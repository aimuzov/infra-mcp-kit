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

// Имя из слов, `getOAuthProtectedResourceMetadataUrl`: у случайной строки за заглавными
// почти никогда не идут по две строчные подряд по всей длине.
const IDENTIFIER = /^[a-z]*(?:[A-Z]+[a-z]{2,})+[A-Z]*$/

// Длинная случайная строка: цифры вперемешку с буквами или смешанный регистр без разделителей слов.
const random = (value: string) =>
	(/\d/.test(value) && /[a-z]/i.test(value)) ||
	(/[a-z]/.test(value) && /[A-Z]/.test(value) && !/[_-]/.test(value) && !IDENTIFIER.test(value))

// Ключ, значение которого секрет целиком: `KAITEN_API_TOKEN`, `client_secret`, `x-api-key`.
// Длина вокруг слова ограничена: без предела длинная строка через дефисы разбиралась бы за квадрат.
const SECRET_KEY = String.raw`[\w-]{0,40}(?:token|secret|passw(?:or)?d|api[_-]?key|credential|signature|session[_-]?id|authorization)[\w-]{0,40}`

const SECRET_FIELD =
	/token|secret|passw(?:or)?d|api[_-]?key|credential|signature|session[_-]?id|cookie|authorization|^auth$/i

// Счётчик токенов модели, `max_tokens: 4096`: число под таким ключом не секрет.
const COUNTER = /tokens$/i

// После голого двоеточия так пишут о состоянии ключа, а не о его значении: `token: expired`.
const STATE =
	/^(?:required|missing|invalid|expired|empty|wrong|incorrect|revoked|rejected|denied|unknown|malformed|not|none|null|undefined|true|false|is|was|must|should|cannot|too)[.!?:]*$/i

// Параметр схемы из `WWW-Authenticate`, `Bearer realm="mcp"`, а не токен.
const AUTH_PARAM = /^(?:realm|scope|error|error_description|error_uri|charset|resource_metadata)=/i

// Уже вычищенное не трогаем, иначе вторая чистка съела бы пробел перед `[Filtered]`.
const NOT_FILTERED = String.raw`(?![\s"'\\]*\[Filtered\])`

// Начало имени: граница слова или экранированный перевод строки, `\nCookie:` внутри JSON.
const EDGE = String.raw`(?:\b|(?<=\\[nrt]))`

// Строка в кавычках до закрывающей, экранированные кавычки внутри не в счёт.
const STRING = String.raw`"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'`

// Заголовок в тексте: `Cookie: ...`, `"authorization": "..."`, массив `"set-cookie": [...]`,
// пара `['cookie', '...']` и `Map` из util.inspect, `'cookie' => '...'`. Значение без кавычек
// идёт до конца строки, как в HTTP: в нём бывают кавычки, `Digest username="..."`.
const HEADER = new RegExp(
	String.raw`${EDGE}((?:proxy-)?authorization|(?:set-)?cookie)(\\?["']?\s*(?:=>|:)\s*|["']\s*,\s*)${NOT_FILTERED}(?:(\[\s*(?:(?:${STRING})\s*(?:,\s*)?)*\])|(${STRING})|[^\r\n]+)`,
	'gi',
)
const BEARER = new RegExp(String.raw`${EDGE}(Bearer|Basic)(\s+)([\w~+/.=-]+)`, 'gi')
// Значение в кавычках до закрывающей: в нём бывают пробелы и запятые. Кавычки бывают
// экранированными, когда JSON лежит строкой внутри другого JSON.
const QUOTED = new RegExp(
	String.raw`\b(${SECRET_KEY})(\\?["']?\s*(?:=>|:|=(?!>))\s*)(\\?["'])${NOT_FILTERED}(?:(?!\3)(?:\\.|[^\\\r\n]))*\3`,
	'gi',
)
const PAIR = new RegExp(
	String.raw`\b(${SECRET_KEY})(\\?["']?\s*(?:=>|:|=(?!>))\s*)(\\?["']?)${NOT_FILTERED}([^\s"'&,;)}\]]+)`,
	'gi',
)

const BUILTIN: Replace[] = [
	// `https://user:pass@host`. Схема короткая: без предела строка через дефисы
	// разбиралась бы за квадрат.
	(text) => text.replace(/\b([a-z][a-z\d+.-]{0,30}:\/\/)[^\s/?#@"'<>]+@/gi, `$1${FILTERED}@`),
	// Значения query и фрагмента: `?token=`, `&code=`, `#access_token=`. Имена остаются, по ним видно запрос.
	(text) => text.replace(/([?&#])([^\s=?&#"'<>]+)=[^\s&#"'<>]+/g, `$1$2=${FILTERED}`),
	// Первая пара тела формы, `code=...&state=...`: у неё нет `?` впереди.
	(text) => text.replace(/(^|[\s"'(])([\w.%-]+)=[^\s&#"'<>]+(?=&)/g, `$1$2=${FILTERED}`),
	// Заголовки в тексте: значение целиком, у cookie это все пары разом, у массива все элементы.
	(text) =>
		text.replace(HEADER, (_all, name: string, separator: string, list?: string, quoted?: string) =>
			// У строки в кавычках кавычки остаются: после неё текст уже не заголовок.
			list || !quoted
				? `${name}${separator}${FILTERED}`
				: `${name}${separator}${quoted[0]}${FILTERED}${quoted[0]}`,
		),
	(text) =>
		text.replace(BEARER, (all, scheme: string, space: string, value: string) =>
			notWord(value) && !AUTH_PARAM.test(value) ? `${scheme}${space}${FILTERED}` : all,
		),
	(text) => text.replace(QUOTED, `$1$2$3${FILTERED}$3`),
	// `token=...`, `"client_secret": "..."`.
	(text) =>
		text.replace(PAIR, (all, key: string, separator: string, quote: string, value: string) => {
			if (COUNTER.test(key) && /^\d+$/.test(value)) return all

			if (!separator.includes('=') && !quote && STATE.test(value)) return all

			return `${key}${separator}${quote}${FILTERED}`
		}),
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

/**
 * Query или фрагмент целиком: остаются только имена параметров. Сегмент без `=`, как
 * `?<token>` в ссылке входа, -- тоже значение.
 */
function scrubQuery(query: string): string {
	return scrub(query).replace(/([&;]|^[?#]?)([^&;]*)/g, (all, lead: string, part: string) => {
		if (!part) return all

		const name = part.indexOf('=')

		return `${lead}${name < 0 ? FILTERED : `${part.slice(0, name)}=${FILTERED}`}`
	})
}

// Идентификаторы события и трейса Sentry сам связывает между собой, они не секрет.
const IDS = new Set(['event_id', 'trace_id', 'span_id', 'parent_span_id', 'segment_id', 'profile_id', 'replay_id'])
const QUERY_FIELD = /(?:^|[._])(?:query|fragment|query_string)$/i

// Под ключом вроде `password` секрет любое значение, кроме пустого и флага. Число тоже:
// PIN, код из письма.
const secretField = (key: string, value: unknown) =>
	SECRET_FIELD.test(key) &&
	value !== null &&
	value !== undefined &&
	typeof value !== 'boolean' &&
	!(typeof value === 'number' && COUNTER.test(key))

function clean(value: unknown, key: string, depth: number): unknown {
	if (IDS.has(key)) return value

	if (key && secretField(key, value)) return FILTERED

	if (typeof value === 'string') return QUERY_FIELD.test(key) ? scrubQuery(value) : scrub(value)

	if (value === null || typeof value !== 'object') return value

	if (depth > 10) return FILTERED

	if (Array.isArray(value)) return value.map((item) => clean(item, '', depth + 1))

	// Имя ключа тоже бывает секретом: токен как ключ словаря сессий.
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), clean(v, k, depth + 1)]))
}

/**
 * Копия значения без секретов: строки через `scrub`, под ключами вроде `token` и `password`
 * значение целиком. Объекты события SDK делит со scope, поэтому не меняем их, а собираем
 * новые. Процессор на чужом scope видит событие до нормализации, где бывают циклы и любая
 * вложенность: глубже предела объект уходит целиком в `[Filtered]`.
 */
export function scrubValue(value: unknown): unknown {
	return clean(value, '', 0)
}

type Exception = {
	value?: string
	mechanism?: { data?: unknown }
	stacktrace?: { frames?: unknown[] }
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
type Span = { name?: string; description?: string; data?: unknown; attributes?: unknown; links?: unknown[] }
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
		// Кадр SDK собирает из строк стека, а строкой стека становится и строка текста ошибки
		// с `at X (`: тогда секрет оказывается в `function`, `filename` или `module` кадра.
		...(stacktrace?.frames && { stacktrace: { ...stacktrace, frames: stacktrace.frames.map(scrubValue) } }),
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
	if (Array.isArray(query))
		return query.map((pair) => [Array.isArray(pair) && typeof pair[0] === 'string' ? scrub(pair[0]) : '', FILTERED])

	return Object.fromEntries(Object.keys(query ?? {}).map((name) => [scrub(name), FILTERED]))
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
 * Спан без секретов: `beforeSendSpan` для `Sentry.init`. Понимает и потоковый спан SDK 11
 * (`name`, `attributes`), и спан внутри транзакции (`description`, `data`). Возвращает копию.
 */
export function scrubSpan<T extends object>(span: T): T {
	const { name, description, data, attributes, links } = span as Span

	return {
		...span,
		...(typeof name === 'string' && { name: scrub(name) }),
		...(typeof description === 'string' && { description: scrub(description) }),
		...(data !== undefined && { data: scrubValue(data) }),
		...(attributes !== undefined && { attributes: scrubValue(attributes) }),
		...(Array.isArray(links) && { links: links.map(scrubValue) }),
	}
}

/**
 * Событие без секретов: текст исключений и их кадры, сообщение, `extra`, `contexts`, теги,
 * запрос, хлебные крошки и спаны. Это `beforeSend` клиента кита; сервер, который заводит
 * Sentry сам, ставит её в свой `beforeSend`.
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

	if (e.spans) e.spans = e.spans.map(scrubSpan)

	return event
}
