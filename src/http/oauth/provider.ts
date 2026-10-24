import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import {
	InvalidClientMetadataError,
	InvalidGrantError,
	InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Request, Response } from 'express'

import { isAllowedRedirectUri } from '#kit/http/config'
import type { Client, Service } from '#kit/http/ui/index'

import type { AuthStore } from './store.ts'
import { ownClaims, type Tokens } from './tokens.ts'

/** Кто вошёл. `claims` попадут в токены и затем в `authInfo.extra` инструментов. */
export type Grant = {
	subject: string
	claims?: Record<string, unknown>
}

/** Ошибка входа, которую стоит показать человеку на той же странице. */
export class LoginError extends Error {}

export type LoginPageContext = {
	service: Service
	client: Client
	/**
	 * Адрес, куда вход должен вернуть человека: GET-ссылка для виджетов вроде Telegram
	 * или `action` формы. В нём уже лежит подписанный запрос авторизации.
	 */
	callbackUrl: URL
	/** Тот же запрос отдельно, для скрытого поля формы. */
	request: string
	error?: string
}

/**
 * Способ входа, который подключает сервис. Протокол, PKCE, коды и токены остаются на ките,
 * вход только рисует страницу и по возвращению говорит, кто это.
 */
export type Login = {
	render(context: LoginPageContext, req: Request): string | Promise<string>
	/** Проверить то, с чем человек вернулся. `LoginError` покажет страницу входа снова. */
	complete(req: Request): Grant | Promise<Grant>
}

export type ProviderOptions = {
	service: Service
	publicUrl: URL
	tokens: Tokens
	store: AuthStore
	login: Login
	allowedRedirectUris?: string[]
}

export const CALLBACK_PATH = '/authorize/callback'

/**
 * OAuth-сервер на SDK: метаданные, регистрацию, PKCE и редиректы с ошибками ведёт роутер SDK,
 * а этот класс решает, кто пользователь и что значит токен.
 */
export class KitOAuthProvider implements OAuthServerProvider {
	private readonly options: ProviderOptions

	constructor(options: ProviderOptions) {
		this.options = options
	}

	get clientsStore(): OAuthRegisteredClientsStore {
		const { store, allowedRedirectUris } = this.options

		return {
			getClient: (id) => store.getClient(id),
			registerClient: (client) => {
				const bad = client.redirect_uris.find((uri) => !isAllowedRedirectUri(uri, allowedRedirectUris))

				if (bad) throw new InvalidClientMetadataError(`redirect_uri не разрешён: ${bad}`)

				// client_id и время регистрации проставил обработчик SDK.
				const full = client as OAuthClientInformationFull

				store.saveClient(full)

				return full
			},
		}
	}

	/** Страница входа. Запрос подписывается и возвращается на колбэк, где выдаётся код. */
	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		const request = await this.options.tokens.sign('authorize', {
			sub: client.client_id,
			redirect_uri: params.redirectUri,
			code_challenge: params.codeChallenge,
			state: params.state ?? '',
		})

		res.type('html').send(await this.renderLogin(request, client, params.redirectUri, res.req))
	}

	async renderLogin(
		request: string,
		client: OAuthClientInformationFull,
		redirectUri: string,
		req: Request,
		error?: string,
	): Promise<string> {
		const callbackUrl = new URL(CALLBACK_PATH, this.options.publicUrl)

		callbackUrl.searchParams.set('request', request)

		return this.options.login.render(
			{
				service: this.options.service,
				client: { name: client.client_name, host: new URL(redirectUri).host },
				callbackUrl,
				request,
				error,
			},
			req,
		)
	}

	/** Выдать код по завершённому входу. Отдаёт адрес, куда редиректить. */
	async issueCode(clientId: string, redirectUri: string, codeChallenge: string, state: string, grant: Grant) {
		const sealed = await this.options.tokens.sign('grant', { ...grant.claims, sub: grant.subject })
		const code = this.options.store.issueCode({ clientId, codeChallenge, redirectUri, grant: sealed })
		const target = new URL(redirectUri)

		target.searchParams.set('code', code)

		if (state) target.searchParams.set('state', state)

		return target
	}

	async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
		const pending = this.options.store.peekCode(code)

		if (!pending || pending.clientId !== client.client_id) throw new InvalidGrantError('Код недействителен')

		return pending.codeChallenge
	}

	async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		code: string,
		_verifier?: string,
		redirectUri?: string,
	): Promise<OAuthTokens> {
		const pending = this.options.store.takeCode(code)

		if (!pending || pending.clientId !== client.client_id) throw new InvalidGrantError('Код недействителен')

		if (redirectUri && redirectUri !== pending.redirectUri) throw new InvalidGrantError('redirect_uri не совпадает')

		const grant = await this.options.tokens.verify('grant', pending.grant)

		if (!grant) throw new InvalidGrantError('Код недействителен')

		return this.issue(client.client_id, grant.sub, ownClaims(grant))
	}

	async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
		const claims = await this.options.tokens.verify('refresh', refreshToken)

		if (!claims || claims.client_id !== client.client_id) {
			throw new InvalidGrantError('Refresh-токен недействителен')
		}

		return this.issue(client.client_id, claims.sub, ownClaims(claims))
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const claims = await this.options.tokens.verify('access', token)

		if (!claims) throw new InvalidTokenError('Токен недействителен')

		return {
			token,
			clientId: String(claims.client_id),
			scopes: [],
			expiresAt: claims.exp,
			extra: { ...ownClaims(claims), subject: claims.sub },
		}
	}

	private async issue(clientId: string, subject: string, claims: Record<string, unknown>): Promise<OAuthTokens> {
		const payload = { ...claims, sub: subject, client_id: clientId }
		const { tokens } = this.options

		return {
			access_token: await tokens.sign('access', payload),
			token_type: 'Bearer',
			expires_in: tokens.ttl.access,
			refresh_token: await tokens.sign('refresh', payload),
		}
	}
}
