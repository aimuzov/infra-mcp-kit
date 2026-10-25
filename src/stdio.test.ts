import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const cli = pathToFileURL(join(import.meta.dirname, 'cli.ts')).href
const mcp = pathToFileURL(join(import.meta.dirname, 'mcp.ts')).href

/** Сервер на runCli в отдельном процессе: так его запускает клиент MCP. */
function server(argv: string[] = []) {
	const file = join(mkdtempSync(join(tmpdir(), 'kit-stdio-')), 'server.ts')

	writeFileSync(
		file,
		`import { McpServer } from '${mcp}'
import { runCli } from '${cli}'

await runCli({
	name: 'probe',
	version: '9.9.9',
	usage: 'usage: probe',
	stdio() {
		const server = new McpServer({ name: 'probe', version: '9.9.9' })

		server.registerTool('ping', { description: 'pong' }, () => ({ content: [{ type: 'text', text: 'pong' }] }))

		return server
	},
})
`,
	)

	return spawn(process.execPath, [file, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] })
}

/**
 * JSON-RPC вручную, без клиента SDK: тест проверяет провод, а не библиотеку,
 * и переживёт её замену.
 */
test('serve по умолчанию: stdout только протокол, баннер в stderr, выход по закрытию stdin', async () => {
	const child = server()
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
	const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
	const next = async () => JSON.parse((await lines.next()).value as string)
	let stderr = ''

	child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))

	send({
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
	})

	const init = await next()

	assert.equal(init.id, 1)
	assert.deepEqual(init.result.serverInfo, { name: 'probe', version: '9.9.9' })
	assert.ok(init.result.capabilities.tools)

	send({ method: 'notifications/initialized' })
	send({ id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } })

	assert.deepEqual((await next()).result, { content: [{ type: 'text', text: 'pong' }] })

	child.stdin.end()

	const code = await new Promise((resolve) => child.on('exit', resolve))

	assert.equal(code, 0)
	assert.match(stderr, /probe running on stdio/)
})

test('--help и -h печатают usage, --version и -v -- версию, и процесс выходит', async () => {
	const run = async (flag: string) => {
		const child = server([flag])
		let out = ''

		child.stdout.on('data', (chunk: Buffer) => (out += chunk))

		const code = await new Promise((resolve) => child.on('exit', resolve))

		return { code, out: out.trim() }
	}

	assert.deepEqual(await run('--help'), { code: 0, out: 'usage: probe' })
	assert.deepEqual(await run('-h'), { code: 0, out: 'usage: probe' })
	assert.deepEqual(await run('--version'), { code: 0, out: '9.9.9' })
	assert.deepEqual(await run('-v'), { code: 0, out: '9.9.9' })
})
