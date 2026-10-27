import assert from 'node:assert/strict'
import { test } from 'node:test'

import mcpPages, { ACCENT_MODULE, safeSvg, serviceCss, VIRTUAL_MODULE } from './index.ts'

type Plugin = { resolveId(id: string): string | undefined; load(id: string): string | undefined }

/** Хуки интеграции с подставными функциями Astro: что она добавила в маршруты и конфиг. */
function setup(options: Parameters<typeof mcpPages>[0]) {
	const routes: string[] = []
	let plugin: Plugin | undefined
	let types = ''
	const hooks = mcpPages(options).hooks as Record<string, ((arg: unknown) => void) | undefined>
	const run = (name: string, arg: unknown) => {
		const hook = hooks[name]

		if (!hook) throw new Error(`Нет хука ${name}`)

		hook(arg)
	}

	run('astro:config:setup', {
		config: { root: new URL('../../e2e/connector/', import.meta.url) },
		injectRoute: ({ pattern }: { pattern: string }) => routes.push(pattern),
		updateConfig: (c: { vite: { plugins: Plugin[] } }) => (plugin = c.vite.plugins[0]),
	})

	run('astro:config:done', { injectTypes: ({ content }: { content: string }) => (types = content) })

	if (!plugin) throw new Error('Интеграция не добавила плагин Vite')

	const load = (id: string) => plugin?.load(plugin.resolveId(id) ?? id)

	return { routes, types, load }
}

test('интеграция: маршруты по настройкам, знак из файла и стили сервиса в виртуальных модулях', () => {
	const { routes, types, load } = setup({
		service: { name: 'x', logo: './logo.svg', glitch: { a: '#f11f24', b: '#5fe8b0' } },
		tokenForm: { title: 'Вход', fields: [] },
		override: ['404'],
	})

	assert.deepEqual(routes, ['/', '/login', '/error'])
	assert.match(types, new RegExp(`declare module '${VIRTUAL_MODULE}'`))
	assert.match(load(VIRTUAL_MODULE) ?? '', /"logoSvg":"<svg /)
	assert.match(load(ACCENT_MODULE) ?? '', /--signal-glitch-a: #f11f24/)
	assert.equal(load('other'), undefined)
})

test('интеграция: без знака и цветов страниц и стилей ровно столько, сколько задано', () => {
	const { routes, load } = setup({ service: { name: 'x' }, telegram: { botName: 'bot' } })

	assert.deepEqual(routes, ['/', '/login/telegram', '/error', '/404'])
	assert.doesNotMatch(load(VIRTUAL_MODULE) ?? '', /logoSvg/)
	assert.equal(load(ACCENT_MODULE), '')

	assert.throws(
		() => mcpPages({ service: { name: 'x', accent: { light: 'red;', dark: '#000' } } }),
		/Неподходящий цвет/,
	)
})

test('интеграция: вход в кабинет через Telegram -- своя страница на всех языках, бот со сборки не нужен', () => {
	const { routes, load } = setup({ service: { name: 'x' }, telegram: { account: true }, locales: ['ru', 'en'] })

	assert.deepEqual(routes, [
		'/',
		'/login/telegram',
		'/account/signin',
		'/error',
		'/404',
		'/en',
		'/en/login/telegram',
		'/en/account/signin',
		'/en/error',
		'/en/404',
	])

	assert.doesNotMatch(load(VIRTUAL_MODULE) ?? '', /botName/)
})

const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="12" fill="#f11f24"/></svg>'

test('знак сервиса: статичный SVG проходит, XML-заголовок отрезается', () => {
	assert.equal(safeSvg(MARK), MARK)
	assert.equal(safeSvg(`<?xml version="1.0"?>\n${MARK}\n`), MARK)
	assert.equal(safeSvg('<svg><use href="#a"/></svg>'), '<svg><use href="#a"/></svg>')
})

test('знак сервиса: скрипты, обработчики, стили и внешние ссылки не проходят', () => {
	for (const svg of [
		'<svg><script>alert(1)</script></svg>',
		'<svg onload="alert(1)"></svg>',
		'<svg><path style="fill:red"/></svg>',
		'<svg><a href="https://evil.example"><path/></a></svg>',
		'<svg><a href="javascript:alert(1)"/></svg>',
		'<svg><foreignObject><div/></foreignObject></svg>',
		'<img src=x>',
		'<svg></svg><svg></svg>junk',
	]) {
		assert.throws(() => safeSvg(svg), Error, svg)
	}
})

test('стили сервиса: цвет и глитч в :root, без настроек пусто, мусор вместо цвета -- ошибка', () => {
	assert.equal(serviceCss({ name: 'x' }), '')

	assert.equal(
		serviceCss({
			name: 'x',
			accent: { light: '#7d4ccf', dark: '#ad73fe' },
			glitch: { a: '#f11f24', b: '#5fe8b0' },
		}),
		':root { --signal-hue: light-dark(#7d4ccf, #ad73fe); --signal-glitch-a: #f11f24; --signal-glitch-b: #5fe8b0; }\n',
	)

	assert.throws(
		() => serviceCss({ name: 'x', glitch: { a: 'red;}body{display:none', b: '#000' } }),
		/Неподходящий цвет/,
	)
})
