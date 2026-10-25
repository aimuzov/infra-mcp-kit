<script lang="ts">
	import { toggleTheme } from '@aimuzov/infra-site-kit/theme.js'
	import { themePeek } from '@aimuzov/infra-site-kit/theme-peek.js'

	/** Тот же ключ, что у `ThemeBoot` в layout: выбор переживает перезагрузку. */
	const KEY = 'mcp:theme'
</script>

<!-- Круг theme-peek показывает другую тему вокруг кнопки ещё до клика, как на сайтах. -->
<button
	class="theme"
	type="button"
	aria-label="Сменить тему"
	onclick={() => toggleTheme({ key: KEY })}
	{@attach (node) => themePeek(node)}
>
	<span class="theme__half"></span>
</button>

<style>
	.theme {
		cursor: pointer;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 1px solid var(--ui-border);
		border-radius: 50%;
		background: transparent;
		transition: border-color 0.15s;

		&:hover {
			border-color: var(--ui-accent);
		}

		&:focus-visible {
			outline: 2px solid var(--ui-accent);
			outline-offset: 2px;
		}
	}

	.theme__half {
		width: 12px;
		height: 12px;
		border: 1.5px solid var(--ui-fg);
		border-radius: 50%;
		background: linear-gradient(90deg, var(--ui-fg) 50%, transparent 50%);
	}
</style>
