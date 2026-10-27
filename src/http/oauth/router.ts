import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import { errorPage } from '#kit/http/json'
import { kt, requestLocale, type Locale } from '#kit/i18n'
import { log, type Logger } from '#kit/log'
import type { AuthInfo } from '#kit/mcp'
import { messageOf } from '#kit/results'
import { captureError, withoutMessage } from '#kit/sentry'

import {
	InvalidClientError,
	InvalidClientMetadataError,
	InvalidGrantError,
	InvalidRequestError,
	InvalidTokenError,
	OAuthError,
	TooManyRequestsError,
	UnsupportedGrantTypeError,
	type OAuthClient,
} from './errors.ts'
import { CALLBACK_PATH, KitOAuthProvider, LoginError, PAGE_DATA_PATH, type ProviderOptions } from './provider.ts'

export type OAuthOptions = ProviderOptions & {
	mcpUrl: URL
	/** Имя сервиса в метаданных защищённого ресурса. */
	resourceName: string
	logger?: Logger
}

export type OAuthRouter = {
	provider: KitOAuthProvider
	/** Ответить на запрос OAuth или `undefined`, если путь не его. */
	handle(request: Request): Promise<Response | undefined>
	/** Проверить Bearer-токен `/mcp`. Без токена или с плохим -- готовый ответ 401. */
	authenticate(request: Request): Promise<AuthInfo | Response>
	/** Адрес метаданных защищённого ресурса, его же клиент видит в `WWW-Authenticate`. */
	resourceMetadataUrl: URL
}

const FORM_LIMIT = 16 * 1024
const JSON_LIMIT = 16 * 1024

/** Регистрация открыта всем, а клиенты хранятся вечно: потолок на адрес держит базу в разумных размерах. */
const REGISTRATIONS_PER_HOUR = 20

/**
 * OAuth-сервер коннектора: метаданные (RFC 8414 и 9728), регистрация (RFC 7591),
 * authorize с PKCE S256, token, revoke (RFC 7009) и колбэк входа. Кто пользователь и что
 * значит токен, решает `KitOAuthProvider`; здесь только протокол.
 */
export function oauthRouter(options: OAuthOptions): OAuthRouter {
	const provider = new KitOAuthProvider(options)
	const { resourceName, tokens, store, login, publicUrl, mcpUrl, logger = log } = options
	const issuer = publicUrl.href
	const endpoint = (path: string) => new URL(path, publicUrl).href
	const resourceMetadataUrl = new URL(`/.well-known/oauth-protected-resource${mcpUrl.pathname}`, publicUrl)
	const registrations = new Map<string, number[]>()

	const authorizationServer = {
		issuer,
		authorization_endpoint: endpoint('/authorize'),
		token_endpoint: endpoint('/token'),
		registration_endpoint: endpoint('/register'),
		revocation_endpoint: endpoint('/revoke'),
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
		revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
	}
	const protectedResource = {
		resource: mcpUrl.href,
		authorization_servers: [issuer],
		resource_name: resourceName,
	}

	function limitRegistrations(request: Request) {
		const ip = clientIp(request)
		const now = Date.now()
		const recent = (registrations.get(ip) ?? []).filter((at) => now - at < 3_600_000)

		if (recent.length >= REGISTRATIONS_PER_HOUR) throw new TooManyRequestsError('Too many registrations, try later')

		recent.push(now)
		registrations.set(ip, recent)

		if (registrations.size > 10_000) registrations.clear()
	}

	async function register(request: Request) {
		if (request.method !== 'POST') return methodNotAllowed('POST')

		limitRegistrations(request)

		const metadata = await readJson(request, JSON_LIMIT)

		if (!isRecord(metadata)) throw new InvalidClientMetadataError('Body must be a JSON object')

		const uris = metadata.redirect_uris

		if (
			!Array.isArray(uris) ||
			!uris.length ||
			!uris.every((uri) => typeof uri === 'string' && URL.canParse(uri))
		) {
			throw new InvalidClientMetadataError('redirect_uris must be a non-empty array of URLs')
		}

		const method = metadata.token_endpoint_auth_method ?? 'client_secret_basic'

		if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method as string)) {
			throw new InvalidClientMetadataError(`Unsupported token_endpoint_auth_method: ${method}`)
		}

		const isPublic = method === 'none'
		const client = provider.clientsStore.registerClient({
			...metadata,
			redirect_uris: uris as string[],
			token_endpoint_auth_method: method as string,
			client_id: randomUUID(),
			client_id_issued_at: Math.floor(Date.now() / 1000),
			// Публичному клиенту секрет не положен: Claude регистрируется
			// с `none` и на /token его не пришлёт.
			...(isPublic ? {} : { client_secret: randomBytes(32).toString('hex'), client_secret_expires_at: 0 }),
		})

		return json(client, 201)
	}

	async function authorize(request: Request) {
		if (request.method !== 'GET' && request.method !== 'POST') return methodNotAllowed('GET, POST')

		const params = { ...query(request), ...(request.method === 'POST' ? await readForm(request) : {}) }
		const client = params.client_id ? store.getClient(params.client_id) : undefined

		if (!client) throw new InvalidClientError('Unknown client_id')

		const redirectUri = params.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '')

		if (!redirectUri) throw new InvalidRequestError('redirect_uri is required when the client has several')

		if (!client.redirect_uris.some((uri) => redirectUriMatches(redirectUri, uri))) {
			throw new InvalidRequestError('Unregistered redirect_uri')
		}

		// redirect_uri проверен: остальные ошибки уходят клиенту
		// в его же колбэк (RFC 6749, 4.1.2.1).
		const back = (code: string, description: string) => {
			const target = new URL(redirectUri)

			target.searchParams.set('error', code)
			target.searchParams.set('error_description', description)

			if (params.state) target.searchParams.set('state', params.state)

			return redirect(target.href)
		}

		if (params.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code')

		if (!params.code_challenge) return back('invalid_request', 'code_challenge is required')

		if (params.code_challenge_method !== 'S256')
			return back('invalid_request', 'code_challenge_method must be S256')

		const location = await provider.authorize(client, {
			redirectUri,
			codeChallenge: params.code_challenge,
			state: params.state,
			scopes: params.scope ? params.scope.split(' ') : [],
		})

		return redirect(location)
	}

	/** Клиент по `client_id` из формы или Basic, с проверкой секрета, если он у клиента есть. */
	function authenticateClient(request: Request, form: Record<string, string>): OAuthClient {
		let id = form.client_id
		let secret = form.client_secret
		const header = request.headers.get('authorization') ?? ''

		if (!id && header.toLowerCase().startsWith('basic ')) {
			const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':', 2)

			id = decodeURIComponent(user ?? '')
			secret = pass === undefined ? undefined : decodeURIComponent(pass)
		}

		const client = id ? store.getClient(id) : undefined

		if (!client) throw new InvalidClientError('Unknown client')

		if (client.client_secret) {
			if (!secret || !safeEqual(secret, client.client_secret))
				throw new InvalidClientError('Invalid client secret')

			const expires = client.client_secret_expires_at

			if (expires && expires < Date.now() / 1000) throw new InvalidClientError('Client secret expired')
		}

		return client
	}

	async function token(request: Request) {
		if (request.method !== 'POST') return methodNotAllowed('POST')

		const form = await readForm(request)
		const client = authenticateClient(request, form)

		if (form.grant_type === 'authorization_code') {
			if (!form.code) throw new InvalidRequestError('code is required')

			if (!form.code_verifier) throw new InvalidRequestError('code_verifier is required')

			const challenge = await provider.challengeForAuthorizationCode(client, form.code)
			const expected = createHash('sha256').update(form.code_verifier).digest('base64url')

			if (!safeEqual(expected, challenge))
				throw new InvalidGrantError('code_verifier does not match the challenge')

			return json(
				await provider.exchangeAuthorizationCode(client, form.code, form.code_verifier, form.redirect_uri),
			)
		}

		if (form.grant_type === 'refresh_token') {
			if (!form.refresh_token) throw new InvalidRequestError('refresh_token is required')

			return json(await provider.exchangeRefreshToken(client, form.refresh_token))
		}

		throw new UnsupportedGrantTypeError(`Unsupported grant_type: ${form.grant_type ?? ''}`)
	}

	async function revoke(request: Request) {
		if (request.method !== 'POST') return methodNotAllowed('POST')

		const form = await readForm(request)
		const client = authenticateClient(request, form)

		if (!form.token) throw new InvalidRequestError('token is required')

		await provider.revokeToken(client, { token: form.token })

		return json({})
	}

	// Страница ошибки статическая, текст ей уходит в query: в нём нет ничего секретного.
	const fail = (locale: Locale, title: string, message?: string) =>
		redirect(errorPage({ code: 'invalid_request', title, message }, locale), 303)

	/** Колбэк входа: GET для виджетов, которые возвращают человека ссылкой, POST для форм. */
	async function callback(request: Request) {
		if (request.method !== 'GET' && request.method !== 'POST') return methodNotAllowed('GET, POST')

		const locale = requestLocale(request)

		const input = {
			request,
			method: request.method,
			query: query(request),
			form: request.method === 'POST' ? await readForm(request) : {},
		}
		const raw = input.query.request ?? input.form.request ?? ''
		const claims = raw ? await tokens.verify('authorize', raw) : null

		if (!claims) return fail(locale, kt(locale, 'oauth.expired'), kt(locale, 'oauth.restart'))

		const client = store.getClient(claims.sub)
		const redirectUri = String(claims.redirect_uri)

		if (!client || !client.redirect_uris.some((uri) => redirectUriMatches(redirectUri, uri))) {
			return fail(locale, kt(locale, 'oauth.unknownClient'), kt(locale, 'oauth.restart'))
		}

		try {
			const grant = await login.complete(input)
			const target = await provider.issueCode(
				client.client_id,
				redirectUri,
				String(claims.code_challenge),
				String(claims.state ?? ''),
				grant,
			)

			return redirect(target.href)
		} catch (error) {
			if (!(error instanceof LoginError)) {
				logger.error('login failed', { message: messageOf(error) })
				// В Sentry только тип и код: текст ошибки входа пишет апстрим, а ему достались
				// токен или подпись, которые человек принёс.
				captureError(withoutMessage(error), { 'http.path': CALLBACK_PATH })

				return fail(locale, kt(locale, 'oauth.failed'), kt(locale, 'server.later'))
			}

			// 303: после POST формы браузер идёт на страницу входа GET-ом.
			return redirect(provider.loginPage(raw, client, redirectUri, error.in(locale), locale), 303)
		}
	}

	const routes: Record<string, (request: Request) => Promise<Response>> = {
		'/.well-known/oauth-authorization-server': async () => json(authorizationServer),
		'/.well-known/oauth-protected-resource': async () => json(protectedResource),
		[resourceMetadataUrl.pathname]: async () => json(protectedResource),
		'/register': register,
		'/authorize': authorize,
		'/token': token,
		'/revoke': revoke,
		[PAGE_DATA_PATH]: async (request) =>
			request.method === 'GET' ? json(login.pageData ?? {}) : methodNotAllowed('GET'),
	}

	async function handle(request: Request): Promise<Response | undefined> {
		const { pathname } = new URL(request.url)

		if (pathname === CALLBACK_PATH) return noStore(await callback(request))

		const route = routes[pathname]

		if (!route) return undefined

		// Метаданные, регистрацию и токены читают и из браузера: клиент
		// на чужом origin, а без CORS ответ ему не достанется.
		// Cookie тут не участвуют, поэтому `*`.
		if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }))

		try {
			return cors(noStore(await route(request)))
		} catch (error) {
			if (error instanceof OAuthError) return cors(noStore(json(error.toJSON(), error.status)))

			logger.error('oauth request failed', { path: pathname, message: messageOf(error) })
			captureError(error, { 'http.path': pathname })

			return cors(json({ error: 'server_error', error_description: 'Internal error' }, 500))
		}
	}

	async function authenticate(request: Request): Promise<AuthInfo | Response> {
		const header = request.headers.get('authorization') ?? ''
		const [scheme, value] = header.split(' ', 2)
		const deny = (description: string) =>
			json({ error: 'invalid_token', error_description: description }, 401, {
				'WWW-Authenticate': challenge('invalid_token', description, resourceMetadataUrl),
			})

		if (scheme?.toLowerCase() !== 'bearer' || !value) return deny('Missing Authorization header')

		try {
			return await provider.verifyAccessToken(value)
		} catch (error) {
			if (error instanceof InvalidTokenError) return deny(error.message)

			throw error
		}
	}

	return { provider, handle, authenticate, resourceMetadataUrl }
}

/**
 * Совпадение redirect_uri с зарегистрированным: точное, а для loopback -- с любым портом
 * (RFC 8252, 7.3): нативный клиент слушает случайный порт.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
	if (requested === registered) return true

	if (!URL.canParse(requested) || !URL.canParse(registered)) return false

	const a = new URL(requested)
	const b = new URL(registered)
	const loopback = ['localhost', '127.0.0.1', '[::1]']

	if (!loopback.includes(a.hostname) || !loopback.includes(b.hostname)) return false

	return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
}

/**
 * `WWW-Authenticate` по RFC 6750. В кавычках только печатный ASCII без `"` и `\`:
 * любой другой символ Node в заголовке не пропустит и ответит 500.
 */
export function challenge(error: string, description: string, resourceMetadataUrl: URL): string {
	const quote = (value: string) => value.replace(/[^\x20-\x7e]|["\\]/g, '?')

	return `Bearer error="${quote(error)}", error_description="${quote(description)}", resource_metadata="${quote(resourceMetadataUrl.href)}"`
}

/** Адрес клиента: Caddy кладёт его в `X-Forwarded-For`, в тестах заголовка нет. */
function clientIp(request: Request) {
	return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams)

function safeEqual(a: string, b: string) {
	const left = Buffer.from(a)
	const right = Buffer.from(b)

	return left.length === right.length && timingSafeEqual(left, right)
}

/** Тело запроса строкой не длиннее `limit` байт. */
export async function readBody(request: Request, limit: number): Promise<string> {
	const declared = Number(request.headers.get('content-length'))

	if (declared > limit) throw new InvalidRequestError('Request body is too large')

	if (!request.body) return ''

	const chunks: Uint8Array[] = []
	let size = 0

	for await (const chunk of request.body) {
		size += chunk.byteLength

		if (size > limit) throw new InvalidRequestError('Request body is too large')

		chunks.push(chunk)
	}

	return Buffer.concat(chunks).toString('utf8')
}

async function readJson(request: Request, limit: number): Promise<unknown> {
	try {
		return JSON.parse(await readBody(request, limit))
	} catch (error) {
		if (error instanceof OAuthError) throw error

		throw new InvalidRequestError('Body is not valid JSON')
	}
}

/** Форма `application/x-www-form-urlencoded`. Другой тип тела -- пустая форма, а не 500. */
export async function readForm(request: Request, limit = FORM_LIMIT): Promise<Record<string, string>> {
	const type = request.headers.get('content-type') ?? ''

	if (!type.includes('application/x-www-form-urlencoded')) return {}

	return Object.fromEntries(new URLSearchParams(await readBody(request, limit)))
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return Response.json(body, { status, headers })
}

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

const methodNotAllowed = (allow: string) => new Response(null, { status: 405, headers: { allow } })

function noStore(response: Response) {
	response.headers.set('cache-control', 'no-store')

	return response
}

function cors(response: Response) {
	response.headers.set('access-control-allow-origin', '*')
	response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS')
	response.headers.set('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version')

	return response
}
