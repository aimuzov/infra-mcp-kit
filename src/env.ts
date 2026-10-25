import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Env = Record<string, string | undefined>

/** Строка без пробелов по краям, пустая считается незаданной. */
export function str(env: Env, name: string, fallback = ''): string {
	return env[name]?.trim() || fallback
}

export function required(env: Env, name: string): string {
	const value = str(env, name)

	if (!value) throw new Error(`Не задана переменная окружения ${name}`)

	return value
}

/**
 * Целое число не меньше `min` (по умолчанию 1). Пустая переменная даёт `fallback`,
 * а мусор -- ошибку: опечатка в `PORT` не должна тихо превращаться в порт по умолчанию.
 */
export function int(env: Env, name: string, fallback: number, { min = 1 }: { min?: number } = {}): number {
	const raw = str(env, name)

	if (!raw) return fallback

	const value = Number(raw)

	if (!Number.isInteger(value) || value < min) {
		throw new Error(`${name}: нужно целое число от ${min}, а задано "${raw}"`)
	}

	return value
}

const TRUE = ['1', 'true', 'yes', 'on']
const FALSE = ['0', 'false', 'no', 'off']

export function bool(env: Env, name: string, fallback = false): boolean {
	const raw = str(env, name)
	const value = raw.toLowerCase()

	if (!value) return fallback

	if (TRUE.includes(value)) return true

	if (FALSE.includes(value)) return false

	throw new Error(`${name}: нужно ${TRUE.join('/')} или ${FALSE.join('/')}, а задано "${raw}"`)
}

/** Список через запятую. */
export function list(env: Env, name: string): string[] {
	return str(env, name)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
}

export type DataDirOptions = {
	/** Своя переменная вместо `<NAME>_DATA_DIR`, например уже описанная в README сервера. */
	variable?: string
	/** `false` -- только вычислить путь: чистому `loadConfig` не место для записи на диск. */
	create?: boolean
}

/**
 * Каталог данных сервера: `<NAME>_DATA_DIR`, иначе `$XDG_CONFIG_HOME/<name>`
 * или `~/.config/<name>`. По умолчанию создаётся, если его нет.
 */
export function dataDir(
	name: string,
	env: Env = process.env,
	{ variable = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_DATA_DIR`, create = true }: DataDirOptions = {},
): string {
	const dir = str(env, variable) || join(str(env, 'XDG_CONFIG_HOME', join(homedir(), '.config')), name)

	if (create) mkdirSync(dir, { recursive: true })

	return dir
}

/**
 * Подхватить `.env`, если он есть. Переменные, уже заданные окружением, не перезаписываются:
 * конфиг MCP-клиента главнее файла.
 */
export function loadEnvFile(path = '.env'): void {
	try {
		process.loadEnvFile(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
}
