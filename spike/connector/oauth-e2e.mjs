// OAuth-поток против собранной статики: node oauth-e2e.mjs
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const BASE = 'http://localhost:8790'
const redirect = 'http://localhost:9999/cb'
const b64 = (b) => b.toString('base64url')

const reg = await fetch(`${BASE}/register`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ client_name: 'Spike', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
}).then((r) => r.json())

const verifier = b64(randomBytes(32))
const challenge = b64(createHash('sha256').update(verifier).digest())
const auth = new URL(`${BASE}/authorize`)

for (const [k, v] of Object.entries({
	response_type: 'code',
	client_id: reg.client_id,
	redirect_uri: redirect,
	code_challenge: challenge,
	code_challenge_method: 'S256',
	state: 'xyz',
})) {
	auth.searchParams.set(k, v)
}

// 1. authorize -> статическая страница входа, контекст во фрагменте.
const a = await fetch(auth, { redirect: 'manual' })

assert.equal(a.status, 302)

const login = new URL(a.headers.get('location'), BASE)

assert.equal(login.pathname, '/login')

const hash = new URLSearchParams(login.hash.slice(1))

assert.ok(hash.get('request'))
assert.equal(hash.get('client'), 'Spike')
assert.equal(hash.get('host'), 'localhost:9999')
assert.equal((await fetch(login)).status, 200)
console.log('authorize -> /login#request ok')

const submit = (token) =>
	fetch(new URL(hash.get('callback'), BASE), {
		method: 'POST',
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ request: hash.get('request'), token }),
	})

// 2. неверный токен -> назад на /login с ошибкой во фрагменте.
const bad = await submit('bad')

assert.equal(bad.status, 303)

const back = new URL(bad.headers.get('location'), BASE)

assert.equal(back.pathname, '/login')
assert.equal(new URLSearchParams(back.hash.slice(1)).get('error'), 'Токен не подошёл')
console.log('bad token -> 303 /login#error ok')

// 3. верный токен -> код на redirect_uri.
const good = await submit('good')

assert.equal(good.status, 302)

const cb = new URL(good.headers.get('location'))

assert.equal(cb.origin + cb.pathname, redirect)
assert.equal(cb.searchParams.get('state'), 'xyz')

const code = cb.searchParams.get('code')
const tokens = await fetch(`${BASE}/token`, {
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		code_verifier: verifier,
		client_id: reg.client_id,
		redirect_uri: redirect,
	}),
}).then((r) => r.json())

assert.ok(tokens.access_token, JSON.stringify(tokens))
console.log('code -> tokens ok')

// 4. /mcp с токеном видит subject из входа.
const call = await fetch(`${BASE}/mcp`, {
	method: 'POST',
	headers: {
		authorization: `Bearer ${tokens.access_token}`,
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	},
	body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
})
const text = await call.text()

assert.match(text, /user-1/)
console.log('/mcp whoami -> user-1 ok')

// 5. код одноразовый.
const again = await fetch(`${BASE}/token`, {
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		code_verifier: verifier,
		client_id: reg.client_id,
		redirect_uri: redirect,
	}),
})

assert.equal(again.status, 400)
console.log('code reuse -> 400 ok')
