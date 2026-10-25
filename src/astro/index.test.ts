import assert from 'node:assert/strict'
import { test } from 'node:test'

import { safeSvg, serviceCss } from './index.ts'

const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="12" fill="#f11f24"/></svg>'

test('знак сервиса: статичный SVG проходит, XML-заголовок отрезается', () => {
	assert.equal(safeSvg(MARK), MARK)
	assert.equal(safeSvg(`<?xml version="1.0"?>\n${MARK}\n`), MARK)
	assert.equal(safeSvg('<svg><use href="#a"/></svg>'), '<svg><use href="#a"/></svg>')
})

test('знак сервиса: скрипты, обработчики, стили и внешние ссылки не проходят', () => {
	for (const svg of [
		'<svg><script>alert(1)</script></svg>',
		'<svg onload="alert(1)"></svg>',
		'<svg><path style="fill:red"/></svg>',
		'<svg><a href="https://evil.example"><path/></a></svg>',
		'<svg><a href="javascript:alert(1)"/></svg>',
		'<svg><foreignObject><div/></foreignObject></svg>',
		'<img src=x>',
		'<svg></svg><svg></svg>junk',
	]) {
		assert.throws(() => safeSvg(svg), Error, svg)
	}
})

test('стили сервиса: цвет и глитч в :root, без настроек пусто, мусор вместо цвета -- ошибка', () => {
	assert.equal(serviceCss({ name: 'x' }), '')

	assert.equal(
		serviceCss({
			name: 'x',
			accent: { light: '#7d4ccf', dark: '#ad73fe' },
			glitch: { a: '#f11f24', b: '#5fe8b0' },
		}),
		':root { --signal-hue: light-dark(#7d4ccf, #ad73fe); --signal-glitch-a: #f11f24; --signal-glitch-b: #5fe8b0; }\n',
	)

	assert.throws(
		() => serviceCss({ name: 'x', glitch: { a: 'red;}body{display:none', b: '#000' } }),
		/Неподходящий цвет/,
	)
})
