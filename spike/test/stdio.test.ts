import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const entry = fileURLToPath(new URL('../src/stdio.ts', import.meta.url))

async function connect() {
	const client = new Client({ name: 'spike', version: '0' }, { capabilities: { elicitation: {} } })

	client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { name: 'Lesha' } }))
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }))

	return client
}

test('stdio: официальный клиент SDK видит инструменты и схемы', async () => {
	const client = await connect()
	const { tools } = await client.listTools()

	assert.deepEqual(tools.map((t) => t.name).sort(), ['add', 'ask_name', 'boom', 'slow', 'whoami'])
	assert.deepEqual(tools.find((t) => t.name === 'add')?.inputSchema.required, ['a', 'b'])
	assert.equal(client.getServerVersion()?.name, 'tmcp-spike')
	await client.close()
})

test('stdio: structuredContent, ошибки валидации и исключения', async () => {
	const client = await connect()
	const ok = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } })

	assert.deepEqual(ok.structuredContent, { sum: 5 })

	const bad = await client.callTool({ name: 'add', arguments: { a: 'x' } }).catch((e: Error) => e)

	console.log('bad input ->', JSON.stringify(bad).slice(0, 300))

	const boom = await client.callTool({ name: 'boom', arguments: {} }).catch((e: Error) => e)

	console.log('throw ->', JSON.stringify(boom).slice(0, 300))
	await client.close()
})

test('stdio: elicitation и progress', async () => {
	const client = await connect()
	const asked = await client.callTool({ name: 'ask_name', arguments: {} })

	assert.deepEqual(asked.content, [{ type: 'text', text: 'hi Lesha' }])

	const progress: number[] = []
	const slow = await client.callTool({ name: 'slow', arguments: { steps: 3 } }, undefined, {
		onprogress: (p) => progress.push(p.progress),
	})

	assert.deepEqual(slow.content, [{ type: 'text', text: 'done' }])
	assert.deepEqual(progress, [1, 2, 3])
	await client.close()
})

test('stdio: отмена запроса доходит до signal', async () => {
	const client = await connect()
	const controller = new AbortController()
	const call = client.callTool({ name: 'slow', arguments: { steps: 40 } }, undefined, { signal: controller.signal })

	setTimeout(() => controller.abort('stop'), 120)
	await assert.rejects(call)

	// Сервер жив и отвечает дальше.
	const ok = await client.callTool({ name: 'add', arguments: { a: 1, b: 1 } })

	assert.deepEqual(ok.structuredContent, { sum: 2 })
	await client.close()
})
