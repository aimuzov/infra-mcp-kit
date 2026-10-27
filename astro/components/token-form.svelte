<script lang="ts">
	import Alert from '@aimuzov/infra-site-kit/ui/alert.svelte'
	import Button from '@aimuzov/infra-site-kit/ui/button.svelte'
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'
	import Field from '@aimuzov/infra-site-kit/ui/field.svelte'
	import Input from '@aimuzov/infra-site-kit/ui/input.svelte'

	import type { TokenField } from '@aimuzov/infra-mcp-kit/astro'
	import Handshake from '@aimuzov/infra-mcp-kit/astro/components/handshake.svelte'
	import { pt } from '@aimuzov/infra-mcp-kit/astro/lib/i18n.ts'
	import { readLoginContext, type LoginContext } from '@aimuzov/infra-mcp-kit/astro/lib/login-context.ts'

	/** Тексты уже на языке страницы: их выбирает login.astro по `locale`. */
	type Props = { title: string; lead?: string; fields: TokenField[]; submit?: string; locale?: string }

	let { title, lead, fields, submit, locale = 'ru' }: Props = $props()

	// До гидрации контекста нет: на сборке страница не знает, кто и откуда пришёл.
	let context = $state<LoginContext | null>(null)

	$effect(() => {
		context = readLoginContext()
	})

	// Страница собрана заранее, а что спрашивать, сервер решает в рантайме: лишнее он
	// перечисляет во фрагменте, и после гидрации этих полей нет.
	const shown = $derived(fields.filter((field) => !context?.hide.includes(field.name)))
</script>

<div class="auth">
	<Card>
		<Handshake client={context?.client || context?.host} />
		<h1>{title}</h1>
		{#if context?.host}
			<p class="muted">
				{pt(locale, 'login.client')}
				{#if context.client}<b>{context.client}</b>{/if}
				{pt(locale, 'login.fromHost')} <code>{context.host}</code>
			</p>
		{/if}
		{#if lead}<p class="muted">{lead}</p>{/if}
		{#if context?.error}
			<Alert variant="danger">{context.error}</Alert>
		{/if}
		{#if context && !context.request}
			<Alert variant="danger">{pt(locale, 'login.broken')}</Alert>
		{:else}
			<!-- Запрос едет скрытым полем POST-формы, а не в query: в логи прокси он не попадёт. -->
			<form class="form" method="post" action={context?.callback}>
				<input type="hidden" name="request" value={context?.request ?? ''} />
				{#each shown as field (field.name)}
					<Field label={field.label} for={`field-${field.name}`} hint={field.hint} {locale}>
						<Input
							id={`field-${field.name}`}
							name={field.name}
							type={field.type ?? 'text'}
							placeholder={field.placeholder}
							required={field.required !== false}
							autocomplete="off"
						/>
					</Field>
				{/each}
				<Button type="submit" size="xl" disabled={!context}>{submit ?? pt(locale, 'login.submit')}</Button>
			</form>
		{/if}
		<p class="hint hint--center">{pt(locale, 'login.ignore')}</p>
	</Card>
</div>
