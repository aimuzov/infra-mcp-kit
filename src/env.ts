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

/** Целое число; мусор, ноль и отрицательные дают `fallback`. */
export function int(env: Env, name: string, fallback: number): number {
	const value = Number.parseInt(str(env, name), 10)

	return value > 0 ? value : fallback
}

export function bool(env: Env, name: string, fallback = false): boolean {
	const value = str(env, name).toLowerCase()

	if (!value) return fallback

	return ['1', 'true', 'yes', 'on'].includes(value)
}

/** Список через запятую. */
export function list(env: Env, name: string): string[] {
	return str(env, name)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
}

/**
 * Каталог данных сервера: `<NAME>_DATA_DIR`, иначе `$XDG_CONFIG_HOME/<name>`
 * или `~/.config/<name>`. Создаётся, если его нет.
 */
export function dataDir(name: string, env: Env = process.env): string {
	const own = str(env, `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_DATA_DIR`)
	const dir = own || join(str(env, 'XDG_CONFIG_HOME', join(homedir(), '.config')), name)

	mkdirSync(dir, { recursive: true })

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
