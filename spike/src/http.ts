import { readFile, stat } from 'node:fs/promises'
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'

import { HttpTransport } from '@tmcp/transport-http'
import type { OAuth } from '@tmcp/auth'

import { createServer } from './server.ts'

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' }

/** node:http -> Request. Именно этот кусок express делал за нас. */
function toRequest(req: IncomingMessage, res: ServerResponse, base: URL): Request {
	const headers = new Headers()

	for (const [k, v] of Object.entries(req.headers)) {
		if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
		else if (v !== undefined) headers.set(k, v)
	}

	const controller = new AbortController()

	// close у IncomingMessage приходит, когда дочитано тело, а не когда клиент ушёл.
	res.on('close', () => controller.abort())

	const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

	return new Request(new URL(req.url ?? '/', base), {
		method: req.method,
		headers,
		body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
		duplex: hasBody ? 'half' : undefined,
		signal: controller.signal,
	} as RequestInit)
}

async function send(res: ServerResponse, response: Response) {
	res.writeHead(response.status, Object.fromEntries(response.headers))

	if (!response.body) return void res.end()

	for await (const chunk of response.body) res.write(chunk)

	res.end()
}

async function serveStatic(dir: string, pathname: string): Promise<Response | null> {
	const file = normalize(join(dir, pathname.endsWith('/') ? `${pathname}index.html` : pathname))

	if (!file.startsWith(normalize(dir))) return null

	try {
		if (!(await stat(file)).isFile()) return null

		return new Response(await readFile(file), {
			headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' },
		})
	} catch {
		return null
	}
}

export type SpikeHttpOptions = {
	publicUrl: URL
	publicDir: string
	oauth?: { oauth: OAuth<'built'>; callback(request: Request): Promise<Response> }
}

/** Всё HTTP коннектора без express: OAuth, /mcp, /health, статика Astro. */
export function spikeHttp({ publicUrl, publicDir, oauth }: SpikeHttpOptions) {
	// Один сервер и транспорт на процесс: tmcp держит сессии сам, а auth и signal
	// приходят в server.ctx на каждый запрос через AsyncLocalStorage.
	const transport = new HttpTransport(createServer(), { path: '/mcp', oauth: oauth?.oauth })

	async function handle(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url)

		if (pathname === '/health') return Response.json({ ok: true })

		if (oauth && pathname === '/authorize/callback') return oauth.callback(request)

		if (pathname === '/mcp') {
			return (await transport.respond(request)) ?? new Response('not found', { status: 404 })
		}

		const authResponse = await oauth?.oauth.respond(request)

		if (authResponse) return authResponse

		return (await serveStatic(publicDir, pathname)) ?? new Response('not found', { status: 404 })
	}

	const server = createNodeServer((req, res) => {
		handle(toRequest(req, res, publicUrl))
			.then((response) => send(res, response))
			.catch((error) => {
				console.error(error)
				res.writeHead(500).end()
			})
	})

	return { server, handle }
}
