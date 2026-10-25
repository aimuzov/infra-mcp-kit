<script lang="ts" generics="T extends { name: string }">
	import type { Snippet } from 'svelte'

	type Props = {
		/** Откуда брать состояние кабинета. 401 -- человек не вошёл. */
		src?: string
		/** Куда вести на вход. */
		login?: string
		children: Snippet<[T, () => Promise<void>]>
	}

	let { src = '/account/state', login = '/account/login', children }: Props = $props()

	let state = $state<{ kind: 'loading' } | { kind: 'guest' } | { kind: 'error' } | { kind: 'ready'; data: T }>({
		kind: 'loading',
	})

	async function load() {
		const res = await fetch(src, { headers: { accept: 'application/json' } }).catch(() => null)

		if (res?.status === 401) state = { kind: 'guest' }
		else if (!res?.ok) state = { kind: 'error' }
		else state = { kind: 'ready', data: (await res.json()) as T }
	}

	$effect(() => void load())
</script>

{#if state.kind === 'loading'}
	<section class="panel" aria-busy="true"><p class="muted">Загружаем кабинет…</p></section>
{:else if state.kind === 'guest'}
	<section class="panel auth">
		<h1>Кабинет</h1>
		<p class="muted">Войди, чтобы увидеть свои данные.</p>
		<a class="btn btn--primary" href={login}>Войти</a>
	</section>
{:else if state.kind === 'error'}
	<section class="panel"><p class="alert" role="alert">Кабинет не загрузился. Обнови страницу.</p></section>
{:else}
	<header class="hero">
		<p class="eyebrow">Кабинет</p>
		<h1>Привет, {state.data.name}</h1>
	</header>
	{@render children(state.data, load)}
{/if}
