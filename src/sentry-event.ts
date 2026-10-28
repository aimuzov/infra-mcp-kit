import { realpathSync } from 'node:fs'
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
// Путь к файлу кода. `~` -- наш же домашний каталог, `C:/` после `file:///C:/` у SDK. Символы --
// те, из которых состоят пути к коду: буквы, цифры, пробел и `_.~@+%$:/\[]-`. Без `?`, `=`, `&`, `#`,
// кавычек и скобок: из них состоят адреса с параметрами, заголовки и JSON в тексте ошибки.
const PATH = String.raw`(?:\/|~[\\/]|file:\/\/|node:|[A-Za-z]:[\\/])[\p{L}\p{M}\p{N} _.~@+%$:/\\\[\]-]{0,${MAX_LINE}}`
// Что V8 пишет вместо места, когда файла нет.
const NO_FILE = String.raw`<anonymous>|native|index \d{1,10}`

// Кадр V8: `    at [async |new ]имя (место)` или `    at [async ]место`. В месте нет скобок, поэтому
// граница однозначна. `eval at ...`, `data:` и прочее не подходят и отбрасываются.
const AT = '    at '
const CALL = new RegExp(String.raw`^ {4}at (async |new )?(${FUNCTION_NAME}) \(([^()]+)\)$`, 'u')
const BARE = /^ {4}at (async )?([^()\s][^()]*)$/
const PLACE = new RegExp(String.raw`^(?:(${PATH}):(\d{1,10}):(\d{1,10})|${NO_FILE})$`, 'u')

// Те же части в кадре события после разбора SDK: функция без `async`, файл без `:строка:столбец`.
const FUNCTION = new RegExp(String.raw`^(?:new )?${FUNCTION_NAME}$`, 'u')
const FILE = new RegExp(String.raw`^(?:${PATH}|${NO_FILE})$`, 'u')
const MODULE = /^[\p{L}\p{N}_$@.:/~+-]{1,300}$/u

const TAG = /^[\w.-]{1,32}$/
const TAG_VALUE_LENGTH = 200
// Сегмент пути в теге `http.path`, который остаётся как есть: слово, а не токен или код.
const SEGMENT = /^[A-Za-z._-]{1,32}$/

// Контексты и в них только поля, которые заполняет сам SDK: у `@sentry/node` сервера это ОС,
// память и процессор, локаль и регион облака. Без имени устройства, `cloud.account.id`, `host.id`
// и того, что сервис положил в контекст сам. У `trace` только связь, без `data` с адресом запроса.
const CONTEXTS: Record<string, ReadonlySet<string>> = {
	trace: new Set(['trace_id', 'span_id', 'parent_span_id']),
	runtime: new Set(['name', 'version']),
	os: new Set(['name', 'version', 'build', 'kernel_version']),
	app: new Set(['app_start_time', 'app_memory', 'free_memory']),
	device: new Set([
		'arch',
		'boot_time',
		'memory_size',
		'free_memory',
		'processor_count',
		'cpu_description',
		'processor_frequency',
	]),
	culture: new Set(['locale', 'timezone']),
	cloud_resource: new Set(['cloud.provider', 'cloud.platform', 'cloud.region', 'cloud.availability_zone']),
}

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
// Все строгие копии. Кадры события SDK разбирает из стека исходной ошибки, и только у копии в нём
// нет строк текста. Ошибку, которую сервер отдал SDK сам, мимо `captureError`, кит шлёт без кадров.
const made = new WeakSet<Error>()

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
		made.add(copy)

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

	// Без кадров, когда стека нет или ни одна строка не подошла, событие с пустым текстом SDK
	// отбрасывает как бесполезное (`eventFiltersIntegration` у `@sentry/node` сервера). Тогда
	// кадры свои, как у брошенного не `Error`: по ним видно хотя бы, где кит ошибку поймал.
	const frames = framesOf(error)

	copy.stack = [String(copy), ...(frames.length > 0 ? frames : framesOf(copy))].join('\n')
	made.add(copy)

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
 * Заголовок обычно совпадает с `String(error)` и отрезается точно, а кадры V8
 * идут за ним сплошным блоком. Если текст поменяли после того, как стек уже
 * собрали, границы не видно: тогда кадры -- сплошной блок подходящих строк
 * в конце стека. И в том и в другом случае строка прежнего текста, подогнанная
 * ровно под кадр, станет кадром: например, когда текст обрезали до первой
 * строки. Но только именем функции и путём из разрешённых символов, без `?`,
 * `=` и `&`, поэтому адрес с параметрами или заголовок так не уйдут.
 */
function framesOf(error: Error): string[] {
	const stack = read(error, 'stack')

	if (typeof stack !== 'string') return []

	const head = headsOf(error).find((head) => stack === head || stack.startsWith(`${head}\n`))

	if (head !== undefined) {
		const frames: string[] = []

		for (const line of stack.slice(head.length + 1).split('\n')) {
			// Блок кончается на первой строке не с `    at `: так библиотеки дописывают
			// к стеку стек вложенной ошибки вместе с её текстом.
			if (!line.startsWith(AT)) break

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

/**
 * Каким может быть заголовок стека: `String(error)` без своего `toString` у ошибки, так его
 * собирает V8, и вариант Node с кодом у своих ошибок: `RangeError [ERR_OUT_OF_RANGE]: ...`.
 */
function headsOf(error: Error): string[] {
	let head: string

	try {
		head = Error.prototype.toString.call(error)
	} catch {
		return []
	}

	const name = read(error, 'name')
	const code = read(error, 'code')

	return typeof name === 'string' && name !== '' && typeof code === 'string' && head.startsWith(name)
		? [head, `${name} [${code}]${head.slice(name.length)}`]
		: [head]
}

function frameOf(line: string): string | undefined {
	// Длину проверяем до регулярок: кадр V8 короче, а длинная строка -- это текст.
	if (line.length > MAX_LINE) return undefined

	const call = CALL.exec(line)

	if (call) {
		const place = placeOf(call[3]!)

		return place && `${AT}${call[1] ?? ''}${call[2]} (${place})`
	}

	const bare = BARE.exec(line)
	const place = bare && placeOf(bare[2]!)

	return place ? `${AT}${bare![1] ?? ''}${place}` : undefined
}

function placeOf(text: string): string | undefined {
	const match = PLACE.exec(text)

	if (!match) return undefined

	const [, path, line, column] = match

	return path === undefined ? text : `${withoutHome(path)}:${line}:${column}`
}

let homes: string[] | undefined

// На macOS и Windows файловая система по умолчанию не различает регистр: `/users/alice/...` --
// тот же домашний каталог.
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'

/** Домашний каталог в пути становится `~`: у stdio-сервера на машине человека в нём его имя. */
function withoutHome(path: string): string {
	homes ??= homePrefixes()

	const home = homes.find((prefix) =>
		FOLD_CASE ? path.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() : path.startsWith(prefix),
	)

	return home ? `~${path.slice(home.length - 1)}` : path
}

/**
 * Домашний каталог во всех видах, в каких он бывает в стеке: с `/` и `\` на конце, `file://`
 * и `C:/` у SDK. `$HOME` Node отдаёт как есть, бывает и со слэшем на конце, а в стек пишет
 * настоящий путь, поэтому за симлинком ищем ещё и его.
 */
function homePrefixes(): string[] {
	const prefixes = new Set<string>()

	for (const raw of [homedir(), realHome()]) {
		const home = trimSeparators(raw ?? '')

		// Корень, домашний каталог системных пользователей, не в счёт: иначе `~` стал бы любой путь.
		if (/^(?:[A-Za-z]:)?$/.test(home)) continue

		const forward = home.replaceAll('\\', '/')

		for (const prefix of [`${home}/`, `${home}\\`, `${forward}/`, `${pathToFileURL(home).href}/`])
			prefixes.add(prefix)
	}

	return [...prefixes]
}

function realHome(): string | undefined {
	try {
		return realpathSync(homedir())
	} catch {
		return undefined
	}
}

function trimSeparators(path: string): string {
	let end = path.length

	while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end--

	return path.slice(0, end)
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
	const framed = made.has(hint?.originalException as Error)

	if (tags) strict.tags = tags

	if (contexts) strict.contexts = contexts

	if (Array.isArray(values)) strict.exception = { values: values.map((value) => exceptionOf(value, framed)) }

	return strict as T
}

function exceptionOf(exception: unknown, framed: boolean): Fields {
	const { type, value, mechanism, stacktrace }: Fields = isObject(exception) ? exception : {}
	const frames = framed && isObject(stacktrace) && Array.isArray(stacktrace.frames) ? stacktrace.frames : undefined

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
 * Теги как есть, если ключ и значение похожи на тег. В `http.path` сегмент остаётся, только если
 * он из латинских букв, `.`, `-` и `_` и не длиннее 32 символов, иначе становится `*`:
 * `/bot<token>/x` и `/login/<код>` не уносят секрет.
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

/** Известные контексты, в них известные поля и только простые значения. */
function contextsOf(contexts: unknown): Fields | undefined {
	if (!isObject(contexts)) return undefined

	const strict: Fields = {}

	for (const [name, context] of Object.entries(contexts)) {
		const fields = Object.hasOwn(CONTEXTS, name) ? CONTEXTS[name] : undefined

		if (!fields || !isObject(context)) continue

		const kept = Object.entries(context).filter(
			([key, value]) =>
				fields.has(key) &&
				((typeof value === 'string' && value.length <= TAG_VALUE_LENGTH) ||
					Number.isFinite(value) ||
					typeof value === 'boolean'),
		)

		if (kept.length > 0) strict[name] = Object.fromEntries(kept)
	}

	return strict
}
