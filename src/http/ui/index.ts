/**
 * Страницы кита: лендинг коннектора, вход, согласие, ошибка и каркас кабинета.
 *
 * Это шов под общий стиль «Сигнал»: остальной кит и серверы зовут только функции отсюда,
 * поэтому разметку и CSS можно менять, не трогая OAuth и маршруты. Страницы без
 * инлайн-скриптов и инлайн-стилей, всё оформление лежит в /_kit/*, и CSP из `CSP` их пускает.
 */
import { readFileSync } from 'node:fs'

import { html, raw, SafeHtml, type HtmlValue } from './html.ts'
import { MARK, MARK_VIEWBOX } from './mark.ts'

export { escapeHtml, html, raw, SafeHtml, type HtmlValue } from './html.ts'

export type Service = {
	/** Короткое имя в шапке и заголовках, например `thinks`. */
	name: string
	/** Репозиторий для ссылки «Исходный код» в подвале. */
	repo?: string
	/** Цвет сервиса для светлой и тёмной темы. */
	accent?: { light: string; dark: string }
}

export type Client = {
	name?: string
	/** Хост, куда уйдёт код: его человек и должен узнать. */
	host: string
}

/** Где кит раздаёт ассеты страниц. */
export const ASSETS_PATH = '/_kit'

const asset = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8')

/** Статика страниц: путь под `ASSETS_PATH` → тип и содержимое. */
export function assets(service: Service): Record<string, { type: string; body: string }> {
	const accent = service.accent ?? { light: '#6d4aff', dark: '#a48bff' }

	return {
		'kit.css': { type: 'text/css', body: asset('kit.css') },
		'kit.js': { type: 'text/javascript', body: asset('kit.js') },
		'service.css': {
			type: 'text/css',
			body: `:root { --hue-light: ${cssColor(accent.light)}; --hue-dark: ${cssColor(accent.dark)}; }\n`,
		},
	}
}

/** Цвет из конфига сервиса попадает в CSS, поэтому пускаем только то, что похоже на цвет. */
function cssColor(value: string): string {
	if (!/^[#a-z0-9(),.%\s-]+$/i.test(value)) throw new Error(`Неподходящий цвет: ${value}`)

	return value
}

/**
 * CSP страниц кита. Telegram-виджет грузит скрипт с telegram.org и рисует iframe
 * с oauth.telegram.org, остальное только своё. `form-action` не задаём: после POST формы
 * входа сервер редиректит на колбэк клиента, а Chrome проверяет по `form-action` и редирект.
 */
export const CSP = [
	"default-src 'self'",
	"script-src 'self' https://telegram.org",
	"style-src 'self'",
	"img-src 'self' data: https://t.me https://telegram.org",
	'frame-src https://oauth.telegram.org',
	"base-uri 'none'",
	"frame-ancestors 'none'",
	"object-src 'none'",
].join('; ')

export const mark = (cls = 'mark'): SafeHtml =>
	html`<svg class="${cls}" viewBox="${MARK_VIEWBOX}" fill="currentColor" aria-hidden="true">
		<path fill-rule="evenodd" d="${MARK}" />
	</svg>`

const GITHUB =
	'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z'

function credit(repo?: string): SafeHtml {
	return html`<footer class="credit">
		<span
			>${new Date().getFullYear()}&nbsp;© Сделано с&nbsp;любовью
			<a href="https://github.com/aimuzov">${mark('credit__mark')}aimuzov</a></span
		>
		${
			repo &&
			html`<a href="${repo}"
				><svg class="credit__gh" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path d="${GITHUB}" /></svg
				>Исходный код</a
			>`
		}
	</footer>`
}

export type DocumentOptions = {
	service: Service
	title: string
	main: HtmlValue
	/** Имя экрана на `<html data-screen>`: по нему CSS может отличать страницы. */
	screen?: string
	/** Дополнительные скрипты с того же origin, например клиентская часть кабинета. */
	scripts?: string[]
}

/** Документ целиком: шапка с сервисом и переключателем темы, содержимое, подвал автора. */
export function document({ service, title, main, screen = 'page', scripts = [] }: DocumentOptions): string {
	return `<!doctype html>\n${html`<html lang="ru" data-screen="${screen}">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width,initial-scale=1" />
			<meta name="color-scheme" content="light dark" />
			<title>${title}</title>
			<link rel="stylesheet" href="${ASSETS_PATH}/kit.css" />
			<link rel="stylesheet" href="${ASSETS_PATH}/service.css" />
			<script src="${ASSETS_PATH}/kit.js"></script>
			${scripts.map((src) => html`<script src="${src}" defer></script>`)}
		</head>
		<body>
			<div class="shell">
				<header class="top">
					<a class="brand" href="/"
						>${mark('brand__mark')}<span class="brand__owner">aimuzov</span
						><span class="brand__slash">/</span><span class="brand__name">${service.name}</span></a
					>
					<button class="theme" type="button" aria-label="Сменить тему" data-theme-toggle>
						<span></span>
					</button>
				</header>
				<main class="main">${main}</main>
				${credit(service.repo)}
			</div>
		</body>
	</html>`}\n`
}

export type LandingOptions = {
	service: Service
	/** Одна строка под именем: что коннектор делает. */
	tagline: string
	lead?: string
	/** Адрес коннектора, который человек вставит в клиент. */
	mcpUrl: string
	tools?: string[]
	/** Строка под карточками, например ссылка на кабинет. */
	aside?: HtmlValue
}

export function landingPage({ service, tagline, lead, mcpUrl, tools = [], aside }: LandingOptions): string {
	return document({
		service,
		title: service.name,
		screen: 'landing',
		main: html`<section class="hero">
				<p class="eyebrow">MCP-коннектор</p>
				<h1 class="glitch" data-text="${service.name}">${service.name}</h1>
				<p class="tagline">${tagline}</p>
				${lead && html`<p class="lead">${lead}</p>`}
			</section>
			<section class="panel connect">
				<h2>Подключить</h2>
				<div class="url">
					<code>${mcpUrl}</code
					><button class="btn btn--ghost" type="button" data-copy="${mcpUrl}">Скопировать</button>
				</div>
				<ol class="steps">
					<li>
						<b>claude.ai и&nbsp;Claude Desktop</b
						><span>Settings → Connectors → Add custom connector, вставить адрес.</span>
					</li>
					<li>
						<b>Claude Code</b
						><span
							><code>claude mcp add --transport http ${service.name} ${mcpUrl}</code>, затем
							<code>/mcp</code> для входа.</span
						>
					</li>
				</ol>
			</section>
			${
				tools.length > 0 &&
				html`<section class="panel tools">
					<h2>Инструменты</h2>
					<ul class="chips">
						${tools.map((t) => html`<li><code>${t}</code></li>`)}
					</ul>
				</section>`
			}
			${aside && html`<p class="aside">${aside}</p>`}`,
	})
}

const HINT = 'Если ты не начинал подключение сам, просто закрой страницу.'

function handshake(): SafeHtml {
	return html`<div class="handshake">
		<span class="party party--client">C</span>
		<span class="wire" aria-hidden="true"></span>
		<span class="party party--service">${mark('party__mark')}</span>
	</div>`
}

const clientLine = (client: Client): SafeHtml =>
	client.name
		? html`Клиент <b>${client.name}</b> с&nbsp;адреса <code>${client.host}</code>`
		: html`Клиент с&nbsp;адреса <code>${client.host}</code>`

export type ConsentOptions = {
	service: Service
	client: Client
	title?: string
	/** Что получит клиент, по пункту на строку. */
	grants?: string[]
	/** Кнопка или виджет входа. */
	action: HtmlValue
	error?: string
}

/** «Клиент просит доступ»: сервис, клиент, что он получит, и способ войти. */
export function consentPage({ service, client, title, grants = [], action, error }: ConsentOptions): string {
	const heading = title ?? `${client.name || 'Клиент'} просит доступ к ${service.name}`

	return document({
		service,
		title: `Вход в ${service.name}`,
		screen: 'consent',
		main: html`<section class="panel auth">
			${handshake()}
			<h1>${heading}</h1>
			<p class="muted">${clientLine(client)}</p>
			${error && html`<p class="alert" role="alert">${error}</p>`}
			${
				grants.length > 0 &&
				html`<ul class="grants">
					${grants.map((g) => html`<li>${g}</li>`)}
				</ul>`
			}
			${action}
			<p class="hint">${HINT}</p>
		</section>`,
	})
}

export type FormField = {
	name: string
	label: string
	type?: 'text' | 'password' | 'url' | 'email' | 'number'
	placeholder?: string
	value?: string
	/** Подсказка под полем: где взять значение. */
	help?: string
	required?: boolean
}

export const field = ({ name, label, type = 'text', placeholder, value, help, required = true }: FormField) =>
	html`<label class="field"
		><span>${label}</span
		><input
			name="${name}"
			type="${type}"
			${placeholder && html`placeholder="${placeholder}"`}
			${value && html`value="${value}"`}
			${required && raw('required')}
			autocomplete="off"
		/>${help && html`<small>${help}</small>`}</label
	>`

export type TokenFormOptions = {
	service: Service
	client: Client
	title: string
	lead?: string
	/** Куда отправить форму. */
	action: string
	fields: FormField[]
	/** Скрытые поля, например подписанный запрос авторизации. */
	hidden?: Record<string, string>
	submit?: string
	error?: string
}

/** Вход по токену стороннего сервиса: форма вместо виджета. */
export function tokenFormPage(options: TokenFormOptions): string {
	const { service, client, title, lead, action, fields, hidden = {}, submit = 'Подключить', error } = options

	return document({
		service,
		title,
		screen: 'token',
		main: html`<section class="panel auth">
			${handshake()}
			<h1>${title}</h1>
			<p class="muted">${lead ?? clientLine(client)}</p>
			${error && html`<p class="alert" role="alert">${error}</p>`}
			<form class="form" method="post" action="${action}">
				${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
				${fields.map(field)}
				<button class="btn btn--primary" type="submit">${submit}</button>
			</form>
			<p class="hint">${HINT}</p>
		</section>`,
	})
}

export type FailOptions = {
	service: Service
	/** Заголовок для человека. */
	title: string
	message?: string
	/** Машинный код вроде `invalid_grant`, крупно над заголовком. */
	code?: string
	href?: string
	hrefLabel?: string
}

export function failPage({ service, title, message, code, href = '/', hrefLabel = 'На главную' }: FailOptions): string {
	return document({
		service,
		title,
		screen: 'error',
		main: html`<section class="panel auth error">
			${code && html`<div class="error__code glitch" data-text="${code}">${code}</div>`}
			<h1>${title}</h1>
			${message && html`<p class="muted">${message}</p>`}
			<a class="btn btn--ghost" href="${href}">${hrefLabel}</a>
		</section>`,
	})
}

export type PanelOptions = {
	title?: string
	body: HtmlValue
	/** `danger` для удаления данных и прочего необратимого. */
	tone?: 'default' | 'danger'
}

export const panel = ({ title, body, tone = 'default' }: PanelOptions): SafeHtml =>
	html`<section class="panel${tone === 'danger' ? ' danger' : ''}">
		${title && html`<h2>${title}</h2>`}${body}
	</section>`

export type StatusOptions = { tone: 'ok' | 'busy' | 'error'; title: string; detail?: string }

export const status = ({ tone, title, detail }: StatusOptions): SafeHtml =>
	html`<section class="panel status">
		<span class="dot dot--${tone}"></span>
		<div><b>${title}</b>${detail && html`<span class="muted">${detail}</span>`}</div>
	</section>`

export type AccountOptions = {
	service: Service
	greeting: string
	/** Секции кабинета: `panel`, `status` или своя разметка. */
	sections: HtmlValue
	scripts?: string[]
}

/** Каркас кабинета: приветствие и секции, которые собирает сервис. */
export function accountPage({ service, greeting, sections, scripts }: AccountOptions): string {
	return document({
		service,
		title: `Кабинет ${service.name}`,
		screen: 'account',
		scripts,
		main: html`<section class="hero hero--small">
				<p class="eyebrow">Кабинет</p>
				<h1>${greeting}</h1>
			</section>
			${sections}`,
	})
}
