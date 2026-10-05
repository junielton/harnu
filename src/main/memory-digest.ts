/**
 * Env-bound shell for the automatic session digest (T79 S2, v2 per BUG-26). Wires
 * the pure {@link ./mcp/digest-core} decisions to the live app: it subscribes to the
 * in-main hook task-state edge (`hook-bridge.addTaskEventObserver`), and when a
 * session ENDS or goes LONG-IDLE after doing relevant work it
 *
 *  1. probes git for EVIDENCE (commits on the session's branch + a `--numstat`
 *     churn summary + the uncommitted count),
 *  2. gates on that evidence (`isRelevantWork` — ≥1 commit by default),
 *  3. reads the transcript-truth recap (T91 — away_summary / task-summary /
 *     last-prompt), NEVER trusting a narrative self-report,
 *  4. writes a `sessions/YYYY-MM-DD-<id8>.md` digest through the SERIALIZED memory
 *     write path (`appendMemoryEntry` — server-stamped provenance, multi-writer
 *     safe), and
 *  5. APPLIES an updated `hot.md` snapshot through the same memory path, immediately
 *     — no Approval Inbox round-trip (v1 gated this behind manual Accept/Reject;
 *     BUG-26 found that gate doesn't scale past a handful of concurrent sessions).
 *     The write is recorded in the shadow log (`responder-registry.ts`) so it's
 *     auditable after the fact via the Approval Inbox's "Would-have" tab.
 *
 * Fully main-side so it survives renderer reloads like the hook bridge itself.
 * env-bound (fs + git + electron IPC) ⇒ e2e-only per ADR-0001; every gate/format
 * decision lives in `digest-core.ts` and is unit-tested there.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { scanFolders } from './claude-reader'
import type { SessionEntry } from './claude-reader'
import { addTaskEventObserver, type HookTaskEvent } from './hook-bridge'
import { appendMemoryEntry, resolveMemoryLocation } from './mcp/memory-store'
import { formatMemoryDate } from './mcp/memory-core'
import { pushShadowEntry } from './responder-registry'
import {
  deriveTranscriptTruth,
  isNoiseEntry,
  pickTitle,
  type TranscriptEntry
} from './transcript-truth'
import {
  buildHotProposal,
  commitsAfter,
  commitsSince,
  digestSlug,
  formatDigest,
  GIT_LOG_FORMAT,
  isRelevantWork,
  parseGitLog,
  parseNumstat,
  shortSessionId,
  type DigestCommit,
  type DigestEndReason,
  type DigestFileStat
} from './mcp/digest-core'

const runFile = promisify(execFile)

/**
 * How long a session must stay idle after its last turn before an idle-triggered
 * digest fires (PRD §3.4 — "long session idle"). A single tunable knob: long
 * enough that a between-turns pause never triggers a digest, short enough that a
 * genuinely-parked session is captured while its transcript is still fresh.
 */
export const LONG_IDLE_MS = 5 * 60 * 1000

const GIT_TIMEOUT_MS = 2_000
const GIT_MAX_BUFFER = 4 << 20 // 4 MiB — a long log/numstat still fits
/** How many recent commits to read from `git log` before filtering to the session. */
const GIT_LOG_LIMIT = 80
/** Tail bytes of the JSONL to read for the transcript-truth recap. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

/** Per-session engine state (debounce timer + last-digested HEAD for dedup). */
interface SessionDigestState {
  /** Pending idle-debounce timer, if armed. */
  idleTimer?: ReturnType<typeof setTimeout>
  /** HEAD at the last successful digest — skip re-digesting the same commit. */
  lastDigestedHead?: string
}

/** Handle returned by {@link registerDigestEngine} (for teardown symmetry). */
export interface DigestEngineHandle {
  close: () => void
}

/** Run a git command in `cwd`; returns stdout, or `null` on ANY failure. */
async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER
    })
    return stdout
  } catch {
    return null
  }
}

/** Count non-empty `git status --porcelain` lines (each = one changed path). */
function countPorcelain(stdout: string): number {
  return stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length
}

/** The git evidence for a session's window. */
interface GitEvidence {
  head: string
  commits: DigestCommit[]
  fileStats: DigestFileStat[]
  dirtyCount: number
}

/**
 * Probe git for a session's evidence: HEAD, the commits attributable to this
 * session (since a known baseline HEAD if we digested this run, else since the
 * session start), the aggregate `--numstat` churn across those commits, and the
 * uncommitted count. Every git call degrades to empty on failure — a non-repo /
 * git outage yields "no commits" (⇒ not relevant), never a throw.
 */
async function gatherGitEvidence(
  folder: string,
  sessionStartUnix: number,
  baselineHead: string | undefined
): Promise<GitEvidence> {
  const empty: GitEvidence = { head: '', commits: [], fileStats: [], dirtyCount: 0 }

  const headRaw = await runGit(folder, ['rev-parse', 'HEAD'])
  if (!headRaw) return empty
  const head = headRaw.trim()

  const logRaw = await runGit(folder, [
    'log',
    `-n`,
    String(GIT_LOG_LIMIT),
    `--format=${GIT_LOG_FORMAT}`,
    'HEAD'
  ])
  const allCommits = logRaw ? parseGitLog(logRaw) : []
  const commits = baselineHead
    ? commitsAfter(allCommits, baselineHead)
    : commitsSince(allCommits, sessionStartUnix)

  let fileStats: DigestFileStat[] = []
  if (commits.length > 0) {
    // Diff from the commit BEFORE the session's oldest commit up to HEAD. With a
    // known baseline that's the baseline itself; otherwise the oldest commit's
    // parent (`~1`). A root commit has no parent — that call fails and we simply
    // omit the churn block (the commit list is still evidence).
    const oldest = commits[commits.length - 1]
    const base = baselineHead ?? `${oldest.hash}~1`
    const numstatRaw = await runGit(folder, ['diff', '--numstat', `${base}..${head}`])
    if (numstatRaw) fileStats = parseNumstat(numstatRaw)
  }

  const statusRaw = await runGit(folder, ['status', '--porcelain'])
  const dirtyCount = statusRaw ? countPorcelain(statusRaw) : 0

  return { head, commits, fileStats, dirtyCount }
}

/**
 * Read the transcript-truth recap from a JSONL's tail (T91). Reads the last
 * {@link TRANSCRIPT_TAIL_BYTES}, parses the noise-filtered entries, and derives
 * `away_summary` / `task-summary` / `last-prompt` / titles. Never throws — a
 * missing/corrupt file yields the empty derivation.
 */
async function readTranscriptTruth(
  fullPath: string
): Promise<ReturnType<typeof deriveTranscriptTruth>> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    fh = await fs.open(fullPath, 'r')
    const { size } = await fh.stat()
    if (size === 0) return deriveTranscriptTruth([])
    const windowBytes = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const start = size - windowBytes
    const buf = Buffer.alloc(windowBytes)
    await fh.read(buf, 0, windowBytes, start)
    let lines = buf.toString('utf8').split('\n')
    if (start > 0 && lines.length > 0) lines = lines.slice(1) // drop partial first line
    const entries: TranscriptEntry[] = []
    for (const raw of lines) {
      if (!raw) continue
      try {
        const obj = JSON.parse(raw) as TranscriptEntry
        if (obj && typeof obj === 'object' && !isNoiseEntry(obj)) entries.push(obj)
      } catch {
        /* skip a partial/corrupt line */
      }
    }
    return deriveTranscriptTruth(entries)
  } catch {
    return deriveTranscriptTruth([])
  } finally {
    if (fh) await fh.close().catch(() => undefined)
  }
}

/** Session start as unix SECONDS from the `created` ISO; a day ago as fallback. */
function sessionStartUnix(session: SessionEntry, nowMs: number): number {
  const parsed = session.created ? Date.parse(session.created) : NaN
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  return Math.floor(nowMs / 1000) - 24 * 3600
}

/**
 * The live-window engine. Holds the per-session debounce/dedup state and
 * exposes the lifecycle hook (`onTaskEdge` / `maybeDigest`), which calls
 * `applyHot` to write the hot.md snapshot immediately — no parking, no IPC
 * actuation. Split from {@link registerDigestEngine} so the pure control flow
 * is one object.
 */
class DigestEngine {
  private readonly states = new Map<string, SessionDigestState>()
  private readonly generating = new Set<string>()

  private stateFor(sessionId: string): SessionDigestState {
    let s = this.states.get(sessionId)
    if (!s) {
      s = {}
      this.states.set(sessionId, s)
    }
    return s
  }

  private clearIdle(sessionId: string): void {
    const s = this.states.get(sessionId)
    if (s?.idleTimer) {
      clearTimeout(s.idleTimer)
      s.idleTimer = undefined
    }
  }

  /** React to a folded task-state edge (T79 S2 trigger). */
  onTaskEdge = (ev: HookTaskEvent): void => {
    // Session ended — digest now (the transcript is on disk regardless of the PTY).
    if (ev.event === 'SessionEnd' || ev.taskState === 'completed') {
      this.clearIdle(ev.sessionId)
      void this.maybeDigest(ev.sessionId, 'ended')
      return
    }
    // Active again — cancel any pending idle digest.
    if (ev.taskState === 'working' || ev.taskState === 'needs-input') {
      this.clearIdle(ev.sessionId)
      return
    }
    // Went idle — arm the long-idle debounce (one shot; reset on next activity).
    if (ev.taskState === 'idle') {
      this.clearIdle(ev.sessionId)
      const st = this.stateFor(ev.sessionId)
      st.idleTimer = setTimeout(() => {
        st.idleTimer = undefined
        void this.maybeDigest(ev.sessionId, 'idle')
      }, LONG_IDLE_MS)
    }
  }

  /**
   * Generate a digest for a session IF it did relevant (commit-backed) work and
   * we haven't already digested this exact HEAD. Never throws — every failure is
   * logged and swallowed so a digest can never take down the app.
   */
  private async maybeDigest(sessionId: string, endReason: DigestEndReason): Promise<void> {
    if (this.generating.has(sessionId)) return
    this.generating.add(sessionId)
    try {
      const session = await this.resolveSession(sessionId)
      if (!session || !session.projectPath) return

      const nowMs = Date.now()
      const st = this.stateFor(sessionId)
      const evidence = await gatherGitEvidence(
        session.projectPath,
        sessionStartUnix(session, nowMs),
        st.lastDigestedHead
      )

      const verdict = isRelevantWork({
        commitCount: evidence.commits.length,
        filesChanged: evidence.fileStats.length,
        dirtyCount: evidence.dirtyCount
      })
      if (!verdict.relevant) return
      // Dedup: HEAD unchanged since the last digest ⇒ nothing new to record.
      if (evidence.head && evidence.head === st.lastDigestedHead) return

      const truth = await readTranscriptTruth(session.fullPath)
      const date = formatMemoryDate(nowMs)
      const title =
        pickTitle(truth.titles) ||
        session.summary ||
        session.whatsHappening ||
        truth.titles.taskSummary ||
        session.firstPrompt ||
        `Session ${shortSessionId(sessionId)}`
      const branch = session.gitBranch || undefined
      const slug = digestSlug(date, sessionId)
      const digestPage = `sessions/${slug}`

      const digest = formatDigest({
        date,
        title,
        ...(branch ? { branch } : {}),
        sessionShort: shortSessionId(sessionId),
        endReason,
        ...(truth.awaySummary ? { awaySummary: truth.awaySummary } : {}),
        ...(truth.titles.taskSummary ? { taskSummary: truth.titles.taskSummary } : {}),
        ...(truth.titles.lastPrompt ? { lastPrompt: truth.titles.lastPrompt } : {}),
        commits: evidence.commits,
        fileStats: evidence.fileStats,
        dirtyCount: evidence.dirtyCount
      })

      const loc = await resolveMemoryLocation(session.projectPath)
      const res = await appendMemoryEntry({
        memoryDir: loc.memoryDir,
        page: digestPage,
        entry: digest,
        author: 'agent',
        ...(loc.branch ? { branch: loc.branch } : {}),
        sessionId,
        ...(loc.mode === 'central' ? { backlink: { sourcePath: loc.checkout } } : {}),
        now: nowMs
      })
      if (!res.ok) {
        console.warn(`[memory-digest] digest write refused (${res.error}): ${res.detail}`)
        return
      }

      // Record the HEAD so a later idle/end with no new commits is a no-op.
      st.lastDigestedHead = evidence.head

      // Apply the updated hot.md snapshot immediately (v2 — BUG-26; no longer
      // gated behind manual Approval Inbox review). Failure is logged and
      // swallowed, consistent with the digest write above.
      const proposedHot = buildHotProposal({
        date,
        title,
        ...(branch ? { branch } : {}),
        commits: evidence.commits,
        ...(truth.titles.lastPrompt ? { lastPrompt: truth.titles.lastPrompt } : {}),
        ...(truth.awaySummary ? { awaySummary: truth.awaySummary } : {}),
        digestPage
      })
      await this.applyHot({
        folder: session.projectPath,
        sessionId,
        sessionShort: shortSessionId(sessionId),
        ...(branch ? { branch } : {}),
        title,
        proposedHot
      })
    } catch (err) {
      console.error('[memory-digest] maybeDigest failed', err)
    } finally {
      this.generating.delete(sessionId)
    }
  }

  /** Resolve a session id to its on-disk entry (folder / transcript / branch). */
  private async resolveSession(sessionId: string): Promise<SessionEntry | null> {
    try {
      const folders = await scanFolders()
      for (const f of folders) {
        for (const s of f.sessions) {
          if (s.sessionId === sessionId) return s
        }
      }
    } catch (err) {
      console.error('[memory-digest] resolveSession failed', err)
    }
    return null
  }

  /**
   * Write a proposed `hot.md` snapshot immediately (auto-accept — BUG-26) and
   * record the outcome in the shadow log so it's auditable after the fact via the
   * Approval Inbox's "Would-have" tab. Never throws — a write failure is logged
   * and swallowed, matching the digest write above (a digest can never crash the
   * app).
   */
  private async applyHot(input: {
    folder: string
    sessionId: string
    sessionShort: string
    branch?: string
    title: string
    proposedHot: string
  }): Promise<void> {
    try {
      const loc = await resolveMemoryLocation(input.folder)
      const res = await appendMemoryEntry({
        memoryDir: loc.memoryDir,
        page: 'hot',
        entry: input.proposedHot,
        author: 'agent',
        ...(loc.branch ? { branch: loc.branch } : {}),
        sessionId: input.sessionId,
        ...(loc.mode === 'central' ? { backlink: { sourcePath: loc.checkout } } : {}),
        now: Date.now()
      })
      if (!res.ok) {
        console.warn(`[memory-digest] hot write refused (${res.error}): ${res.detail}`)
        return
      }
      pushShadowEntry({
        sessionId: input.sessionId,
        event: 'memory:hotProposal',
        by: 'auto-accepted',
        summary: `hot.md auto-updated — ${input.branch ?? input.title} (session ${input.sessionShort})`,
        ts: Date.now()
      })
    } catch (err) {
      console.error('[memory-digest] hot write failed', err)
    }
  }

  /** Clear every pending timer (teardown). */
  close(): void {
    for (const s of this.states.values()) {
      if (s.idleTimer) clearTimeout(s.idleTimer)
    }
    this.states.clear()
    this.generating.clear()
  }
}

let engine: DigestEngine | null = null
let unsubscribe: (() => void) | null = null

/**
 * Register the auto-digest engine (T79 S2). Subscribes to the in-main hook
 * task-state edge. `closeDigestEngine` is called on `before-quit`.
 */
export function registerDigestEngine(): DigestEngineHandle {
  const e = new DigestEngine()
  engine = e
  unsubscribe = addTaskEventObserver(e.onTaskEdge)
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
