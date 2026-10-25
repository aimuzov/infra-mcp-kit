/**
 * Сборка страниц коннектора-фикстуры для e2e кита. Кит попадает в её node_modules симлинком
 * на корень репозитория, поэтому Astro берёт его так же, как у сервера: через `exports`,
 * из собранного `build/` и исходников `astro/`. Перед этим нужен `npm run build`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const CONNECTOR = fileURLToPath(new URL('./connector/', import.meta.url))
export const PUBLIC_DIR = fileURLToPath(new URL('./connector/build/public', import.meta.url))

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LINK = fileURLToPath(new URL('./connector/node_modules/@aimuzov/infra-mcp-kit', import.meta.url))

export function linkKit(): void {
	if (!existsSync(new URL('../build/astro/index.js', import.meta.url))) {
		throw new Error('Кит не собран: сначала npm run build')
	}

	rmSync(LINK, { force: true, recursive: true })
	mkdirSync(fileURLToPath(new URL('./connector/node_modules/@aimuzov', import.meta.url)), { recursive: true })
	symlinkSync(ROOT, LINK, 'dir')
}

export function buildPages(): string {
	linkKit()
	execFileSync('npx', ['astro', 'build', '--root', CONNECTOR], { cwd: ROOT, stdio: 'inherit' })

	return PUBLIC_DIR
}

// `node e2e/pages.ts check` -- `astro check` фикстуры: типы страниц и островов кита.
if (process.argv[2] === 'check') {
	linkKit()
	execFileSync('npx', ['astro', 'check', '--root', CONNECTOR], { cwd: ROOT, stdio: 'inherit' })
} else if (process.argv[2] === 'build') {
	buildPages()
}
