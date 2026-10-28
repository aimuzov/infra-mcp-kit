import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

import {
	cookieLocale,
	DEFAULT_LOCALE,
	enabledLocales,
	enableLocales,
	kt,
	localeOfPath,
	localizePath,
	negotiateLocale,
	requestLocale,
	type Locale,
} from '#kit/i18n'
import { log as defaultLog, type Logger } from '#kit/log'
import type { AuthInfo, McpServer } from '#kit/mcp'
import { causesOf, messageOf } from '#kit/results'
import { captureError } from '#kit/sentry'

import type { HttpConfig } from './config.ts'
import { apiError, errorPage } from './json.ts'
import type { Login } from './oauth/provider.ts'
import { oauthRouter, readBody, type OAuthRouter } from './oauth/router.ts'
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
	oauth?: OAuthRouter
	logger: Logger
}

/** Свой маршрут сервиса: ответ или `undefined`, если запрос не его. */
export type Route = (request: Request, context: HttpContext) => Response | undefined | Promise<Response | undefined>

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
	/**
	 * Свои маршруты, например API кабинета. Идут после OAuth, `/mcp` и страниц, до 404.
	 * Несколько -- по порядку, отвечает первый, кто вернул `Response`: так рядом встают
	 * готовые маршруты кита, например `telegramAccount`.
	 */
	routes?: Route | Route[]
	/** Куда писать ошибки `/mcp` и входа. По умолчанию общий `log` кита. */
	logger?: Logger
	/**
	 * Каталог со страницами, которые собрал Astro через `@aimuzov/infra-mcp-kit/astro`, обычно
	 * `build/public`. Кит раздаёт файлы как есть: лендинг, вход, ошибка и 404 берутся оттуда.
	 */
	publicDir?: string
}

export type HttpApp = {
	/** Ответить на запрос. Им же удобно гонять приложение в тестах без порта. */
	handle(request: Request): Promise<Response>
	/** Обработчик для `node:http`. */
	listener: RequestListener
	context: HttpContext
}

const MCP_BODY_LIMIT = 4 * 1024 * 1024

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml',
	'.webmanifest': 'application/manifest+json',
}

const INTERNAL_ERROR = { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }

/**
 * Удалённый коннектор на `node:http`: `/mcp` по Streamable HTTP, OAuth, `/health` и страницы,
 * собранные Astro.
 *
 * Без состояния: на каждый запрос свой сервер, поэтому клиент не привязан к процессу,
 * а перезапуск не рвёт сессии.
 */
export function createHttpApp(options: HttpAppOptions): HttpApp {
	const { config, service, auth, logger = defaultLog, publicDir } = options
	const mcpUrl = new URL('/mcp', config.publicUrl)
	const tokens =
		auth?.tokens instanceof Tokens
			? auth.tokens
			: new Tokens({ secret: config.authSecret, issuer: config.publicUrl.href, mode: auth?.tokens ?? 'sign' })
	const context: HttpContext = { config, service, mcpUrl, tokens, logger }
	const ownRoutes = [options.routes ?? []].flat()

	// Английские страницы mcpPages кладёт в `en/`: нет каталога -- сервер говорит только по-русски.
	if (publicDir) enableLocales(existsSync(join(publicDir, 'en')) ? ['ru', 'en'] : ['ru'])

	if (auth && !publicDir) {
		throw new Error('Вход показывает статическую страницу: с `auth` нужен `publicDir` со сборкой mcpPages')
	}

	if (auth?.login.sealsSecrets && tokens.mode !== 'encrypt') {
		throw new Error('Вход кладёт в токены чужой секрет: нужен `tokens: "encrypt"`, иначе он поедет открытым')
	}

	if (auth) {
		context.oauth = oauthRouter({
			resourceName: service.name,
			publicUrl: config.publicUrl,
			mcpUrl,
			tokens,
			store: auth.store,
			login: auth.login,
			allowedRedirectUris: config.allowedRedirectUris,
			logger,
		})
	}

	async function mcp(request: Request): Promise<Response> {
		if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })

		let authInfo: AuthInfo | undefined

		if (context.oauth) {
			const result = await context.oauth.authenticate(request)

			if (result instanceof Response) return result

			authInfo = result
		}

		let body: unknown

		try {
			body = JSON.parse(await readBody(request, MCP_BODY_LIMIT))
		} catch {
			return Response.json(
				{ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
				{ status: 400 },
			)
		}

		// Фабрика сервиса тоже может упасть, например на кривом subject:
		// ответом будет JSON-RPC.
		const server = await options.createServer(authInfo)

		return respondMcp(server, body, request, authInfo, logger)
	}

	async function route(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url)

		if (pathname === '/health') return Response.json({ ok: true })

		const oauthResponse = await context.oauth?.handle(request)

		if (oauthResponse) return oauthResponse

		if (pathname === '/mcp') return mcp(request)

		if (publicDir && wantsPage(request)) {
			const target = await languageRedirect(publicDir, request)

			if (target)
				return new Response(null, {
					status: 302,
					headers: { location: target, vary: 'Accept-Language, Cookie' },
				})
		}

		if (publicDir) {
			const page = await servePublic(publicDir, request)

			if (page) return page
		}

		for (const own of ownRoutes) {
			const response = await own(request, context)

			if (response) return response
		}

		if (publicDir && wantsPage(request)) {
			const locale = localeOfPath(pathname)
			const missing =
				(locale !== DEFAULT_LOCALE && (await serveFile(join(publicDir, locale, '404.html')))) ||
				(await serveFile(join(publicDir, '404.html')))

			if (missing) return new Response(missing.body, { status: 404, headers: missing.headers })
		}

		return apiError(404, 'not_found', 'Not found')
	}

	async function handle(request: Request): Promise<Response> {
		let response: Response

		try {
			response = await route(request)
		} catch (error) {
			const { pathname } = new URL(request.url)

			logger.error('request failed', { path: pathname, message: messageOf(error), causes: causesOf(error) })
			captureError(error, { 'http.path': pathname })

			if (pathname === '/mcp') response = Response.json(INTERNAL_ERROR, { status: 500 })
			else if (publicDir && wantsPage(request)) {
				// Человека со страницы ведём на страницу ошибки, остров или скрипт получает JSON.
				const locale = requestLocale(request)

				response = new Response(null, {
					status: 303,
					headers: {
						location: errorPage(
							{
								code: '500',
								title: kt(locale, 'server.brokenTitle'),
								message: kt(locale, 'server.later'),
							},
							locale,
						),
					},
				})
			} else response = apiError(500, 'internal', 'Internal error')
		}

		return secure(response, Boolean(publicDir))
	}

	const listener: RequestListener = (req, res) => {
		const request = toRequest(req, res, config.publicUrl)

		void handle(request)
			.then((response) => send(res, response))
			.catch((error) => {
				logger.error('response failed', { message: messageOf(error), causes: causesOf(error) })
				captureError(error)

				if (!res.headersSent) res.writeHead(500)

				res.end()
			})
	}

	return { handle, listener, context }
}

/**
 * Один POST на `/mcp`: сообщение или пачка. Уведомления и ответы клиента -- 202 без тела.
 * На запросы -- SSE, если клиент его принимает: так до ответа дойдут прогресс и логи, иначе JSON.
 */
async function respondMcp(
	server: McpServer,
	body: unknown,
	request: Request,
	auth: AuthInfo | undefined,
	logger: Logger,
) {
	const messages = (Array.isArray(body) ? body : [body]) as Array<{ id?: unknown; method?: string }>
	const requests = messages.filter((m) => m && m.method !== undefined && m.id !== undefined)
	const receive = (message: unknown) => server.receive(message, { auth, signal: request.signal })

	if (!requests.length) {
		await Promise.all(messages.map(receive))
		await server.close()

		return new Response(null, { status: 202 })
	}

	const accepts = request.headers.get('accept') ?? ''

	if (!accepts.includes('text/event-stream')) {
		const responses = (await Promise.all(messages.map(receive))).filter(Boolean)

		await server.close()

		return Response.json(Array.isArray(body) ? responses : responses[0])
	}

	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (message: unknown) =>
				controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`))

			// Прогресс и логи tmcp отдаёт событием `send`: на stdio это строка
			// в stdout, здесь -- событие SSE.
			server.tmcp.on('send', ({ request: message }) => write(message))

			try {
				await Promise.all(
					messages.map(async (message) => {
						const response = await receive(message)

						if (response) write(response)
					}),
				)
			} catch (error) {
				logger.error('mcp request failed', { message: messageOf(error), causes: causesOf(error) })
				captureError(error, { 'http.path': '/mcp' })
				write(INTERNAL_ERROR)
			} finally {
				await server.close()
				controller.close()
			}
		},
	})

	return new Response(stream, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
	})
}

/**
 * Страницы Astro в формате `file`: `/login` -> `login.html`, остальное -- файлы как есть.
 * Только простые имена: ни точек в имени страницы, ни выхода из каталога.
 */
async function servePublic(root: string, request: Request): Promise<Response | null> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null

	const { pathname } = new URL(request.url)
	const name = pathname === '/' ? 'index' : decodeSafe(pathname.slice(1).replace(/\/$/, ''))

	if (name === null) return null

	if (/^[a-z0-9/-]+$/i.test(name) && !name.includes('..')) {
		const page = await serveFile(join(root, `${name}.html`))

		if (page) return page
	}

	const base = resolve(root)
	const file = resolve(base, `.${pathname}`)

	// Файл должен лежать внутри каталога: `..` и закодированные слеши остаются снаружи.
	if (!file.startsWith(base + sep) || name.split('/').some((part) => part.startsWith('.'))) return null

	return serveFile(file)
}

function decodeSafe(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return null
	}
}

async function serveFile(file: string): Promise<Response | null> {
	try {
		if (!(await stat(file)).isFile()) return null

		return new Response(await readFile(file), {
			headers: { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' },
		})
	} catch {
		return null
	}
}

/**
 * У статики Astro своя CSP в `<meta>`, с хешами своих скриптов; заголовок с другой политикой
 * их пересёк бы. `frame-ancestors` в `<meta>` не работает, поэтому он один идёт заголовком.
 * Без страниц коннектор отдаёт только JSON, и ему хватает `default-src 'none'`.
 */
function secure(response: Response, pages: boolean): Response {
	// Ответ fetch может прийти с неизменяемыми заголовками: собираем новый.
	const headers = new Headers(response.headers)

	headers.set(
		'content-security-policy',
		pages ? "frame-ancestors 'none'" : "default-src 'none'; frame-ancestors 'none'",
	)

	headers.set('x-content-type-options', 'nosniff')
	headers.set('referrer-policy', 'strict-origin-when-cross-origin')

	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** Браузер за страницей, а не `fetch` острова: он просит HTML. */
/**
 * Куда отправить человека за страницей на его языке, или `null`, если он уже там.
 * Явный выбор из cookie действует в обе стороны. Без него сервер только уводит
 * с русской страницы на английскую по `Accept-Language`: ссылку на `/en/…` не трогает.
 * Редирект -- только если страница на нужном языке собрана, свои маршруты сервиса не задеты.
 */
async function languageRedirect(root: string, request: Request): Promise<string | null> {
	const url = new URL(request.url)
	const current = localeOfPath(url.pathname)
	const chosen = cookieLocale(request)
	const wanted: Locale = chosen ?? negotiateLocale(request.headers.get('accept-language'))

	if (wanted === current || !enabledLocales().includes(wanted)) return null

	if (!chosen && current !== DEFAULT_LOCALE) return null

	const target = localizePath(url.pathname, wanted)

	if (!(await pageFile(root, target))) return null

	return target + url.search
}

/** Собранная страница для пути, как её отдаёт `servePublic`, или `null`. */
async function pageFile(root: string, pathname: string): Promise<string | null> {
	const name = pathname === '/' ? 'index' : pathname.slice(1).replace(/\/$/, '')

	if (!/^[a-z0-9/-]+$/i.test(name) || name.includes('..')) return null

	const file = join(root, `${name}.html`)

	try {
		return (await stat(file)).isFile() ? file : null
	} catch {
		return null
	}
}

function wantsPage(request: Request) {
	if (request.method !== 'GET') return false

	const accept = request.headers.get('accept') ?? ''

	return accept.includes('text/html') && !accept.startsWith('application/json')
}

/**
 * `node:http` -> `Request`. Отмена привязана к `close` ответа: у `IncomingMessage` он
 * приходит, как только дочитано тело, и оборвал бы каждый поток SSE сразу.
 */
function toRequest(req: IncomingMessage, res: ServerResponse, base: URL): Request {
	const headers = new Headers()

	for (const [key, value] of Object.entries(req.headers)) {
		if (Array.isArray(value)) for (const item of value) headers.append(key, item)
		else if (value !== undefined) headers.set(key, value)
	}

	const controller = new AbortController()

	res.on('close', () => {
		if (!res.writableFinished) controller.abort()
	})

	const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

	return new Request(new URL(req.url ?? '/', base), {
		method: req.method,
		headers,
		body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
		duplex: hasBody ? 'half' : undefined,
		signal: controller.signal,
	} as RequestInit)
}

async function send(res: ServerResponse, response: Response) {
	const headers: Record<string, string | string[]> = {}

	response.headers.forEach((value, key) => {
		if (key === 'set-cookie') return

		headers[key] = value
	})

	const cookies = response.headers.getSetCookie()

	if (cookies.length) headers['set-cookie'] = cookies

	res.writeHead(response.status, headers)

	if (!response.body) return void res.end()

	for await (const chunk of response.body) {
		if (res.destroyed) break

		res.write(chunk)
	}

	res.end()
}

/**
 * Слушать порт. Ошибка `listen` (порт занят, нет прав) отклоняет промис:
 * без проверки сервер написал бы "listening" и вышел.
 */
export function listen(app: HttpApp, port: number, message = `listening on :${port}`, logger = defaultLog) {
	return new Promise<Server>((resolvePromise, reject) => {
		const server = createServer(app.listener)

		server.once('error', reject)

		server.listen(port, () => {
			server.off('error', reject)
			logger.info(message)
			resolvePromise(server)
		})
	})
}

/** Поднять коннектор на `config.port`. */
export function serveHttp(options: HttpAppOptions): Promise<Server> {
	const app = createHttpApp(options)
	const { config, service } = options

	return listen(
		app,
		config.port,
		`${service.name} listening on :${config.port} as ${config.publicUrl.href}`,
		options.logger,
	)
}
