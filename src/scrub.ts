/**
 * Чистка секретов из текста ошибок, событий Sentry и строк лога. Текст ошибки пишет тот,
 * кто её бросил, часто апстрим: в нём бывают токены, адреса с query и заголовки запроса.
 */

/** Чем заменяется секрет: так же помечает отфильтрованное сам Sentry. */
export const FILTERED = '[Filtered]'

/**
 * Своё правило сервиса. Регулярка -- совпадение заменяется на `[Filtered]`, строка -- точное
 * значение секрета, например токен из окружения, функция получает текст и возвращает чистый.
 */
export type ScrubRule = RegExp | string | ((text: string) => string)

type Replace = (text: string) => string

// Значение похоже на секрет, а не на слово: в нём есть что-то кроме букв.
const notWord = (value: string) => !/^[A-Za-z][a-z]*$/.test(value)

// Длинная случайная строка: цифры вперемешку с буквами или смешанный регистр без разделителей слов.
const random = (value: string) =>
	(/\d/.test(value) && /[a-z]/i.test(value)) || (/[a-z]/.test(value) && /[A-Z]/.test(value) && !/[_-]/.test(value))

// Ключ, значение которого секрет целиком: `KAITEN_API_TOKEN`, `client_secret`, `x-api-key`.
// Длина вокруг слова ограничена: без предела длинная строка через дефисы разбиралась бы за квадрат.
const SECRET_KEY = String.raw`[\w-]{0,40}(?:token|secret|passw(?:or)?d|api[_-]?key|credential|signature|session[_-]?id|authorization)[\w-]{0,40}`

const SECRET_FIELD =
	/token|secret|passw(?:or)?d|api[_-]?key|credential|signature|session[_-]?id|cookie|authorization|^auth$/i

// Уже вычищенное не трогаем, иначе вторая чистка съела бы пробел перед `[Filtered]`.
const NOT_FILTERED = String.raw`(?![\s"']*\[Filtered\])`

const HEADER = new RegExp(
	String.raw`\b((?:proxy-)?authorization|(?:set-)?cookie)(["']?\s*:\s*["']?)${NOT_FILTERED}[^"'\r\n]+`,
	'gi',
)
// Значение в кавычках до закрывающей: в нём бывают пробелы и запятые.
const QUOTED = new RegExp(
	String.raw`\b(${SECRET_KEY})(["']?\s*[:=]\s*)(["'])${NOT_FILTERED}(?:\\.|(?!\3)[^\\\r\n])*\3`,
	'gi',
)
const PAIR = new RegExp(String.raw`\b(${SECRET_KEY})(["']?\s*[:=]\s*)(["']?)${NOT_FILTERED}([^\s"'&,;)}\]]+)`, 'gi')

const BUILTIN: Replace[] = [
	// `https://user:pass@host`. Схема короткая: без предела строка через дефисы
	// разбиралась бы за квадрат.
	(text) => text.replace(/\b([a-z][a-z\d+.-]{0,30}:\/\/)[^\s/?#@"'<>]+@/gi, `$1${FILTERED}@`),
	// Значения query и фрагмента: `?token=`, `&code=`, `#access_token=`. Имена остаются, по ним видно запрос.
	(text) => text.replace(/([?&#])([^\s=?&#"'<>]+)=[^\s&#"'<>]+/g, `$1$2=${FILTERED}`),
	// Первая пара тела формы, `code=...&state=...`: у неё нет `?` впереди.
	(text) => text.replace(/(^|[\s"'(])([\w.%-]+)=[^\s&#"'<>]+(?=&)/g, `$1$2=${FILTERED}`),
	// Заголовки в тексте: значение целиком, у cookie это все пары разом.
	(text) => text.replace(HEADER, `$1$2${FILTERED}`),
	(text) =>
		text.replace(/\b(Bearer|Basic)(\s+)([\w~+/.=-]+)/gi, (all, scheme: string, space: string, value: string) =>
			notWord(value) ? `${scheme}${space}${FILTERED}` : all,
		),
	(text) => text.replace(QUOTED, `$1$2$3${FILTERED}$3`),
	// `token=...`, `"client_secret": "..."`. После голого двоеточия слово остаётся:
	// `token: expired` не секрет.
	(text) =>
		text.replace(PAIR, (all, key: string, separator: string, quote: string, value: string) =>
			separator.includes('=') || quote || notWord(value) ? `${key}${separator}${quote}${FILTERED}` : all,
		),
	// JWT и JWE: заголовок base64url от `{"` всегда начинается с `eyJ`, у JWE пять частей.
	(text) => text.replace(/\beyJ[\w-]+(?:\.[\w-]*){1,4}/g, FILTERED),
	// Токен бота Telegram, и в адресе `/bot<token>/` тоже.
	(text) => text.replace(/(?<!\d)\d{5,}:[\w-]{30,}/g, FILTERED),
	// UUID: в таком виде API-токены выдают многие сервисы.
	(text) => text.replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, FILTERED),
	(text) => text.replace(/\b[\da-f]{32,}\b/gi, FILTERED),
	// Длинный base64url или base64 без `/`: ключи, подписи, непрозрачные токены.
	(text) => text.replace(/(?<![\w+-])[\w+-]{32,}={0,2}/g, (match) => (random(match) ? FILTERED : match)),
]

let own: Replace[] = []

/**
 * Добавить правила сервиса ко встроенным: они работают везде, где кит чистит текст, в Sentry
 * и в логе. Правила сервиса идут первыми, поэтому точное значение секрета заменяется целиком.
 */
export function addScrubRules(...rules: ScrubRule[]): void {
	own = [...own, ...rules.flatMap(toReplace)]
}

function toReplace(rule: ScrubRule): Replace[] {
	if (typeof rule === 'function') return [rule]

	if (typeof rule === 'string') return rule ? [(text) => text.replaceAll(rule, FILTERED)] : []

	// Без `g` заменилось бы только первое совпадение.
	const global = rule.global ? rule : new RegExp(rule.source, `${rule.flags}g`)

	return [(text) => text.replace(global, FILTERED)]
}

/** Текст без секретов: токенов, значений query, userinfo в адресах, заголовков авторизации и cookie. */
export function scrub(text: string): string {
	if (!text) return text

	return [...own, ...BUILTIN].reduce((current, replace) => replace(current), text)
}

/** Значения всех пар `ключ=значение` в query или фрагменте, имена остаются. */
function scrubQuery(query: string): string {
	return query.replace(/(^|[?&#;])([^=&#;]*)=[^&#;]+/g, `$1$2=${FILTERED}`)
}

// Идентификаторы события и трейса Sentry сам связывает между собой, они не секрет.
const IDS = new Set(['event_id', 'trace_id', 'span_id', 'parent_span_id', 'segment_id', 'profile_id', 'replay_id'])
const QUERY_FIELD = /(?:^|[._])(?:query|fragment|query_string)$/i

/**
 * Копия значения без секретов. Объекты события SDK делит со scope, поэтому не меняем их,
 * а собираем новые. Процессор на чужом scope видит событие до нормализации, где бывают
 * циклы и любая вложенность: глубже предела объект уходит целиком в `[Filtered]`.
 */
function scrubValue(value: unknown, key = '', depth = 0): unknown {
	if (IDS.has(key)) return value

	if (key && SECRET_FIELD.test(key) && (typeof value === 'string' || (value !== null && typeof value === 'object')))
		return FILTERED

	if (typeof value === 'string') return QUERY_FIELD.test(key) ? scrubQuery(value) : scrub(value)

	if (value === null || typeof value !== 'object') return value

	if (depth > 10) return FILTERED

	if (Array.isArray(value)) return value.map((item) => scrubValue(item, '', depth + 1))

	return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, k, depth + 1)]))
}

type Frame = { filename?: string; abs_path?: string; vars?: unknown }
type Exception = {
	value?: string
	mechanism?: { data?: unknown }
	stacktrace?: { frames?: Frame[] }
}
type Breadcrumb = { message?: string; data?: unknown }
type Request = {
	url?: string
	query_string?: unknown
	cookies?: unknown
	headers?: Record<string, string>
	data?: unknown
	env?: unknown
}
type Span = { description?: string; data?: unknown }
type SentryEvent = {
	message?: string
	logentry?: unknown
	exception?: { values?: Exception[] }
	request?: Request
	breadcrumbs?: Breadcrumb[]
	extra?: unknown
	contexts?: unknown
	tags?: unknown
	transaction?: string
	spans?: Span[]
}

function scrubException(exception: Exception): Exception {
	const { value, mechanism, stacktrace } = exception

	return {
		...exception,
		...(typeof value === 'string' && { value: scrub(value) }),
		...(mechanism?.data !== undefined && { mechanism: { ...mechanism, data: scrubValue(mechanism.data) } }),
		...(stacktrace?.frames && {
			stacktrace: {
				...stacktrace,
				// Кадр SDK собирает из строк стека, а в них может затесаться текст ошибки.
				frames: stacktrace.frames.map(({ filename, abs_path: path, vars, ...frame }) => ({
					...frame,
					...(typeof filename === 'string' && { filename: scrub(filename) }),
					...(typeof path === 'string' && { abs_path: scrub(path) }),
					...(vars !== undefined && { vars: scrubValue(vars) }),
				})),
			},
		}),
	}
}

function scrubRequest({ url, query_string: query, cookies, headers, data, env, ...rest }: Request): Request {
	return {
		...rest,
		...(typeof url === 'string' && { url: scrub(url) }),
		...(query !== undefined && { query_string: scrubQueryString(query) }),
		// Cookie и тело уходят целиком: в теле формы входа сам токен, в cookie сессия.
		...(cookies !== undefined && { cookies: FILTERED }),
		...(data !== undefined && { data: FILTERED }),
		...(headers && { headers: scrubValue(headers) as Record<string, string> }),
		...(env !== undefined && { env: scrubValue(env) }),
	}
}

function scrubQueryString(query: unknown): unknown {
	if (typeof query === 'string') return scrubQuery(query)

	// Объект или пары `[имя, значение]`: имена остаются, значения нет.
	if (Array.isArray(query)) return query.map((pair) => [Array.isArray(pair) ? pair[0] : '', FILTERED])

	return Object.fromEntries(Object.keys(query ?? {}).map((name) => [name, FILTERED]))
}

/** Хлебная крошка без секретов: `beforeBreadcrumb` для `Sentry.init`. Возвращает копию. */
export function scrubBreadcrumb<T extends object>(breadcrumb: T): T {
	const { message, data } = breadcrumb as Breadcrumb

	return {
		...breadcrumb,
		...(typeof message === 'string' && { message: scrub(message) }),
		...(data !== undefined && { data: scrubValue(data) }),
	}
}

/**
 * Событие без секретов: текст исключений и сообщения, `extra`, `contexts`, теги, запрос,
 * хлебные крошки и спаны. Это `beforeSend` клиента кита; сервер, который заводит Sentry сам,
 * ставит её в свой `beforeSend` и `beforeSendTransaction`.
 */
export function scrubEvent<T extends object>(event: T): T {
	const e = event as SentryEvent

	if (typeof e.message === 'string') e.message = scrub(e.message)

	if (e.logentry !== undefined) e.logentry = scrubValue(e.logentry)

	if (e.exception?.values) e.exception = { ...e.exception, values: e.exception.values.map(scrubException) }

	if (e.request) e.request = scrubRequest(e.request)

	if (e.breadcrumbs) e.breadcrumbs = e.breadcrumbs.map(scrubBreadcrumb)

	if (e.extra !== undefined) e.extra = scrubValue(e.extra)

	if (e.contexts !== undefined) e.contexts = scrubValue(e.contexts)

	if (e.tags !== undefined) e.tags = scrubValue(e.tags)

	if (typeof e.transaction === 'string') e.transaction = scrub(e.transaction)

	if (e.spans) {
		e.spans = e.spans.map((span) => ({
			...span,
			...(typeof span.description === 'string' && { description: scrub(span.description) }),
			...(span.data !== undefined && { data: scrubValue(span.data) }),
		}))
	}

	return event
}
