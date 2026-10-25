import { createHttpApp, listen, LoginError, memoryStore, sessions, tokenFormLogin } from '@aimuzov/infra-mcp-kit/http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const port = Number(process.env.PORT ?? 8790)
const publicUrl = new URL(`http://localhost:${port}`)

const { app, context } = createHttpApp({
	config: {
		publicUrl,
		port,
		authSecret: 'x'.repeat(48),
		allowedRedirectUris: [],
	} as never,
	service: { name: 'spike', repo: 'https://github.com/aimuzov/infra-mcp-kit' },
	publicDir: new URL('../build/public', import.meta.url).pathname,
	auth: {
		store: memoryStore(),
		tokens: 'encrypt',
		login: tokenFormLogin({
			title: 'Подключение spike',
			page: '/login',
			fields: [{ name: 'token', label: 'API-токен', type: 'password' }],
			verify: ({ token }) => {
				if (token !== 'good') throw new LoginError('Токен не подошёл')

				return { subject: 'user-1', claims: { apiToken: token } }
			},
		}),
	},
	createServer: (auth) => {
		const server = new McpServer({ name: 'spike', version: '0.0.0' })

		server.registerTool('whoami', { description: 'who' }, () => ({
			content: [{ type: 'text', text: String(auth?.extra?.subject ?? 'nobody') }],
		}))

		return server
	},
	routes: (app) => {
		// Кабинет в спайке: сессия по cookie ставится ручкой /account/dev-login.
		app.get('/account/state', (req, res) => {
			if (!String(req.headers.cookie ?? '').includes('spike=1')) return void res.status(401).json({})

			res.json({ name: 'dev', corpus: 'ready' })
		})

		app.get('/account/dev-login', (_req, res) => {
			res.cookie('spike', '1', { httpOnly: true, sameSite: 'lax' }).redirect(302, '/account')
		})
	},
})

void context
void sessions
await listen(app, port)
