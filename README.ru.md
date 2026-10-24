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
<p align="center">Ядро для stdio, удалённый коннектор с OAuth, страницы входа в одном стиле и помощники для тестов</p>

Общие части MCP-серверов aimuzov. Исправление в OAuth или во внешнем виде страниц входа делается здесь один раз, а не в каждом сервере.

Пакет собирается из TypeScript и публикуется в npm: сами серверы ставятся через `npx` и тащить зависимость с GitHub не могут.

## Что внутри

- `@aimuzov/infra-mcp-kit`: `runCli` (stdio по умолчанию, `serve --http`, `--help`, свои подкоманды), `serveStdio`, ответы инструментов `text`, `json`, `failure` и обёртка `tool`, хелперы окружения, `dataDir`, логгер в stderr и `readVersion`.
- `@aimuzov/infra-mcp-kit/http`: `createHttpApp` и `serveHttp` со `/mcp` без состояния по Streamable HTTP, OAuth на роутере SDK, `/health` и лендинг. Вход сервис подключает двумя хуками: `render` рисует страницу, `complete` по возвращению человека говорит, кто это. Готовые входы: `telegramLogin` и `tokenFormLogin`. Коды лежат в `memoryStore` или `sqliteStore` и срабатывают ровно один раз; токены подписаны, а если в claims едет чужой API-ключ, зашифрованы.
- `@aimuzov/infra-mcp-kit/testing`: `connectInMemory`, `expectTools`, `startHttp`, `oauthFlow` и `connectHttp` для `node --test`.
- Actions `check` и `publish` для workflow серверов.

Все страницы рисуются через `src/http/ui`, без инлайн-скриптов и стилей, под строгим CSP. Стиль общий для всех коннекторов, у каждого сервера только свой цвет.

## Подключение

```bash
npm install -E @aimuzov/infra-mcp-kit
```

Пример точки входа и workflow проверки -- в [README.md](README.md#usage).

Подробная документация появится вместе с переездом серверов на кит.
