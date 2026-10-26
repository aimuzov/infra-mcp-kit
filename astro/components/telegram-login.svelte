<script lang="ts">
	import Alert from '@aimuzov/infra-site-kit/ui/alert.svelte'
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'

	import Handshake from '@aimuzov/infra-mcp-kit/astro/components/handshake.svelte'
	import { pt } from '@aimuzov/infra-mcp-kit/astro/lib/i18n.ts'
	import { callbackUrl, readLoginContext, type LoginContext } from '@aimuzov/infra-mcp-kit/astro/lib/login-context.ts'

	type Props = { service: string; botName: string; grants?: string[]; locale?: string }

	let { service, botName, grants = [], locale = 'ru' }: Props = $props()

	let context = $state<LoginContext | null>(null)
	let widget = $state<HTMLElement>()

	const devUrl = $derived.by(() => {
		if (!context?.dev) return ''

		const url = callbackUrl(context)

		url.searchParams.set('dev', '1')

		return url.href
	})

	$effect(() => {
		context = readLoginContext()
	})

	// Виджет вставляем скриптом: его data-auth-url собирается из фрагмента, а он есть только
	// в браузере. Источники telegram.org пускает CSP этой страницы, остальные их не знают.
	$effect(() => {
		if (!widget || !context?.request || context.dev) return

		const script = document.createElement('script')

		script.async = true
		script.src = 'https://telegram.org/js/telegram-widget.js?22'
		script.dataset.telegramLogin = botName
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
		{:else}
			<div class="telegram" bind:this={widget}></div>
		{/if}
		<p class="hint hint--center">{pt(locale, 'login.ignore')}</p>
	</Card>
</div>

<style>
	.telegram {
		min-height: 40px;
	}

	.telegram__dev {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 2.75rem;
		border-radius: var(--ui-radius-sm);
		font-weight: 600;
		color: #fff;
		text-decoration: none;
		background: #2aabee;

		&:hover {
			color: #fff;
			background: #1e96d4;
		}
	}
</style>
