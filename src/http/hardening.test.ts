import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import express, { type Request } from 'express'
import { EncryptJWT } from 'jose'

import { connectHttp, oauthFlow, signTelegramLogin, startHttp, type RunningHttp } from '#kit/testing/index'

import { createHttpApp, listen, type HttpAppOptions } from './app.ts'
import { loadHttpConfig } from './config.ts'
import { telegramLogin } from './login/telegram.ts'
import { tokenFormLogin } from './login/token-form.ts'
import { LoginError, type Login } from './oauth/provider.ts'
import { memoryStore, sqliteStore, type AuthStore } from './oauth/store.ts'
import { Tokens } from './oauth/tokens.ts'
import { readCookie } from './session.ts'

const SECRET = 'x'.repeat(32)
const service = { name: 'test', repo: 'https://github.com/aimuzov/test' }

const server = () => {
	const mcp = new McpServer({ name: 'test', version: '0.0.0' })

	mcp.registerTool('ping', { description: 'ping' }, () => ({ content: [{ type: 'text', text: 'pong' }] }))

	return mcp
}

/** Вход без страницы: кнопка ведёт прямо на колбэк, колбэк говорит, кто это. */
const instantLogin = (grant: { subject: string; claims?: Record<string, unknown> }): Login => ({
	render: ({ callbackUrl }) => `<a href="${callbackUrl.href.replaceAll('&', '&amp;')}">go</a>`,
	complete: () => grant,
})

const goLogin = (_page: string, callback: URL) => fetch(callback, { redirect: 'manual' })

const running: RunningHttp[] = []

after(() => Promise.all(running.map((r) => r.close())))

async function start(store: AuthStore, extra: Partial<HttpAppOptions> = {}) {
	const http = await startHttp(
		(base) =>
			createHttpApp({
				config: { port: 0, publicUrl: new URL(base), authSecret: SECRET, allowedRedirectUris: [] },
				service,
				createServer: server,
				auth: { store, login: instantLogin({ subject: 'u1' }) },
				...extra,
			}).app,
	)

	running.push(http)

	return http.base
}

const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error

describe('refresh-токены', () => {
	for (const [name, make] of [
		['memory', memoryStore],
		['sqlite', () => sqliteStore(join(mkdtempSync(join(tmpdir(), 'kit-rt-')), 'auth.db'))],
	] as const) {
		test(`${name}: каждый годится один раз, повтор отзывает всю цепочку`, async () => {
			const base = await start(make())
			const flow = await oauthFlow({ base, login: goLogin })
			const first = await flow.refresh()

			assert.equal(first.status, 200)

			const rotated = (await first.json()) as { refresh_token: string }

			assert.notEqual(rotated.refresh_token, flow.tokens.refresh_token)

			// Старый предъявили снова: значит, его кто-то унёс.
			const reused = await flow.refresh()

			assert.equal(reused.status, 400)
			assert.equal(await errorOf(reused), 'invalid_grant')

			// И новый из той же цепочки больше не работает.
			assert.equal((await flow.refresh(rotated.refresh_token)).status, 400)
		})
	}

	test('отзыв по пользователю закрывает и токен доступа, и refresh', async () => {
		const store = memoryStore()
		const base = await start(store)
		const flow = await oauthFlow({ base, login: goLogin })

		// iat в секундах: отзыв строго позже выдачи.
		await new Promise((resolve) => setTimeout(resolve, 1100))
		store.revokeSubject('u1')

		await assert.rejects(connectHttp(base, flow.tokens.access_token))
		assert.equal((await flow.refresh()).status, 400)

		// Новый вход после отзыва снова пускает. Токен той же секунды, что и отзыв,
		// отозванным считается: iat у JWT в секундах.
		await new Promise((resolve) => setTimeout(resolve, 1100))

		const again = await oauthFlow({ base, login: goLogin })
		const client = await connectHttp(base, again.tokens.access_token)

		await client.close()
	})

	test('/revoke убивает цепочку refresh-токена', async () => {
		const base = await start(memoryStore())
		const flow = await oauthFlow({ base, login: goLogin })
		const revoked = await fetch(`${base}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: flow.tokens.refresh_token ?? '', client_id: flow.clientId }),
		})

		assert.equal(revoked.status, 200)
		assert.equal((await flow.refresh()).status, 400)
	})

	test('refresh-токен кита 1.0 без jti принимается один раз и переводится в цепочку', async () => {
		const store = memoryStore()
		const base = await start(store)
		const flow = await oauthFlow({ base, login: goLogin })
		const legacy = await new Tokens({ secret: SECRET, issuer: new URL(base).href }).sign('refresh', {
			sub: 'u1',
			client_id: flow.clientId,
		})
		const res = await flow.refresh(legacy)

		assert.equal(res.status, 200)

		const { refresh_token } = (await res.json()) as { refresh_token: string }

		assert.equal((await flow.refresh(refresh_token)).status, 200)
	})
})

describe('вход и регистрация', () => {
	test('регистрация с десятками колбэков или раздутыми метаданными отклоняется', async () => {
		const base = await start(memoryStore())
		const register = (body: unknown) =>
			fetch(`${base}/register`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
		const many = Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${1000 + i}/cb`)

		assert.equal((await register({ redirect_uris: many, token_endpoint_auth_method: 'none' })).status, 400)

		const fat = { redirect_uris: ['http://127.0.0.1:1/cb'], client_name: 'x'.repeat(9000) }

		assert.equal((await register({ ...fat, token_endpoint_auth_method: 'none' })).status, 400)
	})

	test('claims, которые кит ставит сам, вход вернуть не может', async () => {
		const base = await start(memoryStore(), {
			auth: { store: memoryStore(), login: instantLogin({ subject: 'u1', claims: { subject: 'admin' } }) },
		})

		await assert.rejects(oauthFlow({ base, login: goLogin }), /Не получилось войти/)
	})

	test('вход с чужим секретом не стартует без шифрования токенов', () => {
		const login = tokenFormLogin({ title: 't', fields: [], verify: () => ({ subject: 'u' }) })
		const options = {
			config: { port: 0, publicUrl: new URL('http://localhost'), authSecret: SECRET, allowedRedirectUris: [] },
			service,
			createServer: server,
		}

		assert.throws(() => createHttpApp({ ...options, auth: { store: memoryStore(), login } }), /encrypt/)

		assert.doesNotThrow(() =>
			createHttpApp({ ...options, auth: { store: memoryStore(), login, tokens: 'encrypt' } }),
		)
	})

	test('подписанный вход Telegram годится один раз', async () => {
		const login = telegramLogin({ botToken: '1:bot', botName: 'bot' })
		const query = signTelegramLogin({ id: '7', auth_date: String(Math.floor(Date.now() / 1000)) }, '1:bot')
		const req = { query } as unknown as Request

		assert.equal((await login.complete(req)).subject, '7')
		await assert.rejects(async () => login.complete(req), LoginError)
	})
})

describe('конфиг и токены', () => {
	test('PUBLIC_URL: только origin и https, кроме localhost', () => {
		const env = (url: string) => ({ AUTH_SECRET: SECRET, PUBLIC_URL: url })

		assert.throws(() => loadHttpConfig(env('https://a.b/sub')), /PUBLIC_URL: нужен адрес без пути/)
		assert.throws(() => loadHttpConfig(env('http://a.b')), /https/)
		assert.throws(() => loadHttpConfig(env('nope')), /PUBLIC_URL/)
		assert.equal(loadHttpConfig(env('http://localhost:8080')).publicUrl.port, '8080')
	})

	test('Tokens не создаются с коротким секретом и кривым TTL', () => {
		assert.throws(() => new Tokens({ secret: 'short', issuer: 'i' }), /короче/)
		assert.throws(() => new Tokens({ secret: SECRET, issuer: 'i', ttl: { access: Number.NaN } }), /TTL/)
	})

	test('JWE с алгоритмом не из списка не принимается', async () => {
		const tokens = new Tokens({ secret: SECRET, issuer: 'i', mode: 'encrypt' })
		const forged = await new EncryptJWT({ sub: 'u', kind: 'access' })
			.setProtectedHeader({ alg: 'PBES2-HS256+A128KW', enc: 'A256GCM', p2c: 1000 })
			.setIssuer('i')
			.setExpirationTime('1h')
			.encrypt(new TextEncoder().encode(SECRET))

		assert.equal(await tokens.verify('access', forged), null)
	})

	test('битая cookie не роняет запрос', () => {
		const req = { get: () => 'mcp_session=%E0%A4%A' } as unknown as Request

		assert.equal(readCookie(req, 'mcp_session'), undefined)
	})
})

describe('ошибки сервера', () => {
	test('упавшая фабрика сервера даёт JSON-RPC 500, а не страницу express', async () => {
		const http = await startHttp(
			(base) =>
				createHttpApp({
					config: { port: 0, publicUrl: new URL(base), authSecret: SECRET, allowedRedirectUris: [] },
					service,
					createServer: () => {
						throw new Error('boom')
					},
					logger: { error() {}, warn() {}, info() {}, debug() {} },
				}).app,
		)

		running.push(http)

		const res = await fetch(`${http.base}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
		})

		assert.equal(res.status, 500)
		assert.equal(((await res.json()) as { error: { code: number } }).error.code, -32603)
	})

	test('занятый порт отклоняет listen, а не пишет "listening"', async () => {
		const busy = createServer()

		await new Promise<void>((resolve) => busy.listen(0, resolve))

		const { port } = busy.address() as AddressInfo
		const lines: string[] = []
		const logger = { error() {}, warn() {}, debug() {}, info: (m: string) => void lines.push(m) }

		await assert.rejects(listen(express(), port, 'up', logger), /EADDRINUSE/)
		assert.deepEqual(lines, [])

		busy.close()
	})
})

test('база кита 1.0 переходит на новую схему и сохраняет клиентов', () => {
	const path = join(mkdtempSync(join(tmpdir(), 'kit-mig-')), 'auth.db')
	const old = new DatabaseSync(path)

	old.prepare('CREATE TABLE client (client_id TEXT PRIMARY KEY, info TEXT NOT NULL)').run()
	old.prepare('CREATE TABLE auth_code (code TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER)').run()
	old.prepare("INSERT INTO client VALUES ('c1', ?)").run(JSON.stringify({ client_id: 'c1', redirect_uris: [] }))
	old.close()

	const store = sqliteStore(path)
	const code = store.issueCode({ clientId: 'c1', codeChallenge: 'ch', redirectUri: 'r', grant: 'g' })

	assert.equal(store.getClient('c1')?.client_id, 'c1')
	assert.equal(store.takeCode(code)?.clientId, 'c1')
	store.close?.()

	const db = new DatabaseSync(path)

	assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2)
	db.close()
})
