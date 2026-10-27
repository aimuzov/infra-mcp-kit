import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Самая старая infra-site-kit, с которой собираются страницы кита: `i18n.js` и переключатель
 * языка появились в 4.2.0. Тот же минимум стоит в `peerDependencies`.
 */
export const SITE_KIT_MIN = '4.2.0'

const SITE_KIT = '@aimuzov/infra-site-kit'

/**
 * Версия site-kit, которую возьмёт сборка страниц, или `undefined`, если его нет. Ищем, как Node
 * и Vite, по `node_modules` вверх от кита: `package.json` site-kit не экспортирует, и
 * `require.resolve` его не отдаст.
 */
export function siteKitVersion(from: string | URL = import.meta.url): string | undefined {
	for (const dir of createRequire(from).resolve.paths(SITE_KIT) ?? []) {
		const file = join(dir, SITE_KIT, 'package.json')

		if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version
	}

	return undefined
}

/** Не ниже ли `version`, чем `min`. Хвост пререлиза не смотрим, непонятную версию пускаем. */
export function atLeast(version: string, min: string): boolean {
	const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number)
	const [have, need] = [parse(version), parse(min)]

	if (!have || !need) return true

	for (let i = 0; i < 3; i++) {
		if (have[i] !== need[i]) return (have[i] ?? 0) > (need[i] ?? 0)
	}

	return true
}

/**
 * Старый site-kit роняет сборку непонятной ошибкой Vite про `exports`, поэтому проверяем его
 * до неё и говорим, что поставить.
 */
export function assertSiteKit(version: string | undefined): void {
	const fix = `npm i -D github:aimuzov/infra-site-kit#v${SITE_KIT_MIN}`

	if (version === undefined)
		throw new Error(`Страницам infra-mcp-kit нужна ${SITE_KIT} ${SITE_KIT_MIN} или новее, а её нет: ${fix}`)

	if (!atLeast(version, SITE_KIT_MIN))
		throw new Error(`Страницам infra-mcp-kit нужна ${SITE_KIT} ${SITE_KIT_MIN} или новее, стоит ${version}: ${fix}`)
}
