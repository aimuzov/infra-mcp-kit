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
<p align="center">stdio core, hosted OAuth connector, Astro pages and test helpers</p>

Shared parts of the aimuzov MCP servers. A fix to OAuth or to the look of the connector pages lands here once instead of in every server.

The package is built from TypeScript and published to npm: the servers themselves are installed with `npx` and cannot pull a dependency from GitHub.

## What is inside

- `@aimuzov/infra-mcp-kit`: `runCli` (stdio by default, `serve --http`, `--help`, subcommands), `serveStdio`, tool results `text`, `json`, `failure` and the `tool` wrapper, env helpers, `dataDir`, a stderr logger and `readVersion`.
- `@aimuzov/infra-mcp-kit/http`: `createHttpApp` and `serveHttp` with stateless `/mcp` over Streamable HTTP, OAuth on the SDK router, `/health` and the pages built by `/astro`, served from `publicDir`. Sign-in is a static page plus a `complete` hook that tells who came back; ready ones are `telegramLogin` and `tokenFormLogin`. Codes live in `memoryStore` or `sqliteStore` and work exactly once; tokens are signed or, when a third-party API key rides in the claims, encrypted. `apiError`, `sendJson`, `requireSession` and `errorPage` serve the JSON API behind the account page.
- `@aimuzov/infra-mcp-kit/astro`: the `mcpPages()` Astro integration with the landing, sign-in (token form and Telegram), error and 404 pages, the layout and the Svelte islands for a service's own pages, such as `AccountShell`.
- `@aimuzov/infra-mcp-kit/testing`: `connectInMemory`, `expectTools`, `startHttp`, `oauthFlow` with `submitForm`, `telegramSigned` and `devLink`, `fakePages` and `connectHttp` for `node --test`.
- Actions `check` and `publish` for the server workflows.

## Pages

The connector pages are static: Astro builds them into `build/public` with the server's `npm run build`, the server only serves files and keeps OAuth, `/mcp`, `/health` and a small JSON API. Whatever depends on the person, the sign-in context or the account data, is drawn by Svelte islands in the browser.

They are built from the parts of [infra-site-kit](https://github.com/aimuzov/infra-site-kit), like the sites: the author credit, the theme switch with the peek circle, the base root styles, the 404 page and the UI components (card, button, field, alert, skeleton, dropzone). The "Signal" theme only maps their `--ui-*` and `--credit-*` tokens onto its palette and styles the page layout. A service brings its accent color.

The sign-in context (the signed authorization request, the client and the error of the previous attempt) travels in the URL fragment, so it reaches neither the server logs nor the proxy.

`astro.config.mjs` of a server:

```js
import mcpPages from '@aimuzov/infra-mcp-kit/astro'
import svelte from '@astrojs/svelte'
import { defineConfig } from 'astro/config'

export default defineConfig({
	srcDir: './src/frontend',
	outDir: './build/public',
	integrations: [
		svelte(),
		mcpPages({
			service: {
				name: 'example',
				repo: 'https://github.com/aimuzov/example',
				tagline: 'What the connector does',
			},
			tokenForm: { title: 'Connect example', fields: [{ name: 'token', label: 'API token', type: 'password' }] },
		}),
	],
})
```

The pages are compiled by the server, so these stay its dev dependencies and never reach the runtime or `npx`: `astro`, `@astrojs/svelte`, `svelte`, `@aimuzov/infra-site-kit`, `@lucide/svelte` and `postcss-nested`. Like the sites, the server keeps `svelte.config.js` with `vitePreprocess()` and `postcss.config.mjs` with `postcss-nested`: the site-kit components need both. [`e2e/connector`](e2e/connector) is a working example.

## Usage

```bash
npm install -E @aimuzov/infra-mcp-kit
```

```ts
import { readVersion, runCli } from '@aimuzov/infra-mcp-kit'
import { loadHttpConfig, serveHttp, sqliteStore, tokenFormLogin } from '@aimuzov/infra-mcp-kit/http'

await runCli({
	name: 'example',
	version: readVersion(import.meta.url),
	usage: 'example: MCP server',
	stdio: () => createServer(),
	http: () =>
		serveHttp({
			config: loadHttpConfig(),
			service: { name: 'example' },
			publicDir: new URL('../build/public', import.meta.url).pathname,
			createServer: (auth) => createServer(auth?.extra),
			auth: {
				store: sqliteStore('/data/auth.db'),
				tokens: 'encrypt',
				login: tokenFormLogin({ fields: [{ name: 'token', label: 'API token' }], verify }),
			},
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
            - uses: aimuzov/infra-mcp-kit/check@v2
```

With `astro.config.mjs` in the repository the action also runs `astro check` and `svelte-check`.

Optional inputs of the action:

- `coverage-lines: 95` fails the check below 95% line coverage. The `test` script must start with `node`: the action puts the coverage flags right after it, because Node accepts them neither in `NODE_OPTIONS` nor after the test glob. Test files, `*.e2e.ts` and `testing/` helpers are left out of the count.
- `astro-tsconfig: tsconfig.astro.json` points `astro check` and `svelte-check` to their own config when the root one is for the server.
- `ui: true` runs `npm run test:ui` in Chromium after the build, with the browser cached by the Playwright version.

A server that uses `/http` adds `@types/express` to its devDependencies: the kit's types refer to it, while an install without dev dependencies doesn't need it. The pages need infra-site-kit 4.1.1 or newer: the kit's CSP no longer allows `style` attributes, and older `Skeleton` and `InfoTip` render them.

## Migrating from 1.x

2.0 drops the HTML that the server rendered on request: every page is built by Astro.

1. Add the pages: the dev dependencies above, `astro.config.mjs` with `mcpPages()`, `svelte.config.js` and `postcss.config.mjs`. `npm run build` becomes `tsc` followed by `astro build`, and `files` of `package.json` keeps `build`, so `npx` gets `build/public` too.
2. Pass `publicDir` to `createHttpApp` or `serveHttp`. With `auth` it is required: sign-in is a static page now. `landing` is gone, the landing comes from `mcpPages({ service })`. `service` is only `{ name }`, its `repo`, `accent` and texts moved to `mcpPages`.
3. Sign-in: `telegramLogin` drops `botName` and `grants`, `tokenFormLogin` drops `title`, `lead` and `submit`, they live in `mcpPages({ telegram, tokenForm })`. A custom `Login` replaces `render` with `page`, the path of its static page, and may add `context` to the fragment. `LoginPageContext`, `KitOAuthProvider.renderLogin` and `telegramButton` are gone.
4. The `ui` namespace, `html`, `raw`, `escapeHtml`, `SafeHtml` and the `/_kit/*` assets are gone. An account page is a page of the service: `src/frontend/pages/account.astro` on the kit layout with an island wrapped in `AccountShell`, which loads `/account/state` and shows sign-in on 401. The server answers that route with `requireSession` and `sendJson`.
5. Errors: the OAuth callback redirects to the static `/error` page instead of rendering one, unknown routes get `404.html` for a browser and a JSON error for `fetch`, `sameOrigin` answers 403 with a JSON error.
6. Tests: `/authorize` answers 302 to the sign-in page. `oauthFlow` passes the `login` callback the parsed `LoginStep` instead of the page HTML; `submitForm`, `telegramSigned` and `devLink` cover the ready sign-ins, and `fakePages()` gives a `publicDir` without building Astro. `callbackFrom` and `hiddenField` are gone.
7. CI: `aimuzov/infra-mcp-kit/check@v2`.
