import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { beforeEach, describe, test } from 'node:test'
import { z } from 'zod'

import { createHttpApp } from '#kit/http/app'

import { McpServer } from './mcp.ts'
import { tool } from './results.ts'
import { captureError, flushSentry, initSentry } from './sentry.ts'

const quiet = { error() {}, warn() {}, info() {}, debug() {} }
const SECRET_ARG = 'card 4276-0000-1111-2222'
const SECRET_QUERY = 'token=abc'

type Event = {
	release?: string
	environment?: string
	tags?: Record<string, string>
	exception?: { values: Array<{ value?: string }> }
}

// Конверт Sentry -- `[заголовки, [[заголовок, тело], ...]]`. Сырое тело тоже храним:
// по нему видно, что аргументы инструмента не ушли ни в одно поле.
const sent: Array<{ event: Event; raw: string }> = []

const transport = () => ({
	send: async (envelope: unknown) => {
		for (const [header, body] of (envelope as [unknown, Array<[{ type: string }, unknown]>])[1]) {
			if (header.type === 'event') sent.push({ event: body as Event, raw: JSON.stringify(body) })
		}

		return {}
	},
	flush: async () => true,
})

async function events() {
	await flushSentry()

	return sent.map((s) => s.event)
}

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

	test('с SENTRY_DSN включается: релиз из имени и версии, окружение production', async () => {
		const env = { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1' }

		assert.equal(await initSentry({ name: 'kit-test', version: '1.2.3', env, transport }), true)
		// Повторный вызов не переинициализирует SDK.
		assert.equal(await initSentry({ name: 'other', version: '9.9.9', env, transport }), true)

		captureError(new Error('direct'))

		const [event] = await events()

		assert.equal(event?.release, 'kit-test@1.2.3')
		assert.equal(event?.environment, 'production')
		assert.equal(event?.exception?.values[0]?.value, 'direct')
	})

	test('ошибка инструмента уходит клиенту ответом и в Sentry с тегом, но без аргументов', async () => {
		const response = await call(server(), 'pay')

		assert.equal(response.result.isError, true)
		assert.equal(response.result.content[0]?.text, 'pay failed')

		const [event, ...rest] = await events()

		assert.equal(rest.length, 0)
		assert.equal(event?.tags?.['mcp.tool'], 'pay')
		assert.equal(event?.exception?.values[0]?.value, 'pay failed')
		assert.ok(!sent[0]!.raw.includes(SECRET_ARG), 'аргументы инструмента не уходят в Sentry')
		assert.ok(!sent[0]!.raw.includes('pay failed"}]'), 'ответ инструмента не уходит в Sentry')
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
		assert.equal(event?.exception?.values[0]?.value, 'prompt failed')
	})

	test('ошибка HTTP-маршрута уходит с путём', async () => {
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
				throw new Error('route failed')
			},
		})

		const response = await app.handle(new Request(`http://localhost:1/api/thing?${SECRET_QUERY}`))

		assert.equal(response.status, 500)

		const [event] = await events()

		assert.equal(event?.tags?.['http.path'], '/api/thing')
		assert.equal(event?.exception?.values[0]?.value, 'route failed')
		assert.ok(!sent[0]!.raw.includes(SECRET_QUERY), 'адрес запроса с параметрами не уходит в Sentry')
	})

	// Отдельный процесс: здесь SDK уже включён с подменённым транспортом, а проверить нужно
	// настоящую отправку по сети и падение процесса. Вместо Sentry -- локальный сервер.
	for (const [kind, crash] of [
		['исключение', "setTimeout(() => { throw new Error('crashed') })"],
		['отклонение промиса', "Promise.reject(new Error('crashed'))"],
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
				`const { initSentry } = await import(${JSON.stringify(new URL('./sentry.ts', import.meta.url).href)})`,
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

			assert.equal(code, 1)
			assert.match(stderr, /Error: crashed/)

			const event = bodies
				.flatMap((body) => body.split('\n'))
				.map((line) => JSON.parse(line) as Event)
				.find((item) => item.exception)

			assert.equal(event?.release, 'crash-test@0.0.1')
			assert.equal(event?.tags?.fatal, 'true')
			assert.equal(event?.exception?.values[0]?.value, 'crashed')
		})
	}
})
