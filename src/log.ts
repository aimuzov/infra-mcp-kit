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
	const at = (lvl: LogLevel) => (message: string, meta?: unknown) => {
		if (ORDER[lvl] > ORDER[level]) return

		const tail = meta === undefined ? '' : ` ${stringify(meta)}`
		const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${message}${tail}\n`

		write(line)

		if (file) {
			try {
				appendFileSync(file, line)
			} catch {
				// Лог в файл -- удобство, падать из-за него нельзя.
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

const envLevel = process.env.LOG_LEVEL as LogLevel | undefined

/** Общий логгер процесса. Уровень и файл из `LOG_LEVEL` и `LOG_FILE`. */
export const log = createLogger({
	level: envLevel && envLevel in ORDER ? envLevel : 'info',
	file: process.env.LOG_FILE || undefined,
})
