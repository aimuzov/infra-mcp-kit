<script lang="ts">
	import AccountShell from '@aimuzov/infra-mcp-kit/astro/components/account-shell.svelte'

	type State = { name: string; corpus: 'none' | 'building' | 'ready' }
</script>

<AccountShell>
	{#snippet children(state: State, reload: () => Promise<void>)}
		<section class="panel">
			<h2>Корпус</h2>
			<p data-corpus>{state.corpus}</p>
			<button class="btn btn--ghost" type="button" onclick={reload}>Обновить</button>
		</section>
	{/snippet}
</AccountShell>
