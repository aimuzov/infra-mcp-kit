/**
 * Помощники для тестов серверов на `node --test`: сервер в памяти, HTTP-приложение на случайном
 * порту и весь OAuth-танец до токена доступа.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client, type ClientOptions } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Express } from 'express'

import { signTelegramLogin } from '#kit/http/login/telegram'

/** Подпись входа как у Telegram, чтобы тест прошёл вход без виджета. */
export { signTelegramLogin }

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

/**
 * Каталог с заглушками страниц `mcpPages`: `publicDir` для тестов OAuth без сборки Astro.
 * В каждой странице только её имя, по нему тест видит, что отдал сервер.
 */
export function fakePages(dir = mkdtempSync(join(tmpdir(), 'mcp-pages-'))): string {
	for (const name of ['index', 'login', 'login/telegram', 'error', '404']) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, `${name}.html`), `<!doctype html><title>${name}</title>page:${name}\n`)
	}

	return dir
}

export const TEST_REDIRECT = 'http://127.0.0.1:33418/callback'

/**
 * Что кит положил во фрагмент статической страницы входа: то же читает её остров.
 * `callback` уже абсолютный адрес колбэка.
 */
export type LoginStep = {
	/** Адрес страницы входа без фрагмента, например `/login`. */
	page: string
	request: string
	callback: URL
	client: string
	host: string
	error: string
	dev: string
}

export type OAuthFlowOptions = {
	base: string
	/**
	 * Пройти вход, как это сделал бы человек на странице: вернуть ответ колбэка.
	 * Готовые варианты -- `submitForm`, `telegramSigned`, `devLink`.
	 */
	login(step: LoginStep): Promise<Response>
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

/** Разобрать редирект на страницу входа: путь и контекст из фрагмента. */
export function loginStep(location: string, base: string): LoginStep {
	const url = new URL(location, base)
	const hash = new URLSearchParams(url.hash.slice(1))
	const get = (key: string) => hash.get(key) ?? ''

	assert.ok(get('request'), `в адресе входа нет запроса: ${location}`)

	return {
		page: url.pathname,
		request: get('request'),
		callback: new URL(get('callback'), base),
		client: get('client'),
		host: get('host'),
		error: get('error'),
		dev: get('dev'),
	}
}

/** Вход формой токена: POST на колбэк с запросом и полями, как отправит остров. */
export function submitForm(fields: Record<string, string>) {
	return (step: LoginStep) =>
		fetch(step.callback, {
			method: 'POST',
			redirect: 'manual',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ request: step.request, ...fields }),
		})
}

/** Вход через Telegram: GET на колбэк с подписанным query, как вернёт виджет. */
export function telegramSigned(user: Record<string, string>, botToken: string) {
	return (step: LoginStep) => {
		const url = new URL(step.callback)
		const signed = signTelegramLogin({ auth_date: String(Math.floor(Date.now() / 1000)), ...user }, botToken)

		url.searchParams.set('request', step.request)

		for (const [key, value] of Object.entries(signed)) url.searchParams.set(key, value)

		return fetch(url, { redirect: 'manual' })
	}
}

/** Dev-вход Telegram на localhost: ссылка, которую страница рисует вместо виджета. */
export function devLink() {
	return (step: LoginStep) => {
		const url = new URL(step.callback)

		url.searchParams.set('request', step.request)
		url.searchParams.set('dev', '1')

		return fetch(url, { redirect: 'manual' })
	}
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
		{ redirect: 'manual' },
	)

	assert.equal(authorize.status, 302, await authorize.clone().text())

	const callback = await login(loginStep(authorize.headers.get('location') ?? '', base))

	// Отказ входа -- редирект на страницу входа или ошибки с текстом в адресе: его и показываем.
	const refused = callback.headers.get('location')

	assert.equal(
		callback.status,
		302,
		`вход не выдал код: ${callback.status} ${
			refused ? decodeURIComponent(refused.replaceAll('+', ' ')) : await callback.clone().text()
		}`,
	)

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
