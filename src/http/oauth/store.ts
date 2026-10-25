import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type { OAuthClient } from './errors.ts'

/** Код авторизации, который ждёт обмена на токены. */
export type PendingCode = {
	clientId: string
	codeChallenge: string
	redirectUri: string
	/** Подписанный или зашифрованный `grant`: кто вошёл и с какими claims. Хранилище его не читает. */
	grant: string
}

/** Действующий refresh-токен: его `jti` и цепочка, к которой он относится. */
export type RefreshRecord = {
	jti: string
	family: string
	subject: string
	/** Миллисекунды. */
	expiresAt: number
}

/**
 * Зарегистрированные клиенты, коды и refresh-токены. Подпись не обещает одного раза,
 * поэтому всё одноразовое лежит здесь: код, refresh-токен (каждый обмен выдаёт новый)
 * и отзыв доступа пользователя.
 *
 * Методы `take*` обязаны быть атомарными: из двух одновременных вызовов с одним ключом
 * запись получает только один.
 */
export type AuthStore = {
	getClient(clientId: string): OAuthClient | undefined
	saveClient(client: OAuthClient): void
	issueCode(pending: PendingCode, now?: number): string
	/** Посмотреть код, не тратя его: SDK сначала сверяет PKCE. */
	peekCode(code: string, now?: number): PendingCode | undefined
	/** Потратить код. Undefined, если он уже потрачен или истёк. */
	takeCode(code: string, now?: number): PendingCode | undefined
	saveRefresh(record: RefreshRecord): void
	/** Потратить refresh-токен. Undefined -- уже потрачен, отозван или истёк. */
	takeRefresh(jti: string, now?: number): RefreshRecord | undefined
	/** Отозвать всю цепочку: так поступают, когда потраченный токен предъявили снова. */
	revokeFamily(family: string): void
	/**
	 * Отозвать всё, что выдано пользователю до этого момента, например при удалении аккаунта.
	 * Токены доступа живут час, но и они перестают приниматься сразу.
	 */
	revokeSubject(subject: string, now?: number): void
	/** Момент последнего отзыва по пользователю в миллисекундах. */
	revokedBefore(subject: string): number | undefined
	close?(): void
}

export const CODE_TTL_MS = 5 * 60 * 1000

const newCode = () => randomBytes(32).toString('base64url')

/**
 * Всё в памяти процесса. После перезапуска клиентам придётся зарегистрироваться
 * и войти заново: Claude так и делает, получив `invalid_client`.
 * Годится для тестов и сервисов без тома.
 */
export function memoryStore(): AuthStore {
	const clients = new Map<string, OAuthClient>()
	const codes = new Map<string, PendingCode & { expiresAt: number }>()
	const refresh = new Map<string, RefreshRecord>()
	const revoked = new Map<string, number>()

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
		saveRefresh(record) {
			for (const [jti, row] of refresh) if (row.expiresAt < Date.now()) refresh.delete(jti)

			refresh.set(record.jti, record)
		},
		takeRefresh(jti, now = Date.now()) {
			const row = refresh.get(jti)

			refresh.delete(jti)

			return row && row.expiresAt >= now ? row : undefined
		},
		revokeFamily(family) {
			for (const [jti, row] of refresh) if (row.family === family) refresh.delete(jti)
		},
		revokeSubject(subject, now = Date.now()) {
			revoked.set(subject, now)

			for (const [jti, row] of refresh) if (row.subject === subject) refresh.delete(jti)
		},
		revokedBefore: (subject) => revoked.get(subject),
	}
}

/**
 * Версия схемы в `PRAGMA user_version`. 0 -- база кита 1.0, где были только клиенты и коды.
 * Коды живут пять минут, их таблицу при переходе можно пересоздать, клиентов -- нельзя.
 */
const SCHEMA_VERSION = 2

const SCHEMA = [
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
	`CREATE TABLE IF NOT EXISTS refresh_token (
		jti        TEXT PRIMARY KEY,
		family     TEXT NOT NULL,
		subject    TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS refresh_token_family ON refresh_token (family)',
	'CREATE INDEX IF NOT EXISTS refresh_token_subject ON refresh_token (subject)',
	`CREATE TABLE IF NOT EXISTS revoked_subject (
		subject TEXT PRIMARY KEY,
		before  INTEGER NOT NULL
	)`,
]

type CodeRow = { client_id: string; challenge: string; redirect: string; grant: string }
type RefreshRow = { jti: string; family: string; subject: string; expires_at: number }

function migrate(db: DatabaseSync): void {
	const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }

	if (version > SCHEMA_VERSION) {
		throw new Error(`База OAuth новее кита: версия схемы ${version}, кит знает ${SCHEMA_VERSION}`)
	}

	const run = (sql: string) => db.prepare(sql).run()

	run('BEGIN')

	try {
		// В базе старого формата (кит 1.0 или своя схема сервиса) таблица кодов могла
		// оказаться с другими колонками, а `IF NOT EXISTS` её бы не тронул.
		if (version < 1) run('DROP TABLE IF EXISTS auth_code')

		for (const sql of SCHEMA) run(sql)

		run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
		run('COMMIT')
	} catch (error) {
		run('ROLLBACK')

		throw error
	}
}

/** SQLite из `node:sqlite`: клиенты и refresh-токены переживают перезапуск и деплой, если файл лежит на томе. */
export function sqliteStore(path: string): AuthStore {
	const db = new DatabaseSync(path)

	db.prepare('PRAGMA journal_mode = WAL').run()
	migrate(db)

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

			return row ? (JSON.parse(row.info) as OAuthClient) : undefined
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
		saveRefresh({ jti, family, subject, expiresAt }) {
			db.prepare('DELETE FROM refresh_token WHERE expires_at < ?').run(Date.now())

			db.prepare('INSERT INTO refresh_token (jti, family, subject, expires_at) VALUES (?, ?, ?, ?)').run(
				jti,
				family,
				subject,
				expiresAt,
			)
		},
		takeRefresh(jti, now = Date.now()) {
			const row = db
				.prepare('SELECT jti, family, subject, expires_at FROM refresh_token WHERE jti = ?')
				.get(jti) as RefreshRow | undefined

			if (!row) return undefined

			const { changes } = db.prepare('DELETE FROM refresh_token WHERE jti = ?').run(jti)

			if (!changes || row.expires_at < now) return undefined

			return { jti: row.jti, family: row.family, subject: row.subject, expiresAt: row.expires_at }
		},
		revokeFamily(family) {
			db.prepare('DELETE FROM refresh_token WHERE family = ?').run(family)
		},
		revokeSubject(subject, now = Date.now()) {
			db.prepare('INSERT OR REPLACE INTO revoked_subject (subject, before) VALUES (?, ?)').run(subject, now)
			db.prepare('DELETE FROM refresh_token WHERE subject = ?').run(subject)
		},
		revokedBefore(subject) {
			const row = db.prepare('SELECT before FROM revoked_subject WHERE subject = ?').get(subject) as
				{ before: number } | undefined

			return row?.before
		},
		close: () => db.close(),
	}
}
