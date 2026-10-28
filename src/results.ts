import { log as defaultLog, type Logger } from './log.ts'
import type { CallToolResult } from './mcp.ts'
import { captureError } from './sentry.ts'

export const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] })

export type JsonOptions = {
	/**
	 * Класть ли объект ещё и в `structuredContent`. По умолчанию да, но большой ответ
	 * без схемы выхода так уходит дважды, такому лучше `false`.
	 */
	structured?: boolean
}

/**
 * JSON для модели и он же в `structuredContent`, если это обычный объект: клиенты со схемой
 * выхода читают его оттуда, остальные видят текст.
 */
export function json(value: unknown, { structured = true }: JsonOptions = {}): CallToolResult {
	// `undefined` и функции JSON.stringify не превращает в строку, а текст в ответе обязателен.
	const result = text(JSON.stringify(value, null, 2) ?? 'null')

	if (structured && isPlainObject(value)) result.structuredContent = value

	return result
}

export function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message

	if (error !== null && typeof error === 'object') {
		try {
			return JSON.stringify(error)
		} catch {
			// Циклический объект, остаётся String.
		}
	}

	return String(error)
}

const MAX_CAUSES = 5

/**
 * Тексты цепочки `cause` для лога, до пяти уровней. В Sentry из неё уходят только коды, а куда
 * не достучался `fetch failed`, написано в тексте его причины: `connect ECONNREFUSED 10.0.0.7:5432`.
 */
export function causesOf(error: unknown): string[] | undefined {
	const causes: string[] = []
	const seen = new Set<unknown>()

	try {
		for (let item = error; item instanceof Error && causes.length < MAX_CAUSES;) {
			seen.add(item)

			const cause: unknown = item.cause

			if (cause === undefined || seen.has(cause)) break

			causes.push(messageOf(cause))
			item = cause
		}
	} catch {
		// Отозванный Proxy или геттер, который бросает: хватит того, что успели прочитать.
	}

	return causes.length > 0 ? causes : undefined
}

/** Ошибка инструмента уходит модели ответом с `isError`, а не исключением: так она может её прочитать и поправиться. */
export const failure = (error: unknown): CallToolResult => ({ ...text(messageOf(error)), isError: true })

export type ToolOptions = JsonOptions & {
	/** Имя инструмента для лога: без него по строке "tool failed" не понять, что упало. */
	name?: string
	logger?: Logger
}

/**
 * Обёртка обработчика инструмента: строка становится текстом, `CallToolResult` проходит как есть,
 * остальное уходит в `json`, а исключение -- в `failure` с записью в лог.
 */
export function tool<Args extends unknown[]>(
	handler: (...args: Args) => unknown,
	{ name, logger = defaultLog, ...jsonOptions }: ToolOptions = {},
): (...args: Args) => Promise<CallToolResult> {
	return async (...args) => {
		try {
			const value = await handler(...args)

			if (typeof value === 'string') return text(value)

			if (isResult(value)) return value

			return json(value, jsonOptions)
		} catch (error) {
			logger.error('tool failed', { tool: name, message: messageOf(error), causes: causesOf(error) })
			logger.debug('tool failed', { tool: name, stack: error instanceof Error ? error.stack : undefined })
			captureError(error, name ? { 'mcp.tool': name } : undefined)

			return failure(error)
		}
	}
}

function isResult(value: unknown): value is CallToolResult {
	return value !== null && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false

	const proto = Object.getPrototypeOf(value)

	return proto === Object.prototype || proto === null
}
