import type { NextFunction, Request, Response } from 'express'

import type { Sessions } from './session.ts'

/**
 * Ошибка API кабинета и прочих JSON-маршрутов коннектора. Один формат на всех: острова
 * читают `error.message` и показывают его человеку, а по `error.code` решают, что делать.
 */
export type ApiError = { error: { code: string; message: string } }

export function apiError(res: Response, status: number, code: string, message: string): void {
	res.status(status)
		.set('Cache-Control', 'no-store')
		.json({ error: { code, message } } satisfies ApiError)
}

/** Ответ JSON без кэша: состояние кабинета у каждого своё и меняется на глазах. */
export function sendJson(res: Response, body: unknown, status = 200): void {
	res.status(status).set('Cache-Control', 'no-store').json(body)
}

export type ErrorPageOptions = { code?: string; title: string; message?: string }

/** Адрес статической страницы `/error` с текстом в query: туда сервер редиректит человека. */
export function errorPage({ code = 'error', title, message }: ErrorPageOptions): string {
	const query = new URLSearchParams({ code, title })

	if (message) query.set('message', message)

	return `/error?${query}`
}

/**
 * Пускает дальше только с cookie кабинета, сессия -- в `res.locals.session`. Без неё
 * 401: `AccountShell` на это показывает экран входа.
 */
export function requireSession(sessions: Sessions) {
	return async (req: Request, res: Response, next: NextFunction) => {
		const session = await sessions.read(req)

		if (!session) return apiError(res, 401, 'unauthorized', 'Нужно войти')

		res.locals.session = session
		next()
	}
}
