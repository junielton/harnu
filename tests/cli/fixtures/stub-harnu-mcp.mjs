// A stand-in for Harnu's control server. It exposes EVERY verb it is told to (argv[2] is a JSON
// array of verb names, taken from the real tool catalog by the test), allowed or not, so the test
// can see which of them the CLI actually puts in an observe tick's roster.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const verbs = JSON.parse(process.argv[2] ?? '[]')
const server = new McpServer({ name: 'harnu', version: '0.0.0' })
for (const verb of verbs) {
  server.tool(verb, verb, async () => ({ content: [{ type: 'text', text: 'stub' }] }))
}
await server.connect(new StdioServerTransport())
