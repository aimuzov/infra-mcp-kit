# Changelog

## [3.0.0](https://github.com/aimuzov/infra-mcp-kit/compare/v2.1.0...v3.0.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* createHttpApp returns { handle, listener, context }, routes take a Request and return a Response, the account helpers work with Request and Response, Login.complete gets { request, method, query, form }, mountOAuth is oauthRouter. See "Migrating from 2.x" in the README.

### Features

* move the kit to tmcp and drop express ([bcc719a](https://github.com/aimuzov/infra-mcp-kit/commit/bcc719a1f58adde22f6afc28b5a96978c16095d5))

## [2.1.0](https://github.com/aimuzov/infra-mcp-kit/compare/v2.0.0...v2.1.0) (2026-10-25)


### Features

* **check:** add coverage-lines, astro-tsconfig and ui inputs ([6cfcd6a](https://github.com/aimuzov/infra-mcp-kit/commit/6cfcd6aeb07af2170a1eda0086a69a92f2cd4826))
* cover the kit before tmcp, tighten the CSP and add coverage to the check action ([9ba08cf](https://github.com/aimuzov/infra-mcp-kit/commit/9ba08cf3a4bab9b38b1c0e3446c43996bb2252ff))
* **testing:** expose Login.context in loginStep ([ca0ed20](https://github.com/aimuzov/infra-mcp-kit/commit/ca0ed2096a20249fcf0038eaa020d82694a84672))


### Bug Fixes

* **pages:** drop inline style attributes from the CSP and make @types/express an optional peer ([5ca6c76](https://github.com/aimuzov/infra-mcp-kit/commit/5ca6c768f7328d9caf7030088d770b76891242f0))
* **pages:** ship CopyValue styles on the landing and keep hints left-aligned ([35dde62](https://github.com/aimuzov/infra-mcp-kit/commit/35dde6201636dc6ae35430ccfefc0a0d104dead9))

## [2.0.0](https://github.com/aimuzov/infra-mcp-kit/compare/v1.0.3...v2.0.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* the SSR layer `src/http/ui` is gone: `ui`, `html`, `escapeHtml`, `landing`, `Login.render` and `telegramButton` are removed, sign-in needs a static page and `createHttpApp` with `auth` needs `publicDir`. The migration steps are in the README.

### Features

* build the connector pages with Astro on infra-site-kit parts ([8c8edfd](https://github.com/aimuzov/infra-mcp-kit/commit/8c8edfd2a8f4598f5095453dcf9877ff297452b3))

## [1.0.3](https://github.com/aimuzov/infra-mcp-kit/compare/v1.0.2...v1.0.3) (2026-10-25)


### Bug Fixes

* harden the hosted connector and the core after the architecture review ([b42e809](https://github.com/aimuzov/infra-mcp-kit/commit/b42e809a064b28df006754ba44bb45720a7017fd))

## [1.0.2](https://github.com/aimuzov/infra-mcp-kit/compare/v1.0.1...v1.0.2) (2026-10-25)


### Bug Fixes

* keep OAuth error text ASCII so a bad token gets 401, not 500 ([f6b1bc6](https://github.com/aimuzov/infra-mcp-kit/commit/f6b1bc651f27cc68b3fdfd3e711c41c4c78e86c8))
* keep OAuth error text ASCII so a bad token gets 401, not 500 ([ad25898](https://github.com/aimuzov/infra-mcp-kit/commit/ad25898a21169eb879a5407ceabda8f237ae98cf))

## [1.0.1](https://github.com/aimuzov/infra-mcp-kit/compare/v1.0.0...v1.0.1) (2026-10-24)


### Bug Fixes

* build the kit on prepare so git installs get build/ ([38bb83d](https://github.com/aimuzov/infra-mcp-kit/commit/38bb83d488e2576efc456a77e03d2a999e4f8583))
* build the kit on prepare so git installs get build/ ([3a47206](https://github.com/aimuzov/infra-mcp-kit/commit/3a47206b3bf097e3acfecb728d70ae776f01a518))

## 1.0.0 (2026-10-24)


### Features

* add the MCP kit with stdio core, hosted OAuth, UI pages and test helpers ([d00486a](https://github.com/aimuzov/infra-mcp-kit/commit/d00486a3141ab44193543e07e0fbcfc507f147a9))
* add the MCP kit with stdio core, hosted OAuth, UI pages and test helpers ([3af5a61](https://github.com/aimuzov/infra-mcp-kit/commit/3af5a61783b372ea53797c9e848ee9130ff5f943))
* **ui:** polish the Signal pages and cover them with render and browser tests ([2839bdc](https://github.com/aimuzov/infra-mcp-kit/commit/2839bdcf0c484ecc7a2facab6a5a90195a537564))
* **ui:** polish the Signal pages and cover them with render and browser tests ([4e98133](https://github.com/aimuzov/infra-mcp-kit/commit/4e98133464d74a8d4714535493ec7f36b8d08e32))


### Bug Fixes

* keep prettier off the release-please manifest ([20eb142](https://github.com/aimuzov/infra-mcp-kit/commit/20eb142a534253e795f5706028cb7a0e304bc1c0))
* keep prettier off the release-please manifest ([e317e5f](https://github.com/aimuzov/infra-mcp-kit/commit/e317e5f73458a226255bd7e7d42c6ad570944357))
