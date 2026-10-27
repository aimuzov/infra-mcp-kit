import { randomBytes } from 'node:crypto'

import type { Route } from '#kit/http/app'
import { isLoopback } from '#kit/http/config'
import { errorPage, sendJson } from '#kit/http/json'
import {
	MAX_AGE_SECONDS,
	spendSignature,
	telegramUser,
	type TelegramConfig,
	type TelegramUser,
} from '#kit/http/login/telegram'
import { ownClaims } from '#kit/http/oauth/tokens'
import { sessions as cookieSessions, hostCookie, readCookie, sameOrigin, type Sessions } from '#kit/http/session'
import { DEFAULT_LOCALE, kt, localizePath, requestLocale, type KitKey } from '#kit/i18n'
import { messageOf } from '#kit/results'
import { captureError, withoutMessage } from '#kit/sentry'

export type TelegramAccountOptions = TelegramConfig & {
	/**
	 * Сессии кабинета: те же, по которым свои маршруты сервиса зовут `requireSession`.
	 * По умолчанию `sessions(context.tokens, publicUrl)` с cookie `mcp_session`, на https --
	 * `__Host-mcp_session`.
	 */
	sessions?: Sessions
	/** Claims сессии по пользователю. По умолчанию `{ name }` из имени или ника; `sub` -- его Telegram id. */
	claims?: (user: TelegramUser) => Record<string, unknown>
	/** Куда вести после входа, на языке страницы входа. По умолчанию `/account`. */
	home?: string
	/** Статическая страница входа, по умолчанию `/account/signin` из `mcpPages`. */
	page?: string
}

/** Что страница входа получает от `GET /account/auth`. */
export type TelegramAccountAuth = {
	/** Имя бота для виджета, `null` -- бот не настроен. */
	botName: string | null
	/** Telegram id для dev-входа на localhost или `null`. */
	dev: string | null
	/** Метка этой страницы входа: её надо вернуть на `/account/login` в `state`. */
	state: string
}

/**
 * Cookie с меткой страницы входа: живёт, пока годится подпись виджета.
 * На https она `__Host-mcp_signin` (см. `hostCookie`), иначе соседний
 * поддомен подложил бы свою метку.
 */
export const SIGNIN_COOKIE = 'mcp_signin'

/**
 * Вход в кабинет через Telegram с cookie-сессией, маршрутами для `routes` в `createHttpApp`:
 *
 * - `GET /account/auth` -- имя бота и dev-id из окружения рантайма, страница собрана без них;
 *   заодно ставит cookie с меткой входа;
 * - `GET /account/login` -- сюда виджет возвращает человека с подписанным query: проверка
 *   подписи, свежести, повтора и метки, затем cookie сессии и редирект в кабинет;
 * - `POST /account/logout` -- только со страницы сервиса, по `Origin`.
 *
 * Метка закрывает login CSRF: без неё чужая подписанная ссылка тихо впустила бы человека
 * в чужой кабинет, и он загрузил бы туда свои данные.
 */
export function telegramAccount(options: TelegramAccountOptions): Route {
	const { botToken, botName, home = '/account', page = '/account/signin' } = options

	if (!options.devUserId && !(botToken && botName)) {
		throw new Error('telegramAccount: нужны botToken и botName, без них -- только devUserId на localhost')
	}

	const claimsOf = (user: TelegramUser) =>
		ownClaims(options.claims?.(user) ?? { name: user.firstName || user.username })
	let devWarned = false

	return async (request, context) => {
		const url = new URL(request.url)
		const route = `${request.method} ${localizePath(url.pathname, DEFAULT_LOCALE)}`
		const { publicUrl } = context.config
		const signin = hostCookie(SIGNIN_COOKIE, publicUrl)
		const signinCookie = (value: string, maxAge: number) =>
			`${signin.name}=${value}; Max-Age=${maxAge}; ${signin.attributes}`

		// Сессии и dev-вход берём по приложению каждого запроса: один маршрут могут отдать
		// и локальному приложению, и проду.
		const session = options.sessions ?? cookieSessions(context.tokens, publicUrl)

		// Dev-вход пускает без подписи, поэтому только на localhost. `loadTelegramConfig` это уже
		// проверяет, но `devUserId` можно передать и руками: на проде он только оставит строку в логе.
		const devUserId = options.devUserId && isLoopback(publicUrl) ? options.devUserId : ''

		if (options.devUserId && !devUserId && !devWarned) {
			devWarned = true

			context.logger.warn('telegramAccount: devUserId is ignored, PUBLIC_URL is not on localhost', {
				publicUrl: publicUrl.origin,
			})
		}

		if (route === 'GET /account/auth') {
			const state = randomBytes(24).toString('base64url')
			const body: TelegramAccountAuth = { botName: botName || null, dev: devUserId || null, state }

			return sendJson(body, 200, { 'set-cookie': signinCookie(state, MAX_AGE_SECONDS) })
		}

		if (route === 'GET /account/login') {
			const query = Object.fromEntries(url.searchParams)
			const locale = requestLocale(request)
			const fail = (message: KitKey) =>
				redirect(
					errorPage(
						{ code: 'login', title: kt(locale, 'account.signinFailed'), message: kt(locale, message) },
						locale,
					),
				)

			// Ссылка "Войти" без подписи, например из `AccountShell`: ведём на страницу входа.
			if (!query.hash && query.dev !== '1') return redirect(localizePath(page, locale))

			const state = readCookie(request, signin.name)

			if (!state || query.state !== state) return fail('account.signinAgain')

			const user = telegramUser(query, { botToken, devUserId })

			if (!user) return fail('account.signinAgain')

			if (query.hash && !spendSignature(query.hash)) return fail('login.linkUsed')

			let cookie: string

			try {
				cookie = await session.cookie({ ...claimsOf(user), sub: user.id })
			} catch (error) {
				// Как у OAuth-входа: claims собирает сервис, и в тексте его ошибки может быть что угодно.
				context.logger.error('account login failed', { message: messageOf(error) })
				captureError(withoutMessage(error), { 'http.path': url.pathname })

				return fail('server.later')
			}

			const response = redirect(localizePath(home, locale), cookie)

			response.headers.append('set-cookie', signinCookie('', 0))

			return response
		}

		if (route === 'POST /account/logout') {
			return (
				sameOrigin(publicUrl, request) ?? sendJson({ ok: true }, 200, { 'set-cookie': session.clearCookie() })
			)
		}

		return undefined
	}
}

function redirect(location: string, cookie?: string): Response {
	const headers = new Headers({ location, 'cache-control': 'no-store' })

	if (cookie) headers.set('set-cookie', cookie)

	return new Response(null, { status: 302, headers })
}
