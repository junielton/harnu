// A stand-in for Harnu's control server: exposes some verbs an observe tick may call and
// some it must never see. Used only by tests/cli/scheduler-observe-tools.test.ts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'harnu', version: '0.0.0' })
for (const verb of [
  'get_fleet',
  'mission_get',
  'notify',
  'create_session',
  'spawn_terminal',
  'mission_create',
  'create_worker'
]) {
  server.tool(verb, verb, async () => ({ content: [{ type: 'text', text: 'stub' }] }))
}
await server.connect(new StdioServerTransport())
