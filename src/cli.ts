import { parseLogLevel } from './log.ts'
import type { McpServer } from './mcp.ts'
import { causesOf, messageOf } from './results.ts'
import { captureError, flushSentry, initSentry } from './sentry.ts'
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

		await initSentry({ name, version })

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
		// С текстом причин из `cause`: в Sentry от них только коды.
		console.error(`${name}: ${[messageOf(error), ...(causesOf(error) ?? [])].join(': ')}`)
		captureError(error)
		await flushSentry()

		// Для своих ошибок хватает строки, а неожиданный TypeError без стека не найти.
		if (parseLogLevel(process.env.LOG_LEVEL) === 'debug' && error instanceof Error) console.error(error.stack)

		process.exitCode = 1
	}
}
