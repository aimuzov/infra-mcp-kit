import { LOCALES, localizePath, pick, type Locale, type Localized, type Strings } from '#kit/i18n'

/** Свои карточки лендинга поверх его разметки: героя, "Подключить" и инструментов. */
export type PagesLanding = {
	cards?: PagesCard[]
}

/**
 * Карточка на лендинге: заголовок, абзац и ссылки, например дорога в кабинет. Тексты --
 * строкой или по языкам, а перевод по ключу `card.<id>.title`, `card.<id>.text`,
 * `card.<id>.link.<i>` в `service.strings` сильнее.
 */
export type PagesCard = {
	/** Имя карточки: ключи перевода и `data-card` на странице. Латиница, цифры, `-` и `_`. */
	id: string
	title: Localized
	text?: Localized
	links?: PagesLink[]
	/** После чего встать: героя, "Подключить" или инструментов. По умолчанию в конце. */
	after?: LandingPlace
}

export type PagesLink = {
	/**
	 * Путь страницы сервиса без языка (`/account`, на английской странице -- `/en/account`),
	 * `#якорь`, `https://` или `mailto:`. Внешняя ссылка открывается в новой вкладке.
	 */
	href: string
	label: Localized
	/** Главная кнопка. Остальные ссылки -- обведённые. */
	primary?: boolean
}

export type LandingPlace = 'hero' | 'connect' | 'tools'

const PLACES: readonly LandingPlace[] = ['hero', 'connect', 'tools']

/**
 * Карточки лендинга из конфига: без повторов имени, с заголовком и ссылками, которые можно
 * показать. Плохая карточка роняет сборку, а не тихо пропадает со страницы.
 */
export function checkLanding(
	landing: PagesLanding | undefined,
	strings?: Strings,
	locales: readonly Locale[] = LOCALES,
): void {
	const ids = new Set<string>()
	// Тот же текст, что покажет `own` на странице языка: перевод по ключу сильнее конфига.
	const filled = (key: string, value: Localized | undefined) =>
		locales.every((locale) => Boolean(strings?.[locale]?.[key] ?? pick(value, locale)))

	for (const card of landing?.cards ?? []) {
		if (!/^[\w-]+$/.test(card.id ?? '')) throw new Error(`Неподходящее имя карточки лендинга: "${card.id}"`)

		if (ids.has(card.id)) throw new Error(`Карточка лендинга "${card.id}" описана дважды`)

		ids.add(card.id)

		if (!filled(`card.${card.id}.title`, card.title)) {
			throw new Error(`У карточки лендинга "${card.id}" нет заголовка`)
		}

		if (card.after !== undefined && !PLACES.includes(card.after)) {
			throw new Error(`Карточка лендинга "${card.id}": after -- одно из ${PLACES.join(', ')}`)
		}

		for (const [i, link] of (card.links ?? []).entries()) {
			checkLink(card.id, link)

			if (!filled(`card.${card.id}.link.${i}`, link.label)) {
				throw new Error(`У ссылки "${link.href}" карточки "${card.id}" нет подписи`)
			}
		}
	}
}

// `href` встаёт как есть: `javascript:` и чужой хост под видом пути не пускаем.
// Браузер выкидывает из адреса переносы и табы, а `\` читает как `/`:
// `/\t/x` и `/\x` стали бы `//x`.
const SAFE_HREF = /^(?:\/(?!\/)|#|https?:\/\/|mailto:)/i
const UNSAFE_CHAR = /[\p{Cc}\\]/u

function checkLink(id: string, link: PagesLink): void {
	if (!SAFE_HREF.test(link.href ?? '') || UNSAFE_CHAR.test(link.href)) {
		throw new Error(`Ссылка "${link.href}" карточки "${id}": только путь, #якорь, http(s) или mailto`)
	}
}

/**
 * Адрес ссылки на странице языка `locale`: путь страницы сервиса получает префикс языка,
 * а якорь, внешний адрес, почта и файл вроде `/llms.txt` остаются как есть.
 */
export function landingHref(href: string, locale: string): string {
	const cut = href.search(/[?#]|$/)
	const path = href.slice(0, cut)

	if (!path.startsWith('/') || /\.\w+$/.test(path)) return href

	return localizePath(path, locale) + href.slice(cut)
}
