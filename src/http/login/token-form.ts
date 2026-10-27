import { LoginError, type Grant, type Login } from '#kit/http/oauth/provider'
import { allLocales, pick } from '#kit/i18n'
import { checkTokenFields, type TokenFormField } from '#kit/token-form'

export type TokenFormLoginOptions = {
	/**
	 * Поля формы, те же, что в `tokenForm.fields` у `mcpPages`: по ним сервер собирает значения.
	 * Одним источником их даёт `defineTokenForm`: `fields: loginForm.fields`.
	 */
	fields: readonly TokenFormField[]
	/**
	 * Поля, которых на форме в этом запуске нет: их значение сервер знает сам, например из env.
	 * Остров прячет их по фрагменту, а сервер не требует и не берёт из формы: в `values` у
	 * `verify` их нет, даже если кто-то их прислал. Имена -- латиница, цифры, `_`, `-` и `.`.
	 */
	hide?: readonly string[]
	/**
	 * Проверить введённое и сказать, кто это. Обычно здесь стучатся в API сервиса с этим токеном.
	 * `LoginError` вернёт человека на форму с текстом ошибки.
	 */
	verify(values: Record<string, string>): Grant | Promise<Grant>
	/** Статическая страница формы, по умолчанию `/login` из `mcpPages`. */
	page?: string
}

/** Имя скрываемого поля: латиница, цифры, `_`, `-` и `.`, без разделителя списка. */
const HIDDEN_NAME = /^[\w.-]+$/

/**
 * Вход по токену стороннего сервиса, как у kaiten: человек вставляет свой API-ключ, кит
 * кладёт его в claims. С ним `Tokens` нужен в режиме `encrypt`, иначе ключ поедет
 * в токене доступа открытым текстом.
 */
export function tokenFormLogin(options: TokenFormLoginOptions): Login {
	checkTokenFields(options.fields)

	const hide = new Set(options.hide)
	// Список едет во фрагменте через запятую: запятая в имени разрезала бы его на два поля.
	const unfit = [...hide].filter((name) => !HIDDEN_NAME.test(name))

	if (unfit.length) throw new Error(`В hide неподходящие имена полей: ${unfit.map((n) => `"${n}"`).join(', ')}`)

	const unknown = [...hide].filter((name) => !options.fields.some((field) => field.name === name))

	// Опечатка в имени оставила бы поле на форме, а сервер молча ждал бы его из env.
	if (unknown.length) throw new Error(`В hide поля, которых нет в форме: ${unknown.join(', ')}`)

	const fields = options.fields.filter((field) => !hide.has(field.name))

	return {
		sealsSecrets: true,
		page: options.page ?? '/login',
		...(hide.size ? { context: { hide: [...hide].join(',') } } : {}),
		async complete({ method, form }) {
			if (method !== 'POST') throw new LoginError(allLocales('login.resend'))

			const values: Record<string, string> = {}

			for (const field of fields) {
				const value = (form[field.name] ?? '').trim()

				if (!value && field.required !== false)
					throw new LoginError({
						ru: allLocales('login.required', { field: pick(field.label, 'ru') ?? field.name }).ru,
						en: allLocales('login.required', { field: pick(field.label, 'en') ?? field.name }).en,
					})

				values[field.name] = value
			}

			return options.verify(values)
		},
	}
}
