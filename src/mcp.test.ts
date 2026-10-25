import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import { z } from 'zod'

import { connectInMemory, textOf } from '#kit/testing/index'

import { McpServer, ResourceTemplate } from './mcp.ts'
import { StdioServerTransport } from './stdio.ts'

const quiet = { error() {}, warn() {}, info() {}, debug() {} }

function server() {
	const mcp = new McpServer({ name: 'kit', version: '3.0.0' }, { logger: quiet })

	mcp.registerTool(
		'add',
		{
			description: 'Add',
			inputSchema: { a: z.number(), b: z.number().default(1) },
			outputSchema: { sum: z.number() },
		},
		({ a, b }: { a: number; b: number }) => ({
			content: [{ type: 'text', text: String(a + b) }],
			structuredContent: { sum: a + b },
		}),
	)

	mcp.registerTool('titled', { title: 'With title', description: 'd' }, () => ({ content: [] }))

	mcp.registerTool('boom', { description: 'Throws' }, () => {
		throw new Error('kaboom')
	})

	mcp.registerTool(
		'steps',
		{ description: 'Progress', inputSchema: { n: z.number() } },
		async ({ n }: { n: number }, extra) => {
			for (let i = 1; i <= n; i++) {
				await extra.sendNotification({
					method: 'notifications/progress',
					params: { progressToken: extra._meta?.progressToken ?? 0, progress: i, total: n },
				})
			}

			return { content: [{ type: 'text', text: 'done' }] }
		},
	)

	mcp.registerTool('ask', { description: 'Elicit' }, async () => {
		const answer = await mcp.server.elicitInput({
			message: 'Name?',
			requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
		})

		return { content: [{ type: 'text', text: `${answer.action}:${answer.content?.name ?? ''}` }] }
	})

	mcp.registerPrompt('greet', { description: 'Greet', argsSchema: { name: z.string() } }, ({ name }) => ({
		messages: [{ role: 'user', content: { type: 'text', text: `hi ${name}` } }],
	}))

	mcp.registerResource('fixed', 'kit://fixed', { mimeType: 'text/plain' }, (uri) => ({
		contents: [{ uri: uri.href, text: 'fixed' }],
	}))

	mcp.registerResource(
		'by-key',
		new ResourceTemplate('kit://item/{key}', {
			list: () => ({ resources: [{ uri: 'kit://item/a', name: 'a' }] }),
		}),
		{ description: 'Items' },
		(uri, variables) => ({ contents: [{ uri: uri.href, text: `item ${variables.key}` }] }),
	)

	return mcp
}

describe('McpServer поверх tmcp: то, что видит клиент SDK', () => {
	test('схема входа -- как у SDK: без additionalProperties, default не делает поле обязательным', async () => {
		const client = await connectInMemory(server())
		const { tools } = await client.listTools()
		const add = tools.find((t) => t.name === 'add')!

		assert.equal('additionalProperties' in add.inputSchema, false)
		assert.deepEqual(add.inputSchema.required, ['a'])
		assert.deepEqual(add.outputSchema?.required, ['sum'])
	})

	test('без title в регистрации его нет и в списке, с ним -- есть', async () => {
		const client = await connectInMemory(server())
		const { tools } = await client.listTools()

		assert.equal(tools.find((t) => t.name === 'add')!.title, undefined)
		assert.equal(tools.find((t) => t.name === 'titled')!.title, 'With title')
	})

	test('исключение обработчика -- результат с isError, а не ошибка JSON-RPC', async () => {
		const client = await connectInMemory(server())
		const result = await client.callTool({ name: 'boom', arguments: {} })

		assert.equal(result.isError, true)
		assert.equal(textOf(result), 'kaboom')
	})

	test('structuredContent и вычисление по схеме', async () => {
		const client = await connectInMemory(server())
		const result = await client.callTool({ name: 'add', arguments: { a: 2 } })

		assert.deepEqual(result.structuredContent, { sum: 3 })
	})

	test('прогресс доходит до клиента', async () => {
		const client = await connectInMemory(server())
		const seen: number[] = []

		await client.callTool({ name: 'steps', arguments: { n: 3 } }, undefined, {
			onprogress: (p) => void seen.push(p.progress),
		})

		assert.deepEqual(seen, [1, 2, 3])
	})

	test('elicitation: вопрос уходит клиенту, ответ возвращается в инструмент', async () => {
		const client = await connectInMemory(server(), { capabilities: { elicitation: {} } })
		const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')

		client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { name: 'Alex' } }))

		assert.equal(textOf(await client.callTool({ name: 'ask', arguments: {} })), 'accept:Alex')
	})

	test('промпты, ресурсы и шаблоны ресурсов', async () => {
		const client = await connectInMemory(server())

		assert.deepEqual(
			(await client.listPrompts()).prompts.map((p) => p.name),
			['greet'],
		)

		assert.equal(
			(
				(await client.getPrompt({ name: 'greet', arguments: { name: 'A' } })).messages[0]!.content as {
					text: string
				}
			).text,
			'hi A',
		)

		assert.equal(
			((await client.readResource({ uri: 'kit://fixed' })).contents[0] as { text: string }).text,
			'fixed',
		)

		assert.equal(
			((await client.readResource({ uri: 'kit://item/b' })).contents[0] as { text: string }).text,
			'item b',
		)

		assert.deepEqual(
			(await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate),
			['kit://item/{key}'],
		)

		assert.ok((await client.listResources()).resources.some((r) => r.uri === 'kit://item/a'))
	})

	test('мелочи протокола как у SDK: промпт без аргументов, ресурсы шаблона, вызов без arguments', async () => {
		const mcp = server()

		mcp.registerPrompt('plain', { description: 'No args' }, () => ({ messages: [] }))

		const client = await connectInMemory(mcp)
		const plain = (await client.listPrompts()).prompts.find((p) => p.name === 'plain')!
		const item = (await client.listResources()).resources.find((r) => r.uri === 'kit://item/a')!
		const missing = await client.callTool({ name: 'add' } as never)

		assert.equal('arguments' in plain, false)
		assert.equal(item.description, 'Items')
		assert.equal(missing.isError, true)
		assert.match(textOf(missing), /"a"/)
	})

	test('возможности -- только то, что зарегистрировано, и без настроек сервера в initialize', async () => {
		const only = new McpServer({ name: 'tools-only', version: '1' }, { logger: quiet })

		only.registerTool('x', { description: 'x' }, () => ({ content: [] }))

		const client = await connectInMemory(only)
		const caps = client.getServerCapabilities()!

		assert.ok(caps.tools)
		assert.equal(caps.prompts, undefined)
		assert.equal(caps.resources, undefined)
	})
})

describe('stdio', () => {
	/** Сервер на паре потоков, как его видит клиент на другом конце stdio. */
	async function wire(mcp: McpServer) {
		const input = new PassThrough()
		const output = new PassThrough()
		const lines: unknown[] = []
		let buffer = ''

		output.on('data', (chunk: Buffer) => {
			buffer += chunk

			for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
				lines.push(JSON.parse(buffer.slice(0, i)))
				buffer = buffer.slice(i + 1)
			}
		})

		await mcp.connect(new StdioServerTransport(input, output))

		const send = (message: object) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
		const waitFor = async (match: (m: Record<string, unknown>) => boolean) => {
			for (let i = 0; i < 200; i++) {
				const found = lines.find((l) => match(l as Record<string, unknown>))

				if (found) return found as Record<string, unknown>

				await new Promise((resolve) => setTimeout(resolve, 5))
			}

			throw new Error('no such message')
		}

		return { send, waitFor, lines, raw: (line: string) => input.write(line) }
	}

	test('notifications/cancelled останавливает обработчик через AbortSignal и гасит ответ', async () => {
		const mcp = new McpServer({ name: 'cancel', version: '1' }, { logger: quiet })
		let stopped = false

		mcp.registerTool('wait', { description: 'Waits until cancelled' }, async (extra) => {
			await new Promise<void>((resolve) => extra.signal.addEventListener('abort', () => resolve()))
			stopped = true

			return { content: [{ type: 'text', text: 'too late' }] }
		})

		const { send, waitFor, lines } = await wire(mcp)

		send({
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
		})

		await waitFor((m) => m.id === 1)
		send({ id: 2, method: 'tools/call', params: { name: 'wait', arguments: {} } })
		send({ method: 'notifications/cancelled', params: { requestId: 2, reason: 'user' } })

		for (let i = 0; i < 100 && !stopped; i++) await new Promise((resolve) => setTimeout(resolve, 5))

		assert.equal(stopped, true)
		await new Promise((resolve) => setTimeout(resolve, 20))

		assert.equal(
			lines.some((l) => (l as { id?: number }).id === 2),
			false,
		)
	})

	test('битая строка не роняет сервер', async () => {
		const mcp = new McpServer({ name: 'junk', version: '1' }, { logger: quiet })
		const { send, raw, waitFor } = await wire(mcp)

		raw('{not json\n')

		send({ id: 1, method: 'ping' })
		assert.deepEqual((await waitFor((m) => m.id === 1)).result, {})
	})
})
