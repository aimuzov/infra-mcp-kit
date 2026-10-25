// Браузерная проверка статики: node browser-e2e.mjs <shots-dir>
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = 'http://localhost:8790'
const out = process.argv[2]

mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const violations = []

async function open(path, { scheme = 'light', viewport = { width: 1280, height: 860 }, cookie } = {}) {
	const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2 })

	if (cookie) await context.addCookies([{ name: 'spike', value: '1', url: BASE }])

	const page = await context.newPage()

	page.on('console', (m) => {
		if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(`${path}: ${m.text()}`)
	})

	page.on('pageerror', (e) => violations.push(`${path}: ${e.message}`))
	await page.goto(BASE + path)
	await page.waitForLoadState('networkidle')

	return { page, context }
}

// Контекст входа, как его выдаёт /authorize.
const reg = await fetch(`${BASE}/register`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({
		client_name: 'Claude',
		redirect_uris: ['http://localhost:9999/cb'],
		token_endpoint_auth_method: 'none',
	}),
}).then((r) => r.json())
const auth = new URL(`${BASE}/authorize`)

Object.entries({
	response_type: 'code',
	client_id: reg.client_id,
	redirect_uri: 'http://localhost:9999/cb',
	code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
	code_challenge_method: 'S256',
}).forEach(([k, v]) => auth.searchParams.set(k, v))

const loginUrl = new URL((await fetch(auth, { redirect: 'manual' })).headers.get('location'), BASE)
const loginPath = loginUrl.pathname + loginUrl.hash

// Остров входа: клиент из фрагмента, скрытый запрос, отправка неверного токена возвращает с ошибкой.
{
	const { page, context } = await open(loginPath)

	assert.match(await page.locator('.panel.auth').innerText(), /Claude/)
	assert.ok((await page.locator('input[name=request]').inputValue()).length > 20)
	await page.fill('input[name=token]', 'bad')
	await Promise.all([page.waitForURL(/error=/), page.click('button[type=submit]')])
	await page.waitForSelector('.alert')
	assert.match(await page.locator('.alert').innerText(), /Токен не подошёл/)
	await page.screenshot({ path: join(out, 'login-error.light.desktop.png'), fullPage: true })

	await page.fill('input[name=token]', 'good')

	const [request] = await Promise.all([
		page.waitForRequest((r) => r.url().startsWith('http://localhost:9999/cb')),
		page.click('button[type=submit]'),
	])

	assert.match(request.url(), /code=/)
	console.log('browser login: error back and code to client ok')
	await context.close()
}

// Кабинет: гость видит вход, с cookie -- данные из /account/state.
{
	const guest = await open('/account')

	assert.match(await guest.page.locator('main').innerText(), /Войди/)
	await guest.context.close()

	const me = await open('/account', { cookie: true })

	assert.equal(await me.page.locator('[data-corpus]').innerText(), 'ready')
	await me.context.close()
	console.log('account island: guest and ready ok')
}

// Скриншоты всех экранов.
const screens = {
	landing: '/',
	login: loginPath,
	telegram: '/login/telegram',
	error: '/error?code=400&title=Ссылка устарела&message=Начни заново',
	missing: '/nope',
	'account-guest': '/account',
	account: '/account',
}

for (const [name, path] of Object.entries(screens)) {
	for (const scheme of ['light', 'dark']) {
		for (const [label, viewport] of [
			['desktop', { width: 1280, height: 860 }],
			['phone', { width: 390, height: 844 }],
		]) {
			const { page, context } = await open(path, { scheme, viewport, cookie: name === 'account' })

			await page.screenshot({ path: join(out, `${name}.${scheme}.${label}.png`), fullPage: true })
			await context.close()
		}
	}
}

await browser.close()

// Telegram-виджет грузится только на своей странице; его источники на других закрыты, и это ожидаемо.
const real = violations.filter((v) => !v.startsWith('/login/telegram'))

console.log(real.length ? `CSP/JS problems:\n${real.join('\n')}` : 'no CSP or JS errors outside the telegram page')
console.log(violations.filter((v) => v.startsWith('/login/telegram')).join('\n'))
