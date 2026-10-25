// Для `check:pages` самого кита. В сервисе эти типы кладёт интеграция (`injectTypes`),
// поэтому файл лежит вне `astro/` и в пакет не попадает.
declare module 'virtual:infra-mcp-kit/pages' {
	const options: import('../src/astro/index.ts').McpPagesOptions

	export default options
}
