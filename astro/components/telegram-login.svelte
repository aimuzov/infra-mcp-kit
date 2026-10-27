<script lang="ts">
	import Alert from '@aimuzov/infra-site-kit/ui/alert.svelte'
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'

	import Handshake from '@aimuzov/infra-mcp-kit/astro/components/handshake.svelte'
	import { pt } from '@aimuzov/infra-mcp-kit/astro/lib/i18n.ts'
	import { callbackUrl, readLoginContext, type LoginContext } from '@aimuzov/infra-mcp-kit/astro/lib/login-context.ts'

	type Props = {
		service: string
		/** Имя бота со сборки. Сервер с `telegramLogin({ botName })` присылает своё через `src`. */
		botName?: string
		/** Откуда брать бота сервера: `GET /authorize/page` из OAuth кита. */
		src?: string
		grants?: string[]
		locale?: string
	}

	let { service, botName = '', src = '/authorize/page', grants = [], locale = 'ru' }: Props = $props()

	let context = $state<LoginContext | null>(null)
	let widget = $state<HTMLElement>()

	// Бот сервера, `null` -- ещё не ответил. Только с сервера: фрагмент в ссылке подставит
	// кто угодно, и виджет попросил бы человека довериться чужому боту.
	let serverBot = $state<string | null>(null)

	// Бот из окружения сервера главнее бота со сборки: страницу обычно собирают без окружения прода.
	const bot = $derived(serverBot === null ? '' : serverBot || botName)

	const devUrl = $derived.by(() => {
		if (!context?.dev) return ''

		const url = callbackUrl(context)

		url.searchParams.set('dev', '1')

		return url.href
	})

	$effect(() => {
		context = readLoginContext()
	})

	// Сервер без `/authorize/page` или без бота -- остаётся бот со сборки.
	$effect(() => {
		fetch(src, { headers: { accept: 'application/json' } })
			.then((res) => (res.ok ? res.json() : {}))
			.then((data: { bot?: unknown }) => (serverBot = typeof data.bot === 'string' ? data.bot : ''))
			.catch(() => (serverBot = ''))
	})

	// Виджет вставляем скриптом: его data-auth-url собирается из фрагмента, а он есть только
	// в браузере. Источники telegram.org пускает CSP этой страницы, остальные их не знают.
	$effect(() => {
		if (!widget || !context?.request || context.dev || !bot) return

		const script = document.createElement('script')

		script.async = true
		script.src = 'https://telegram.org/js/telegram-widget.js?22'
		script.dataset.telegramLogin = bot
		script.dataset.size = 'large'
		script.dataset.authUrl = callbackUrl(context).href
		widget.append(script)

		return () => script.remove()
	})
</script>

<div class="auth">
	<Card>
		<Handshake client={context?.client || context?.host} />
		<h1>{pt(locale, 'login.asks', { client: context?.client || pt(locale, 'login.client'), service })}</h1>
		{#if context?.host}
			<p class="muted">{pt(locale, 'login.clientFromHost')} <code>{context.host}</code></p>
		{/if}
		{#if context?.error}
			<Alert variant="danger">{context.error}</Alert>
		{/if}
		{#if grants.length > 0}
			<ul class="grants">
				{#each grants as grant (grant)}<li>{grant}</li>{/each}
			</ul>
		{/if}
		{#if context && !context.request}
			<Alert variant="danger">{pt(locale, 'login.broken')}</Alert>
		{:else if devUrl}
			<a class="telegram__dev" href={devUrl}>{pt(locale, 'login.dev', { id: context?.dev ?? '' })}</a>
		{:else if context && serverBot !== null && !bot}
			<Alert variant="danger">{pt(locale, 'login.telegramMissing')}</Alert>
		{:else}
			<div class="telegram" bind:this={widget}></div>
		{/if}
		<p class="hint hint--center">{pt(locale, 'login.ignore')}</p>
	</Card>
</div>
