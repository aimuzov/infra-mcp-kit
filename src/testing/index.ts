/**
 * Помощники для тестов серверов на `node --test`: сервер в памяти, HTTP-приложение на случайном
 * порту и весь OAuth-танец до токена доступа.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client, type ClientOptions } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Express } from 'express'

/** Подпись входа как у Telegram: в `/http` она останется до 2.0 ради совместимости. */
export { signTelegramLogin } from '#kit/http/login/telegram'

/**
 * Клиент, подключённый к серверу через пару транспортов в памяти. Во втором
 * аргументе возможности клиента, например `{ capabilities: { elicitation: {} } }`
 * для тестов запросов к человеку.
 */
export async function connectInMemory(server: McpServer, options?: ClientOptions): Promise<Client> {
	const client = new Client({ name: 'test', version: '0.0.0' }, options)
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

	return client
}

/** Сервер отдаёт ровно эти инструменты: при переезде на кит ничего не потерялось и не прибавилось. */
export async function expectTools(client: Client, names: string[]): Promise<void> {
	const { tools } = await client.listTools()

	assert.deepEqual(tools.map((t) => t.name).sort(), [...names].sort())
}

/** Текст ответа инструмента одной строкой. */
export function textOf(result: unknown): string {
	return ((result as CallToolResult).content ?? [])
		.filter((c) => c.type === 'text')
		.map((c) => (c as { text: string }).text)
		.join('\n')
}

export type RunningHttp = {
	base: string
	server: Server
	close(): Promise<void>
}

/**
 * Слушать случайный порт на 127.0.0.1. Приложение собирается после `listen`: ему нужен
 * публичный адрес, а порт известен только теперь.
 */
export async function startHttp(build: (base: string) => Express | Promise<Express>): Promise<RunningHttp> {
	const server = createServer()

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

	server.on('request', await build(base))

	return {
		base,
		server,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

export const TEST_REDIRECT = 'http://127.0.0.1:33418/callback'

export type OAuthFlowOptions = {
	base: string
	/**
	 * Пройти вход: по HTML страницы входа и адресу колбэка вернуть ответ колбэка.
	 * Обычно это `fetch` с `redirect: 'manual'`.
	 */
	login(page: string, callbackUrl: URL): Promise<Response>
	redirectUri?: string
}

export type OAuthFlowResult = {
	clientId: string
	code: string
	verifier: string
	tokens: { access_token: string; refresh_token?: string; expires_in?: number }
	/** Обменять код ещё раз, чтобы проверить его одноразовость. */
	exchangeAgain(): Promise<Response>
	/** Обновить токены refresh-токеном, по умолчанию выданным при входе. */
	refresh(refreshToken?: string): Promise<Response>
}

/** Достать адрес колбэка со страницы входа: из виджета Telegram, ссылки или формы. */
export function callbackFrom(page: string, base: string): URL {
	const match = page.match(/data-auth-url="([^"]+)"/) ?? page.match(/href="([^"]*\/authorize\/callback[^"]*)"/)

	if (match?.[1]) return new URL(match[1].replaceAll('&amp;', '&'), base)

	const form = page.match(/<form[^>]*action="([^"]+)"/)

	assert.ok(form?.[1], 'на странице входа нет ни виджета, ни формы')

	return new URL(form[1].replaceAll('&amp;', '&'), base)
}

/** Значение скрытого поля формы. */
export function hiddenField(page: string, name: string): string {
	const match = page.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))

	assert.ok(match?.[1], `на странице нет поля ${name}`)

	return match[1].replaceAll('&amp;', '&')
}

/** Регистрация клиента, authorize, вход, колбэк и обмен кода на токены, как это делает Claude. */
export async function oauthFlow({
	base,
	login,
	redirectUri = TEST_REDIRECT,
}: OAuthFlowOptions): Promise<OAuthFlowResult> {
	const registered = await fetch(`${base}/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client_name: 'test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
	})

	assert.equal(registered.status, 201, await registered.clone().text())

	const { client_id: clientId } = (await registered.json()) as { client_id: string }
	const verifier = randomBytes(32).toString('base64url')
	const challenge = createHash('sha256').update(verifier).digest('base64url')
	const authorize = await fetch(
		`${base}/authorize?${new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: redirectUri,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state: 'st',
		})}`,
	)

	assert.equal(authorize.status, 200)

	const page = await authorize.text()
	const callback = await login(page, callbackFrom(page, base))

	assert.equal(callback.status, 302, await callback.clone().text())

	const location = new URL(callback.headers.get('location') ?? '')

	assert.equal(location.searchParams.get('state'), 'st')

	const code = location.searchParams.get('code') ?? ''
	const exchange = () =>
		fetch(`${base}/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				code_verifier: verifier,
				client_id: clientId,
				redirect_uri: redirectUri,
			}),
		})
	const token = await exchange()

	assert.equal(token.status, 200, await token.clone().text())

	const tokens = (await token.json()) as OAuthFlowResult['tokens']

	return {
		clientId,
		code,
		verifier,
		tokens,
		exchangeAgain: exchange,
		refresh: (refreshToken = tokens.refresh_token ?? '') =>
			fetch(`${base}/token`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
					client_id: clientId,
				}),
			}),
	}
}

/** MCP-клиент к `/mcp` с токеном доступа. */
export async function connectHttp(base: string, accessToken?: string): Promise<Client> {
	const client = new Client({ name: 'test', version: '0.0.0' })
	const headers: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {}

	await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers } }))

	return client
}
