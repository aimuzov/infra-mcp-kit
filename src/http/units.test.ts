import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

import { isAllowedRedirectUri, loadHttpConfig } from './config.ts'
import { signTelegramLogin, verifyTelegramLogin } from './login/telegram.ts'
import { CODE_TTL_MS, memoryStore, sqliteStore, type PendingCode } from './oauth/store.ts'
import { Tokens } from './oauth/tokens.ts'
import { consentPage, document, escapeHtml, failPage, html, landingPage, raw, tokenFormPage } from './ui/index.ts'

const SECRET = 'x'.repeat(32)
const service = { name: 'test', repo: 'https://github.com/aimuzov/test' }

test('redirect: колбэки Claude, loopback по http и дополнительные из конфига', () => {
	assert.ok(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback'))
	assert.ok(isAllowedRedirectUri('http://127.0.0.1:5555/cb'))
	assert.ok(isAllowedRedirectUri('http://[::1]:5555/cb'))
	assert.ok(isAllowedRedirectUri('http://localhost/cb'))
	assert.ok(!isAllowedRedirectUri('https://localhost/cb'))
	assert.ok(!isAllowedRedirectUri('https://evil.example/cb'))
	assert.ok(!isAllowedRedirectUri('not a url'))
	assert.ok(isAllowedRedirectUri('https://my.app/cb', ['https://my.app/cb']))
	// Дополнительный список расширяет, а не заменяет колбэки Claude.
	assert.ok(isAllowedRedirectUri('https://claude.com/api/mcp/auth_callback', ['https://my.app/cb']))
})

test('конфиг: короткий секрет и отсутствие адреса не пускают сервер', () => {
	assert.throws(() => loadHttpConfig({ AUTH_SECRET: 'short', PUBLIC_URL: 'https://a.b' }), /AUTH_SECRET/)
	assert.throws(() => loadHttpConfig({ AUTH_SECRET: SECRET }), /PUBLIC_URL/)
	assert.equal(loadHttpConfig({ AUTH_SECRET: SECRET, PUBLIC_URL: 'https://a.b' }).port, 8080)
})

for (const mode of ['sign', 'encrypt'] as const) {
	test(`токены (${mode}): kind не подменить, чужой ключ и издатель не проходят`, async () => {
		const tokens = new Tokens({ secret: SECRET, issuer: 'https://a.b/', mode })
		const access = await tokens.sign('access', { sub: 'u1', secret: 'kaiten-token' })

		assert.equal((await tokens.verify('access', access))?.sub, 'u1')
		assert.equal(await tokens.verify('refresh', access), null)

		assert.equal(
			await new Tokens({ secret: 'y'.repeat(32), issuer: 'https://a.b/', mode }).verify('access', access),
			null,
		)

		assert.equal(await new Tokens({ secret: SECRET, issuer: 'https://c.d/', mode }).verify('access', access), null)
		assert.equal(await tokens.verify('access', 'garbage'), null)

		// В режиме encrypt claims не прочитать без ключа.
		const readable = access
			.split('.')
			.some((part) => Buffer.from(part, 'base64url').toString().includes('kaiten-token'))

		assert.equal(readable, mode === 'sign')
	})
}

test('токены: просроченный не проходит', async () => {
	const tokens = new Tokens({ secret: SECRET, issuer: 'i', ttl: { access: -1 } })

	assert.equal(await tokens.verify('access', await tokens.sign('access', { sub: 'u' })), null)
})

const client = { client_id: 'c1', redirect_uris: ['http://127.0.0.1/cb'] } as OAuthClientInformationFull
const pending: PendingCode = { clientId: 'c1', codeChallenge: 'ch', redirectUri: 'http://127.0.0.1/cb', grant: 'g' }

for (const [name, make] of [
	['memory', () => memoryStore()],
	['sqlite', () => sqliteStore(join(mkdtempSync(join(tmpdir(), 'kit-store-')), 'auth.db'))],
] as const) {
	test(`хранилище ${name}: код тратится ровно один раз и истекает`, () => {
		const store = make()

		store.saveClient(client)
		assert.deepEqual(store.getClient('c1'), client)
		assert.equal(store.getClient('nope'), undefined)

		const code = store.issueCode(pending)

		assert.deepEqual(store.peekCode(code), pending)
		assert.deepEqual(store.takeCode(code), pending)
		assert.equal(store.takeCode(code), undefined)

		const old = store.issueCode(pending, 0)

		assert.equal(store.peekCode(old, CODE_TTL_MS + 1), undefined)
		store.close?.()
	})
}

const BOT = '123:bot'
const now = Date.now()
const signed = (fields: Record<string, string> = {}) =>
	signTelegramLogin({ id: '42', first_name: 'Ivan', auth_date: String(Math.floor(now / 1000)), ...fields }, BOT)

test('telegram: подпись, свежесть и чужие поля', () => {
	assert.deepEqual(verifyTelegramLogin(signed(), BOT, now), { id: '42', firstName: 'Ivan', username: '' })
	assert.equal(verifyTelegramLogin(signed(), 'other', now), null)
	assert.equal(verifyTelegramLogin({ ...signed(), first_name: 'Eve' }, BOT, now), null)
	assert.equal(verifyTelegramLogin(signed(), BOT, now + 11 * 60_000), null)
	// Наши параметры в auth URL подписью не покрыты и проверке не мешают.
	assert.ok(verifyTelegramLogin({ ...signed(), request: 'x' }, BOT, now))
})

test('html экранирует строки и пропускает SafeHtml, массивы и пустые условия', () => {
	const evil = '<script>"x"</script>'

	assert.equal(escapeHtml(evil), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;')

	assert.equal(
		html`<p title="${evil}">${[raw('<b>'), 'a&b', null, false, undefined]}</p>`.value,
		'<p title="&lt;script&gt;&quot;x&quot;&lt;/script&gt;"><b>a&amp;b</p>',
	)
})

test('страницы кита: экранируют ввод, без инлайн-скриптов и стилей под CSP', () => {
	const evil = '<img src=x onerror=alert(1)>'
	const pages = [
		document({ service, title: evil, main: evil }),
		landingPage({ service, tagline: evil, mcpUrl: 'https://a.b/mcp', tools: [evil] }),
		consentPage({ service, client: { name: evil, host: 'claude.ai' }, grants: [evil], action: '', error: evil }),
		tokenFormPage({
			service,
			client: { host: 'claude.ai' },
			title: evil,
			action: '/authorize/callback',
			fields: [{ name: 'token', label: evil, value: evil }],
			hidden: { request: evil },
		}),
		failPage({ service, title: evil, message: evil, code: evil }),
	]

	for (const page of pages) {
		assert.ok(!page.includes(evil), 'ввод попал в разметку как есть')
		assert.ok(page.startsWith('<!doctype html>'))
		assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)/, 'инлайн-скрипт')
		assert.doesNotMatch(page, /\sstyle=|<style/, 'инлайн-стиль')
		assert.match(page, /aimuzov\/test/)
	}
})
