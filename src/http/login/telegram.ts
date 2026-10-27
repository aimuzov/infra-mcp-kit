import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { required, str, type Env } from '#kit/env'
import { devOnly } from '#kit/http/config'
import { LoginError, type Login } from '#kit/http/oauth/provider'
import { allLocales } from '#kit/i18n'

/** Поля, которые Telegram Login Widget дописывает к auth URL. */
export type TelegramUser = {
	id: string
	firstName: string
	username: string
}

/**
 * Бот входа из окружения рантайма. Страницы собираются без него, поэтому имя бота
 * сервер отдаёт им сам: OAuth-входу через `/authorize/page`, кабинету через `/account/auth`.
 */
export type TelegramConfig = {
	/** Токен бота: им проверяется подпись виджета. Секрет. */
	botToken: string
	/** Имя бота без `@`, его кнопку рисует виджет. Не секрет. */
	botName?: string
	/**
	 * Войти этим Telegram id без виджета. Виджет работает только на домене бота,
	 * так сервер пробуют на localhost; задаётся через `devOnly`.
	 */
	devUserId?: string
}

/** Вход старше этого отклоняется: подписанный query не должен годиться для повтора. */
export const MAX_AGE_SECONDS = 10 * 60

const SIGNED_FIELDS = ['auth_date', 'first_name', 'id', 'last_name', 'photo_url', 'username']

/** Имя бота, как его знает Telegram: 5-32 символа, латиница, цифры и `_`. */
const BOT_NAME = /^[a-z0-9_]{5,32}$/i

/**
 * `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME` и id для dev-входа из `devVar`. С dev-входом
 * бот не нужен: на localhost виджет всё равно не работает, а сам dev-вход только там и разрешён.
 */
export function loadTelegramConfig(
	env: Env,
	publicUrl: URL,
	devVar = 'TELEGRAM_DEV_USER_ID',
): Required<TelegramConfig> {
	const devUserId = devOnly(env, devVar, publicUrl)

	if (devUserId && !/^\d+$/.test(devUserId)) throw new Error(`${devVar}: нужен числовой Telegram id`)

	const botName = (devUserId ? str(env, 'TELEGRAM_BOT_NAME') : required(env, 'TELEGRAM_BOT_NAME')).replace(/^@/, '')

	if (botName && !BOT_NAME.test(botName)) throw new Error(`TELEGRAM_BOT_NAME: не имя бота: "${botName}"`)

	return {
		botToken: devUserId ? str(env, 'TELEGRAM_BOT_TOKEN') : required(env, 'TELEGRAM_BOT_TOKEN'),
		botName,
		devUserId,
	}
}

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
	// С пустым токеном подпись посчитает кто угодно: такой сервер ничего не проверяет.
	if (!botToken) return null

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

export type TelegramLoginOptions = TelegramConfig & {
	/** Дополнительные claims по пользователю, например имя для кабинета. */
	claims?: (user: TelegramUser) => Record<string, unknown>
	/** Статическая страница виджета, по умолчанию `/login/telegram` из `mcpPages`. */
	page?: string
}

/** Кто это по запросу: подпись виджета или, на localhost, dev-ссылка. */
export function telegramUser(
	query: Record<string, string>,
	{ botToken, devUserId }: Pick<TelegramConfig, 'botToken' | 'devUserId'>,
): TelegramUser | null {
	if (devUserId && query.dev === '1') return { id: devUserId, firstName: 'dev', username: '' }

	return verifyTelegramLogin(query, botToken)
}

/** Потраченные подписи виджета и когда их можно забыть. */
const spent = new Map<string, number>()

/**
 * Потратить подпись виджета: `false`, если её уже тратили. Подписанный query из истории
 * браузера иначе годился бы на чужой вход до `MAX_AGE_SECONDS`.
 *
 * Журнал один на процесс, а не на вход: виджет подписывает только человека и время, так что
 * подпись из OAuth-входа годится и в кабинет, и наоборот. Подписи разных ботов не совпадают.
 * Память процесса: после рестарта окно повтора то же, что и без этой проверки.
 */
export function spendSignature(hash: string, now = Date.now()): boolean {
	for (const [key, expiresAt] of spent) if (expiresAt < now) spent.delete(key)

	if (spent.has(hash)) return false

	spent.set(hash, now + MAX_AGE_SECONDS * 1000)

	return true
}

/** Вход через Telegram Login Widget: виджет возвращает человека GET-ссылкой с подписанным query. */
export function telegramLogin(options: TelegramLoginOptions): Login {
	return {
		page: options.page ?? '/login/telegram',
		// Страница входа покажет dev-ссылку вместо виджета: на localhost виджет не работает.
		context: options.devUserId ? { dev: options.devUserId } : undefined,
		// Страница собрана без окружения рантайма, а бота из фрагмента подставил бы кто угодно.
		pageData: options.botName ? { bot: options.botName } : undefined,
		complete({ query }) {
			const user = telegramUser(query, options)

			if (!user) throw new LoginError(allLocales('login.telegramFailed'))

			const hash = query.hash ?? ''

			if (hash && !spendSignature(hash)) throw new LoginError(allLocales('login.linkUsed'))

			return { subject: user.id, claims: options.claims?.(user) }
		},
	}
}
