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
				name: 'spike',
				repo: 'https://github.com/aimuzov/infra-mcp-kit',
				tagline: 'Проверка страниц на Astro',
				lead: 'Статика из кита, данные дорисовывают острова.',
				tools: ['ping', 'whoami'],
			},
			tokenForm: {
				title: 'Подключение spike',
				lead: 'Вставь токен.',
				fields: [{ name: 'token', label: 'API-токен', type: 'password' }],
			},
			telegram: { botName: 'spike_bot' },
		}),
	],
})
