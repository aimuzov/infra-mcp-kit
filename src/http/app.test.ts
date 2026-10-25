import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import {
	callbackFrom,
	connectHttp,
	connectInMemory,
	expectTools,
	hiddenField,
	oauthFlow,
	startHttp,
	textOf,
	type RunningHttp,
} from '#kit/testing/index'

import { createHttpApp, type HttpAppOptions } from './app.ts'
import { signTelegramLogin, telegramLogin } from './login/telegram.ts'
import { tokenFormLogin } from './login/token-form.ts'
import { LoginError } from './oauth/provider.ts'
import { memoryStore, sqliteStore, type AuthStore } from './oauth/store.ts'

const SECRET = 'x'.repeat(32)
const BOT = '123:bot'
const service = { name: 'test', repo: 'https://github.com/aimuzov/test' }

/** Сервер с одним инструментом, который рассказывает, кого видит. */
function whoami(auth: { extra?: Record<string, unknown> } | undefined): McpServer {
	const server = new McpServer({ name: 'test', version: '0.0.0' })

	server.registerTool('whoami', { description: 'who is calling' }, () => ({
		content: [{ type: 'text', text: JSON.stringify(auth?.extra ?? null) }],
	}))

	return server
}

const config = (base: string) => ({
	port: 0,
	publicUrl: new URL(base),
	authSecret: SECRET,
	allowedRedirectUris: [],
})

const running: RunningHttp[] = []

after(() => Promise.all(running.map((r) => r.close())))

async function start(options: Omit<HttpAppOptions, 'config' | 'service' | 'createServer'>) {
	const http = await startHttp(
		(base) => createHttpApp({ config: config(base), service, createServer: whoami, ...options }).app,
	)

	running.push(http)

	return http.base
}

/** Что делает виджет: дописывает подписанный вход к auth URL и идёт по нему. */
const telegramWidget =
	(id: string, bot = BOT) =>
	(_page: string, callback: URL) => {
		const login = signTelegramLogin(
			{ id, first_name: 'Ivan', auth_date: String(Math.floor(Date.now() / 1000)) },
			bot,
		)

		for (const [k, v] of Object.entries(login)) callback.searchParams.set(k, v)

		return fetch(callback, { redirect: 'manual' })
	}

const stores: [string, () => AuthStore][] = [
	['memory', memoryStore],
	['sqlite', () => sqliteStore(join(mkdtempSync(join(tmpdir(), 'kit-app-')), 'auth.db'))],
]

for (const [name, store] of stores) {
	describe(`OAuth через Telegram, хранилище ${name}`, () => {
		test('вход доходит до инструмента с subject и claims, код одноразовый', async () => {
			const base = await start({
				auth: {
					store: store(),
					login: telegramLogin({ botToken: BOT, botName: 'bot', claims: (u) => ({ name: u.firstName }) }),
				},
			})
			const flow = await oauthFlow({ base, login: telegramWidget('42') })
			const client = await connectHttp(base, flow.tokens.access_token)

			await expectTools(client, ['whoami'])

			assert.deepEqual(JSON.parse(textOf(await client.callTool({ name: 'whoami' }))), {
				name: 'Ivan',
				subject: '42',
			})

			await client.close()

			const again = await flow.exchangeAgain()

			assert.equal(again.status, 400)
			assert.equal(((await again.json()) as { error: string }).error, 'invalid_grant')
		})
	})
}

describe('OAuth: отказы', () => {
	test('чужая подпись Telegram возвращает на страницу входа с ошибкой', async () => {
		const base = await start({
			auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT, botName: 'bot' }) },
		})
		const reg = await fetch(`${base}/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/cb'], token_endpoint_auth_method: 'none' }),
		})
		const { client_id } = (await reg.json()) as { client_id: string }
		const page = await fetch(
			`${base}/authorize?${new URLSearchParams({
				response_type: 'code',
				client_id,
				redirect_uri: 'http://127.0.0.1:1/cb',
				code_challenge: 'x'.repeat(43),
				code_challenge_method: 'S256',
			})}`,
		).then((r) => r.text())
		const res = await telegramWidget('42', 'other-bot')(page, callbackFrom(page, base))

		assert.equal(res.status, 400)
		assert.match(await res.text(), /Telegram не подтвердил вход/)
	})

	test('колбэк без подписанного запроса и регистрация чужого redirect отклоняются', async () => {
		const base = await start({
			auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT, botName: 'bot' }) },
		})

		assert.equal((await fetch(`${base}/authorize/callback?request=forged`)).status, 400)

		const reg = await fetch(`${base}/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }),
		})

		assert.equal(reg.status, 400)
	})

	test('без токена /mcp отвечает 401 с адресом метаданных, не POST -- 405', async () => {
		const base = await start({
			auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT, botName: 'bot' }) },
		})
		const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })

		assert.equal(res.status, 401)
		assert.match(res.headers.get('www-authenticate') ?? '', /oauth-protected-resource/)
		assert.equal((await fetch(`${base}/mcp`)).status, 405)
	})

	test('недействительный токен доступа даёт 401, а не 500', async () => {
		const base = await start({
			auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT, botName: 'bot' }) },
		})
		const res = await fetch(`${base}/mcp`, {
			method: 'POST',
			headers: { authorization: 'Bearer garbage', 'content-type': 'application/json' },
			body: '{}',
		})

		assert.equal(res.status, 401)
		assert.match(res.headers.get('www-authenticate') ?? '', /invalid_token/)
	})
})

describe('OAuth через форму токена с шифрованием', () => {
	const login = tokenFormLogin({
		title: 'Подключение',
		fields: [{ name: 'token', label: 'API-токен', type: 'password' }],
		verify: ({ token }) => {
			if (token !== 'good') throw new LoginError('Токен не подошёл')

			return { subject: 'kaiten-user', claims: { apiToken: token } }
		},
	})

	const submit = (token: string) => (page: string, callback: URL) =>
		fetch(callback, {
			method: 'POST',
			redirect: 'manual',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ request: hiddenField(page, 'request'), token }),
		})

	test('секрет едет в claims до инструмента, но не читается из токена', async () => {
		const base = await start({ auth: { store: memoryStore(), login, tokens: 'encrypt' } })
		const flow = await oauthFlow({ base, login: submit('good') })

		assert.ok(
			!flow.tokens.access_token.split('.').some((p) => Buffer.from(p, 'base64url').toString().includes('good')),
		)

		const client = await connectHttp(base, flow.tokens.access_token)

		assert.deepEqual(JSON.parse(textOf(await client.callTool({ name: 'whoami' }))), {
			apiToken: 'good',
			subject: 'kaiten-user',
		})

		await client.close()

		// Обновление токена сохраняет claims.
		const refreshed = await fetch(`${base}/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: flow.tokens.refresh_token ?? '',
				client_id: flow.clientId,
			}),
		})

		assert.equal(refreshed.status, 200)

		const again = await connectHttp(base, ((await refreshed.json()) as { access_token: string }).access_token)

		assert.match(textOf(await again.callTool({ name: 'whoami' })), /good/)
		await again.close()
	})

	test('неверный токен возвращает форму с ошибкой', async () => {
		const base = await start({ auth: { store: memoryStore(), login, tokens: 'encrypt' } })

		await assert.rejects(oauthFlow({ base, login: submit('bad') }), /Токен не подошёл/)
	})
})

describe('без OAuth', () => {
	test('/mcp открыт, есть лендинг, /health, ассеты и 404 страницей кита', async () => {
		const base = await start({ landing: { tagline: 'Тестовый коннектор', tools: ['whoami'] } })
		const client = await connectHttp(base)

		assert.equal(textOf(await client.callTool({ name: 'whoami' })), 'null')
		await client.close()

		const landing = await fetch(base)

		assert.match(landing.headers.get('content-security-policy') ?? '', /default-src 'self'/)
		assert.match(await landing.text(), /Тестовый коннектор[\s\S]*\/mcp/)
		assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true })
		assert.match((await fetch(`${base}/_kit/kit.css`)).headers.get('content-type') ?? '', /text\/css/)
		assert.match(await (await fetch(`${base}/_kit/service.css`)).text(), /--hue-light/)
		assert.equal((await fetch(`${base}/nope`)).status, 404)
	})

	test('connectInMemory видит инструменты сервера', async () => {
		await expectTools(await connectInMemory(whoami(undefined)), ['whoami'])
	})
})
