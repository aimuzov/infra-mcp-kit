<p align="center">
	<a href="README.md"><img src="https://img.shields.io/badge/English-555?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MCAzMCI+PGNsaXBQYXRoIGlkPSJ0Ij48cGF0aCBkPSJNMzAsMTVoMzB2MTV6djE1aC0zMHpoLTMwdi0xNXp2LTE1aDMweiIvPjwvY2xpcFBhdGg+PHBhdGggZD0iTTAsMHYzMGg2MHYtMzB6IiBmaWxsPSIjMDEyMTY5Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTAsMCA2MCwzME02MCwwIDAsMzAiIGNsaXAtcGF0aD0idXJsKCN0KSIgc3Ryb2tlPSIjQzgxMDJFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMTAiLz48cGF0aCBkPSJNMzAsMHYzME0wLDE1aDYwIiBzdHJva2U9IiNDODEwMkUiIHN0cm9rZS13aWR0aD0iNiIvPjwvc3ZnPg==" alt="English"></a>
	<img src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-8b5cf6?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5IDYiPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0wIDBoOXYzSDB6Ii8+PHBhdGggZmlsbD0iIzAwMzlhNiIgZD0iTTAgMmg5djJIMHoiLz48cGF0aCBmaWxsPSIjZDUyYjFlIiBkPSJNMCA0aDl2MkgweiIvPjwvc3ZnPg==" alt="Русский">
</p>

<p align="center">
	<a href="https://github.com/aimuzov/infra-mcp-kit/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/aimuzov/infra-mcp-kit/check.yml?branch=main&label=check" alt="Check"></a>
	<a href="https://www.npmjs.com/package/@aimuzov/infra-mcp-kit"><img src="https://img.shields.io/npm/v/@aimuzov/infra-mcp-kit?label=npm" alt="npm"></a>
	<a href="package.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Faimuzov%2Finfra-mcp-kit%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&logo=nodedotjs&logoColor=white&color=5fa04e" alt="Node"></a>
	<a href="LICENSE"><img src="https://img.shields.io/github/license/aimuzov/infra-mcp-kit" alt="License"></a>
</p>

<h3 align="center">Общая основа MCP-серверов aimuzov</h3>
<p align="center">Ядро для stdio, удалённый коннектор с OAuth, страницы на Astro и помощники для тестов</p>

Общие части MCP-серверов aimuzov. Исправление в OAuth или во внешнем виде страниц коннектора делается здесь один раз, а не в каждом сервере.

Пакет собирается из TypeScript и публикуется в npm: сами серверы ставятся через `npx` и тащить зависимость с GitHub не могут.

## Что внутри

- `@aimuzov/infra-mcp-kit`: `runCli` (stdio по умолчанию, `serve --http`, `--help`, свои подкоманды), `serveStdio`, ответы инструментов `text`, `json`, `failure` и обёртка `tool`, хелперы окружения, `dataDir`, логгер в stderr и `readVersion`.
- `@aimuzov/infra-mcp-kit/http`: `createHttpApp` и `serveHttp` со `/mcp` без состояния по Streamable HTTP, OAuth на роутере SDK, `/health` и страницы из `publicDir`, собранные `/astro`. Вход -- статическая страница и хук `complete`, который по возвращению человека говорит, кто это; готовые входы: `telegramLogin` и `tokenFormLogin`. Коды лежат в `memoryStore` или `sqliteStore` и срабатывают ровно один раз; токены подписаны, а если в claims едет чужой API-ключ, зашифрованы. `apiError`, `sendJson`, `requireSession` и `errorPage` -- для JSON-API за кабинетом.
- `@aimuzov/infra-mcp-kit/astro`: интеграция `mcpPages()` для Astro с лендингом, входом (токен-форма и Telegram), страницами ошибки и 404, layout и Svelte-островами для своих страниц сервиса, например `AccountShell`.
- `@aimuzov/infra-mcp-kit/testing`: `connectInMemory`, `expectTools`, `startHttp`, `oauthFlow` с `submitForm`, `telegramSigned` и `devLink`, `fakePages` и `connectHttp` для `node --test`.
- Actions `check` и `publish` для workflow серверов.

## Страницы

Страницы коннектора статические: Astro собирает их в `build/public` при `npm run build` сервера, а сервер только раздаёт файлы и держит OAuth, `/mcp`, `/health` и небольшое JSON-API. Всё, что зависит от человека, контекст входа и данные кабинета, дорисовывают Svelte-острова в браузере.

Собраны они из частей [infra-site-kit](https://github.com/aimuzov/infra-site-kit), как у сайтов: подпись автора, переключатель темы с кругом подглядывания, базовые стили корня, страница 404 и компоненты (карточка, кнопка, поле, предупреждение, скелетон, дропзона). Тема "Сигнал" только переназначает их токены `--ui-*` и `--credit-*` на свою палитру и оформляет раскладку страниц. От сервиса -- только его цвет.

Контекст входа (подписанный запрос авторизации, клиент и ошибка прошлой попытки) едет во фрагменте адреса, поэтому не попадает ни в логи сервера, ни в прокси.

Страницы собирает сервер, поэтому всё нужное для этого остаётся в его devDependencies и не попадает в рантайм и `npx`: `astro`, `@astrojs/svelte`, `svelte`, `@aimuzov/infra-site-kit`, `@lucide/svelte` и `postcss-nested`. Как у сайтов, у сервера лежат `svelte.config.js` с `vitePreprocess()` и `postcss.config.mjs` с `postcss-nested`: без них компоненты site-kit не собираются. Рабочий пример -- [`e2e/connector`](e2e/connector), конфиг и точка входа -- в [README.md](README.md#pages).

## Подключение

```bash
npm install -E @aimuzov/infra-mcp-kit
```

Workflow проверки сервера -- `aimuzov/infra-mcp-kit/check@v2`. Если в репозитории есть `astro.config.mjs`, action гоняет ещё `astro check` и `svelte-check`.

Необязательные входы action:

- `coverage-lines: 95` валит проверку при покрытии строк ниже 95%. Скрипт `test` должен начинаться с `node`: флаги покрытия action ставит сразу за ним, потому что ни в `NODE_OPTIONS`, ни после глоба тестов Node их не принимает. Тесты, `*.e2e.ts` и хелперы из `testing/` в счёт не идут.
- `astro-tsconfig: tsconfig.astro.json` -- свой конфиг для `astro check` и `svelte-check`, когда корневой отдан серверу.
- `ui: true` после сборки гоняет `npm run test:ui` в Chromium, браузер кэшируется по версии Playwright.

Сервер с `/http` держит `@types/express` в devDependencies: на него ссылаются типы кита, а установке без dev-зависимостей он не нужен. Страницам нужен infra-site-kit 4.1.1 или новее: CSP кита больше не пускает атрибут `style`, а старые `Skeleton` и `InfoTip` его пишут.

## Переезд с 1.x

В 2.0 сервер больше не рисует HTML на запрос: все страницы собирает Astro.

1. Добавить страницы: devDependencies выше, `astro.config.mjs` с `mcpPages()`, `svelte.config.js` и `postcss.config.mjs`. `npm run build` -- это `tsc`, затем `astro build`, а в `files` у `package.json` остаётся `build`, поэтому `npx` получает и `build/public`.
2. Передать `publicDir` в `createHttpApp` или `serveHttp`. С `auth` он обязателен: вход теперь статическая страница. `landing` больше нет, лендинг рисует `mcpPages({ service })`. `service` у сервера -- только `{ name }`, а `repo`, `accent` и тексты переехали в `mcpPages`.
3. Вход: у `telegramLogin` нет `botName` и `grants`, у `tokenFormLogin` -- `title`, `lead` и `submit`, они живут в `mcpPages({ telegram, tokenForm })`. Свой `Login` вместо `render` задаёт `page`, путь своей статической страницы, и может дописать во фрагмент `context`. `LoginPageContext`, `KitOAuthProvider.renderLogin` и `telegramButton` удалены.
4. Неймспейса `ui`, `html`, `raw`, `escapeHtml`, `SafeHtml` и ассетов `/_kit/*` больше нет. Кабинет -- страница самого сервиса: `src/frontend/pages/account.astro` на layout кита и остров в `AccountShell`, который грузит `/account/state` и на 401 показывает вход. Сервер отвечает на этот маршрут через `requireSession` и `sendJson`.
5. Ошибки: колбэк OAuth редиректит на статическую `/error`, а не рисует её; на незнакомый адрес браузер получает `404.html`, а `fetch` -- JSON-ошибку; `sameOrigin` отвечает 403 JSON-ошибкой.
6. Тесты: `/authorize` отвечает 302 на страницу входа. `oauthFlow` отдаёт колбэку `login` разобранный `LoginStep` вместо HTML страницы; готовые входы закрывают `submitForm`, `telegramSigned` и `devLink`, а `fakePages()` даёт `publicDir` без сборки Astro. `callbackFrom` и `hiddenField` удалены.
7. CI: `aimuzov/infra-mcp-kit/check@v2`.
