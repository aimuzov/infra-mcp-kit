import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { fakePages, startHttp, type RunningHttp } from '#kit/testing/index'

import { createHttpApp } from './app.ts'
import { apiError, errorPage, requireSession, sendJson } from './json.ts'
import { sameOrigin, sessions } from './session.ts'

const SECRET = 'x'.repeat(32)
const running: RunningHttp[] = []

after(() => Promise.all(running.map((r) => r.close())))

/** Коннектор без OAuth с API кабинета, как его собирает сервис через `routes`. */
async function start(publicUrl?: string, pages = true) {
	const http = await startHttp((base) => {
		const url = new URL(publicUrl ?? base)

		return createHttpApp({
			config: { port: 0, publicUrl: url, authSecret: SECRET, allowedRedirectUris: [] },
			service: { name: 'test' },
			createServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
			publicDir: pages ? fakePages() : undefined,
			routes(app, { tokens }) {
				const cabinet = sessions(tokens, url)
				const guard = requireSession(cabinet)

				app.post('/account/login', sameOrigin(url), async (_req, res) => {
					await cabinet.write(res, { sub: 'u1' })
					sendJson(res, { ok: true })
				})

				app.post('/account/logout', sameOrigin(url), (_req, res) => {
					cabinet.clear(res)
					sendJson(res, { ok: true })
				})

				app.get('/account/state', guard, (_req, res) => sendJson(res, { sub: res.locals.session.sub }))
				app.get('/account/busy', (_req, res) => apiError(res, 409, 'busy', 'Идёт сборка'))

				app.get('/account/boom', () => {
					throw new Error('boom')
				})
			},
		}).app
	})

	running.push(http)

	return http.base
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

describe('кабинет: сессия по cookie', () => {
	test('вход ставит httpOnly cookie, с ней /account/state пускает, выход её стирает', async () => {
		const base = await start()
		const login = await fetch(`${base}/account/login`, { method: 'POST', headers: { origin: base } })
		const setCookie = login.headers.get('set-cookie') ?? ''

		assert.equal(login.status, 200)
		assert.match(setCookie, /^mcp_session=/)
		assert.match(setCookie, /HttpOnly/i)
		assert.match(setCookie, /SameSite=Lax/i)
		assert.match(setCookie, /Max-Age=\d+/)
		// На localhost без https Secure не ставим, иначе браузер не вернёт cookie.
		assert.doesNotMatch(setCookie, /Secure/i)

		const state = await fetch(`${base}/account/state`, { headers: { cookie: cookieOf(login) } })

		assert.equal(state.status, 200)
		assert.equal(state.headers.get('cache-control'), 'no-store')
		assert.deepEqual(await state.json(), { sub: 'u1' })

		const logout = await fetch(`${base}/account/logout`, {
			method: 'POST',
			headers: { origin: base, cookie: cookieOf(login) },
		})

		assert.match(logout.headers.get('set-cookie') ?? '', /mcp_session=;.*Expires=Thu, 01 Jan 1970/i)
	})

	test('за https cookie помечается Secure', async () => {
		const base = await start('https://mcp.example.com')
		const login = await fetch(`${base}/account/login`, {
			method: 'POST',
			headers: { origin: 'https://mcp.example.com' },
		})

		assert.match(login.headers.get('set-cookie') ?? '', /Secure/i)
	})

	test('без cookie, с чужой или битой cookie /account/state отвечает 401 JSON', async () => {
		const base = await start()

		for (const cookie of [undefined, 'mcp_session=garbage', 'mcp_session=%E0%A4%A']) {
			const res = await fetch(`${base}/account/state`, { headers: cookie ? { cookie } : {} })

			assert.equal(res.status, 401, String(cookie))
			assert.equal(res.headers.get('cache-control'), 'no-store')
			assert.deepEqual(await res.json(), { error: { code: 'unauthorized', message: 'Нужно войти' } })
		}
	})

	test('POST кабинета с чужого Origin или без него -- 403', async () => {
		const base = await start()

		for (const origin of ['https://evil.example', undefined]) {
			const res = await fetch(`${base}/account/login`, { method: 'POST', headers: origin ? { origin } : {} })

			assert.equal(res.status, 403, String(origin))
			assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'forbidden_origin')
			assert.equal(res.headers.get('set-cookie'), null)
		}
	})
})

describe('ошибки маршрутов сервиса', () => {
	test('apiError отдаёт свой статус и код без кэша', async () => {
		const res = await fetch(`${await start()}/account/busy`)

		assert.equal(res.status, 409)
		assert.equal(res.headers.get('cache-control'), 'no-store')
		assert.deepEqual(await res.json(), { error: { code: 'busy', message: 'Идёт сборка' } })
	})

	test('исключение в маршруте: браузер уходит на /error, fetch получает JSON 500', async () => {
		const base = await start()
		const page = await fetch(`${base}/account/boom`, { headers: { accept: 'text/html' }, redirect: 'manual' })

		assert.equal(page.status, 303)

		assert.equal(
			page.headers.get('location'),
			errorPage({ code: '500', title: 'Что-то сломалось', message: 'Попробуй ещё раз чуть позже.' }),
		)

		const api = await fetch(`${base}/account/boom`, { headers: { accept: 'application/json' } })

		assert.equal(api.status, 500)
		assert.deepEqual(await api.json(), { error: { code: 'internal', message: 'Internal error' } })
	})

	test('без страниц исключение и 404 -- всегда JSON', async () => {
		const base = await start(undefined, false)
		const page = await fetch(`${base}/account/boom`, { headers: { accept: 'text/html' }, redirect: 'manual' })

		assert.equal(page.status, 500)
		assert.equal(((await page.json()) as { error: { code: string } }).error.code, 'internal')

		const missing = await fetch(`${base}/nope`, { headers: { accept: 'text/html' } })

		assert.equal(missing.status, 404)
		assert.deepEqual(await missing.json(), { error: { code: 'not_found', message: 'Not found' } })
	})
})

test('errorPage: код по умолчанию и текст в query', () => {
	assert.equal(errorPage({ title: 'Нет' }), '/error?code=error&title=%D0%9D%D0%B5%D1%82')

	assert.equal(
		new URL(errorPage({ code: '403', title: 't', message: 'm' }), 'http://x').searchParams.get('message'),
		'm',
	)
})
