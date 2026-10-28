import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Event, EventHint } from '@sentry/core'

import { strictCopy, strictError, strictEvent } from './sentry-event.ts'

// Подложенный секрет: API-токен в виде UUID.
const PLANTED = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924'
const HOME = homedir()

/** Ошибка с заданным стеком: заголовок совпадает с `String(error)`, как у V8. */
function withStack(frames: string[], message = 'boom') {
	const error = new Error(message)

	error.stack = [String(error), ...frames].join('\n')

	return error
}

const framesOf = (error: Error) => error.stack!.split('\n').slice(1)

test('strictError: тип и код вместо текста', () => {
	const copy = strictError(Object.assign(new TypeError(`GET /api?token=${PLANTED}`), { code: 'ECONNREFUSED' }))

	assert.equal(copy.name, 'TypeError')
	assert.equal(copy.message, 'ECONNREFUSED')
	assert.match(copy.stack!, /^TypeError: ECONNREFUSED\n {4}at /)
	assert.ok(!copy.stack!.includes(PLANTED))

	const messageOf = (fields: object, name?: string) =>
		strictError(Object.assign(new Error(PLANTED), fields, name === undefined ? {} : { name })).message

	assert.equal(messageOf({ code: 'ERR_INVALID_URL' }), 'ERR_INVALID_URL')
	assert.equal(messageOf({ code: 503 }), '503')
	assert.equal(messageOf({ status: 401 }), '401')
	assert.equal(messageOf({ statusCode: 599 }), '599')
	assert.equal(messageOf({ status: 600 }), '')
	assert.equal(messageOf({ status: '503' }), '', 'статус только числом')
	assert.equal(messageOf({ code: `token ${PLANTED}` }), '')
	assert.equal(messageOf({ code: 'econnrefused' }), '')
	assert.equal(messageOf({}), '')

	assert.equal(strictError(Object.assign(new Error('x'), { name: 'HttpError' })).name, 'HttpError')
	assert.equal(strictError(Object.assign(new Error('x'), { name: `Bearer ${PLANTED}` })).name, 'Error')
	assert.equal(strictError(Object.assign(new Error('x'), { name: 'A'.repeat(61) })).name, 'Error')
})

test('strictError: брошенный не Error уходит заменой без содержимого', () => {
	for (const [thrown, kind] of [
		[`Bearer ${PLANTED}`, 'string'],
		[{ token: PLANTED }, 'object'],
		[null, 'null'],
		[42, 'number'],
		[undefined, 'undefined'],
		[() => PLANTED, 'function'],
	] as const) {
		const copy = strictError(thrown)

		assert.equal(copy.name, 'Error')
		assert.equal(copy.message, `Non-Error thrown: ${kind}`)
		assert.ok(!copy.stack!.includes(PLANTED))
		// Кадры свои: видно, где кит поймал брошенное.
		assert.match(copy.stack!, /\n {4}at /)
	}
})

test('strictError: копия одна на объект, strictCopy -- свежая', () => {
	const error = new Error('x')
	const object = { note: 'x' }

	assert.equal(strictError(error), strictError(error))
	assert.equal(strictError(object), strictError(object))
	assert.notEqual(strictCopy(error), strictError(error))
	assert.notEqual(strictError('x'), strictError('x'), 'у строки нет личности, повтор -- новый случай')
})

test('строки вида `    at ...` в тексте ошибки не становятся кадрами', () => {
	const error = new Error(`upstream 401\n    at leak (/srv/${PLANTED}.js:1:1)\n    at /srv/${PLANTED}:2:2`)
	const copy = strictError(error)

	assert.ok(!copy.stack!.includes(PLANTED), copy.stack!)
	assert.equal(framesOf(copy).length, framesOf(error).length - 2)
})

test('текст, изменённый после создания: кадры -- сплошной блок в конце стека', () => {
	const error = withStack(['    at real (/srv/app.js:1:1)', '    at node:internal/main:2:2'], 'first')

	error.message = `second ${PLANTED}`

	assert.deepEqual(framesOf(strictError(error)), ['    at real (/srv/app.js:1:1)', '    at node:internal/main:2:2'])

	// Над блоком -- старый текст. Строка не по грамматике кадра блок обрывает.
	const header = withStack([`token: ${PLANTED}`, '    at real (/srv/app.js:1:1)'], 'x')

	header.message = 'y'
	assert.deepEqual(framesOf(strictError(header)), ['    at real (/srv/app.js:1:1)'])

	// Пустые строки в конце стека не обрывают блок.
	const trailing = withStack(['    at real (/srv/app.js:1:1)', '', ''], 'x')

	trailing.message = 'y'
	assert.deepEqual(framesOf(strictError(trailing)), ['    at real (/srv/app.js:1:1)'])
})

test('кадры V8 разбираются и рисуются заново, остальное отбрасывается', () => {
	const kept = [
		'    at run (/srv/app/build/index.js:10:5)',
		'    at async Promise.all (index 0)',
		'    at new Promise (<anonymous>)',
		'    at Array.forEach (native)',
		'    at Object.<anonymous> (/srv/a b/c.js:1:1)',
		'    at Object.m [as alias] (/srv/x.js:1:1)',
		'    at #private (/srv/x.js:1:1)',
		'    at get size (/srv/x.js:1:1)',
		'    at [Symbol.iterator] (/srv/x.js:1:1)',
		'    at Обработчик.вызов (/srv/x.js:1:1)',
		'    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
		'    at async file:///srv/app/main.mjs:3:1',
		'    at C:\\srv\\app.js:1:1',
		'    at ModuleJob.run (C:/srv/app.js:1:1)',
	]
	const dropped = [
		'    at eval (eval at <anonymous> (/srv/x.js:1:1), <anonymous>:1:1)',
		'    at f (data:text/javascript,throw 1:1:1)',
		'    at f (https://evil.example/x.js:1:1)',
		'    at f (/srv/x.js:1)',
		'    at f (/srv/x.js:1:a)',
		'    at f [as g] x (/srv/x.js:1:1)',
		`    at f?token=${PLANTED} (/srv/x.js:1:1)`,
		'  at f (/srv/x.js:1:1)',
		'    at relative/x.js:1:1',
		`    at ${'f'.repeat(201)} (/srv/x.js:1:1)`,
		`    at f (/srv/${'x'.repeat(1000)}.js:1:1)`,
		'Caused by: something',
	]

	assert.deepEqual(framesOf(strictError(withStack([...kept, ...dropped]))), kept)
	assert.equal(framesOf(strictError(withStack(Array(80).fill('    at f (/srv/x.js:1:1)')))).length, 50)
})

test('домашний каталог в пути становится ~', () => {
	const copy = strictError(
		withStack([
			`    at run (${join(HOME, 'project/build/index.js')}:10:5)`,
			`    at ${pathToFileURL(join(HOME, 'project/build/tool.mjs')).href}:3:7`,
			`    at other (${HOME}-backup/x.js:1:1)`,
		]),
	)

	assert.deepEqual(framesOf(copy), [
		'    at run (~/project/build/index.js:10:5)',
		'    at ~/project/build/tool.mjs:3:7',
		`    at other (${HOME}-backup/x.js:1:1)`,
	])
})

test('цепочка cause: такие же копии, циклы обрываются, глубина не больше пяти', () => {
	const inner = Object.assign(new Error(`connect ${PLANTED}`), { code: 'ECONNREFUSED' })
	const outer = new TypeError(`fetch failed for ${PLANTED}`, { cause: inner })

	inner.cause = outer

	const copy = strictError(outer)
	const cause = copy.cause as Error

	assert.equal(copy.message, '')
	assert.equal(cause.name, 'Error')
	assert.equal(cause.message, 'ECONNREFUSED')
	assert.equal(cause.cause, undefined, 'цикл оборван')
	assert.ok(!cause.stack!.includes(PLANTED))

	assert.equal(strictError(Object.assign(new Error('x'), { cause: 'text' })).cause, undefined)

	let deep = new Error('0')

	for (let i = 1; i < 10; i++) deep = new Error(String(i), { cause: deep })

	let depth = 0

	for (let item = strictError(deep).cause; item; item = (item as Error).cause) depth++

	assert.equal(depth, 5)
})

test('свойство-геттер, который бросает, не ломает копию', () => {
	const error = new Error('x')

	for (const key of ['name', 'stack', 'code', 'cause'])
		Object.defineProperty(error, key, {
			get() {
				throw new Error('getter')
			},
		})

	const copy = strictError(error)

	assert.equal(copy.name, 'Error')
	assert.equal(copy.message, '')
	assert.equal(copy.stack, 'Error')

	// Стек читается, а заголовок не собрать: кадры берутся блоком из конца стека.
	const nameless = withStack(['    at real (/srv/app.js:1:1)'])

	Object.defineProperty(nameless, 'name', {
		get() {
			throw new Error('getter')
		},
	})

	assert.deepEqual(framesOf(strictError(nameless)), ['    at real (/srv/app.js:1:1)'])
})

test('strictEvent оставляет только разрешённые поля', () => {
	const frame = {
		filename: `${HOME}/project/build/index.js`,
		function: 'run',
		lineno: 10,
		colno: 5,
		in_app: false,
		vars: { token: PLANTED },
		context_line: `const token = '${PLANTED}'`,
		pre_context: [PLANTED],
		debug_id: PLANTED,
	}
	const event = {
		event_id: 'a'.repeat(32),
		timestamp: 1,
		level: 'error',
		platform: 'node',
		release: 'kit@1.0.0',
		dist: '1',
		environment: 'production',
		sdk: { name: 'sentry.javascript.core', version: '11.9.0' },
		sdkProcessingMetadata: { normalizedRequest: { url: `/?token=${PLANTED}` } },
		message: PLANTED,
		logentry: { message: PLANTED },
		extra: { token: PLANTED },
		user: { id: PLANTED },
		request: { url: `/?token=${PLANTED}` },
		breadcrumbs: [{ message: PLANTED }],
		spans: [{ description: PLANTED }],
		transaction: `GET /?token=${PLANTED}`,
		fingerprint: [PLANTED],
		modules: { [PLANTED]: '1' },
		debug_meta: { images: [{ code_file: PLANTED }] },
		server_name: 'alice-macbook',
		unknown: PLANTED,
		tags: {
			'mcp.tool': 'pay',
			'http.path': `/bot7012345678:AAH/x/login/${PLANTED}/.well-known/oauth-protected-resource`,
			bad: PLANTED.repeat(10),
			'bad key': 'x',
			number: 1,
		},
		contexts: {
			trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16), data: { url: PLANTED }, description: PLANTED },
			runtime: { name: 'node', version: 'v26.0.0', nested: { token: PLANTED } },
			os: { name: 'Linux', long: PLANTED.repeat(10) },
			culture: { timezone: 'Europe/Moscow', is_24_hour_format: true, calendar: 1 },
			custom: { token: PLANTED },
			response: { status_code: 500 },
		},
		exception: {
			values: [
				{
					type: 'Error',
					value: `connect ${PLANTED}`,
					module: PLANTED,
					mechanism: { type: 'chained', source: 'cause', exception_id: 1, parent_id: 0, data: { PLANTED } },
					stacktrace: {
						frames: [
							frame,
							{ ...frame, filename: `https://evil.example/?token=${PLANTED}`, function: `x ${PLANTED}` },
							{ ...frame, filename: '~/project/node_modules/lib/x.js', in_app: true },
							{ ...frame, filename: 'node:internal/x', module: 'node.internal:x', in_app: false },
						],
					},
				},
				{ type: `Bearer ${PLANTED}`, value: '503', mechanism: { type: 'generic', handled: true } },
				{ type: 'Error', value: 'Non-Error thrown: object' },
				{ type: 'Error', value: 'ECONNREFUSED', mechanism: { type: `x ${PLANTED}` } },
				'garbage',
			],
		},
	}
	const hint: EventHint = { attachments: [{ filename: 'a.txt', data: PLANTED }] }
	const strict = strictEvent(event as unknown as Event, hint)
	const { filename: _, vars: _vars, context_line: _line, pre_context: _pre, debug_id: _id, ...fields } = frame

	assert.equal(hint.attachments, undefined, 'вложения не уходят')
	assert.ok(!JSON.stringify(strict).includes(PLANTED), JSON.stringify(strict))
	assert.ok(!JSON.stringify(strict).includes(HOME))

	assert.deepEqual(strict, {
		event_id: 'a'.repeat(32),
		timestamp: 1,
		level: 'error',
		platform: 'node',
		release: 'kit@1.0.0',
		dist: '1',
		environment: 'production',
		sdk: { name: 'sentry.javascript.core', version: '11.9.0' },
		tags: { 'mcp.tool': 'pay', 'http.path': '/*/x/login/*/.well-known/oauth-protected-resource' },
		contexts: {
			trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) },
			runtime: { name: 'node', version: 'v26.0.0' },
			os: { name: 'Linux' },
			culture: { timezone: 'Europe/Moscow', is_24_hour_format: true, calendar: 1 },
		},
		exception: {
			values: [
				{
					type: 'Error',
					value: '',
					mechanism: { type: 'chained', source: 'cause', exception_id: 1, parent_id: 0 },
					stacktrace: {
						frames: [
							// SDK не считает `~/...` кодом сервиса, кит поправляет.
							{ ...fields, filename: '~/project/build/index.js', in_app: true },
							{ lineno: 10, colno: 5, in_app: false },
							{ ...fields, filename: '~/project/node_modules/lib/x.js', in_app: false },
							{ ...fields, filename: 'node:internal/x', module: 'node.internal:x' },
						],
					},
				},
				{ type: 'Error', value: '503', mechanism: { type: 'generic', handled: true } },
				{ type: 'Error', value: 'Non-Error thrown: object' },
				{ type: 'Error', value: 'ECONNREFUSED', mechanism: { type: 'generic' } },
				{ type: 'Error', value: '' },
			],
		},
	})

	assert.deepEqual(strictEvent({ tags: { 'http.path': '/' } } as Event), { tags: { 'http.path': '/' } })
	assert.deepEqual(strictEvent({ tags: { 'http.path': `/${'a/'.repeat(150)}` } } as Event), { tags: {} })
	assert.deepEqual(strictEvent({ level: 'secret', exception: {} } as unknown as Event), {})
})

// Пороги с запасом в десятки раз: квадратичный разбор на таком входе шёл бы минуты.
test('разбор линеен: текст в 1e6 символов и стек в 1e5 строк', () => {
	const huge = 'at '.repeat(333_334)
	const line = `    at f (/srv/${':1'.repeat(40)}x)`
	const cases = [
		// Заголовок совпал: каждая строка проверяется до конца, ни одна не подходит.
		withStack(Array(100_000).fill(line), huge),
		// Текст поменяли: стек разбирается снизу целиком, все строки -- кадры.
		Object.assign(withStack(Array(100_000).fill('    at f (/srv/x.js:1:1)'), huge), { message: 'changed' }),
		withStack([`    at f (/srv/${'x'.repeat(1_000_000)})`], huge),
	]

	for (const error of cases) {
		const started = performance.now()

		strictCopy(error)
		assert.ok(performance.now() - started < 2000, `${performance.now() - started} мс`)
	}

	const value = `${'A'.repeat(1_000_000)}`
	const started = performance.now()

	strictEvent({
		tags: { 'http.path': '/a1'.repeat(300_000), key: value },
		exception: {
			values: [
				{
					type: value,
					value,
					mechanism: { type: value, source: value },
					stacktrace: { frames: [{ filename: `/${value}(`, function: value, module: value }] },
				},
			],
		},
	} as Event)

	assert.ok(performance.now() - started < 2000, `${performance.now() - started} мс`)
})
