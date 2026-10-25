// Подменяет McpServer из SDK фасадом на tmcp, не трогая код сервиса:
// node --import <этот файл> ... гоняет тесты сервиса на tmcp.
import { register } from 'node:module'

const compat = new URL('./compat.ts', import.meta.url).href

register(
	`data:text/javascript,${encodeURIComponent(`
		export async function resolve(specifier, context, next) {
			if (specifier === '@modelcontextprotocol/sdk/server/mcp.js') return { url: ${JSON.stringify(compat)}, shortCircuit: true }
			return next(specifier, context)
		}
	`)}`,
)
