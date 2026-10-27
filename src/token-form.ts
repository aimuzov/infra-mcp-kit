import type { Localized } from '#kit/i18n'

/**
 * Поле формы входа по токену. Одно описание на страницу и сервер: страница рисует поле,
 * сервер по `name` собирает значения и по `label` пишет ошибку. Тексты -- строкой или по
 * языкам: `{ ru: 'API-токен', en: 'API token' }`.
 */
export type TokenFormField = {
	/** Имя поля в форме и ключ в `values` у `verify`. */
	name: string
	label: Localized
	type?: 'text' | 'password' | 'url' | 'email'
	placeholder?: Localized
	/** Подсказка у подписи: где взять значение. */
	hint?: Localized
	required?: boolean
}

/** Форма входа по токену: `tokenForm` у `mcpPages`, а её `fields` -- у `tokenFormLogin`. */
export type TokenForm = {
	title: Localized
	lead?: Localized
	submit?: Localized
	fields: readonly TokenFormField[]
}

/**
 * Форма входа по токену одним модулем, который берут и `astro.config.mjs`, и сервер:
 *
 * ```ts
 * export const loginForm = defineTokenForm({ title: 'Вход', fields: [{ name: 'token', label: 'API-токен' }] })
 *
 * mcpPages({ service, tokenForm: loginForm })
 * tokenFormLogin({ fields: loginForm.fields, verify })
 * ```
 *
 * Отдаёт форму как есть, а повтор имени или имя `request` роняет сборку и старт сервера сразу.
 */
export function defineTokenForm<T extends TokenForm>(form: T): T {
	checkTokenFields(form.fields)

	return form
}

/** Имена полей формы: непустые, без повторов и не `request`. Иначе форма сломалась бы молча. */
export function checkTokenFields(fields: readonly TokenFormField[]): void {
	const names = new Set<string>()

	for (const { name } of fields) {
		// В `request` форма везёт подписанный запрос входа: поле с этим именем затёрло бы его.
		if (!name || name === 'request') throw new Error(`Неподходящее имя поля формы входа: "${name}"`)

		if (names.has(name)) throw new Error(`Поле формы входа "${name}" описано дважды`)

		names.add(name)
	}
}
