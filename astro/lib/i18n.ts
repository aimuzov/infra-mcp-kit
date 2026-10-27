import { pick, toLocale, withKitStrings, type Localized } from '@aimuzov/infra-mcp-kit/i18n'
import { t } from '@aimuzov/infra-site-kit/i18n.js'
import config from 'virtual:infra-mcp-kit/pages'

const strings = withKitStrings(config.service.strings)

/** Строка страницы: свои строки сервиса, затем кита, затем общие из site-kit. */
export function pt(locale: string, key: string, vars?: Record<string, string | number>): string {
	return t(locale, key, vars, strings)
}

/**
 * Поле конфига mcpPages на языке страницы: перевод из `service.strings` по ключу или само
 * поле, как оно записано в конфиге, строкой или по языкам `{ ru, en }`.
 */
export function own(locale: string, key: string, value: Localized): string
export function own(locale: string, key: string, value: Localized | undefined): string | undefined
export function own(locale: string, key: string, value: Localized | undefined): string | undefined {
	return config.service.strings?.[toLocale(locale)]?.[key] ?? pick(value, locale)
}

/**
 * `getStaticPaths` для своих страниц сервиса на всех его языках: файл
 * `pages/[...lang]/account.astro` соберётся в `/account` и `/en/account`.
 */
export function localePaths() {
	return (config.locales ?? ['ru']).map((locale) => ({ params: { lang: locale === 'ru' ? undefined : locale } }))
}
