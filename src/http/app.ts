import type { Server } from 'node:http'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type Express, type RequestHandler } from 'express'

import { log } from '#kit/log'

import type { HttpConfig } from './config.ts'
import { mountOAuth, type KitOAuthProvider, type Login } from './oauth/index.ts'
import type { AuthStore } from './oauth/store.ts'
import { Tokens } from './oauth/tokens.ts'
import { assets, ASSETS_PATH, CSP, failPage, landingPage, type LandingOptions, type Service } from './ui/index.ts'

export type HttpAuthOptions = {
	login: Login
	store: AuthStore
	/**
	 * `encrypt`, когда в claims едет чужой секрет. По умолчанию `sign`.
	 * Свой `Tokens` нужен, если сервис подписывает им и что-то ещё, например cookie кабинета.
	 */
	tokens?: Tokens | 'sign' | 'encrypt'
}

export type HttpContext = {
	config: HttpConfig
	service: Service
	mcpUrl: URL
	tokens: Tokens
	provider?: KitOAuthProvider
}

export type HttpAppOptions = {
	config: HttpConfig
	service: Service
	/** Сервер на один запрос. `auth` есть, когда включён OAuth: в `auth.extra` claims входа и `subject`. */
	createServer(auth: AuthInfo | undefined): McpServer | Promise<McpServer>
	/** Без него `/mcp` открыт всем: только для серверов без чужих данных. */
	auth?: HttpAuthOptions
	/** Лендинг на `/`. `false` -- сервис рисует `/` сам. */
	landing?: Omit<LandingOptions, 'service' | 'mcpUrl'> | false
	/** Свои маршруты, например кабинет. Ставятся после OAuth и `/mcp`, до 404. */
	routes?(app: Express, context: HttpContext): void
}

/** Заголовки для всех ответов: CSP страниц кита и запрет встраивать их во фрейм. */
const securityHeaders: RequestHandler = (_req, res, next) => {
	res.set({
		'Content-Security-Policy': CSP,
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
	})

	next()
}

/**
 * Удалённый коннектор на express: `/mcp` по Streamable HTTP, OAuth, лендинг, `/health`
 * и ассеты страниц.
 *
 * Без состояния: на каждый запрос свой сервер и транспорт, поэтому клиент не привязан к процессу,
 * а перезапуск не рвёт сессии.
 */
export function createHttpApp(options: HttpAppOptions): { app: Express; context: HttpContext } {
	const { config, service, auth } = options
	const app = express()
	const mcpUrl = new URL('/mcp', config.publicUrl)
	const tokens =
		auth?.tokens instanceof Tokens
			? auth.tokens
			: new Tokens({ secret: config.authSecret, issuer: config.publicUrl.href, mode: auth?.tokens ?? 'sign' })
	const context: HttpContext = { config, service, mcpUrl, tokens }

	// Перед нами Caddy с TLS; лимитам запросов в SDK нужен адрес клиента, а не прокси.
	app.set('trust proxy', 1)
	app.disable('x-powered-by')
	app.use(securityHeaders)

	for (const [name, { type, body }] of Object.entries(assets(service))) {
		app.get(
			`${ASSETS_PATH}/${name}`,
			(_req, res) => void res.type(type).set('Cache-Control', 'public, max-age=3600').send(body),
		)
	}

	app.get('/health', (_req, res) => void res.json({ ok: true }))

	let bearer: RequestHandler | undefined

	if (auth) {
		const mounted = mountOAuth(app, {
			service,
			publicUrl: config.publicUrl,
			mcpUrl,
			tokens,
			store: auth.store,
			login: auth.login,
			allowedRedirectUris: config.allowedRedirectUris,
		})

		bearer = mounted.bearer
		context.provider = mounted.provider
	}

	const handlers: RequestHandler[] = [...(bearer ? [bearer] : []), express.json({ limit: '4mb' })]

	app.post('/mcp', ...handlers, async (req, res) => {
		const server = await options.createServer(req.auth)
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

		res.on('close', () => {
			void transport.close()
			void server.close()
		})

		try {
			await server.connect(transport)
			await transport.handleRequest(req, res, req.body)
		} catch (error) {
			log.error('mcp request failed', { message: error instanceof Error ? error.message : String(error) })

			if (!res.headersSent)
				res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
		}
	})

	app.all('/mcp', (_req, res) => void res.status(405).set('Allow', 'POST').end())

	if (options.landing !== false) {
		const page = landingPage({ service, mcpUrl: mcpUrl.href, tagline: '', ...options.landing })

		app.get('/', (_req, res) => void res.type('html').send(page))
	}

	options.routes?.(app, context)

	app.use((_req, res) => {
		res.status(404)
			.type('html')
			.send(failPage({ service, title: 'Такой страницы нет', code: '404' }))
	})

	return { app, context }
}

/** Поднять коннектор на `config.port`. */
export function serveHttp(options: HttpAppOptions): Promise<Server> {
	const { app } = createHttpApp(options)

	return new Promise((resolve) => {
		const server = app.listen(options.config.port, () => {
			log.info(`${options.service.name} listening on :${options.config.port} as ${options.config.publicUrl.href}`)
			resolve(server)
		})
	})
}
