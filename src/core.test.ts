import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runCli } from './cli.ts'
import { bool, dataDir, int, list, required, str } from './env.ts'
import { createLogger } from './log.ts'
import { failure, json, text, tool } from './results.ts'
import { readVersion } from './version.ts'

test('версия читается из ближайшего package.json', () => {
	assert.match(readVersion(import.meta.url), /^\d+\.\d+\.\d+/)
})

test('json кладёт объект ещё и в structuredContent, а массив нет', () => {
	assert.deepEqual(json({ a: 1 }).structuredContent, { a: 1 })
	assert.equal(json([1]).structuredContent, undefined)
	assert.equal(json([1]).content[0]?.type, 'text')
})

test('failure приводит что угодно к тексту с isError', () => {
	assert.deepEqual(failure(new Error('boom')), { ...text('boom'), isError: true })
	assert.deepEqual(failure('plain'), { ...text('plain'), isError: true })
})

test('tool раскладывает результат обработчика по типам и ловит исключения', async () => {
	assert.deepEqual(await tool(() => 'hi')(), text('hi'))
	assert.deepEqual(await tool(() => text('as is'))(), text('as is'))
	assert.deepEqual((await tool(async () => ({ n: 1 }))()).structuredContent, { n: 1 })

	const failed = await tool(() => {
		throw new Error('nope')
	})()

	assert.equal(failed.isError, true)
})

test('env-хелперы: пустое значит незаданное, мусор даёт запасное значение', () => {
	const env = { A: '  x ', N: 'abc', M: '5', Z: '0', L: 'a, b,,c', T: 'yes', E: ' ' }

	assert.equal(str(env, 'A'), 'x')
	assert.equal(str(env, 'E', 'def'), 'def')
	assert.equal(int(env, 'N', 7), 7)
	assert.equal(int(env, 'Z', 7), 7)
	assert.equal(int(env, 'M', 7), 5)
	assert.deepEqual(list(env, 'L'), ['a', 'b', 'c'])
	assert.equal(bool(env, 'T'), true)
	assert.equal(bool(env, 'missing', true), true)
	assert.throws(() => required(env, 'E'), /E/)
})

test('dataDir берёт своё имя переменной, иначе XDG', () => {
	const root = mkdtempSync(join(tmpdir(), 'kit-'))

	assert.equal(dataDir('veo-mcp', { VEO_MCP_DATA_DIR: join(root, 'own') }), join(root, 'own'))
	assert.equal(dataDir('veo-mcp', { XDG_CONFIG_HOME: root }), join(root, 'veo-mcp'))
})

test('логгер отсекает уровни ниже заданного', () => {
	const lines: string[] = []
	const logger = createLogger({ level: 'warn', write: (l) => lines.push(l) })

	logger.info('skip')
	logger.error('keep', { a: 1 })

	assert.equal(lines.length, 1)
	assert.match(lines[0] ?? '', /ERROR keep \{"a":1\}/)
})

test('runCli: подкоманды, неизвестная команда и ошибка дают код выхода', async (t) => {
	const out: string[] = []

	t.mock.method(console, 'log', (s: string) => out.push(s))
	t.mock.method(console, 'error', (s: string) => out.push(s))

	const base = { name: 'x', version: '1.2.3', usage: 'usage', stdio: () => assert.fail('stdio') }
	const calls: string[][] = []

	await runCli({ ...base, argv: ['--version'] })
	await runCli({ ...base, argv: ['sync', 'a'], commands: { sync: (args) => void calls.push(args) } })

	assert.deepEqual(out, ['1.2.3'])
	assert.deepEqual(calls, [['a']])

	await runCli({ ...base, argv: ['nope'] })
	assert.equal(process.exitCode, 2)

	await runCli({ ...base, argv: ['serve', '--http'] })
	assert.equal(process.exitCode, 1)
	process.exitCode = 0
})
