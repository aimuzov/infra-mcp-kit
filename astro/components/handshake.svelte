<script lang="ts">
	import { MARK, MARK_VIEWBOX } from '@aimuzov/infra-site-kit/mark.js'
	import config from 'virtual:infra-mcp-kit/pages'

	/** Имя клиента или его хост: значка у клиента нет, вместо него первая буква. */
	let { client = '' }: { client?: string } = $props()

	const initial = $derived(client.trim().charAt(0).toUpperCase() || '?')
</script>

<!-- Клиент и сервис, связанные бегущим пунктиром: кто к кому подключается. -->
<div class="handshake" aria-hidden="true">
	<span class="handshake__party handshake__party--client">{initial}</span>
	<span class="handshake__wire"></span>
	<span class="handshake__party handshake__party--service">
		<!-- Знак сервиса или маска автора. Разметку знака проверил `safeSvg` на сборке. -->
		{#if config.service.logoSvg}
			<span class="handshake__logo">{@html config.service.logoSvg}</span>
		{:else}
			<svg class="handshake__mark" viewBox={MARK_VIEWBOX} fill="currentColor"
				><path fill-rule="evenodd" d={MARK} /></svg
			>
		{/if}
	</span>
</div>
