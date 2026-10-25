import type { AstroIntegration } from 'astro'

/** Что знают страницы кита о сервисе на сборке. */
export type PagesService = {
	name: string
	repo?: string
	tagline?: string
	lead?: string
	tools?: string[]
}

export type TokenField = {
	name: string
	label: string
	type?: 'text' | 'password' | 'url'
	placeholder?: string
	required?: boolean
}

export type McpPagesOptions = {
	service: PagesService
	/** Вход по токен-форме: поля формы. Без него страницы `/login` нет. */
	tokenForm?: { title: string; lead?: string; fields: TokenField[]; submit?: string }
	/** Вход через Telegram: имя бота. Страница `/login/telegram`. */
	telegram?: { botName: string }
	/** Страницы кита, которые сервис рисует сам, например `account`. */
	override?: Array<'index' | 'login' | 'error' | '404'>
}

const VIRTUAL = 'virtual:infra-mcp-kit/pages'

// Исходники страниц лежат рядом со сборкой интеграции: build/astro/index.js -> astro/pages.
// Astro компилирует .astro и .svelte из node_modules сам, собирать их в ките не нужно.
const page = (name: string) => new URL(`../../astro/pages/${name}`, import.meta.url)

/**
 * Страницы MCP-коннектора для Astro: лендинг, вход, ошибка и 404 статикой, данные
 * под пользователя дорисовывают острова в браузере. Сервис подключает её в своём
 * `astro.config.mjs` рядом с `svelte()`.
 */
export default function mcpPages(options: McpPagesOptions): AstroIntegration {
	const skip = new Set(options.override ?? [])

	return {
		name: '@aimuzov/infra-mcp-kit/astro',
		hooks: {
			'astro:config:setup': ({ injectRoute, updateConfig }) => {
				const routes: Array<[string, string, boolean]> = [
					['/', 'index.astro', !skip.has('index')],
					['/login', 'login.astro', Boolean(options.tokenForm) && !skip.has('login')],
					['/login/telegram', 'telegram.astro', Boolean(options.telegram)],
					['/error', 'error.astro', !skip.has('error')],
					['/404', '404.astro', !skip.has('404')],
				]

				for (const [pattern, file, on] of routes) {
					if (on) injectRoute({ pattern, entrypoint: page(file), prerender: true })
				}

				updateConfig({
					// Страницы раздаёт сервер коннектора, поэтому только статика и свой каталог сборки.
					output: 'static',
					build: { format: 'file' },
					security: {
						csp: {
							algorithm: 'SHA-256',
							scriptDirective: { resources: ["'self'"] },
							directives: [
								"default-src 'self'",
								"img-src 'self' data:",
								"connect-src 'self'",
								"object-src 'none'",
								"base-uri 'self'",
							],
						},
					},
					vite: { plugins: [virtualOptions(options)] },
				})
			},
		},
	}
}

/** Настройки интеграции попадают в страницы виртуальным модулем: так их не надо прокидывать пропсами. */
function virtualOptions(options: McpPagesOptions) {
	const resolved = `\0${VIRTUAL}`

	return {
		name: 'infra-mcp-kit-pages',
		resolveId: (id: string) => (id === VIRTUAL ? resolved : undefined),
		load: (id: string) => (id === resolved ? `export default ${JSON.stringify(options)}` : undefined),
	}
}
