import { kt, requestLocale } from '#kit/i18n'

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

/**
 * Имя и атрибуты cookie входа. На https имя с префиксом `__Host-`: такую cookie
 * браузер примет только от самого хоста, с Secure, `Path=/` и без `Domain`.
 * Без префикса сайт на соседнем поддомене поставит cookie с тем же именем
 * на общий родительский домен, сервер прочтёт её вместо своей, и человек
 * окажется в чужом кабинете. На http-localhost префикс не годится: браузер
 * не примет его без Secure.
 */
export function hostCookie(name: string, publicUrl: URL): { name: string; attributes: string } {
	const https = publicUrl.protocol === 'https:'

	return {
		name: https ? `__Host-${name}` : name,
		attributes: ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(https ? ['Secure'] : [])].join('; '),
	}
}

/** Помечает сессии под `__Host-` cookie: старое имя без префикса их не примет. */
const HOST_CLAIM = 'host_cookie'

/**
 * Cookie кабинета: подписанный токен `session`, HttpOnly и SameSite=Lax,
 * на https -- `__Host-<cookie>` (см. `hostCookie`).
 *
 * Сессии, выданные до префикса, живут под прежним `<cookie>`, и `read` берёт
 * их оттуда, пока нет `__Host-` cookie. Только их: новую сессию под старым
 * именем мог подложить соседний поддомен, поэтому у новых есть claim,
 * которого нет у старых.
 *
 * Старую подложить всё ещё можно: от своей сервер её не отличит. Окно
 * закрывается само. На https `cookie` всегда ставит claim, поэтому через
 * `ttl.session` после обновления старых сессий не остаётся, если сервис
 * не подписывает `session` в обход `sessions`.
 */
export function sessions(tokens: Tokens, publicUrl: URL, cookie = 'mcp_session'): Sessions {
	const { name, attributes } = hostCookie(cookie, publicUrl)
	const prefixed = name !== cookie

	return {
		async read(request) {
			const token = readCookie(request, name)

			if (token !== undefined || !prefixed) {
				const claims = token ? await tokens.verify('session', token) : null

				if (claims) delete claims[HOST_CLAIM]

				return claims
			}

			const legacy = readCookie(request, cookie)
			const claims = legacy ? await tokens.verify('session', legacy) : null

			return claims && !(HOST_CLAIM in claims) ? claims : null
		},
		async cookie(claims) {
			const token = await tokens.sign('session', prefixed ? { ...claims, [HOST_CLAIM]: true } : claims)

			return `${name}=${encodeURIComponent(token)}; Max-Age=${tokens.ttl.session}; ${attributes}`
		},
		// Старую cookie без префикса тем же заголовком не стереть. Поэтому на https
		// остаётся пустая `__Host-` cookie: пока она есть, старое имя не читается,
		// а живёт она дольше любой старой сессии.
		clearCookie: () =>
			prefixed
				? `${name}=; Max-Age=${tokens.ttl.session}; ${attributes}`
				: `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${attributes}`,
	}
}

/**
 * Формы кабинета меняют и удаляют данные, имея за спиной только cookie. SameSite=Lax уже
 * не пускает её на кросс-сайтовые POST, проверка Origin закрывает остальное.
 * Чужой origin -- готовый ответ 403, свой -- `undefined`.
 */
export function sameOrigin(publicUrl: URL, request: Request): Response | undefined {
	if (request.headers.get('origin') === publicUrl.origin) return undefined

	return apiError(403, 'forbidden_origin', kt(requestLocale(request), 'server.foreignOrigin'))
}
