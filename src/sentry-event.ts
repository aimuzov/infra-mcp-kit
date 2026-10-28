import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { Event, EventHint } from '@sentry/core'

/**
 * Что кит отдаёт в Sentry: только разрешённое и в разрешённом виде. Текст ошибки пишет тот,
 * кто её бросил, часто апстрим, и в нём бывает что угодно, от токена до тела запроса.
 * Искать в нём секреты -- догонялки с форматами, поэтому текст не уходит вовсе: только тип,
 * код и кадры стека, собранные заново. Целиком ошибка остаётся в логе у того, кто держит сервер.
 * Регулярки здесь якорные, без вложенных квантификаторов и на входе ограниченной длины.
 */

type Fields = Record<string, unknown>

// Тип ошибки: `TypeError`, `HttpError`, `errors.AbortError`.
const NAME = /^[A-Za-z_$][\w$.]{0,59}$/
// Код из Node и undici: `ECONNREFUSED`, `ERR_INVALID_URL`, `UND_ERR_CONNECT_TIMEOUT`.
const CODE = /^[A-Z][A-Z\d_]{1,40}$/
// Чем может быть текст исключения в событии: код, HTTP-статус или замена брошенного не `Error`.
const VALUE = /^(?:[A-Z][A-Z\d_]{1,40}|[1-5]\d{2}|Non-Error thrown: [a-z]+)?$/

const MAX_CAUSES = 5
const MAX_FRAMES = 50
const MAX_LINE = 1000

// Имя функции в кадре: `Object.<anonymous>`, `#private`, `[Symbol.iterator]`, `get size`,
// `run [as handler]`. `?` -- так SDK пишет безымянную.
const FUNCTION_NAME = String.raw`(?:get |set )?[\p{L}\p{N}_$#.<>?\[\]-]{1,200}(?: \[as [\p{L}\p{N}_$#.<>?\[\]-]{1,200}\])?`
// Путь к файлу кода. `~` -- наш же домашний каталог, `C:/` после `file:///C:/` у SDK.
const PATH = String.raw`(?:\/|~[\\/]|file:\/\/|node:|[A-Za-z]:[\\/])[^()\n]{0,${MAX_LINE}}`
// Что V8 пишет вместо места, когда файла нет.
const NO_FILE = String.raw`<anonymous>|native|index \d{1,10}`

// Кадр V8: `    at [async |new ]имя (место)` или `    at [async ]место`. В месте нет скобок, поэтому
// граница однозначна. `eval at ...`, `data:` и прочее не подходят и отбрасываются.
const CALL = new RegExp(String.raw`^ {4}at (async |new )?(${FUNCTION_NAME}) \(([^()]+)\)$`, 'u')
const BARE = /^ {4}at (async )?([^()\s][^()]*)$/
const PLACE = new RegExp(String.raw`^(?:(${PATH}):(\d{1,10}):(\d{1,10})|${NO_FILE})$`)

// Те же части в кадре события после разбора SDK: функция без `async`, файл без `:строка:столбец`.
const FUNCTION = new RegExp(String.raw`^(?:new )?${FUNCTION_NAME}$`, 'u')
const FILE = new RegExp(String.raw`^(?:${PATH}|${NO_FILE})$`)
const MODULE = /^[\p{L}\p{N}_$@.:/~+-]{1,300}$/u

const TAG = /^[\w.-]{1,32}$/
const TAG_VALUE_LENGTH = 200
// Сегмент пути в теге `http.path`, который остаётся как есть: слово, а не токен или код.
const SEGMENT = /^[A-Za-z._-]{1,32}$/

const CONTEXTS = new Set(['trace', 'runtime', 'os', 'app', 'device', 'culture', 'cloud_resource'])
// У `trace` старых SDK бывают `data` и `description` с адресом запроса: оставляем только связь.
const TRACE = new Set(['trace_id', 'span_id', 'parent_span_id'])

type Check = (value: unknown) => boolean

const isString: Check = (value) => typeof value === 'string'
const isBoolean: Check = (value) => typeof value === 'boolean'
const isCount: Check = (value) => Number.isInteger(value) && (value as number) >= 0
const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null
const matches =
	(pattern: RegExp): Check =>
	(value) =>
		typeof value === 'string' && pattern.test(value)

const EVENT: Record<string, Check> = {
	event_id: matches(/^[\da-f]{32}$/),
	timestamp: Number.isFinite,
	level: matches(/^(?:fatal|error|warning|log|info|debug)$/),
	platform: matches(/^[a-z]{1,20}$/),
	release: isString,
	dist: isString,
	environment: isString,
	sdk: isObject,
}
const MECHANISM: Record<string, Check> = {
	type: matches(/^[\w.-]{1,64}$/),
	handled: isBoolean,
	synthetic: isBoolean,
	exception_id: isCount,
	parent_id: isCount,
	source: matches(/^[\w.[\]]{1,64}$/),
	is_exception_group: isBoolean,
}
const FRAME: Record<string, Check> = {
	filename: matches(FILE),
	abs_path: matches(FILE),
	function: matches(FUNCTION),
	module: matches(MODULE),
	lineno: isCount,
	colno: isCount,
	in_app: isBoolean,
	platform: matches(/^[a-z]{1,20}$/),
}

/** Поля `source`, которые прошли проверку, остальных в ответе нет. */
function pick(source: unknown, checks: Record<string, Check>): Fields {
	const picked: Fields = {}

	if (isObject(source))
		for (const [key, check] of Object.entries(checks)) if (check(source[key])) picked[key] = source[key]

	return picked
}

const copies = new WeakMap<object, Error>()

/**
 * Строгая копия ошибки для Sentry, одна на исходный объект. Одну ошибку ловят двое, например
 * обработчик и HTTP-слой над ним: SDK помечает отправленный объект и второй раз его не шлёт.
 */
export function strictError(error: unknown): Error {
	if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return strictCopy(error)

	let copy = copies.get(error)

	if (!copy) copies.set(error, (copy = strictCopy(error)))

	return copy
}

/**
 * Свежая копия мимо кэша: тип, код вместо текста, кадры стека и такая же цепочка `cause`.
 * Так кит отправляет падение процесса, отдельным событием, даже если ошибку уже отправляли.
 */
export const strictCopy = (error: unknown): Error => copyOf(error, new Set())

function copyOf(error: unknown, seen: Set<object>): Error {
	if (!(error instanceof Error)) {
		// В брошенном объекте бывают аргументы инструмента, а в строке -- что угодно. Кадры свои:
		// по ним видно, где кит его поймал.
		const copy = new Error(`Non-Error thrown: ${error === null ? 'null' : typeof error}`)

		copy.stack = [String(copy), ...framesOf(copy)].join('\n')

		return copy
	}

	seen.add(error)

	const name = read(error, 'name')
	const cause = read(error, 'cause')
	// Глубину и циклы считает `seen`. Код из `cause`, `fetch failed` -> `ECONNREFUSED`, SDK
	// покажет отдельным исключением.
	const copy = new Error(
		codeOf(error),
		cause instanceof Error && !seen.has(cause) && seen.size <= MAX_CAUSES
			? { cause: copyOf(cause, seen) }
			: undefined,
	)

	copy.name = typeof name === 'string' && NAME.test(name) ? name : 'Error'
	copy.stack = [String(copy), ...framesOf(error)].join('\n')

	return copy
}

/** Чужое свойство может оказаться геттером, который бросает. */
function read(error: Error, key: string): unknown {
	try {
		return (error as unknown as Fields)[key]
	} catch {
		return undefined
	}
}

/** `code` из Node и undici или HTTP-статус. Остальное -- пустая строка. */
function codeOf(error: Error): string {
	const code = read(error, 'code')

	if (typeof code === 'string' && CODE.test(code)) return code

	const status = [code, read(error, 'status'), read(error, 'statusCode')].find(
		(value) => Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599,
	)

	return status === undefined ? '' : String(status)
}

/**
 * Кадры стека, отрисованные заново из разобранных частей. Стек начинается
 * с заголовка, а в нём текст ошибки, в том числе строки вида `    at ...`.
 * Заголовок обычно совпадает с `String(error)` и отрезается точно. Если текст
 * поменяли после того, как стек уже собрали, границы не видно: тогда кадры --
 * сплошной блок подходящих строк в конце стека. Строка прежнего текста,
 * подогнанная ровно под кадр, тогда в него попадёт, но только именем функции
 * и путём из разрешённых символов.
 */
function framesOf(error: Error): string[] {
	const stack = read(error, 'stack')

	if (typeof stack !== 'string') return []

	const head = headOf(error)

	if (head !== undefined && (stack === head || stack.startsWith(`${head}\n`))) {
		const frames: string[] = []

		for (const line of stack.slice(head.length + 1).split('\n')) {
			const frame = frameOf(line)

			if (frame) frames.push(frame)

			if (frames.length === MAX_FRAMES) break
		}

		return frames
	}

	const lines = stack.trimEnd().split('\n')
	let start = lines.length

	while (start > 0 && frameOf(lines[start - 1]!)) start--

	return lines.slice(start, start + MAX_FRAMES).map((line) => frameOf(line)!)
}

/** `String(error)` без своего `toString` у ошибки: так заголовок стека собирает и V8. */
function headOf(error: Error): string | undefined {
	try {
		return Error.prototype.toString.call(error)
	} catch {
		return undefined
	}
}

function frameOf(line: string): string | undefined {
	// Длину проверяем до регулярок: кадр V8 короче, а длинная строка -- это текст.
	if (line.length > MAX_LINE) return undefined

	const call = CALL.exec(line)

	if (call) {
		const place = placeOf(call[3]!)

		return place && `    at ${call[1] ?? ''}${call[2]} (${place})`
	}

	const bare = BARE.exec(line)
	const place = bare && placeOf(bare[2]!)

	return place ? `    at ${bare![1] ?? ''}${place}` : undefined
}

function placeOf(text: string): string | undefined {
	const match = PLACE.exec(text)

	if (!match) return undefined

	const [, path, line, column] = match

	return path === undefined ? text : `${withoutHome(path)}:${line}:${column}`
}

let homes: string[] | undefined

/** Домашний каталог в пути становится `~`: у stdio-сервера на машине человека в нём его имя. */
function withoutHome(path: string): string {
	homes ??= homePrefixes()

	const home = homes.find((prefix) => path.startsWith(prefix))

	return home ? `~${path.slice(home.length - 1)}` : path
}

function homePrefixes(): string[] {
	const home = homedir()

	// Корень, домашний каталог системных пользователей, не в счёт: иначе `~` стал бы любой путь.
	if (/^(?:[A-Za-z]:)?[\\/]?$/.test(home)) return []

	return [`${home}/`, `${home}\\`, `${pathToFileURL(home).href}/`]
}

/**
 * Событие только из разрешённых полей: что не названо здесь, в Sentry не уходит. Стоит
 * в `beforeSend` своего клиента и процессором на копии scope чужого. Без текста ошибки, запроса,
 * пользователя, `extra`, хлебных крошек, спанов, имени машины и всего, что SDK добавит потом.
 */
export function strictEvent<T extends Event>(event: T, hint?: EventHint): T {
	// Вложения scope SDK кладёт в тот же конверт отдельными частями.
	if (hint) delete hint.attachments

	const strict = pick(event, EVENT)
	const tags = tagsOf(event.tags)
	const contexts = contextsOf(event.contexts)
	const values = event.exception?.values

	if (tags) strict.tags = tags

	if (contexts) strict.contexts = contexts

	if (Array.isArray(values)) strict.exception = { values: values.map(exceptionOf) }

	return strict as T
}

function exceptionOf(exception: unknown): Fields {
	const { type, value, mechanism, stacktrace }: Fields = isObject(exception) ? exception : {}
	const frames = isObject(stacktrace) && Array.isArray(stacktrace.frames) ? stacktrace.frames : undefined

	return {
		type: typeof type === 'string' && NAME.test(type) ? type : 'Error',
		value: typeof value === 'string' && VALUE.test(value) ? value : '',
		...(isObject(mechanism) && { mechanism: { type: 'generic', ...pick(mechanism, MECHANISM) } }),
		...(frames && { stacktrace: { frames: frames.map(frameFieldsOf) } }),
	}
}

function frameFieldsOf(frame: unknown): Fields {
	const strict = pick(frame, FRAME)

	for (const key of ['filename', 'abs_path']) if (strict[key]) strict[key] = withoutHome(strict[key] as string)

	// SDK считает кодом сервиса только абсолютный путь, а `~/...` уже не такой.
	if ((strict.filename as string | undefined)?.startsWith('~'))
		strict.in_app = !(strict.filename as string).includes('node_modules')

	return strict
}

/**
 * Теги как есть, если ключ и значение похожи на тег. В `http.path` сегмент с цифрами или длинный
 * становится `*`: `/bot<token>/x` и `/login/<код>` не уносят секрет.
 */
function tagsOf(tags: unknown): Record<string, string> | undefined {
	if (!isObject(tags)) return undefined

	const strict: Record<string, string> = {}

	for (const [key, raw] of Object.entries(tags)) {
		if (!TAG.test(key) || typeof raw !== 'string') continue

		const value = key === 'http.path' ? pathTag(raw) : raw

		if (value.length <= TAG_VALUE_LENGTH) strict[key] = value
	}

	return strict
}

const pathTag = (path: string) =>
	path
		.split('/')
		.map((segment) => (segment === '' || SEGMENT.test(segment) ? segment : '*'))
		.join('/')

/** Известные контексты и в них только простые значения: версия рантайма, ОС, регион облака. */
function contextsOf(contexts: unknown): Fields | undefined {
	if (!isObject(contexts)) return undefined

	const strict: Fields = {}

	for (const [name, context] of Object.entries(contexts)) {
		if (!CONTEXTS.has(name) || !isObject(context)) continue

		strict[name] = Object.fromEntries(
			Object.entries(context).filter(
				([key, value]) =>
					(name !== 'trace' || TRACE.has(key)) &&
					((typeof value === 'string' && value.length <= TAG_VALUE_LENGTH) ||
						Number.isFinite(value) ||
						typeof value === 'boolean'),
			),
		)
	}

	return strict
}
