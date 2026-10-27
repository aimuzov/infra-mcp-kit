# Changelog

## [3.4.0](https://github.com/aimuzov/infra-mcp-kit/compare/v3.3.0...v3.4.0) (2026-10-27)


### Features

* **astro:** describe the token form once and hide its fields at runtime ([9877031](https://github.com/aimuzov/infra-mcp-kit/commit/98770312a65753f6f3bde9d3a97f28d413360840))
* **astro:** let a service add cards and slots to the landing ([21bd7b3](https://github.com/aimuzov/infra-mcp-kit/commit/21bd7b3838ebf5686a811380294f02d5292ac6ec))
* **deps:** move the pages to infra-site-kit 5.8.1 with its language menu ([f013037](https://github.com/aimuzov/infra-mcp-kit/commit/f013037e52dd05836a84ddf6de98daad452bd6e6))
* **http:** Telegram sign-in for the account and the bot name at runtime ([e995b2c](https://github.com/aimuzov/infra-mcp-kit/commit/e995b2cfbbb44f0b2f4bcafbc9896ea688722fe1))


### Bug Fixes

* **check:** reliable Chromium install, and an explicit infra-site-kit minimum ([58ae467](https://github.com/aimuzov/infra-mcp-kit/commit/58ae46728e77fd46285306bbe9887b5cf29d4bbf))
* **http:** read the session only under the Host prefix over https ([fb2c569](https://github.com/aimuzov/infra-mcp-kit/commit/fb2c569430dbaad5ba79db444648f31fd14d0889))

## [3.3.0](https://github.com/aimuzov/infra-mcp-kit/compare/v3.2.1...v3.3.0) (2026-10-27)


### Features

* report errors to Sentry when SENTRY_DSN is set ([8651c2d](https://github.com/aimuzov/infra-mcp-kit/commit/8651c2d25899e395aaef0c1cb861442cd4503b36))
* report errors to Sentry when SENTRY_DSN is set ([dc5819c](https://github.com/aimuzov/infra-mcp-kit/commit/dc5819c71890ef77fe7ebdd60d214d32c7a267ab))
* reuse a Sentry client the server started itself ([ea62822](https://github.com/aimuzov/infra-mcp-kit/commit/ea628220fde02951a31073936e731a6f85e8031b))


### Bug Fixes

* harden the Sentry transport and the crash path ([daf51b3](https://github.com/aimuzov/infra-mcp-kit/commit/daf51b36c614041ad4efd363ba9ec982063b18d6))
* report a crash after a captured error and never send thrown objects ([51b32ca](https://github.com/aimuzov/infra-mcp-kit/commit/51b32ca55cbdc98c345a6d3a8d46818446af0d05))
* report repeated errors instead of deduping them ([9638529](https://github.com/aimuzov/infra-mcp-kit/commit/963852915de74f9b7d17c60513ca8c6fa975e926))
* skip a closed Sentry client of the server ([aea50a2](https://github.com/aimuzov/infra-mcp-kit/commit/aea50a27026f2b15d84628693ade7ca87c92c19e))
* time out a Sentry request that hangs ([99221b1](https://github.com/aimuzov/infra-mcp-kit/commit/99221b13165b58c78adb97ee17a52b76187f2a58))

## [3.2.1](https://github.com/aimuzov/infra-mcp-kit/compare/v3.2.0...v3.2.1) (2026-10-27)


### Bug Fixes

* **deps:** move to tmcp 1.20.1 and drop the initialize workaround ([23e28ac](https://github.com/aimuzov/infra-mcp-kit/commit/23e28ac353871435f39c9e7f6691ccaf84a7a3da))
* **deps:** move to tmcp 1.20.1 and drop the initialize workaround ([525c0d7](https://github.com/aimuzov/infra-mcp-kit/commit/525c0d71af476c732fd763b9de25803cfa74b148))

## [3.2.0](https://github.com/aimuzov/infra-mcp-kit/compare/v3.1.0...v3.2.0) (2026-10-26)


### Features

* build connector pages in Russian and English with a language switch ([5cd5cfd](https://github.com/aimuzov/infra-mcp-kit/commit/5cd5cfd2c6ad6512f28940ea986dd894a2dbd886))
* build connector pages in Russian and English with a language switch ([e24155b](https://github.com/aimuzov/infra-mcp-kit/commit/e24155b5e3a1d57020db6b81f0fd213849cc16af))

## [3.1.0](https://github.com/aimuzov/infra-mcp-kit/compare/v3.0.2...v3.1.0) (2026-10-26)


### Features

* **astro:** let a tool chip carry a Lucide icon ([8180f77](https://github.com/aimuzov/infra-mcp-kit/commit/8180f77c2ffa5abcf7267e87caf02d2d4c8bf2a0))
* **astro:** rework the connect block into a copy plate and tabs ([1ff4eed](https://github.com/aimuzov/infra-mcp-kit/commit/1ff4eed7440b06201078c34c59d8e53066e96653))
* **astro:** show the service mark and tint the glitch in its colours ([11805c4](https://github.com/aimuzov/infra-mcp-kit/commit/11805c48763c6f5d95099f7e7db5e7c18f44cc7b))


### Bug Fixes

* **astro:** keep the author's mask for the footer and put a plug icon in the header ([f32dd42](https://github.com/aimuzov/infra-mcp-kit/commit/f32dd42b297fee1523165bc1b0b5d3db259d311f))

## [3.0.2](https://github.com/aimuzov/infra-mcp-kit/compare/v3.0.1...v3.0.2) (2026-10-25)


### Bug Fixes

* **deps:** move to infra-site-kit 4.1.2 so the theme peek stops lagging ([3c8725d](https://github.com/aimuzov/infra-mcp-kit/commit/3c8725d20a2fdaeba2868e67025a3fd68fe659dd))
* **deps:** move to infra-site-kit 4.1.2 so the theme peek stops lagging ([1a2f97e](https://github.com/aimuzov/infra-mcp-kit/commit/1a2f97e341e7b8f0e85bcdc84ae1c2be4713c054))

## [3.0.1](https://github.com/aimuzov/infra-mcp-kit/compare/v3.0.0...v3.0.1) (2026-10-25)


### Bug Fixes

* **ui:** name the page an MCP connector in the header ([02f0779](https://github.com/aimuzov/infra-mcp-kit/commit/02f07792cd0f37593b1d33995143dc1641b30e87))
* **ui:** name the page an MCP connector in the header ([a8a4725](https://github.com/aimuzov/infra-mcp-kit/commit/a8a4725d7bdb6fe6f51888f50d3a6eb5e26a49cb))

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
