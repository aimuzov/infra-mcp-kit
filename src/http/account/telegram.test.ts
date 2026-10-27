import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { createHttpApp, type Route } from '#kit/http/app'
import { loadHttpConfig } from '#kit/http/config'
import { requireSession, sendJson } from '#kit/http/json'
import { loadTelegramConfig, telegramLogin, verifyTelegramLogin } from '#kit/http/login/telegram'
import { memoryStore } from '#kit/http/oauth/store'
import { Tokens } from '#kit/http/oauth/tokens'
import { sessions, type Sessions } from '#kit/http/session'
import { log } from '#kit/log'
import { McpServer } from '#kit/mcp'
import {
	accountLogin,
	connectHttp,
	fakePages,
	freshTelegramLogin,
	oauthFlow,
	signTelegramLogin,
	startHttp,
	telegramSigned,
	textOf,
	type LoginStep,
	type RunningHttp,
} from '#kit/testing/index'

import { SIGNIN_COOKIE, telegramAccount, type TelegramAccountOptions } from './telegram.ts'

const SECRET = 'x'.repeat(32)
const BOT = '123:bot'
const IVAN = { id: '42', first_name: 'Ivan' }
const running: RunningHttp[] = []

after(() => Promise.all(running.map((r) => r.close())))

// Английские страницы включают английские ответы: `createHttpApp` смотрит на каталог `en/`.
const publicDir = fakePages()

mkdirSync(join(publicDir, 'en'), { recursive: true })

/** Кабинет сервиса за входом кита: `/account/state` по той же сессии, по умолчанию -- кита. */
const state =
	(cabinet?: Sessions): Route =>
	async (request, { tokens, config }) => {
		if (new URL(request.url).pathname !== '/account/state') return undefined

		const session = await requireSession(cabinet ?? sessions(tokens, config.publicUrl), request)

		return session instanceof Response ? session : sendJson(session)
	}

async function start(options: Partial<TelegramAccountOptions> = {}) {
	const http = await startHttp((base) =>
		createHttpApp({
			config: { port: 0, publicUrl: new URL(base), authSecret: SECRET, allowedRedirectUris: [] },
			service: { name: 'test' },
			createServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
			publicDir,
			routes: [telegramAccount({ botToken: BOT, botName: 'test_bot', ...options }), state()],
		}),
	)

	running.push(http)

	return http.base
}

const ivan = { user: IVAN, botToken: BOT }

/** Подписанный вход, как его вернёт виджет, с меткой и cookie страницы входа. */
async function signed(base: string, user = IVAN) {
	const auth = await fetch(`${base}/account/auth`)
	const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
	const { state: label } = (await auth.json()) as { state: string }
	const url = new URL('/account/login', base)
	const fields = freshTelegramLogin(user, BOT)

	for (const [key, value] of Object.entries({ ...fields, state: label })) url.searchParams.set(key, value)

	return { url, cookie, label }
}

const go = (url: URL, cookie?: string) => fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} })

const errorOf = (res: Response) => {
	const location = new URL(res.headers.get('location') ?? '', 'http://x')

	assert.equal(location.pathname.replace(/^\/en/, ''), '/error')

	return { code: location.searchParams.get('code'), message: location.searchParams.get('message') ?? '' }
}

describe('вход в кабинет через Telegram', () => {
	test('страница входа получает бота из рантайма и метку в httpOnly cookie', async () => {
		const base = await start()
		const res = await fetch(`${base}/account/auth`)
		const body = (await res.json()) as { botName: string; dev: string | null; state: string }
		const cookie = res.headers.get('set-cookie') ?? ''

		assert.equal(res.headers.get('cache-control'), 'no-store')
		assert.equal(body.botName, 'test_bot')
		assert.equal(body.dev, null)
		assert.match(body.state, /^[\w-]{32}$/)
		assert.ok(cookie.startsWith(`${SIGNIN_COOKIE}=${body.state};`), cookie)
		assert.match(cookie, /HttpOnly/)
		assert.match(cookie, /SameSite=Lax/)
		assert.match(cookie, /Max-Age=600/)
		assert.doesNotMatch(cookie, /Secure/)
	})

	test('подпись виджета даёт cookie сессии и ведёт в кабинет, метка стирается', async () => {
		const base = await start()
		const { response, cookie } = await accountLogin(base, ivan)

		assert.equal(response.status, 302)
		assert.equal(response.headers.get('location'), '/account')

		const cookies = response.headers.getSetCookie()

		assert.match(cookies[0] ?? '', /^mcp_session=.+; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Lax$/)
		assert.match(cookies[1] ?? '', new RegExp(`^${SIGNIN_COOKIE}=; Max-Age=0;`))

		const me = await fetch(`${base}/account/state`, { headers: { cookie } })

		assert.equal(me.status, 200)

		assert.deepEqual(
			Object.entries((await me.json()) as Record<string, unknown>).filter(([key]) =>
				['sub', 'name'].includes(key),
			),
			[
				['name', 'Ivan'],
				['sub', '42'],
			],
		)
	})

	test('вход с английской страницы возвращает в английский кабинет', async () => {
		const base = await start()
		const { response } = await accountLogin(base, ivan, '/en/account/login')

		assert.equal(response.headers.get('location'), '/en/account')
	})

	test('чужая подпись -- страница ошибки без сессии', async () => {
		const base = await start()
		const { response, cookie } = await accountLogin(base, { user: IVAN, botToken: '999:forged' })

		assert.equal(response.status, 302)
		assert.equal(errorOf(response).code, 'login')
		assert.match(errorOf(response).message, /войди ещё раз/)
		assert.equal(cookie, '')
	})

	test('подпись без метки своей страницы входа не впускает: login CSRF', async () => {
		const base = await start()
		const { url, cookie, label } = await signed(base)

		// Ссылку с чужой подписью подсунули человеку: его браузер не открывал страницу входа.
		const noCookie = await go(url)

		assert.equal(errorOf(noCookie).code, 'login')
		assert.equal(noCookie.headers.getSetCookie().length, 0)

		// Метка из другой страницы входа, например чужая.
		const other = await signed(base)
		const mismatched = await go(url, other.cookie)

		assert.equal(errorOf(mismatched).code, 'login')

		url.searchParams.delete('state')

		assert.equal(errorOf(await go(url, cookie)).code, 'login')

		url.searchParams.set('state', label)

		assert.equal((await go(url, cookie)).headers.get('location'), '/account')
	})

	test('подписанная ссылка годится один раз', async () => {
		const base = await start()
		const { url, cookie } = await signed(base)

		assert.equal((await go(url, cookie)).headers.get('location'), '/account')

		const again = await go(url, cookie)

		assert.match(errorOf(again).message, /уже использована/)
		assert.equal(again.headers.getSetCookie().length, 0)
	})

	test('"Войти" без подписи ведёт на страницу входа на языке кабинета', async () => {
		const base = await start()
		const ru = await go(new URL('/account/login', base))
		const en = await go(new URL('/en/account/login', base))

		assert.equal(ru.status, 302)
		assert.equal(ru.headers.get('location'), '/account/signin')
		assert.equal(en.headers.get('location'), '/en/account/signin')
		assert.match(await (await fetch(new URL('/account/signin', base))).text(), /page:account\/signin/)
	})

	test('выход только со страницы сервиса', async () => {
		const base = await start()
		const { cookie } = await accountLogin(base, ivan)
		const logout = (origin?: string) =>
			fetch(`${base}/account/logout`, { method: 'POST', headers: { cookie, ...(origin ? { origin } : {}) } })

		for (const origin of ['https://evil.example', undefined]) {
			const res = await logout(origin)

			assert.equal(res.status, 403, String(origin))
			assert.equal(res.headers.get('set-cookie'), null)
		}

		const res = await logout(base)

		assert.equal(res.status, 200)
		assert.match(res.headers.get('set-cookie') ?? '', /^mcp_session=;.*Max-Age=0/)
	})

	test('dev-вход на localhost без бота, а без devUserId ссылка ?dev=1 не пускает', async () => {
		const dev = await start({ botToken: '', botName: '', devUserId: '7' })
		const auth = (await (await fetch(`${dev}/account/auth`)).json()) as { botName: string | null; dev: string }

		assert.equal(auth.botName, null)
		assert.equal(auth.dev, '7')

		const { cookie } = await accountLogin(dev, 'dev')
		const me = (await (await fetch(`${dev}/account/state`, { headers: { cookie } })).json()) as { sub: string }

		assert.equal(me.sub, '7')

		// Без бота подпись не проверить ничем: даже подписанная пустым токеном не годится.
		const blank = await accountLogin(dev, { user: IVAN, botToken: '' })

		assert.equal(errorOf(blank.response).code, 'login')

		const prod = await start()

		assert.equal(errorOf((await accountLogin(prod, 'dev')).response).code, 'login')
	})

	test('на проде devUserId не работает, а только пишет в лог, и сессия -- своего приложения', async () => {
		const warnings: string[] = []
		const logger = { ...log, warn: (message: string) => warnings.push(message) }
		// Один маршрут на два приложения: что видел localhost, не должно попасть в прод.
		const account = telegramAccount({ botToken: BOT, botName: 'test_bot', devUserId: '7' })
		const appAt = (url: string) =>
			createHttpApp({
				config: loadHttpConfig({ AUTH_SECRET: SECRET, PUBLIC_URL: url }),
				service: { name: 'test' },
				createServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
				logger,
				routes: [account, state()],
			})
		const local = await appAt('http://localhost:8080').handle(new Request('http://localhost:8080/account/auth'))

		assert.equal(((await local.json()) as { dev: string | null }).dev, '7')

		const app = appAt('https://mcp.example.com')
		const auth = await app.handle(new Request('https://mcp.example.com/account/auth'))
		const body = (await auth.json()) as { dev: string | null; state: string }

		assert.equal(body.dev, null)

		const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
		const login = await app.handle(
			new Request(`https://mcp.example.com/account/login?dev=1&state=${body.state}`, { headers: { cookie } }),
		)

		assert.equal(errorOf(login).code, 'login')
		assert.equal(login.headers.getSetCookie().length, 0)
		assert.equal(warnings.length, 1)
		assert.match(warnings[0] ?? '', /devUserId is ignored/)

		const signed = new URL(`https://mcp.example.com/account/login?state=${body.state}`)

		for (const [key, value] of Object.entries(freshTelegramLogin(IVAN, BOT))) signed.searchParams.set(key, value)

		const session = (await app.handle(new Request(signed, { headers: { cookie } }))).headers.getSetCookie()[0]
		const me = await app.handle(
			new Request('https://mcp.example.com/account/state', { headers: { cookie: session?.split(';')[0] ?? '' } }),
		)

		assert.equal(me.status, 200)
	})

	test('свои claims сессии, но sub -- всегда Telegram id', async () => {
		const base = await start({ claims: (user) => ({ name: `@${user.username}`, sub: 'admin', kind: 'access' }) })
		const { cookie } = await accountLogin(base, { user: { ...IVAN, username: 'ivan' }, botToken: BOT })
		const me = (await (await fetch(`${base}/account/state`, { headers: { cookie } })).json()) as {
			sub: string
			name: string
			kind: string
		}

		assert.equal(me.sub, '42')
		assert.equal(me.name, '@ivan')
		assert.equal(me.kind, 'session')
	})

	test('без бота и без dev-входа маршруты не собрать', () => {
		assert.throws(() => telegramAccount({ botToken: BOT }), /botName/)
		assert.throws(() => telegramAccount({ botToken: '', botName: 'test_bot' }), /botToken/)
	})

	test('за https метка и сессия -- __Host- cookie, подложенные без префикса не годятся', async () => {
		const prod = 'https://mcp.example.com'
		const app = createHttpApp({
			config: loadHttpConfig({ AUTH_SECRET: SECRET, PUBLIC_URL: prod }),
			service: { name: 'test' },
			createServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
			routes: [telegramAccount({ botToken: BOT, botName: 'test_bot' }), state()],
		})
		const get = (path: string | URL, cookie = '') =>
			app.handle(new Request(new URL(path, prod), { headers: cookie ? { cookie } : {} }))

		/** Своя страница входа и подписанная ссылка виджета на неё. */
		const signin = async (user = IVAN) => {
			const auth = await get('/account/auth')
			const setCookie = auth.headers.get('set-cookie') ?? ''
			const { state: label } = (await auth.json()) as { state: string }
			const url = new URL(`/account/login?state=${label}`, prod)

			for (const [key, value] of Object.entries(freshTelegramLogin(user, BOT))) url.searchParams.set(key, value)

			return { setCookie, label, url }
		}

		const mine = await signin()

		assert.match(mine.setCookie, /^__Host-mcp_signin=[\w-]+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax; Secure$/)

		// Злоумышленник прошёл вход сам и положил свою метку на родительский домен
		// без префикса: браузер человека пришлёт её, но кит читает только __Host-.
		const stranger = await signin({ id: '666', first_name: 'Mallory' })
		const planted = await get(stranger.url, `mcp_signin=${stranger.label}`)

		assert.equal(errorOf(planted).code, 'login')
		assert.equal(planted.headers.getSetCookie().length, 0)

		const login = await get(mine.url, `__Host-mcp_signin=${mine.label}`)
		const [session, cleared] = login.headers.getSetCookie()

		assert.equal(login.headers.get('location'), '/account')
		assert.match(session ?? '', /^__Host-mcp_session=.+; Path=\/; HttpOnly; SameSite=Lax; Secure$/)
		assert.match(cleared ?? '', /^__Host-mcp_signin=; Max-Age=0;/)

		const pair = session?.split(';')[0] ?? ''

		assert.equal((await get('/account/state', pair)).status, 200)
		// Ту же сессию без префикса мог положить соседний поддомен.
		assert.equal((await get('/account/state', pair.replace(/^__Host-/, ''))).status, 401)
	})
})

describe('свои сессии сервиса', () => {
	test('вход кладёт сессию в cookie сервиса, и его маршруты её читают', async () => {
		const http = await startHttp((base) => {
			const publicUrl = new URL(base)
			// Свои `Tokens` с тем же секретом и издателем, что у кита: так их строит thinks.
			const cabinet = sessions(
				new Tokens({ secret: SECRET, issuer: publicUrl.href }),
				publicUrl,
				'thinks_session',
			)

			return createHttpApp({
				config: { port: 0, publicUrl, authSecret: SECRET, allowedRedirectUris: [] },
				service: { name: 'test' },
				createServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
				publicDir,
				routes: [telegramAccount({ botToken: BOT, botName: 'test_bot', sessions: cabinet }), state(cabinet)],
			})
		})

		running.push(http)

		const { response, cookie } = await accountLogin(http.base, ivan)

		assert.match(response.headers.getSetCookie()[0] ?? '', /^thinks_session=/)
		assert.ok(cookie.startsWith('thinks_session='), cookie)
		assert.equal((await fetch(`${http.base}/account/state`, { headers: { cookie } })).status, 200)

		const logout = await fetch(`${http.base}/account/logout`, {
			method: 'POST',
			headers: { cookie, origin: http.base },
		})

		assert.match(logout.headers.get('set-cookie') ?? '', /^thinks_session=;/)
	})
})

describe('одна подпись на OAuth-вход и кабинет', () => {
	/** Сервис, где Telegram пускает и в OAuth, и в кабинет, как в README. */
	async function both() {
		const telegram = { botToken: BOT, botName: 'test_bot' }
		const http = await startHttp((base) =>
			createHttpApp({
				config: { port: 0, publicUrl: new URL(base), authSecret: SECRET, allowedRedirectUris: [] },
				service: { name: 'test' },
				createServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
				publicDir,
				auth: { store: memoryStore(), login: telegramLogin(telegram) },
				routes: [telegramAccount(telegram)],
			}),
		)

		running.push(http)

		return http.base
	}

	/** Виджет вернул человека на колбэк OAuth-входа с этими полями. */
	const widget = (fields: Record<string, string>) => (step: LoginStep) => {
		const url = new URL(step.callback)

		url.searchParams.set('request', step.request)

		for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value)

		return fetch(url, { redirect: 'manual' })
	}

	test('подпись из OAuth-входа не впускает в кабинет', async () => {
		const base = await both()
		const fields = freshTelegramLogin(IVAN, BOT)

		await oauthFlow({ base, login: widget(fields) })

		// Подпись взяли из истории браузера, а метку и cookie -- со своей страницы входа.
		const { url, cookie } = await signed(base)

		for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value)

		const replay = await go(url, cookie)

		assert.match(errorOf(replay).message, /уже использована/)
		assert.equal(replay.headers.getSetCookie().length, 0)
	})

	test('подпись из входа в кабинет не даёт OAuth-токенов', async () => {
		const base = await both()
		const { url, cookie } = await signed(base)

		assert.equal((await go(url, cookie)).headers.get('location'), '/account')

		const fields = Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'state'))

		await assert.rejects(oauthFlow({ base, login: widget(fields) }), /уже использована/)
	})
})

describe('имя бота в рантайме', () => {
	test('OAuth-вход отдаёт бота странице с сервера, не во фрагменте, и пускает по подписи', async () => {
		const http = await startHttp((base) =>
			createHttpApp({
				config: { port: 0, publicUrl: new URL(base), authSecret: SECRET, allowedRedirectUris: [] },
				service: { name: 'test' },
				createServer: (auth) => {
					const server = new McpServer({ name: 'test', version: '0.0.0' })

					server.registerTool('whoami', { description: 'who' }, () => ({
						content: [{ type: 'text', text: String(auth?.extra?.subject) }],
					}))

					return server
				},
				publicDir,
				auth: { store: memoryStore(), login: telegramLogin({ botToken: BOT, botName: 'runtime_bot' }) },
			}),
		)

		running.push(http)

		let seen: LoginStep | undefined
		const flow = await oauthFlow({
			base: http.base,
			login: (step) => {
				seen = step

				return telegramSigned(IVAN, BOT)(step)
			},
		})

		// Фрагмент в ссылке подставит кто угодно: бота страница берёт только с сервера.
		assert.deepEqual(seen?.context, {})

		const page = await fetch(`${http.base}/authorize/page`)

		assert.deepEqual(await page.json(), { bot: 'runtime_bot' })
		assert.equal(page.headers.get('cache-control'), 'no-store')
		assert.equal((await fetch(`${http.base}/authorize/page`, { method: 'POST' })).status, 405)

		const client = await connectHttp(http.base, flow.tokens.access_token)

		assert.equal(textOf(await client.callTool({ name: 'whoami' })), '42')
		await client.close()
	})

	test('фрагмент прежний: бот едет в pageData, dev-id -- во фрагменте', () => {
		assert.equal(telegramLogin({ botToken: BOT }).context, undefined)
		assert.equal(telegramLogin({ botToken: BOT }).pageData, undefined)

		const login = telegramLogin({ botToken: BOT, botName: 'b_bot', devUserId: '7' })

		assert.deepEqual(login.context, { dev: '7' })
		assert.deepEqual(login.pageData, { bot: 'b_bot' })
	})

	test('конфиг: бот из окружения, dev-вход только на localhost и без бота', () => {
		const prod = new URL('https://mcp.example.com')
		const local = new URL('http://localhost:8080')

		assert.deepEqual(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_BOT_NAME: '@thinks_bot' }, prod), {
			botToken: BOT,
			botName: 'thinks_bot',
			devUserId: '',
		})

		assert.throws(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: BOT }, prod), /TELEGRAM_BOT_NAME/)
		assert.throws(() => loadTelegramConfig({ TELEGRAM_BOT_NAME: 'thinks_bot' }, prod), /TELEGRAM_BOT_TOKEN/)

		assert.throws(
			() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_BOT_NAME: 'thinks bot' }, prod),
			/не имя бота/,
		)

		assert.deepEqual(loadTelegramConfig({ THINKS_DEV_USER_ID: '7' }, local, 'THINKS_DEV_USER_ID'), {
			botToken: '',
			botName: '',
			devUserId: '7',
		})

		assert.throws(() => loadTelegramConfig({ TELEGRAM_DEV_USER_ID: '7' }, prod), /localhost/)
		assert.throws(() => loadTelegramConfig({ TELEGRAM_DEV_USER_ID: 'me' }, local), /числовой/)
	})

	test('подпись пустым токеном бота не проверяется', () => {
		const query = signTelegramLogin({ ...IVAN, auth_date: String(Math.floor(Date.now() / 1000)) }, '')

		assert.equal(verifyTelegramLogin(query, ''), null)
	})
})
