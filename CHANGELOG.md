# Changelog

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
