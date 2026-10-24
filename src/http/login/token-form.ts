import { LoginError, type Grant, type Login } from '#kit/http/oauth/provider'
import { tokenFormPage, type FormField } from '#kit/http/ui/index'

export type TokenFormLoginOptions = {
	title: string
	/** Абзац под заголовком: зачем токен и что с ним будет. */
	lead?: string
	fields: FormField[]
	submit?: string
	/**
	 * Проверить введённое и сказать, кто это. Обычно здесь стучатся в API сервиса с этим токеном.
	 * `LoginError` вернёт человека на форму с текстом ошибки.
	 */
	verify(values: Record<string, string>): Grant | Promise<Grant>
}

/**
 * Вход по токену стороннего сервиса, как у kaiten: человек вставляет свой API-ключ, кит
 * кладёт его в claims. С ним `Tokens` нужен в режиме `encrypt`, иначе ключ поедет
 * в токене доступа открытым текстом.
 */
export function tokenFormLogin(options: TokenFormLoginOptions): Login {
	return {
		render: ({ service, client, callbackUrl, request, error }) => {
			const action = new URL(callbackUrl)

			// Запрос едет скрытым полем, а не в query: так он не попадёт в логи прокси.
			action.search = ''

			return tokenFormPage({
				service,
				client,
				title: options.title,
				lead: options.lead,
				action: action.pathname,
				fields: options.fields,
				hidden: { request },
				submit: options.submit,
				error,
			})
		},
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
