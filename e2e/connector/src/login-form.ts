// Форма входа одним модулем: её берут и `astro.config.mjs` для страницы, и сервер
// для `tokenFormLogin`. Так поля описаны один раз, а не связаны только именами.
import { defineTokenForm } from '@aimuzov/infra-mcp-kit/astro'

export const loginForm = defineTokenForm({
	title: { ru: 'Подключение fixture', en: 'Connecting fixture' },
	// Строкой с переводом по ключу `tokenForm.lead` в `service.strings`: так тоже можно.
	lead: 'Вставь API-токен сервиса: он уедет только в зашифрованный токен доступа.',
	fields: [
		{
			// Адрес пространства сервер может знать сам, тогда поле прячет `hide`.
			name: 'space',
			label: { ru: 'Адрес пространства', en: 'Space address' },
			type: 'url',
			placeholder: 'https://space.example.com',
		},
		{
			name: 'token',
			label: { ru: 'API-токен', en: 'API token' },
			type: 'password',
			hint: { ru: 'Настройки → API', en: 'Settings → API' },
		},
	],
})
