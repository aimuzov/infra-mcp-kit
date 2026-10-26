import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { LoginError } from '#kit/http/oauth/provider'
import {
	allLocales,
	enableLocales,
	KIT_STRINGS,
	kt,
	localeOfPath,
	localizePath,
	negotiateLocale,
	pick,
	requestLocale,
} from '#kit/i18n'

const page = (path: string, headers: Record<string, string> = {}) =>
	new Request(new URL(path, 'https://x.test'), { headers })

after(() => enableLocales(['ru', 'en']))

test('у английского словаря кита те же ключи, что у русского', () => {
	assert.deepEqual(Object.keys(KIT_STRINGS.en).sort(), Object.keys(KIT_STRINGS.ru).sort())
})

test('kt подставляет переменные, pick выбирает перевод конфига', () => {
	assert.equal(kt('en', 'login.required', { field: 'API token' }), 'Fill in the field “API token”')
	assert.equal(kt('xx', 'server.unauthorized'), 'Нужно войти')
	assert.equal(pick({ ru: 'Вход', en: 'Sign in' }, 'en'), 'Sign in')
	assert.equal(pick({ ru: 'Вход' }, 'en'), 'Вход')
	assert.equal(pick('Вход', 'en'), 'Вход')
	assert.deepEqual(allLocales('oauth.failed'), { ru: 'Не получилось войти', en: 'Could not sign in' })
})

test('пути и Accept-Language на сервере -- по тем же правилам, что в site-kit', () => {
	assert.equal(localeOfPath('/en/login'), 'en')
	assert.equal(localizePath('/login', 'en'), '/en/login')
	assert.equal(localizePath('/en/', 'ru'), '/')
	assert.equal(negotiateLocale('de,en;q=0.8,ru;q=0.5'), 'en')
	assert.equal(negotiateLocale('fr'), 'ru')
})

test('язык запроса: путь, затем страница-источник, cookie и Accept-Language', () => {
	enableLocales(['ru', 'en'])

	assert.equal(requestLocale(page('/en/account/state')), 'en')
	assert.equal(requestLocale(page('/authorize/callback', { referer: 'https://x.test/en/login' })), 'en')

	// Русская страница-источник сильнее английского браузера: человек видит её язык.
	assert.equal(
		requestLocale(page('/authorize/callback', { referer: 'https://x.test/login', 'accept-language': 'en' })),
		'ru',
	)

	assert.equal(requestLocale(page('/x', { cookie: 'a=1; lang=en', 'accept-language': 'ru' })), 'en')
	assert.equal(requestLocale(page('/x', { 'accept-language': 'en-US' })), 'en')
})

test('без английских страниц сервер отвечает по-русски', () => {
	enableLocales(['ru'])

	assert.equal(requestLocale(page('/x', { 'accept-language': 'en' })), 'ru')
	enableLocales(['ru', 'en'])
})

test('LoginError держит текст по языкам, без перевода -- русский', () => {
	const both = new LoginError({ ru: 'Токен не подошёл', en: 'The token did not fit' })
	const plain = new LoginError('Токен не подошёл')

	assert.equal(both.message, 'Токен не подошёл')
	assert.equal(both.in('en'), 'The token did not fit')
	assert.equal(plain.in('en'), 'Токен не подошёл')
})
