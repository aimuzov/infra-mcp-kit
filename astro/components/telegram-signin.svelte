<script lang="ts">
	import { localizePath } from '@aimuzov/infra-site-kit/i18n.js'
	import Alert from '@aimuzov/infra-site-kit/ui/alert.svelte'
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'
	import Skeleton from '@aimuzov/infra-site-kit/ui/skeleton.svelte'

	import { pt } from '@aimuzov/infra-mcp-kit/astro/lib/i18n.ts'

	type Props = {
		locale?: string
		/** Откуда брать бота и метку входа: `GET /account/auth` из `telegramAccount`. */
		src?: string
		/** Куда виджет вернёт человека с подписью, по умолчанию `/account/login` на языке страницы. */
		login?: string
	}

	let { locale = 'ru', src = '/account/auth', login = localizePath('/account/login', locale) }: Props = $props()

	// Вход в кабинет, а не OAuth клиента: виджет ведёт на `login`, и сервер ставит cookie сессии.
	type Auth = { botName: string | null; dev: string | null; state: string }

	let auth = $state<Auth | null>(null)
	let failed = $state(false)
	let widget = $state<HTMLElement>()

	// Метка входа едет обратно в query: сервер сверит её с cookie, которую поставил вместе с ответом.
	const callback = $derived.by(() => {
		if (!auth) return null

		const url = new URL(login, location.origin)

		url.searchParams.set('state', auth.state)

		if (auth.dev) url.searchParams.set('dev', '1')

		return url
	})

	$effect(() => {
		fetch(src, { headers: { accept: 'application/json' } })
			.then((res) => (res.ok ? (res.json() as Promise<Auth>) : Promise.reject(new Error(String(res.status)))))
			.then((data) => (auth = data))
			.catch(() => (failed = true))
	})

	// Скрипт виджета вставляем сами: имя бота приходит с сервера, на сборке страницы его нет.
	// Источники telegram.org пускает CSP этой страницы, остальные их не знают.
	$effect(() => {
		if (!widget || !auth?.botName || auth.dev || !callback) return

		const script = document.createElement('script')

		script.async = true
		script.src = 'https://telegram.org/js/telegram-widget.js?22'
		script.dataset.telegramLogin = auth.botName
		script.dataset.size = 'large'
		script.dataset.authUrl = callback.href
		widget.append(script)

		return () => script.remove()
	})
</script>

<div class="auth">
	<Card>
		<p class="eyebrow">{pt(locale, 'account.eyebrow')}</p>
		<h1>{pt(locale, 'account.signinTitle')}</h1>
		<p class="muted">{pt(locale, 'account.signinLead')}</p>
		{#if failed}
			<Alert variant="danger" title={pt(locale, 'account.signinBroken')}>{pt(locale, 'account.failText')}</Alert>
		{:else if !auth}
			<Skeleton height="2.5rem" width="14rem" />
		{:else if auth.dev}
			<a class="telegram__dev" href={callback?.href}>{pt(locale, 'login.dev', { id: auth.dev })}</a>
		{:else if !auth.botName}
			<Alert variant="danger">{pt(locale, 'login.telegramMissing')}</Alert>
		{:else}
			<div class="telegram" bind:this={widget}></div>
		{/if}
		<p class="hint hint--center">{pt(locale, 'account.signinNote')}</p>
	</Card>
</div>
