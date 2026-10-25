import { appendFileSync } from 'node:fs'

/**
 * Лог только в stderr и, по желанию, в файл: stdout в stdio-режиме занят JSON-RPC,
 * и любая строка там ломает протокол.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export type Logger = Record<LogLevel, (message: string, meta?: unknown) => void>

export type LoggerOptions = {
	level?: LogLevel
	file?: string
	write?: (line: string) => void
}

export function createLogger({
	level = 'info',
	file,
	write = (line) => process.stderr.write(line),
}: LoggerOptions = {}): Logger {
	let toFile = file

	const at = (lvl: LogLevel) => (message: string, meta?: unknown) => {
		if (ORDER[lvl] > ORDER[level]) return

		const tail = meta === undefined ? '' : ` ${stringify(meta)}`
		const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${message}${tail}\n`

		write(line)

		if (toFile) {
			try {
				appendFileSync(toFile, line)
			} catch (error) {
				// Лог в файл -- удобство, падать из-за него нельзя. Но и терять молча тоже:
				// говорим один раз и дальше пишем только в основной поток.
				write(`[${new Date().toISOString()}] WARN log file ${toFile} is unavailable: ${String(error)}\n`)
				toFile = undefined
			}
		}
	}

	return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') }
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/** Уровень по имени; неизвестное имя (и `toString` с прототипа) не уровень. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
	const name = value?.trim().toLowerCase()

	return name && Object.hasOwn(ORDER, name) ? (name as LogLevel) : undefined
}

let shared: Logger | undefined

// Окружение читается при первой записи, а не при импорте: `.env` сервер подхватывает
// уже после того, как кит загружен, и уровень из него иначе бы не сработал.
function current(): Logger {
	if (shared) return shared

	const raw = process.env.LOG_LEVEL

	shared = createLogger({ level: parseLogLevel(raw) ?? 'info', file: process.env.LOG_FILE || undefined })

	if (raw?.trim() && !parseLogLevel(raw)) shared.warn(`LOG_LEVEL "${raw}" is unknown, using info`)

	return shared
}

/** Общий логгер процесса. Уровень и файл из `LOG_LEVEL` и `LOG_FILE`. */
export const log: Logger = {
	error: (message, meta) => current().error(message, meta),
	warn: (message, meta) => current().warn(message, meta),
	info: (message, meta) => current().info(message, meta),
	debug: (message, meta) => current().debug(message, meta),
}
