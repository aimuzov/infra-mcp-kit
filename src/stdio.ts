import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { log } from './log.ts'

/** Поднять сервер на stdio. Сообщение о старте уходит в stderr, stdout принадлежит протоколу. */
export async function serveStdio(server: McpServer, name = 'mcp'): Promise<void> {
	await server.connect(new StdioServerTransport())

	log.info(`${name} running on stdio`)
}
