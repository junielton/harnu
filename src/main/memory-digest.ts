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
 *    shadow log (`responder-registry.ts`), so it stays auditable after the fact.
 *
 * Fully main-side so it survives renderer reloads like the hook bridge itself.
 */

import { scanFolders } from './claude-reader'
import { addTaskEventObserver } from './hook-bridge'
import { appendMemoryEntry, resolveMemoryLocation } from './mcp/memory-store'
import { pushShadowEntry } from './responder-registry'
import { shortSessionId } from './mcp/digest-core'
import {
  createDigestEngine,
  type DigestEngine,
  type DigestEngineDeps,
  type EngineSession
} from './mcp/digest-engine'
import { gatherGitEvidence, readTranscriptFacts, readTranscriptTruth } from './mcp/digest-io'

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

const liveDeps: DigestEngineDeps = {
  resolveSession,
  readFacts: readTranscriptFacts,
  readTruth: readTranscriptTruth,
  gatherGit: gatherGitEvidence,
  writeDigest,
  writeHot,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

let engine: DigestEngine | null = null
let unsubscribe: (() => void) | null = null

/**
 * Register the auto-digest engine (T79 S2). Subscribes to the in-main hook
 * task-state edge. `closeDigestEngine` is called on `before-quit`.
 */
export function registerDigestEngine(): DigestEngineHandle {
  const e = createDigestEngine(liveDeps)
  engine = e
  unsubscribe = addTaskEventObserver((ev) => {
    void e.onTaskEdge(ev)
  })
  return { close: () => e.close() }
}

/** Teardown for `before-quit` — unsubscribe + clear timers. */
export function closeDigestEngine(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (engine) {
    engine.close()
    engine = null
  }
}
