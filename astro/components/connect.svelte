<script lang="ts">
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'

	import CopyPlate from '@aimuzov/infra-mcp-kit/astro/components/copy-plate.svelte'
	import { pt } from '@aimuzov/infra-mcp-kit/astro/lib/i18n.ts'

	let { name, locale = 'ru' }: { name: string; locale?: string } = $props()

	// Адрес известен только в браузере: статика не знает, на каком домене её раздают.
	let url = $state('')

	$effect(() => {
		url = new URL('/mcp', location.origin).href
	})

	const TABS = [
		{ id: 'app', title: pt(locale, 'connect.tabApp') },
		{ id: 'code', title: 'Claude Code' },
	] as const

	let active = $state(0)

	const shown = $derived(url || '…/mcp')
	const command = $derived(`claude mcp add --transport http ${name} ${shown}`)

	/** Стрелки, Home и End переключают вкладки, как велит паттерн tablist. */
	function onkeydown(event: KeyboardEvent) {
		const keys: Record<string, number> = {
			ArrowRight: active + 1,
			ArrowLeft: active - 1,
			Home: 0,
			End: TABS.length - 1,
		}
		const next = keys[event.key]

		if (next === undefined) return

		event.preventDefault()
		active = (next + TABS.length) % TABS.length
		document.getElementById(`connect-tab-${TABS[active].id}`)?.focus()
	}
</script>

<Card>
	<h2 class="section-title">{pt(locale, 'connect.title')}</h2>
	<!-- Плашку рисуем и на сборке, с заглушкой: Astro вшивает CSS только тех компонентов,
	     что попали в статику, а стили отрисованных в браузере теряются. -->
	<div class="connect__url"><CopyPlate value={shown} label={pt(locale, 'connect.urlLabel')} {locale} /></div>
	<div class="tabs" role="tablist" aria-label={pt(locale, 'connect.where')}>
		{#each TABS as tab, i (tab.id)}
			<button
				id={`connect-tab-${tab.id}`}
				type="button"
				role="tab"
				class="tabs__tab"
				aria-selected={active === i}
				aria-controls={`connect-panel-${tab.id}`}
				tabindex={active === i ? 0 : -1}
				onclick={() => (active = i)}
				{onkeydown}
			>
				{tab.title}
			</button>
		{/each}
	</div>
	<div id="connect-panel-app" class="panel" role="tabpanel" aria-labelledby="connect-tab-app" hidden={active !== 0}>
		<ol>
			<li>Settings → Connectors → Add custom connector.</li>
			<li>{pt(locale, 'connect.appPaste')}</li>
		</ol>
	</div>
	<div id="connect-panel-code" class="panel" role="tabpanel" aria-labelledby="connect-tab-code" hidden={active !== 1}>
		<p>{pt(locale, 'connect.codeBefore')} <code>/mcp</code> {pt(locale, 'connect.codeAfter')}</p>
		<CopyPlate value={command} label={pt(locale, 'connect.command')} {locale} small />
	</div>
</Card>

<style>
	.tabs {
		display: flex;
		gap: 4px;
		width: max-content;
		max-width: 100%;
		margin-top: 18px;
		padding: 4px;
		border-radius: 10px;
		background: var(--ui-surface);
	}

	.tabs__tab {
		cursor: pointer;
		padding: 7px 12px;
		border: 0;
		border-radius: 7px;
		font: 500 14px/1 var(--ui-font, inherit);
		color: var(--ui-muted);
		white-space: nowrap;
		background: transparent;

		&[aria-selected='true'] {
			color: var(--ui-fg);
			background: var(--ui-card-bg);
			box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
		}

		&:focus-visible {
			outline: 2px solid var(--ui-accent);
			outline-offset: 2px;
		}
	}

	/* Колонка не шире карточки: иначе длинная команда растягивает её на телефоне. */
	.panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
		margin-top: 12px;
		color: var(--ui-muted);

		&[hidden] {
			display: none;
		}

		& ol,
		& p {
			margin: 0;
		}

		& ol {
			display: grid;
			gap: 6px;
			padding-left: 20px;
		}
	}
</style>
