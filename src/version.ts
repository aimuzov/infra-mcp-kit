import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Версия из ближайшего к модулю package.json, чтобы рукопожатие MCP не отставало от релиза.
 * Ищем вверх по каталогам: из `src/` и из `build/` до корня пакета разное расстояние.
 */
export function readVersion(importMetaUrl: string): string {
	let dir = dirname(fileURLToPath(importMetaUrl))

	for (;;) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }

			if (typeof pkg.version === 'string') return pkg.version
		} catch {
			// Нет package.json на этом уровне, идём выше.
		}

		const parent = dirname(dir)

		if (parent === dir) return '0.0.0'

		dir = parent
	}
}
