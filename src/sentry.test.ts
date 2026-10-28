import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as core from '@sentry/core'
import { z } from 'zod'

import { telegramAccount } from '#kit/http/account/telegram'
import { createHttpApp, type Route } from '#kit/http/app'
import { telegramLogin } from '#kit/http/login/telegram'
import { tokenFormLogin } from '#kit/http/login/token-form'
import type { Login } from '#kit/http/oauth/provider'
import { memoryStore } from '#kit/http/oauth/store'
import {
	accountLogin,
	fakePages,
	oauthFlow,
	startHttp,
	submitForm,
	telegramSigned,
	type RunningHttp,
} from '#kit/testing/index'

import { createLogger, type Logger } from './log.ts'
import { McpServer } from './mcp.ts'
import { tool } from './results.ts'
import { captureError, flushSentry, initSentry } from './sentry.ts'

const quiet = { error() {}, warn() {}, info() {}, debug() {} }
const SECRET_ARG = 'card 4276-0000-1111-2222'
const SECRET_QUERY = 'token=abc'
// Подложенные секреты: API-токен в виде UUID, JWT и токен бота Telegram.
const PLANTED = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJrYWl0ZW4ifQ.Kq2rCmgVTpD0pXMjWj1EDx1vJmLy3tqB0V4i3x9P0nE'
const BOT_TOKEN = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2'

type Frame = { filename?: string; function?: string; in_app?: boolean }
type Event = {
	release?: string
	environment?: string
	tags?: Record<string, string>
	contexts?: Record<string, Record<string, unknown>>
	exception?: { values: Array<{ type?: string; value?: string; stacktrace?: { frames: Frame[] } }> }
	[field: string]: unknown
}

// Конверт Sentry -- `[заголовки, [[заголовок, тело], ...]]`. Храним заголовки, типы частей
// и весь конверт строкой: по ней видно, что секрет не ушёл ни в одно поле.
const sent: Array<{ event: Event; header: Record<string, unknown>; items: string[]; raw: string }> = []

const transport = () => ({
	send: async (envelope: unknown) => {
		const [header, items] = envelope as [Record<string, unknown>, Array<[{ type: string }, unknown]>]
		const event = items.find(([item]) => item.type === 'event')?.[1] as Event | undefined

		if (event) sent.push({ event, header, items: items.map(([item]) => item.type), raw: JSON.stringify(envelope) })

		return {}
	},
	flush: async () => true,
})

async function events() {
	await flushSentry()

	return sent.map((s) => s.event)
}

const valuesOf = (event: Event | undefined) => event?.exception?.values.map(({ type, value }) => ({ type, value }))

function server() {
	const mcp = new McpServer({ name: 'kit', version: '3.0.0' }, { logger: quiet })

	mcp.registerTool('pay', { description: 'Throws', inputSchema: { note: z.string() } }, async () => {
		await new Promise((resolve) => setTimeout(resolve, 1))

		throw new Error('pay failed')
	})

	// Обёртка `tool` без имени: тег всё равно приходит из `registerTool`.
	mcp.registerTool(
		'wrapped',
		{ description: 'Throws inside tool()', inputSchema: { note: z.string() } },
		tool(
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 1))

				throw new Error('wrapped failed')
			},
			{ logger: quiet },
		),
	)

	mcp.registerTool('leaky', { description: 'Throws with a token' }, async () => {
		throw new Error(
			`Kaiten 401: GET https://kaiten.example/api/cards?token=${PLANTED} with Authorization: Bearer ${JWT}`,
		)
	})

	mcp.registerPrompt('broken', { description: 'Throws' }, () => {
		throw new Error('prompt failed')
	})

	return mcp
}

const call = (mcp: McpServer, name: string) =>
	mcp.receive({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name, arguments: { note: SECRET_ARG } },
	}) as Promise<{ result: { isError?: boolean; content: Array<{ text: string }> } }>

const running: RunningHttp[] = []

after(() => Promise.all(running.map((http) => http.close())))

/** Коннектор со входом или своими маршрутами, со страницами-заглушками. */
async function startApp({ login, routes, logger = quiet }: { login?: Login; routes?: Route[]; logger?: Logger }) {
	const http = await startHttp((base) =>
		createHttpApp({
			config: { port: 0, publicUrl: new URL(base), authSecret: 'x'.repeat(32), allowedRedirectUris: [] },
			service: { name: 'test' },
			createServer: () => server(),
			logger,
			publicDir: fakePages(),
			...(login && { auth: { store: memoryStore(), login, tokens: 'encrypt' as const } }),
			...(routes && { routes }),
		}),
	)

	running.push(http)

	return http.base
}

/** Приложение без сети: маршрут бросает `error`, путь запроса -- `path`. */
async function routeFailure(path: string, error: Error) {
	const app = createHttpApp({
		config: {
			port: 0,
			publicUrl: new URL('http://localhost:1'),
			authSecret: 'x'.repeat(32),
			allowedRedirectUris: [],
		},
		service: { name: 'test' },
		createServer: () => server(),
		logger: quiet,
		routes: () => {
			throw error
		},
	})

	return app.handle(new Request(`http://localhost:1${path}`))
}

describe('sentry', () => {
	beforeEach(() => {
		sent.length = 0
	})

	test('без SENTRY_DSN не включается и ничего не шлёт', async () => {
		assert.equal(await initSentry({ name: 'kit-test', version: '1.2.3', env: {}, transport }), false)

		const response = await call(server(), 'pay')

		assert.equal(response.result.isError, true)
		captureError(new Error('nowhere'))
		assert.deepEqual(await events(), [])
	})

	test('с SENTRY_DSN включается: релиз из имени и версии, окружение production', async (t) => {
		const env = { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1' }
		const warn = t.mock.method(console, 'warn')

		assert.equal(await initSentry({ name: 'kit-test', version: '1.2.3', env, transport }), true)
		// SDK 11 ругается в stderr на опции, которые сам не вызовет, например `beforeSendTransaction`.
		assert.equal(warn.mock.callCount(), 0, String(warn.mock.calls[0]?.arguments))

		// Повторный вызов не переинициализирует SDK.
		assert.equal(await initSentry({ name: 'other', version: '9.9.9', env, transport }), true)

		captureError(new Error('direct'))

		const [event] = await events()

		assert.equal(event?.release, 'kit-test@1.2.3')
		assert.equal(event?.environment, 'production')
		assert.deepEqual(valuesOf(event), [{ type: 'Error', value: '' }])
		assert.ok(!sent[0]!.raw.includes('direct'), 'текст ошибки не уходит')
	})

	test('в событии только разрешённое: без scope сервера, крошек, вложений и имени машины', async () => {
		// Крошки из API SDK кит не копит вовсе: `beforeBreadcrumb` их отбрасывает.
		core.addBreadcrumb({ message: `global ${PLANTED}` })

		core.withScope((scope) => {
			scope.setUser({ id: PLANTED, email: 'person@example.com' })
			scope.setExtra('token', PLANTED)
			scope.setContext('upstream', { token: PLANTED })
			scope.setTag('upstream.token', PLANTED)
			scope.addBreadcrumb({ message: PLANTED }, 100)
			scope.addAttachment({ filename: 'token.txt', data: PLANTED })
			captureError(new Error(`upstream ${PLANTED}`), { 'mcp.tool': 'pay' })
		})

		const [event, ...rest] = await events()
		const [{ header, items, raw }] = sent as [(typeof sent)[number]]

		assert.equal(rest.length, 0)
		assert.equal(core.getIsolationScope().getScopeData().breadcrumbs.length, 0)

		assert.deepEqual(Object.keys(event!).sort(), [
			'contexts',
			'environment',
			'event_id',
			'exception',
			'level',
			'platform',
			'release',
			'sdk',
			'tags',
			'timestamp',
		])

		assert.deepEqual(Object.keys(event!.contexts!).sort(), ['runtime', 'trace'])
		// Теги, которые сервис поставил сам, уходят как есть: данным людей в них не место.
		assert.deepEqual(event?.tags, { 'upstream.token': PLANTED, 'mcp.tool': 'pay' })

		// `sdkProcessingMetadata` SDK из тела убирает, но его `dynamicSamplingContext` отправил бы
		// заголовком `trace`: кит его не оставляет.
		assert.deepEqual(Object.keys(header).sort(), ['event_id', 'sent_at'])
		assert.deepEqual(items, ['event'], 'вложения scope не уходят')
		assert.equal(raw.split(PLANTED).length, 2, 'секрет только в теге, который сервис поставил сам')
	})

	test('ошибка инструмента уходит клиенту ответом и в Sentry с тегом, но без аргументов и текста', async () => {
		const response = await call(server(), 'pay')

		assert.equal(response.result.isError, true)
		assert.equal(response.result.content[0]?.text, 'pay failed')

		const [event, ...rest] = await events()

		assert.equal(rest.length, 0)
		assert.equal(event?.tags?.['mcp.tool'], 'pay')
		assert.deepEqual(valuesOf(event), [{ type: 'Error', value: '' }])
		assert.ok(!sent[0]!.raw.includes(SECRET_ARG), 'аргументы инструмента не уходят в Sentry')
		assert.ok(!sent[0]!.raw.includes('pay failed'), 'текст ошибки и ответ инструмента не уходят в Sentry')
	})

	test('ошибка внутри tool() без имени помечена инструментом из registerTool', async () => {
		const response = await call(server(), 'wrapped')

		assert.equal(response.result.isError, true)

		const [event, ...rest] = await events()

		assert.equal(rest.length, 0)
		assert.equal(event?.tags?.['mcp.tool'], 'wrapped')
		assert.ok(!sent[0]!.raw.includes(SECRET_ARG))
	})

	test('ошибка промпта уходит с тегом промпта', async () => {
		await server().receive({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'broken' } })

		const [event] = await events()

		assert.equal(event?.tags?.['mcp.prompt'], 'broken')
		assert.ok(!sent[0]!.raw.includes('prompt failed'))
	})

	test('ошибка HTTP-маршрута уходит с путём', async () => {
		const response = await routeFailure(`/api/thing?${SECRET_QUERY}`, new Error('route failed'))

		assert.equal(response.status, 500)

		const [event] = await events()

		assert.equal(event?.tags?.['http.path'], '/api/thing')
		assert.ok(!sent[0]!.raw.includes('route failed'))
		assert.ok(!sent[0]!.raw.includes(SECRET_QUERY), 'адрес запроса с параметрами не уходит в Sentry')
	})

	test('сегмент пути с токеном или кодом уходит звёздочкой', async () => {
		await routeFailure(`/bot${BOT_TOKEN}/getMe`, new Error('telegram failed'))
		await routeFailure(`/login/${PLANTED}`, new Error('login failed'))
		await routeFailure('/login/abcdefghijklmnopqrstuvwxyzABCDEFG', new Error('login failed'))

		assert.deepEqual(
			(await events()).map((event) => event.tags?.['http.path']),
			['/*/getMe', '/login/*', '/login/*'],
		)

		assert.ok(sent.every(({ raw }) => !raw.includes(BOT_TOKEN) && !raw.includes(PLANTED)))
	})

	test('одинаковые ошибки подряд уходят каждая, одна и та же -- один раз', async () => {
		const error = Object.assign(new Error('again'), { code: 'EAGAIN' })

		captureError(error)
		// Её же ловит HTTP-слой над обработчиком: событие уже ушло.
		captureError(error, { 'http.path': '/mcp' })

		for (let i = 0; i < 2; i++) captureError(Object.assign(new Error('same'), { code: 'ESAME' }))

		const all = await events()

		assert.deepEqual(
			all.map((event) => event.exception?.values[0]?.value),
			['EAGAIN', 'ESAME', 'ESAME'],
		)

		assert.equal(all[0]?.tags?.['http.path'], undefined)
	})

	test('брошенный не Error уходит заменой, без своего содержимого', async () => {
		const thrown = { note: SECRET_ARG, token: PLANTED }

		captureError(thrown)
		captureError(thrown)
		captureError(`Bearer ${JWT}`)

		const [object, string, ...rest] = await events()

		assert.equal(rest.length, 0, 'тот же объект уходит один раз')
		assert.equal(object?.exception?.values[0]?.value, 'Non-Error thrown: object')
		assert.equal(string?.exception?.values[0]?.value, 'Non-Error thrown: string')

		for (const { raw } of sent)
			for (const secret of [SECRET_ARG, PLANTED, JWT]) assert.ok(!raw.includes(secret), raw)
	})

	test('секрет в тексте ошибки апстрима не уходит, а модель видит текст целиком', async () => {
		const response = await call(server(), 'leaky')

		assert.equal(response.result.isError, true)
		assert.match(response.result.content[0]?.text ?? '', new RegExp(PLANTED))

		const [event, ...rest] = await events()

		assert.equal(rest.length, 0)
		assert.equal(event?.tags?.['mcp.tool'], 'leaky')
		assert.deepEqual(valuesOf(event), [{ type: 'Error', value: '' }])

		for (const secret of [PLANTED, JWT, 'kaiten.example']) assert.ok(!sent[0]!.raw.includes(secret))
	})

	test('строки текста ошибки вида `    at ...` не становятся кадрами', async () => {
		captureError(new Error(`upstream 401\n    at leak (/srv/${PLANTED}.js:1:1)\n    at /srv/${JWT}:1:1`))

		const [event] = await events()
		const frames = event?.exception?.values[0]?.stacktrace?.frames ?? []

		assert.ok(frames.length > 0)
		assert.ok(frames.some((frame) => frame.filename?.endsWith('sentry.test.ts')))

		for (const secret of [PLANTED, JWT, 'leak']) assert.ok(!sent[0]!.raw.includes(secret), sent[0]!.raw)
	})

	test('текст, изменённый после создания, не уходит, кадры на месте', async () => {
		const error = new Error(`token ${PLANTED} rejected`)

		// Стек собран с прежним текстом, а потом текст дополнили.
		assert.ok(error.stack)
		error.message = `retry with Bearer ${JWT}\n    at leak (/srv/x.js:1:1)`
		captureError(error)

		const [event] = await events()
		const frames = event?.exception?.values[0]?.stacktrace?.frames ?? []

		assert.ok(frames.some((frame) => frame.filename?.endsWith('sentry.test.ts')))

		for (const secret of [PLANTED, JWT, 'leak']) assert.ok(!sent[0]!.raw.includes(secret), sent[0]!.raw)
	})

	test('цепочка cause уходит кодами, без текста, цикл не мешает', async () => {
		const inner = Object.assign(new Error(`connect ${PLANTED}:443`), { code: 'ECONNREFUSED' })
		const outer = new TypeError(`fetch failed for https://kaiten.example/?token=${JWT}`, { cause: inner })

		inner.cause = outer
		captureError(outer)
		captureError(Object.assign(new Error(`Kaiten answered ${PLANTED}`), { status: 503 }))

		const [chain, status] = await events()

		// SDK кладёт `cause` отдельным исключением перед исходным.
		assert.deepEqual(valuesOf(chain), [
			{ type: 'Error', value: 'ECONNREFUSED' },
			{ type: 'TypeError', value: '' },
		])

		assert.deepEqual(valuesOf(status), [{ type: 'Error', value: '503' }])

		for (const { raw } of sent)
			for (const secret of [PLANTED, JWT, 'kaiten.example']) assert.ok(!raw.includes(secret))
	})

	test('домашний каталог в кадрах становится ~', async () => {
		const error = new Error('home')

		error.stack = [
			'Error: home',
			`    at run (${join(homedir(), 'project/build/index.js')}:10:5)`,
			`    at ${pathToFileURL(join(homedir(), 'project/build/tool.mjs')).href}:3:7`,
		].join('\n')

		captureError(error)

		const [event] = await events()

		assert.deepEqual(
			event?.exception?.values[0]?.stacktrace?.frames.map(({ filename, in_app }) => ({ filename, in_app })),
			[
				{ filename: '~/project/build/tool.mjs', in_app: true },
				{ filename: '~/project/build/index.js', in_app: true },
			],
		)

		assert.ok(!sent[0]!.raw.includes(homedir()))
	})

	test('большой текст и длинный стек уходят быстро', async () => {
		const error = new Error('x'.repeat(1_000_000))

		error.stack = [String(error), ...Array<string>(100_000).fill('    at f (/srv/x.js:1:1)')].join('\n')

		const started = performance.now()

		captureError(error)

		const [event] = await events()

		// Порог с большим запасом: квадратичный разбор на таком входе шёл бы минуты.
		assert.ok(performance.now() - started < 2000, `${performance.now() - started} мс`)
		assert.equal(event?.exception?.values[0]?.stacktrace?.frames.length, 50)
	})

	test('ошибка входа: лог хранит текст целиком, в Sentry его нет', async () => {
		const password = 'correct horse, battery'
		const lines: string[] = []
		const login = tokenFormLogin({
			fields: [
				{ name: 'login', label: 'Логин' },
				{ name: 'password', label: 'Пароль', type: 'password' },
			],
			verify: (values) => {
				// Апстрим повторяет тело запроса в тексте ошибки.
				throw new Error(`auth API 500: ${JSON.stringify(values)}`)
			},
		})
		const base = await startApp({ login, logger: createLogger({ write: (line) => lines.push(line) }) })

		await assert.rejects(oauthFlow({ base, login: submitForm({ login: 'bob', password }) }), /303/)

		const logged = lines.find((line) => line.includes('login failed')) ?? ''

		assert.ok(logged.includes(password), 'лог у того, кто держит сервер, и текст в нём целиком')
		assert.ok((await events()).length === 1 && !sent[0]!.raw.includes(password))
	})

	test('ошибка входа по токену уходит типом и кодом из cause', async () => {
		const login = tokenFormLogin({
			fields: [{ name: 'token', label: 'API-токен' }],
			verify: ({ token }) => {
				throw Object.assign(new TypeError(`GET https://kaiten.example/api?token=${token}: Bearer ${token}`), {
					cause: Object.assign(new Error(`connect ${token}`), { code: 'ECONNREFUSED' }),
				})
			},
		})
		const base = await startApp({ login })

		await assert.rejects(oauthFlow({ base, login: submitForm({ token: PLANTED }) }), /303/)

		const [event, ...rest] = await events()

		assert.equal(rest.length, 0)
		assert.equal(event?.tags?.['http.path'], '/authorize/callback')

		assert.deepEqual(valuesOf(event), [
			{ type: 'Error', value: 'ECONNREFUSED' },
			{ type: 'TypeError', value: '' },
		])

		assert.ok(!sent[0]!.raw.includes(PLANTED))
		assert.ok(!sent[0]!.raw.includes('kaiten.example'))
	})

	test('ошибка входа через Telegram уходит без текста и токена бота', async () => {
		const login = telegramLogin({
			botToken: BOT_TOKEN,
			botName: 'test_bot',
			claims: () => {
				throw new Error(`profile lookup with ${BOT_TOKEN} failed`)
			},
		})
		const base = await startApp({ login })

		await assert.rejects(oauthFlow({ base, login: telegramSigned({ id: '42', first_name: 'A' }, BOT_TOKEN) }))

		const [event, ...rest] = await events()

		assert.equal(rest.length, 0)
		assert.equal(event?.tags?.['http.path'], '/authorize/callback')
		assert.deepEqual(valuesOf(event), [{ type: 'Error', value: '' }])
		assert.ok(!sent[0]!.raw.includes(BOT_TOKEN) && !sent[0]!.raw.includes('profile lookup'))
	})

	test('ошибка входа в кабинет уходит без текста, человек видит страницу ошибки', async () => {
		const account = telegramAccount({
			botToken: BOT_TOKEN,
			botName: 'test_bot',
			claims: () => {
				throw new Error(`session store rejected ${PLANTED}`)
			},
		})
		const base = await startApp({ routes: [account] })
		const { response, cookie } = await accountLogin(base, {
			user: { id: '42', first_name: 'A' },
			botToken: BOT_TOKEN,
		})

		assert.equal(response.status, 302)
		assert.match(response.headers.get('location') ?? '', /\/error/)
		assert.equal(cookie, '')

		const [event, ...rest] = await events()

		assert.equal(rest.length, 0)
		assert.equal(event?.tags?.['http.path'], '/account/login')
		assert.deepEqual(valuesOf(event), [{ type: 'Error', value: '' }])
		assert.ok(!sent[0]!.raw.includes(PLANTED))
	})

	// Сервер вроде kaiten-mcp зовёт `Sentry.init` из своего `@sentry/node` до `runCli`. Его ядро
	// другой версии, и состояние SDK лежит под другим ключом `__SENTRY__`: так и эмулируем.
	test('если сервер уже завёл Sentry, кит шлёт через его клиент строгое событие', async () => {
		const script = `
			const core = await import('@sentry/core')
			const { nodeStackLineParser, ServerRuntimeClient } = await import('@sentry/core/server')
			const events = []

			core.initAndBind(ServerRuntimeClient, {
				dsn: 'https://public@o0.ingest.sentry.io/1',
				release: 'own@1.0.0',
				integrations: [],
				stackParser: core.createStackParser(nodeStackLineParser()),
				transport: () => ({
					send: async (envelope) => {
						for (const [header, body] of envelope[1]) if (header.type === 'event') events.push(body)

						return {}
					},
					flush: async () => true,
				}),
			})

			// Что сервер сам положил в scope и в событие: у кита этого быть не должно.
			const own = core.getCurrentScope()

			own.setUser({ id: '${PLANTED}' })
			own.setExtra('token', '${PLANTED}')
			own.setContext('upstream', { token: '${PLANTED}' })
			own.setContext('runtime', { name: 'node', upstream: { token: '${PLANTED}' } })
			own.addBreadcrumb({ message: '${PLANTED}' }, 100)
			core.getClient().addEventProcessor((event) => ({ ...event, request: { url: '/?token=${PLANTED}' } }))

			const carriers = globalThis.__SENTRY__
			carriers['0.0.0-server'] = carriers[core.SDK_VERSION]
			delete carriers[core.SDK_VERSION]

			// Закрытый клиент и клиент без DSN других копий SDK лежат первыми: кит их пропускает.
			const closed = new ServerRuntimeClient({
				dsn: 'https://public@o0.ingest.sentry.io/2',
				integrations: [],
				stackParser: core.createStackParser(),
				transport: () => ({ send: async () => ({}), flush: async () => true }),
			})
			const scope = new core.Scope()

			scope.setClient(closed)
			await closed.close()
			const noDsn = new core.Scope()

			noDsn.setClient(new ServerRuntimeClient({ integrations: [], stackParser: core.createStackParser(), transport: () => ({}) }))
			globalThis.__SENTRY__ = {
				'0.0.0-closed': { defaultCurrentScope: scope },
				'0.0.0-no-dsn': { defaultCurrentScope: noDsn },
				...carriers,
			}

			const kit = await import(${JSON.stringify(new URL('./sentry.ts', import.meta.url).href)})
			const enabled = await kit.initSentry({ name: 'kit-test', version: '1.2.3', env: {} })

			kit.withTags({ 'mcp.tool': 'pay' }, () => kit.captureError(new Error('via server, Bearer ${PLANTED}')))
			// Своё событие сервер шлёт сам, и кит его не трогает.
			own.captureException(new Error('server own'))
			await kit.flushSentry()
			console.log(JSON.stringify({ enabled, events, listeners: process.listenerCount('uncaughtException') }))
		`
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			env: { ...process.env, SENTRY_DSN: '' },
			stdio: ['ignore', 'pipe', 'inherit'],
		})
		let stdout = ''

		child.stdout.on('data', (chunk) => (stdout += chunk))

		const [code] = await once(child, 'exit')

		assert.equal(code, 0)

		const { enabled, events, listeners } = JSON.parse(stdout) as {
			enabled: boolean
			events: Event[]
			listeners: number
		}
		const kit = events.find((event) => event.tags?.['mcp.tool'] === 'pay')
		const own = events.find((event) => event !== kit)

		assert.equal(enabled, true)
		assert.equal(listeners, 0, 'обработчики падения ставит сам сервер, кит свои не добавляет')
		assert.equal(events.length, 2)
		assert.equal(kit?.release, 'own@1.0.0')
		assert.deepEqual(valuesOf(kit), [{ type: 'Error', value: '' }])
		assert.ok(kit?.exception?.values[0]?.stacktrace?.frames.length, 'кадры разобрал клиент сервера')

		for (const field of ['user', 'extra', 'request', 'breadcrumbs']) {
			assert.equal(kit?.[field], undefined, field)
			assert.ok(own?.[field], `${field} у события самого сервера`)
		}

		assert.deepEqual(Object.keys(kit?.contexts ?? {}).sort(), ['runtime', 'trace'])
		assert.deepEqual(kit?.contexts?.runtime, { name: 'node' })
		assert.ok(!JSON.stringify(kit).includes(PLANTED), JSON.stringify(kit))
	})

	test('сломанная отправка не мешает упавшему процессу выйти с кодом 1', async () => {
		const script = [
			`const { initSentry } = await import(${JSON.stringify(new URL('./sentry.ts', import.meta.url).href)})`,
			"const transport = () => ({ send: async () => ({}), flush: async () => { throw new Error('flush broke') } })",
			"await initSentry({ name: 'crash-test', version: '0.0.1', transport })",
			"setTimeout(() => { throw new Error('crashed') })",
		].join('\n')
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			env: { ...process.env, SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1' },
			stdio: ['ignore', 'ignore', 'pipe'],
		})
		let stderr = ''

		child.stderr.on('data', (chunk) => (stderr += chunk))

		const [code] = await once(child, 'exit')

		assert.equal(code, 1)
		assert.match(stderr, /Error: crashed/)
	})

	test('зависший приёмник не держит процесс после отправки', async () => {
		const ingest = createServer(() => {})

		ingest.listen(0, '127.0.0.1')
		await once(ingest, 'listening')

		const { port } = ingest.address() as AddressInfo
		const script = [
			`const { captureError, flushSentry, initSentry } = await import(${JSON.stringify(new URL('./sentry.ts', import.meta.url).href)})`,
			"await initSentry({ name: 'hang-test', version: '0.0.1' })",
			"captureError(new Error('stuck'))",
			'await flushSentry()',
		].join('\n')
		const started = Date.now()
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1` },
			stdio: 'ignore',
		})
		// Без тайм-аута отправки процесс висит, пока приёмник держит соединение: тест не должен висеть с ним.
		const kill = setTimeout(() => child.kill(), 10_000)
		const [code] = await once(child, 'exit')

		clearTimeout(kill)
		ingest.closeAllConnections()
		ingest.close()

		assert.equal(code, 0)
		assert.ok(Date.now() - started < 5000, 'процесс вышел вскоре после тайм-аута отправки')
	})

	// Отдельный процесс: здесь SDK уже включён с подменённым транспортом, а проверить нужно
	// настоящую отправку по сети и падение процесса. Вместо Sentry -- локальный сервер.
	for (const [kind, crash] of [
		['исключение', "setTimeout(() => { throw new Error('crashed') })"],
		['отклонение промиса', "Promise.reject(new Error('crashed'))"],
		// Уже отправленная ошибка, которую потом бросили: падение всё равно уходит своим событием.
		[
			'исключение, отправленное раньше',
			"const e = new Error('crashed'); captureError(e); setTimeout(() => { throw e })",
		],
	]) {
		test(`необработанное ${kind} уходит по сети до выхода с кодом 1`, async () => {
			const bodies: string[] = []
			const ingest = createServer((req, res) => {
				let body = ''

				req.on('data', (chunk) => (body += chunk))

				req.on('end', () => {
					bodies.push(body)
					res.end('{}')
				})
			})

			ingest.listen(0, '127.0.0.1')
			await once(ingest, 'listening')

			const { port } = ingest.address() as AddressInfo
			const script = [
				`const { captureError, initSentry } = await import(${JSON.stringify(new URL('./sentry.ts', import.meta.url).href)})`,
				"await initSentry({ name: 'crash-test', version: '0.0.1' })",
				crash,
			].join('\n')
			const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
				env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1` },
				stdio: ['ignore', 'ignore', 'pipe'],
			})
			let stderr = ''

			child.stderr.on('data', (chunk) => (stderr += chunk))

			const [code] = await once(child, 'exit')

			ingest.close()

			// Текст целиком печатается в stderr, у того, кто держит сервер.
			assert.equal(code, 1)
			assert.match(stderr, /Error: crashed/)

			const event = bodies
				.flatMap((body) => body.split('\n'))
				.map((line) => JSON.parse(line) as Event)
				.find((item) => item.tags?.fatal)

			assert.equal(event?.release, 'crash-test@0.0.1')
			assert.equal(event?.tags?.fatal, 'true')
			assert.deepEqual(valuesOf(event), [{ type: 'Error', value: '' }])
			assert.ok(event?.exception?.values[0]?.stacktrace?.frames.length)
			assert.ok(!bodies.join('\n').includes('crashed'), 'текст ошибки не уходит и при падении')
		})
	}
})
