/**
 * The auto-digest engine (memory U1 S-2; spec `docs/specs/2026-11-04-memory-u1-capture/spec.md`,
 * "The engine"). Hook edges drive it: a session that ends, compacts, or sits idle for
 * {@link LONG_IDLE_MS} is read from its whole transcript, probed for git evidence, planned with
 * {@link planDigest} (a commit, or three user turns), and written as a
 * `sessions/<date>-<id8>` digest followed by a `hot.md` snapshot. A folder outside git gets a
 * digest too (evidence `no-git`), unless its memory root is unsafe ({@link digestTargetAllowed}).
 *
 * Every I/O is injected ({@link DigestEngineDeps}), so the control flow is unit-tested with
 * fakes and the replay runs it with the real reader and git probe; `../memory-digest.ts`
 * supplies the live deps and subscribes it to the hook bridge.
 */

import { homedir } from 'node:os'
import type { HookTaskEvent } from '../detect/task-state-hub'
import { pickTitle, type deriveTranscriptTruth } from '../transcript-truth'
import { formatMemoryDate } from './memory-core'
import {
  buildHotProposal,
  digestSlug,
  digestTargetAllowed,
  digestTriggerFor,
  planDigest,
  renderDigest,
  shortSessionId,
  type DigestReason,
  type GitEvidence
} from './digest-core'
import type { TranscriptFacts } from './digest-transcript'

/**
 * How long a session must stay idle after its last turn before an idle-triggered
 * digest fires (PRD §3.4 — "long session idle"). Long enough that a between-turns
 * pause never triggers a digest, short enough that a parked session is captured
 * while its transcript is still fresh.
 */
export const LONG_IDLE_MS = 5 * 60 * 1000

const DAY_SEC = 86_400

/** What the engine needs to know about a session. */
export interface EngineSession {
  transcriptPath: string
  folder: string
  branch?: string
  /** `SessionEntry.created`. */
  created?: string
  summary?: string
  whatsHappening?: string
  firstPrompt?: string
}

/** The engine's I/O, injected. */
export interface DigestEngineDeps {
  resolveSession(id: string): Promise<EngineSession | null>
  readFacts(
    path: string,
    from?: { offset: number; facts: TranscriptFacts }
  ): Promise<{ facts: TranscriptFacts; offset: number }>
  readTruth(path: string): Promise<ReturnType<typeof deriveTranscriptTruth>>
  gatherGit(folder: string, sinceUnixSec: number, baselineHead: string | null): Promise<GitEvidence>
  writeDigest(
    folder: string,
    page: string,
    entry: string,
    sessionId: string
  ): Promise<{ ok: boolean; error?: string; detail?: string }>
  writeHot(
    folder: string,
    sessionId: string,
    branch: string | undefined,
    title: string,
    hot: string
  ): Promise<void>
  /** The checkout whose memory serves `folder` (S-3's unsafe-root guard checks it). */
  memoryCheckout(folder: string): Promise<string>
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface DigestEngine {
  /** Returns the digest's promise for a digest trigger (callers may ignore it), else undefined. */
  onTaskEdge(ev: HookTaskEvent): Promise<void> | undefined
  digestNow(sessionId: string, reason: DigestReason): Promise<void>
  close(): void
}

/** Per-session state: the idle timer, where the last read stopped, what the last digest saw. */
interface SessionState {
  timer?: unknown
  scan?: { offset: number; facts: TranscriptFacts }
  last?: { head: string | null; userTurns: number }
}

/** Unix seconds of an ISO time, or null when it does not parse. */
function unixSec(iso: string | null | undefined): number | null {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export function createDigestEngine(deps: DigestEngineDeps): DigestEngine {
  const states = new Map<string, SessionState>()
  const inFlight = new Set<string>()
  let closed = false

  const stateFor = (id: string): SessionState => {
    let s = states.get(id)
    if (!s) {
      s = {}
      states.set(id, s)
    }
    return s
  }

  const clearIdle = (id: string): void => {
    const s = states.get(id)
    if (s?.timer !== undefined) {
      deps.clearTimer(s.timer)
      s.timer = undefined
    }
  }

  async function runDigest(id: string, reason: DigestReason): Promise<void> {
    const session = await deps.resolveSession(id)
    if (!session) return
    const st = stateFor(id)

    const scan = await deps.readFacts(session.transcriptPath, st.scan)
    st.scan = scan
    const { facts } = scan

    const since =
      unixSec(facts.firstAt) ?? unixSec(session.created) ?? Math.floor(deps.now() / 1000) - DAY_SEC
    const git = await deps.gatherGit(session.folder, since, st.last?.head ?? null)

    const plan = planDigest({ facts, git, last: st.last ?? null })
    if (plan.action === 'skip') return
    // Never write a digest into the home directory, the filesystem root, or Claude Code's or
    // the global memory layer's data (S-3); a git checkout is checked as well as a plain folder.
    const checkout = await deps.memoryCheckout(session.folder)
    if (!digestTargetAllowed(checkout, homedir())) {
      console.log(`[memory-digest] skipped: unsafe memory root ${checkout}`)
      return
    }

    const truth = await deps.readTruth(session.transcriptPath)
    const title =
      pickTitle(truth.titles) ||
      session.summary ||
      session.whatsHappening ||
      truth.titles.taskSummary ||
      session.firstPrompt ||
      `Session ${shortSessionId(id)}`
    const nowMs = deps.now()
    const date = formatMemoryDate(nowMs)
    const branch = session.branch || undefined
    const awaySummary = truth.awaySummary || undefined
    const lastPrompt = truth.titles.lastPrompt || undefined
    const entry = renderDigest({
      date,
      title,
      ...(branch ? { branch } : {}),
      sessionShort: shortSessionId(id),
      reason,
      plan,
      git,
      facts,
      ...(awaySummary ? { awaySummary } : {}),
      ...(truth.titles.taskSummary ? { taskSummary: truth.titles.taskSummary } : {}),
      ...(lastPrompt ? { lastPrompt } : {})
    })

    const digestPage = `sessions/${digestSlug(date, id)}`
    const res = await deps.writeDigest(session.folder, digestPage, entry, id)
    if (!res.ok) {
      console.warn(`[memory-digest] digest write refused (${res.error}): ${res.detail}`)
      return
    }

    const head = git.kind === 'repo' ? git.head : null
    st.last = { head, userTurns: facts.userTurns }

    const hot = buildHotProposal({
      date,
      title,
      ...(branch ? { branch } : {}),
      commits: git.kind === 'repo' ? git.commits : [],
      ...(lastPrompt ? { lastPrompt } : {}),
      ...(awaySummary ? { awaySummary } : {}),
      digestPage
    })
    await deps.writeHot(session.folder, id, branch, title, hot)
  }

  async function digestNow(id: string, reason: DigestReason): Promise<void> {
    if (closed || inFlight.has(id)) return
    inFlight.add(id)
    try {
      await runDigest(id, reason)
    } catch (err) {
      console.error('[memory-digest] digest failed', err)
    } finally {
      inFlight.delete(id)
    }
  }

  function onTaskEdge(ev: HookTaskEvent): Promise<void> | undefined {
    if (closed) return undefined
    const id = ev.sessionId
    switch (digestTriggerFor({ event: ev.event, taskState: ev.taskState })) {
      case 'digest-ended':
        clearIdle(id)
        return digestNow(id, 'ended')
      case 'digest-compact':
        clearIdle(id)
        return digestNow(id, 'compact')
      case 'arm-idle': {
        clearIdle(id)
        const st = stateFor(id)
        // The callback hands back the digest's promise so a caller holding the timer can await it.
        const fire = (): Promise<void> => {
          st.timer = undefined
          return digestNow(id, 'idle')
        }
        st.timer = deps.setTimer(fire, LONG_IDLE_MS)
        return undefined
      }
      case 'cancel-idle':
        clearIdle(id)
        return undefined
      case 'none':
        return undefined
    }
  }

  function close(): void {
    closed = true
    for (const id of states.keys()) clearIdle(id)
    states.clear()
    inFlight.clear()
  }

  return { onTaskEdge, digestNow, close }
}
