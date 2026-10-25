<script lang="ts">
	import Button from '@aimuzov/infra-site-kit/ui/button.svelte'
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'
	import Dropzone from '@aimuzov/infra-site-kit/ui/dropzone.svelte'

	import AccountShell from '@aimuzov/infra-mcp-kit/astro/components/account-shell.svelte'

	// Кабинет, как его собирает сервис: каркас кита и свои карточки из компонентов site-kit.
	// Параметр сниппета не зовём `state`: рядом с рунами Svelte примет `$state` за store.
	type State = { name: string; corpus: 'none' | 'building' | 'ready' }
</script>

<AccountShell>
	{#snippet children(data: State, reload: () => Promise<void>)}
		<Card>
			<h2 class="section-title">Корпус</h2>
			<p data-corpus>{data.corpus}</p>
			<Dropzone onfile={() => reload()} accept=".json,application/json" title="Перетащи выгрузку сюда" />
		</Card>
		<Card tone="danger">
			<h2 class="section-title">Данные</h2>
			<p class="muted">Удалить корпус и выйти из кабинета.</p>
			<div class="actions">
				<Button variant="danger">Удалить корпус</Button>
				<Button variant="outline">Выйти</Button>
			</div>
		</Card>
	{/snippet}
</AccountShell>
