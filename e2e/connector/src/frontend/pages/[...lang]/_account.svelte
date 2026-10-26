<script lang="ts">
	import Button from '@aimuzov/infra-site-kit/ui/button.svelte'
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'
	import Dropzone from '@aimuzov/infra-site-kit/ui/dropzone.svelte'

	import AccountShell from '@aimuzov/infra-mcp-kit/astro/components/account-shell.svelte'
	import { pt } from '@aimuzov/infra-mcp-kit/astro/lib/i18n.ts'

	let { locale = 'ru' }: { locale?: string } = $props()

	// Кабинет, как его собирает сервис: каркас кита и свои карточки из компонентов site-kit.
	// Параметр сниппета не зовём `state`: рядом с рунами Svelte примет `$state` за store.
	type State = { name: string; corpus: 'none' | 'building' | 'ready' }
</script>

<AccountShell {locale}>
	{#snippet children(data: State, reload: () => Promise<void>)}
		<Card>
			<h2 class="section-title">{pt(locale, 'fixture.corpus')}</h2>
			<p data-corpus>{data.corpus}</p>
			<Dropzone onfile={() => reload()} accept=".json,application/json" {locale} />
		</Card>
		<Card tone="danger">
			<h2 class="section-title">{pt(locale, 'fixture.data')}</h2>
			<p class="muted">{pt(locale, 'fixture.dataLead')}</p>
			<div class="actions">
				<Button variant="danger">{pt(locale, 'fixture.delete')}</Button>
				<Button variant="outline">{pt(locale, 'fixture.logout')}</Button>
			</div>
		</Card>
	{/snippet}
</AccountShell>
