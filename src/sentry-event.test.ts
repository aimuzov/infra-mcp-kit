import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
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

/** Кадры строгой копии в отдельном процессе с другим `HOME`: домашний каталог кит читает один раз. */
async function framesWithHome(home: string, frames: string[]): Promise<string[]> {
	const script = `
		const { strictError } = await import(${JSON.stringify(new URL('./sentry-event.ts', import.meta.url).href)})
		const error = new Error('x')

		error.stack = ['Error: x', ...${JSON.stringify(frames)}].join('\\n')
		console.log(JSON.stringify(strictError(error).stack.split('\\n').slice(1)))
	`
	const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
		env: { ...process.env, HOME: home },
	})

	return JSON.parse(stdout) as string[]
}

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

	// Текст обрезали до первой строки: заголовок совпал, и строки прежнего текста идут сразу
	// за ним. Адрес с параметрами и заголовок под путь не подходят.
	const truncated = new Error(
		[
			'upstream 500',
			`    at /api/cards?token=${PLANTED}&password=hunter2:1:1`,
			`    at retry (/srv/{"token":"${PLANTED}"}:1:1)`,
			`    at retry (/srv/#${PLANTED}:1:1)`,
		].join('\n'),
	)

	assert.ok(truncated.stack)
	truncated.message = 'upstream 500'
	assert.ok(!strictError(truncated).stack!.includes(PLANTED), strictError(truncated).stack!)
})

test('кадры идут сплошным блоком за заголовком: дописанный стек вложенной ошибки не в счёт', () => {
	// Так делают nested-error-stacks и похожие: стек вложенной ошибки дописан вместе с её текстом.
	const inner = new Error(`upstream said:\n    at leak (/srv/${PLANTED}.js:1:1)`)
	const outer = withStack(['    at real (/srv/app.js:1:1)', '    at eval (eval at <anonymous> (/srv/x.js:1:1))'])

	outer.stack += `\nCaused By: ${inner.stack}`

	assert.deepEqual(framesOf(strictError(outer)), ['    at real (/srv/app.js:1:1)'])
})

test('заголовок с кодом у ошибок Node отрезается точно', () => {
	// `RangeError [ERR_X]: ...`: без кода в заголовке разбор шёл бы хвостовым блоком, и строка
	// текста, похожая на кадр, прямо над кадрами стала бы кадром.
	const error = Object.assign(new RangeError(`bad\n    at leak (/srv/${PLANTED}.js:1:1)`), { code: 'ERR_X' })

	error.stack = [`RangeError [ERR_X]: ${error.message}`, '    at real (/srv/app.js:1:1)'].join('\n')
	assert.deepEqual(framesOf(strictError(error)), ['    at real (/srv/app.js:1:1)'])

	try {
		Buffer.alloc(1).readUInt8(5)
	} catch (thrown) {
		const node = thrown as Error

		assert.match(node.stack!, /^RangeError \[ERR_OUT_OF_RANGE\]: /)
		assert.equal(framesOf(strictError(node)).length, framesOf(node).length)
	}
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
		'    at f (/srv/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/x.js:1:1)',
		'    at f (/srv/app/[slug]/$id.js:1:1)',
		'    at file:///srv/My%20App/x.mjs:1:1',
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
		`    at f (/srv/x.js?token=${PLANTED}:1:1)`,
		`    at /api?token=${PLANTED}&password=x:1:1`,
		`    at f (/srv/'${PLANTED}':1:1)`,
		'    at f (/srv/x\tjs:1:1)',
	]

	assert.deepEqual(framesOf(strictError(withStack([...kept, ...dropped]))), kept)
	assert.deepEqual(framesOf(strictError(withStack([...kept, 'Caused by: something', ...kept]))), kept)
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

test('домашний каталог со слэшем на конце, за симлинком и в другом регистре', async () => {
	// Настоящий путь: на macOS сам `tmpdir()` за симлинком.
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-home-')))

	try {
		const real = join(root, 'Real')
		const link = join(root, 'link')

		mkdirSync(real)
		symlinkSync(real, link)

		// `$HOME` со слэшем на конце Node отдаёт как есть.
		assert.deepEqual(await framesWithHome(`${real}//`, [`    at run (${real}/project/index.js:1:1)`]), [
			'    at run (~/project/index.js:1:1)',
		])

		// В стек Node пишет настоящий путь, а `$HOME` -- симлинк.
		assert.deepEqual(await framesWithHome(link, [`    at run (${real}/project/index.js:1:1)`]), [
			'    at run (~/project/index.js:1:1)',
		])

		// На macOS и Windows `/users/alice` -- тот же каталог, что `/Users/alice`.
		const folds = process.platform === 'darwin' || process.platform === 'win32'
		const lower = `    at run (${real.toLowerCase()}/project/index.js:1:1)`

		assert.deepEqual(await framesWithHome(real, [lower]), [folds ? '    at run (~/project/index.js:1:1)' : lower])

		// Корень домашним каталогом не считается.
		assert.deepEqual(await framesWithHome('/', ['    at run (/srv/index.js:1:1)']), [
			'    at run (/srv/index.js:1:1)',
		])

		// Каталога нет, настоящий путь не узнать: хватает `$HOME` как есть.
		assert.deepEqual(await framesWithHome(join(root, 'gone'), [`    at run (${root}/gone/index.js:1:1)`]), [
			'    at run (~/index.js:1:1)',
		])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
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

test('ошибка без разбираемых кадров получает кадры места, где её поймали', () => {
	// Событие без кадров, кода и текста SDK отбрасывает как бесполезное.
	const limit = Error.stackTraceLimit

	Error.stackTraceLimit = 0

	const limited = new Error('x')

	Error.stackTraceLimit = limit

	const deleted = Object.assign(new Error('x'), { stack: undefined })
	const foreign = withStack([
		`    at f (C:\\Program Files (x86)\\app\\x.js:1:1)`,
		'    at eval (eval at f (/srv/x.js:1:1))',
	])

	for (const error of [limited, deleted, foreign]) {
		const frames = framesOf(strictError(error))

		assert.ok(frames.length > 0)

		assert.ok(
			frames.some((frame) => frame.includes('sentry-event.test.ts')),
			frames.join('\n'),
		)
	}
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

	// Без своих кадров у копии кадры того места, где кит поймал ошибку.
	assert.ok(
		framesOf(copy).some((frame) => frame.includes('sentry-event.test.ts')),
		copy.stack!,
	)

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
			runtime: { name: 'node', version: 'v26.0.0', nested: { token: PLANTED }, token: PLANTED },
			os: { name: 'Linux', kernel_version: PLANTED.repeat(10), token: PLANTED },
			app: { app_memory: 1, app_start_time: '2026-01-01T00:00:00.000Z', token: PLANTED, app_name: PLANTED },
			device: { arch: 'arm64', processor_count: 8, name: 'alice-macbook', device_unique_identifier: PLANTED },
			culture: { locale: 'ru-RU', timezone: 'Europe/Moscow', is_24_hour_format: true, display_name: PLANTED },
			cloud_resource: { 'cloud.provider': 'aws', 'cloud.region': 'eu-west-1', 'cloud.account.id': PLANTED },
			custom: { token: PLANTED },
			response: { status_code: 500 },
			toString: { token: PLANTED },
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
	const hint: EventHint = {
		attachments: [{ filename: 'a.txt', data: PLANTED }],
		originalException: strictError(new Error('x')),
	}
	const strict = strictEvent(event as unknown as Event, hint)
	const { filename: _, vars: _vars, context_line: _line, pre_context: _pre, debug_id: _id, ...fields } = frame

	assert.equal(hint.attachments, undefined, 'вложения не уходят')
	assert.ok(!JSON.stringify(strict).includes(PLANTED), JSON.stringify(strict))
	assert.ok(!JSON.stringify(strict).includes(HOME))
	assert.ok(!JSON.stringify(strict).includes('alice-macbook'))

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
			app: { app_memory: 1, app_start_time: '2026-01-01T00:00:00.000Z' },
			device: { arch: 'arm64', processor_count: 8 },
			culture: { locale: 'ru-RU', timezone: 'Europe/Moscow' },
			cloud_resource: { 'cloud.provider': 'aws', 'cloud.region': 'eu-west-1' },
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

	assert.deepEqual(strictEvent({ tags: { 'http.path': '/users/@alice/a+b/a:b/%D0%B0/ok' } } as Event), {
		tags: { 'http.path': '/users/*/*/*/*/ok' },
	})

	assert.deepEqual(strictEvent({ tags: { 'http.path': `/${'a/'.repeat(150)}` } } as Event), { tags: {} })
	assert.deepEqual(strictEvent({ level: 'secret', exception: {} } as unknown as Event), {})
})

test('ошибка мимо captureError: без кадров, код из самой ошибки', () => {
	// Сервер отдал SDK ошибку сам, мимо `captureError`: кадры SDK разобрал из её исходного стека
	// вместе со строками текста, а текст исключения взял из текста ошибки.
	const KEY = 'AKIAIOSFODNN7EXAMPLE'
	const event = (...values: string[]) =>
		({
			exception: {
				values: values.map((value) => ({
					type: 'TypeError',
					value,
					stacktrace: { frames: [{ filename: '/srv/leak.js', function: 'retry', lineno: 1 }] },
				})),
			},
		}) as Event
	const valuesOf = (strict: Event) =>
		strict.exception?.values?.map(({ value, stacktrace }) => ({ value, stacktrace }))

	for (const [hint, value] of [
		[undefined, ''],
		[{}, ''],
		// Текст, похожий на код, -- ключ доступа AWS.
		[{ originalException: new Error(KEY) }, ''],
		[{ originalException: Object.assign(new Error(KEY), { code: 'ECONNREFUSED' }) }, 'ECONNREFUSED'],
		[{ originalException: Object.assign(new Error(KEY), { status: 503 }) }, '503'],
		[{ originalException: KEY }, 'Non-Error thrown: string'],
	] as const)
		assert.deepEqual(strictEvent(event(KEY), hint), { exception: { values: [{ type: 'TypeError', value }] } })

	// Причины из `cause` SDK кладёт перед самой ошибкой, и их текст пустой.
	assert.deepEqual(
		valuesOf(
			strictEvent(event('ECONNREFUSED', KEY), {
				originalException: Object.assign(new Error(KEY), { code: 'EPIPE' }),
			}),
		),
		[
			{ value: '', stacktrace: undefined },
			{ value: 'EPIPE', stacktrace: undefined },
		],
	)

	// У строгой копии кита текст и кадры из события.
	for (const original of [strictError(new Error('x')), strictCopy('x')])
		assert.deepEqual(valuesOf(strictEvent(event('ECONNREFUSED', ''), { originalException: original })), [
			{
				value: 'ECONNREFUSED',
				stacktrace: { frames: [{ filename: '/srv/leak.js', function: 'retry', lineno: 1 }] },
			},
			{ value: '', stacktrace: { frames: [{ filename: '/srv/leak.js', function: 'retry', lineno: 1 }] } },
		])
})

test('отозванный Proxy, брошенный сам или в cause, не ломает копию', () => {
	// `instanceof` на нём бросает. Такое бывает с черновиком immer после `produce`.
	const revoked = () => {
		const { proxy, revoke } = Proxy.revocable({}, {})

		revoke()

		return proxy
	}

	assert.equal(strictError(revoked()).message, 'Non-Error thrown: object')

	const copy = strictError(Object.assign(new Error('x', { cause: revoked() }), { code: 'ECONNRESET' }))

	assert.equal(copy.message, 'ECONNRESET')
	assert.equal(copy.cause, undefined)

	assert.deepEqual(
		strictEvent({ exception: { values: [{ type: 'Error', value: 'x' }] } } as Event, {
			originalException: revoked(),
		}),
		{ exception: { values: [{ type: 'Error', value: 'Non-Error thrown: object' }] } },
	)
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
