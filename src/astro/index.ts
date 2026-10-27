import { readFileSync } from 'node:fs'
import type { AstroIntegration } from 'astro'

import { DEFAULT_LOCALE, type Locale, type Strings } from '#kit/i18n'

export type { Locale, Strings } from '#kit/i18n'

/** Что знают страницы кита о сервисе на сборке. */
export type PagesService = {
	/** Короткое имя в шапке и заголовках, например `thinks`. */
	name: string
	/** Репозиторий для ссылки "Исходный код" в подписи автора. */
	repo?: string
	/** Одна строка под именем на лендинге: что коннектор делает. */
	tagline?: string
	lead?: string
	/** Чипы инструментов на лендинге: строка или подпись с иконкой Lucide. */
	tools?: Array<string | PagesTool>
	/** Цвет сервиса для светлой и тёмной темы, по умолчанию фиолетовый "Сигнала". */
	accent?: { light: string; dark: string }
	/** Цвета расслоения у заголовка и главной кнопки, по умолчанию красный и голубой. */
	glitch?: { a: string; b: string }
	/**
	 * Знак сервиса, к которому подключается коннектор: путь к SVG от корня проекта.
	 * Встаёт слева от имени на лендинге и на место сервиса на экране входа.
	 */
	logo?: string
	/** Разметка знака из `logo`, её кладёт интеграция на сборке. */
	logoSvg?: string
	/**
	 * Свои строки сервиса по языкам. Свои страницы берут их через `pt(locale, key)`, а
	 * переводы полей конфига кит ищет по ключам: `service.tagline`, `service.lead`,
	 * `tool.<label>`, `tokenForm.title`, `tokenForm.lead`, `tokenForm.submit`,
	 * `field.<name>.label`, `field.<name>.placeholder`, `field.<name>.hint`, `telegram.grant.<i>`.
	 * Нет перевода -- поле показывается как в конфиге.
	 */
	strings?: Strings
}

export type PagesTool = {
	label: string
	/** Имя иконки Lucide в kebab-case, как на lucide.dev: `kanban`, `list-checks`. */
	icon?: string
}

export type TokenField = {
	name: string
	label: string
	type?: 'text' | 'password' | 'url' | 'email'
	placeholder?: string
	/** Подсказка у подписи: где взять значение. */
	hint?: string
	required?: boolean
}

export type TelegramPages = {
	/**
	 * Имя бота для `/login/telegram` на случай, если сервер его не прислал. `/account/signin`
	 * берёт бота только из `/account/auth`. Страницы обычно собирают без окружения прода,
	 * поэтому имя лучше отдать в рантайме: `telegramLogin({ botName })` и `telegramAccount`.
	 */
	botName?: string
	grants?: string[]
	/** Страница `/account/signin`: вход в кабинет через Telegram. Сервер берёт `telegramAccount`. */
	account?: boolean
}

export type McpPagesOptions = {
	service: PagesService
	/** Вход по токен-форме, страница `/login`. Сервер берёт `tokenFormLogin`. */
	tokenForm?: { title: string; lead?: string; fields: TokenField[]; submit?: string }
	/** Вход через Telegram, страница `/login/telegram`. Сервер берёт `telegramLogin`. */
	telegram?: TelegramPages
	/** Страницы кита, которые сервис рисует сам, например свой лендинг. */
	override?: Array<'index' | 'error' | '404'>
	/**
	 * Языки страниц. По умолчанию только `ru`; с `en` кит собирает английские страницы
	 * под `/en/`, ставит переключатель и `hreflang`, а сервер подбирает язык по `Accept-Language`.
	 */
	locales?: Locale[]
}

export const VIRTUAL_MODULE = 'virtual:infra-mcp-kit/pages'

// Исходники страниц лежат рядом со сборкой интеграции: build/astro/index.js -> astro/pages.
// Astro компилирует .astro и .svelte из node_modules сам, собирать их в ките не нужно.
const page = (name: string) => new URL(`../../astro/pages/${name}`, import.meta.url)

/** Цвет из конфига попадает в CSS, поэтому пускаем только то, что похоже на цвет. */
export function cssColor(value: string): string {
	if (!/^[#a-z0-9(),.%\s-]+$/i.test(value)) throw new Error(`Неподходящий цвет: ${value}`)

	return value
}

/**
 * Знак встаёт в страницу разметкой, поэтому пускаем только статичный SVG: без скриптов,
 * обработчиков, внешних ссылок и атрибутов `style`, которые CSP страниц всё равно режет.
 */
export function safeSvg(text: string): string {
	const svg = text.replace(/<\?xml[^>]*\?>/, '').trim()

	if (!/^<svg[\s>][\s\S]*<\/svg>$/i.test(svg)) throw new Error('Знак сервиса должен быть одним SVG')

	const banned = /<script|<foreignObject|<!ENTITY|\son\w+\s*=|\sstyle\s*=|javascript:|\shref\s*=\s*["'](?!#)/i

	if (banned.test(svg)) throw new Error('В знаке сервиса есть скрипт, стиль или внешняя ссылка')

	return svg
}

/** Стили из конфига: цвет сервиса и цвета глитча. Пустая строка, если сервис их не задал. */
export function serviceCss(service: PagesService): string {
	const vars = []

	if (service.accent)
		vars.push(`--signal-hue: light-dark(${cssColor(service.accent.light)}, ${cssColor(service.accent.dark)});`)

	if (service.glitch)
		vars.push(
			`--signal-glitch-a: ${cssColor(service.glitch.a)};`,
			`--signal-glitch-b: ${cssColor(service.glitch.b)};`,
		)

	return vars.length > 0 ? `:root { ${vars.join(' ')} }\n` : ''
}

/**
 * Страницы MCP-коннектора для Astro: лендинг, вход, ошибка и 404 статикой, а данные
 * под пользователя дорисовывают острова в браузере. Сервис подключает её в своём
 * `astro.config.mjs` рядом с `svelte()`.
 */
export default function mcpPages(options: McpPagesOptions): AstroIntegration {
	const skip = new Set(options.override ?? [])

	// Плохой цвет роняет сборку сразу, а не при первой загрузке стилей.
	serviceCss(options.service)

	return {
		name: '@aimuzov/infra-mcp-kit/astro',
		hooks: {
			'astro:config:setup': ({ config, injectRoute, updateConfig }) => {
				const { logo } = options.service
				const resolved: McpPagesOptions = logo
					? {
							...options,
							service: {
								...options.service,
								logoSvg: safeSvg(readFileSync(new URL(logo, config.root), 'utf8')),
							},
						}
					: options

				const routes: Array<[string, string, boolean]> = [
					['/', 'index.astro', !skip.has('index')],
					['/login', 'login.astro', Boolean(options.tokenForm)],
					['/login/telegram', 'telegram.astro', Boolean(options.telegram)],
					['/account/signin', 'account-signin.astro', Boolean(options.telegram?.account)],
					['/error', 'error.astro', !skip.has('error')],
					['/404', '404.astro', !skip.has('404')],
				]

				const locales = options.locales ?? [DEFAULT_LOCALE]

				for (const locale of locales) {
					const prefix = locale === DEFAULT_LOCALE ? '' : `/${locale}`

					for (const [pattern, file, on] of routes) {
						if (on)
							injectRoute({
								pattern: pattern === '/' ? prefix || '/' : prefix + pattern,
								entrypoint: page(file),
								prerender: true,
							})
					}
				}

				updateConfig({
					// Страницы раздаёт сервер коннектора: только статика, `/login` -> `login.html`.
					output: 'static',
					build: { format: 'file' },
					security: {
						csp: {
							algorithm: 'SHA-256',
							scriptDirective: { resources: ["'self'"] },
							// Атрибутов `style` в статике нет: компоненты site-kit ставят размеры
							// в браузере через `el.style`, а `<style>` и скрипты идут по хешам.
							styleDirective: { resources: ["'self'"] },
							directives: [
								"default-src 'self'",
								"img-src 'self' data:",
								"connect-src 'self'",
								"object-src 'none'",
								"base-uri 'self'",
							],
						},
					},
					vite: {
						plugins: [virtualOptions(resolved)],
						// Prerender-сборка лежит в каталоге сервера и ищет `cookie` оттуда, а там
						// поднят 0.7 от express из зависимостей кита, без `parseCookie` Astro.
						// Вшитый в сборку, он берётся из node_modules самого Astro.
						environments: { prerender: { resolve: { noExternal: ['cookie'] } } },
					},
				})
			},
			'astro:config:done': ({ injectTypes }) => {
				injectTypes({
					filename: 'pages.d.ts',
					content: `declare module '${VIRTUAL_MODULE}' {\n\tconst options: import('@aimuzov/infra-mcp-kit/astro').McpPagesOptions\n\texport default options\n}\n`,
				})
			},
		},
	}
}

export const ACCENT_MODULE = 'virtual:infra-mcp-kit/accent.css'

/**
 * Настройки интеграции попадают в страницы виртуальным модулем: так их не надо прокидывать
 * пропсами. Цвет сервиса -- отдельным CSS-модулем, он уходит в общий файл стилей, а не
 * в инлайн-стиль, который CSP без хеша не пустила бы.
 */
function virtualOptions(options: McpPagesOptions) {
	const resolved = `\0${VIRTUAL_MODULE}`

	return {
		name: 'infra-mcp-kit-pages',
		resolveId(id: string) {
			if (id === VIRTUAL_MODULE) return resolved

			// Без `\0`: CSS-плагин Vite такие id пропускает, а модуль должен стать стилем.
			if (id === ACCENT_MODULE) return ACCENT_MODULE

			return undefined
		},
		load(id: string) {
			if (id === resolved) return `export default ${JSON.stringify(options)}`

			if (id === ACCENT_MODULE) return serviceCss(options.service)

			return undefined
		},
	}
}
