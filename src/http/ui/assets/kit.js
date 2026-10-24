// Скрипт страниц кита. Подключается в <head> без defer: тема должна встать до первой
// отрисовки, иначе страница мигнёт системной схемой. Инлайн-скрипты закрыты CSP.
const KEY = 'mcp:theme'
const root = document.documentElement

try {
	const saved = localStorage.getItem(KEY)

	if (saved === 'light' || saved === 'dark') root.dataset.theme = saved
} catch {
	// Хранилище закрыто, остаётся системная тема.
}

const system = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

// Клик всегда переворачивает видимую схему; совпала с системной -- выбор забываем,
// как в theme.js из infra-site-kit.
function toggleTheme() {
	const shown = root.dataset.theme ?? system()
	const next = shown === 'dark' ? 'light' : 'dark'

	try {
		if (next === system()) {
			delete root.dataset.theme
			localStorage.removeItem(KEY)
		} else {
			root.dataset.theme = next
			localStorage.setItem(KEY, next)
		}
	} catch {
		root.dataset.theme = next
	}
}

document.addEventListener('click', (event) => {
	const target = event.target instanceof Element ? event.target : null

	if (target?.closest('[data-theme-toggle]')) {
		toggleTheme()

		return
	}

	const copy = target?.closest('[data-copy]')

	if (copy) {
		void navigator.clipboard?.writeText(copy.getAttribute('data-copy') ?? '').then(() => {
			const label = copy.textContent

			copy.textContent = 'Скопировано'
			setTimeout(() => (copy.textContent = label), 1500)
		})
	}
})
