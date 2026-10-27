import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { readLoginContext } from '@aimuzov/infra-mcp-kit/astro/lib/login-context.ts'

import mcpPages from '#kit/astro/index'
import { createHttpApp } from '#kit/http/app'
import { tokenFormLogin } from '#kit/http/login/token-form'
import { LoginError, type LoginInput } from '#kit/http/oauth/provider'
import { memoryStore } from '#kit/http/oauth/store'
import { McpServer } from '#kit/mcp'
import { fakePages, loginStep, oauthFlow, startHttp, submitForm, type RunningHttp } from '#kit/testing/index'

import { defineTokenForm } from './token-form.ts'

const form = defineTokenForm({
	title: { ru: 'Вход', en: 'Sign in' },
	fields: [
		{ name: 'space', label: { ru: 'Адрес пространства', en: 'Space address' }, type: 'url' },
		{ name: 'token', label: { ru: 'API-токен', en: 'API token' }, type: 'password' },
		{ name: 'note', label: 'Заметка', required: false },
	],
})

const post = (fields: Record<string, string>): LoginInput => ({
	request: new Request('http://127.0.0.1/authorize/callback'),
	method: 'POST',
	query: {},
	form: fields,
})

describe('общий модуль формы', () => {
	test('defineTokenForm отдаёт форму как есть, её принимают и mcpPages, и tokenFormLogin', () => {
		assert.equal(form.fields[1]?.name, 'token')
		assert.doesNotThrow(() => mcpPages({ service: { name: 'x' }, tokenForm: form }))
		assert.equal(tokenFormLogin({ fields: form.fields, verify: () => ({ subject: 'u' }) }).page, '/login')
	})

	test('повтор имени, пустое имя и `request` роняют форму сразу, и по-старому через mcpPages', () => {
		const field = (name: string) => ({ name, label: name })

		assert.throws(() => defineTokenForm({ title: 'x', fields: [field('a'), field('a')] }), /"a" описано дважды/)
		assert.throws(() => defineTokenForm({ title: 'x', fields: [field('')] }), /Неподходящее имя/)
		assert.throws(() => defineTokenForm({ title: 'x', fields: [field('request')] }), /"request"/)

		assert.throws(
			() => mcpPages({ service: { name: 'x' }, tokenForm: { title: 'x', fields: [field('b'), field('b')] } }),
			/"b" описано дважды/,
		)

		assert.throws(
			() => tokenFormLogin({ fields: [field('request')], verify: () => ({ subject: 'u' }) }),
			/"request"/,
		)
	})
})

describe('hide у tokenFormLogin', () => {
	test('скрытое поле не обязательно, а присланное значение до verify не доходит', async () => {
		const seen: Record<string, string>[] = []
		const login = tokenFormLogin({
			fields: form.fields,
			hide: ['space'],
			verify: (values) => {
				seen.push(values)

				return { subject: 'u' }
			},
		})

		assert.deepEqual(login.context, { hide: 'space' })
		await login.complete(post({ token: ' t ' }))
		await login.complete(post({ token: 't', space: 'https://evil.example', note: 'n' }))

		assert.deepEqual(seen, [
			{ token: 't', note: '' },
			{ token: 't', note: 'n' },
		])
	})

	test('видимое обязательное поле без значения -- ошибка с подписью на обоих языках', async () => {
		const login = tokenFormLogin({ fields: form.fields, verify: () => ({ subject: 'u' }) })

		assert.equal(login.context, undefined)

		await assert.rejects(
			async () => login.complete(post({ token: 't' })),
			(error) => {
				assert.ok(error instanceof LoginError)
				assert.equal(error.in('ru'), 'Заполни поле «Адрес пространства»')
				assert.equal(error.in('en'), 'Fill in the field “Space address”')

				return true
			},
		)
	})

	test('имя в hide, которого нет в форме, не даёт серверу стартовать', () => {
		assert.throws(
			() => tokenFormLogin({ fields: form.fields, hide: ['spcae'], verify: () => ({ subject: 'u' }) }),
			/нет в форме: spcae/,
		)
	})

	test('запятая и прочие лишние символы в имени скрываемого поля не дают серверу стартовать', () => {
		const field = (name: string) => ({ name, label: name })
		const hiding = (name: string) => () =>
			tokenFormLogin({ fields: [field(name), field('token')], hide: [name], verify: () => ({ subject: 'u' }) })

		// Фрагмент режет список по запятой: `space,tenant` вернулся бы на страницу двумя полями.
		assert.throws(hiding('space,tenant'), /неподходящие имена полей: "space,tenant"/)
		assert.throws(hiding('space url'), /"space url"/)
		assert.throws(hiding('адрес'), /"адрес"/)

		assert.deepEqual(hiding('kaiten.url-1_a')().context, { hide: 'kaiten.url-1_a' })
	})
})

describe('hide через OAuth', () => {
	const running: RunningHttp[] = []

	after(() => Promise.all(running.map((r) => r.close())))

	test('список едет во фрагменте страницы входа, и после ошибки тоже', async () => {
		const login = tokenFormLogin({
			fields: form.fields,
			hide: ['space', 'note'],
			verify: ({ token }) => {
				if (token !== 'good') throw new LoginError('Токен не подошёл')

				return { subject: 'u', claims: { token } }
			},
		})
		const http = await startHttp((base) =>
			createHttpApp({
				config: { port: 0, publicUrl: new URL(base), authSecret: 'x'.repeat(32), allowedRedirectUris: [] },
				service: { name: 'test' },
				createServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
				publicDir: fakePages(),
				auth: { store: memoryStore(), login, tokens: 'encrypt' },
			}),
		)

		running.push(http)

		const steps: string[][] = []
		const flow = await oauthFlow({
			base: http.base,
			login: async (step) => {
				steps.push(step.hide)

				const refused = await submitForm({ token: 'bad' })(step)
				const again = loginStep(refused.headers.get('location') ?? '', http.base)

				steps.push(again.hide)
				assert.deepEqual(again.context, {})

				return submitForm({ token: 'good' })(again)
			},
		})

		assert.deepEqual(steps, [
			['space', 'note'],
			['space', 'note'],
		])

		assert.ok(flow.tokens.access_token)
	})

	test('остров читает список из фрагмента, без него ничего не прячет', () => {
		assert.deepEqual(readLoginContext('#request=r&hide=space%2Cnote').hide, ['space', 'note'])
		assert.deepEqual(readLoginContext('#request=r').hide, [])
	})
})
