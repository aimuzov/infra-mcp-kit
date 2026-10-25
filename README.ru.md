<p align="center">
	<a href="README.md"><img src="https://img.shields.io/badge/English-555?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI+PGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg+PHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg==" alt="English"></a>
	<img src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-8b5cf6?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5IDYiPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDBoOXYzSDB6Ii8+PHBhdGggZmlsbD0iIzAwMzlhNiIgZD0iTTAgMmg5djJIMHoiLz48cGF0aCBmaWxsPSIjZDUyYjFlIiBkPSJNMCA0aDl2MkgweiIvPjwvc3ZnPg==" alt="Русский">
</p>

<p align="center">
	<img src=".github/assets/banner.jpg" alt="infra-mcp-kit: общая основа MCP-серверов" width="100%">
</p>

<p align="center">
	<a href="https://github.com/aimuzov/infra-mcp-kit/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/aimuzov/infra-mcp-kit/check.yml?branch=main&label=check" alt="Check"></a>
	<a href="https://github.com/aimuzov/infra-mcp-kit/releases"><img src="https://img.shields.io/github/v/release/aimuzov/infra-mcp-kit?sort=semver&label=version" alt="Version"></a>
	<a href="package.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Faimuzov%2Finfra-mcp-kit%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&logo=nodedotjs&logoColor=white&color=5fa04e" alt="Node"></a>
	<a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-kit-8b5cf6" alt="MCP"></a>
	<a href="LICENSE"><img src="https://img.shields.io/github/license/aimuzov/infra-mcp-kit" alt="License"></a>
</p>

<h3 align="center">Одна основа для всех MCP-серверов aimuzov</h3>
<p align="center">Ядро на stdio, размещённый OAuth-коннектор, страницы коннектора и хелперы для тестов</p>

Общие части MCP-серверов aimuzov, собранных из [infra-mcp-template](https://github.com/aimuzov/infra-mcp-template). Правка OAuth, CLI или внешнего вида страниц коннектора попадает сюда один раз, а не в каждый сервер.

## Что внутри

- [**Ядро**](#ядро): `runCli`, `serveStdio`, результаты инструментов, хелперы окружения, `dataDir`, логгер в stderr и `readVersion`.
- [**HTTP и OAuth**](#http-и-oauth): `/mcp` без состояния поверх Streamable HTTP, OAuth-сервер с одноразовыми кодами и ротацией refresh-токенов, вход через Telegram и форму токена, JSON-API для кабинета.
- [**Страницы**](#страницы): Astro-интеграция `mcpPages()` с лендингом, входом, страницами ошибки и 404 в стиле «Сигнал».
- [**Тесты**](#тесты): клиенты в памяти и по HTTP и весь OAuth-поток для `node --test`.
- [**Actions**](#actions) `check` и `publish` для workflow серверов.
- [**Переезд с 1.x**](#переезд-с-1x).

## Установка

```bash
npm install -E github:aimuzov/infra-mcp-kit#v2.0.0
```

npm собирает пакет при установке, `prepare` запускает `tsc`. Peer-зависимость `@modelcontextprotocol/sdk` остаётся в сервере. Публикация в npm готова, но выключена, пока в репо не задана переменная `NPM_PUBLISH`.

## Ядро

```ts
import { readVersion, runCli } from '@aimuzov/infra-mcp-kit'

await runCli({
	name: 'example',
	version: readVersion(import.meta.url),
	usage: 'example: MCP server\n\nUsage: example [serve [--http] | --help | --version]',
	stdio: () => createServer(),
	http: () => import('./http.ts').then((m) => m.serve()),
	commands: { sync: (args) => sync(args) },
})
```

- `runCli` обрабатывает `--help`, `--version`, `serve` (stdio, и без аргументов тоже), `serve --http` и собственные `commands` сервиса. Неизвестная команда печатает usage и выходит с кодом 2, любая ошибка печатается одной строкой `name: message` с кодом 1, стек — при `LOG_LEVEL=debug`.
- `serveStdio(server, name)` подключает сервер к stdio.
- `text`, `json` (обычный объект попадает и в `structuredContent`) и `failure` собирают результат инструмента. `tool(handler)` оборачивает обработчик: строка становится текстом, объект — JSON, брошенная ошибка — `failure` и строкой в логе.
- `str`, `required`, `int`, `bool` и `list` читают окружение строго: опечатка в числе или флаге останавливает запуск с именем переменной. `loadEnvFile()` читает `.env`, не перезаписывая то, что уже задано.
- `dataDir(name)` — это `<NAME>_DATA_DIR`, затем `$XDG_CONFIG_HOME/<name>`, затем `~/.config/<name>`.
- `log` пишет только в stderr: stdout принадлежит протоколу. `LOG_LEVEL` — `error`, `warn`, `info` (по умолчанию) или `debug`, `LOG_FILE` добавляет файл.
- `readVersion(import.meta.url)` находит ближайший `package.json`, поэтому рукопожатие MCP не отстаёт от релиза.

## HTTP и OAuth

```ts
import { loadHttpConfig, serveHttp, sqliteStore, tokenFormLogin } from '@aimuzov/infra-mcp-kit/http'

await serveHttp({
	config: loadHttpConfig(),
	service: { name: 'example' },
	publicDir: new URL('../build/public', import.meta.url).pathname,
	createServer: (auth) => createServer(auth?.extra),
	auth: {
		store: sqliteStore(`${dataDir('example')}/auth.db`),
		tokens: 'encrypt',
		login: tokenFormLogin({ fields: [{ name: 'token', label: 'API-токен' }], verify }),
	},
})
```

`createHttpApp` отдаёт приложение express, `serveHttp` ещё и слушает `PORT`. Маршруты:

- `POST /mcp` создаёт новый сервер и транспорт на каждый запрос. С `auth` требует Bearer-токен, другие методы получают 405.
- `GET /health` отвечает `{ "ok": true }`.
- OAuth: метаданные в `/.well-known/`, `/register`, `/authorize`, `/token`, `/revoke` и `/authorize/callback`.
- Страницы из `publicDir`, `/x` отдаёт `x.html`. Браузер на неизвестный адрес получает `404.html`, при сбое — страницу `/error`, `fetch` получает JSON.
- `routes(app, context)` добавляет собственное API сервиса.

`loadHttpConfig()` читает `PUBLIC_URL` (origin, https везде, кроме loopback), `AUTH_SECRET` (от 32 символов, `openssl rand -base64 48`), `PORT` (8080) и `ALLOWED_REDIRECT_URIS`. Колбэки Claude и loopback-адреса разрешены всегда, список добавляется к ним.

Правила OAuth:

- Клиент регистрируется максимум с 10 redirect URI, каждый проверяется.
- Код авторизации живёт 5 минут, работает один раз и только для своего клиента.
- Access-токен живёт час. Refresh-токен живёт 30 дней и работает один раз: обмен выдаёт новый токен той же цепочки, а повтор уже потраченного отзывает всю цепочку. Цепочка живёт не дольше 90 дней от входа.
- `tokens: 'sign'` выдаёт JWT HS256, `'encrypt'` — JWE. Вход, который несёт чужой секрет, как форма токена, требует `encrypt`: из токена секрет не прочитать.
- `memoryStore()` держит клиентов и коды в памяти, `sqliteStore(path)` — в `node:sqlite`, поэтому деплой никого не разлогинивает. `store.revokeSubject(sub)` отзывает всё, что выдано человеку.

Вход — это статическая страница и хук `complete(req)`, который говорит, кто вернулся:

- `telegramLogin({ botToken })` проверяет подпись виджета Telegram, вход старше 10 минут или повторный отклоняется. `devUserId` включает `?dev=1` на loopback.
- `tokenFormLogin({ fields, verify })` принимает форму POST-запросом. `verify` возвращает `{ subject, claims }`, и claims доходят до `createServer` в `auth.extra`. `LoginError` возвращает человека на форму со своим текстом.

Контекст входа — подписанный запрос, клиент и ошибка прошлой попытки — едет во фрагменте адреса и не попадает ни в логи сервера, ни в прокси.

Для кабинета: `sessions(tokens, publicUrl)` даёт подписанную httpOnly-куку, `requireSession` без неё отвечает 401, `sameOrigin` отвечает 403 на чужой `Origin`, `sendJson` и `apiError` отвечают в одном формате.

## Страницы

Страницы коннектора статические: Astro собирает их в `build/public` при `npm run build` сервера, сервер только отдаёт файлы. Всё, что зависит от человека, — контекст входа или данные кабинета — дорисовывают Svelte-острова в браузере.

Они собраны из [infra-site-kit](https://github.com/aimuzov/infra-site-kit), как и сайты: строка автора, переключатель темы с кругом подсмотра, базовые стили, страница 404 и UI-компоненты. Тема «Сигнал» переносит их токены на свою палитру, сервис приносит свой акцентный цвет.

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
				tagline: 'Что он делает',
				tools: ['search'],
			},
			tokenForm: {
				title: 'Подключение example',
				fields: [{ name: 'token', label: 'API-токен', type: 'password' }],
			},
		}),
	],
})
```

- `mcpPages` добавляет `/`, `/error`, `/404`, `/login` с `tokenForm` и `/login/telegram` с `telegram: { botName, grants }`. `override` оставляет страницу сервису. `service.accent` принимает цвета `{ light, dark }`.
- У страниц строгий CSP: скрипты и стили по хешу, всё остальное с `'self'`.
- Своя страница сервиса строится на `@aimuzov/infra-mcp-kit/astro/layout.astro`. Острова лежат в `astro/components`: `AccountShell` загружает `/account/state` и на 401 показывает вход, `Connect` показывает адрес коннектора.
- Dev-зависимости сервера: `astro`, `@astrojs/svelte`, `svelte`, `@aimuzov/infra-site-kit` и `postcss-nested`, а также `svelte.config.js` с `vitePreprocess()` и `postcss.config.mjs` с `postcss-nested`. В рантайм и в `npx` они не попадают.

Рабочий пример — [`e2e/connector`](e2e/connector).

## Тесты

```ts
import {
	connectInMemory,
	expectTools,
	fakePages,
	oauthFlow,
	startHttp,
	submitForm,
} from '@aimuzov/infra-mcp-kit/testing'

const client = await connectInMemory(createServer())

await expectTools(client, ['search'])

const { base } = await startHttp(() => createHttpApp({ ...options, publicDir: fakePages() }).app)
const { tokens, exchangeAgain } = await oauthFlow({ base, login: submitForm({ token: 'good' }) })
```

- `connectInMemory` и `connectHttp` дают клиента SDK. `expectTools` сверяет список инструментов, `textOf` склеивает текстовый ответ.
- `startHttp` слушает случайный порт на 127.0.0.1.
- `oauthFlow` проходит регистрацию, авторизацию, вход, колбэк и обмен кода. `submitForm`, `telegramSigned` и `devLink` покрывают готовые способы входа, `exchangeAgain` и `refresh` проверяют одноразовость.
- `fakePages()` даёт `publicDir` без сборки Astro.

## Actions

`.github/workflows/check.yml` сервера:

```yaml
jobs:
    check:
        runs-on: ubuntu-latest
        timeout-minutes: 15
        steps:
            - uses: aimuzov/infra-mcp-kit/check@v2
              with:
                  docker: deploy/Dockerfile
```

- `check`: `npm ci`, Prettier, oxlint, типы, `astro check` и `svelte-check` при наличии `astro.config.mjs`, `node --test`, сборка и `smoke` (`node build/index.js --help`). Потом упаковывает сервер, ставит тарбол без dev-зависимостей, как это сделает `npx`, и запускает его `--help`. С `docker` ещё и собирает образ. Пакеты Ubuntu передаются в `apt-packages`.
- `publish`: `npm publish --provenance` релизного тега, по `npm-token` или через trusted publishing.

Это composite actions: job остаётся в сервере, поэтому обязательная проверка `check` не меняет имени.

## Релизы

release-please через [aimuzov/.github](https://github.com/aimuzov/.github) ведёт релизный PR. Его мёрж выпускает релиз, проверки проходят ещё раз, и мажорный тег `v2` переезжает на него, поэтому `check@v2` подхватывает патчи.

Необязательные входы action:

- `coverage-lines: 95` валит проверку при покрытии строк ниже 95%. Скрипт `test` должен начинаться с `node`: флаги покрытия action ставит сразу за ним, потому что ни в `NODE_OPTIONS`, ни после глоба тестов Node их не принимает. Тесты, `*.e2e.ts` и хелперы из `testing/` в счёт не идут.
- `astro-tsconfig: tsconfig.astro.json` -- свой конфиг для `astro check` и `svelte-check`, когда корневой отдан серверу.
- `ui: true` после сборки гоняет `npm run test:ui` в Chromium, браузер кэшируется по версии Playwright.

Сервер с `/http` держит `@types/express` в devDependencies: на него ссылаются типы кита, а установке без dev-зависимостей он не нужен. Страницам нужен infra-site-kit 4.1.1 или новее: CSP кита больше не пускает атрибут `style`, а старые `Skeleton` и `InfoTip` его пишут.

## Переезд с 1.x

2.0 отказывается от HTML, который сервер рисовал на запрос: все страницы собирает Astro.

1. Добавь страницы: dev-зависимости выше, `astro.config.mjs` с `mcpPages()`, `svelte.config.js` и `postcss.config.mjs`. `npm run build` становится `tsc` и затем `astro build`.
2. Передай `publicDir` в `createHttpApp` или `serveHttp`, с `auth` он обязателен. `landing` убран, `service` — только `{ name }`: репозиторий, акцент и тексты переехали в `mcpPages`.
3. У `telegramLogin` больше нет `botName` и `grants`, у `tokenFormLogin` — `title`, `lead` и `submit`: они живут в `mcpPages`. Свой `Login` заменяет `render` на `page`, путь к своей статической странице.
4. Убраны `ui`, `html`, `raw`, `escapeHtml`, `SafeHtml` и ассеты `/_kit/*`. Кабинет — это страница сервиса с островом в `AccountShell`, который обслуживают `requireSession` и `sendJson`.
5. Ошибки ведут редиректом на статическую `/error`, неизвестные адреса получают `404.html` или JSON.
6. Тесты: `/authorize` отвечает 302 на страницу входа, `oauthFlow` передаёт в `login` разобранный `LoginStep` вместо HTML. `callbackFrom` и `hiddenField` убраны.
7. CI: `aimuzov/infra-mcp-kit/check@v2`.
