/**
 * Env-bound shell for the automatic session digest (T79 S2, v2 per BUG-26; memory U1 S-2).
 * The engine itself — triggers, dedup, planning, rendering — lives in
 * {@link ./mcp/digest-engine} with its I/O injected; this file supplies the live deps and
 * subscribes the engine to the in-main hook task-state edge
 * (`hook-bridge.addTaskEventObserver`):
 *
 *  - `resolveSession` over the fleet model (`scanFolders()`),
 *  - the whole-transcript reader, the transcript-truth recap and the git probe
 *    (`./mcp/digest-io`),
 *  - `writeDigest` / `writeHot` through the serialized memory write path
 *    (`appendMemoryEntry` — server-stamped provenance, multi-writer safe). The `hot.md`
 *    snapshot is applied immediately (BUG-26 removed the review gate) and recorded in the
 *    shadow log (`responder-registry.ts`), so it stays auditable after the fact,
 *  - the persisted state (`<userData>/memory-digest-state.json`, S-4): read once at
 *    registration, rewritten atomically after every successful digest,
 *  - the catch-up sweep (S-4): 60 s after registration and every 30 minutes, the fleet model's
 *    sessions go to `engine.catchUp`, which digests the quiet ones no hook reached.
 *
 * Fully main-side so it survives renderer reloads like the hook bridge itself.
 */

import { readFileSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { scanFolders } from './claude-reader'
import { addTaskEventObserver } from './hook-bridge'
import { appendMemoryEntry, resolveMemoryLocation } from './mcp/memory-store'
import { resolveMemoryCheckout } from './mcp/memory-core'
import { probeGitMeta } from './git-probe'
import { pushShadowEntry } from './responder-registry'
import { shortSessionId } from './mcp/digest-core'
import {
  createDigestEngine,
  type CatchUpSession,
  type DigestEngine,
  type DigestEngineDeps,
  type EngineSession
} from './mcp/digest-engine'
import {
  commitFileStats,
  gatherGitEvidence,
  hasSessionDigest,
  listSubagentTranscripts,
  readTranscriptFacts,
  readTranscriptTruth
} from './mcp/digest-io'
import {
  DIGEST_STATE_FILE,
  emptyDigestState,
  parseDigestState,
  serializeDigestState,
  type DigestState
} from './mcp/digest-state'

export { LONG_IDLE_MS } from './mcp/digest-engine'

/** Handle returned by {@link registerDigestEngine} (for teardown symmetry). */
export interface DigestEngineHandle {
  close: () => void
}

/** Resolve a session id to the engine's view of its on-disk entry. */
async function resolveSession(sessionId: string): Promise<EngineSession | null> {
  try {
    for (const f of await scanFolders()) {
      for (const s of f.sessions) {
        if (s.sessionId !== sessionId) continue
        if (!s.fullPath || !s.projectPath) return null
        return {
          transcriptPath: s.fullPath,
          folder: s.projectPath,
          ...(s.gitBranch ? { branch: s.gitBranch } : {}),
          ...(s.created ? { created: s.created } : {}),
          ...(s.summary ? { summary: s.summary } : {}),
          ...(s.whatsHappening ? { whatsHappening: s.whatsHappening } : {}),
          ...(s.firstPrompt ? { firstPrompt: s.firstPrompt } : {})
        }
      }
    }
  } catch (err) {
    console.error('[memory-digest] resolveSession failed', err)
  }
  return null
}

/** Write a digest page through the memory write path. */
async function writeDigest(
  folder: string,
  page: string,
  entry: string,
  sessionId: string
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const loc = await resolveMemoryLocation(folder)
  return appendMemoryEntry({
    memoryDir: loc.memoryDir,
    page,
    entry,
    author: 'agent',
    ...(loc.branch ? { branch: loc.branch } : {}),
    sessionId,
    ...(loc.mode === 'central' ? { backlink: { sourcePath: loc.checkout } } : {}),
    now: Date.now()
  })
}

/**
 * Write the `hot.md` snapshot immediately (auto-accept — BUG-26) and record the outcome in the
 * shadow log so it's auditable after the fact via the Approval Inbox's "Would-have" tab. Never
 * throws — a write failure is logged and swallowed (a digest can never crash the app).
 */
async function writeHot(
  folder: string,
  sessionId: string,
  branch: string | undefined,
  title: string,
  hot: string
): Promise<void> {
  try {
    const loc = await resolveMemoryLocation(folder)
    const res = await appendMemoryEntry({
      memoryDir: loc.memoryDir,
      page: 'hot',
      entry: hot,
      author: 'agent',
      ...(loc.branch ? { branch: loc.branch } : {}),
      sessionId,
      ...(loc.mode === 'central' ? { backlink: { sourcePath: loc.checkout } } : {}),
      now: Date.now()
    })
    if (!res.ok) {
      console.warn(`[memory-digest] hot write refused (${res.error}): ${res.detail}`)
      return
    }
    pushShadowEntry({
      sessionId,
      event: 'memory:hotProposal',
      by: 'auto-accepted',
      summary: `hot.md auto-updated — ${branch ?? title} (session ${shortSessionId(sessionId)})`,
      ts: Date.now()
    })
  } catch (err) {
    console.error('[memory-digest] hot write failed', err)
  }
}

/**
 * The checkout whose memory serves `folder`: the same value as
 * `resolveMemoryLocation(folder).checkout`, computed without that call's side effect (it
 * copies a legacy `.capy/` into `.harnu/` for the checkout), so asking about an unsafe root
 * such as the home directory never writes there.
 */
async function memoryCheckout(folder: string): Promise<string> {
  const meta = await probeGitMeta(folder)
  return resolveMemoryCheckout(folder, meta.repoId)
}

/** Whether the folder is still there; any answer but "it is missing" counts as there. */
async function folderExists(folder: string): Promise<boolean> {
  try {
    await fs.stat(folder)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** The session's subagent transcripts, next to its main transcript. */
async function subagentTranscripts(sessionId: string): Promise<string[]> {
  const session = await resolveSession(sessionId)
  return session ? listSubagentTranscripts(session.transcriptPath, sessionId) : []
}

/** Whether the folder's memory dir already holds a digest of the session (the catch-up sweep). */
async function hasDigest(folder: string, sessionId: string): Promise<boolean> {
  const loc = await resolveMemoryLocation(folder)
  return hasSessionDigest(loc.memoryDir, sessionId)
}

// ---- Persisted state (S-4) ---------------------------------------------------

const statePath = (): string => join(app.getPath('userData'), DIGEST_STATE_FILE)

/** Read the state file once. A missing file is the empty state; a bad one is logged once. */
function loadState(): DigestState {
  let raw: string
  try {
    raw = readFileSync(statePath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[memory-digest] state file unreadable; starting empty', err)
    }
    return emptyDigestState()
  }
  const { state, problem } = parseDigestState(raw, Date.now())
  if (problem) console.warn(`[memory-digest] state file ignored (${problem}); starting empty`)
  return state
}

/** Writes are chained, so the last snapshot always lands last; each is tmp-then-rename. */
let stateWrite: Promise<void> = Promise.resolve()
function saveState(state: DigestState): void {
  const text = serializeDigestState(state)
  stateWrite = stateWrite.then(async () => {
    const file = statePath()
    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true })
      await fs.writeFile(`${file}.tmp`, text, 'utf8')
      await fs.rename(`${file}.tmp`, file)
    } catch (err) {
      console.error('[memory-digest] state write failed', err)
    }
  })
}

const liveDeps: DigestEngineDeps = {
  resolveSession,
  readFacts: readTranscriptFacts,
  readTruth: readTranscriptTruth,
  gatherGit: gatherGitEvidence,
  writeDigest,
  writeHot,
  memoryCheckout,
  folderExists,
  subagentTranscripts,
  commitFileStats,
  saveState,
  hasDigest,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

// ---- Catch-up sweep (S-4) ----------------------------------------------------

/** The first pass runs this long after registration (the fleet model is warm by then). */
const CATCH_UP_FIRST_MS = 60_000
/** Later passes run this often. */
const CATCH_UP_EVERY_MS = 30 * 60_000

let catchUpFirst: ReturnType<typeof setTimeout> | null = null
let catchUpEvery: ReturnType<typeof setInterval> | null = null
let sweeping = false

/** The fleet model's sessions, as the engine's catch-up candidates. */
async function catchUpCandidates(): Promise<CatchUpSession[]> {
  const out: CatchUpSession[] = []
  for (const f of await scanFolders()) {
    for (const s of f.sessions) {
      if (!s.fullPath || !s.projectPath || !Number.isFinite(s.fileMtime)) continue
      out.push({
        sessionId: s.sessionId,
        folder: s.projectPath,
        transcriptPath: s.fullPath,
        mtimeMs: s.fileMtime
      })
    }
  }
  return out
}

/** One sweep; a pass still running when the next is due is not doubled. */
async function sweep(e: DigestEngine): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const done = await e.catchUp(await catchUpCandidates())
    if (done.length > 0) console.log(`[memory-digest] caught up ${done.length} session(s)`)
  } catch (err) {
    console.error('[memory-digest] catch-up sweep failed', err)
  } finally {
    sweeping = false
  }
}

let engine: DigestEngine | null = null
let unsubscribe: (() => void) | null = null

/**
 * Register the auto-digest engine (T79 S2). Reads the persisted state, subscribes to the
 * in-main hook task-state edge and schedules the catch-up sweep. `closeDigestEngine` is called
 * on `before-quit`.
 */
export function registerDigestEngine(): DigestEngineHandle {
  const e = createDigestEngine(liveDeps, { state: loadState() })
  engine = e
  unsubscribe = addTaskEventObserver((ev) => {
    void e.onTaskEdge(ev)
  })
  catchUpFirst = setTimeout(() => {
    catchUpFirst = null
    void sweep(e)
    catchUpEvery = setInterval(() => void sweep(e), CATCH_UP_EVERY_MS)
  }, CATCH_UP_FIRST_MS)
  return { close: () => closeDigestEngine() }
}

/**
 * Digests an orphaned transcript (a removed worktree's session) into its owning repo's memory
 * (S-5), for Cleanup's gather. A no-op while the engine is not registered.
 */
export async function digestOrphanTranscript(
  args: Parameters<DigestEngine['digestTranscriptInto']>[0]
): Promise<void> {
  await engine?.digestTranscriptInto(args)
}

/** Whether `home`'s memory already holds a digest of the session (S-5's orphan gather). */
export function orphanHasDigest(home: string, sessionId: string): Promise<boolean> {
  return hasDigest(home, sessionId)
}

/** Teardown for `before-quit` — unsubscribe + clear timers. */
export function closeDigestEngine(): void {
  if (catchUpFirst) clearTimeout(catchUpFirst)
  if (catchUpEvery) clearInterval(catchUpEvery)
  catchUpFirst = null
  catchUpEvery = null
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (engine) {
    engine.close()
    engine = null
  }
}
