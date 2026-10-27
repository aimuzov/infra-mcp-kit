/**
 * Контекст входа, который кит кладёт во фрагмент адреса статической страницы: подписанный
 * запрос авторизации, путь колбэка, клиент и ошибка прошлой попытки. Фрагмент не уходит
 * на сервер и не оседает в логах прокси, а статической странице его больше взять неоткуда.
 */
export type LoginContext = {
	request: string
	callback: string
	client: string
	host: string
	error: string
	/** Telegram id для входа без виджета, только на localhost. */
	dev: string
	/** Поля формы, которые сервер в этом запуске не спрашивает: `hide` у `tokenFormLogin`. */
	hide: string[]
}

export function readLoginContext(hash = location.hash): LoginContext {
	const params = new URLSearchParams(hash.replace(/^#/, ''))
	const get = (key: string) => params.get(key) ?? ''

	return {
		request: get('request'),
		callback: get('callback'),
		client: get('client'),
		host: get('host'),
		error: get('error'),
		dev: get('dev'),
		hide: get('hide').split(',').filter(Boolean),
	}
}

/** Колбэк входа с запросом в query: так его ждут виджет Telegram и dev-ссылка. */
export function callbackUrl({ callback, request }: LoginContext, origin = location.origin): URL {
	const url = new URL(callback || '/', origin)

	url.searchParams.set('request', request)

	return url
}
