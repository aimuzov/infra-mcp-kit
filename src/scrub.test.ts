import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createLogger } from './log.ts'
import { addScrubRules, FILTERED, scrub, scrubBreadcrumb, scrubEvent } from './scrub.ts'

// Ненастоящие, но той же формы, что и настоящие.
const JWT =
	'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrYWl0ZW4tdXNlciJ9.Kq2rCmgVTpD0pXMjWj1EDx1vJmLy3tqB0V4i3x9P0nE'
const JWE =
	'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..6nT3zv0KQb2qJx9G.Zx1yWq8rT0pL3mN5vB7cX9dF2gH4jK6l.R2d4Y8wQ1eT5uI7oP3aS6d'
const KAITEN = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924'
const BOT = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2'
const HEX = 'a3f1c9e07b2d4e8f9a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d'
const OPAQUE = 'q4eC39HqLyjWDarjtT1zdp7dcXz9K2mQ8wR5n'

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
	]

	for (const text of plain) assert.equal(scrub(text), text)
})

test('scrub: медленных случаев на длинном мусоре нет', () => {
	const started = Date.now()

	for (const junk of ['a-'.repeat(20_000), '1'.repeat(40_000), '?a'.repeat(20_000), 'x='.repeat(20_000)]) scrub(junk)

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
		const object = scrubEvent({ request: { query_string: { token: 't', q: 'x' } } })
		const pairs = scrubEvent({ request: { query_string: [['token', 't']] } })

		assert.deepEqual(object.request.query_string, { token: FILTERED, q: FILTERED })
		assert.deepEqual(pairs.request.query_string, [['token', FILTERED]])
	})
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
