import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

/** Код авторизации, который ждёт обмена на токены. */
export type PendingCode = {
	clientId: string
	codeChallenge: string
	redirectUri: string
	/** Подписанный или зашифрованный `grant`: кто вошёл и с какими claims. Хранилище его не читает. */
	grant: string
}

/**
 * Зарегистрированные клиенты и коды. Токены подписаны и в хранении не нуждаются, а эти двое
 * нуждаются: клиент регистрируется один раз и дальше приходит только с id, а код должен
 * сработать ровно один раз, чего одна подпись не обещает.
 */
export type AuthStore = {
	getClient(clientId: string): OAuthClientInformationFull | undefined
	saveClient(client: OAuthClientInformationFull): void
	issueCode(pending: PendingCode, now?: number): string
	/** Посмотреть код, не тратя его: SDK сначала сверяет PKCE. */
	peekCode(code: string, now?: number): PendingCode | undefined
	/** Потратить код. Undefined, если он уже потрачен или истёк. */
	takeCode(code: string, now?: number): PendingCode | undefined
	close?(): void
}

export const CODE_TTL_MS = 5 * 60 * 1000

const newCode = () => randomBytes(32).toString('base64url')

/**
 * Всё в памяти процесса. После перезапуска клиентам придётся зарегистрироваться заново:
 * Claude так и делает, получив `invalid_client`. Годится для тестов и сервисов без тома.
 */
export function memoryStore(): AuthStore {
	const clients = new Map<string, OAuthClientInformationFull>()
	const codes = new Map<string, PendingCode & { expiresAt: number }>()

	const peek = (code: string, now = Date.now()) => {
		const row = codes.get(code)

		if (!row || row.expiresAt < now) return undefined

		const { expiresAt: _, ...pending } = row

		return pending
	}

	return {
		getClient: (id) => clients.get(id),
		saveClient: (client) => void clients.set(client.client_id, client),
		issueCode(pending, now = Date.now()) {
			for (const [code, row] of codes) if (row.expiresAt < now) codes.delete(code)

			const code = newCode()

			codes.set(code, { ...pending, expiresAt: now + CODE_TTL_MS })

			return code
		},
		peekCode: peek,
		takeCode(code, now = Date.now()) {
			const pending = peek(code, now)

			codes.delete(code)

			return pending
		},
	}
}

const SCHEMA = [
	'PRAGMA journal_mode = WAL',
	`CREATE TABLE IF NOT EXISTS client (
		client_id TEXT PRIMARY KEY,
		info      TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS auth_code (
		code       TEXT PRIMARY KEY,
		client_id  TEXT NOT NULL,
		challenge  TEXT NOT NULL,
		redirect   TEXT NOT NULL,
		grant      TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
]

type CodeRow = { client_id: string; challenge: string; redirect: string; grant: string }

/** SQLite из `node:sqlite`: клиенты переживают перезапуск и деплой, если файл лежит на томе. */
export function sqliteStore(path: string): AuthStore {
	const db = new DatabaseSync(path)

	for (const sql of SCHEMA) db.prepare(sql).run()

	const peek = (code: string, now = Date.now()): PendingCode | undefined => {
		const row = db
			.prepare('SELECT client_id, challenge, redirect, grant FROM auth_code WHERE code = ? AND expires_at >= ?')
			.get(code, now) as CodeRow | undefined

		return (
			row && {
				clientId: row.client_id,
				codeChallenge: row.challenge,
				redirectUri: row.redirect,
				grant: row.grant,
			}
		)
	}

	return {
		getClient(id) {
			const row = db.prepare('SELECT info FROM client WHERE client_id = ?').get(id) as
				{ info: string } | undefined

			return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined
		},
		saveClient(client) {
			db.prepare('INSERT OR REPLACE INTO client (client_id, info) VALUES (?, ?)').run(
				client.client_id,
				JSON.stringify(client),
			)
		},
		issueCode(pending, now = Date.now()) {
			const code = newCode()

			db.prepare('DELETE FROM auth_code WHERE expires_at < ?').run(now)

			db.prepare(
				'INSERT INTO auth_code (code, client_id, challenge, redirect, grant, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
			).run(code, pending.clientId, pending.codeChallenge, pending.redirectUri, pending.grant, now + CODE_TTL_MS)

			return code
		},
		peekCode: peek,
		takeCode(code, now = Date.now()) {
			const pending = peek(code, now)

			if (!pending) return undefined

			// Два одновременных обмена прочитают один код, но удалит его только один из них.
			const { changes } = db.prepare('DELETE FROM auth_code WHERE code = ?').run(code)

			return changes ? pending : undefined
		},
		close: () => db.close(),
	}
}
