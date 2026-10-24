import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { log } from './log.ts'

export const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] })

/**
 * JSON для модели и он же в `structuredContent`, если это объект: клиенты со схемой выхода
 * читают его оттуда, остальные видят текст.
 */
export function json(value: unknown): CallToolResult {
	const result = text(JSON.stringify(value, null, 2))

	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		result.structuredContent = value as Record<string, unknown>
	}

	return result
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Ошибка инструмента уходит модели ответом с `isError`, а не исключением: так она может её прочитать и поправиться. */
export const failure = (error: unknown): CallToolResult => ({ ...text(messageOf(error)), isError: true })

/**
 * Обёртка обработчика инструмента: строка становится текстом, `CallToolResult` проходит как есть,
 * остальное уходит в `json`, а исключение -- в `failure` с записью в лог.
 */
export function tool<Args extends unknown[]>(
	handler: (...args: Args) => unknown,
): (...args: Args) => Promise<CallToolResult> {
	return async (...args) => {
		try {
			const value = await handler(...args)

			if (typeof value === 'string') return text(value)

			if (isResult(value)) return value

			return json(value)
		} catch (error) {
			log.error('tool failed', { message: messageOf(error) })

			return failure(error)
		}
	}
}

function isResult(value: unknown): value is CallToolResult {
	return value !== null && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)
}
