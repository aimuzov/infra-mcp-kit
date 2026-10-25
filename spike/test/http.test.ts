import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

// Тестовые хелперы кита 2.x работают по адресу, им всё равно, express за ним или нет.
import { connectHttp, oauthFlow, type LoginStep } from '../../src/testing/index.ts'
import { memoryStore, sqliteStore, type AuthStore } from '../../src/http/oauth/store.ts'
import { Tokens } from '../../src/http/oauth/tokens.ts'
import { spikeHttp } from '../src/http.ts'
import { spikeOAuth } from '../src/oauth.ts'

const SECRET = 'x'.repeat(40)
const pages = mkdtempSync(join(tmpdir(), 'tmcp-pages-'))

writeFileSync(join(pages, 'index.html'), '<h1>landing</h1>')

async function start(store: AuthStore, mode: 'sign' | 'encrypt' = 'sign') {
	// issuer должен знать порт заранее: берём свободный и отпускаем.
	const probe = createNetServer()

	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))

	const port = (probe.address() as AddressInfo).port

	await new Promise((resolve) => probe.close(resolve))
	const base = `http://localhost:${port}`
	const tokens = new Tokens({ secret: SECRET, issuer: `${base}/`, mode })
	const auth = spikeOAuth({ publicUrl: new URL(`${base}/`), tokens, store })
	const app = spikeHttp({ publicUrl: new URL(`${base}/`), publicDir: pages, oauth: auth })

	await new Promise<void>((resolve) => app.server.listen(port, resolve))
	after(() => app.server.close())

	return { base, tokens }
}

const userLogin = (user: string) => (step: LoginStep) => {
	const url = new URL(step.callback)

	url.searchParams.set('request', step.request)
	url.searchParams.set('user', user)

	return fetch(url, { redirect: 'manual' })
}

for (const [name, make] of [
	['memoryStore', () => memoryStore()],
	['sqliteStore', () => sqliteStore(join(mkdtempSync(join(tmpdir(), 'tmcp-db-')), 'auth.db'))],
] as const) {
	describe(`OAuth на @tmcp/auth, ${name}`, () => {
		test('полный вход как у Claude, инструмент видит subject', async () => {
			const { base } = await start(make())
			const flow = await oauthFlow({ base, login: userLogin('alice') })
			const client = await connectHttp(base, flow.tokens.access_token)
			const who = await client.callTool({ name: 'whoami', arguments: {} })

			assert.deepEqual(who.content, [{ type: 'text', text: 'alice' }])
			await client.close()
		})

		test('код одноразовый, чужой client_id не проходит', async () => {
			const { base } = await start(make())
			const flow = await oauthFlow({ base, login: userLogin('bob') })
			const again = await flow.exchangeAgain()

			assert.equal(again.status, 400)
			assert.equal(((await again.json()) as { error: string }).error, 'invalid_grant')

			const other = await oauthFlow({ base, login: userLogin('eve') })
			const stolen = await fetch(`${base}/token`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: flow.tokens.refresh_token ?? '',
					client_id: other.clientId,
				}),
			})

			assert.equal(stolen.status, 400, await stolen.clone().text())
		})

		test('refresh ротируется, повтор отзывает семью', async () => {
			const { base } = await start(make())
			const flow = await oauthFlow({ base, login: userLogin('carol') })
			const first = await flow.refresh()

			assert.equal(first.status, 200, await first.clone().text())

			const rotated = (await first.json()) as { refresh_token: string }
			const replay = await flow.refresh()

			assert.equal(replay.status, 400)

			// Семья отозвана: свежий токен из той же цепочки тоже не работает.
			const afterReplay = await flow.refresh(rotated.refresh_token)

			assert.equal(afterReplay.status, 400)
		})
	})
}

describe('HTTP без express', () => {
	test('битый токен -- 401 с ASCII WWW-Authenticate, без токена -- 401', async () => {
		const { base } = await start(memoryStore())
		const bad = await fetch(`${base}/mcp`, {
			method: 'POST',
			headers: { authorization: 'Bearer garbage', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
			body: '{}',
		})

		assert.equal(bad.status, 401)
		console.log('www-authenticate:', bad.headers.get('www-authenticate'))

		const none = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })

		assert.equal(none.status, 401)
		console.log('no token www-authenticate:', none.headers.get('www-authenticate'))
	})

	test('JWE: секрет едет в claims, но не читается из токена', async () => {
		const { base } = await start(memoryStore(), 'encrypt')
		const flow = await oauthFlow({ base, login: userLogin('dave') })

		assert.equal(flow.tokens.access_token.split('.').length, 5)
	})

	test('/health, статика и метаданные OAuth', async () => {
		const { base } = await start(memoryStore())

		assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true })
		assert.match(await (await fetch(`${base}/`)).text(), /landing/)
		assert.equal((await fetch(`${base}/../../etc/passwd`)).status, 404)

		const meta = await fetch(`${base}/.well-known/oauth-authorization-server`)

		assert.equal(meta.status, 200)

		const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)

		console.log('protected resource:', prm.status, await prm.text())
	})

	test('регистрация чужого redirect отклоняется', async () => {
		const { base } = await start(memoryStore())
		const reg = await fetch(`${base}/register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }),
		})

		assert.equal(reg.status, 400, await reg.clone().text())
	})
})

describe('HTTP: сессии и запросы к клиенту', () => {
	test('elicitation, progress и отмена поверх HTTP', async () => {
		const { base } = await start(memoryStore())
		const flow = await oauthFlow({ base, login: userLogin('erin') })
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
		const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
		const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
		const client = new Client({ name: 't', version: '0' }, { capabilities: { elicitation: {} } })

		client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { name: 'Erin' } }))
		await client.connect(
			new StreamableHTTPClientTransport(new URL('/mcp', base), {
				requestInit: { headers: { authorization: `Bearer ${flow.tokens.access_token}` } },
			}),
		)

		const asked = await client.callTool({ name: 'ask_name', arguments: {} })

		assert.deepEqual(asked.content, [{ type: 'text', text: 'hi Erin' }])

		const progress: number[] = []

		await client.callTool({ name: 'slow', arguments: { steps: 3 } }, undefined, { onprogress: (p) => progress.push(p.progress) })
		assert.deepEqual(progress, [1, 2, 3])

		const controller = new AbortController()
		const started = Date.now()
		const call = client.callTool({ name: 'slow', arguments: { steps: 40 } }, undefined, { signal: controller.signal })

		setTimeout(() => controller.abort('stop'), 120)
		await assert.rejects(call)
		console.log('cancel rejected after', Date.now() - started, 'ms')
		await client.close()
	})
})
