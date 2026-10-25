import { createHash } from 'node:crypto'
import { EncryptJWT, jwtDecrypt, jwtVerify, SignJWT, type JWTPayload } from 'jose'

import { log } from '#kit/log'

/**
 * Всё, что сервер выдаёт на руки, различается по `kind`, чтобы одно нельзя было подсунуть
 * вместо другого: cookie кабинета не токен доступа, а токен доступа нельзя обновить.
 *
 * - `access` и `refresh` -- токены клиента;
 * - `authorize` -- запрос авторизации, который ходит через страницу входа и обратно;
 * - `grant` -- кто вошёл и с какими claims, лежит в хранилище рядом с кодом;
 * - `session` -- cookie кабинета.
 */
export type TokenKind = 'access' | 'refresh' | 'authorize' | 'grant' | 'session'

/** Время жизни в секундах. */
export const TTL: Readonly<Record<TokenKind, number>> = Object.freeze({
	access: 60 * 60,
	refresh: 30 * 24 * 60 * 60,
	authorize: 10 * 60,
	grant: 5 * 60,
	session: 7 * 24 * 60 * 60,
})

/** Сколько живёт цепочка refresh-токенов от первого входа, как бы часто её ни обновляли. */
export const REFRESH_FAMILY_TTL = 90 * 24 * 60 * 60

/** Короче секрет подбирается перебором. */
export const MIN_SECRET_LENGTH = 32

export type TokenClaims = { sub: string; [claim: string]: unknown }

export type TokensOptions = {
	secret: string
	issuer: string
	/**
	 * `sign` -- подписанный JWT, claims читаемы. `encrypt` -- JWE, claims закрыты: нужен,
	 * когда в токене едет чужой секрет, например API-токен Kaiten.
	 */
	mode?: 'sign' | 'encrypt'
	ttl?: Partial<Record<TokenKind, number>>
}

export class Tokens {
	readonly mode: 'sign' | 'encrypt'
	readonly ttl: Readonly<Record<TokenKind, number>>
	private readonly key: Uint8Array
	private readonly issuer: string

	constructor({ secret, issuer, mode = 'sign', ttl = {} }: TokensOptions) {
		if (secret.length < MIN_SECRET_LENGTH) {
			throw new Error(`Секрет токенов короче ${MIN_SECRET_LENGTH} символов`)
		}

		for (const [kind, seconds] of Object.entries(ttl)) {
			if (!Number.isFinite(seconds)) throw new Error(`TTL ${kind}: нужно число секунд, а задано ${seconds}`)
		}

		this.mode = mode
		this.issuer = issuer
		this.ttl = Object.freeze({ ...TTL, ...ttl })
		// Для A256GCM нужен ровно 32-байтный ключ, HS256 принимает любой.
		this.key = mode === 'encrypt' ? createHash('sha256').update(secret).digest() : new TextEncoder().encode(secret)
	}

	sign(kind: TokenKind, claims: TokenClaims): Promise<string> {
		const payload = { ...claims, kind }
		const ttl = `${this.ttl[kind]}s`

		if (this.mode === 'encrypt') {
			return new EncryptJWT(payload)
				.setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
				.setIssuer(this.issuer)
				.setIssuedAt()
				.setExpirationTime(ttl)
				.encrypt(this.key)
		}

		return new SignJWT(payload)
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuer(this.issuer)
			.setIssuedAt()
			.setExpirationTime(ttl)
			.sign(this.key)
	}

	/** Claims, либо null для поддельного, просроченного или чужого по `kind`. */
	async verify(kind: TokenKind, token: string): Promise<(TokenClaims & { exp: number }) | null> {
		let payload: JWTPayload

		try {
			// Алгоритмы JWE перечислены явно: иначе jose примет и PBES2 с дорогим PBKDF2,
			// и кто угодно нагрузит процессор поддельными токенами.
			payload =
				this.mode === 'encrypt'
					? (
							await jwtDecrypt(token, this.key, {
								issuer: this.issuer,
								keyManagementAlgorithms: ['dir'],
								contentEncryptionAlgorithms: ['A256GCM'],
							})
						).payload
					: (await jwtVerify(token, this.key, { issuer: this.issuer, algorithms: ['HS256'] })).payload
		} catch (error) {
			// Смена AUTH_SECRET или PUBLIC_URL иначе выглядит как внезапные 401 у всех.
			log.debug('token rejected', { kind, reason: (error as { code?: string }).code ?? String(error) })

			return null
		}

		if (payload.kind !== kind || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null

		return payload as TokenClaims & { exp: number }
	}
}

/** Claims, которые кит кладёт в токены сам: сервису в `extra` они не нужны. */
export const RESERVED_CLAIMS = new Set([
	'sub',
	'kind',
	'iss',
	'iat',
	'exp',
	'nbf',
	'jti',
	'aud',
	'client_id',
	'fam',
	'auth_time',
	'subject',
])

export function ownClaims(claims: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(claims).filter(([k]) => !RESERVED_CLAIMS.has(k)))
}
