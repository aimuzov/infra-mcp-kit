/**
 * Страницы кита на настоящей сборке Astro: OAuth-вход через статическую `/login`, острова
 * в Chromium и скриншоты всех экранов в обеих темах. CSP режет инлайн-код молча, поэтому
 * любая строка "Refused to" в консоли -- провал. Снимки не сравниваем: шрифты на раннере другие,
 * они лежат в `test-results/screens` для глаз и для PR.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

import { createHttpApp } from '#kit/http/app'
import { tokenFormLogin } from '#kit/http/login/token-form'
import { LoginError } from '#kit/http/oauth/provider'
import { memoryStore } from '#kit/http/oauth/store'
import { McpServer } from '#kit/mcp'
import {
	connectHttp,
	loginStep,
	oauthFlow,
	startHttp,
	submitForm,
	textOf,
	type LoginStep,
	type RunningHttp,
} from '#kit/testing/index'

import { buildPages } from './pages.ts'

const SHOTS = fileURLToPath(new URL('../test-results/screens', import.meta.url))
const CLIENT_REDIRECT = 'http://127.0.0.1:9/cb'

let http: RunningHttp
let browser: Browser
const problems: string[] = []

before(async () => {
	const publicDir = buildPages()

	http = await startHttp((base) =>
		createHttpApp({
			config: { port: 0, publicUrl: new URL(base), authSecret: 'x'.repeat(32), allowedRedirectUris: [] },
			service: { name: 'fixture' },
			publicDir,
			auth: {
				store: memoryStore(),
				tokens: 'encrypt',
				login: tokenFormLogin({
					fields: [{ name: 'token', label: 'API-токен' }],
					verify: ({ token }) => {
						if (token !== 'good')
							throw new LoginError({ ru: 'Токен не подошёл', en: 'The token did not fit' })

						return { subject: 'user-1', claims: { apiToken: token } }
					},
				}),
			},
			createServer: (auth) => {
				const server = new McpServer({ name: 'fixture', version: '0.0.0' })

				server.registerTool('whoami', { description: 'who' }, () => ({
					content: [{ type: 'text', text: String(auth?.extra?.subject ?? 'nobody') }],
				}))

				return server
			},
			// Кабинет фикстуры: cookie `fixture=1` -- вошёл, без неё 401.
			routes: (request) => {
				if (request.method !== 'GET' || new URL(request.url).pathname !== '/account/state') return undefined

				if (!(request.headers.get('cookie') ?? '').includes('fixture=1')) {
					return Response.json({ error: { code: 'unauthorized', message: 'Нужно войти' } }, { status: 401 })
				}

				return Response.json({ name: 'Алексей', corpus: 'ready' })
			},
		}),
	)

	browser = await chromium.launch()
	mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
	await browser?.close()
	await http?.close()
})

/** Клиент регистрируется и идёт в `/authorize`: адрес страницы входа с контекстом во фрагменте. */
async function authorize(): Promise<{ url: string; step: LoginStep }> {
	const base = http.base
	const reg = await fetch(`${base}/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			client_name: 'Claude',
			redirect_uris: [CLIENT_REDIRECT],
			token_endpoint_auth_method: 'none',
		}),
	})
	const { client_id } = (await reg.json()) as { client_id: string }
	const res = await fetch(
		`${base}/authorize?${new URLSearchParams({
			response_type: 'code',
			client_id,
			redirect_uri: CLIENT_REDIRECT,
			code_challenge: 'x'.repeat(43),
			code_challenge_method: 'S256',
		})}`,
		{ redirect: 'manual' },
	)
	const location = res.headers.get('location') ?? ''

	return { url: new URL(location, base).href, step: loginStep(location, base) }
}

type OpenOptions = { scheme?: 'light' | 'dark'; width?: number; cookie?: boolean }

async function open(path: string, { scheme = 'light', width = 1280, cookie }: OpenOptions = {}) {
	const context: BrowserContext = await browser.newContext({
		viewport: { width, height: width < 600 ? 844 : 900 },
		colorScheme: scheme,
		deviceScaleFactor: 2,
	})

	// Виджет Telegram в тестах не грузим: сеть раннера не наша забота, а CSP его страницы проверяем ниже.
	await context.route('https://telegram.org/**', (route) => route.abort())

	if (cookie) await context.addCookies([{ name: 'fixture', value: '1', url: http.base }])

	const page: Page = await context.newPage()

	page.on('console', (m) => {
		if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(`${path}: ${m.text()}`)
	})

	page.on('pageerror', (e) => problems.push(`${path}: ${e.message}`))

	await page.goto(new URL(path, http.base).href)
	await page.waitForLoadState('networkidle')

	return { page, context }
}

describe('OAuth через статическую страницу входа', () => {
	test('вход формой доходит до инструмента, код одноразовый, ошибка возвращает на форму', async () => {
		const { step } = await authorize()
		const page = await fetch(new URL(step.page, http.base))

		assert.equal(page.status, 200)
		assert.match(await page.text(), /astro-island/)

		const refused = await submitForm({ token: 'bad' })(step)

		assert.equal(refused.status, 303)
		assert.match(loginStep(refused.headers.get('location') ?? '', http.base).error, /Токен не подошёл/)

		const flow = await oauthFlow({ base: http.base, login: submitForm({ token: 'good' }) })
		const client = await connectHttp(http.base, flow.tokens.access_token)

		assert.equal(textOf(await client.callTool({ name: 'whoami' })), 'user-1')
		await client.close()
		assert.equal((await flow.exchangeAgain()).status, 400)
	})

	test('остров формы: клиент из фрагмента, ошибка после неверного токена, код клиенту', async () => {
		const { url } = await authorize()
		const { page, context } = await open(url)

		assert.match(await page.locator('main').innerText(), /Claude/)
		assert.ok((await page.locator('input[name=request]').inputValue()).length > 20)

		await page.fill('input[name=token]', 'bad')
		await Promise.all([page.waitForURL(/error=/), page.click('button[type=submit]')])
		await page.waitForSelector('[role=alert]')
		assert.match(await page.locator('[role=alert]').innerText(), /Токен не подошёл/)

		await page.fill('input[name=token]', 'good')

		const [request] = await Promise.all([
			page.waitForRequest((r) => r.url().startsWith(CLIENT_REDIRECT)),
			page.click('button[type=submit]'),
		])

		assert.match(request.url(), /code=/)
		await context.close()
	})
})

describe('острова', () => {
	test('кабинет: гость видит вход, с cookie -- данные сервиса', async () => {
		const guest = await open('/account')

		assert.match(await guest.page.locator('main').innerText(), /Нужно войти/)
		await guest.context.close()

		const me = await open('/account', { cookie: true })

		assert.equal(await me.page.locator('[data-corpus]').innerText(), 'ready')
		assert.match(await me.page.locator('main').innerText(), /Привет, Алексей/)
		await me.context.close()
	})

	test('ошибка показывает текст из query как текст, а не разметку', async () => {
		const { page, context } = await open('/error?code=400&title=%3Cb%3Ex%3C%2Fb%3E&message=Начни%20заново')

		assert.equal(await page.locator('h1').innerText(), '<b>x</b>')
		assert.match(await page.locator('main').innerText(), /Начни заново/)
		await context.close()
	})

	test('кнопка темы переворачивает схему и запоминает выбор', async () => {
		const { page, context } = await open('/')

		await page.click('button[aria-label="Сменить тему"]')
		assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
		await page.reload()
		assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
		await context.close()
	})

	test('знак сервиса у имени и на экране входа, глитч в цветах сервиса', async () => {
		const { page, context } = await open('/')

		assert.equal(await page.locator('.hero__title .hero__logo svg').count(), 1)
		// Иконка только у инструмента, где она задана: строка остаётся простым чипом.
		assert.equal(await page.locator('.chips li', { hasText: 'whoami' }).locator('svg.lucide-user').count(), 1)
		assert.equal(await page.locator('.chips li', { hasText: 'ping' }).locator('svg').count(), 0)

		const glitch = await page.locator('.hero h1').evaluate((node) => ({
			a: getComputedStyle(node, '::before').color,
			b: getComputedStyle(node, '::after').color,
		}))

		assert.deepEqual(glitch, { a: 'rgb(241, 31, 36)', b: 'rgb(95, 232, 176)' })
		await page.goto(`${http.base}/login`)
		assert.equal(await page.locator('.handshake__logo svg').count(), 1)
		assert.equal(await page.locator('.handshake__mark').count(), 0)
		await context.close()
	})

	test('подпись автора -- Credit из site-kit со ссылкой на исходники', async () => {
		const { page, context } = await open('/')

		assert.equal(await page.locator('footer .credit').count(), 1)

		assert.equal(
			await page.locator('footer a', { hasText: 'Исходный код' }).getAttribute('href'),
			'https://github.com/aimuzov/infra-mcp-kit',
		)

		await context.close()
	})

	// Стили компонентов, которые появляются только в браузере, Astro в страницу не вшивает:
	// адрес на лендинге раньше был голой системной кнопкой.
	test('адрес на лендинге -- плашка со своими стилями, настоящим адресом и в одну строку', async () => {
		const { page, context } = await open('/')
		const value = page.locator('.connect__url .plate__value')

		assert.equal(await value.textContent(), new URL('/mcp', http.base).href)

		const style = await value.evaluate((node) => {
			const css = getComputedStyle(node)

			return { font: css.fontFamily, wrap: css.whiteSpace, overflow: css.textOverflow }
		})

		assert.match(style.font, /mono/i)
		assert.deepEqual([style.wrap, style.overflow], ['nowrap', 'ellipsis'])
		await context.close()
	})

	test('вкладки подключения: клик и стрелки переключают, команда для Claude Code с адресом', async () => {
		const { page, context } = await open('/')
		const code = page.getByRole('tab', { name: 'Claude Code' })

		assert.equal(await page.locator('#connect-panel-code').isHidden(), true)
		await code.click()
		assert.equal(await code.getAttribute('aria-selected'), 'true')

		assert.match(
			(await page.locator('#connect-panel-code .plate__value').textContent()) ?? '',
			/^claude mcp add --transport http fixture http:\/\/.+\/mcp$/,
		)

		await page.keyboard.press('ArrowLeft')
		assert.equal(await page.getByRole('tab', { name: 'claude.ai и Desktop' }).getAttribute('aria-selected'), 'true')
		assert.equal(await page.locator('#connect-panel-app').isVisible(), true)
		await context.close()
	})
})

describe('языки', () => {
	test('английские страницы: lang, тексты кита и сервиса, подпись автора', async () => {
		const { page, context } = await open('/en/')

		assert.equal(await page.locator('html').getAttribute('lang'), 'en')
		assert.equal(await page.locator('.brand__label').innerText(), 'MCP connector')
		assert.match(await page.locator('.tagline').innerText(), /A check of the kit pages/)
		assert.match(await page.locator('main').innerText(), /tools/i)
		assert.match(await page.locator('main').innerText(), /ping/)
		assert.match(await page.locator('footer').innerText(), /Source code/)
		await context.close()

		const ru = await open('/')

		assert.equal(await ru.page.locator('html').getAttribute('lang'), 'ru')
		assert.equal(await ru.page.locator('.brand__label').innerText(), 'MCP-коннектор')
		await ru.context.close()
	})

	test('hreflang и canonical указывают на обе версии', async () => {
		const { page, context } = await open('/en/login')
		const links = await page
			.locator('link[rel="alternate"]')
			.evaluateAll((els) =>
				els.map((el) => [el.getAttribute('hreflang'), new URL(el.getAttribute('href') ?? '').pathname]),
			)

		assert.deepEqual(links, [
			['ru', '/login'],
			['en', '/en/login'],
			['x-default', '/login'],
		])

		assert.equal(
			new URL((await page.locator('link[rel="canonical"]').getAttribute('href')) ?? '').pathname,
			'/en/login',
		)

		await context.close()
	})

	test('переключатель ведёт на ту же страницу и запоминает выбор', async () => {
		const { page, context } = await open('/account')

		await page.locator('a.lang').click()
		await page.waitForURL(/\/en\/account$/)
		// Экран входа рисует остров после запроса состояния, его и ждём.
		await page.getByRole('heading', { name: 'Sign in first' }).waitFor()

		// Выбор в cookie сильнее Accept-Language: русская ссылка теперь ведёт на английскую.
		await page.goto(new URL('/login', http.base).href)
		assert.equal(new URL(page.url()).pathname, '/en/login')

		await page.locator('a.lang').click()
		await page.waitForURL(/\/login$/)
		assert.equal(await page.locator('html').getAttribute('lang'), 'ru')
		await context.close()
	})

	test('первый заход по Accept-Language уводит на английскую версию, фрагмент на месте', async () => {
		const res = await fetch(new URL('/login?x=1', http.base), {
			redirect: 'manual',
			headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
		})

		assert.equal(res.status, 302)
		assert.equal(res.headers.get('location'), '/en/login?x=1')

		const ru = await fetch(new URL('/login', http.base), {
			redirect: 'manual',
			headers: { accept: 'text/html', 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.5' },
		})

		assert.equal(ru.status, 200)

		// Без cookie ссылку на /en/ не трогаем, а JSON и API не редиректим вовсе.
		const en = await fetch(new URL('/en/login', http.base), {
			redirect: 'manual',
			headers: { accept: 'text/html', 'accept-language': 'ru' },
		})

		assert.equal(en.status, 200)

		const api = await fetch(new URL('/account/state', http.base), {
			headers: { accept: 'application/json', 'accept-language': 'en' },
		})

		assert.equal(api.status, 401)

		const { url } = await authorize()
		const context = await browser.newContext({ locale: 'en-US' })
		const page = await context.newPage()

		await page.goto(url)
		await page.waitForLoadState('networkidle')
		assert.equal(new URL(page.url()).pathname, '/en/login')
		assert.match(await page.locator('main').innerText(), /A client|Client/)
		assert.equal(await page.locator('button[type="submit"]').innerText(), 'Connect')
		await context.close()
	})

	test('ошибка входа на английской странице приходит по-английски', async () => {
		const { url } = await authorize()
		const context = await browser.newContext({ locale: 'en-US' })
		const page = await context.newPage()

		await page.goto(url)
		await page.locator('input[name="token"]').fill('bad')
		await page.locator('button[type="submit"]').click()
		await page.waitForURL(/\/en\/login/)
		assert.match(await page.locator('main').innerText(), /The token did not fit/)
		await context.close()
	})

	test('английская 404', async () => {
		const { page, context } = await open('/en/nope')

		assert.match(await page.locator('h1').innerText(), /There is no such page/)
		await context.close()
	})
})

describe('лендинг', () => {
	/** Что стоит в `main` лендинга по порядку: карточки по `data-card`, остальное по заголовку. */
	async function order(page: Page): Promise<string[]> {
		return page
			.locator('main > *')
			.evaluateAll((els) =>
				els.map(
					(el) =>
						el.getAttribute('data-card') ??
						el.getAttribute('data-slot') ??
						(el.matches('.hero') ? 'hero' : (el.querySelector('h2')?.textContent ?? el.tagName)),
				),
			)
	}

	test('карточки из конфига встают после героя и в конце, ссылки -- кнопки', async () => {
		const { page, context } = await open('/')

		assert.deepEqual(await order(page), ['hero', 'account', 'Подключить', 'Инструменты', 'help'])

		const account = page.locator('[data-card="account"]')

		assert.match((await account.textContent()) ?? '', /Сначала кабинет[\s\S]*Войди и загрузи корпус/)

		const enter = account.getByRole('link', { name: 'Открыть кабинет' })

		assert.equal(await enter.getAttribute('href'), '/account')
		assert.equal(await enter.getAttribute('target'), null)

		// Главная ссылка -- залитая кнопка с расслоением, остальные обведены.
		const look = await enter.evaluate((node) => {
			const css = getComputedStyle(node)

			return {
				underline: css.textDecorationLine,
				shadow: css.boxShadow,
				height: node.getBoundingClientRect().height,
			}
		})

		assert.equal(look.underline, 'none')
		assert.match(look.shadow, /rgb\(241, 31, 36\).*rgb\(95, 232, 176\)/)
		assert.equal(look.height, 40)

		const readme = page.locator('[data-card="help"]').getByRole('link', { name: 'README' })

		assert.deepEqual(
			[await readme.getAttribute('target'), await readme.getAttribute('rel')],
			['_blank', 'noopener'],
		)

		assert.equal(await readme.locator('svg').count(), 1)

		assert.equal(
			await page.locator('[data-card="help"]').getByRole('link', { name: 'Написать' }).getAttribute('href'),
			'mailto:help@example.com',
		)

		await enter.click()
		await page.waitForURL(/\/account$/)
		await context.close()
	})

	test('английский лендинг: тексты по ключам и по языкам, путь ссылки с языком', async () => {
		const { page, context } = await open('/en/')
		const account = page.locator('[data-card="account"]')

		assert.match((await account.textContent()) ?? '', /Account first[\s\S]*Sign in and upload the corpus/)
		assert.equal(await account.getByRole('link', { name: 'Open the account' }).getAttribute('href'), '/en/account')
		assert.match((await page.locator('[data-card="help"]').textContent()) ?? '', /Help[\s\S]*Write to us/)
		await context.close()
	})

	test('свой лендинг на разметке кита: слоты после героя, после "Подключить" и в конце', async () => {
		const { page, context } = await open('/landing')

		assert.deepEqual(await order(page), [
			'hero',
			'account',
			'status',
			'Подключить',
			'faq',
			'Инструменты',
			'help',
			'end',
		])

		// Своя разметка в слоте карточки встаёт между заголовком и ссылками.
		assert.equal(await page.locator('[data-card="faq"] .grants li').count(), 1)
		await context.close()

		const en = await open('/en/landing')

		assert.match((await en.page.locator('[data-card="status"]').textContent()) ?? '', /Corpus status/)
		assert.match((await en.page.locator('[data-slot="end"]').textContent()) ?? '', /The last slot/)
		await en.context.close()
	})
})

describe('скриншоты', () => {
	test('все экраны в обеих темах на телефоне и десктопе, без нарушений CSP и ошибок JS', async () => {
		const { url: login } = await authorize()
		const loginError = `${login}&error=${encodeURIComponent('Токен не подошёл')}`
		const telegram = `/login/telegram#request=r&callback=%2Fauthorize%2Fcallback&client=Claude&host=claude.ai&dev=42`
		const screens: Record<string, [string, OpenOptions?]> = {
			landing: ['/'],
			login: [login],
			'login-error': [loginError],
			telegram: [telegram],
			error: ['/error?code=invalid_request&title=Ссылка устарела&message=Начни подключение заново из клиента.'],
			'not-found': ['/nope'],
			'account-guest': ['/account'],
			account: ['/account', { cookie: true }],
			'en.landing': ['/en/'],
			'en.login': [login.replace('/login', '/en/login')],
			'en.telegram': [`/en${telegram}`],
			'en.error': [
				'/en/error?code=invalid_request&title=The sign-in link has expired&message=Start connecting again from the client.',
			],
			'en.not-found': ['/en/nope'],
			'en.account-guest': ['/en/account'],
			'en.account': ['/en/account', { cookie: true }],
			'landing-slots': ['/landing'],
			'en.landing-slots': ['/en/landing'],
		}

		for (const [name, [path, options]] of Object.entries(screens)) {
			for (const scheme of ['light', 'dark'] as const) {
				for (const [label, width] of [
					['desktop', 1280],
					['phone', 390],
				] as const) {
					const { page, context } = await open(path, { ...options, scheme, width })

					await page.screenshot({ path: join(SHOTS, `${name}.${scheme}.${label}.png`), fullPage: true })
					await context.close()
				}
			}
		}

		assert.deepEqual(problems, [])
	})
})
