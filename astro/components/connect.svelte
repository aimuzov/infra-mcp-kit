<script lang="ts">
	let { name }: { name: string } = $props()

	// До гидрации стоит заглушка: SSR на сборке не знает домена.
	let url = $state('')

	$effect(() => {
		url = new URL('/mcp', location.origin).href
	})
</script>

<section class="panel connect">
	<h2>Подключить</h2>
	<div class="url">
		<code>{url || '…/mcp'}</code><button class="btn btn--ghost" type="button" data-copy={url}>Скопировать</button>
	</div>
	<ol class="steps">
		<li>
			<b>claude.ai и&nbsp;Claude Desktop</b><span
				>Settings → Connectors → Add custom connector, вставить адрес.</span
			>
		</li>
		<li>
			<b>Claude Code</b><span
				><code>claude mcp add --transport http {name} {url}</code>, затем <code>/mcp</code> для входа.</span
			>
		</li>
	</ol>
</section>
