import { kt, localizePath, requestLocale } from '#kit/i18n'

import type { TokenClaims } from './oauth/tokens.ts'
import type { Sessions } from './session.ts'

/**
 * Ошибка API кабинета и прочих JSON-маршрутов коннектора. Один формат на всех: острова
 * читают `error.message` и показывают его человеку, а по `error.code` решают, что делать.
 */
export type ApiError = { error: { code: string; message: string } }

export function apiError(status: number, code: string, message: string): Response {
	return sendJson({ error: { code, message } } satisfies ApiError, status)
}

/** Ответ JSON без кэша: состояние кабинета у каждого своё и меняется на глазах. */
export function sendJson(body: unknown, status = 200, headers?: HeadersInit): Response {
	const response = Response.json(body, { status, headers })

	response.headers.set('cache-control', 'no-store')

	return response
}

export type ErrorPageOptions = { code?: string; title: string; message?: string }

/** Адрес статической страницы `/error` с текстом в query: туда сервер редиректит человека. */
export function errorPage({ code = 'error', title, message }: ErrorPageOptions, locale = 'ru'): string {
	const query = new URLSearchParams({ code, title })

	if (message) query.set('message', message)

	return `${localizePath('/error', locale)}?${query}`
}

/**
 * Сессия кабинета или готовый ответ 401: `AccountShell` на него показывает экран входа.
 *
 * ```ts
 * const session = await requireSession(sessions, request)
 * if (session instanceof Response) return session
 * ```
 */
export async function requireSession(sessions: Sessions, request: Request): Promise<TokenClaims | Response> {
	return (
		(await sessions.read(request)) ??
		apiError(401, 'unauthorized', kt(requestLocale(request), 'server.unauthorized'))
	)
}
