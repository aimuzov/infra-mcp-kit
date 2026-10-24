import type { NextFunction, Request, Response } from 'express'

import { isLoopback } from './config.ts'
import type { TokenClaims, Tokens } from './oauth/tokens.ts'

export function readCookie(req: Request, name: string): string | undefined {
	for (const part of (req.get('cookie') ?? '').split(';')) {
		const [key, ...rest] = part.trim().split('=')

		if (key === name) return decodeURIComponent(rest.join('='))
	}

	return undefined
}

export type Sessions = {
	read(req: Request): Promise<TokenClaims | null>
	write(res: Response, claims: TokenClaims): Promise<void>
	clear(res: Response): void
}

/** Cookie кабинета: подписанный токен `session`, httpOnly и SameSite=Lax. */
export function sessions(tokens: Tokens, publicUrl: URL, cookie = 'mcp_session'): Sessions {
	const options = { httpOnly: true, secure: !isLoopback(publicUrl), sameSite: 'lax' as const, path: '/' }

	return {
		async read(req) {
			const token = readCookie(req, cookie)

			return token ? tokens.verify('session', token) : null
		},
		async write(res, claims) {
			res.cookie(cookie, await tokens.sign('session', claims), { ...options, maxAge: tokens.ttl.session * 1000 })
		},
		clear: (res) => void res.clearCookie(cookie, options),
	}
}

/**
 * Формы кабинета меняют и удаляют данные, имея за спиной только cookie. SameSite=Lax уже
 * не пускает её на кросс-сайтовые POST, проверка Origin закрывает остальное.
 */
export function sameOrigin(publicUrl: URL) {
	return (req: Request, res: Response, next: NextFunction) => {
		if (req.get('origin') === publicUrl.origin) return next()

		res.status(403).send('Запрос пришёл не со страницы сервиса')
	}
}
