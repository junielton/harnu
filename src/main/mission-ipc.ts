/**
 * Mission IPC (T370, Missions v4) — what the renderer reads of the missions and the operator's doors, over
 * typed `mission:*` channels.
 *
 * Missions v4 S-40: the v3 view is gone. `mission:list` no longer derives a v3 view of each mission (the
 * v3 progress, gates, waiting list and end dialog it fed to the old popovers): it answers an empty
 * `views` and the files it could not read, and every reader that wanted a mission reads the v4 view
 * (`mission:v4View`), which serves a mission still held in a v3 file too. The operator's v3 doors
 * (approve a re-scope, tick a check, choose a decision, end a mission as the v3 popover did) are gone
 * with the popover; the operator's doors are `mission:v4Door` and `mission:handOff`.
 */

import { promises as fs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { ipcMain } from 'electron'
import { addTaskEventObserver } from './hook-bridge'
import { markdownKnownRoots } from './markdown-read'
import { isPathAllowed } from './settings'
import { readUserProjects } from './user-projects'
import type { RecordResult } from './mission-record'
import { realFactsDeps } from './mcp/tool-handlers'
import {
  missionRoot,
  readMissionsDeduped,
  reportedUnreadableMissionFiles,
  type RootedMission
} from './missions/store'
import type { Mission, MissionDerived, MissionProgress } from './missions/derive'
import type { WaitingItem } from './missions/waiting'
import { approveDoneWhen, declineDoneWhen, doorReply, runDoor } from './missions/doors'
import { createMissionObserver, type MissionObserver } from './missions/observer'
import { ensureLinkCacheLoaded, rememberResolved } from './mission-link-cache'
import { hydrateMissionLedger, observedRows } from './missions/ledger-store'
import { repoRoot } from './data-dir'
import { openEntry, leaderOf as v4LeaderOf, type Actor } from './missions/guard'
import {
  listMissionRecords,
  unreadableRecordFiles,
  readMissionRecord,
  v4RecordsDir,
  type MissionRecordView,
  type RecordSource
} from './missions/record-store'
import {
  missionGet,
  missionList,
  type ListedMission,
  type MissionDetail
} from './missions/verbs-read'
import {
  closeWarningsOf,
  stagedDoneWhenOf,
  type CloseWarning as V4CloseWarning
} from './missions/doors'
import type { MissionV4 } from './missions/model'
import { sessionHistory, type SessionHistoryRow } from './missions/sessions'
import { attachFoundPrs } from './missions/verbs-plan'
import type { CardFile } from './missions/cards'
import { gatherStepFacts, gatherStepInputs, type FactsDeps } from './missions/facts'
import {
  handoffOffer,
  leaderContextPercent,
  runHandOff,
  type ContextReading,
  type HandOffReply,
  type HandoffOffer,
  type HandoffStart
} from './missions/handoff'

/** What `mission:handOff` answers: the outcome and the new session id, never the record (S-16b). */
export type MissionHandOffReply = HandOffReply
import { defaultSummaryRouteDeps, summaryRoute } from './missions/summary-route'
import { getTelemetryPayload } from './telemetry-store'

/** What the retired v3 end dialog warned about. Warnings, never refusals. */
export interface CloseWarning {
  kind: 'end-unverified' | 'left-behind' | 'checks-open' | 'blockers-open' | 'rescope-staged'
  detail: string
}

/**
 * One open mission as the retired v3 list read it. `mission:list` answers no view any more (S-40); the type
 * stays because the renderer's store still types its list by it, and goes with that code.
 */
export interface MissionView {
  /** The repo root whose `.harnu/missions/` holds the file — the door's `root`. */
  root: string
  /** `legacyRaw` is left out, like `mission_get` does (design §9). */
  mission: Omit<Mission, 'legacyRaw'>
  title: string
  derived: MissionDerived
  /**
   * What waits on the operator, in order; `[]` = nothing. THE waiting list (missions/waiting.ts):
   * a pending decision is in it, and `describeWaiting` words each item.
   */
  you: WaitingItem[]
  /** Mission v3 §3.1 — the server's progress (the same object as `derived.progress`). */
  progress: MissionProgress
  /** Mission v3 §3.5 — what the end dialog warns about. Warnings, never refusals. */
  closeWarnings: CloseWarning[]
}

export interface MissionListResult {
  views: MissionView[]
  /** Mission files that failed to parse — reported, never thrown. */
  unreadable: string[]
  /**
   * Copies of a mission id that lost to a newer copy in another clone (BUG-173).
   * A diagnostic for "two clones carry the same missions"; nothing is deleted.
   */
  shadowed: Array<{ missionId: string; root: string }>
}

export type MissionDoor =
  | { door: 'approveRescope'; root: string; missionId: string }
  // S-37 delta 1 — Decline: the operator drops a staged re-scope; the declared end stays as it was.
  | { door: 'declineRescope'; root: string; missionId: string }
  // Mission v3 §3.5 — the ONE end door: close as delivered, or discard.
  | {
      door: 'end'
      root: string
      missionId: string
      closedAs: 'delivered' | 'discarded'
      reason?: string
      /**
       * Campaign ch.6 (T610) — ids of the stored `memoryDrafts` the operator ticked under
       * "Also record". Only meaningful with `closedAs: 'delivered'`; absent = write nothing.
       */
      record?: string[]
    }
  | { door: 'verifyStep'; root: string; missionId: string; stepId: string; verified: boolean }
  // Mission v3 §3.6 — human checks. Only these doors tick or delete one.
  | { door: 'addCheck'; root: string; missionId: string; stepId: string; label: string }
  | {
      door: 'tickCheck'
      root: string
      missionId: string
      stepId: string
      checkId: string
      ticked: boolean
    }
  | { door: 'deleteCheck'; root: string; missionId: string; stepId: string; checkId: string }
  // Campaign spec §4 — Choose: the operator picks an option of a decision node.
  | { door: 'chooseDecision'; root: string; missionId: string; stepId: string; index: number }

/**
 * Mission v3 §3.2 — a door answers with the mission it changed, re-derived on
 * its own (never a full list), so the renderer patches that one view at once.
 * `view: null` when the door ended the mission (it leaves every surface), or in
 * the rare case the re-derive failed after the write landed.
 * `deduped`: an `addCheck` whose label was already on the step — nothing was written or logged.
 */
export type MissionDoorResult =
  | {
      ok: true
      view: MissionView | null
      deduped?: true
      /** An `end` that ticked memory drafts: which landed, which the memory write refused. */
      recorded?: RecordResult
    }
  | { ok: false; error: string }

/**
 * What `mission:list` answers: no v3 view of any mission (S-40), and the files that could not be read —
 * a v3 mission file or a v4 record the store cannot parse. A reader that skips such a file would hide a
 * mission, so the app raises one notice that names it (the renderer's store does), and Your move closes
 * nothing by absence while one exists.
 */
export async function listMissionViews(folders: readonly string[]): Promise<MissionListResult> {
  const roots = [...new Set(folders.filter((f) => typeof f === 'string').map(missionRoot))]
  if (roots.length === 0) return { views: [], unreadable: [], shadowed: [] }
  const read = await readMissionsDeduped(roots, { includeClosed: false })
  const v4Unreadable = (await Promise.all(roots.map((r) => unreadableRecordFiles(r)))).flat()
  // The files the other readers (hibernation, the companion, Your move) could not read are named too.
  const unreadable = [
    ...new Set([
      ...read.unreadable.map((u) => u.name),
      ...v4Unreadable,
      ...reportedUnreadableMissionFiles()
    ])
  ]
  return { views: [], unreadable, shadowed: read.shadowed }
}

// ---- The observer pass (S-3 delta 1) -------------------------------------------------------

/**
 * Missions v4 S-4 (AC-6): a closed mission is never derived or observed, but the observed rows the
 * userData cache still holds for it belong in the repo too. Copy them — only for the missions that
 * have any (a closed mission with nothing cached costs no read), once per process.
 */
async function copyClosedMissionLedgers(missions: readonly RootedMission[]): Promise<void> {
  const closed = missions.filter((m) => m.mission.status === 'closed')
  if (closed.length === 0) return
  await ensureLinkCacheLoaded()
  for (const { root, mission } of closed) {
    if (observedRows(mission.id).length === 0) continue
    try {
      await hydrateMissionLedger(root, mission.id)
    } catch (err) {
      console.warn(`[mission-observer] could not copy the cached ledger of ${mission.id}:`, err)
    }
  }
}

/**
 * One observer pass: for each open v4 record of `folders` (or the ones a session in `onlySessions` works
 * on), read the facts and record what they show (see {@link observeV4Records}). A closed v3 mission is not
 * derived, but the rows the userData cache still holds for it belong in the repo too, so they are copied
 * (once per process). With no open mission it stops after reading the files. Returns how many records it
 * observed.
 */
export async function observeOpenMissions(
  folders: readonly string[],
  _now = Date.now(),
  opts: {
    onlySessions?: ReadonlySet<string>
    /** Test seam: the sources the v4 leg gathers a step's facts from (default: the real ones). */
    v4Facts?: (root: string) => FactsDeps
  } = {}
): Promise<number> {
  const roots = [...new Set(folders.filter((f) => typeof f === 'string').map(missionRoot))]
  if (roots.length === 0) return 0
  try {
    await copyClosedMissionLedgers(
      (await readMissionsDeduped([...roots], { includeClosed: true })).missions
    )
  } catch (err) {
    console.warn('[mission-observer] could not copy the cached ledgers:', err)
  }
  try {
    return await observeV4Records(roots, opts)
  } catch (err) {
    console.warn('[mission-observer] the v4 leg failed:', err)
    return 0
  }
}

// ---- Missions v4 S-16a: the facts' real sources, the view channel and the observer's v4 leg ----------

/** How long the view waits for GitHub; past it a step reads its sticky last-known state (like a door). */
const VIEW_PR_WAIT_MS = 1500

/** What the view channel is asked: the folder the caller works in, who asks, and optionally which mission. */
export interface MissionV4ViewRequest {
  folder: string
  sessionId: string
  missionId?: string
  /** The percentage the operator last said "Not now" to the hand-off offer at, if any (S-16b). */
  dismissedPercent?: number
}

/**
 * What the view channel answers. `mission`: everything the dropdown reads about one mission (`detail` is
 * S-12's `missionGet`; the rest is what its detail does not carry). `none`: the session is attached to
 * no open mission, here are the folder's missions to pick from. `refused`: a typed reason.
 */
export type MissionV4ViewReply =
  | {
      state: 'mission'
      /** Send it back on later calls: a call that names the id reads one record. */
      missionId: string
      source: RecordSource
      detail: MissionDetail
      /**
       * What the view read about each step beyond the record: its pull request state (`open`, `merged`,
       * `closed` or `none`) and whether a worker is working on it. The companion draws its executors and
       * pull request badges from it. Absent in a reply built without facts.
       */
      stepFacts?: Record<string, { pr?: string; workerWorking?: boolean }>
      /** What the end dialog warns about, counted with the facts (the close door's own reply has none). */
      closeWarnings: V4CloseWarning[]
      /** The Done when a session staged for the operator to approve, or `null`. */
      pendingDoneWhen: { text: string; at?: string } | null
      sessions: SessionHistoryRow[]
      /**
       * Whether the leader's context from a LIVE reading is high enough to offer a hand-off: 80 percent or
       * more, quiet after a "Not now" until it grows five points. The Mission dropdown no longer draws the
       * offer (it has no "Continue in a new session…" control), so nothing reads this field today; it stays
       * in the reply for the dormant `mission:handOff` door below, which still starts nothing until asked.
       */
      handoff: HandoffOffer
    }
  | { state: 'none'; missions: ListedMission[] }
  | { state: 'refused'; code: string; error: string }

/**
 * Missions v4 S-15 — what `mission:v4Door` is asked: the folder the caller works in, the mission and
 * one door. The time is always the app's own (a caller never sets `at`). An unknown door or a missing
 * field is refused `BAD_ARGS`.
 */
export type MissionV4Door = { folder: string; missionId: string } & (
  | { door: 'mark'; stepId: string; criterionId: string; evidence?: string }
  | { door: 'clearBlocker'; blockerId: string; stepId?: string }
  | { door: 'approveDoneWhen' }
  | { door: 'declineDoneWhen' }
  | { door: 'close'; closedAs: 'delivered' | 'discarded'; reason?: string }
  | { door: 'decideAttach'; requestId: string; decision: 'allowed' | 'denied' }
  | { door: 'attach'; sessionId: string }
)

/**
 * What `mission:v4Door` answers: the outcome and what the dialog needs, never the record or a file
 * path (the view channel serves the refreshed mission). `changed: false` means the target was already
 * as asked. A close carries the warnings counted without the facts: the view's own `closeWarnings`
 * (with them) is what the dialog shows before the operator confirms.
 */
export type MissionV4DoorReply =
  | {
      ok: true
      changed: boolean
      stepId?: string | null
      criterionId?: string
      blockerId?: string
      warnings?: V4CloseWarning[]
    }
  | { ok: false; code: string; error: string }

const refusedView = (code: string, message: string): MissionV4ViewReply => ({
  state: 'refused',
  code,
  error: `${code}: ${message}`
})

/**
 * The open mission a session is attached to when it names none: the one it leads, else the only one.
 * (The unnamed lookup lists every record of the repo and converts each unconverted v3 file in memory:
 * the channel answers `missionId`, and a call that names it reads one record.)
 *
 * A session attached to several (after the cut-over an old leader leads one mission per v3 file it ever
 * started, the normal case for old records) is never refused: the dropdown draws the one written most recently
 * (the newest file, a v3 file included; the id breaks a tie), among the ones it leads, else among the
 * ones it is in. The reply names it (`missionId`) and the dropdown offers the others.
 */
async function missionOfSession(
  root: string,
  sessionId: string
): Promise<{ ok: true; view: MissionRecordView } | { ok: 'none' }> {
  const { records } = await listMissionRecords(root)
  const mine = records.filter(
    (v) => v.record.status === 'open' && openEntry(v.record, sessionId) !== undefined
  )
  if (mine.length === 0) return { ok: 'none' }
  if (mine.length === 1) return { ok: true, view: mine[0] }
  const leading = mine.filter((v) => v4LeaderOf(v.record) === sessionId)
  const pool = leading.length > 0 ? leading : mine
  if (pool.length === 1) return { ok: true, view: pool[0] }
  const written = await Promise.all(
    pool.map(async (view) => ({
      view,
      at: await fs.stat(view.file).then(
        (st) => st.mtimeMs,
        () => 0
      )
    }))
  )
  written.sort((a, b) => b.at - a.at || a.view.record.id.localeCompare(b.view.record.id))
  return { ok: true, view: written[0].view }
}

/**
 * The folder's open missions, the most recently written first (the file's mtime, a v3 file included; the id
 * breaks a tie): the order every reader of a session that leads several shares (S-35 delta 1), and the one
 * {@link missionOfSession} picks from. The list is otherwise ordered by id, which says nothing.
 */
async function newestFirst(root: string, rows: readonly ListedMission[]): Promise<ListedMission[]> {
  const { records } = await listMissionRecords(root)
  const file = new Map(records.map((v) => [v.record.id, v.file]))
  const written = await Promise.all(
    rows.map(async (row) => ({
      row,
      at: await fs.stat(file.get(row.id) ?? '').then(
        (st) => st.mtimeMs,
        () => 0
      )
    }))
  )
  written.sort((a, b) => b.at - a.at || a.row.id.localeCompare(b.row.id))
  return written.map((w) => w.row)
}

/** The status line's LIVE readings: one record per running session. The last-known ones are never used. */
const liveContexts = (): readonly ContextReading[] => getTelemetryPayload().perSession

/**
 * The re-scope an older (v3) mission has staged, as the box the dropdown shows for a staged Done when (S-37
 * delta 1): the new target and its proof, and the reason the owner gave when it asked (the Log's
 * "re-scope requested" entry). `null` for a v4 record and for a v3 file with nothing staged. It reads the
 * view and writes nothing. THIS is the function that carries the door's box: whoever removes the v3 readers
 * keeps it (or its successor) so an owed re-scope never loses its Approve and Decline.
 */
export function stagedRescopeOf(view: MissionRecordView): { text: string; at?: string } | null {
  if (view.source !== 'v3-mission') return null
  const staged = (view.record as { legacyV3?: { pendingRescope?: unknown } }).legacyV3
    ?.pendingRescope
  if (typeof staged !== 'object' || staged === null) return null
  const { target, evidence } = staged as { target?: unknown; evidence?: unknown }
  if (typeof target !== 'string' || target.trim() === '') return null
  const t = target.trim()
  const sentence = /[.!?]$/.test(t) ? t : `${t}.`
  const proof =
    typeof evidence === 'string' && evidence.trim() !== '' ? ` Proof: ${evidence.trim()}` : ''
  const asked = view.log
    .split(/\n(?=### )/)
    .filter((b) => /^### \S+ · re-scope requested/.test(b))
    .at(-1)
  const reason = asked ? /^Reason: (.+)$/m.exec(asked)?.[1]?.trim() : undefined
  return { text: `${sentence}${proof}${reason ? ` (Reason: ${reason})` : ''}` }
}

/**
 * What `mission:v4Door` runs. Every door goes to the v4 doors, for an older (v3) mission too: the first
 * write converts it by copy (the v4 record under the same id, the v3 file left byte-identical, NG-8 and
 * AC-22), and for a staged re-scope the copy carries the staging as its `pendingDoneWhen`, so Approve and
 * Decline are the v4 Done when doors (S-42 delta 1). The Log line is the one the old popover wrote.
 */
export async function runPaneDoor(raw: unknown): Promise<Record<string, unknown>> {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (
    (a.door === 'approveDoneWhen' || a.door === 'declineDoneWhen') &&
    typeof a.folder === 'string' &&
    a.folder !== '' &&
    typeof a.missionId === 'string' &&
    a.missionId !== ''
  ) {
    try {
      // A read: it writes nothing. Only the door call below writes, and it converts by copy first.
      const read = await readMissionRecord(repoRoot(a.folder), a.missionId)
      if (read.ok && stagedRescopeOf(read) !== null) {
        const door = a.door === 'approveDoneWhen' ? approveDoneWhen : declineDoneWhen
        return doorReply(await door(a.folder, a.missionId, { asRescope: true }))
      }
    } catch (err) {
      return { ok: false, code: 'UNREADABLE', error: `UNREADABLE: ${(err as Error).message}` }
    }
  }
  return doorReply(await runDoor(raw))
}

/**
 * Missions v4 S-16a (V-1, V-3) — the view of one mission for the Mission dropdown. It READS and never
 * writes, even for a mission that exists only as a v3 file: no v4 record, no sidecar, no ledger row,
 * no steward wake, no sticky sighting (the observer remembers; a view does not). The caller is the
 * app's interface, not a session, so the guard lets it read everything. It adds no wording of its own:
 * `detail` is S-12's, `closeWarnings` and `pendingDoneWhen` are S-15's, `sessions` is S-15's history.
 *
 * The record is read twice (once to find the facts to gather, once inside `missionGet`): S-12 has no
 * detail builder from a record already read. Nothing is derived twice. Never throws.
 */
export async function buildMissionV4View(
  raw: unknown,
  opts: {
    facts?: (root: string) => FactsDeps
    /** The live context readings (default: the status-line telemetry's live records). */
    contexts?: () => readonly ContextReading[]
  } = {}
): Promise<MissionV4ViewReply> {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (
    typeof a.folder !== 'string' ||
    a.folder === '' ||
    typeof a.sessionId !== 'string' ||
    a.sessionId === '' ||
    (a.missionId !== undefined && (typeof a.missionId !== 'string' || a.missionId === ''))
  ) {
    return refusedView(
      'BAD_ARGS',
      'the view needs a folder, a session id and, optionally, a mission id.'
    )
  }
  const folder = a.folder
  const sessionId = a.sessionId
  try {
    const root = repoRoot(folder)
    let view: MissionRecordView
    if (typeof a.missionId === 'string') {
      const read = await readMissionRecord(root, a.missionId)
      if (!read.ok) return { state: 'refused', code: read.code, error: read.error }
      view = read
    } else {
      const found = await missionOfSession(root, sessionId)
      if (found.ok === 'none') {
        const list = await missionList(folder, { kind: 'operator' })
        return list.ok
          ? { state: 'none', missions: await newestFirst(root, list.missions) }
          : { state: 'refused', code: list.code, error: list.error }
      }
      view = found.view
    }
    const { record } = view
    // The id a later call reads the record back by. A v3 campaign that was never converted reads as a
    // mission whose own id exists nowhere yet: it is found again by the campaign's id.
    const lookupId = view.source === 'v3-campaign' ? (view.sourceIds[0] ?? record.id) : record.id
    const deps = opts.facts ? opts.facts(root) : await realFactsDeps(root, VIEW_PR_WAIT_MS)
    const inputs = await gatherStepInputs(root, record, deps)
    const detail = await missionGet(
      folder,
      { kind: 'operator' },
      { missionId: lookupId },
      { inputs }
    )
    if (!detail.ok) return { state: 'refused', code: detail.code, error: detail.error }
    return {
      state: 'mission',
      missionId: lookupId,
      source: detail.source,
      detail,
      stepFacts: Object.fromEntries(
        Object.entries(inputs).map(([id, i]) => [
          id,
          {
            ...(i.pr !== undefined ? { pr: i.pr } : {}),
            ...(i.workerWorking !== undefined ? { workerWorking: i.workerWorking } : {})
          }
        ])
      ),
      closeWarnings: closeWarningsOf(record, inputs),
      // An older mission's staging reads from its file with the reason its owner gave; once converted by copy,
      // the record's own staged Done when stands in (the conversion writes it).
      pendingDoneWhen: stagedRescopeOf(view) ?? stagedDoneWhenOf(record),
      sessions: sessionHistory(record),
      handoff: handoffOffer(
        leaderContextPercent((opts.contexts ?? liveContexts)(), v4LeaderOf(record)),
        typeof a.dismissedPercent === 'number' ? a.dismissedPercent : null
      )
    }
  } catch (err) {
    return refusedView('UNREADABLE', (err as Error).message)
  }
}

/**
 * The facts of a record's steps for a surface that must answer soon (the hand-off's summary, the
 * summary after a compaction): the same sources the view reads, with a short wait for GitHub, so a
 * step reads its last-known state instead of holding the answer up.
 */
async function stepInputsOf(
  root: string,
  record: MissionV4,
  waitMs: number
): Promise<Awaited<ReturnType<typeof gatherStepInputs>>> {
  return gatherStepInputs(root, record, await realFactsDeps(root, waitMs))
}

/** The starter of the hand-off door: set once by `index.ts` from the command bridge, `null` until then. */
let handoffStart: HandoffStart | null = null

export function setMissionHandoffStarter(start: HandoffStart | null): void {
  handoffStart = start
}

/**
 * The text the summary hook prints (S-16b): the mission summary for the open leader of an open v4
 * mission after a compaction, and nothing for anyone else. Wired to the hook bridge by `index.ts`.
 */
export function answerMissionSummaryHook(body: Record<string, unknown>): Promise<string> {
  return summaryRoute(body, {
    ...defaultSummaryRouteDeps(),
    inputsFor: (cwd, record) => stepInputsOf(repoRoot(cwd), record, VIEW_PR_WAIT_MS)
  })
}

/**
 * Who the observer's v4 leg writes as. ONE constant: Harnu's own call, `{ kind: 'harnu' }` (S-11): the
 * guard judges it as it judges the operator, but nothing records that the operator did what Harnu did.
 */
const OBSERVER_ACTOR: Actor = { kind: 'harnu' }

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Missions v4 S-16a (V-4) — the observer's v4 leg. For each open record whose source is `v4`: gather
 * the facts, remember the sticky sightings (the only place that may) and attach the pull requests
 * found for its steps through S-13's `attachFoundPrs`, once. **It touches ONLY `v4` records and never
 * makes the first v4 write of a v3 mission**: `attachFoundPrs` on a record read from v3 would convert
 * it by copy, which is the format switch and belongs to a v4-shaped verb or a door. A repo with no
 * `.harnu/missions-v4/` costs one directory check. It adds no timer and no spawn: the pass is the
 * existing one, and the join shares the pull request cache a chapter 2 poll warms.
 * Returns how many v4 records it observed.
 */
async function observeV4Records(
  roots: readonly string[],
  opts: { onlySessions?: ReadonlySet<string>; v4Facts?: (root: string) => FactsDeps }
): Promise<number> {
  let observed = 0
  for (const root of roots) {
    if (!(await isDirectory(v4RecordsDir(root)))) continue
    const { records } = await listMissionRecords(root)
    const open = records.filter(
      (v) =>
        v.source === 'v4' &&
        v.record.status === 'open' &&
        (opts.onlySessions === undefined ||
          [...opts.onlySessions].some((id) => openEntry(v.record, id) !== undefined))
    )
    if (open.length === 0) continue
    // The sources are built once per repo, and the board is read once per pass however many records
    // name a card: every record's gather shares the one answer (and the one parse of it).
    const base = opts.v4Facts ? opts.v4Facts(root) : await realFactsDeps(root)
    let board: Promise<readonly CardFile[]> | undefined
    const readBoard = base.board
    const deps: FactsDeps = readBoard ? { ...base, board: () => (board ??= readBoard()) } : base
    for (const { record } of open) {
      try {
        const { sightings, found } = await gatherStepFacts(root, record, deps)
        for (const s of sightings) rememberResolved(root, s.kind, s.ref, s.seen)
        if (found.some((f) => f.state !== 'closed')) {
          const result = await attachFoundPrs(root, OBSERVER_ACTOR, record.id, found)
          if (!result.ok)
            console.warn(`[mission-observer] could not attach to ${record.id}:`, result.error)
        }
        observed++
      } catch (err) {
        console.warn(`[mission-observer] could not observe ${record.id}:`, err)
      }
    }
  }
  return observed
}

/** Folders the renderer asked about lately: where the observer looks when the app is open. */
const askedFolders = new Set<string>()
const ASKED_FOLDERS_MAX = 500

function noteAskedFolders(folders: readonly string[]): void {
  for (const f of folders) {
    if (typeof f !== 'string' || askedFolders.has(f)) continue
    askedFolders.add(f)
    if (askedFolders.size > ASKED_FOLDERS_MAX) {
      const oldest = askedFolders.values().next().value
      if (oldest !== undefined) askedFolders.delete(oldest)
    }
  }
}

/** Where the observer looks for open missions: what the renderer asked about and the pinned folders. */
async function observerFolders(): Promise<string[]> {
  const out = new Set<string>(askedFolders)
  try {
    for (const p of (await readUserProjects()).projects) out.add(p.path)
  } catch {
    // No projects file yet: the asked folders still stand.
  }
  return [...out]
}

let observer: MissionObserver | null = null

/**
 * Starts what drives the observer, once, from `src/main/index.ts`: a pass on a cadence over the
 * open missions and one after a linked session ends. It is the only thing that records what the
 * missions' links show (ledger rows, sticky facts, remembered progress) and wakes the stewards;
 * the reads never do. Returns the stop.
 */
export function startMissionObserver(): () => void {
  if (!observer) {
    observer = createMissionObserver({
      folders: observerFolders,
      pass: (folders, opts) => observeOpenMissions(folders, Date.now(), opts),
      onTaskEvent: (cb) =>
        addTaskEventObserver((ev) => cb({ sessionId: ev.sessionId, taskState: ev.taskState }))
    })
    observer.start()
  }
  return () => {
    observer?.stop()
    observer = null
  }
}

/** The one in-main observer of the polled list (Your move's mission source). */
let missionListObserver: ((r: MissionListResult, roots: string[]) => void) | null = null

export function setMissionListObserver(
  fn: ((r: MissionListResult, roots: string[]) => void) | null
): void {
  missionListObserver = fn
}

/** What the disk says about a path: a regular file, a folder, or nothing there. */
export type MissionPathKind = 'file' | 'dir' | 'missing'

/** The most paths one `mission:pathKinds` call answers: a step's links, never a directory walk. */
export const PATH_KINDS_MAX = 32

/**
 * Missions v4 mission dropdown S-4 — whether the paths a step's links name still exist, and whether each is a
 * file or a folder. The dropdown draws a worktree whose path is gone as "removed — branch kept", and opens an
 * evidence link's README (or the file itself). It reads the file system's metadata and nothing else: no
 * content, no listing, no write. Only absolute paths are asked about (anything else answers `missing`) and at
 * most {@link PATH_KINDS_MAX} of them; the answer is keyed by the path asked.
 *
 * The renderer is untrusted, so a path is looked at only inside the folders Harnu knows (`markdownKnownRoots()`,
 * the roots `markdown:read` is confined to): anything outside them answers `missing` and is never stat-ed. A
 * mission's own worktrees sit under their repo's `.claude/worktrees/`, inside the repo's root, so they are
 * covered; a worktree that is gone from disk still answers `missing`, which the dropdown reads as removed.
 */
export async function readPathKinds(paths: unknown): Promise<Record<string, MissionPathKind>> {
  const asked = Array.isArray(paths)
    ? paths.filter((p): p is string => typeof p === 'string').slice(0, PATH_KINDS_MAX)
    : []
  const out: Record<string, MissionPathKind> = {}
  const roots = asked.some((p) => isAbsolute(p)) ? await markdownKnownRoots() : []
  await Promise.all(
    asked.map(async (p) => {
      if (!isAbsolute(p) || !isPathAllowed(resolve(p), roots)) {
        out[p] = 'missing'
        return
      }
      try {
        const st = await fs.stat(p)
        out[p] = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'missing'
      } catch {
        out[p] = 'missing'
      }
    })
  )
  return out
}

/** Registers the renderer-facing channels. Called once from `src/main/index.ts`. */
export function registerMissionIpc(): void {
  ipcMain.handle('mission:list', async (_e, folders: unknown): Promise<MissionListResult> => {
    const asked = Array.isArray(folders) ? (folders as string[]) : []
    noteAskedFolders(asked)
    const result = await listMissionViews(asked)
    // Your move reads the same poll the renderer makes: no extra read, no extra GitHub budget.
    if (missionListObserver) {
      try {
        missionListObserver(result, [
          ...new Set(asked.filter((f) => typeof f === 'string').map(missionRoot))
        ])
      } catch (err) {
        console.error('[mission-ipc] list observer threw', err)
      }
    }
    return result
  })
  // The v3 operator doors went with the v3 popover (S-40). The preload still names the channels, so they
  // answer a refusal that says so instead of leaving a call unanswered.
  const goneDoor = async (): Promise<MissionDoorResult> => ({
    ok: false,
    error:
      'The v3 mission doors were removed: the operator acts on a mission in the Mission dropdown (mission:v4Door).'
  })
  ipcMain.handle('mission:operatorDoor', goneDoor)
  ipcMain.handle('mission:choose', goneDoor)
  // Missions v4 S-15 — the operator's doors on a v4 record (mark, clear a blocker, approve a Done when,
  // close, allow or deny a join, attach from the picker). Additive: nothing above changes. The preload
  // exposes it as `missionV4Door`, which is how the renderer reaches it. The reply carries the outcome and
  // the close warnings, never the record or a file path.
  ipcMain.handle('mission:v4Door', async (_e, door: unknown) => runPaneDoor(door))
  // Mission dropdown S-4 — a read-only existence check for the paths of a step's links. No write, no content.
  ipcMain.handle('mission:pathKinds', (_e, paths: unknown) => readPathKinds(paths))
  // Missions v4 S-16a — the view of one mission for the Mission dropdown. It reads and never writes. The
  // dropdown calls it for the selected session (and by mission id for the one it shows). It also notes the folder, so the observer's v4 leg looks there.
  ipcMain.handle('mission:v4View', async (_e, args: unknown): Promise<MissionV4ViewReply> => {
    const folder = (args as { folder?: unknown } | null)?.folder
    if (typeof folder === 'string') noteAskedFolders([folder])
    return buildMissionV4View(args)
  })
  // Missions v4 S-16b — the hand-off: the one thing that changes who leads. It starts a normal session with the
  // mission summary as its first prompt, waits for its real id and writes once as the operator. No renderer
  // calls it since the Mission dropdown replaced the old pane (the door stays, dormant: no text points at it).
  ipcMain.handle('mission:handOff', async (_e, args: unknown) =>
    runHandOff(
      args,
      handoffStart === null
        ? null
        : {
            start: handoffStart,
            inputs: (root, record) => stepInputsOf(root, record, VIEW_PR_WAIT_MS)
          }
    )
  )
}
