import type { AstroIntegration } from 'astro'

/** Что знают страницы кита о сервисе на сборке. */
export type PagesService = {
	/** Короткое имя в шапке и заголовках, например `thinks`. */
	name: string
	/** Репозиторий для ссылки "Исходный код" в подписи автора. */
	repo?: string
	/** Одна строка под именем на лендинге: что коннектор делает. */
	tagline?: string
	lead?: string
	tools?: string[]
	/** Цвет сервиса для светлой и тёмной темы, по умолчанию фиолетовый "Сигнала". */
	accent?: { light: string; dark: string }
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

export type McpPagesOptions = {
	service: PagesService
	/** Вход по токен-форме, страница `/login`. Сервер берёт `tokenFormLogin`. */
	tokenForm?: { title: string; lead?: string; fields: TokenField[]; submit?: string }
	/** Вход через Telegram, страница `/login/telegram`. Сервер берёт `telegramLogin`. */
	telegram?: { botName: string; grants?: string[] }
	/** Страницы кита, которые сервис рисует сам, например свой лендинг. */
	override?: Array<'index' | 'error' | '404'>
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
 * Страницы MCP-коннектора для Astro: лендинг, вход, ошибка и 404 статикой, а данные
 * под пользователя дорисовывают острова в браузере. Сервис подключает её в своём
 * `astro.config.mjs` рядом с `svelte()`.
 */
export default function mcpPages(options: McpPagesOptions): AstroIntegration {
	const skip = new Set(options.override ?? [])

	if (options.service.accent) {
		cssColor(options.service.accent.light)
		cssColor(options.service.accent.dark)
	}

	return {
		name: '@aimuzov/infra-mcp-kit/astro',
		hooks: {
			'astro:config:setup': ({ injectRoute, updateConfig }) => {
				const routes: Array<[string, string, boolean]> = [
					['/', 'index.astro', !skip.has('index')],
					['/login', 'login.astro', Boolean(options.tokenForm)],
					['/login/telegram', 'telegram.astro', Boolean(options.telegram)],
					['/error', 'error.astro', !skip.has('error')],
					['/404', '404.astro', !skip.has('404')],
				]

				for (const [pattern, file, on] of routes) {
					if (on) injectRoute({ pattern, entrypoint: page(file), prerender: true })
				}

				updateConfig({
					// Страницы раздаёт сервер коннектора: только статика, `/login` -> `login.html`.
					output: 'static',
					build: { format: 'file' },
					security: {
						csp: {
							algorithm: 'SHA-256',
							scriptDirective: { resources: ["'self'"] },
							// Компоненты site-kit (Skeleton, InfoTip) ставят размеры атрибутом `style`
							// ещё на сборке. Это `style-src-attr`: `<style>` и скрипты идут по хешам.
							styleDirective: {
								resources: ["'self'", { resource: "'unsafe-inline'", kind: 'attribute' }],
							},
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
						plugins: [virtualOptions(options)],
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
	const accent = options.service.accent

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

			if (id === ACCENT_MODULE) {
				return accent ? `:root { --signal-hue: light-dark(${accent.light}, ${accent.dark}); }\n` : ''
			}

			return undefined
		},
	}
}
