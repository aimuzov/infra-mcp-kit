import { int, list, required, str, type Env } from '#kit/env'

import { MIN_SECRET_LENGTH } from './oauth/tokens.ts'

/** Что нужно любому удалённому коннектору поверх своих настроек. */
export type HttpConfig = {
	port: number
	/** Публичный адрес, по которому сервер видят клиенты, например https://thinks-mcp.aimuzov.online */
	publicUrl: URL
	/** Ключ, которым подписываются или шифруются токены. */
	authSecret: string
	/** Колбэки, которые разрешено регистрировать сверх колбэков Claude и loopback. */
	allowedRedirectUris: string[]
}

export { MIN_SECRET_LENGTH }

/** Колбэки Claude; loopback для Claude Code разрешён сверх них. */
export const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']

/** `PORT`, `PUBLIC_URL`, `AUTH_SECRET` и `ALLOWED_REDIRECT_URIS`. */
export function loadHttpConfig(env: Env = process.env): HttpConfig {
	const authSecret = required(env, 'AUTH_SECRET')

	if (authSecret.length < MIN_SECRET_LENGTH) {
		throw new Error(`AUTH_SECRET слишком короткий: нужно минимум ${MIN_SECRET_LENGTH} символа`)
	}

	return {
		port: int(env, 'PORT', 8080),
		publicUrl: publicUrl(required(env, 'PUBLIC_URL')),
		authSecret,
		allowedRedirectUris: list(env, 'ALLOWED_REDIRECT_URIS'),
	}
}

/**
 * Только origin: `/mcp`, колбэки и метаданные строятся от корня, и путь
 * в `PUBLIC_URL` молча потерялся бы.
 */
function publicUrl(raw: string): URL {
	if (!URL.canParse(raw)) throw new Error(`PUBLIC_URL: не адрес: "${raw}"`)

	const url = new URL(raw)

	if (url.pathname !== '/' || url.search || url.hash) {
		throw new Error(`PUBLIC_URL: нужен адрес без пути, например ${url.origin}`)
	}

	if (url.protocol !== 'https:' && !isLoopback(url)) {
		throw new Error(`PUBLIC_URL: нужен https, http только на localhost`)
	}

	return url
}

/** Режим разработки по `PUBLIC_URL` на localhost. Нужен для входов, которые работают только на своём домене. */
export const devOnly = (env: Env, name: string, publicUrl: URL): string => {
	const value = str(env, name)

	if (value && !isLoopback(publicUrl)) throw new Error(`${name} разрешён только при PUBLIC_URL на localhost`)

	return value
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export const isLoopback = (url: URL): boolean => LOOPBACK.has(url.hostname)

/**
 * Можно ли зарегистрировать такой колбэк. Без проверки кто угодно заведёт клиента,
 * который шлёт код на свой хост, подсунет жертве ссылку на вход и получит её доступ:
 * PKCE не спасёт, challenge задаёт он сам.
 *
 * Пускаем колбэки Claude, дополнительные из конфига и loopback по http: Claude Code слушает
 * случайный локальный порт, а код на машине самого человека никто другой не перехватит.
 */
export function isAllowedRedirectUri(uri: string, extra: string[] = []): boolean {
	if (CLAUDE_CALLBACKS.includes(uri) || extra.includes(uri)) return true

	if (!URL.canParse(uri)) return false

	const url = new URL(uri)

	return url.protocol === 'http:' && isLoopback(url)
}
