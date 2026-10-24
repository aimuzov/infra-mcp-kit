import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	accountPage,
	assets,
	consentPage,
	CSP,
	document,
	failPage,
	field,
	landingPage,
	panel,
	raw,
	status,
	tokenFormPage,
	type Service,
} from './index.ts'

const service: Service = { name: 'thinks', repo: 'https://github.com/aimuzov/thinks-mcp' }
const evil = '<img src=x onerror=alert(1)>'

test('service.css берёт цвет сервиса, а без него оставляет фиолетовый по умолчанию', () => {
	const own = assets({ ...service, accent: { light: '#e8590c', dark: 'rgb(255 138 76)' } })['service.css']
	const fallback = assets(service)['service.css']

	assert.equal(own?.type, 'text/css')
	assert.match(own?.body ?? '', /--hue-light: #e8590c; --hue-dark: rgb\(255 138 76\);/)
	assert.match(fallback?.body ?? '', /--hue-light: #6d4aff;/)
	assert.ok(assets(service)['kit.css']?.body.includes('.glitch'))
	assert.ok(assets(service)['kit.js']?.body.includes('mcp:theme'))
})

test('цвет, похожий на выход из правила CSS, не пропускается', () => {
	for (const light of ['red; } body { display: none', '#fff}', 'url(https://evil)/*'])
		assert.throws(() => assets({ ...service, accent: { light, dark: '#000' } }), /Неподходящий цвет/)
})

test('CSP страниц не разрешает инлайн-код и чужие фреймы', () => {
	assert.doesNotMatch(CSP, /unsafe-inline|unsafe-eval/)
	assert.match(CSP, /frame-ancestors 'none'/)
	assert.match(CSP, /frame-src https:\/\/oauth\.telegram\.org(;|$)/)
})

test('документ подключает ассеты кита, переключатель темы и подпись с исходниками', () => {
	const page = document({ service, title: 't', main: '', scripts: ['/account.js'] })

	assert.match(page, /<link rel="stylesheet" href="\/_kit\/kit\.css"/)
	assert.match(page, /<link rel="stylesheet" href="\/_kit\/service\.css"/)
	assert.match(page, /<script src="\/_kit\/kit\.js"><\/script>/)
	assert.match(page, /<script src="\/account\.js" defer><\/script>/)
	assert.match(page, /data-theme-toggle/)
	assert.match(page, /href="https:\/\/github\.com\/aimuzov\/thinks-mcp"/)
	assert.doesNotMatch(document({ service: { name: 'x' }, title: 't', main: '' }), /Исходный код/)
})

test('лендинг: кнопка копирует адрес, пустой tagline и пустые инструменты не рисуются', () => {
	const page = landingPage({ service, tagline: '', mcpUrl: 'https://a.b/mcp' })

	assert.match(page, /data-copy="https:\/\/a\.b\/mcp"/)
	assert.match(page, /claude mcp add --transport http thinks https:\/\/a\.b\/mcp/)
	assert.doesNotMatch(page, /class="tagline"/)
	assert.doesNotMatch(page, /Инструменты/)
	assert.match(landingPage({ service, tagline: 'x', mcpUrl: 'u', tools: ['a'] }), /<li><code>a<\/code><\/li>/)
})

test('в рукопожатии у клиента первая буква имени, а без имени -- хоста', () => {
	const action = raw('<button>go</button>')
	const named = consentPage({ service, client: { name: 'claude', host: 'claude.ai' }, action })
	const nameless = tokenFormPage({
		service,
		client: { host: 'example.com' },
		title: 't',
		action: '/cb',
		fields: [],
	})

	assert.match(named, /party--client">C</)
	assert.match(named, /claude просит доступ к\sthinks/)
	assert.match(named, /<button>go<\/button>/)
	assert.match(nameless, /party--client">E</)
	assert.match(nameless, /Клиент с&nbsp;адреса <code>example\.com<\/code>/)
})

test('поле формы: подсказка, обязательность и пустые атрибуты', () => {
	const required = field({ name: 'token', label: 'Токен', type: 'password', help: 'где взять' }).value
	const optional = field({ name: 'url', label: 'Адрес', required: false }).value

	assert.match(required, /name="token"/)
	assert.match(required, /type="password"/)
	assert.match(required, /\brequired\b/)
	assert.match(required, /<small>где взять<\/small>/)
	assert.doesNotMatch(optional, /\brequired\b|placeholder=|value=|<small>/)
})

test('ошибка: код крупно, ссылка назад по умолчанию на главную', () => {
	const page = failPage({ service, title: 'Нет', code: 'invalid_grant' })

	assert.match(page, /data-text="invalid_grant">invalid_grant</)
	assert.match(page, /href="\/">На\sглавную</)
	assert.doesNotMatch(failPage({ service, title: 'Нет' }), /error__code/)
})

test('кабинет собирается из секций, а их ввод экранируется', () => {
	const page = accountPage({
		service,
		greeting: `Привет, ${evil}`,
		sections: [
			status({ tone: 'busy', title: evil, detail: evil }),
			panel({ title: evil, body: evil }),
			panel({ title: 'Данные', body: '', tone: 'danger' }),
		],
	})

	assert.ok(!page.includes(evil))
	assert.match(page, /data-screen="account"/)
	assert.match(page, /dot--busy/)
	assert.match(page, /class="panel danger"/)
	assert.doesNotMatch(page, /\sstyle=|<style|<script(?![^>]*\bsrc=)/)
})
