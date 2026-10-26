<script lang="ts">
	import Check from '@lucide/svelte/icons/check'
	import Copy from '@lucide/svelte/icons/copy'

	/** Строка на плашке и что про неё сказать читалке. */
	let { value, label, small = false }: { value: string; label: string; small?: boolean } = $props()

	let copied = $state(false)
	let timer: ReturnType<typeof setTimeout> | undefined

	async function copy() {
		try {
			await navigator.clipboard.writeText(value)
		} catch {
			// Буфер закрыт (не https или запрет браузера): строка видна, её можно выделить руками.
			return
		}

		copied = true
		clearTimeout(timer)
		timer = setTimeout(() => (copied = false), 1500)
	}
</script>

<!-- Длинная строка обрезается многоточием, целиком она в подсказке и в буфере. -->
<div class={['plate', small && 'plate--small']}>
	<code class="plate__value" title={value}>{value}</code>
	<button
		type="button"
		class={['plate__copy', copied && 'plate__copy--done']}
		aria-label={copied ? 'Скопировано' : `Скопировать ${label}`}
		title={copied ? 'Скопировано' : 'Скопировать'}
		onclick={copy}
	>
		{#if copied}<Check size={17} />{:else}<Copy size={17} />{/if}
	</button>
	<span class="plate__status" role="status">{copied ? 'Скопировано' : ''}</span>
</div>

<style>
	.plate {
		display: flex;
		gap: 10px;
		align-items: center;
		padding: 8px 8px 8px 16px;
		border-radius: 12px;
		background: var(--ui-surface);
	}

	.plate__value {
		overflow: hidden;
		flex: 1;
		min-width: 0;
		font: 500 15px/1.4 var(--ui-font-mono);
		color: var(--ui-fg);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.plate--small .plate__value {
		font-size: 13px;
	}

	.plate__copy {
		cursor: pointer;
		display: grid;
		flex: none;
		place-items: center;
		width: 36px;
		height: 36px;
		padding: 0;
		border: 1px solid var(--ui-border-strong);
		border-radius: 9px;
		color: var(--ui-accent);
		background: var(--ui-card-bg);
		transition:
			border-color 0.15s,
			color 0.15s;

		&:hover {
			border-color: var(--ui-accent);
		}

		&:focus-visible {
			outline: 2px solid var(--ui-accent);
			outline-offset: 2px;
		}

		&.plate__copy--done {
			border-color: color-mix(in oklch, var(--ui-success) 45%, transparent);
			color: var(--ui-success);
		}
	}

	/* Только для читалок: объявляет, что строка скопирована. */
	.plate__status {
		position: absolute;
		overflow: hidden;
		width: 1px;
		height: 1px;
		white-space: nowrap;
		clip-path: inset(50%);
	}
</style>
