import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

import { LoginError, type Login } from '#kit/http/oauth/provider'
import { consentPage, html } from '#kit/http/ui/index'

/** Поля, которые Telegram Login Widget дописывает к auth URL. */
export type TelegramUser = {
	id: string
	firstName: string
	username: string
}

/** Вход старше этого отклоняется: подписанный query не должен годиться для повтора. */
const MAX_AGE_SECONDS = 10 * 60

const SIGNED_FIELDS = ['auth_date', 'first_name', 'id', 'last_name', 'photo_url', 'username']

/**
 * Проверить подпись виджета. Telegram подписывает свои поля HMAC-SHA256 с ключом SHA-256
 * от токена бота по строкам `key=value`, отсортированным по ключу. Наши параметры в auth URL
 * не подписаны, поэтому в строку не идут.
 * https://core.telegram.org/widgets/login#checking-authorization
 */
export function verifyTelegramLogin(
	query: Record<string, unknown>,
	botToken: string,
	now = Date.now(),
): TelegramUser | null {
	const hash = typeof query.hash === 'string' ? query.hash : ''

	if (!/^[0-9a-f]{64}$/.test(hash)) return null

	const lines = SIGNED_FIELDS.filter((key) => typeof query[key] === 'string').map((key) => `${key}=${query[key]}`)
	const secret = createHash('sha256').update(botToken).digest()
	const expected = createHmac('sha256', secret).update(lines.sort().join('\n')).digest()

	if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null

	const authDate = Number(query.auth_date)

	if (!Number.isFinite(authDate) || now / 1000 - authDate > MAX_AGE_SECONDS) return null

	const id = String(query.id ?? '')

	if (!/^\d+$/.test(id)) return null

	return { id, firstName: String(query.first_name ?? ''), username: String(query.username ?? '') }
}

/** Подписать вход так, как это делает Telegram. Только для тестов. */
export function signTelegramLogin(fields: Record<string, string>, botToken: string): Record<string, string> {
	const data = Object.keys(fields)
		.sort()
		.map((k) => `${k}=${fields[k]}`)
		.join('\n')
	const secret = createHash('sha256').update(botToken).digest()

	return { ...fields, hash: createHmac('sha256', secret).update(data).digest('hex') }
}

export type TelegramLoginOptions = {
	botToken: string
	botName: string
	/** Что получит клиент, по пункту на строку. */
	grants?: string[]
	/**
	 * Войти этим Telegram id без виджета. Виджет работает только на домене бота,
	 * так сервер пробуют на localhost; задаётся через `devOnly`.
	 */
	devUserId?: string
	/** Дополнительные claims по пользователю, например имя для кабинета. */
	claims?: (user: TelegramUser) => Record<string, unknown>
}

/** Кнопка Telegram, а в dev-режиме обычная ссылка на тот же колбэк. */
export function telegramButton(
	authUrl: URL,
	{ botName, devUserId }: Pick<TelegramLoginOptions, 'botName' | 'devUserId'>,
) {
	if (devUserId) {
		const url = new URL(authUrl)

		url.searchParams.set('dev', '1')

		return html`<a class="btn btn--tg" href="${url.href}">Войти как ${devUserId} (dev)</a>`
	}

	return html`<script
		async
		src="https://telegram.org/js/telegram-widget.js?22"
		data-telegram-login="${botName}"
		data-size="large"
		data-auth-url="${authUrl.href}"
	></script>`
}

/** Кто это по запросу: подпись виджета или, на localhost, dev-ссылка. */
export function telegramUser(
	req: Request,
	{ botToken, devUserId }: Pick<TelegramLoginOptions, 'botToken' | 'devUserId'>,
) {
	if (devUserId && req.query.dev === '1') return { id: devUserId, firstName: 'dev', username: '' }

	return verifyTelegramLogin(req.query, botToken)
}

/** Вход через Telegram Login Widget: виджет возвращает человека GET-ссылкой с подписанным query. */
export function telegramLogin(options: TelegramLoginOptions): Login {
	return {
		render: ({ service, client, callbackUrl, error }) =>
			consentPage({
				service,
				client,
				grants: options.grants,
				error,
				action: telegramButton(callbackUrl, options),
			}),
		complete(req) {
			const user = telegramUser(req, options)

			if (!user) throw new LoginError('Telegram не подтвердил вход, попробуй ещё раз')

			return { subject: user.id, claims: options.claims?.(user) }
		},
	}
}
