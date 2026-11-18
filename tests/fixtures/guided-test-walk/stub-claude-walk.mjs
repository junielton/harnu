#!/usr/bin/env node
/**
 * What the scripted stub `claude` does when the operator types a plain sentence ("walk me through what we just
 * built") into a session that was never briefed about walks: it is the part of a model that W-22 scripts.
 *
 * Exactly what a real session would do with the control server it was spawned with, and nothing else:
 *   1. read the `--mcp-config` file it was started with and connect to the `harnu` server in it;
 *   2. list its tools and note which of the four walk verbs carry `anthropic/alwaysLoad` (turn-one visibility);
 *   3. `walk_get` for the source (the skill's "before you write" rule), then `walk_open` with the script;
 *   4. print one `STUB-WALK {json}` line, which the stub appends to the file the smoke script reads.
 *
 * Usage: node stub-claude-walk.mjs <mcp-config.json> <folder> <script.json>
 * It never calls Claude, never calls a verb outside the four, and never passes a session id: this session was
 * never briefed, so it knows none.
 */
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [cfgPath, folder, scriptPath] = process.argv.slice(2)
const out = (o) => console.log(`STUB-WALK ${JSON.stringify(o)}`)

try {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const server = cfg.mcpServers?.harnu ?? cfg.mcpServers?.capy
  if (!server?.url) throw new Error('no harnu server in the --mcp-config file')
  const client = new Client({ name: 'stub-claude', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} }
    })
  )
  const listed = (await client.listTools()).tools
  const alwaysLoad = Object.fromEntries(
    ['walk_open', 'walk_extend', 'walk_report', 'walk_get', 'create_worktree'].map((n) => [
      n,
      listed.find((t) => t.name === n)?._meta?.['anthropic/alwaysLoad'] === true
    ])
  )
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content?.[0]?.text ?? ''
    try {
      return { isError: r.isError === true, payload: JSON.parse(text) }
    } catch {
      return { isError: r.isError === true, payload: { raw: text } }
    }
  }
  const existing = await call('walk_get', { folder, source: script.source })
  const opened = await call('walk_open', { folder, script })
  out({
    ok: !opened.isError && opened.payload.ok === true,
    alwaysLoad,
    before: { isError: existing.isError, walks: existing.payload.walks?.length ?? null },
    opened: opened.payload
  })
  await client.close()
} catch (err) {
  out({ ok: false, error: String(err?.message ?? err) })
}
