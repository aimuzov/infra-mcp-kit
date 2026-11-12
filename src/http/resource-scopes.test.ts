import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { oauthRouter } from './oauth/router.ts'
import { memoryStore, sqliteStore, type AuthStore } from './oauth/store.ts'
import { Tokens } from './oauth/tokens.ts'

const base = 'https://service.example'
const resource = `${base}/mcp`
const redirect = 'http://localhost/callback'
const verifier = 'v'.repeat(43)

function setup(strict = true, store: AuthStore = memoryStore()) {
	const tokens = new Tokens({ secret: 's'.repeat(32), issuer: `${base}/` })
	const router = oauthRouter({
		publicUrl: new URL(base),
		mcpUrl: new URL(resource),
		resourceName: 'test',
		tokens,
		store,
		login: { page: '/login', complete: () => ({ subject: 'owner' }) },
		...(strict ? { scopesSupported: ['clients:read', 'clients:write'] } : {}),
	})

	store.saveClient({ client_id: 'client', redirect_uris: [redirect], token_endpoint_auth_method: 'none' })
	const handle = async (path: string, init?: RequestInit) =>
		(await router.handle(new Request(`${base}${path}`, init)))!
	const authorize = (extra: Record<string, string> = {}) =>
		handle(
			`/authorize?${new URLSearchParams({
				client_id: 'client',
				redirect_uri: redirect,
				response_type: 'code',
				code_challenge_method: 'S256',
				code_challenge: createHash('sha256').update(verifier).digest('base64url'),
				scope: 'clients:read',
				...extra,
			})}`,
		)
	const post = (body: Record<string, string>) =>
		handle('/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: 'client', ...body }),
		})
	const code = async (extra: Record<string, string> = {}) => {
		const response = await authorize(extra)
		const signed = new URLSearchParams(new URL(response.headers.get('location')!, base).hash.slice(1)).get(
			'request',
		)!
		const callback = await handle(`/authorize/callback?${new URLSearchParams({ request: signed })}`)

		return new URL(callback.headers.get('location')!).searchParams.get('code')!
	}
	const exchange = (code: string, extra: Record<string, string> = {}) =>
		post({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, ...extra })

	return { router, tokens, handle, authorize, post, code, exchange }
}

test('strict metadata advertises supported scopes', async () => {
	const { handle } = setup()

	for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
		assert.deepEqual((await (await handle(path)).json()).scopes_supported, ['clients:read', 'clients:write'])
	}
})

for (const [extra, error] of [
	[{ resource: 'https://other.example/mcp' }, 'invalid_target'],
	[{ scope: 'admin' }, 'invalid_scope'],
] as const) {
	test(`authorize rejects ${error} through the registered redirect`, async () => {
		const response = await setup().authorize(extra)

		assert.equal(new URL(response.headers.get('location')!, base).searchParams.get('error'), error)
	})
}

test('wrong resource and extra scope do not consume an authorization code', async () => {
	const { code, exchange } = setup()
	const pending = await code()

	for (const [extra, error] of [
		[{ resource: 'https://other.example/mcp' }, 'invalid_target'],
		[{ scope: 'clients:write' }, 'invalid_scope'],
	] as const) {
		assert.equal((await (await exchange(pending, extra)).json()).error, error)
	}

	assert.equal((await exchange(pending)).status, 200)
	assert.equal((await exchange(pending)).status, 400)
})

test('access and refresh carry the signed resource and scope; access exposes them', async () => {
	const { code, exchange, tokens, router } = setup()
	const issued = await (await exchange(await code())).json()

	assert.equal(issued.scope, 'clients:read')

	for (const [kind, token] of [
		['access', issued.access_token],
		['refresh', issued.refresh_token],
	] as const) {
		const claims = await tokens.verify(kind, token)

		assert.equal(claims?.aud, resource)
		assert.equal(claims?.scope, 'clients:read')
	}

	const auth = await router.provider.verifyAccessToken(issued.access_token)

	assert.deepEqual(auth.scopes, ['clients:read'])
	assert.equal(auth.resource?.href, resource)
	assert.deepEqual(auth.extra, { subject: 'owner' })
})

test('refresh rejects wrong resource and escalation without consuming the token; narrowing persists', async () => {
	const { code, exchange, post, router } = setup()
	const issued = await (await exchange(await code())).json()
	const refresh = (extra: Record<string, string>) =>
		post({ grant_type: 'refresh_token', refresh_token: issued.refresh_token, ...extra })

	assert.equal((await (await refresh({ resource: 'https://other.example/mcp' })).json()).error, 'invalid_target')
	assert.equal((await (await refresh({ scope: 'clients:read clients:write' })).json()).error, 'invalid_scope')
	const narrowed = await (await refresh({ scope: '' })).json()

	assert.equal(narrowed.scope, '')
	assert.deepEqual((await router.provider.verifyAccessToken(narrowed.access_token)).scopes, [])

	assert.equal(
		(
			await (
				await post({
					grant_type: 'refresh_token',
					refresh_token: narrowed.refresh_token,
					scope: 'clients:read',
				})
			).json()
		).error,
		'invalid_scope',
	)
})

test('strict access verification rejects missing or foreign audience and unsupported scope', async () => {
	const { tokens, router } = setup()

	for (const claims of [
		{},
		{ aud: 'https://other.example/mcp', scope: 'clients:read' },
		{ aud: resource, scope: 'admin' },
	]) {
		await assert.rejects(
			router.provider.verifyAccessToken(
				await tokens.sign('access', { sub: 'owner', client_id: 'client', ...claims }),
			),
			/Invalid/,
		)
	}
})

test('login cannot override scope claims', async () => {
	const { router } = setup()

	await assert.rejects(
		router.provider.issueCode('client', redirect, 'challenge', '', {
			subject: 'owner',
			claims: { scope: 'admin' },
		}),
		/claims/,
	)
})

test('legacy mode accepts existing access tokens without audience or scope', async () => {
	const { router, tokens, code, exchange } = setup(false)

	assert.deepEqual(
		(await router.provider.verifyAccessToken(await tokens.sign('access', { sub: 'owner', client_id: 'client' })))
			.scopes,
		[],
	)

	const issued = await (await exchange(await code({ resource: 'https://other.example/mcp', scope: 'old' }))).json()

	assert.equal(issued.scope, undefined)
	assert.equal((await tokens.verify('access', issued.access_token))?.aud, undefined)
})

test('default redirects accept only exact ChatGPT callback locations', async () => {
	const { isAllowedRedirectUri } = await import('./config.ts')

	for (const uri of [
		'https://chatgpt.com/connector_platform_oauth_redirect',
		'https://chatgpt.com/connector/oauth/id_123-ABC',
	])
		assert.equal(isAllowedRedirectUri(uri), true, uri)

	for (const uri of [
		'https://chatgpt.com.evil.example/connector/oauth/id',
		'https://evil.example/connector/oauth/id',
		'https://chatgpt.com/connector/oauth/',
		'https://chatgpt.com/connector/oauth/id/other',
		'https://chatgpt.com/connector/oauth/id?next=evil',
		'https://chatgpt.com/connector/oauth/id#fragment',
		'https://user:pass@chatgpt.com/connector/oauth/id',
		'http://chatgpt.com/connector/oauth/id',
		'https://chatgpt.com:444/connector/oauth/id',
		'https://chatgpt.com/other',
	])
		assert.equal(isAllowedRedirectUri(uri), false, uri)
})

test('resource grants and rotating refresh survive sqlite store reopening', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'kit-scopes-'))
	const path = join(directory, 'oauth.db')
	let store = sqliteStore(path)

	try {
		const first = setup(true, store)
		const pending = await first.code()

		store.close?.()
		store = sqliteStore(path)
		assert.equal(store.getClient('client')?.client_id, 'client')
		const second = setup(true, store)
		const issued = await (await second.exchange(pending, { resource })).json()

		store.close?.()
		store = sqliteStore(path)
		const restarted = setup(true, store)
		const response = await restarted.post({
			grant_type: 'refresh_token',
			refresh_token: issued.refresh_token,
			resource,
		})

		assert.equal(response.status, 200)
		const refreshed = await response.json()

		assert.deepEqual((await restarted.router.provider.verifyAccessToken(refreshed.access_token)).scopes, [
			'clients:read',
		])
	} finally {
		store.close?.()
		rmSync(directory, { recursive: true, force: true })
	}
})

test('createHttpApp forwards scopesSupported to OAuth', async () => {
	const { createHttpApp } = await import('./app.ts')
	const { McpServer } = await import('#kit/mcp')
	const { fakePages } = await import('#kit/testing/index')
	const app = createHttpApp({
		config: { port: 0, publicUrl: new URL(base), authSecret: 's'.repeat(32), allowedRedirectUris: [] },
		service: { name: 'test' },
		createServer: () => new McpServer({ name: 'test', version: '1.0.0' }),
		publicDir: fakePages(),
		auth: {
			store: memoryStore(),
			login: { page: '/login', complete: () => ({ subject: 'owner' }) },
			scopesSupported: ['clients:read'],
		},
	})
	const response = await app.handle(new Request(`${base}/.well-known/oauth-authorization-server`))

	assert.deepEqual((await response.json()).scopes_supported, ['clients:read'])
})
