import { ZodJsonSchemaAdapter } from '@tmcp/adapter-zod'
import { McpServer } from 'tmcp'
import { z } from 'zod'

/**
 * Сервер спайка с тем, что наши серверы реально используют:
 * zod-схемы, structuredContent, elicitation (kaiten), progress и отмена (veo), auth extra (thinks).
 */
export function createServer() {
	const server = new McpServer(
		{ name: 'tmcp-spike', version: '0.0.0', description: 'tmcp spike' },
		{
			adapter: new ZodJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		},
	)

	server.tool(
		{
			name: 'add',
			description: 'Add two numbers',
			schema: z.object({ a: z.number(), b: z.number() }),
			outputSchema: z.object({ sum: z.number() }),
		},
		({ a, b }) => ({
			content: [{ type: 'text', text: String(a + b) }],
			structuredContent: { sum: a + b },
		}),
	)

	server.tool(
		{
			name: 'ask_name',
			description: 'Ask the user for a name through elicitation',
		},
		async () => {
			const answer = await server.elicitation('Your name?', z.object({ name: z.string() }))

			return {
				content: [
					{ type: 'text', text: answer.action === 'accept' ? `hi ${answer.content?.name}` : answer.action },
				],
			}
		},
	)

	server.tool(
		{
			name: 'slow',
			description: 'Report progress and stop when cancelled',
			schema: z.object({ steps: z.number().int().min(1) }),
		},
		async ({ steps }) => {
			const signal = server.ctx.signal

			for (let i = 1; i <= steps; i++) {
				if (signal?.aborted) {
					console.error(`slow: stopped at step ${i}`)

					return { content: [{ type: 'text', text: 'cancelled' }], isError: true }
				}

				server.progress(i, steps, `step ${i}`)
				await new Promise((resolve) => setTimeout(resolve, 50))
			}

			console.error(`slow: finished ${steps} steps, signal=${signal ? 'set' : 'none'}`)

			return { content: [{ type: 'text', text: 'done' }] }
		},
	)

	server.tool({ name: 'whoami', description: 'Echo the subject from the access token' }, () => ({
		content: [{ type: 'text', text: String(server.ctx.auth?.extra?.subject ?? 'anonymous') }],
	}))

	server.tool({ name: 'boom', description: 'Throw' }, () => {
		throw new Error('kaboom')
	})

	return server
}
