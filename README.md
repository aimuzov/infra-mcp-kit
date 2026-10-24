<p align="center">
	<img src="https://img.shields.io/badge/English-8b5cf6?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI+PGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg+PHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg==" alt="English">
	<a href="README.ru.md"><img src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-555?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5IDYiPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDBoOXYzSDB6Ii8+PHBhdGggZmlsbD0iIzAwMzlhNiIgZD0iTTAgMmg5djJIMHoiLz48cGF0aCBmaWxsPSIjZDUyYjFlIiBkPSJNMCA0aDl2MkgweiIvPjwvc3ZnPg==" alt="Русский"></a>
</p>

<p align="center">
	<a href="https://github.com/aimuzov/infra-mcp-kit/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/aimuzov/infra-mcp-kit/check.yml?branch=main&label=check" alt="Check"></a>
	<a href="https://www.npmjs.com/package/@aimuzov/infra-mcp-kit"><img src="https://img.shields.io/npm/v/@aimuzov/infra-mcp-kit?label=npm" alt="npm"></a>
	<a href="package.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Faimuzov%2Finfra-mcp-kit%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&logo=nodedotjs&logoColor=white&color=5fa04e" alt="Node"></a>
	<a href="LICENSE"><img src="https://img.shields.io/github/license/aimuzov/infra-mcp-kit" alt="License"></a>
</p>

<h3 align="center">One base for every aimuzov MCP server</h3>
<p align="center">stdio core, hosted OAuth connector, shared sign-in pages and test helpers</p>

Shared parts of the aimuzov MCP servers. A fix to OAuth or to the look of the sign-in pages lands here once instead of in every server.

The package is built from TypeScript and published to npm: the servers themselves are installed with `npx` and cannot pull a dependency from GitHub.

## What is inside

- `@aimuzov/infra-mcp-kit`: `runCli` (stdio by default, `serve --http`, `--help`, subcommands), `serveStdio`, tool results `text`, `json`, `failure` and the `tool` wrapper, env helpers, `dataDir`, a stderr logger and `readVersion`.
- `@aimuzov/infra-mcp-kit/http`: `createHttpApp` and `serveHttp` with stateless `/mcp` over Streamable HTTP, OAuth on the SDK router, `/health` and a landing page. Sign-in plugs in through two hooks: `render` draws the page, `complete` tells who came back. Ready ones are `telegramLogin` and `tokenFormLogin`. Codes live in `memoryStore` or `sqliteStore` and work exactly once; tokens are signed or, when a third-party API key rides in the claims, encrypted.
- `@aimuzov/infra-mcp-kit/testing`: `connectInMemory`, `expectTools`, `startHttp`, `oauthFlow` and `connectHttp` for `node --test`.
- Actions `check` and `publish` for the server workflows.

Every page goes through `src/http/ui`, with no inline scripts or styles, under a strict CSP. The style is shared by every connector, each server only brings its own accent color.

## Usage

```bash
npm install -E @aimuzov/infra-mcp-kit
```

```ts
import { readVersion, runCli } from '@aimuzov/infra-mcp-kit'
import { loadHttpConfig, serveHttp, sqliteStore, telegramLogin } from '@aimuzov/infra-mcp-kit/http'

await runCli({
	name: 'example',
	version: readVersion(import.meta.url),
	usage: 'example: MCP server',
	stdio: () => createServer(),
	http: () =>
		serveHttp({
			config: loadHttpConfig(),
			service: { name: 'example', repo: 'https://github.com/aimuzov/example' },
			createServer: (auth) => createServer(auth?.extra),
			auth: { store: sqliteStore('/data/auth.db'), login: telegramLogin({ botToken, botName }) },
			landing: { tagline: 'What the connector does' },
		}),
})
```

`.github/workflows/check.yml` of a server:

```yaml
jobs:
    check:
        runs-on: ubuntu-latest
        timeout-minutes: 10
        steps:
            - uses: aimuzov/infra-mcp-kit/check@v1
```

Full documentation comes with the move of the servers onto the kit.
