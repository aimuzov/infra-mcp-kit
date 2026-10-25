<script lang="ts">
	type TokenField = { name: string; label: string; type?: string; placeholder?: string; required?: boolean }

	type Props = { service: string; title: string; lead?: string; fields: TokenField[]; submit?: string }

	let { service, title, lead, fields, submit = 'Подключить' }: Props = $props()

	// Запрос авторизации, клиент и ошибка приходят во фрагменте адреса: он не уходит на сервер
	// и не оседает в логах прокси, а статической странице больше их взять неоткуда.
	let context = $state<{ request: string; callback: string; client: string; host: string; error: string } | null>(
		null,
	)

	$effect(() => {
		const hash = new URLSearchParams(location.hash.slice(1))

		context = {
			request: hash.get('request') ?? '',
			callback: hash.get('callback') ?? '',
			client: hash.get('client') ?? '',
			host: hash.get('host') ?? '',
			error: hash.get('error') ?? '',
		}
	})

	const initial = $derived((context?.client || context?.host || '?').trim().charAt(0).toUpperCase())
</script>

<section class="panel auth">
	<div class="handshake" aria-hidden="true">
		<span class="party party--client">{initial}</span>
		<span class="wire"></span>
		<span class="party party--service">{service.charAt(0)}</span>
	</div>
	<h1>{title}</h1>
	{#if context?.host}
		<p class="muted">
			Клиент {#if context.client}<b>{context.client}</b>{/if} с&nbsp;адреса <code>{context.host}</code>
		</p>
	{/if}
	{#if lead}<p class="muted">{lead}</p>{/if}
	{#if context?.error}<p class="alert" role="alert">{context.error}</p>{/if}
	{#if context && !context.request}
		<p class="alert" role="alert">Ссылка для входа неполная. Начни подключение заново из клиента.</p>
	{:else}
		<form class="form" method="post" action={context?.callback}>
			<input type="hidden" name="request" value={context?.request ?? ''} />
			{#each fields as field (field.name)}
				<label class="field"
					><span class="field__label">{field.label}</span><input
						name={field.name}
						type={field.type ?? 'text'}
						placeholder={field.placeholder}
						required={field.required !== false}
						autocomplete="off"
					/></label
				>
			{/each}
			<button class="btn btn--primary" type="submit" disabled={!context}>{submit}</button>
		</form>
	{/if}
	<p class="hint">Если ты не начинал подключение сам, просто закрой страницу.</p>
</section>
