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
				tools: ['whoami', 'ping'],
				logo: './logo.svg',
				glitch: { a: '#f11f24', b: '#5fe8b0' },
			},
			tokenForm: {
				title: 'Подключение fixture',
				lead: 'Вставь API-токен сервиса: он уедет только в зашифрованный токен доступа.',
				fields: [{ name: 'token', label: 'API-токен', type: 'password', hint: 'Настройки → API' }],
			},
			telegram: { botName: 'fixture_bot', grants: ['читать твои данные', 'писать от твоего имени'] },
		}),
	],
})
