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

/** Agent-opened panes per folder (spec §10.1, decision 28). Enforced in the verb, not here. */
export const MAX_AGENT_PANES_PER_FOLDER = 4

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
}

export function createBrowserRegistry(now: () => number): BrowserRegistry {
  const panes = new Map<string, BrowserPaneRecord>()
  const operatorAt = new Map<string, number>()
  /** Per pane: the ids of writes currently in flight, and a monotonically growing counter. */
  const inflight = new Map<string, Set<number>>()
  /** Per pane: write ids that overlapped some other write while in flight. */
  const overlapped = new Map<string, Set<number>>()
  let nextId = 1

  return {
    add: (rec) => void panes.set(rec.paneId, rec),
    get: (id) => panes.get(id),
    remove(id) {
      operatorAt.delete(id)
      inflight.delete(id)
      overlapped.delete(id)
      return panes.delete(id)
    },
    list: () => [...panes.values()],
    agentPanesIn: (folder) =>
      [...panes.values()]
        .filter((p) => p.folder === folder && p.openedBy === 'agent')
        .sort((a, b) => a.createdAt - b.createdAt),
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
