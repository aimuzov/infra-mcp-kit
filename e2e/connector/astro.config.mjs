// Коннектор-фикстура для e2e кита: так страницы собирает настоящий сервер.
// Кит подключён симлинком из node_modules, его ставит `e2e/pages.ts`.
import mcpPages from '@aimuzov/infra-mcp-kit/astro'
import svelte from '@astrojs/svelte'
import { defineConfig } from 'astro/config'

export default defineConfig({
	srcDir: './src/frontend',
	outDir: './build/public',
	integrations: [
		svelte(),
		mcpPages({
			service: {
				name: 'fixture',
				repo: 'https://github.com/aimuzov/infra-mcp-kit',
				tagline: 'Проверка страниц кита на Astro',
				lead: 'Статика из кита, данные под пользователя дорисовывают острова в браузере.',
				tools: [{ label: 'whoami', icon: 'user' }, 'пинг'],
				logo: './logo.svg',
				glitch: { a: '#f11f24', b: '#5fe8b0' },
				strings: {
					ru: {
						'fixture.accountTitle': 'Кабинет fixture',
						'fixture.corpus': 'Корпус',
						'fixture.data': 'Данные',
						'fixture.dataLead': 'Удалить корпус и выйти из кабинета.',
						'fixture.delete': 'Удалить корпус',
						'fixture.logout': 'Выйти',
					},
					en: {
						'service.tagline': 'A check of the kit pages on Astro',
						'service.lead': 'Static pages from the kit, islands in the browser draw the data of the user.',
						'tool.пинг': 'ping',
						'tokenForm.title': 'Connecting fixture',
						'tokenForm.lead':
							'Paste the API token of the service: it only travels inside the encrypted access token.',
						'field.token.label': 'API token',
						'field.token.hint': 'Settings → API',
						'telegram.grant.0': 'read your data',
						'telegram.grant.1': 'write on your behalf',
						'fixture.accountTitle': 'fixture account',
						'fixture.corpus': 'Corpus',
						'fixture.data': 'Data',
						'fixture.dataLead': 'Delete the corpus and sign out.',
						'fixture.delete': 'Delete the corpus',
						'fixture.logout': 'Sign out',
					},
				},
			},
			locales: ['ru', 'en'],
			tokenForm: {
				title: 'Подключение fixture',
				lead: 'Вставь API-токен сервиса: он уедет только в зашифрованный токен доступа.',
				fields: [
					{
						name: 'token',
						label: 'API-токен',
						type: 'password',
						hint: 'Настройки → API',
					},
				],
			},
			telegram: {
				// Запасной бот со сборки: сервер присылает свой из окружения рантайма.
				botName: 'fixture_bot',
				grants: ['читать твои данные', 'писать от твоего имени'],
				account: true,
			},
		}),
	],
})
