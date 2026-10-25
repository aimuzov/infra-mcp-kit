import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, mock, test } from 'node:test'
import { z } from 'zod'

import { McpServer } from '#kit/mcp'
import { connectHttp, devLink, fakePages, oauthFlow, startHttp, textOf, type RunningHttp } from '#kit/testing/index'

import { createHttpApp, type HttpAppOptions } from './app.ts'
import { telegramLogin } from './login/telegram.ts'
import { KitOAuthProvider } from './oauth/provider.ts'
import { challenge } from './oauth/router.ts'
import { memoryStore, sqliteStore } from './oauth/store.ts'
import { Tokens } from './oauth/tokens.ts'

const SECRET = 'x'.repeat(32)
const quiet = { error() {}, warn() {}, info() {}, debug() {} }
const running: RunningHttp[] = []

after(() => Promise.all(running.map((r) => r.close())))

function steps() {
	const server = new McpServer({ name: 'steps', version: '0.0.0' }, { logger: quiet })

	server.registerTool(
		'steps',
		{ description: 'Progress', inputSchema: { n: z.number() } },
		async ({ n }: { n: number }, extra) => {
			for (let i = 1; i <= n; i++) {
				await extra.sendNotification({
					method: 'notifications/progress',
					params: { progressToken: extra._meta?.progressToken ?? 0, progress: i, total: n },
				})
			}

			return { content: [{ type: 'text', text: `user ${extra.authInfo?.extra?.subject ?? 'nobody'}` }] }
		},
	)

	return server
}

async function start(options: Partial<HttpAppOptions> = {}) {
	const http = await startHttp((base) =>
		createHttpApp({
			config: { port: 0, publicUrl: new URL(base), authSecret: SECRET, allowedRedirectUris: [] },
			service: { name: 'kit3' },
			createServer: steps,
			publicDir: fakePages(),
			auth: { store: memoryStore(), login: telegramLogin({ botToken: '1:bot', devUserId: '42' }) },
			logger: quiet,
			...options,
		}),
	)

	running.push(http)

	return http.base
}

const register = (base: string, body: unknown) =>
	fetch(`${base}/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('совместимость с китом 2.x: живые сессии переживают обновление', () => {
	const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/tokens-2.1.json'), 'utf8')) as {
		secret: string
		issuer: string
		createdAt: number
		modes: Record<'sign' | 'encrypt', { clientId: string; access_token: string; refresh_token: string }>
	}

	for (const mode of ['sign', 'encrypt'] as const) {
		test(`auth.db и токены 2.1.0 в режиме ${mode}: клиент, токен доступа и refresh работают`, async () => {
			// Токены выданы при создании фикстуры: часы те же, что тогда, плюс минута.
			// Подменяем весь Date, а не Date.now: jose сверяет срок по `new Date()`.
			mock.timers.enable({ apis: ['Date'], now: fixture.createdAt + 60_000 })

			try {
				const db = join(mkdtempSync(join(tmpdir(), 'kit3-compat-')), 'auth.db')

				copyFileSync(join(import.meta.dirname, 'fixtures/auth-2.1.db'), db)

				const store = sqliteStore(db)
				const provider = new KitOAuthProvider({
					publicUrl: new URL(fixture.issuer),
					tokens: new Tokens({ secret: fixture.secret, issuer: fixture.issuer, mode }),
					store,
					login: { page: '/login', complete: () => ({ subject: 'unused' }) },
				})
				const issued = fixture.modes[mode]
				const client = store.getClient(issued.clientId)

				assert.ok(client, 'клиент из базы 2.1 на месте')

				const auth = await provider.verifyAccessToken(issued.access_token)

				assert.equal(auth.extra?.subject, `user-${mode}`)

				assert.equal(
					auth.extra?.[mode === 'encrypt' ? 'apiToken' : 'name'],
					mode === 'encrypt' ? 'kaiten-secret' : 'Alex',
				)

				const refreshed = await provider.exchangeRefreshToken(client, issued.refresh_token)

				assert.equal((await provider.verifyAccessToken(refreshed.access_token)).extra?.subject, `user-${mode}`)
			} finally {
				mock.timers.reset()
			}
		})
	}
})

describe('регистрация клиентов', () => {
	test('публичный клиент получает UUID и не получает секрета', async () => {
		const base = await start()
		const res = await register(base, {
			redirect_uris: ['http://127.0.0.1:1/cb'],
			token_endpoint_auth_method: 'none',
		})
		const client = (await res.json()) as Record<string, unknown>

		assert.equal(res.status, 201)
		assert.match(String(client.client_id), /^[0-9a-f-]{36}$/)
		assert.equal('client_secret' in client, false)
	})

	test('конфиденциальный клиент получает секрет, и /token без него -- invalid_client', async () => {
		const base = await start()
		const res = await register(base, { redirect_uris: ['http://127.0.0.1:1/cb'] })
		const { client_id, client_secret } = (await res.json()) as { client_id: string; client_secret: string }
		const token = (body: Record<string, string>) =>
			fetch(`${base}/token`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code: 'x',
					code_verifier: 'v',
					client_id,
					...body,
				}),
			})

		assert.match(client_secret, /^[0-9a-f]{64}$/)
		assert.equal(((await (await token({})).json()) as { error: string }).error, 'invalid_client')
		// С верным секретом клиент проходит, и дальше спотыкается уже о сам код.
		assert.equal(((await (await token({ client_secret })).json()) as { error: string }).error, 'invalid_grant')
	})

	test('кривое тело регистрации -- 400, а не 500', async () => {
		const base = await start()
		const bad = await fetch(`${base}/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		})

		assert.equal(bad.status, 400)
		assert.equal((await register(base, { redirect_uris: 'nope' })).status, 400)
		assert.equal((await register(base, { redirect_uris: ['x'], token_endpoint_auth_method: 'magic' })).status, 400)
	})

	test('client_id-адрес не загружается с чужого сервера: просто неизвестный клиент', async () => {
		const base = await start()
		const res = await fetch(
			`${base}/authorize?${new URLSearchParams({ client_id: 'https://evil.example/client.json', response_type: 'code' })}`,
			{ redirect: 'manual' },
		)

		assert.equal(res.status, 400)
		assert.equal(((await res.json()) as { error: string }).error, 'invalid_client')
	})
})

describe('ресурс и токен доступа', () => {
	test('метаданные защищённого ресурса называют ресурсом адрес /mcp', async () => {
		const base = await start()
		const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
			string,
			unknown
		>

		assert.equal(meta.resource, `${base}/mcp`)
		assert.deepEqual(meta.authorization_servers, [`${base}/`])
	})

	test('WWW-Authenticate только из печатного ASCII, даже с кириллицей и кавычками в тексте', () => {
		const header = challenge('invalid_token', 'Токен "протух"\n', new URL('https://a.b/.well-known/x'))

		assert.match(header, /^[\x20-\x7e]+$/)
		assert.match(header, /resource_metadata="https:\/\/a\.b\/\.well-known\/x"/)
	})

	test('прогресс по HTTP приходит в потоке SSE, токен доходит до инструмента', async () => {
		const base = await start()
		const { tokens } = await oauthFlow({ base, login: devLink() })
		const client = await connectHttp(base, tokens.access_token)
		const seen: number[] = []
		const result = await client.callTool({ name: 'steps', arguments: { n: 2 } }, undefined, {
			onprogress: (p) => void seen.push(p.progress),
		})

		assert.deepEqual(seen, [1, 2])
		assert.equal(textOf(result), 'user 42')
	})
})

describe('статика', () => {
	test('выйти из publicDir нельзя ни .., ни закодированным путём', async () => {
		const base = await start({ auth: undefined })

		for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/.env']) {
			const res = await fetch(`${base}${path}`)

			assert.notEqual(res.status, 200, path)
		}

		assert.equal((await fetch(`${base}/login`)).status, 200)
	})
})
