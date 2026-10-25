import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runCli } from './cli.ts'
import { bool, dataDir, int, list, required, str } from './env.ts'
import { createLogger, parseLogLevel } from './log.ts'
import { failure, json, text, tool } from './results.ts'
import { readVersion } from './version.ts'

test('версия читается из ближайшего package.json', () => {
	assert.match(readVersion(import.meta.url), /^\d+\.\d+\.\d+/)
})

test('json кладёт обычный объект ещё и в structuredContent, а массив, Date и undefined нет', () => {
	assert.deepEqual(json({ a: 1 }).structuredContent, { a: 1 })
	assert.equal(json({ a: 1 }, { structured: false }).structuredContent, undefined)
	assert.equal(json([1]).structuredContent, undefined)
	assert.equal(json(new Date(0)).structuredContent, undefined)
	assert.equal(json([1]).content[0]?.type, 'text')
	assert.deepEqual(json(undefined), text('null'))
})

test('failure приводит что угодно к тексту с isError', () => {
	assert.deepEqual(failure(new Error('boom')), { ...text('boom'), isError: true })
	assert.deepEqual(failure('plain'), { ...text('plain'), isError: true })
	assert.deepEqual(failure({ code: 42 }), { ...text('{"code":42}'), isError: true })
})

test('tool раскладывает результат обработчика по типам и ловит исключения', async () => {
	assert.deepEqual(await tool(() => 'hi')(), text('hi'))
	assert.deepEqual(await tool(() => text('as is'))(), text('as is'))
	assert.deepEqual((await tool(async () => ({ n: 1 }))()).structuredContent, { n: 1 })

	const failed = await tool(() => {
		throw new Error('nope')
	})()

	assert.equal(failed.isError, true)

	const lines: string[] = []
	const logger = createLogger({ write: (l) => lines.push(l) })

	await tool(
		() => {
			throw new Error('named')
		},
		{ name: 'search', logger },
	)()

	assert.match(lines[0] ?? '', /tool failed \{"tool":"search","message":"named"\}/)
})

test('env-хелперы: пустое значит незаданное, мусор даёт ошибку с именем переменной', () => {
	const env = { A: '  x ', N: 'abc', M: '5', Z: '0', L: 'a, b,,c', T: 'yes', E: ' ' }

	assert.equal(str(env, 'A'), 'x')
	assert.equal(str(env, 'E', 'def'), 'def')
	assert.throws(() => int(env, 'N', 7), /N: .*"abc"/)
	assert.throws(() => int(env, 'Z', 7), /Z: нужно целое число от 1/)
	assert.throws(() => int({ P: '80a0' }, 'P', 7), /P:/)
	assert.equal(int(env, 'Z', 7, { min: 0 }), 0)
	assert.equal(int(env, 'M', 7), 5)
	assert.equal(int(env, 'E', 7), 7)
	assert.deepEqual(list(env, 'L'), ['a', 'b', 'c'])
	assert.equal(bool(env, 'T'), true)
	assert.equal(bool(env, 'missing', true), true)
	assert.equal(bool({ F: 'off' }, 'F', true), false)
	assert.throws(() => bool({ F: 'yse' }, 'F'), /F: .*"yse"/)
	assert.throws(() => required(env, 'E'), /E/)
})

test('dataDir берёт своё имя переменной, иначе XDG', () => {
	const root = mkdtempSync(join(tmpdir(), 'kit-'))

	assert.equal(dataDir('veo-mcp', { VEO_MCP_DATA_DIR: join(root, 'own') }), join(root, 'own'))
	assert.equal(dataDir('veo-mcp', { XDG_CONFIG_HOME: root }), join(root, 'veo-mcp'))
	assert.equal(dataDir('zen', { ZEN_DATA_DIR: join(root, 'zen') }, { variable: 'ZEN_DATA_DIR' }), join(root, 'zen'))

	const lazy = dataDir('lazy', { XDG_CONFIG_HOME: root }, { create: false })

	assert.equal(existsSync(lazy), false)
})

test('логгер отсекает уровни ниже заданного', () => {
	const lines: string[] = []
	const logger = createLogger({ level: 'warn', write: (l) => lines.push(l) })

	logger.info('skip')
	logger.error('keep', { a: 1 })

	assert.equal(lines.length, 1)
	assert.match(lines[0] ?? '', /ERROR keep \{"a":1\}/)
})

test('уровень лога: только свои имена, без ключей прототипа', () => {
	assert.equal(parseLogLevel(' Debug '), 'debug')
	assert.equal(parseLogLevel('toString'), undefined)
	assert.equal(parseLogLevel(undefined), undefined)
})

test('недоступный файл лога предупреждает один раз и не роняет запись', () => {
	const lines: string[] = []
	const logger = createLogger({ file: join(tmpdir(), 'no-such-dir-kit', 'x.log'), write: (l) => lines.push(l) })

	logger.info('one')
	logger.info('two')

	assert.equal(lines.filter((l) => l.includes('unavailable')).length, 1)
	assert.equal(lines.length, 3)
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
