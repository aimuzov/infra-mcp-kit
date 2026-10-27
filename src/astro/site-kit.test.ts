import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { assertSiteKit, atLeast, siteKitVersion } from './site-kit.ts'

/** Логгер Astro, который запоминает предупреждения. */
function logger() {
	const warnings: string[] = []

	return { warnings, warn: (message: string) => void warnings.push(message) }
}

test('site-kit: свой site-kit кита проходит минимум, а в peerDependencies его нет', () => {
	const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
		peerDependencies: Record<string, string>
	}

	// Со старым site-kit ради конфигов линтеров peer-зависимость уронила бы `npm install`
	// stdio-серверам без страниц, проверять его -- дело `mcpPages()`.
	assert.equal(pkg.peerDependencies['@aimuzov/infra-site-kit'], undefined)

	const log = logger()

	assert.doesNotThrow(() => assertSiteKit(siteKitVersion(), log))
	assert.deepEqual(log.warnings, [])
})

test('site-kit: версию берём из node_modules выше по дереву, без него -- undefined', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'site-kit-'))

	t.after(() => rmSync(root, { recursive: true, force: true }))

	const from = pathToFileURL(join(root, 'node_modules/@aimuzov/infra-mcp-kit/build/astro/index.js'))

	assert.equal(siteKitVersion(from), undefined)

	mkdirSync(join(root, 'node_modules/@aimuzov/infra-site-kit'), { recursive: true })
	writeFileSync(join(root, 'node_modules/@aimuzov/infra-site-kit/package.json'), '{"version":"4.1.1"}')

	assert.equal(siteKitVersion(from), '4.1.1')
})

test('site-kit: старый или пропавший роняет сборку с тем, что поставить', () => {
	const log = logger()

	assert.throws(
		() => assertSiteKit('4.1.1', log),
		/infra-site-kit 4\.2\.0 или новее, стоит 4\.1\.1: npm i -D github:aimuzov\/infra-site-kit#v4\.2\.0/,
	)

	assert.throws(() => assertSiteKit(undefined, log), /а её нет/)
	assert.doesNotThrow(() => assertSiteKit('4.2.0', log))
	assert.doesNotThrow(() => assertSiteKit('5.5.0', log))
	assert.deepEqual(log.warnings, [])
})

test('site-kit: неразборчивую версию пускаем с предупреждением и тем, что поставить', () => {
	const log = logger()

	assert.doesNotThrow(() => assertSiteKit('main', log))
	assert.equal(log.warnings.length, 1)

	assert.match(
		log.warnings[0] ?? '',
		/infra-site-kit 4\.2\.0 или новее, а версию main не разобрать\. .*npm i -D github:aimuzov\/infra-site-kit#v4\.2\.0/,
	)
})

test('site-kit: сравнение версий по major, minor, patch и пререлизу', () => {
	assert.equal(atLeast('4.2.0', '4.2.0'), true)
	assert.equal(atLeast('4.10.0', '4.2.0'), true)
	assert.equal(atLeast('5.0.0', '4.2.0'), true)
	assert.equal(atLeast('4.2.1-rc.1', '4.2.0'), true)
	assert.equal(atLeast('4.2.0-rc.1', '4.2.0'), false)
	assert.equal(atLeast('4.2.0+build.1', '4.2.0'), true)
	assert.equal(atLeast('4.1.9', '4.2.0'), false)
	assert.equal(atLeast('3.9.9', '4.2.0'), false)
	assert.equal(atLeast('v4.2.0', '4.2.0'), true)
	assert.equal(atLeast('main', '4.2.0'), undefined)
})
