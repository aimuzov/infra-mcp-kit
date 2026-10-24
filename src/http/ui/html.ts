const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

/** Уже собранная разметка. Строки снаружи в неё попадают только через `html` и экранируются. */
export class SafeHtml {
	readonly value: string

	constructor(value: string) {
		this.value = value
	}

	toString(): string {
		return this.value
	}
}

/** Разметка как есть, без экранирования. Только для того, что собрал сам код. */
export const raw = (value: string): SafeHtml => new SafeHtml(value)

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[]

function render(value: HtmlValue): string {
	if (value instanceof SafeHtml) return value.value

	if (Array.isArray(value)) return value.map(render).join('')

	if (value === null || value === undefined || value === false) return ''

	return escapeHtml(String(value))
}

/**
 * Шаблон разметки: подставленные строки экранируются, `SafeHtml` и массивы из него
 * вставляются как есть, а `null`, `undefined` и `false` пропадают, чтобы писать условия
 * прямо в шаблоне.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
	let out = strings[0] ?? ''

	for (const [i, value] of values.entries()) out += render(value) + (strings[i + 1] ?? '')

	return new SafeHtml(out)
}
