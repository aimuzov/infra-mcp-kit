<script lang="ts" generics="T extends { name: string }">
	import type { Snippet } from 'svelte'

	import Alert from '@aimuzov/infra-site-kit/ui/alert.svelte'
	import Card from '@aimuzov/infra-site-kit/ui/card.svelte'
	import Skeleton from '@aimuzov/infra-site-kit/ui/skeleton.svelte'

	type Props = {
		/** Откуда брать состояние кабинета. 401 -- человек не вошёл. */
		src?: string
		/** Куда вести на вход. */
		login?: string
		/** Абзац на экране входа: что человек найдёт в кабинете. */
		guest?: string
		children: Snippet<[T, () => Promise<void>]>
	}

	let {
		src = '/account/state',
		login = '/account/login',
		guest = 'Войди, чтобы увидеть свои данные.',
		children,
	}: Props = $props()

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

<!-- Каркас кабинета: загрузка, вход и ошибка общие, данные рисует сервис сниппетом. -->
{#if state.kind === 'loading'}
	<div class="account__loading" role="status" aria-label="Загружаем кабинет">
		<Skeleton width="6rem" height="0.75rem" />
		<Skeleton width="60%" height="2.5rem" />
		<Card>
			<Skeleton width="40%" />
			<Skeleton />
			<Skeleton width="80%" />
		</Card>
	</div>
{:else if state.kind === 'guest'}
	<div class="auth">
		<Card>
			<p class="eyebrow">Кабинет</p>
			<h1>Нужно войти</h1>
			<p class="muted">{guest}</p>
			<a class="account__login" href={login}>Войти</a>
		</Card>
	</div>
{:else if state.kind === 'error'}
	<Alert variant="danger" title="Кабинет не загрузился">Обнови страницу или зайди чуть позже.</Alert>
{:else}
	<header class="hero hero--small">
		<p class="eyebrow">Кабинет</p>
		<h1>Привет, {state.data.name}</h1>
	</header>
	{@render children(state.data, load)}
{/if}

<style>
	.account__loading {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* Ссылка в виде главной кнопки site-kit: вход -- переход, а не действие на странице. */
	.account__login {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 2.75rem;
		padding: 0 1.5rem;
		border-radius: var(--ui-radius-sm);
		font-weight: 500;
		color: var(--ui-primary-fg);
		text-decoration: none;
		background: var(--ui-primary);
		box-shadow:
			-2px 0 0 var(--signal-red),
			2px 0 0 var(--signal-cyan);

		&:hover {
			color: var(--ui-primary-fg);
		}
	}
</style>
