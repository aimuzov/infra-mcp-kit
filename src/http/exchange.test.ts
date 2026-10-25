import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import {
	fakePages,
	loginStep,
	oauthFlow,
	startHttp,
	submitForm,
	TEST_REDIRECT,
	type RunningHttp,
} from '#kit/testing/index'

import { createHttpApp } from './app.ts'
import { tokenFormLogin } from './login/token-form.ts'
import { memoryStore } from './oauth/store.ts'

const running: RunningHttp[] = []

after(() => Promise.all(running.map((r) => r.close())))

const login = tokenFormLogin({
	fields: [{ name: 'token', label: 'Токен', required: true }],
	verify: ({ token }) => ({ subject: `user-${token}` }),
})

async function start() {
	const http = await startHttp(
		(base) =>
			createHttpApp({
				config: { port: 0, publicUrl: new URL(base), authSecret: 'x'.repeat(32), allowedRedirectUris: [] },
				service: { name: 'test' },
				createServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
				publicDir: fakePages(),
				auth: { store: memoryStore(), login, tokens: 'encrypt' },
			}).app,
	)

	running.push(http)

	return http.base
}

const form = (body: Record<string, string>) => ({
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(body),
})

async function register(base: string, redirect = TEST_REDIRECT) {
	const res = await fetch(`${base}/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
	})

	return ((await res.json()) as { client_id: string }).client_id
}

/** Вход до кода, без обмена: дальше тест сам решает, с чем идти на /token. */
async function codeFor(base: string, client: string) {
	const verifier = randomBytes(32).toString('base64url')
	const authorize = await fetch(
		`${base}/authorize?${new URLSearchParams({
			response_type: 'code',
			client_id: client,
			redirect_uri: TEST_REDIRECT,
			code_challenge: createHash('sha256').update(verifier).digest('base64url'),
			code_challenge_method: 'S256',
		})}`,
		{ redirect: 'manual' },
	)
	const callback = await submitForm({ token: '1' })(loginStep(authorize.headers.get('location') ?? '', base))
	const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? ''

	assert.ok(code, 'вход не выдал код')

	return { code, verifier }
}

const exchange = (base: string, body: Record<string, string>) =>
	fetch(`${base}/token`, form({ grant_type: 'authorization_code', redirect_uri: TEST_REDIRECT, ...body }))

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

describe('обмен кода', () => {
	test('неверный verifier PKCE отклоняется, и код после этого ещё годен', async () => {
		const base = await start()
		const client = await register(base)
		const { code, verifier } = await codeFor(base, client)
		const wrong = await exchange(base, { code, client_id: client, code_verifier: 'x'.repeat(43) })

		assert.equal(wrong.status, 400)
		assert.equal(await errorOf(wrong), 'invalid_grant')
		assert.equal((await exchange(base, { code, client_id: client, code_verifier: verifier })).status, 200)
	})

	test('код другого клиента не обменять', async () => {
		const base = await start()
		const owner = await register(base)
		const stranger = await register(base)
		const { code, verifier } = await codeFor(base, owner)
		const res = await exchange(base, { code, client_id: stranger, code_verifier: verifier })

		assert.equal(res.status, 400)
		assert.equal(await errorOf(res), 'invalid_grant')
	})

	test('несовпадение redirect_uri отклоняется и сжигает код', async () => {
		const base = await start()
		const client = await register(base)
		const { code, verifier } = await codeFor(base, client)
		const other = await exchange(base, {
			code,
			client_id: client,
			code_verifier: verifier,
			redirect_uri: 'http://127.0.0.1:1/other',
		})

		assert.equal(other.status, 400)
		assert.equal(await errorOf(other), 'invalid_grant')
		assert.equal((await exchange(base, { code, client_id: client, code_verifier: verifier })).status, 400)
	})

	test('неизвестный клиент на /token -- invalid_client', async () => {
		const base = await start()
		const res = await exchange(base, { code: 'x', client_id: 'nobody', code_verifier: 'x'.repeat(43) })

		assert.equal(res.status, 400)
		assert.equal(await errorOf(res), 'invalid_client')
	})

	test('authorize с незарегистрированным redirect_uri не уводит на страницу входа', async () => {
		const base = await start()
		const client = await register(base)
		const res = await fetch(
			`${base}/authorize?${new URLSearchParams({
				response_type: 'code',
				client_id: client,
				redirect_uri: 'http://127.0.0.1:1/other',
				code_challenge: 'c'.repeat(43),
				code_challenge_method: 'S256',
			})}`,
			{ redirect: 'manual' },
		)

		assert.equal(res.status, 400)
	})
})

test('refresh-токен чужого клиента не обновляется', async () => {
	const base = await start()
	const flow = await oauthFlow({ base, login: submitForm({ token: '7' }) })
	const stranger = await register(base)
	const res = await fetch(
		`${base}/token`,
		form({ grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token ?? '', client_id: stranger }),
	)

	assert.equal(res.status, 400)
	assert.equal(await errorOf(res), 'invalid_grant')
})
