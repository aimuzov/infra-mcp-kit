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
						if (token !== 'good') throw new LoginError('Токен не подошёл')

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
	test('адрес на лендинге -- CopyValue со своими стилями и настоящим адресом', async () => {
		const { page, context } = await open('/')
		const button = page.locator('.connect__url .copy__button')

		assert.equal(await button.locator('.copy__value').textContent(), new URL('/mcp', http.base).href)

		const style = await button.evaluate((node) => {
			const css = getComputedStyle(node)

			return {
				radius: css.borderTopLeftRadius,
				font: getComputedStyle(node.querySelector('.copy__value')!).fontFamily,
			}
		})

		assert.equal(style.radius, '6px')
		assert.match(style.font, /mono/i)
		await context.close()
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
