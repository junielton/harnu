/**
 * Browser pane registry, pure core (T564 U1, spec §2.1, §2.2, §6): paneId → record, plus the bookkeeping that
 * the ACKs of write verbs report (`othersWrote`, `operatorInteracted`, the `send_terminal` convention).
 *
 * The record is main's own view of a pane. The live page facts (URL, title, loading) are NOT stored here: the
 * view host owns the `webContents` and answers for them, so a stale copy can never disagree with the page.
 * No electron, no clock of its own (ADR-0001).
 */
import type { BrowserPartition } from './guest-prefs'
import type { BrowserOpenedBy } from './access'
import type { EmulationRecord } from '../../shared/browser-emulation'

/** Agent-opened panes per folder (spec §10.1, decision 28). Enforced in the verb, not here. */
export const MAX_AGENT_PANES_PER_FOLDER = 4
/** How long a finished agent input run is remembered for the emit gate (F5). */
export const AGENT_INPUT_HISTORY_MS = 15_000

export interface BrowserPaneRecord {
  paneId: string
  /** The folder whose helper stack shows this pane (the gate anchor for every verb). */
  folder: string
  name: string
  openedBy: BrowserOpenedBy
  /** Fixed at creation (spec §3.4); no verb argument selects it. */
  partition: BrowserPartition
  /** Attribution only, never authority (ADR-0020 D-3). */
  ownerSessionId: string | null
  createdAt: number
  lastActiveAt: number
  /** Hosts this pane has shown, for the "opened by agent" flag. */
  seenHosts: Set<string>
  /** The "opened by agent · host" flag (spec §3.2), or `null`. */
  flagged: { host: string } | null
  /**
   * The device-emulation record (T572, spec §9.2): the one truth the operator's picker and the agent's
   * `browser_emulate` both write and the view host applies. Absent or empty = no emulation.
   */
  emulation?: EmulationRecord
  /**
   * The folder-relative page file this pane was opened on (T569 U2): the dedupe key of a page pane. The pane's
   * CLASS is always read off the live URL, never off this field.
   */
  pagePath?: string | null
  /** The operator's per-pane "Allow network" switch (spec §4.3). Off by default; NO verb sets it. */
  allowNetwork?: boolean
}

/** A write in flight: what the ACK needs to say about concurrent activity. */
export interface WriteToken {
  paneId: string
  id: number
  startedAt: number
}

export interface WriteReport {
  /** Another write started or finished on this pane during the call. */
  othersWrote: boolean
  /** The operator used the pane (typed, clicked, navigated) during the call. */
  operatorInteracted: boolean
}

export interface BrowserRegistry {
  add(rec: BrowserPaneRecord): void
  get(paneId: string): BrowserPaneRecord | undefined
  remove(paneId: string): boolean
  list(): BrowserPaneRecord[]
  /** Agent-opened panes in `folder`, oldest first (the `PANE_LIMIT` nextActions list them). */
  agentPanesIn(folder: string): BrowserPaneRecord[]
  touch(paneId: string): void
  /** The operator did something in the pane. */
  noteOperatorInteraction(paneId: string): void
  beginWrite(paneId: string): WriteToken
  endWrite(token: WriteToken): WriteReport
  /** A page pane in `folder` showing `relPath`, for `browser_open({ path })` dedupe (spec §6.2). */
  findPagePane(folder: string, relPath: string): BrowserPaneRecord | undefined
  /**
   * An agent INPUT verb (`click`, `type`, `fill`, `press`, `upload`, an `eval` that dispatches input) is running
   * on the pane (spec §5.4 condition 2). U4 calls these around its input verbs; the emit gate reads them.
   */
  beginAgentInput(paneId: string): void
  endAgentInput(paneId: string): void
  agentInput(paneId: string): {
    inFlight: boolean
    /** When the last run finished, or `null`. */
    at: number | null
    /** Recent runs (the last ~15 s, open ones with `end: null`), for the emit gate's overlap test. */
    intervals: Array<{ start: number; end: number | null }>
  }
  /** Epoch ms of the latest moment an agent input verb was active (now while one runs), or `null` if none ever. */
  lastAgentInputAt(paneId: string): number | null
  /**
   * Whether any agent input verb was active at some moment in `[fromMs, toMs]` (a verb still running counts up to
   * `toMs`). The emit gate asks it for `[activation − AGENT_INPUT_WINDOW_MS, emit]` (spec §5.4 condition 2).
   */
  agentInputOverlaps(paneId: string, fromMs: number, toMs: number): boolean
}

/**
 * How far back from a user activation an agent input verb still disqualifies it (spec §5.4, Q8). Chromium keeps a
 * user activation "sticky" for about 5 s, so a CDP click can be spent by a `setTimeout(emit, 1600)` the page
 * armed itself; the window therefore covers the activation's whole lifetime, not only the last 1.5 s.
 */
export const AGENT_INPUT_WINDOW_MS = 5000

/**
 * Most intervals kept per pane. Old ones stop mattering once they are more than {@link AGENT_INPUT_WINDOW_MS} plus
 * an activation's lifetime in the past, but the count is the only bound, so a busy agent cannot grow it.
 */
const MAX_INPUT_INTERVALS = 64

export function createBrowserRegistry(now: () => number): BrowserRegistry {
  const panes = new Map<string, BrowserPaneRecord>()
  const operatorAt = new Map<string, number>()
  /** Per pane: the ids of writes currently in flight, and a monotonically growing counter. */
  const inflight = new Map<string, Set<number>>()
  /** Per pane: write ids that overlapped some other write while in flight. */
  const overlapped = new Map<string, Set<number>>()
  let nextId = 1
  /** Per pane: agent input verbs running now, and when the last one finished. */
  const agentInputs = new Map<
    string,
    {
      running: number
      at: number | null
      /** Start times of the verbs running now. */
      open: number[]
      /** Finished verbs, oldest first. */
      done: Array<{ start: number; end: number }>
    }
  >()

  return {
    add: (rec) => void panes.set(rec.paneId, rec),
    get: (id) => panes.get(id),
    remove(id) {
      operatorAt.delete(id)
      inflight.delete(id)
      overlapped.delete(id)
      agentInputs.delete(id)
      return panes.delete(id)
    },
    list: () => [...panes.values()],
    agentPanesIn: (folder) =>
      [...panes.values()]
        .filter((p) => p.folder === folder && p.openedBy === 'agent')
        .sort((a, b) => a.createdAt - b.createdAt),
    findPagePane: (folder, relPath) =>
      [...panes.values()].find((p) => p.folder === folder && p.pagePath === relPath),
    beginAgentInput(id) {
      const cur = agentInputs.get(id) ?? { running: 0, at: null, open: [], done: [] }
      cur.running++
      cur.open.push(now())
      agentInputs.set(id, cur)
    },
    endAgentInput(id) {
      const cur = agentInputs.get(id)
      if (!cur) return
      cur.running = Math.max(0, cur.running - 1)
      const end = now()
      cur.at = end
      const start = cur.open.shift()
      if (start !== undefined) {
        cur.done.push({ start, end })
        if (cur.done.length > MAX_INPUT_INTERVALS) cur.done.shift()
      }
    },
    agentInput(id) {
      const cur = agentInputs.get(id)
      if (!cur) return { inFlight: false, at: null, intervals: [] }
      // Keep ~15 s of history: an activation lives about 5 s, and the gate asks about runs around it.
      const cutoff = now() - AGENT_INPUT_HISTORY_MS
      cur.done = cur.done.filter((iv) => iv.end >= cutoff)
      return {
        inFlight: cur.running > 0,
        at: cur.at,
        intervals: [
          ...cur.done.map((iv) => ({ ...iv })),
          ...cur.open.map((start) => ({ start, end: null }))
        ]
      }
    },
    lastAgentInputAt(id) {
      const cur = agentInputs.get(id)
      if (!cur) return null
      return cur.running > 0 ? now() : cur.at
    },
    agentInputOverlaps(id, fromMs, toMs) {
      const cur = agentInputs.get(id)
      if (!cur) return false
      if (cur.open.some((start) => start <= toMs)) return true
      return cur.done.some((iv) => iv.start <= toMs && iv.end >= fromMs)
    },
    touch(id) {
      const rec = panes.get(id)
      if (rec) rec.lastActiveAt = now()
    },
    noteOperatorInteraction(id) {
      operatorAt.set(id, now())
      const rec = panes.get(id)
      if (rec) rec.lastActiveAt = now()
    },
    beginWrite(paneId) {
      const id = nextId++
      const active = inflight.get(paneId) ?? new Set<number>()
      // Any write already in flight overlaps this one, and this one overlaps them.
      if (active.size > 0) {
        const marks = overlapped.get(paneId) ?? new Set<number>()
        marks.add(id)
        for (const other of active) marks.add(other)
        overlapped.set(paneId, marks)
      }
      active.add(id)
      inflight.set(paneId, active)
      this.touch(paneId)
      return { paneId, id, startedAt: now() }
    },
    endWrite(token) {
      const active = inflight.get(token.paneId)
      active?.delete(token.id)
      const marks = overlapped.get(token.paneId)
      const others = marks?.delete(token.id) ?? false
      const opAt = operatorAt.get(token.paneId)
      return {
        othersWrote: others,
        operatorInteracted: opAt !== undefined && opAt >= token.startedAt
      }
    }
  }
}
