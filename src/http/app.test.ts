import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import {
	connectHttp,
	connectInMemory,
	devLink,
	expectTools,
	fakePages,
	loginStep,
	oauthFlow,
	startHttp,
	submitForm,
	telegramSigned,
	textOf,
	type RunningHttp,
} from '#kit/testing/index'

import { createHttpApp, type HttpAppOptions } from './app.ts'
import { telegramLogin } from './login/telegram.ts'
import { tokenFormLogin } from './login/token-form.ts'
import { LoginError } from './oauth/provider.ts'
import { memoryStore, sqliteStore, type AuthStore } from './oauth/store.ts'

const SECRET = 'x'.repeat(32)
const BOT = '123:bot'
const service = { name: 'test' }
const publicDir = fakePages()

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
		(base) => createHttpApp({ config: config(base), service, createServer: whoami, publicDir, ...options }).app,
	)

	running.push(http)

	return http.base
}

/** Что делает виджет: дописывает подписанный вход к адресу колбэка и идёт по нему. */
const telegramWidget = (id: string, bot = BOT) => telegramSigned({ id, first_name: 'Ivan' }, bot)

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
					login: telegramLogin({ botToken: BOT, claims: (u) => ({ name: u.firstName }) }),
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
	test('authorize ведёт на статическую страницу входа с контекстом во фрагменте', async () => {
		const base = await start({ auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT }) } })
		const step = await authorizeStep(base)

		assert.equal(step.page, '/login/telegram')
		assert.equal(step.client, 'test')
		assert.equal(step.host, '127.0.0.1:1')
		assert.equal(step.callback.pathname, '/authorize/callback')
		assert.match(await (await fetch(new URL(step.page, base))).text(), /page:login\/telegram/)
	})

	test('чужая подпись Telegram возвращает на страницу входа с ошибкой во фрагменте', async () => {
		const base = await start({ auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT }) } })
		const res = await telegramWidget('42', 'other-bot')(await authorizeStep(base))

		assert.equal(res.status, 303)

		const again = loginStep(res.headers.get('location') ?? '', base)

		assert.equal(again.page, '/login/telegram')
		assert.match(again.error, /Telegram не подтвердил вход/)
	})

	test('dev-вход Telegram: id во фрагменте и вход по ссылке без подписи', async () => {
		const base = await start({
			auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT, devUserId: '7' }) },
		})

		assert.equal((await authorizeStep(base)).dev, '7')

		const flow = await oauthFlow({ base, login: devLink() })
		const client = await connectHttp(base, flow.tokens.access_token)

		assert.match(textOf(await client.callTool({ name: 'whoami' })), /"subject":"7"/)
		await client.close()
	})

	test('колбэк без подписанного запроса и регистрация чужого redirect отклоняются', async () => {
		const base = await start({
			auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT }) },
		})

		const forged = await fetch(`${base}/authorize/callback?request=forged`, { redirect: 'manual' })

		assert.equal(forged.status, 303)
		assert.match(forged.headers.get('location') ?? '', /^\/error\?code=invalid_request&title=/)

		const reg = await fetch(`${base}/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }),
		})

		assert.equal(reg.status, 400)
	})

	test('без токена /mcp отвечает 401 с адресом метаданных, не POST -- 405', async () => {
		const base = await start({
			auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT }) },
		})
		const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })

		assert.equal(res.status, 401)
		assert.match(res.headers.get('www-authenticate') ?? '', /oauth-protected-resource/)
		assert.equal((await fetch(`${base}/mcp`)).status, 405)
	})

	// Текст ошибки уходит в WWW-Authenticate, а не-ASCII в заголовке Node режет в 500.
	// На 500 клиент не обновляет токен, и коннектор отваливается, когда истекает access.
	test('битый токен на /mcp даёт 401, а не 500', async () => {
		const base = await start({
			auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT }) },
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
		fields: [{ name: 'token', label: 'API-токен' }],
		verify: ({ token }) => {
			if (token !== 'good') throw new LoginError('Токен не подошёл')

			return { subject: 'kaiten-user', claims: { apiToken: token } }
		},
	})

	const submit = (token: string) => submitForm({ token })

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
	test('/mcp открыт, страницы из publicDir, /health и 404 страницей', async () => {
		const base = await start({})
		const client = await connectHttp(base)

		assert.equal(textOf(await client.callTool({ name: 'whoami' })), 'null')
		await client.close()

		const landing = await fetch(base)

		assert.equal(landing.headers.get('content-security-policy'), "frame-ancestors 'none'")
		assert.match(await landing.text(), /page:index/)
		assert.match(await (await fetch(`${base}/login`)).text(), /page:login/)
		assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true })

		const missing = await fetch(`${base}/nope`, { headers: { accept: 'text/html' } })

		assert.equal(missing.status, 404)
		assert.match(await missing.text(), /page:404/)

		const api = await fetch(`${base}/nope`, { headers: { accept: 'application/json' } })

		assert.equal(api.status, 404)
		assert.deepEqual(await api.json(), { error: { code: 'not_found', message: 'Not found' } })
	})

	test('без страниц коннектор отдаёт только JSON и строгую CSP', async () => {
		const base = await start({ publicDir: undefined })

		assert.match((await fetch(base)).headers.get('content-security-policy') ?? '', /default-src 'none'/)
		assert.equal((await fetch(`${base}/`, { headers: { accept: 'text/html' } })).status, 404)
	})

	test('с OAuth, но без publicDir не стартует: входу нужна страница', () => {
		assert.throws(
			() =>
				createHttpApp({
					config: config('http://127.0.0.1:1'),
					service,
					createServer: whoami,
					auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT }) },
				}),
			/publicDir/,
		)
	})

	test('connectInMemory видит инструменты сервера', async () => {
		await expectTools(await connectInMemory(whoami(undefined)), ['whoami'])
	})
})

/** Зарегистрировать клиента и дойти до редиректа на страницу входа. */
async function authorizeStep(base: string) {
	const reg = await fetch(`${base}/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			client_name: 'test',
			redirect_uris: ['http://127.0.0.1:1/cb'],
			token_endpoint_auth_method: 'none',
		}),
	})
	const { client_id } = (await reg.json()) as { client_id: string }
	const res = await fetch(
		`${base}/authorize?${new URLSearchParams({
			response_type: 'code',
			client_id,
			redirect_uri: 'http://127.0.0.1:1/cb',
			code_challenge: 'x'.repeat(43),
			code_challenge_method: 'S256',
		})}`,
		{ redirect: 'manual' },
	)

	assert.equal(res.status, 302)

	return loginStep(res.headers.get('location') ?? '', base)
}
