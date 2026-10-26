<script lang="ts">
	import config from 'virtual:infra-mcp-kit/pages'

	/** Имя клиента или его хост: значка у клиента нет, вместо него первая буква. */
	let { client = '' }: { client?: string } = $props()

	const letter = (name: string) => name.trim().charAt(0).toUpperCase() || '?'
	const initial = $derived(letter(client))
</script>

<!-- Клиент и сервис, связанные бегущим пунктиром: кто к кому подключается. -->
<div class="handshake" aria-hidden="true">
	<span class="handshake__party handshake__party--client">{initial}</span>
	<span class="handshake__wire"></span>
	<span class="handshake__party handshake__party--service">
		<!-- Знак сервиса или, без него, первая буква имени. Разметку знака проверил `safeSvg`. -->
		{#if config.service.logoSvg}
			<span class="handshake__logo">{@html config.service.logoSvg}</span>
		{:else}
			{letter(config.service.name)}
		{/if}
	</span>
</div>
