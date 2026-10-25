/** Зарегистрированный клиент OAuth (RFC 7591), как его хранят `memoryStore` и `sqliteStore`. */
export type OAuthClient = {
	client_id: string
	client_secret?: string
	client_id_issued_at?: number
	client_secret_expires_at?: number
	redirect_uris: string[]
	client_name?: string
	token_endpoint_auth_method?: string
	grant_types?: string[]
	response_types?: string[]
	scope?: string
	[key: string]: unknown
}

export type OAuthTokens = {
	access_token: string
	token_type: 'Bearer'
	expires_in: number
	refresh_token: string
}

/**
 * Ошибка OAuth с кодом из RFC 6749. Текст уходит клиенту в `error_description`
 * и в заголовок `WWW-Authenticate`, поэтому только ASCII: кириллицу Node в заголовке
 * не пропустит, и вместо 401 клиент получил бы 500.
 */
export class OAuthError extends Error {
	readonly code: string
	readonly status: number

	constructor(code: string, message: string, status = 400) {
		super(message)
		this.code = code
		this.status = status
	}

	toJSON() {
		return { error: this.code, error_description: this.message }
	}
}

export class InvalidRequestError extends OAuthError {
	constructor(message: string) {
		super('invalid_request', message)
	}
}

export class InvalidClientError extends OAuthError {
	constructor(message: string) {
		super('invalid_client', message)
	}
}

export class InvalidClientMetadataError extends OAuthError {
	constructor(message: string) {
		super('invalid_client_metadata', message)
	}
}

export class InvalidGrantError extends OAuthError {
	constructor(message: string) {
		super('invalid_grant', message)
	}
}

export class InvalidTokenError extends OAuthError {
	constructor(message: string) {
		super('invalid_token', message, 401)
	}
}

export class UnsupportedGrantTypeError extends OAuthError {
	constructor(message: string) {
		super('unsupported_grant_type', message)
	}
}

export class TooManyRequestsError extends OAuthError {
	constructor(message: string) {
		super('too_many_requests', message, 429)
	}
}
