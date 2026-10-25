import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import express, { type Express, type RequestHandler } from 'express'

import { errorPage } from '#kit/http/json'
import { log, type Logger } from '#kit/log'
import { messageOf } from '#kit/results'

import { CALLBACK_PATH, KitOAuthProvider, LoginError, type ProviderOptions } from './provider.ts'

export type OAuthOptions = ProviderOptions & {
	mcpUrl: URL
	/** Имя сервиса в метаданных защищённого ресурса. */
	resourceName: string
	logger?: Logger
}

export type MountedOAuth = {
	provider: KitOAuthProvider
	/** Проверка Bearer-токена для `/mcp`; без токена клиент получит 401 с адресом метаданных. */
	bearer: RequestHandler
}

/**
 * Подключить OAuth к приложению: роутер SDK (`/.well-known/*`, `/register`, `/authorize`,
 * `/token`) и колбэк, на который вход возвращает человека.
 */
export function mountOAuth(app: Express, options: OAuthOptions): MountedOAuth {
	const provider = new KitOAuthProvider(options)
	const { resourceName, tokens, store, login, publicUrl, mcpUrl, logger = log } = options

	app.use(
		mcpAuthRouter({
			provider,
			issuerUrl: publicUrl,
			resourceServerUrl: mcpUrl,
			resourceName,
		}),
	)

	// Страница ошибки статическая, текст ей уходит в query: в нём нет ничего секретного.
	const fail = (res: express.Response, title: string, message?: string) =>
		res.redirect(303, errorPage({ code: 'invalid_request', title, message }))

	// GET для виджетов, которые возвращают человека ссылкой, POST для форм.
	app.all(CALLBACK_PATH, express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
		res.set('Cache-Control', 'no-store')

		if (req.method !== 'GET' && req.method !== 'POST') return void res.status(405).set('Allow', 'GET, POST').end()

		const raw = String(req.query.request ?? req.body?.request ?? '')
		const request = raw && (await tokens.verify('authorize', raw))

		if (!request) {
			return void fail(res, 'Ссылка для входа устарела', 'Начни подключение заново из клиента.')
		}

		const client = store.getClient(request.sub)
		const redirectUri = String(request.redirect_uri)

		if (!client || !client.redirect_uris.some((uri) => redirectUriMatches(redirectUri, uri))) {
			return void fail(res, 'Клиент не зарегистрирован', 'Начни подключение заново из клиента.')
		}

		try {
			const grant = await login.complete(req)
			const target = await provider.issueCode(
				client.client_id,
				redirectUri,
				String(request.code_challenge),
				String(request.state ?? ''),
				grant,
			)

			res.redirect(302, target.href)
		} catch (error) {
			if (!(error instanceof LoginError)) {
				logger.error('login failed', { message: messageOf(error) })

				return void fail(res, 'Не получилось войти', 'Попробуй ещё раз чуть позже.')
			}

			// 303: после POST формы браузер идёт на страницу входа GET-ом.
			res.redirect(303, provider.loginPage(raw, client, redirectUri, error.message))
		}
	})

	return {
		provider,
		bearer: requireBearerAuth({
			verifier: provider,
			resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
		}),
	}
}

export { CALLBACK_PATH, KitOAuthProvider, LoginError, type Grant, type Login } from './provider.ts'
export { CODE_TTL_MS, memoryStore, sqliteStore, type AuthStore, type PendingCode, type RefreshRecord } from './store.ts'
export { ownClaims, Tokens, TTL, type TokenClaims, type TokenKind, type TokensOptions } from './tokens.ts'
