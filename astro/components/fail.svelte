<script lang="ts">
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'

	import { pt } from '@aimuzov/infra-mcp-kit/astro/lib/i18n.ts'

	type Props = { code?: string; title?: string; message?: string; locale?: string }

	let { code = 'error', locale = 'ru', title = pt(locale, 'error.default'), message = '' }: Props = $props()

	// Сервер шлёт сюда редиректом с `?code=&title=&message=`. Svelte вставляет их текстом,
	// поэтому разметка из ссылки страницу не изменит.
	let query = $state<URLSearchParams>()

	$effect(() => {
		query = new URLSearchParams(location.search)
	})

	const shown = $derived({
		code: query?.get('code') || code,
		title: query?.get('title') || title,
		message: query?.get('message') || message,
	})
</script>

<div class="auth fail">
	<Card>
		<p class="fail__code glitch" data-text={shown.code}>{shown.code}</p>
		<h1>{shown.title}</h1>
		{#if shown.message}<p class="muted">{shown.message}</p>{/if}
		<p><a href={locale === 'ru' ? '/' : `/${locale}/`}>{pt(locale, 'notFound.home')}</a></p>
	</Card>
</div>
