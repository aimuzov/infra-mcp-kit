import { AsyncLocalStorage } from 'node:async_hooks'
import { McpServer as TmcpServer } from 'tmcp'
import { JsonSchemaAdapter } from 'tmcp/adapter'
import { z, type ZodType } from 'zod'

import { log as defaultLog, type Logger } from './log.ts'
import { causesOf, failure, messageOf } from './results.ts'
import { captureError, withTags } from './sentry.ts'

export type TextContent = { type: 'text'; text: string; _meta?: Record<string, unknown> }
export type ImageContent = { type: 'image' | 'audio'; data: string; mimeType: string; _meta?: Record<string, unknown> }
export type ResourceLink = { type: 'resource_link'; uri: string; name: string; [key: string]: unknown }
export type EmbeddedResource = {
	type: 'resource'
	resource: { uri: string; mimeType?: string; text?: string; blob?: string }
}

/** Содержимое ответа инструмента или промпта, те же варианты, что в SDK. */
export type Content = TextContent | ImageContent | ResourceLink | EmbeddedResource

export type CallToolResult = {
	content: Content[]
	structuredContent?: Record<string, unknown>
	isError?: boolean
	_meta?: Record<string, unknown>
}

export type GetPromptResult = {
	description?: string
	messages: Array<{ role: 'user' | 'assistant'; content: Content }>
}

export type ReadResourceResult = {
	contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>
}

/** Кто пришёл с токеном: `extra` -- claims входа и `subject`. */
export type AuthInfo = {
	token: string
	clientId: string
	scopes: string[]
	expiresAt?: number
	extra?: Record<string, unknown>
}

/** Второй аргумент обработчиков, как у SDK: отмена, токен и прогресс. */
export type RequestExtra = {
	signal: AbortSignal
	authInfo?: AuthInfo
	sessionId?: string
	requestId?: string | number
	_meta?: { progressToken?: string | number; [key: string]: unknown }
	/** Только `notifications/progress` и `notifications/message`: остальное сервер шлёт сам. */
	sendNotification(notification: { method: string; params?: Record<string, unknown> }): Promise<void>
}

type Shape = Record<string, ZodType>

/** Что приходит в обработчик: вход схемы, с подставленными `default`. */
type InputOf<S> = S extends ZodType ? z.output<S> : S extends Shape ? z.output<z.ZodObject<S>> : never

export type ToolConfig = {
	title?: string
	description?: string
	/** Поля входа, как в SDK, или готовый `z.object`. */
	inputSchema?: Shape | ZodType
	outputSchema?: Shape | ZodType
	annotations?: Record<string, unknown>
	_meta?: Record<string, unknown>
}

export type PromptConfig = {
	title?: string
	description?: string
	argsSchema?: Shape
}

export type ResourceMetadata = {
	title?: string
	description?: string
	mimeType?: string
}

type ResourceListing = { resources: Array<{ uri: string; name: string; [key: string]: unknown }> }

/** Шаблон ресурса, как в SDK: адрес по RFC 6570 и, по желанию, список готовых ресурсов. */
export class ResourceTemplate {
	readonly uriTemplate: string
	readonly list: (() => ResourceListing | Promise<ResourceListing>) | undefined
	readonly complete: Record<string, (value: string) => string[] | Promise<string[]>> | undefined

	constructor(
		uriTemplate: string,
		callbacks: {
			list: (() => ResourceListing | Promise<ResourceListing>) | undefined
			complete?: Record<string, (value: string) => string[] | Promise<string[]>>
		},
	) {
		this.uriTemplate = uriTemplate
		this.list = callbacks.list
		this.complete = callbacks.complete
	}
}

/** Транспорт с интерфейсом SDK: кит подключает и свой stdio, и `InMemoryTransport` в тестах. */
export type Transport = {
	start(): Promise<void>
	send(message: any, ...rest: any[]): Promise<void>
	close(): Promise<void>
	// `any`, чтобы подошёл и транспорт SDK: у него параметр уже, чем `unknown`.
	onmessage?: (message: any, ...rest: any[]) => void
	onclose?: () => void
}

export type ServerInfo = { name: string; version: string; title?: string; description?: string }

export type ServerOptions = {
	instructions?: string
	capabilities?: Record<string, unknown>
	logger?: Logger
}

type Message = {
	jsonrpc: '2.0'
	id?: string | number
	method?: string
	params?: Record<string, unknown>
	result?: unknown
	error?: unknown
}

export type ReceiveContext = {
	auth?: AuthInfo
	signal?: AbortSignal
	sessionId?: string
}

/**
 * tmcp строит JSON Schema по выходу zod, и у каждого объекта появляется
 * `additionalProperties: false`. SDK публикует вход, каким его видит клиент.
 */
class InputSchemaAdapter extends JsonSchemaAdapter<ZodType> {
	async toJsonSchema(schema: ZodType) {
		return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as never
	}
}

const toObject = (schema: Shape | ZodType) => (schema instanceof z.ZodType ? schema : z.object(schema))

/**
 * MCP-сервер с API `McpServer` из SDK поверх tmcp. Сервису хватает сменить импорт:
 * `registerTool`, `registerPrompt`, `registerResource` и `server.server` те же.
 * Под капотом -- `tmcp`, он доступен как `.tmcp` для того, чего в SDK не было.
 */
export class McpServer {
	readonly #info: ServerInfo
	readonly #instructions: string | undefined
	readonly #capabilities: Record<string, unknown>
	readonly #logger: Logger
	#tmcp: TmcpServer<any> | undefined
	#pending: Array<(tmcp: TmcpServer<any>) => void> = []
	readonly #request = new AsyncLocalStorage<{ message: Message; context: ReceiveContext }>()
	#clientCapabilities: Record<string, unknown> | undefined
	#clientInfo: Record<string, unknown> | undefined
	#transport: Transport | undefined
	#inFlight = new Map<string | number, AbortController>()
	// tmcp ставит заголовком описание, если заголовка нет, а SDK такого поля не шлёт.
	readonly #untitled = new Set<string>()

	/** То, что сервисы на SDK зовут через `server.server`. */
	readonly server = {
		getClientCapabilities: () => this.#clientCapabilities,
		getClientVersion: () => this.#clientInfo,
		elicitInput: (params: { message: string; requestedSchema: unknown }) =>
			this.tmcp.request({ method: 'elicitation/create', params: params as never }) as Promise<{
				action: 'accept' | 'decline' | 'cancel'
				content?: Record<string, unknown>
			}>,
	}

	constructor(info: ServerInfo, options: ServerOptions = {}) {
		this.#info = info
		this.#instructions = options.instructions
		this.#capabilities = { ...options.capabilities }
		this.#logger = options.logger ?? defaultLog
	}

	/**
	 * Сервер tmcp. Создаётся при первом обращении: обработчики `tools/list` и прочих он
	 * заводит по возможностям из конструктора, а их кит знает только после регистраций.
	 * Так возможности те же, что у SDK: только то, что зарегистрировано.
	 */
	get tmcp(): TmcpServer<any> {
		if (this.#tmcp) return this.#tmcp

		const tmcp = new TmcpServer(this.#info as never, {
			adapter: new InputSchemaAdapter(),
			capabilities: this.#capabilities as never,
			instructions: this.#instructions,
		})

		tmcp.on('initialize', ({ capabilities, clientInfo }) => {
			this.#clientCapabilities = capabilities as never
			this.#clientInfo = clientInfo as never
		})

		for (const apply of this.#pending) apply(tmcp)

		this.#pending = []
		this.#tmcp = tmcp

		return tmcp
	}

	#register(apply: (tmcp: TmcpServer<any>) => void) {
		if (this.#tmcp) apply(this.#tmcp)
		else this.#pending.push(apply)
	}

	registerTool<S extends Shape | ZodType>(
		name: string,
		config: ToolConfig & { inputSchema: S },
		handler: (args: InputOf<S>, extra: RequestExtra) => unknown,
	): void
	registerTool(
		name: string,
		config: ToolConfig & { inputSchema?: undefined },
		handler: (extra: RequestExtra) => unknown,
	): void
	registerTool(name: string, config: ToolConfig, handler: (...args: any[]) => unknown): void {
		this.#capabilities.tools ??= { listChanged: true }

		if (config.title === undefined) this.#untitled.add(`tool:${name}`)

		const schema = config.inputSchema ? toObject(config.inputSchema) : undefined
		const outputSchema = config.outputSchema ? toObject(config.outputSchema) : undefined

		this.#register((tmcp) =>
			tmcp.tool(
				{
					name,
					title: config.title,
					description: config.description,
					schema,
					outputSchema,
					annotations: config.annotations,
					_meta: config._meta,
				} as never,
				((input: unknown) =>
					withTags({ 'mcp.tool': name }, async () => {
						const extra = this.#extra()

						// tmcp отвечает на исключение ошибкой JSON-RPC, а модель
						// должна прочитать текст и поправиться.
						try {
							return (await (schema ? handler(input, extra) : handler(extra))) as CallToolResult
						} catch (error) {
							this.#logger.error('tool failed', {
								tool: name,
								message: messageOf(error),
								causes: causesOf(error),
							})

							captureError(error)

							return failure(error)
						}
					})) as never,
			),
		)
	}

	registerPrompt<S extends Shape>(
		name: string,
		config: PromptConfig & { argsSchema: S },
		handler: (args: InputOf<S>, extra: RequestExtra) => unknown,
	): void
	registerPrompt(
		name: string,
		config: PromptConfig & { argsSchema?: undefined },
		handler: (extra: RequestExtra) => unknown,
	): void
	registerPrompt(name: string, config: PromptConfig, handler: (...args: any[]) => unknown): void {
		this.#capabilities.prompts ??= { listChanged: true }

		if (config.title === undefined) this.#untitled.add(`prompt:${name}`)

		const schema = config.argsSchema ? z.object(config.argsSchema) : undefined

		this.#register((tmcp) =>
			tmcp.prompt(
				{ name, title: config.title, description: config.description, schema } as never,
				((input: unknown) =>
					reported(this.#logger, 'prompt', name, () => {
						const extra = this.#extra()

						return schema ? handler(input, extra) : handler(extra)
					})) as never,
			),
		)
	}

	registerResource(
		name: string,
		uri: string,
		metadata: ResourceMetadata,
		handler: (uri: URL, extra: RequestExtra) => unknown,
	): void
	registerResource(
		name: string,
		template: ResourceTemplate,
		metadata: ResourceMetadata,
		handler: (uri: URL, variables: Record<string, string | string[]>, extra: RequestExtra) => unknown,
	): void
	registerResource(
		name: string,
		uriOrTemplate: string | ResourceTemplate,
		metadata: ResourceMetadata,
		handler: (...args: any[]) => unknown,
	): void {
		this.#capabilities.resources ??= { listChanged: true }

		if (typeof uriOrTemplate === 'string') {
			this.#register((tmcp) =>
				tmcp.resource(
					{ name, uri: uriOrTemplate, ...metadata } as never,
					((uri: string) =>
						reported(this.#logger, 'resource', name, () => handler(new URL(uri), this.#extra()))) as never,
				),
			)

			return
		}

		const template = uriOrTemplate

		this.#register((tmcp) =>
			tmcp.template(
				{
					name,
					uri: template.uriTemplate,
					...metadata,
					// Как в SDK: ресурс из списка наследует заголовок, описание и тип шаблона.
					list: template.list
						? async () =>
								(await template.list!()).resources.map((resource) => ({ ...metadata, ...resource }))
						: undefined,
					complete: template.complete
						? Object.fromEntries(
								Object.entries(template.complete).map(([key, complete]) => [
									key,
									async (value: string) => ({ completion: { values: await complete(value) } }),
								]),
							)
						: undefined,
				} as never,
				((uri: string, params: Record<string, string | string[]>) =>
					reported(this.#logger, 'resource', name, () =>
						handler(new URL(uri), params, this.#extra()),
					)) as never,
			),
		)
	}

	/**
	 * Обработать одно сообщение JSON-RPC. На запрос отдаёт ответ, на уведомление и ответ
	 * клиента -- `undefined`. HTTP кита зовёт это напрямую, stdio и тесты -- через `connect`.
	 */
	async receive(message: unknown, context: ReceiveContext = {}): Promise<unknown> {
		const m = message as Message

		if (m.method === 'initialize') this.#logInitialize(m)

		// SDK проверяет вызов без `arguments` как `{}`, и ошибка называет пропущенное поле.
		if (m.method === 'tools/call' && m.params && m.params.arguments === undefined) {
			m.params = { ...m.params, arguments: {} }
		}

		const sessionInfo = {
			clientCapabilities: m.method === 'initialize' ? m.params?.capabilities : this.#clientCapabilities,
			clientInfo: m.method === 'initialize' ? m.params?.clientInfo : this.#clientInfo,
		}
		const response = await this.#request.run({ message: m, context }, () =>
			this.tmcp.receive(m as never, { ...context, sessionInfo } as never),
		)

		if (m.method === 'tools/list') return this.#dropTitles(response, 'tools', 'tool')

		if (m.method === 'prompts/list') return dropEmptyArguments(this.#dropTitles(response, 'prompts', 'prompt'))

		return response
	}

	/**
	 * Подключить транспорт с интерфейсом SDK. Отмена приходит уведомлением
	 * `notifications/cancelled`: у каждого запроса свой `AbortController`, а транспорт
	 * tmcp для stdio только выбрасывает ответ и не останавливает обработчик.
	 */
	async connect(transport: Transport): Promise<void> {
		this.#transport = transport
		this.tmcp.on('send', ({ request }) => void transport.send(request))
		this.tmcp.on('broadcast', ({ request }) => void transport.send(request))

		transport.onmessage = (raw) => {
			const message = raw as Message

			if (message.method === 'notifications/cancelled') {
				this.#inFlight.get(message.params?.requestId as string | number)?.abort(message.params?.reason)

				return
			}

			const isRequest = message.method !== undefined && message.id !== undefined
			const controller = new AbortController()

			if (isRequest) this.#inFlight.set(message.id!, controller)

			void this.receive(message, { signal: controller.signal })
				.then(async (response) => {
					// Отменённому запросу ответ не нужен: клиент уже его забыл.
					if (response && !controller.signal.aborted) await transport.send(response)
				})
				.catch((error) => {
					this.#logger.error('mcp message failed', { message: messageOf(error), causes: causesOf(error) })
					captureError(error)
				})
				.finally(() => {
					if (isRequest) this.#inFlight.delete(message.id!)
				})
		}

		await transport.start()
	}

	async close(): Promise<void> {
		for (const controller of this.#inFlight.values()) controller.abort()

		this.#inFlight.clear()
		await this.#transport?.close()
		this.#transport = undefined
	}

	isConnected(): boolean {
		return this.#transport !== undefined
	}

	#dropTitles(response: unknown, key: 'tools' | 'prompts', kind: string) {
		const items = (response as { result?: Record<string, Array<{ name: string; title?: string }>> } | undefined)
			?.result?.[key]

		for (const item of items ?? []) if (this.#untitled.has(`${kind}:${item.name}`)) delete item.title

		return response
	}

	#extra(): RequestExtra {
		const current = this.#request.getStore()
		const ctx = this.tmcp.ctx

		return {
			signal: ctx.signal ?? current?.context.signal ?? new AbortController().signal,
			authInfo: (ctx.auth as AuthInfo | undefined) ?? current?.context.auth,
			sessionId: ctx.sessionId,
			requestId: current?.message.id,
			_meta: current?.message.params?._meta as RequestExtra['_meta'],
			sendNotification: async ({ method, params = {} }) => {
				if (method === 'notifications/progress') {
					this.tmcp.progress(
						params.progress as number,
						params.total as number | undefined,
						params.message as string | undefined,
					)
				} else if (method === 'notifications/message') {
					this.tmcp.log(params.level as never, params.data, params.logger as string | undefined)
				}
			},
		}
	}

	/** На живом коннекторе видно, какую версию протокола шлёт клиент и кто он. */
	#logInitialize(message: Message) {
		const client = message.params?.clientInfo as { name?: string; version?: string } | undefined

		this.#logger.info('mcp initialize', {
			protocolVersion: message.params?.protocolVersion,
			client: client ? `${client.name}/${client.version}` : undefined,
		})
	}
}

/**
 * Ошибку промпта или ресурса tmcp сам превращает в ответ JSON-RPC: пишем её в лог,
 * как у инструмента, отправляем в Sentry и отдаём ему дальше. Текст ошибки есть
 * только в логе, в Sentry уходят тип и код.
 */
function reported(logger: Logger, kind: 'prompt' | 'resource', name: string, run: () => unknown): Promise<unknown> {
	return withTags({ [`mcp.${kind}`]: name }, async () => {
		try {
			return await run()
		} catch (error) {
			logger.error(`${kind} failed`, { [kind]: name, message: messageOf(error), causes: causesOf(error) })
			captureError(error)

			throw error
		}
	})
}

/** У промпта без аргументов tmcp пишет `arguments: []`, SDK поля не шлёт вовсе. */
function dropEmptyArguments(response: unknown) {
	const prompts = (response as { result?: { prompts?: Array<{ arguments?: unknown[] }> } } | undefined)?.result
		?.prompts

	for (const prompt of prompts ?? []) if (prompt.arguments?.length === 0) delete prompt.arguments

	return response
}
