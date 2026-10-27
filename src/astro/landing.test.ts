import assert from 'node:assert/strict'
import { test } from 'node:test'

import mcpPages, { VIRTUAL_MODULE } from './index.ts'
import { checkLanding, landingHref, type PagesCard } from './landing.ts'

const card = (over: Partial<PagesCard> = {}): PagesCard => ({ id: 'account', title: 'Кабинет', ...over })

test('лендинг: карточки по языкам и ключам проходят, без карточек тоже', () => {
	assert.doesNotThrow(() => checkLanding(undefined))
	assert.doesNotThrow(() => checkLanding({}))

	assert.doesNotThrow(() =>
		checkLanding({
			cards: [
				card({ after: 'hero', links: [{ href: '/account', label: 'Открыть', primary: true }] }),
				card({
					id: 'help_2',
					title: { en: 'Help' },
					links: [
						{ href: 'https://example.com/docs', label: { ru: 'Документация', en: 'Docs' } },
						{ href: 'mailto:help@example.com', label: 'Почта' },
						{ href: '#tools', label: 'Инструменты' },
					],
				}),
			],
		}),
	)
})

test('лендинг: плохая карточка роняет сборку', () => {
	for (const [cards, error] of [
		[[card({ id: '' })], /Неподходящее имя/],
		[[card({ id: 'a b' })], /Неподходящее имя/],
		[[card(), card()], /описана дважды/],
		[[card({ title: '' })], /нет заголовка/],
		[[card({ title: {} })], /нет заголовка/],
		[[card({ title: { ru: 'Кабинет', en: '' } })], /нет заголовка/],
		[[card({ after: 'footer' as never })], /after -- одно из hero, connect, tools/],
		[[card({ links: [{ href: '/account', label: '' }] })], /нет подписи/],
		[[card({ links: [{ href: '/account', label: { ru: 'Открыть', en: '' } }] })], /нет подписи/],
	] as const) {
		assert.throws(() => checkLanding({ cards: [...cards] }), error)
	}
})

test('лендинг: ссылка -- только путь, якорь, http(s) или почта', () => {
	for (const href of [
		'javascript:alert(1)',
		'JavaScript:alert(1)',
		'//evil.example',
		'/\\evil.example',
		'/\t/evil.example',
		'/\n/evil.example',
		'/docs\r',
		'data:text/html,x',
		'account',
		'',
	]) {
		assert.throws(() => checkLanding({ cards: [card({ links: [{ href, label: 'x' }] })] }), /только путь/, href)
	}
})

test('лендинг: путь страницы получает язык, остальное остаётся как есть', () => {
	assert.equal(landingHref('/account', 'ru'), '/account')
	assert.equal(landingHref('/account', 'en'), '/en/account')
	assert.equal(landingHref('/', 'en'), '/en/')
	assert.equal(landingHref('/en/account', 'ru'), '/account')
	assert.equal(landingHref('/account?tab=data#corpus', 'en'), '/en/account?tab=data#corpus')
	assert.equal(landingHref('/#tools', 'en'), '/en/#tools')

	for (const href of [
		'#tools',
		'https://example.com/a',
		'mailto:help@example.com',
		'/llms.txt',
		'/files/a.pdf?x=1',
	]) {
		assert.equal(landingHref(href, 'en'), href)
	}
})

test('лендинг: интеграция проверяет карточки и отдаёт их страницам', () => {
	assert.throws(() => mcpPages({ service: { name: 'x' }, landing: { cards: [card(), card()] } }), /описана дважды/)

	const landing = { cards: [card({ text: { ru: 'Сначала войди', en: 'Sign in first' } })] }
	let plugin: { resolveId(id: string): string | undefined; load(id: string): string | undefined } | undefined
	const hooks = mcpPages({ service: { name: 'x' }, landing }).hooks as Record<string, (arg: unknown) => void>

	hooks['astro:config:setup']?.({
		config: { root: new URL('.', import.meta.url) },
		injectRoute: () => undefined,
		updateConfig: (c: { vite: { plugins: NonNullable<typeof plugin>[] } }) => (plugin = c.vite.plugins[0]),
	})

	const options = JSON.parse(
		(plugin?.load(plugin.resolveId(VIRTUAL_MODULE) ?? '') ?? '').replace(/^export default /, ''),
	)

	assert.deepEqual(options.landing, landing)
})
