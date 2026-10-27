// Коннектор-фикстура для e2e кита: так страницы собирает настоящий сервер.
// Кит подключён симлинком из node_modules, его ставит `e2e/pages.ts`.
import mcpPages from '@aimuzov/infra-mcp-kit/astro'
import svelte from '@astrojs/svelte'
import { defineConfig } from 'astro/config'

import { loginForm } from './src/login-form.ts'

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
						'fixture.status': 'Статус корпуса',
						'fixture.statusText': 'Остров сервиса в слоте после героя.',
						'fixture.faq': 'Вопросы',
						'fixture.faqText': 'Своя разметка внутри карточки кита.',
						'fixture.end': 'Последний слот: после инструментов и карточек конфига.',
					},
					en: {
						'service.tagline': 'A check of the kit pages on Astro',
						'service.lead': 'Static pages from the kit, islands in the browser draw the data of the user.',
						'tool.пинг': 'ping',
						'tokenForm.lead':
							'Paste the API token of the service: it only travels inside the encrypted access token.',
						'telegram.grant.0': 'read your data',
						'telegram.grant.1': 'write on your behalf',
						'fixture.accountTitle': 'fixture account',
						'fixture.corpus': 'Corpus',
						'fixture.data': 'Data',
						'fixture.dataLead': 'Delete the corpus and sign out.',
						'fixture.delete': 'Delete the corpus',
						'fixture.logout': 'Sign out',
						'card.account.title': 'Account first',
						'card.account.text': 'Sign in and upload the corpus, then connect.',
						'card.account.link.0': 'Open the account',
						'fixture.status': 'Corpus status',
						'fixture.statusText': 'An island of the service in the slot after the hero.',
						'fixture.faq': 'Questions',
						'fixture.faqText': 'Own markup inside a kit card.',
						'fixture.end': 'The last slot: after the tools and the config cards.',
					},
				},
			},
			locales: ['ru', 'en'],
			// Те же поля берёт сервер: `tokenFormLogin({ fields: loginForm.fields })`.
			tokenForm: loginForm,
			telegram: {
				// Запасной бот со сборки: сервер присылает свой из окружения рантайма.
				botName: 'fixture_bot',
				grants: ['читать твои данные', 'писать от твоего имени'],
				account: true,
			},
			// Перевод первой карточки -- ключами `card.account.*` в `strings.en`, второй -- `{ ru, en }`.
			landing: {
				cards: [
					{
						id: 'account',
						after: 'hero',
						title: 'Сначала кабинет',
						text: 'Войди и загрузи корпус, потом подключай.',
						links: [{ href: '/account', label: 'Открыть кабинет', primary: true }],
					},
					{
						id: 'help',
						title: { ru: 'Помощь', en: 'Help' },
						text: { ru: 'Как устроен кит и куда писать.', en: 'How the kit works and where to write.' },
						links: [
							{ href: 'https://github.com/aimuzov/infra-mcp-kit#readme', label: 'README' },
							{ href: 'mailto:help@example.com', label: { ru: 'Написать', en: 'Write to us' } },
						],
					},
				],
			},
		}),
	],
})
