import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { inspect } from 'node:util'

import { createLogger } from './log.ts'
import { addScrubRules, FILTERED, scrub, scrubBreadcrumb, scrubEvent, scrubSpan, scrubValue } from './scrub.ts'

// Ненастоящие, но той же формы, что и настоящие.
const JWT =
	'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrYWl0ZW4tdXNlciJ9.Kq2rCmgVTpD0pXMjWj1EDx1vJmLy3tqB0V4i3x9P0nE'
const JWE =
	'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..6nT3zv0KQb2qJx9G.Zx1yWq8rT0pL3mN5vB7cX9dF2gH4jK6l.R2d4Y8wQ1eT5uI7oP3aS6d'
const KAITEN = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924'
const BOT = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2'
const HEX = 'a3f1c9e07b2d4e8f9a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d'
const OPAQUE = 'q4eC39HqLyjWDarjtT1zdp7dcXz9K2mQ8wR5n'
const LETTERS = 'qLyjWDarjtTdpdcXzKmQwRnBvCxZaSdF'

describe('scrub: каждый класс секрета', () => {
	const cases: Array<[string, string, string]> = [
		['JWT', `token rejected: ${JWT}`, `token rejected: ${FILTERED}`],
		['JWE с пустым ключом', `cannot decrypt ${JWE}.`, `cannot decrypt ${FILTERED}.`],
		['Bearer', `Kaiten said 401 for Bearer ${KAITEN}`, `Kaiten said 401 for Bearer ${FILTERED}`],
		['Basic', 'proxy refused Basic dXNlcjpwYXNzd29yZA==', `proxy refused Basic ${FILTERED}`],
		[
			'заголовок Authorization',
			'headers: {"Authorization":"Bearer abc","Accept":"*/*"}',
			`headers: {"Authorization":"${FILTERED}","Accept":"*/*"}`,
		],
		['Cookie целиком', 'Cookie: mcp_session=abc; theme=dark', `Cookie: ${FILTERED}`],
		['API-токен Kaiten (UUID)', `token ${KAITEN} is not valid`, `token ${FILTERED} is not valid`],
		['длинный hex', `key ${HEX} expired`, `key ${FILTERED} expired`],
		['длинный base64url', `secret ${OPAQUE} leaked`, `secret ${FILTERED} leaked`],
		[
			'токен бота Telegram',
			`GET https://api.telegram.org/bot${BOT}/getMe failed`,
			`GET https://api.telegram.org/bot${FILTERED}/getMe failed`,
		],
		[
			'значения query',
			'GET https://kaiten.example/api/cards?token=t0p&code=xyz&state=st&q=поиск',
			`GET https://kaiten.example/api/cards?token=${FILTERED}&code=${FILTERED}&state=${FILTERED}&q=${FILTERED}`,
		],
		[
			'фрагмент адреса',
			'back to /cb#access_token=abc&expires_in=3600',
			`back to /cb#access_token=${FILTERED}&expires_in=${FILTERED}`,
		],
		[
			'userinfo в адресе',
			'connect https://bot:hunter2@kaiten.example/api failed',
			`connect https://${FILTERED}@kaiten.example/api failed`,
		],
		[
			'тело формы входа',
			'body was request=r1&token=t0p&host=k.example',
			`body was request=${FILTERED}&token=${FILTERED}&host=${FILTERED}`,
		],
		[
			'ключ-секрет в JSON',
			'{"client_secret": "s3cr3t", "name": "x"}',
			`{"client_secret": "${FILTERED}", "name": "x"}`,
		],
		[
			'значение в кавычках с пробелом и запятой',
			`{"password": "correct horse, battery", 'api_key': 'a b'}`,
			`{"password": "${FILTERED}", 'api_key': '${FILTERED}'}`,
		],
		['переменная окружения', 'KAITEN_API_TOKEN=abc is set twice', `KAITEN_API_TOKEN=${FILTERED} is set twice`],
		['пароль-слово после двоеточия', 'password: swordfish', `password: ${FILTERED}`],
		['пароль-слово с заглавной', 'login as bob, password: Swordfish', `login as bob, password: ${FILTERED}`],
		['токен из букв', 'token: Secretvalue', `token: ${FILTERED}`],
		['длинная строка из одних букв', `secret ${LETTERS} leaked`, `secret ${FILTERED} leaked`],
		[
			'заголовок с новой строки',
			'upstream rejected request\nCookie: sid=s3ss10n; theme=dark',
			`upstream rejected request\nCookie: ${FILTERED}`,
		],
		[
			'Authorization с новой строки, короткий токен',
			'upstream rejected request\nAuthorization: Token abc123',
			`upstream rejected request\nAuthorization: ${FILTERED}`,
		],
		['Basic с новой строки', 'upstream rejected\nBasic dXNlcjpwYXNz', `upstream rejected\nBasic ${FILTERED}`],
		[
			'Digest с кавычками внутри',
			'proxy-authorization: Digest username="bob", response="6629fae4"',
			`proxy-authorization: ${FILTERED}`,
		],
		[
			'короткие ключи в JSON',
			'{"client_secret":"s3cr3t","api_key":"k-42","token":"short1"}',
			`{"client_secret":"${FILTERED}","api_key":"${FILTERED}","token":"${FILTERED}"}`,
		],
		['Authorization в JSON', '{"Authorization": "Token abc123"}', `{"Authorization": "${FILTERED}"}`],
		[
			'массив set-cookie',
			'response headers: {"set-cookie":["sid=s3ss10n; Path=/; HttpOnly", "theme=dark"]}',
			`response headers: {"set-cookie":${FILTERED}}`,
		],
		['массив authorization', '{"authorization":["Token abc123"]}', `{"authorization":${FILTERED}}`],
		[
			'пары заголовков',
			"[['authorization', 'Token abc123'], ['cookie', 'sid=s3ss10n']]",
			`[['authorization', '${FILTERED}'], ['cookie', '${FILTERED}']]`,
		],
		[
			'Map из util.inspect',
			"Map(3) { 'authorization' => 'Token abc123', 'cookie' => 'sid=s3ss10n', 'password' => 'hunter2' }",
			`Map(3) { 'authorization' => '${FILTERED}', 'cookie' => '${FILTERED}', 'password' => '${FILTERED}' }`,
		],
		[
			'JSON строкой внутри JSON',
			'{"error":"{\\"password\\":\\"correct horse\\"}"}',
			`{"error":"{\\"password\\":\\"${FILTERED}\\"}"}`,
		],
		[
			'экранированный перевод строки перед заголовком',
			'{"message":"denied\\nCookie: sid=s3ss10n"}',
			`{"message":"denied\\nCookie: ${FILTERED}`,
		],
	]

	for (const [name, input, expected] of cases) {
		test(name, () => assert.equal(scrub(input), expected))
	}

	test('повторная чистка ничего не меняет', () => {
		for (const [, input] of cases) assert.equal(scrub(scrub(input)), scrub(input))
	})
})

test('scrub: обычный текст не портится', () => {
	const plain = [
		'Kaiten API returned 404 for card 123456',
		'Unknown command: sync',
		'Invalid token: expired',
		'Missing Authorization header',
		'Bearer token is required',
		'password: required',
		'rate limit exceeded, retry in 30s',
		'GET https://kaiten.example/api/latest/cards/42/comments failed: 502 Bad Gateway',
		'connect ECONNREFUSED 127.0.0.1:443',
		'Токен не подошёл: проверьте адрес Kaiten',
		'/Users/aimuzov/Projects/aimuzov/infra-mcp-kit/src/http/oauth/router.ts:290:17',
		'release-please--branches--main--components--infra-mcp-kit',
		'at 2026-10-28T02:16:00.000Z, status code: 500',
		'Invalid token: expired.',
		'{"password": null, "token": false}',
		// Имена из SDK длиннее 32 символов: длинная строка, но из слов.
		"Cannot read properties of undefined (reading 'getOAuthProtectedResourceMetadataUrl')",
		'client.registerToolWithStructuredOutputSchema is not a function',
		'WebStandardStreamableHTTPServerTransport.handleRequest failed',
		'Request exceeds max_tokens=4096, "input_tokens": 12',
		'WWW-Authenticate: Bearer realm="mcp", error="invalid_token"',
		'WWW-Authenticate: Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
	]

	for (const text of plain) assert.equal(scrub(text), text)
})

test('scrub: заголовки из util.inspect, в том числе в несколько строк', () => {
	const headers = {
		'set-cookie': ['sid=s3ss10n; Path=/; HttpOnly; SameSite=Lax', 'theme=dark; Path=/; Max-Age=31536000'],
		authorization: 'Token abc123',
		accept: 'application/json',
	}
	const text = scrub(`upstream 401, headers: ${inspect(headers)}`)

	assert.ok(!/s3ss10n|theme=dark|abc123/.test(text), text)
	assert.match(text, /accept: 'application\/json'/)
})

test('scrub: медленных случаев на длинном мусоре нет', () => {
	const started = Date.now()

	const junks = [
		'a-'.repeat(20_000),
		'1'.repeat(40_000),
		'?a'.repeat(20_000),
		'x='.repeat(20_000),
		'token-'.repeat(7_000),
		'token="x '.repeat(5_000),
		`cookie: [${"'a'  ".repeat(8_000)}`,
		"'cookie', ".repeat(8_000),
		"'token' => ".repeat(8_000),
		'\\"token\\":\\"'.repeat(5_000),
		'Bearer '.repeat(8_000),
		'Ab'.repeat(20_000),
	]

	for (const junk of junks) scrub(junk)

	assert.ok(Date.now() - started < 1000, `${Date.now() - started} мс`)
})

test('addScrubRules: регулярка, точное значение и функция', () => {
	addScrubRules(/kt_[a-z]+/, 'my-env-secret', '', (text) => text.replaceAll('Иван', 'И.'))

	assert.equal(scrub('kt_abc and kt_def'), `${FILTERED} and ${FILTERED}`)
	assert.equal(scrub('value my-env-secret leaked'), `value ${FILTERED} leaked`)
	assert.equal(scrub('Иван вошёл'), 'И. вошёл')
	// Пустое значение не правило: иначе `[Filtered]` встал бы между всеми символами.
	assert.equal(scrub('ok'), 'ok')
})

describe('scrubEvent', () => {
	test('чистит текст исключений, сообщение, extra, contexts, теги, запрос, крошки и спаны', () => {
		const shared = { url: `https://kaiten.example/api?token=${KAITEN}`, 'url.query': 'token=x&q=1' }
		const event = scrubEvent({
			event_id: 'a'.repeat(32),
			message: `failed with Bearer ${KAITEN}`,
			logentry: { message: 'login %s', params: [JWT] },
			exception: {
				values: [
					{
						type: 'Error',
						value: `401 at https://kaiten.example/api?token=${KAITEN}`,
						mechanism: { type: 'generic', data: { token: 'x' } },
						stacktrace: {
							frames: [
								{ filename: 'a.ts', lineno: 3, vars: { apiToken: KAITEN, n: 1 } },
								{ filename: 'https://evil.example/x.js?token=t', abs_path: `/srv/${JWT}.js` },
							],
						},
					},
				],
			},
			request: {
				method: 'POST',
				url: 'https://u:p@mcp.example/authorize/callback?request=r1',
				query_string: 'request=r1&dev=1',
				cookies: { mcp_session: 's' },
				headers: { Authorization: `Bearer ${KAITEN}`, Cookie: 'a=b', 'X-Api-Key': 'k', Accept: 'text/html' },
				data: `request=r1&token=${KAITEN}`,
			},
			breadcrumbs: [{ category: 'fetch', message: `GET ${shared.url}`, data: shared }],
			extra: { body: { token: KAITEN }, note: `bot ${BOT}` },
			contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) }, upstream: { reply: JWT } },
			tags: { 'http.path': '/authorize/callback', hint: `?code=${KAITEN}` },
			transaction: 'GET /cb?code=abc',
			spans: [{ description: `GET ${shared.url}`, data: { 'http.query': 'token=x' } }],
		})

		assert.equal(event.event_id, 'a'.repeat(32))
		assert.equal(event.message, `failed with Bearer ${FILTERED}`)
		assert.deepEqual(event.logentry, { message: 'login %s', params: [FILTERED] })
		assert.equal(event.exception.values[0]?.value, `401 at https://kaiten.example/api?token=${FILTERED}`)
		assert.deepEqual(event.exception.values[0]?.mechanism, { type: 'generic', data: { token: FILTERED } })

		assert.deepEqual(event.exception.values[0]?.stacktrace.frames, [
			{ filename: 'a.ts', lineno: 3, vars: { apiToken: FILTERED, n: 1 } },
			{ filename: `https://evil.example/x.js?token=${FILTERED}`, abs_path: `/srv/${FILTERED}` },
		])

		assert.deepEqual(event.request, {
			method: 'POST',
			url: `https://${FILTERED}@mcp.example/authorize/callback?request=${FILTERED}`,
			query_string: `request=${FILTERED}&dev=${FILTERED}`,
			cookies: FILTERED,
			headers: { Authorization: FILTERED, Cookie: FILTERED, 'X-Api-Key': FILTERED, Accept: 'text/html' },
			data: FILTERED,
		})

		assert.deepEqual(event.breadcrumbs[0], {
			category: 'fetch',
			message: `GET https://kaiten.example/api?token=${FILTERED}`,
			data: {
				url: `https://kaiten.example/api?token=${FILTERED}`,
				'url.query': `token=${FILTERED}&q=${FILTERED}`,
			},
		})

		assert.deepEqual(event.extra, { body: { token: FILTERED }, note: `bot ${FILTERED}` })

		assert.deepEqual(event.contexts, {
			trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) },
			upstream: { reply: FILTERED },
		})

		assert.deepEqual(event.tags, { 'http.path': '/authorize/callback', hint: `?code=${FILTERED}` })
		assert.equal(event.transaction, `GET /cb?code=${FILTERED}`)

		assert.deepEqual(event.spans[0], {
			description: `GET https://kaiten.example/api?token=${FILTERED}`,
			data: { 'http.query': `token=${FILTERED}` },
		})

		// Объекты из scope SDK делит между событиями: их кит не меняет, а заменяет копиями.
		assert.equal(shared.url, `https://kaiten.example/api?token=${KAITEN}`)
	})

	test('хлебная крошка возвращается копией', () => {
		const crumb = { message: `Authorization: Bearer ${KAITEN}`, data: { url: '/x?token=1' } }

		assert.deepEqual(scrubBreadcrumb(crumb), {
			message: `Authorization: ${FILTERED}`,
			data: { url: `/x?token=${FILTERED}` },
		})

		assert.equal(crumb.data.url, '/x?token=1')
	})

	test('до нормализации: цикл и глубокая вложенность не вешают чистку и не протекают', () => {
		const loop: Record<string, unknown> = { note: `token=${KAITEN}` }

		loop.self = loop

		const { extra } = scrubEvent({
			extra: { loop, 'http.request.header.authorization': `Bearer ${KAITEN}` },
		})

		assert.ok(!JSON.stringify(extra).includes(KAITEN))
		assert.equal((extra as Record<string, unknown>)['http.request.header.authorization'], FILTERED)
	})

	test('query запроса объектом или парами теряет значения, имена остаются', () => {
		const object = scrubEvent({ request: { query_string: { token: 't', q: 'x', [JWT]: '' } } })
		const pairs = scrubEvent({
			request: {
				query_string: [
					['token', 't'],
					[JWT, ''],
				],
			},
		})

		assert.deepEqual(object.request.query_string, { token: FILTERED, q: FILTERED, [FILTERED]: FILTERED })

		assert.deepEqual(pairs.request.query_string, [
			['token', FILTERED],
			[FILTERED, FILTERED],
		])
	})

	test('query и фрагмент в полях события: голое значение, правила сервиса и хвост после `;`', () => {
		addScrubRules('kt_SERVICE_SECRET')

		const event = scrubEvent({
			request: { url: `https://srv.example/magic?${JWT}`, query_string: JWT },
			breadcrumbs: [{ category: 'http', data: { 'http.query': `?${JWT}`, 'http.fragment': `#${KAITEN}` } }],
			contexts: { trace: { data: { 'url.query': 'state=a;tail', 'http.query': '?kt_SERVICE_SECRET&debug' } } },
			extra: { query: `user search: Bearer ${JWT}` },
		})

		assert.deepEqual(event.request, { url: `https://srv.example/magic?${FILTERED}`, query_string: FILTERED })
		assert.deepEqual(event.breadcrumbs[0]?.data, { 'http.query': `?${FILTERED}`, 'http.fragment': `#${FILTERED}` })

		assert.deepEqual(event.contexts.trace.data, {
			'url.query': `state=${FILTERED};${FILTERED}`,
			'http.query': `?${FILTERED}&${FILTERED}`,
		})

		assert.deepEqual(event.extra, { query: FILTERED })
	})

	test('кадры из строк текста ошибки: секрет не уходит ни в одно поле кадра', () => {
		const event = scrubEvent({
			exception: {
				values: [
					{
						value: `upstream 401\nsession issued at ${JWT} (expired)`,
						stacktrace: {
							frames: [
								{ function: JWT, filename: 'expired', in_app: false },
								{ function: `Bearer ${KAITEN}`, module: `bot${BOT}`, filename: 'rotate', lineno: 1 },
								{
									function: 'Object.registerToolWithStructuredOutputSchema',
									context_line: `token=${KAITEN}`,
									pre_context: [`const key = '${HEX}'`],
								},
							],
						},
					},
				],
			},
		})

		assert.deepEqual(event.exception.values[0]?.stacktrace.frames, [
			{ function: FILTERED, filename: 'expired', in_app: false },
			{ function: `Bearer ${FILTERED}`, module: `bot${FILTERED}`, filename: 'rotate', lineno: 1 },
			{
				function: 'Object.registerToolWithStructuredOutputSchema',
				context_line: `token=${FILTERED}`,
				pre_context: [`const key = '${FILTERED}'`],
			},
		])
	})

	test('число под секретным ключом тоже секрет, а счётчик токенов, флаг и null нет', () => {
		const { extra, breadcrumbs } = scrubEvent({
			extra: {
				password: 123456,
				session_id: 42,
				token: 9876543210n,
				hasToken: true,
				password_hint: null,
				input_tokens: 12,
				usage: { 'gen_ai.usage.output_tokens': 7 },
			},
			breadcrumbs: [{ category: 'console', data: { arguments: [{ password: 271828 }] } }],
		})

		assert.deepEqual(extra, {
			password: FILTERED,
			session_id: FILTERED,
			token: FILTERED,
			hasToken: true,
			password_hint: null,
			input_tokens: 12,
			usage: { 'gen_ai.usage.output_tokens': 7 },
		})

		assert.deepEqual(breadcrumbs, [{ category: 'console', data: { arguments: [{ password: FILTERED }] } }])
	})
})

test('scrubSpan: спан SDK 11 и спан внутри транзакции', () => {
	const ids = { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) }
	const span = {
		...ids,
		name: 'GET /callback?code=abc',
		is_segment: true,
		attributes: {
			'url.full': `https://kaiten.example/api?token=${KAITEN}`,
			'url.query': `?${JWT}`,
			'http.request.header.authorization': 'Token abc123',
			'gen_ai.usage.input_tokens': 12,
			'sentry.op': 'http.client',
		},
		links: [{ ...ids, attributes: { note: `Bearer ${KAITEN}` } }],
	}

	assert.deepEqual(scrubSpan(span), {
		...ids,
		name: `GET /callback?code=${FILTERED}`,
		is_segment: true,
		attributes: {
			'url.full': `https://kaiten.example/api?token=${FILTERED}`,
			'url.query': `?${FILTERED}`,
			'http.request.header.authorization': FILTERED,
			'gen_ai.usage.input_tokens': 12,
			'sentry.op': 'http.client',
		},
		links: [{ ...ids, attributes: { note: `Bearer ${FILTERED}` } }],
	})

	assert.equal(span.attributes['url.query'], `?${JWT}`, 'спан не меняется, возвращается копия')

	assert.deepEqual(scrubSpan({ description: 'GET /x?token=1', data: { password: 1 } }), {
		description: `GET /x?token=${FILTERED}`,
		data: { password: FILTERED },
	})
})

test('scrubValue: копия без секретов для своего логгера', () => {
	assert.deepEqual(scrubValue({ message: 'upstream: {"token":"short1"}', nested: [{ cookie: 'a=b' }] }), {
		message: `upstream: {"token":"${FILTERED}"}`,
		nested: [{ cookie: FILTERED }],
	})
})

test('лог: текст ошибки апстрима в meta чистится до сериализации в JSON', () => {
	const lines: string[] = []
	const logger = createLogger({ write: (line) => lines.push(line) })
	const upstream = [
		'auth API 500: {"login":"bob","password":"correct horse, battery"}',
		'upstream 400: {"client_secret":"s3cr3t","api_key":"k-42"}',
		'kaiten 401: {"Authorization": "Token abc123"}',
		'{"token":"short1"}',
		'upstream rejected request\nCookie: sid=s3ss10n; theme=dark',
		'upstream rejected request\nBasic dXNlcjpwYXNz',
	]

	for (const message of upstream) logger.error('login failed', { message, at: new Date(0) })

	assert.equal(lines.length, upstream.length)

	for (const line of lines) {
		assert.ok(!/correct horse|s3cr3t|k-42|abc123|short1|s3ss10n|dXNlcjpwYXNz/.test(line), line)
		// `Date` в логе строкой, как без чистки.
		assert.match(line, /"at":"1970-01-01T00:00:00\.000Z"\}\n$/)
	}

	assert.match(lines[0]!, /\{"message":"auth API 500: \{\\"login\\":\\"bob\\",\\"password\\":\\"\[Filtered\]\\"\}"/)
})

test('лог: meta, которая не превращается в JSON', () => {
	const lines: string[] = []
	const logger = createLogger({ write: (line) => lines.push(line) })
	const loop: Record<string, unknown> = {}

	loop.self = loop
	logger.info('loop', loop)
	logger.info('fn', () => 1)
	logger.info('text', 'token=abc')

	assert.deepEqual(
		lines.map((line) => line.replace(/^\S+ /, '')),
		['INFO loop [object Object]\n', 'INFO fn undefined\n', 'INFO text "token=[Filtered]"\n'],
	)
})

test('лог в stderr не пишет секреты', () => {
	const lines: string[] = []
	const logger = createLogger({ write: (line) => lines.push(line) })

	logger.error(`login failed for ${JWT}`, { message: `Kaiten 401: Bearer ${KAITEN}`, tool: 'search' })

	assert.equal(lines.length, 1)
	assert.ok(!lines[0]!.includes(JWT) && !lines[0]!.includes(KAITEN), lines[0]!)

	assert.match(
		lines[0]!,
		/ERROR login failed for \[Filtered\] \{"message":"Kaiten 401: Bearer \[Filtered\]","tool":"search"\}/,
	)
})
