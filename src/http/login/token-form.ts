import { LoginError, type Grant, type Login } from '#kit/http/oauth/provider'

/** Поле формы, как его описывает `mcpPages({ tokenForm })`: серверу нужны имя и подпись. */
export type TokenFormField = {
	name: string
	label: string
	required?: boolean
}

export type TokenFormLoginOptions = {
	/** Те же поля, что в `tokenForm.fields` у `mcpPages`: по ним сервер собирает значения. */
	fields: TokenFormField[]
	/**
	 * Проверить введённое и сказать, кто это. Обычно здесь стучатся в API сервиса с этим токеном.
	 * `LoginError` вернёт человека на форму с текстом ошибки.
	 */
	verify(values: Record<string, string>): Grant | Promise<Grant>
	/** Статическая страница формы, по умолчанию `/login` из `mcpPages`. */
	page?: string
}

/**
 * Вход по токену стороннего сервиса, как у kaiten: человек вставляет свой API-ключ, кит
 * кладёт его в claims. С ним `Tokens` нужен в режиме `encrypt`, иначе ключ поедет
 * в токене доступа открытым текстом.
 */
export function tokenFormLogin(options: TokenFormLoginOptions): Login {
	return {
		sealsSecrets: true,
		page: options.page ?? '/login',
		async complete(req) {
			if (req.method !== 'POST') throw new LoginError('Отправь форму ещё раз')

			const body = (req.body ?? {}) as Record<string, unknown>
			const values: Record<string, string> = {}

			for (const field of options.fields) {
				const value = String(body[field.name] ?? '').trim()

				if (!value && field.required !== false) throw new LoginError(`Заполни поле «${field.label}»`)

				values[field.name] = value
			}

			return options.verify(values)
		},
	}
}
