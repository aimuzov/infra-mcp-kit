import { StdioTransport } from '@tmcp/transport-stdio'

import { createServer } from './server.ts'

new StdioTransport(createServer()).listen()
