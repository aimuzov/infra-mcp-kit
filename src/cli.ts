import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { messageOf } from './results.ts'
import { serveStdio } from './stdio.ts'

export type CliOptions = {
	name: string
	version: string
	/** Текст `--help`: команды и переменные окружения. */
	usage: string
	/** Сервер для stdio, режим по умолчанию. */
	stdio: () => McpServer | Promise<McpServer>
	/** `serve --http`. Без него сервер только локальный. */
	http?: () => unknown
	/** Свои подкоманды, например `auth` или `sync`. Аргументы после имени команды. */
	commands?: Record<string, (args: string[]) => unknown>
	argv?: string[]
}

/**
 * Точка входа сервера. Без аргументов поднимает stdio: так его запускает MCP-клиент.
 * Ошибка печатается одной строкой в stderr и даёт код выхода 1, без стека.
 */
export async function runCli({
	name,
	version,
	usage,
	stdio,
	http,
	commands = {},
	argv = process.argv.slice(2),
}: CliOptions): Promise<void> {
	const [command = 'serve', ...args] = argv

	try {
		if (command === '--help' || command === '-h') {
			console.log(usage)

			return
		}

		if (command === '--version' || command === '-v') {
			console.log(version)

			return
		}

		if (command === 'serve') {
			if (!args.includes('--http')) return await serveStdio(await stdio(), name)

			if (!http) throw new Error(`${name} не умеет работать по HTTP`)

			await http()

			return
		}

		const run = commands[command]

		if (!run) {
			console.error(`Неизвестная команда: ${command}\n\n${usage}`)
			process.exitCode = 2

			return
		}

		await run(args)
	} catch (error) {
		console.error(`${name}: ${messageOf(error)}`)
		process.exitCode = 1
	}
}
