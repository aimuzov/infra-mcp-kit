import type { Server } from 'node:http'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express'

import { log as defaultLog, type Logger } from '#kit/log'
import { messageOf } from '#kit/results'

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
	/** Куда писать ошибки `/mcp` и входа. По умолчанию общий `log` кита. */
	logger?: Logger
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
	const { config, service, auth, logger = defaultLog } = options
	const app = express()
	const mcpUrl = new URL('/mcp', config.publicUrl)
	const tokens =
		auth?.tokens instanceof Tokens
			? auth.tokens
			: new Tokens({ secret: config.authSecret, issuer: config.publicUrl.href, mode: auth?.tokens ?? 'sign' })
	const context: HttpContext = { config, service, mcpUrl, tokens }

	if (auth?.login.sealsSecrets && tokens.mode !== 'encrypt') {
		throw new Error('Вход кладёт в токены чужой секрет: нужен `tokens: "encrypt"`, иначе он поедет открытым')
	}

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
			logger,
		})

		bearer = mounted.bearer
		context.provider = mounted.provider
	}

	const handlers: RequestHandler[] = [...(bearer ? [bearer] : []), express.json({ limit: '4mb' })]

	app.post('/mcp', ...handlers, async (req, res) => {
		try {
			// Фабрика сервиса тоже может упасть, например на кривом subject: это внутри try,
			// чтобы ответом был JSON-RPC, а не HTML-страница express со стеком.
			const server = await options.createServer(req.auth)
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

			res.on('close', () => {
				void transport.close()
				void server.close()
			})

			await server.connect(transport)
			await transport.handleRequest(req, res, req.body)
		} catch (error) {
			logger.error('mcp request failed', { message: messageOf(error) })

			if (!res.headersSent) res.status(500).json(INTERNAL_ERROR)
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

	// Без своего обработчика ошибку маршрута сервиса express отдал бы своей HTML-страницей,
	// вне production -- со стеком, и мимо лога.
	const onError: ErrorRequestHandler = (error, req, res, next) => {
		logger.error('request failed', { path: req.path, message: messageOf(error) })

		if (res.headersSent) return void next(error)

		if (req.path === '/mcp') return void res.status(500).json(INTERNAL_ERROR)

		res.status(500)
			.type('html')
			.send(
				failPage({ service, title: 'Что-то сломалось', message: 'Попробуй ещё раз чуть позже.', code: '500' }),
			)
	}

	app.use(onError)

	return { app, context }
}

const INTERNAL_ERROR = { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }

/**
 * Слушать порт. Ошибка `listen` (порт занят, нет прав) отклоняет промис: express 5
 * отдаёт её в тот же колбэк, и без проверки сервер написал бы "listening" и вышел.
 */
export function listen(app: Express, port: number, message = `listening on :${port}`, logger = defaultLog) {
	return new Promise<Server>((resolve, reject) => {
		const server = app.listen(port, (error?: Error) => {
			if (error) return void reject(error)

			logger.info(message)
			resolve(server)
		})
	})
}

/** Поднять коннектор на `config.port`. */
export function serveHttp(options: HttpAppOptions): Promise<Server> {
	const { app } = createHttpApp(options)
	const { config, service } = options

	return listen(
		app,
		config.port,
		`${service.name} listening on :${config.port} as ${config.publicUrl.href}`,
		options.logger,
	)
}
