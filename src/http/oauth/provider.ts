import { randomUUID } from 'node:crypto'

import { isAllowedRedirectUri } from '#kit/http/config'
import type { AuthInfo } from '#kit/mcp'

import {
	InvalidClientMetadataError,
	InvalidGrantError,
	InvalidTokenError,
	type OAuthClient,
	type OAuthTokens,
} from './errors.ts'
import type { AuthStore } from './store.ts'
import { ownClaims, REFRESH_FAMILY_TTL, RESERVED_CLAIMS, type Tokens } from './tokens.ts'

/** Кто вошёл. `claims` попадут в токены и затем в `authInfo.extra` инструментов. */
export type Grant = {
	subject: string
	claims?: Record<string, unknown>
}

/**
 * С чем человек вернулся на колбэк входа. Тело формы кит уже прочитал: `Request`
 * отдаёт его один раз.
 */
export type LoginInput = {
	request: Request
	method: string
	query: Record<string, string>
	form: Record<string, string>
}

export type AuthorizationParams = {
	redirectUri: string
	codeChallenge: string
	state?: string
	scopes?: string[]
}

/** Ошибка входа, которую стоит показать человеку на той же странице. */
export class LoginError extends Error {}

/**
 * Способ входа, который подключает сервис. Протокол, PKCE, коды и токены остаются на ките,
 * вход только рисует страницу и по возвращению говорит, кто это.
 */
export type Login = {
	/**
	 * Статическая страница входа из `@aimuzov/infra-mcp-kit/astro`, например `/login`. Кит
	 * редиректит на неё, а запрос, клиент и ошибку кладёт во фрагмент адреса: фрагмент
	 * не уходит на сервер и в логи прокси.
	 */
	page: string
	/** Что ещё положить во фрагмент страницы входа, например id для dev-входа на localhost. */
	context?: Record<string, string>
	/** Проверить то, с чем человек вернулся. `LoginError` покажет страницу входа снова. */
	complete(input: LoginInput): Grant | Promise<Grant>
	/**
	 * В claims едет чужой секрет, например API-токен. Тогда токены обязаны быть
	 * зашифрованными, и `createHttpApp` не стартует с `sign`.
	 */
	sealsSecrets?: boolean
}

export type ProviderOptions = {
	publicUrl: URL
	tokens: Tokens
	store: AuthStore
	login: Login
	allowedRedirectUris?: string[]
}

export const CALLBACK_PATH = '/authorize/callback'

/**
 * Регистрация открыта всем, а клиенты хранятся вечно: без потолка один адрес
 * за час набил бы базу мегабайтами имён и колбэков.
 */
const MAX_CLIENT_BYTES = 8 * 1024
const MAX_REDIRECT_URIS = 10

/**
 * OAuth-сервер на SDK: метаданные, регистрацию, PKCE и редиректы с ошибками ведёт роутер SDK,
 * а этот класс решает, кто пользователь и что значит токен.
 */
export class KitOAuthProvider {
	private readonly options: ProviderOptions

	constructor(options: ProviderOptions) {
		this.options = options
	}

	get clientsStore(): {
		getClient(id: string): OAuthClient | undefined
		registerClient(client: OAuthClient): OAuthClient
	} {
		const { store, allowedRedirectUris } = this.options

		return {
			getClient: (id) => store.getClient(id),
			registerClient: (client) => {
				if (client.redirect_uris.length > MAX_REDIRECT_URIS) {
					throw new InvalidClientMetadataError(`More than ${MAX_REDIRECT_URIS} redirect_uris`)
				}

				if (Buffer.byteLength(JSON.stringify(client)) > MAX_CLIENT_BYTES) {
					throw new InvalidClientMetadataError(`Client metadata is over ${MAX_CLIENT_BYTES} bytes`)
				}

				const bad = client.redirect_uris.find((uri) => !isAllowedRedirectUri(uri, allowedRedirectUris))

				if (bad) throw new InvalidClientMetadataError(`redirect_uri is not allowed: ${bad}`)

				// client_id, секрет и время регистрации проставил роутер кита.
				const full = client as OAuthClient

				store.saveClient(full)

				return full
			},
		}
	}

	/** Страница входа. Запрос подписывается и возвращается на колбэк, где выдаётся код. */
	async authorize(client: OAuthClient, params: AuthorizationParams): Promise<string> {
		const request = await this.options.tokens.sign('authorize', {
			sub: client.client_id,
			redirect_uri: params.redirectUri,
			code_challenge: params.codeChallenge,
			state: params.state ?? '',
		})

		return this.loginPage(request, client, params.redirectUri)
	}

	/** Адрес статической страницы входа с контекстом во фрагменте. */
	loginPage(request: string, client: OAuthClient, redirectUri: string, error?: string): string {
		const { page, context } = this.options.login
		const hash = new URLSearchParams({
			...context,
			request,
			callback: CALLBACK_PATH,
			client: client.client_name ?? '',
			host: new URL(redirectUri).host,
		})

		if (error) hash.set('error', error)

		return `${page}#${hash}`
	}

	/** Выдать код по завершённому входу. Отдаёт адрес, куда редиректить. */
	async issueCode(clientId: string, redirectUri: string, codeChallenge: string, state: string, grant: Grant) {
		const reserved = Object.keys(grant.claims ?? {}).filter((k) => RESERVED_CLAIMS.has(k))

		// Молча перетереть `subject` или `exp` хуже, чем упасть:
		// в инструмент приехал бы не тот пользователь.
		if (reserved.length) throw new Error(`Вход вернул claims, которые кит ставит сам: ${reserved.join(', ')}`)

		const sealed = await this.options.tokens.sign('grant', {
			...grant.claims,
			sub: grant.subject,
			auth_time: Math.floor(Date.now() / 1000),
		})
		const code = this.options.store.issueCode({ clientId, codeChallenge, redirectUri, grant: sealed })
		const target = new URL(redirectUri)

		target.searchParams.set('code', code)

		if (state) target.searchParams.set('state', state)

		return target
	}

	async challengeForAuthorizationCode(client: OAuthClient, code: string): Promise<string> {
		const pending = this.options.store.peekCode(code)

		if (!pending || pending.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code')

		return pending.codeChallenge
	}

	async exchangeAuthorizationCode(
		client: OAuthClient,
		code: string,
		_verifier?: string,
		redirectUri?: string,
	): Promise<OAuthTokens> {
		const pending = this.options.store.takeCode(code)

		if (!pending || pending.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code')

		// RFC 6749 4.1.3: redirect_uri был в запросе авторизации, значит обязателен и здесь.
		if (redirectUri !== pending.redirectUri) throw new InvalidGrantError('redirect_uri does not match')

		const grant = await this.options.tokens.verify('grant', pending.grant)

		if (!grant) throw new InvalidGrantError('Invalid authorization code')

		const authTime = typeof grant.auth_time === 'number' ? grant.auth_time : Math.floor(Date.now() / 1000)

		return this.issue(client.client_id, grant.sub, ownClaims(grant), randomUUID(), authTime)
	}

	/**
	 * Каждый refresh-токен годится один раз и меняется на новый той же цепочки.
	 * Повтор потраченного значит, что токен утёк: отзываем всю цепочку, и войти
	 * придётся заново и вору, и хозяину (RFC 9700, 4.14.2).
	 */
	async exchangeRefreshToken(client: OAuthClient, refreshToken: string): Promise<OAuthTokens> {
		const { tokens, store } = this.options
		const claims = await tokens.verify('refresh', refreshToken)

		if (!claims || claims.client_id !== client.client_id) {
			throw new InvalidGrantError('Invalid refresh token')
		}

		this.assertNotRevoked(claims)

		const family = typeof claims.fam === 'string' ? claims.fam : undefined
		const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : undefined

		// Токены кита 1.0 без `jti`: принимаем один раз и переводим в цепочку,
		// чтобы обновление кита не разлогинило всех разом.
		if (typeof claims.jti === 'string') {
			if (!store.takeRefresh(claims.jti)) {
				if (family) store.revokeFamily(family)

				throw new InvalidGrantError('Refresh token already used')
			}
		}

		const now = Math.floor(Date.now() / 1000)

		if (authTime !== undefined && now - authTime > REFRESH_FAMILY_TTL) {
			throw new InvalidGrantError('Login is too old, connect again')
		}

		return this.issue(client.client_id, claims.sub, ownClaims(claims), family ?? randomUUID(), authTime ?? now)
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const claims = await this.options.tokens.verify('access', token)

		if (!claims) throw new InvalidTokenError('Invalid access token')

		try {
			this.assertNotRevoked(claims)
		} catch {
			throw new InvalidTokenError('Access revoked')
		}

		return {
			token,
			clientId: String(claims.client_id),
			scopes: [],
			expiresAt: claims.exp,
			extra: { ...ownClaims(claims), subject: claims.sub },
		}
	}

	/** RFC 7009: отзыв refresh-токена убивает его цепочку. Токен доступа доживает свой час. */
	async revokeToken(client: OAuthClient, request: { token: string }): Promise<void> {
		const claims = await this.options.tokens.verify('refresh', request.token)

		// Неизвестный или чужой токен -- тоже успех: так велит RFC, и это ничего не выдаёт.
		if (!claims || claims.client_id !== client.client_id || typeof claims.fam !== 'string') return

		this.options.store.revokeFamily(claims.fam)
	}

	private assertNotRevoked(claims: { sub: string; iat?: unknown }) {
		const before = this.options.store.revokedBefore(claims.sub)

		if (before !== undefined && typeof claims.iat === 'number' && claims.iat * 1000 <= before) {
			throw new InvalidGrantError('Access revoked')
		}
	}

	private async issue(
		clientId: string,
		subject: string,
		claims: Record<string, unknown>,
		family: string,
		authTime: number,
	): Promise<OAuthTokens> {
		const { tokens, store } = this.options
		const jti = randomUUID()
		const payload = { ...claims, sub: subject, client_id: clientId }

		store.saveRefresh({ jti, family, subject, expiresAt: Date.now() + tokens.ttl.refresh * 1000 })

		return {
			access_token: await tokens.sign('access', payload),
			token_type: 'Bearer',
			expires_in: tokens.ttl.access,
			refresh_token: await tokens.sign('refresh', { ...payload, jti, fam: family, auth_time: authTime }),
		}
	}
}
