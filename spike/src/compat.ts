import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { JsonSchemaAdapter } from 'tmcp/adapter'
import { McpServer as TmcpServer } from 'tmcp'

// zod сервиса, а не спайка: z.object из чужого экземпляра zod склеивал бы схемы двух копий.
const serviceZod = await import(
	pathToFileURL(createRequire(join(process.cwd(), 'package.json')).resolve('zod')).href
).then((m: { z?: unknown; default?: unknown }) => (m.z ?? m.default ?? m) as typeof import('zod').z)

/**
 * @tmcp/adapter-zod строит схему по выходу zod, и у каждого объекта появляется
 * `additionalProperties: false`. SDK описывает вход, как его видит клиент.
 */
class InputSchemaAdapter extends JsonSchemaAdapter<any> {
	async toJsonSchema(schema: any) {
		return serviceZod.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as never
	}
}

type ToolConfig = {
	title?: string
	description?: string
	inputSchema?: Record<string, unknown>
	outputSchema?: Record<string, unknown>
	annotations?: Record<string, unknown>
}

/**
 * Фасад с API McpServer из SDK поверх tmcp. Нужен спайку, чтобы гонять тесты
 * реального сервиса без правок его кода; в ките 3.0 его место займёт свой API.
 */
export class McpServer {
	readonly tmcp: TmcpServer<any>
	#clientCapabilities: Record<string, unknown> | undefined
	#clientInfo: Record<string, unknown> | undefined

	/** То, что сервисы зовут через `server.server` в SDK. */
	readonly server = {
		getClientCapabilities: () => this.#clientCapabilities,
		elicitInput: (params: { message: string; requestedSchema: unknown }) =>
			this.tmcp.request({ method: 'elicitation/create', params: params as never }) as Promise<{
				action: string
				content?: Record<string, unknown>
			}>,
	}

	constructor(
		info: { name: string; version: string },
		options: { capabilities?: Record<string, unknown>; instructions?: string } = {},
	) {
		this.tmcp = new TmcpServer(info, {
			adapter: new InputSchemaAdapter(),
			capabilities: (options.capabilities ?? { tools: {} }) as never,
			instructions: options.instructions,
		})
	}

	registerTool(
		name: string,
		config: ToolConfig,
		handler: (...args: unknown[]) => unknown,
	) {
		const schema = config.inputSchema ? serviceZod.object(config.inputSchema as never) : undefined
		const outputSchema = config.outputSchema ? serviceZod.object(config.outputSchema as never) : undefined

		this.tmcp.tool(
			{
				name,
				title: config.title,
				description: config.description ?? '',
				schema,
				outputSchema,
				annotations: config.annotations,
			} as never,
			(async (input: unknown) => {
				const ctx = this.tmcp.ctx
				const extra = {
					signal: ctx.signal ?? new AbortController().signal,
					authInfo: ctx.auth,
					sessionId: ctx.sessionId,
					_meta: {},
				}

				return schema ? handler(input ?? {}, extra) : handler(extra)
			}) as never,
		)
	}

	/** Подключить любой транспорт SDK: in-memory в тестах, stdio в бою. */
	async connect(transport: Transport) {
		this.tmcp.on('send', ({ request }) => void transport.send(request as JSONRPCMessage))
		this.tmcp.on('broadcast', ({ request }) => void transport.send(request as JSONRPCMessage))

		this.tmcp.on('initialize', ({ capabilities, clientInfo }) => {
			this.#clientCapabilities = capabilities as never
			this.#clientInfo = clientInfo as never
		})

		transport.onmessage = async (message) => {
			const m = message as { method?: string; params?: Record<string, unknown> }
			const isInit = m.method === 'initialize'
			const response = await this.tmcp.receive(message as never, {
				sessionInfo: {
					clientCapabilities: (isInit ? m.params?.capabilities : this.#clientCapabilities) as never,
					clientInfo: (isInit ? m.params?.clientInfo : this.#clientInfo) as never,
				},
			})

			if (response) await transport.send(response as JSONRPCMessage)
		}

		await transport.start()
	}

	async close() {}

	isConnected() {
		return true
	}
}
