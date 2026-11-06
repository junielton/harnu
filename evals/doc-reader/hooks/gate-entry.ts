/**
 * T1 spike: the eval plugin's command-hook entry. It reads a `PreToolUse` payload on stdin and
 * prints the gate's decision. `run.sh` bundles it into `gate.mjs` with esbuild, so the eval runs
 * exactly the rule in `src/main/doc-reader/gate-core.ts`.
 *
 * The shipped design calls the same rule over the Hook Bridge instead. This command form exists
 * because `claude plugin eval` runs in a sandbox with no Harnu running. It fails open: any error
 * prints `{}` and exits 0.
 */

import { appendFileSync, readFileSync, statSync } from 'node:fs'
import {
  decideDocRead,
  gateHookOutput,
  parseMinLines
} from '../../../src/main/doc-reader/gate-core'

/** Files above this size are not counted; the gate lets them through. */
const MAX_COUNT_BYTES = 32 * 1024 * 1024

function countLines(abs: string): number | null {
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > MAX_COUNT_BYTES) return null
    const buf = readFileSync(abs)
    let n = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++
    return n
  } catch {
    return null
  }
}

/** `HARNU_DOC_READER_DEBUG=<file>` appends each payload's tool, agent and decision to that file. */
function debugLog(entry: Record<string, unknown>): void {
  const file = process.env.HARNU_DOC_READER_DEBUG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* debugging must never change the decision */
  }
}

function main(): void {
  let out = '{}'
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
    debugLog({
      tool: input.tool_name,
      agent_type: input.agent_type ?? null,
      input: JSON.stringify(input.tool_input ?? {}).slice(0, 200)
    })
    const decision = decideDocRead(input, {
      minLines: parseMinLines(process.env.HARNU_DOC_READER_MIN_LINES),
      countLines,
      agentName: 'harnu:doc-reader'
    })
    out = gateHookOutput(decision)
    debugLog({ decision: decision.action, why: decision.action === 'allow' ? decision.why : null })
  } catch (err) {
    debugLog({ error: String(err) })
    out = '{}'
  }
  process.stdout.write(out + '\n')
}

main()
