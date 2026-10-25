<script lang="ts">
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'
	import CopyValue from '@aimuzov/infra-site-kit/ui/copy-value.svelte'

	let { name }: { name: string } = $props()

	// Адрес известен только в браузере: статика не знает, на каком домене её раздают.
	let url = $state('')

	$effect(() => {
		url = new URL('/mcp', location.origin).href
	})
</script>

<Card>
	<h2 class="section-title">Подключить</h2>
	<div class="connect__url">
		{#if url}<CopyValue value={url} label="Адрес" />{:else}<code>…/mcp</code>{/if}
	</div>
	<ol class="steps">
		<li>
			<b>claude.ai и&nbsp;Claude Desktop</b><span
				>Settings → Connectors → Add custom connector, вставить адрес.</span
			>
		</li>
		<li>
			<b>Claude Code</b><span
				><code>claude mcp add --transport http {name} {url || '…/mcp'}</code>, затем <code>/mcp</code> для входа.</span
			>
		</li>
	</ol>
</Card>

<style>
	.connect__url {
		overflow-x: auto;
		padding: 10px 14px;
		border: 1px dashed var(--ui-border);
		border-radius: var(--ui-radius-sm);
	}
</style>
