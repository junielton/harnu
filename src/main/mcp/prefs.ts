/**
 * MCP server prefs (T19, thin shell): the kill switch + the friction opt-in.
 *
 * The Harnu MCP control server is now ON OUT OF THE BOX. {@link readMcpEnabled}
 * defaults to **`true`** — a missing prefs file (first run) or a corrupt one both
 * resolve ON, because a torn pref must not silently strand every agent in the
 * fleet. The operator's kill switch is an explicit `{ "enabled": false }`, which
 * is honored absolutely (it is the one gate `evaluateToolCall` never lets any
 * layer promote past).
 *
 * The old header claimed "there is deliberately NO `mutationMode` / 'allow
 * everything' pref … every mutation faces a human confirm". That is REPEALED.
 * Agents are free by default; the human confirm is now the opt-in, spelled
 * {@link readMcpAsk} (`{ "ask": true }` — "Ask before agent actions" in
 * Settings → Control server). `ask` restores the per-action confirm for every
 * mutating verb; it does NOT resurrect the per-folder allowlist, which is gone.
 *
 * The file lives at `<userData>/mcp-prefs.json`:
 * `{ "enabled"?: boolean, "ask"?: boolean, "autoRegister"?: boolean }`.
 *
 * env-bound (electron `app` + `node:fs`) ⇒ e2e-only per ADR-0001 (no unit test;
 * goes in coverage.exclude). The pure policy math lives in `policy-assemble.ts`;
 * this module only persists the bits.
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** On-disk file name under `app.getPath('userData')`. */
const FILE_NAME = 'mcp-prefs.json'

/** Absolute path to the MCP prefs file in the Electron userData dir. */
function mcpPrefsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** The persisted prefs shape. Every key is optional so a partial/old file reads cleanly. */
interface McpPrefsFile {
  /** Kill switch. Default ON — only an explicit `false` shuts the server down. */
  enabled?: boolean
  /**
   * The friction opt-in ("Ask before agent actions"). Default OFF — only an
   * explicit `true` puts the per-action human confirm back in front of every
   * mutating verb.
   */
  ask?: boolean
  /** T93: auto-register opt-out. Default ON — only an explicit `false` opts out. */
  autoRegister?: boolean
}

/** Read + parse the prefs object, or `{}` on a missing/corrupt/unreadable file. */
async function readPrefs(): Promise<McpPrefsFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(mcpPrefsPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as McpPrefsFile) : {}
  } catch {
    return {}
  }
}

/** Read-merge-write the prefs file, preserving any unrelated keys already on disk. */
async function mergePrefs(patch: Partial<McpPrefsFile>): Promise<void> {
  const current = await readPrefs()
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(
    mcpPrefsPath(),
    JSON.stringify({ ...current, ...patch }, null, 2) + '\n',
    'utf8'
  )
}

/**
 * Whether the Harnu MCP control server is enabled. Defaults to **`true`** — the
 * server is on out of the box. A missing file (first run), corrupt JSON, or any
 * read error all resolve `true`: the failure we now protect against is an idle
 * fleet, not an exposed one (the server is loopback-only + bearer-token gated).
 * Only an explicit `{ "enabled": false }` — the operator's kill switch — turns it
 * off, and that denial is absolute.
 */
export async function readMcpEnabled(): Promise<boolean> {
  // Strict `!== false`: only an explicit `{ "enabled": false }` opts out.
  return (await readPrefs()).enabled !== false
}

/** Persist the MCP server enable flag (read-merge-write; preserves `ask`/`autoRegister`). */
export async function writeMcpEnabled(enabled: boolean): Promise<void> {
  await mergePrefs({ enabled })
}

/**
 * Whether every mutating agent action must face a human confirm first — the
 * OPT-IN friction switch ("Ask before agent actions"). Defaults to **`false`**:
 * agents act freely, which is the whole posture. Only an explicit
 * `{ "ask": true }` re-arms the per-action confirm (and, with it, the
 * containment/`PATH_ESCAPE` check — see `permission-core.ts`). A missing/corrupt
 * file → default OFF.
 *
 * This is NOT the allowlist coming back: `ask` restores the confirm for every
 * folder alike. The per-folder opt-out is the denylist (`agentDenied`).
 */
export async function readMcpAsk(): Promise<boolean> {
  return (await readPrefs()).ask === true
}

/** Persist the "Ask before agent actions" opt-in (read-merge-write; preserves the rest). */
export async function writeMcpAsk(ask: boolean): Promise<void> {
  await mergePrefs({ ask })
}

/**
 * Whether to AUTO-REGISTER Harnu's MCP server into every spawned `claude` (T93):
 * inject the `--mcp-config` descriptor + the `--allowedTools mcp__harnu,mcp__capy` allow rule.
 * Defaults to **`true`** (the auto-register is the point of the server) — only an
 * explicit `{ "autoRegister": false }` opts out. A missing/corrupt file → default ON.
 * Independent of {@link readMcpEnabled}: injection only happens while the server is
 * actually running AND this flag is on.
 */
export async function readMcpAutoRegister(): Promise<boolean> {
  return (await readPrefs()).autoRegister !== false
}

/** Persist the auto-register opt-out (read-merge-write; preserves `enabled`). */
export async function writeMcpAutoRegister(autoRegister: boolean): Promise<void> {
  await mergePrefs({ autoRegister })
}
