import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { LoginError, type Login } from '#kit/http/oauth/provider'
import { allLocales } from '#kit/i18n'

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
	/**
	 * Войти этим Telegram id без виджета. Виджет работает только на домене бота,
	 * так сервер пробуют на localhost; задаётся через `devOnly`.
	 */
	devUserId?: string
	/** Дополнительные claims по пользователю, например имя для кабинета. */
	claims?: (user: TelegramUser) => Record<string, unknown>
	/** Статическая страница виджета, по умолчанию `/login/telegram` из `mcpPages`. */
	page?: string
}

/** Кто это по запросу: подпись виджета или, на localhost, dev-ссылка. */
export function telegramUser(
	query: Record<string, string>,
	{ botToken, devUserId }: Pick<TelegramLoginOptions, 'botToken' | 'devUserId'>,
) {
	if (devUserId && query.dev === '1') return { id: devUserId, firstName: 'dev', username: '' }

	return verifyTelegramLogin(query, botToken)
}

/** Вход через Telegram Login Widget: виджет возвращает человека GET-ссылкой с подписанным query. */
export function telegramLogin(options: TelegramLoginOptions): Login {
	// Подписанный query из истории браузера иначе годился бы на чужой вход до MAX_AGE_SECONDS.
	// Память процесса: после рестарта окно повтора то же, что и без этой проверки.
	const used = new Map<string, number>()

	const spend = (hash: string, now = Date.now()) => {
		for (const [key, expiresAt] of used) if (expiresAt < now) used.delete(key)

		if (used.has(hash)) return false

		used.set(hash, now + MAX_AGE_SECONDS * 1000)

		return true
	}

	return {
		page: options.page ?? '/login/telegram',
		// Страница входа покажет dev-ссылку вместо виджета: на localhost виджет не работает.
		context: options.devUserId ? { dev: options.devUserId } : undefined,
		complete({ query }) {
			const user = telegramUser(query, options)

			if (!user) throw new LoginError(allLocales('login.telegramFailed'))

			const hash = query.hash ?? ''

			if (hash && !spend(hash)) throw new LoginError(allLocales('login.linkUsed'))

			return { subject: user.id, claims: options.claims?.(user) }
		},
	}
}
