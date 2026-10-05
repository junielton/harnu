#!/usr/bin/env node
// Harnu-managed orchestrator guard (T109). Rewritten into <userData>/orchestrator-guard/
// on every app boot by src/main/orchestrator-guard.ts — never hand-edit the installed
// copy, it will be overwritten. Plain Node, zero deps, so it runs standalone as a
// Claude Code `PreToolUse` hook command with no build step.
//
// Nature (spec §0): this is a behavioral-drift brake, NOT a security boundary — the
// real doors are server-side (T104/T80). Any internal error here fails OPEN (allow),
// because a broken guard must degrade to "normal session", never brick the user's
// Claude Code.
//
// Decision order (spec §2), evaluated top to bottom, first match wins:
//   1. payload carries `agent_id` (a subagent/executor)         -> allow
//   2. `session_id` is not armed                                -> allow
//   3. the write's target path is inside an allowed surface     -> allow
//   4. otherwise                                                -> deny (steer)
//   5. anything above throws                                    -> allow + stderr

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ARMED_PATH = join(HERE, 'armed.json')
const CONTRACT_DOC = 'docs/harnu-orchestrator.md'

// The repo-local data dir name(s) the guard treats as Harnu-owned. A standalone script
// cannot import the TS constant (`src/shared/data-dir.ts`), so the names live HERE, in one
// place — the current name first, then the pre-rename one: a stale session can still be
// editing under the old directory, and that stays allowed.
const DATA_DIRS = ['.harnu', '.capy']

/** Absolute-with-trailing-sep test: is `absPath` equal to or inside `dirAbs`? */
function withinDir(absPath, dirAbs) {
  const prefix = dirAbs.endsWith(sep) ? dirAbs : dirAbs + sep
  return absPath === dirAbs || absPath.startsWith(prefix)
}

/** `/tmp/claude-*` session scratchpads (spec §2.3). */
function isScratchpad(absPath) {
  return /^\/tmp\/claude-[^/]*(\/|$)/.test(absPath)
}

/** `~/.claude/projects/<slug>/memory/` — the harness auto-memory surface (spec §2.3). */
function isMemorySurface(absPath) {
  const root = join(homedir(), '.claude', 'projects')
  if (!withinDir(absPath, root)) return false
  const rel = absPath.slice(root.length).split(sep).filter(Boolean)
  return rel[1] === 'memory'
}

/** `<folder>/.harnu/` (or the legacy `.capy/`) — the repo's own Harnu-owned surface (spec §2.3). */
function isHarnuDir(absPath, folder) {
  if (typeof folder !== 'string' || folder.length === 0) return false
  const root = resolve(folder)
  return DATA_DIRS.some((name) => withinDir(absPath, join(root, name)))
}

/** Whether `absPath` sits inside one of the always-allowed surfaces (spec §2.3). */
export function isAllowedSurface(absPath, folder) {
  if (typeof absPath !== 'string' || absPath.length === 0) return false
  return isHarnuDir(absPath, folder) || isScratchpad(absPath) || isMemorySurface(absPath)
}

/**
 * The write target for the tools this guard's hook matcher covers
 * (`Edit|Write|NotebookEdit`), resolved against `cwd` and NORMALIZED (`..`/`.`
 * collapsed) — `path.resolve` ignores `cwd` once `raw` is itself absolute, so
 * this both absolutizes a relative path and closes off a `..` traversal out of
 * an otherwise-allowed surface (e.g. `/tmp/claude-x/../../etc/passwd`).
 * `null` when the expected field is missing/blank — treated as "can't
 * determine", not a match.
 */
export function targetPathFor(toolName, toolInput, cwd) {
  const raw = toolName === 'NotebookEdit' ? toolInput?.notebook_path : toolInput?.file_path
  if (typeof raw !== 'string' || raw.length === 0) return null
  return resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd(), raw)
}

/**
 * The pure decision core (spec §2). `armed` is the parsed `armed.json` map (or
 * `undefined`/anything falsy — a corrupt/missing flag behaves exactly like "not
 * armed", which is itself branch 2's allow). Never throws: any unexpected shape
 * degrades to `{ decision: 'allow' }`, optionally carrying a diagnostic `error`
 * for the caller to log to stderr (fail-open, spec §0/§2.5).
 */
export function decide(payload, armed) {
  try {
    const agentId = payload?.agent_id ?? payload?.agentId
    if (typeof agentId === 'string' && agentId.length > 0) return { decision: 'allow' }

    const sessionId = payload?.session_id ?? payload?.sessionId
    const entry =
      typeof sessionId === 'string' && armed && typeof armed === 'object'
        ? armed[sessionId]
        : undefined
    if (!entry) return { decision: 'allow' }

    const toolName = payload?.tool_name ?? payload?.toolName
    const toolInput = payload?.tool_input ?? payload?.toolInput ?? {}
    const target = targetPathFor(toolName, toolInput, payload?.cwd)
    if (target === null) {
      return { decision: 'allow', error: 'guard: could not resolve a target path from tool_input' }
    }
    if (isAllowedSurface(target, entry.folder)) return { decision: 'allow' }

    return {
      decision: 'deny',
      reason: `orchestrator session — delegate this write (contract: ${CONTRACT_DOC})`
    }
  } catch (err) {
    return { decision: 'allow', error: `guard: internal error — ${err?.message ?? err}` }
  }
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolvePromise(data))
    process.stdin.on('error', reject)
  })
}

function readArmed() {
  try {
    return JSON.parse(readFileSync(ARMED_PATH, 'utf8'))
  } catch {
    return undefined // missing/corrupt flag file -> decide() treats it as "not armed"
  }
}

async function main() {
  let out
  try {
    const raw = await readStdin()
    const payload = raw ? JSON.parse(raw) : {}
    out = decide(payload, readArmed())
  } catch (err) {
    out = { decision: 'allow', error: `guard: internal error — ${err?.message ?? err}` }
  }
  if (out.error) process.stderr.write(`[orchestrator-guard] ${out.error}\n`)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: out.decision,
        ...(out.reason ? { permissionDecisionReason: out.reason } : {})
      }
    })
  )
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  void main()
}
