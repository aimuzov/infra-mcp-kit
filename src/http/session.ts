import { isLoopback } from './config.ts'
import { apiError } from './json.ts'
import type { TokenClaims, Tokens } from './oauth/tokens.ts'

export function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const [key, ...rest] = part.trim().split('=')

		if (key !== name) continue

		// Битую cookie может подбросить кто угодно с соседнего поддомена; это не повод для 500.
		try {
			return decodeURIComponent(rest.join('='))
		} catch {
			return undefined
		}
	}

	return undefined
}

export type Sessions = {
	read(request: Request): Promise<TokenClaims | null>
	/** Значение `Set-Cookie` с новой сессией. */
	cookie(claims: TokenClaims): Promise<string>
	/** Значение `Set-Cookie`, которое стирает сессию. */
	clearCookie(): string
}

/** Cookie кабинета: подписанный токен `session`, HttpOnly и SameSite=Lax. */
export function sessions(tokens: Tokens, publicUrl: URL, cookie = 'mcp_session'): Sessions {
	const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(isLoopback(publicUrl) ? [] : ['Secure'])].join('; ')

	return {
		async read(request) {
			const token = readCookie(request, cookie)

			return token ? tokens.verify('session', token) : null
		},
		async cookie(claims) {
			const value = encodeURIComponent(await tokens.sign('session', claims))

			return `${cookie}=${value}; Max-Age=${tokens.ttl.session}; ${attributes}`
		},
		clearCookie: () => `${cookie}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${attributes}`,
	}
}

/**
 * Формы кабинета меняют и удаляют данные, имея за спиной только cookie. SameSite=Lax уже
 * не пускает её на кросс-сайтовые POST, проверка Origin закрывает остальное.
 * Чужой origin -- готовый ответ 403, свой -- `undefined`.
 */
export function sameOrigin(publicUrl: URL, request: Request): Response | undefined {
	if (request.headers.get('origin') === publicUrl.origin) return undefined

	return apiError(403, 'forbidden_origin', 'Запрос пришёл не со страницы сервиса')
}
