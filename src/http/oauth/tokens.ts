import { createHash } from 'node:crypto'
import { EncryptJWT, jwtDecrypt, jwtVerify, SignJWT, type JWTPayload } from 'jose'

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
export const TTL: Record<TokenKind, number> = {
	access: 60 * 60,
	refresh: 30 * 24 * 60 * 60,
	authorize: 10 * 60,
	grant: 5 * 60,
	session: 7 * 24 * 60 * 60,
}

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
	readonly ttl: Record<TokenKind, number>
	private readonly key: Uint8Array
	private readonly issuer: string

	constructor({ secret, issuer, mode = 'sign', ttl = {} }: TokensOptions) {
		this.mode = mode
		this.issuer = issuer
		this.ttl = { ...TTL, ...ttl }
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
			payload =
				this.mode === 'encrypt'
					? (await jwtDecrypt(token, this.key, { issuer: this.issuer })).payload
					: (await jwtVerify(token, this.key, { issuer: this.issuer, algorithms: ['HS256'] })).payload
		} catch {
			return null
		}

		if (payload.kind !== kind || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null

		return payload as TokenClaims & { exp: number }
	}
}

/** Claims, которые кит кладёт в токены сам: сервису в `extra` они не нужны. */
export const RESERVED_CLAIMS = new Set(['sub', 'kind', 'iss', 'iat', 'exp', 'nbf', 'jti', 'aud', 'client_id'])

export function ownClaims(claims: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(claims).filter(([k]) => !RESERVED_CLAIMS.has(k)))
}
