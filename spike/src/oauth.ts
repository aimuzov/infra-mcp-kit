import { randomUUID } from 'node:crypto'

import {
	InvalidClientMetadataError,
	InvalidGrantError,
	InvalidRequestError,
	InvalidTokenError,
	OAuth,
	OAuthError,
	ServerError,
} from '@tmcp/auth'

// Логика кита как есть: провайдер, токены и хранилища не знают про tmcp.
import { KitOAuthProvider, type Grant } from '../../src/http/oauth/provider.ts'
import type { AuthStore } from '../../src/http/oauth/store.ts'
import type { Tokens } from '../../src/http/oauth/tokens.ts'

/** Ошибки SDK несут `errorCode`, а @tmcp/auth узнаёт только свои классы, иначе отвечает 500. */
const BY_CODE: Record<string, new (message: string) => OAuthError> = {
	invalid_grant: InvalidGrantError,
	invalid_token: InvalidTokenError,
	invalid_client_metadata: InvalidClientMetadataError,
	invalid_request: InvalidRequestError,
}

function translate(error: unknown): never {
	const code = (error as { errorCode?: string })?.errorCode

	if (error instanceof OAuthError) throw error

	if (code && BY_CODE[code]) throw new BY_CODE[code]((error as Error).message)

	throw new ServerError(error instanceof Error ? error.message : String(error))
}

const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R> | R) =>
	async (...args: A): Promise<R> => {
		try {
			return await fn(...args)
		} catch (error) {
			translate(error)
		}
	}

export type SpikeOAuthOptions = {
	publicUrl: URL
	tokens: Tokens
	store: AuthStore
	allowedRedirectUris?: string[]
}

/**
 * Провайдер кита под @tmcp/auth. Все наши правила (одноразовый код, client_id,
 * семьи refresh, JWE, отзыв) живут в KitOAuthProvider, здесь только переходник.
 */
export function spikeOAuth({ publicUrl, tokens, store, allowedRedirectUris }: SpikeOAuthOptions) {
	const provider = new KitOAuthProvider({
		publicUrl,
		tokens,
		store,
		allowedRedirectUris,
		login: { page: '/login', complete: () => ({ subject: 'unused' }) },
	})
	const clients = provider.clientsStore

	const oauth = OAuth.issuer(publicUrl.href)
		.clients({
			getClient: (id) => clients.getClient(id),
			// tmcp не ставит client_id сам и вшивает client_secret всем, даже публичным клиентам:
			// Claude регистрируется с `token_endpoint_auth_method: none` и секрет на /token не пришлёт.
			registerClient: wrap(async (client) => {
				const isPublic = client.token_endpoint_auth_method === 'none'
				const full = {
					...client,
					client_id: randomUUID(),
					client_id_issued_at: Math.floor(Date.now() / 1000),
					...(isPublic ? { client_secret: undefined, client_secret_expires_at: undefined } : {}),
				}

				return clients.registerClient!(full as never) as never
			}),
		})
		.pkce(wrap((client, code) => provider.challengeForAuthorizationCode(client as never, code)))
		.handlers({
			authorize: wrap(async (req) => {
				let location = ''

				await provider.authorize(
					req.client as never,
					{ redirectUri: req.redirectUri, codeChallenge: req.codeChallenge ?? '', state: req.state, scopes: [] },
					{ redirect: (_status: number, url: string) => void (location = url) } as never,
				)

				return new Response(null, { status: 302, headers: { location } })
			}),
			exchange: wrap(async (req) =>
				req.type === 'authorization_code'
					? provider.exchangeAuthorizationCode(req.client as never, req.code, req.verifier, req.redirectUri)
					: provider.exchangeRefreshToken(req.client as never, req.refreshToken),
			) as never,
			verify: wrap((token) => provider.verifyAccessToken(token)) as never,
			revoke: wrap((client, data) => provider.revokeToken(client as never, { token: data.token })),
		})
		.bearer({ paths: { POST: ['/mcp'], GET: ['/mcp'] }, resourceUrl: new URL('/.well-known/oauth-protected-resource/mcp', publicUrl).href })
		.registration(true)
		.build()

	/** Колбэк входа: в спайке пользователь приходит с `?user=` вместо Telegram или формы. */
	async function callback(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const claims = await tokens.verify('authorize', url.searchParams.get('request') ?? '')

		if (!claims) return new Response('bad request', { status: 400 })

		const grant: Grant = { subject: url.searchParams.get('user') ?? 'anonymous', claims: { plan: 'pro' } }
		const target = await provider.issueCode(
			String(claims.sub),
			String(claims.redirect_uri),
			String(claims.code_challenge),
			String(claims.state ?? ''),
			grant,
		)

		return new Response(null, { status: 302, headers: { location: target.href } })
	}

	return { oauth, callback }
}
