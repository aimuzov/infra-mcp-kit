import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Самая старая infra-site-kit, с которой собираются страницы кита: `i18n.js` и переключатель
 * языка появились в 4.2.0. В `peerDependencies` его нет: stdio-серверы без страниц держат
 * site-kit ради конфигов Prettier и oxlint, и старый не должен ронять им `npm install`.
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

/**
 * Не ниже ли `version`, чем `min`, или `undefined`, если версию не разобрать. Пререлиз ниже
 * своего релиза: 4.2.0-rc.1 ещё без того, что пришло в 4.2.0. Пререлизы между собой не сравниваем.
 */
export function atLeast(version: string, min: string): boolean | undefined {
	const parse = (v: string) => {
		const m = /^v?(\d+)\.(\d+)\.(\d+)(-)?/.exec(v)

		return m && [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1]
	}

	const [have, need] = [parse(version), parse(min)]

	if (!have || !need) return undefined

	for (let i = 0; i < 4; i++) {
		if (have[i] !== need[i]) return (have[i] ?? 0) > (need[i] ?? 0)
	}

	return true
}

/**
 * Старый site-kit роняет сборку непонятной ошибкой Vite про `exports`, поэтому проверяем его
 * до неё и говорим, что поставить. Релизы site-kit версионирует release-please, так что
 * неразборчивая версия -- это форк или локальная копия: свежая она или нет, не знаем, и сборку
 * не останавливаем, а оставляем подсказку на случай той же ошибки Vite.
 */
export function assertSiteKit(version: string | undefined, logger: { warn(message: string): void }): void {
	const fix = `npm i -D github:aimuzov/infra-site-kit#v${SITE_KIT_MIN}`

	if (version === undefined)
		throw new Error(`Страницам infra-mcp-kit нужна ${SITE_KIT} ${SITE_KIT_MIN} или новее, а её нет: ${fix}`)

	const fresh = atLeast(version, SITE_KIT_MIN)

	if (fresh === undefined)
		logger.warn(
			`Страницам infra-mcp-kit нужна ${SITE_KIT} ${SITE_KIT_MIN} или новее, а версию ${version} не разобрать. Если Vite упадёт на exports: ${fix}`,
		)
	else if (!fresh)
		throw new Error(`Страницам infra-mcp-kit нужна ${SITE_KIT} ${SITE_KIT_MIN} или новее, стоит ${version}: ${fix}`)
}
