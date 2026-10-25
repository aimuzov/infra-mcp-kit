import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { log } from './log.ts'
import type { McpServer, Transport } from './mcp.ts'

/** Сообщения JSON-RPC построчно: stdin -- от клиента, stdout -- клиенту. */
export class StdioServerTransport implements Transport {
	onmessage?: (message: unknown) => void
	onclose?: () => void
	readonly #input: Readable
	readonly #output: Writable

	constructor(input: Readable = process.stdin, output: Writable = process.stdout) {
		this.#input = input
		this.#output = output
	}

	async start(): Promise<void> {
		const lines = createInterface({ input: this.#input, crlfDelay: Infinity })

		lines.on('line', (line) => {
			if (!line.trim()) return

			try {
				this.onmessage?.(JSON.parse(line))
			} catch {
				// Битая строка не валит сервер: ответить на неё нечем, у неё нет id.
				log.warn('stdio: not JSON', { line: line.slice(0, 200) })
			}
		})

		lines.on('close', () => this.onclose?.())
	}

	async send(message: unknown): Promise<void> {
		this.#output.write(`${JSON.stringify(message)}\n`)
	}

	async close(): Promise<void> {
		this.#input.pause()
	}
}

/** Поднять сервер на stdio. Сообщение о старте уходит в stderr, stdout принадлежит протоколу. */
export async function serveStdio(server: McpServer, name = 'mcp'): Promise<void> {
	await server.connect(new StdioServerTransport())

	log.info(`${name} running on stdio`)
}
