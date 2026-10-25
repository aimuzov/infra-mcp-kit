<script lang="ts">
	import Alert from '@aimuzov/infra-site-kit/ui/alert.svelte'
	import Button from '@aimuzov/infra-site-kit/ui/button.svelte'
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'
	import Field from '@aimuzov/infra-site-kit/ui/field.svelte'
	import Input from '@aimuzov/infra-site-kit/ui/input.svelte'

	import type { TokenField } from '@aimuzov/infra-mcp-kit/astro'
	import Handshake from '@aimuzov/infra-mcp-kit/astro/components/handshake.svelte'
	import { readLoginContext, type LoginContext } from '@aimuzov/infra-mcp-kit/astro/lib/login-context.ts'

	type Props = { title: string; lead?: string; fields: TokenField[]; submit?: string }

	let { title, lead, fields, submit = 'Подключить' }: Props = $props()

	// До гидрации контекста нет: на сборке страница не знает, кто и откуда пришёл.
	let context = $state<LoginContext | null>(null)

	$effect(() => {
		context = readLoginContext()
	})
</script>

<div class="auth">
	<Card>
		<Handshake client={context?.client || context?.host} />
		<h1>{title}</h1>
		{#if context?.host}
			<p class="muted">
				Клиент {#if context.client}<b>{context.client}</b>{/if} с&nbsp;адреса <code>{context.host}</code>
			</p>
		{/if}
		{#if lead}<p class="muted">{lead}</p>{/if}
		{#if context?.error}
			<Alert variant="danger">{context.error}</Alert>
		{/if}
		{#if context && !context.request}
			<Alert variant="danger">Ссылка для входа неполная. Начни подключение заново из клиента.</Alert>
		{:else}
			<!-- Запрос едет скрытым полем POST-формы, а не в query: в логи прокси он не попадёт. -->
			<form class="form" method="post" action={context?.callback}>
				<input type="hidden" name="request" value={context?.request ?? ''} />
				{#each fields as field (field.name)}
					<Field label={field.label} for={`field-${field.name}`} hint={field.hint}>
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
				<Button type="submit" size="xl" disabled={!context}>{submit}</Button>
			</form>
		{/if}
		<p class="hint hint--center">Если ты не начинал подключение сам, просто закрой страницу.</p>
	</Card>
</div>
