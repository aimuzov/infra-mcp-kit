import { AsyncLocalStorage } from 'node:async_hooks'
import { hostname } from 'node:os'
import type { BaseTransportOptions, Transport } from '@sentry/core'

import { str, type Env } from './env.ts'

type Tags = Record<string, string>
type Core = typeof import('@sentry/core')

/** Куда уходят ошибки: свой клиент кита или тот, что сервер завёл сам. */
type Reporter = {
	capture(error: unknown, tags: Tags): void
	flush(timeout: number): PromiseLike<unknown>
}

// Хватает того, что есть у `Scope` и `Client` любой версии SDK: чужой клиент
// может быть из другой копии `@sentry/core`, и её типы с нашими не совпадут.
type ForeignScope = {
	clone(): ForeignScope
	setTags(tags: Tags): unknown
	captureException(error: unknown): unknown
	getClient(): ForeignClient | undefined
}
type ForeignClient = { flush(timeout: number): PromiseLike<unknown>; getOptions?(): { enabled?: boolean } }
type Carrier = { acs?: { getCurrentScope?(): ForeignScope }; defaultCurrentScope?: ForeignScope }

export type SentryOptions = {
	/** Имя сервера, как в `runCli`: релиз в Sentry -- `<name>@<version>`. */
	name: string
	version: string
	env?: Env
	/** Свой транспорт вместо сети. Нужен тестам: так видно, что именно уйдёт в Sentry. */
	transport?: (options: BaseTransportOptions) => Transport
}

let reporter: Reporter | undefined
const tagged = new AsyncLocalStorage<Tags>()

/**
 * Включить отчёты об ошибках, если задан `SENTRY_DSN`; без него SDK даже не загружается.
 * Только ошибки, без трейсов. Клиент из `@sentry/core`, а не `@sentry/node`: тот тянет
 * OpenTelemetry и плагины сборщиков, 80 МБ против всего кита в 12. А его интеграции
 * пишут в событие адреса исходящих запросов и строки консоли, там бывают токены
 * и то, что люди доверили серверу.
 * Если сервер уже завёл Sentry сам, второй клиент не нужен: ошибки уходят через его.
 * Повторный вызов ничего не меняет. Возвращает, включён ли Sentry.
 */
export async function initSentry({ name, version, env = process.env, transport }: SentryOptions): Promise<boolean> {
	if (reporter) return true

	reporter = foreignReporter()

	if (reporter) return true

	const dsn = str(env, 'SENTRY_DSN')

	if (!dsn) return false

	const sentry = await import('@sentry/core')
	const { nodeStackLineParser, ServerRuntimeClient } = await import('@sentry/core/server')

	sentry.initAndBind(ServerRuntimeClient, {
		dsn,
		release: `${name}@${version}`,
		environment: str(env, 'SENTRY_ENVIRONMENT', 'production'),
		// В SDK 11 это замена `sendDefaultPii: false`, и строже: аргументы и ответы инструментов,
		// заголовки, тела запросов и переменные из стека остаются на сервере.
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: false,
			httpBodies: [],
			urlQueryParams: false,
			graphQL: { document: false, variables: false },
			genAI: { inputs: false, outputs: false },
			mcp: { inputs: false, outputs: false },
			databaseQueryData: false,
			queues: false,
			stackFrameVariables: false,
		},
		integrations: [
			sentry.eventFiltersIntegration(),
			sentry.functionToStringIntegration(),
			sentry.linkedErrorsIntegration(),
		],
		stackParser: sentry.createStackParser(nodeStackLineParser()),
		transport: transport ?? fetchTransport(sentry),
		platform: 'node',
		runtime: { name: 'node', version: process.version },
		serverName: hostname(),
	})

	reporter = {
		capture: (error, tags) => sentry.captureException(error, { tags }),
		flush: (timeout) => sentry.flush(timeout),
	}

	process.on('uncaughtException', fatal)
	// Слушатель отменяет падение по умолчанию, поэтому падаем сами, как Node без него.
	process.on('unhandledRejection', fatal)

	return true
}

/**
 * Клиент, который сервер завёл до `runCli`, например `Sentry.init` из `@sentry/node`.
 * `getClient()` из нашего `@sentry/core` его не видит, если версии разные: SDK держит
 * состояние в `globalThis.__SENTRY__` отдельно для каждой версии. Поэтому ищем во всех.
 */
function foreignReporter(): Reporter | undefined {
	const carriers = Object.values((globalThis as { __SENTRY__?: Record<string, unknown> }).__SENTRY__ ?? {})

	for (const carrier of carriers as Carrier[]) {
		if (carrier === null || typeof carrier !== 'object') continue

		const current = () => carrier.acs?.getCurrentScope?.() ?? carrier.defaultCurrentScope
		const client = current()?.getClient()

		if (!client || isClosed(client)) continue

		return {
			capture(error, tags) {
				const scope = current()!.clone()

				scope.setTags(tags)
				scope.captureException(error)
			},
			flush: (timeout) => client.flush(timeout),
		}
	}

	return undefined
}

/**
 * После `Sentry.close()` клиент остаётся в scope, но уже ничего не шлёт. Метка в реестре
 * `Symbol.for` общая для всех версий SDK, `enabled: false` -- на случай версии без неё.
 */
const isClosed = (client: ForeignClient) =>
	Symbol.for('SentryClosedClient') in client || client.getOptions?.().enabled === false

/** Сеть через `fetch` из Node: своего HTTP-клиента `@sentry/core` не везёт. */
const fetchTransport = (sentry: Core) => (options: BaseTransportOptions) =>
	sentry.createTransport(options, async ({ body }) => {
		const response = await fetch(options.url, { method: 'POST', body: body as BodyInit, headers: options.headers })

		return {
			statusCode: response.status,
			headers: {
				'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
				'retry-after': response.headers.get('retry-after'),
			},
		}
	})

let dying = false

/** Необработанная ошибка: дождаться отправки, напечатать стек и выйти с 1. */
async function fatal(error: unknown) {
	if (dying) return

	dying = true
	// Копия: отправленную раньше ошибку Sentry помечает и второй раз не шлёт, а падение процесса --
	// отдельное событие.
	send(error instanceof Error ? copyOf(error) : error, { fatal: 'true' })
	await flushSentry()
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
	process.exit(1)
}

const copyOf = (error: Error) =>
	Object.assign(new Error(error.message, { cause: error.cause }), { name: error.name, stack: error.stack })

/**
 * Отправить ошибку, которую кит поймал и превратил в ответ. Без Sentry ничего не делает.
 * Одну ошибку могут поймать двое, например обработчик и HTTP-слой над ним: тот же объект
 * Sentry второй раз не шлёт, а разные случаи с одинаковым стеком уходят каждый.
 */
export function captureError(error: unknown, tags?: Tags): void {
	send(error, tags)
}

function send(error: unknown, tags?: Tags) {
	reporter?.capture(safe(error), { ...tagged.getStore(), ...tags })
}

const replaced = new WeakMap<object, Error>()

/**
 * Не `Error` уходит заменой: брошенный объект Sentry кладёт в событие целиком, а в нём
 * бывают аргументы инструмента. Строку оставляем, это тот же текст ошибки. Замена
 * для объекта одна и та же, чтобы повтор узнавался, как у `Error`.
 */
function safe(error: unknown): Error {
	if (error instanceof Error) return error

	if (typeof error === 'string') return new Error(error)

	const replacement = new Error(`Non-Error thrown: ${error === null ? 'null' : typeof error}`)

	if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return replacement

	if (!replaced.has(error)) replaced.set(error, replacement)

	return replaced.get(error)!
}

/**
 * Выполнить `run` с тегами на всех ошибках внутри, в том числе после `await`.
 * Так ошибка из обёртки `tool` знает имя инструмента, хотя самой обёртке его могли не дать.
 */
export function withTags<T>(tags: Tags, run: () => T): T {
	return reporter ? tagged.run({ ...tagged.getStore(), ...tags }, run) : run()
}

/** Дождаться отправки перед выходом: иначе ошибка, уронившая процесс, не дойдёт. */
export async function flushSentry(timeout = 2000): Promise<void> {
	await reporter?.flush(timeout)
}
