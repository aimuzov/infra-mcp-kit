import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler } from 'express'

import { log as defaultLog, type Logger } from '#kit/log'
import { messageOf } from '#kit/results'

import type { HttpConfig } from './config.ts'
import { apiError, errorPage } from './json.ts'
import { mountOAuth, type KitOAuthProvider, type Login } from './oauth/index.ts'
import type { AuthStore } from './oauth/store.ts'
import { Tokens } from './oauth/tokens.ts'

/** Кто отвечает: имя попадает в метаданные OAuth и в строку запуска. */
export type Service = {
	/** Короткое имя, например `thinks`. */
	name: string
}

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
	/**
	 * Без него `/mcp` открыт всем: только для серверов без чужих данных. Входу нужна
	 * статическая страница, поэтому с `auth` нужен и `publicDir`.
	 */
	auth?: HttpAuthOptions
	/** Свои маршруты, например кабинет. Ставятся после OAuth и `/mcp`, до 404. */
	routes?(app: Express, context: HttpContext): void
	/** Куда писать ошибки `/mcp` и входа. По умолчанию общий `log` кита. */
	logger?: Logger
	/**
	 * Каталог со страницами, которые собрал Astro через `@aimuzov/infra-mcp-kit/astro`, обычно
	 * `build/public`. Кит раздаёт файлы как есть: лендинг, вход, ошибка и 404 берутся оттуда.
	 */
	publicDir?: string
}

/**
 * Страницы Astro в формате `file`: `/login` -> `login.html`. `express.static` с `extensions`
 * так не умеет, когда рядом лежит каталог `login/` от `/login/telegram`: он видит каталог
 * и уходит в редирект на `/login/` или в 404.
 */
function pages(root: string): RequestHandler {
	return (req, res, next) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') return void next()

		const name = req.path === '/' ? 'index' : req.path.slice(1).replace(/\/$/, '')

		// Только простые имена страниц: ни точек, ни обратных слешей, ни выхода из каталога.
		if (!/^[a-z0-9/-]+$/i.test(name) || name.includes('..')) return void next()

		if (!existsSync(join(root, `${name}.html`))) return void next()

		// С `root` send ищет точки только в пути внутри него, иначе каталог сервера
		// вроде `.claude/...` отдал бы 404.
		res.sendFile(`${name}.html`, { root })
	}
}

/**
 * У статики Astro своя CSP в `<meta>`, с хешами своих скриптов; заголовок с другой политикой
 * их пересёк бы. `frame-ancestors` в `<meta>` не работает, поэтому он один идёт заголовком.
 * Без страниц коннектор отдаёт только JSON, и ему хватает `default-src 'none'`.
 */
const securityHeaders =
	(pages: boolean): RequestHandler =>
	(_req, res, next) => {
		res.set({
			'Content-Security-Policy': pages ? "frame-ancestors 'none'" : "default-src 'none'; frame-ancestors 'none'",
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'strict-origin-when-cross-origin',
		})

		next()
	}

/**
 * Удалённый коннектор на express: `/mcp` по Streamable HTTP, OAuth, `/health` и страницы,
 * собранные Astro.
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

	if (auth && !options.publicDir) {
		throw new Error('Вход показывает статическую страницу: с `auth` нужен `publicDir` со сборкой mcpPages')
	}

	if (auth?.login.sealsSecrets && tokens.mode !== 'encrypt') {
		throw new Error('Вход кладёт в токены чужой секрет: нужен `tokens: "encrypt"`, иначе он поедет открытым')
	}

	// Перед нами Caddy с TLS; лимитам запросов в SDK нужен адрес клиента, а не прокси.
	app.set('trust proxy', 1)
	app.disable('x-powered-by')
	app.use(securityHeaders(Boolean(options.publicDir)))

	app.get('/health', (_req, res) => void res.json({ ok: true }))

	let bearer: RequestHandler | undefined

	if (auth) {
		const mounted = mountOAuth(app, {
			resourceName: service.name,
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

	if (options.publicDir) {
		app.use(pages(options.publicDir))
		app.use(express.static(options.publicDir, { index: false, redirect: false }))
	}

	options.routes?.(app, context)

	app.use((req, res) => {
		if (options.publicDir && wantsPage(req)) {
			return void res.status(404).sendFile('404.html', { root: options.publicDir })
		}

		apiError(res, 404, 'not_found', 'Not found')
	})

	// Без своего обработчика ошибку маршрута сервиса express отдал бы своей HTML-страницей,
	// вне production -- со стеком, и мимо лога.
	const onError: ErrorRequestHandler = (error, req, res, next) => {
		logger.error('request failed', { path: req.path, message: messageOf(error) })

		if (res.headersSent) return void next(error)

		if (req.path === '/mcp') return void res.status(500).json(INTERNAL_ERROR)

		// Человека со страницы ведём на страницу ошибки, остров или скрипт получает JSON.
		if (options.publicDir && wantsPage(req)) {
			return void res.redirect(
				303,
				errorPage({ code: '500', title: 'Что-то сломалось', message: 'Попробуй ещё раз чуть позже.' }),
			)
		}

		apiError(res, 500, 'internal', 'Internal error')
	}

	app.use(onError)

	return { app, context }
}

/** Браузер за страницей, а не `fetch` острова: он просит HTML. */
const wantsPage = (req: Request) => req.method === 'GET' && req.accepts(['html', 'json']) === 'html'

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
