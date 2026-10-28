import { AsyncLocalStorage } from 'node:async_hooks'
import { inspect } from 'node:util'
import type { BaseTransportOptions, Event, EventHint, Transport } from '@sentry/core'

import { str, type Env } from './env.ts'
import { strictCopy, strictError, strictEvent } from './sentry-event.ts'

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
	addEventProcessor(processor: (event: Event, hint: EventHint) => Event): unknown
	getClient(): ForeignClient | undefined
	getPropagationContext?(): object
	setPropagationContext?(context: object): unknown
}
type ForeignClient = {
	flush(timeout: number): PromiseLike<unknown>
	getDsn?(): unknown
	getOptions?(): { enabled?: boolean; dsn?: unknown }
}
type Carrier = { acs?: { getCurrentScope?(): ForeignScope }; defaultCurrentScope?: ForeignScope }

export type SentryOptions = {
	/** Имя сервера, как в `runCli`: релиз в Sentry -- `<name>@<version>`. */
	name: string
	version: string
	env?: Env
	/** Свой транспорт вместо сети. Нужен тестам: так видно, что именно уйдёт в Sentry. */
	transport?: (options: BaseTransportOptions) => Transport
}

const SEND_TIMEOUT = 2000

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
		// `dataCollection` не касается текста ошибок, тегов и того, что сервер положил в scope:
		// событие собирается заново только из разрешённых полей.
		beforeSend: strictEvent,
		beforeBreadcrumb: () => null,
		// Без `eventFiltersIntegration`: текста в событии нет, и фильтровать по нему нечего,
		// а копию без кадров и без кода он отбросил бы как бесполезную.
		integrations: [sentry.functionToStringIntegration(), sentry.linkedErrorsIntegration()],
		stackParser: sentry.createStackParser(nodeStackLineParser()),
		transport: transport ?? fetchTransport(sentry),
		platform: 'node',
		runtime: { name: 'node', version: process.version },
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

		// Без DSN SDK не заводит транспорт, и такой клиент молча теряет всё.
		if (!client || isClosed(client) || !(client.getDsn?.() ?? client.getOptions?.().dsn)) continue

		return {
			capture(error, tags) {
				const scope = current()!.clone()
				const propagation = scope.getPropagationContext?.()

				// DSC входящего запроса, baggage посетителя и имя транзакции с адресом, SDK кладёт
				// в заголовок конверта `trace` уже после процессоров. Связь с трейсом остаётся,
				// а DSC SDK соберёт заново из своих опций: релиз, окружение, ключ DSN.
				if (propagation) scope.setPropagationContext?.({ ...propagation, dsc: undefined })

				scope.setTags(tags)
				// `beforeSend` чужого клиента кит не ставит, поэтому строгим делает своё событие
				// процессором на копии scope: остальные события сервера он не трогает.
				scope.addEventProcessor(strictEvent)
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
		const response = await fetch(options.url, {
			method: 'POST',
			body: body as BodyInit,
			headers: options.headers,
			// Sentry не перенаправляет, а редирект увёл бы событие на чужой адрес или с https на http.
			redirect: 'error',
			// `flush` перестаёт ждать, но запрос не отменяет: зависший приёмник держал бы процесс живым.
			signal: AbortSignal.timeout(SEND_TIMEOUT),
		})

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
	// Свежая копия мимо кэша: отправленную раньше ошибку Sentry помечает и второй раз не шлёт,
	// а падение процесса -- отдельное событие.
	send(strictCopy(error), { fatal: 'true' })
	// Сломанная отправка не должна помешать выйти с 1 и напечатать стек.
	await flushSentry().catch(() => {})

	try {
		process.stderr.write(`${describe(error)}\n`)
	} finally {
		process.exit(1)
	}
}

function describe(error: unknown): string {
	try {
		return error instanceof Error ? String(error.stack) : String(error)
	} catch {
		// Объект без прототипа или с `toString`, который бросает: печатаем, как Node, не вызывая его.
		return inspect(error)
	}
}

/**
 * Отправить ошибку, которую кит поймал и превратил в ответ. Без Sentry ничего не делает.
 * Уходит строгая копия, см. `strictError`: тип, код и кадры стека, без текста ошибки.
 * Одну ошибку могут поймать двое, например обработчик и HTTP-слой над ним: тот же объект
 * Sentry второй раз не шлёт, а разные случаи с одинаковым стеком уходят каждый.
 */
export function captureError(error: unknown, tags?: Tags): void {
	if (reporter) send(strictError(error), tags)
}

function send(copy: Error, tags?: Tags) {
	reporter?.capture(copy, { ...tagged.getStore(), ...tags })
}

/**
 * Выполнить `run` с тегами на всех ошибках внутри, в том числе после `await`.
 * Так ошибка из обёртки `tool` знает имя инструмента, хотя самой обёртке его могли не дать.
 */
export function withTags<T>(tags: Tags, run: () => T): T {
	return reporter ? tagged.run({ ...tagged.getStore(), ...tags }, run) : run()
}

/** Дождаться отправки перед выходом: иначе ошибка, уронившая процесс, не дойдёт. */
export async function flushSentry(timeout = SEND_TIMEOUT): Promise<void> {
	await reporter?.flush(timeout)
}
