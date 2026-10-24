/**
 * Все экраны UI кита в настоящем Chromium: две темы, телефон и десктоп, под тем же CSP,
 * что отдаёт сервер. Ловит ошибки консоли (CSP режет инлайн-код молча, только в консоль),
 * горизонтальную прокрутку на телефоне и переключатель темы, а снимки кладёт
 * в .github/assets/ui -- их показывают PR и README.
 *
 * `npm run test:ui`. В `npm test` не входит: нужен браузер (`npx playwright install chromium`).
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { chromium, type Browser } from 'playwright'

import {
	accountPage,
	assets,
	ASSETS_PATH,
	consentPage,
	CSP,
	failPage,
	html,
	landingPage,
	panel,
	status,
	tokenFormPage,
	type Service,
} from './index.ts'

const thinks: Service = { name: 'thinks', repo: 'https://github.com/aimuzov/thinks-mcp' }
const kaiten: Service = {
	name: 'kaiten',
	repo: 'https://github.com/aimuzov/kaiten-mcp',
	accent: { light: '#e8590c', dark: '#ff8a4c' },
}
const claude = { name: 'Claude', host: 'claude.ai' }

const screens: Record<string, { service: Service; page: string }> = {
	landing: {
		service: thinks,
		page: landingPage({
			service: thinks,
			tagline: 'Пишет, отвечает и переформулирует твоим голосом',
			lead: 'MCP-коннектор, который учится по твоей переписке в Telegram. Сам он ничего не генерирует: отдаёт модели стиль-профиль и твои настоящие сообщения под запрос.',
			mcpUrl: 'https://thinks-mcp.aimuzov.online/mcp',
			tools: ['write_as_me', 'reply_as_me', 'rephrase_as_me', 'check_as_me', 'find_my_messages'],
			aside: html`<a href="/account">Личный кабинет</a> — загрузить выгрузку, настроить, удалить данные.`,
		}),
	},
	'landing-kaiten': {
		service: kaiten,
		page: landingPage({
			service: kaiten,
			tagline: 'Доски, карточки и время в Kaiten из любого MCP-клиента',
			mcpUrl: 'https://kaiten-mcp.aimuzov.online/mcp',
			tools: ['search_cards', 'create_card', 'update_card', 'add_comment', 'log_time', 'plan_day'],
		}),
	},
	consent: {
		service: thinks,
		page: consentPage({
			service: thinks,
			client: claude,
			grants: ['Читать стиль-профиль', 'Искать по твоим сообщениям', 'Проверять тексты на похожесть'],
			action: html`<a class="btn btn--tg" href="#">Войти через Telegram</a>`,
		}),
	},
	token: {
		service: kaiten,
		page: tokenFormPage({
			service: kaiten,
			client: claude,
			title: 'Подключение к Kaiten',
			lead: 'Токен нужен только для твоих запросов. Он шифруется в токен доступа и на сервере не хранится.',
			action: '/authorize/callback',
			fields: [
				{ name: 'url', label: 'Адрес Kaiten', type: 'url', placeholder: 'https://company.kaiten.ru' },
				{ name: 'token', label: 'API-токен', type: 'password', help: 'Профиль → API-ключи → Создать' },
			],
			hidden: { request: 'signed' },
			error: 'Kaiten не узнал этот токен, проверь его и адрес',
		}),
	},
	error: {
		service: kaiten,
		page: failPage({
			service: kaiten,
			title: 'Ссылка для входа устарела',
			message: 'Код подтверждения действует пять минут и только один раз. Начни подключение заново из Claude.',
			code: 'invalid_grant',
		}),
	},
	account: {
		service: thinks,
		page: accountPage({
			service: thinks,
			greeting: 'Привет, Алексей',
			sections: [
				status({ tone: 'busy', title: 'Корпус собирается', detail: 'Страница обновится сама' }),
				panel({
					title: 'Подключение',
					body: html`<div class="url"><code>https://thinks-mcp.aimuzov.online/mcp</code></div>`,
				}),
				panel({
					title: 'Данные',
					tone: 'danger',
					body: html`<p class="muted">Корпус никому, кроме подключённых тобой клиентов, не отдаётся.</p>
						<div class="row">
							<button class="btn btn--danger" type="button">Удалить все мои данные</button
							><button class="btn btn--ghost" type="button">Выйти</button>
						</div>`,
				}),
			],
		}),
	},
}

const VIEWPORTS = {
	desktop: { width: 1280, height: 860 },
	phone: { width: 390, height: 844 },
}
const OUT = new URL('../../../.github/assets/ui/', import.meta.url)

let browser: Browser
let origin: string

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://x')
	const name = url.pathname.slice(1)

	// Настоящий сервер один на сервис, а здесь их два. Чей service.css отдать, видно по
	// странице, которая его просит.
	if (url.pathname.startsWith(`${ASSETS_PATH}/`)) {
		const from = new URL(req.headers.referer ?? '/', 'http://x').pathname.slice(1)
		const file = assets(screens[from]?.service ?? thinks)[url.pathname.slice(ASSETS_PATH.length + 1)]

		if (!file) return void res.writeHead(404).end()

		return void res.writeHead(200, { 'content-type': file.type }).end(file.body)
	}

	const screen = screens[name]

	if (!screen) return void res.writeHead(404).end()

	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP }).end(screen.page)
})

before(async () => {
	mkdirSync(OUT, { recursive: true })
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	browser = await chromium.launch()
})

after(async () => {
	await browser?.close()
	server.close()
})

for (const name of Object.keys(screens))
	test(`экран ${name}: без ошибок консоли и прокрутки вбок, снимки обеих тем`, async () => {
		for (const scheme of ['light', 'dark'] as const)
			for (const [label, viewport] of Object.entries(VIEWPORTS)) {
				const page = await browser.newPage({ viewport, colorScheme: scheme, deviceScaleFactor: 2 })
				const errors: string[] = []

				page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text())))
				page.on('pageerror', (e) => void errors.push(e.message))

				await page.goto(`${origin}/${name}`)
				await page.emulateMedia({ reducedMotion: 'reduce' })

				assert.deepEqual(errors, [], `${name} ${scheme} ${label}`)

				const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

				assert.ok(overflow <= 0, `${name} ${scheme} ${label}: прокрутка вбок на ${overflow}px`)

				await page.screenshot({ path: new URL(`${name}.${scheme}.${label}.png`, OUT).pathname, fullPage: true })
				await page.close()
			}
	})

test('переключатель темы переворачивает схему и помнит выбор', async () => {
	const page = await browser.newPage({ colorScheme: 'light' })

	await page.goto(`${origin}/landing`)
	await page.click('[data-theme-toggle]')
	assert.equal(await page.getAttribute('html', 'data-theme'), 'dark')

	await page.reload()
	assert.equal(await page.getAttribute('html', 'data-theme'), 'dark')

	// Обратно к системной схеме: выбор забывается.
	await page.click('[data-theme-toggle]')
	assert.equal(await page.getAttribute('html', 'data-theme'), null)
	await page.close()
})
