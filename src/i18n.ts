// Те же правила, что у i18n.js в infra-site-kit, только для сервера. Site-kit -- зависимость
// сборки страниц, а не рантайма: тянуть его в `npx` ради сорока строк незачем.

/** Языки страниц: русский по умолчанию без префикса, английский под `/en/`. */
export type Locale = 'ru' | 'en'

/** Свои строки сервиса по языкам, поверх строк кита и site-kit. */
export type Strings = Partial<Record<Locale, Record<string, string>>>

export const LOCALES: readonly Locale[] = ['ru', 'en']
export const DEFAULT_LOCALE: Locale = 'ru'
/** Cookie с явным выбором языка, его ставит переключатель site-kit. */
export const LOCALE_COOKIE = 'lang'

export function toLocale(value: string | null | undefined): Locale {
	return LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE
}

/** Язык страницы по первому сегменту пути. */
export function localeOfPath(pathname: string): Locale {
	const first = pathname.split('/')[1]

	return first !== DEFAULT_LOCALE && LOCALES.includes(first as Locale) ? (first as Locale) : DEFAULT_LOCALE
}

/** Тот же путь на другом языке: `/login` → `/en/login` и обратно. */
export function localizePath(pathname: string, locale: string): string {
	const current = localeOfPath(pathname)
	const bare = current === DEFAULT_LOCALE ? pathname : pathname.slice(current.length + 1) || '/'

	return toLocale(locale) === DEFAULT_LOCALE ? bare : `/${locale}${bare}`
}

/** Лучший поддерживаемый язык из `Accept-Language` с учётом весов `q`. */
export function negotiateLocale(header: string | null | undefined): Locale {
	const ranked = (header ?? '')
		.split(',')
		.map((part) => {
			const [tag = '', ...params] = part.trim().split(';')
			const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))

			return { lang: tag.toLowerCase().split('-')[0] ?? '', q: q ? Number(q.slice(2)) : 1 }
		})
		.filter(({ lang, q }) => lang && q > 0)
		.sort((a, b) => b.q - a.q)

	return toLocale(ranked.find(({ lang }) => LOCALES.includes(lang as Locale))?.lang)
}

/** Текст конфига на одном языке или по языкам: `'Вход'` или `{ ru: 'Вход', en: 'Sign in' }`. */
export type Localized = string | Partial<Record<Locale, string>>

/** Строки страниц и сервера кита. Общие части (подпись, 404, тема) -- в словарях site-kit. */
export const KIT_STRINGS = {
	ru: {
		'brand.label': 'MCP-коннектор',
		'tools.title': 'Инструменты',
		'connect.title': 'Подключить',
		'connect.urlLabel': 'адрес коннектора',
		'connect.where': 'Где подключить',
		'connect.tabApp': 'claude.ai и Desktop',
		'connect.appPaste': 'Вставь адрес и войди.',
		'connect.codeBefore': 'Выполни в терминале, затем',
		'connect.codeAfter': 'для входа:',
		'connect.command': 'команду',
		'login.title': 'Вход в {service}',
		'login.submit': 'Подключить',
		'login.client': 'Клиент',
		'login.fromHost': 'с адреса',
		'login.clientFromHost': 'Клиент с адреса',
		'login.asks': '{client} просит доступ к {service}',
		'login.broken': 'Ссылка для входа неполная. Начни подключение заново из клиента.',
		'login.dev': 'Войти как {id} (dev)',
		'login.ignore': 'Если ты не начинал подключение сам, просто закрой страницу.',
		'error.title': 'Ошибка',
		'error.default': 'Что-то пошло не так',
		'account.eyebrow': 'Кабинет',
		'account.loading': 'Загружаем кабинет',
		'account.guest': 'Войди, чтобы увидеть свои данные.',
		'account.needLogin': 'Нужно войти',
		'account.login': 'Войти',
		'account.failTitle': 'Кабинет не загрузился',
		'account.failText': 'Обнови страницу или зайди чуть позже.',
		'account.hello': 'Привет, {name}',
		'server.brokenTitle': 'Что-то сломалось',
		'server.later': 'Попробуй ещё раз чуть позже.',
		'server.unauthorized': 'Нужно войти',
		'server.foreignOrigin': 'Запрос пришёл не со страницы сервиса',
		'login.resend': 'Отправь форму ещё раз',
		'login.required': 'Заполни поле «{field}»',
		'login.telegramFailed': 'Telegram не подтвердил вход, попробуй ещё раз',
		'login.linkUsed': 'Эта ссылка входа уже использована, войди ещё раз',
		'oauth.expired': 'Ссылка для входа устарела',
		'oauth.restart': 'Начни подключение заново из клиента.',
		'oauth.unknownClient': 'Клиент не зарегистрирован',
		'oauth.failed': 'Не получилось войти',
	},
	en: {
		'brand.label': 'MCP connector',
		'tools.title': 'Tools',
		'connect.title': 'Connect',
		'connect.urlLabel': 'the connector address',
		'connect.where': 'Where to connect',
		'connect.tabApp': 'claude.ai and Desktop',
		'connect.appPaste': 'Paste the address and sign in.',
		'connect.codeBefore': 'Run this in a terminal, then',
		'connect.codeAfter': 'to sign in:',
		'connect.command': 'the command',
		'login.title': 'Sign in to {service}',
		'login.submit': 'Connect',
		'login.client': 'Client',
		'login.fromHost': 'from',
		'login.clientFromHost': 'A client from',
		'login.asks': '{client} asks for access to {service}',
		'login.broken': 'The sign-in link is incomplete. Start connecting again from the client.',
		'login.dev': 'Sign in as {id} (dev)',
		'login.ignore': 'If you did not start connecting yourself, just close this page.',
		'error.title': 'Error',
		'error.default': 'Something went wrong',
		'account.eyebrow': 'Account',
		'account.loading': 'Loading your account',
		'account.guest': 'Sign in to see your data.',
		'account.needLogin': 'Sign in first',
		'account.login': 'Sign in',
		'account.failTitle': 'The account did not load',
		'account.failText': 'Reload the page or come back a bit later.',
		'account.hello': 'Hi, {name}',
		'server.brokenTitle': 'Something broke',
		'server.later': 'Try again a bit later.',
		'server.unauthorized': 'Sign in first',
		'server.foreignOrigin': 'The request did not come from a page of this service',
		'login.resend': 'Send the form again',
		'login.required': 'Fill in the field “{field}”',
		'login.telegramFailed': 'Telegram did not confirm the sign-in, try again',
		'login.linkUsed': 'This sign-in link has already been used, sign in again',
		'oauth.expired': 'The sign-in link has expired',
		'oauth.restart': 'Start connecting again from the client.',
		'oauth.unknownClient': 'The client is not registered',
		'oauth.failed': 'Could not sign in',
	},
} satisfies Record<Locale, Record<string, string>>

export type KitKey = keyof (typeof KIT_STRINGS)['ru']

/** Строка кита с подстановкой `{name}`, для текстов сервера. Страницы берут `pt` из astro/lib. */
export function kt(locale: string, key: KitKey, vars?: Record<string, string | number>): string {
	const text: string = KIT_STRINGS[toLocale(locale)][key] ?? KIT_STRINGS.ru[key]

	return vars ? text.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all)) : text
}

/** Свои словари сервиса поверх строк кита: так их понимает `t` из site-kit. */
export function withKitStrings(service?: Strings): Strings {
	return {
		ru: { ...KIT_STRINGS.ru, ...service?.ru },
		en: { ...KIT_STRINGS.en, ...service?.en },
	}
}

/** Строка кита сразу на всех языках: так её понимают `LoginError` и тексты по языкам. */
export function allLocales(key: KitKey, vars?: Record<string, string | number>): Record<Locale, string> {
	return { ru: kt('ru', key, vars), en: kt('en', key, vars) }
}

/** Текст конфига на нужном языке: без перевода -- русский, без русского -- любой. */
export function pick(value: Localized | undefined, locale: string): string | undefined {
	if (value === undefined || typeof value === 'string') return value

	return value[toLocale(locale)] ?? value[DEFAULT_LOCALE] ?? Object.values(value)[0]
}

/**
 * Язык запроса для текстов сервера: путь `/en/…`, затем явный выбор в cookie, затем
 * `Accept-Language`. Так ответ колбэка входа говорит на языке страницы, с которой пришли.
 */
export function requestLocale(request: Request): Locale {
	const locale = guessLocale(request)

	return enabled.includes(locale) ? locale : DEFAULT_LOCALE
}

// Языки, на которых у сервиса есть страницы. `createHttpApp` сужает их по сборке mcpPages:
// без английских страниц английский текст ошибки на русской странице был бы чужим.
let enabled: readonly Locale[] = LOCALES

export function enableLocales(locales: readonly Locale[]): void {
	enabled = locales.length > 0 ? locales : [DEFAULT_LOCALE]
}

export function enabledLocales(): readonly Locale[] {
	return enabled
}

function guessLocale(request: Request): Locale {
	const { pathname } = new URL(request.url)

	if (localeOfPath(pathname) !== DEFAULT_LOCALE) return localeOfPath(pathname)

	// Колбэк формы входа и API кабинета зовутся со страницы сервиса: её язык и берём.
	const referer = request.headers.get('referer')

	if (referer && URL.canParse(referer) && new URL(referer).host === new URL(request.url).host) {
		return localeOfPath(new URL(referer).pathname)
	}

	return cookieLocale(request) ?? negotiateLocale(request.headers.get('accept-language'))
}

/** Явный выбор языка из cookie или `undefined`, если человек его не делал. */
export function cookieLocale(request: Request): Locale | undefined {
	const cookie = request.headers.get('cookie') ?? ''
	const match = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([a-z]{2})`))

	return match ? toLocale(match[1]) : undefined
}
