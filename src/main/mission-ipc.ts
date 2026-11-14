/**
 * Mission IPC (T370, T358 slice S9; Mission v3) — the renderer's read of every
 * open mission and the operator's doors, over typed `mission:*` channels.
 *
 * Read side: `mission:list` returns, per open (non-`closed`) mission in the
 * repos of the folders the renderer knows, the SAME projection `mission_get`
 * builds — stored fields, the `derived` block (live children, existence proofs,
 * the stall verdict, the server's `progress`) — plus the ordered `you` list
 * the UI translates, and the end dialog's `closeWarnings` (warnings, never
 * refusals). `stale` stays derived (`derived.stale`); nothing here writes a status.
 *
 * Write side: `mission:operatorDoor` is the ONLY write the mission UI makes —
 * approve a staged re-scope, tick a human step, end a mission (close as
 * delivered or discard), add / tick / delete a human check, and choose a decision
 * node's option (also reachable as `mission:choose`). Each is a pure
 * function in `mission-core.ts` applied under the same per-mission-id lock the
 * `mission_*` verbs use, then written atomically with a Log line saying what
 * the operator did. No MCP verb reaches this module (pinned by
 * tests/mission-operator-doors.test.ts), which is what makes these doors the
 * operator's: an agent can only stage (`mission_set_end`,
 * `mission_request_close`) or add a check, never apply.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { retireStewardForClosedMission } from './steward-shell'
import { ipcMain } from 'electron'
import { addTaskEventObserver } from './hook-bridge'
import { listStewards } from './scheduler-shell'
import { readUserProjects } from './user-projects'
import { scanFolders } from './claude-reader'
import type { FolderEntry } from './folder-model'
import { mapLimit } from './map-limit'
import {
  applyAddCheck,
  applyChooseDecision,
  applyApprovedRescope,
  applyPauseSteward,
  applyResumeSteward,
  applyDeleteCheck,
  applyOperatorEnd,
  applyOperatorVerifyStep,
  applyTickCheck,
  buildMissionFileContent,
  closeWarnings,
  withMissionIdMintLock,
  type CloseWarning,
  type Mission
} from './mission-core'
import type { MissionProgress } from './mission-progress'
import { atomicWriteFile } from './mcp/atomic-write'
import { recordMemoryDrafts, unknownDraftIds, type RecordResult } from './mission-record'
import {
  deriveMissionReading,
  deriveMissionSignals,
  missionTitle,
  type MissionDerived,
  type ToolHandlerCtx
} from './mcp/tool-handlers'
import {
  leaderOf,
  loadMission,
  missionRoot,
  readMissionsDeduped,
  type RootedMission
} from './missions/store'
import { waitingList, type WaitingItem } from './missions/waiting'
import { doorReply, runDoor } from './missions/doors'
import { createMissionObserver, observeMission, type MissionObserver } from './missions/observer'
import { ensureLinkCacheLoaded, getLastKnown, rememberResolved } from './mission-link-cache'
import { hydrateMissionLedger, observedRows } from './missions/ledger-store'
import { getTaskState } from './detect/task-state-hub'
import { findMainCi, findPrsForWorktrees } from './pr-stack'
import { repoRoot } from './data-dir'
import { resolveRoadmap } from './roadmap-ipc'
import { openEntry, leaderOf as v4LeaderOf, type Actor } from './missions/guard'
import {
  listMissionRecords,
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

/** One open mission as the renderer reads it (design.md §6 "Mission progress"). */
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
  // Campaign spec §3.4 — Pause steward…: a mandatory reason; Resume steward. A mission door, not a worker switch.
  | { door: 'pauseSteward'; root: string; missionId: string; reason: string }
  | { door: 'resumeSteward'; root: string; missionId: string }

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

/** How long one fleet scan serves `mission:list` passes (Mission v3 §3.8). */
const SCAN_TTL_MS = 10_000
/** How many missions `mission:list` derives at once (Mission v3 §3.8). */
const LIST_CONCURRENCY = 4
/**
 * How long a door's re-derive waits for GitHub (Mission v3 §3.8, "doors return
 * within 2 s"). The list poll keeps the 60 s PR cache warm, so this only bites
 * on a cold cache: the links then read their sticky last-known state
 * (`stale: true`) and the fetch lands in the cache for the next poll.
 */
const DOOR_PR_WAIT_MS = 1500

let scanMemo: { at: number; folders: Promise<FolderEntry[]> } | null = null

/**
 * `scanFolders()` memoized for {@link SCAN_TTL_MS}: the list poll and a door's
 * re-derive share one fleet scan instead of walking ~/.claude/projects each time.
 * Single-flight while pending; a failed scan is not kept.
 */
function scanFoldersMemo(): Promise<FolderEntry[]> {
  const now = Date.now()
  if (scanMemo && now - scanMemo.at < SCAN_TTL_MS) return scanMemo.folders
  const memo = { at: now, folders: scanFolders() }
  scanMemo = memo
  memo.folders.catch(() => {
    if (scanMemo === memo) scanMemo = null
  })
  return memo.folders
}

/** One mission's view — the same projection `mission_get` builds. */
async function buildMissionView(
  root: string,
  mission: Mission,
  log: string,
  ctx: ToolHandlerCtx,
  now: number,
  opts: { prWaitMs?: number } = {}
): Promise<MissionView> {
  const { derived, children } = await deriveMissionSignals(root, mission, log, ctx, now, opts)
  const projected: Mission = { ...mission }
  delete projected.legacyRaw
  return {
    root,
    mission: projected,
    title: missionTitle(log, mission.slug),
    derived,
    you: waitingList(mission, children, derived.progress, derived.steps),
    progress: derived.progress,
    closeWarnings: closeWarnings(mission, derived.progress)
  }
}

/** One mission to derive: where its file lives, the mission and its Log. */
interface MissionJob {
  root: string
  mission: Mission
  log: string
}

/**
 * The missions to derive, taken round-robin across repos (so every repo's first `gh` fetch starts
 * in the first wave). `only`: just the missions one of these sessions owns or is linked to as a
 * child; absent: every one.
 */
function pickJobs(missions: readonly RootedMission[], only?: ReadonlySet<string>): MissionJob[] {
  const wanted = (m: Mission): boolean =>
    only === undefined ||
    only.has(leaderOf(m) ?? '') ||
    m.steps.some((s) => s.links.some((l) => l.kind === 'session' && only.has(l.ref)))
  const perRoot = new Map<string, RootedMission[]>()
  for (const m of missions) {
    if (!wanted(m.mission)) continue
    perRoot.set(m.root, [...(perRoot.get(m.root) ?? []), m])
  }
  const lists = [...perRoot.values()]
  const jobs: MissionJob[] = []
  for (let k = 0; lists.some((list) => k < list.length); k++) {
    for (const list of lists) if (k < list.length) jobs.push(list[k])
  }
  return jobs
}

/**
 * Every open mission under the repos of `folders`, newest first. Missions are
 * derived {@link LIST_CONCURRENCY} at a time (Mission v3 §3.8), taken round-robin
 * across repos so every repo's first `gh` fetch starts in the first wave — the
 * rest of that repo's missions then join the single-flight fetch in pr-stack.
 */
export async function listMissionViews(
  folders: readonly string[],
  now = Date.now(),
  opts: {
    /**
     * Only the missions one of these sessions owns or is linked to as a child are derived (the files
     * are all read; the derive, the costly part, is skipped for the rest). Absent: every open mission.
     */
    onlySessions?: ReadonlySet<string>
  } = {}
): Promise<MissionListResult> {
  const roots = [...new Set(folders.filter((f) => typeof f === 'string').map(missionRoot))]
  if (roots.length === 0) return { views: [], unreadable: [], shadowed: [] }
  const [read, folderRows] = await Promise.all([
    readMissionsDeduped(roots, { includeClosed: false }),
    scanFoldersMemo()
  ])
  const unreadable = read.unreadable.map((u) => u.name)
  const jobs = pickJobs(read.missions, opts.onlySessions)
  const views = await mapLimit(jobs, LIST_CONCURRENCY, ({ root, mission, log }) =>
    // The operator's own view: no folder is blocked from them (denyFolders is
    // an AGENT policy), and the fleet scan feeds the linked children's live state.
    buildMissionView(
      root,
      mission,
      log,
      { folder: root, folders: folderRows, denyFolders: [], bridge: undefined },
      now
    )
  )
  views.sort((a, b) => b.mission.updatedAt.localeCompare(a.mission.updatedAt))
  return { views, unreadable, shadowed: read.shadowed }
}

function applyDoor(door: MissionDoor, mission: Mission, at: string): Mission {
  switch (door.door) {
    case 'approveRescope':
      return applyApprovedRescope(mission, { at })
    case 'end':
      return applyOperatorEnd(mission, {
        at,
        closedAs: door.closedAs,
        ...(door.reason !== undefined ? { reason: door.reason } : {})
      })
    case 'verifyStep':
      return applyOperatorVerifyStep(mission, door.stepId, { at, verified: door.verified })
    case 'addCheck':
      return applyAddCheck(mission, door.stepId, door.label, 'operator', at)
    case 'tickCheck':
      return applyTickCheck(mission, door.stepId, door.checkId, { at, ticked: door.ticked })
    case 'deleteCheck':
      return applyDeleteCheck(mission, door.stepId, door.checkId, { at })
    case 'chooseDecision':
      return applyChooseDecision(mission, door.stepId, door.index, { at })
    case 'pauseSteward':
      return applyPauseSteward(mission, door.reason, { at })
    case 'resumeSteward':
      return applyResumeSteward(mission, { at })
  }
}

/**
 * The Log line a door leaves (Mission v3 §3.5, F8): the owner reads its mission's
 * Log, so it learns what the operator did — and a closed mission refuses its
 * verbs with MISSION_CLOSED.
 */
function doorLogEntry(
  door: MissionDoor,
  at: string,
  applied: Mission,
  recorded?: RecordResult
): string {
  const what = ((): string => {
    switch (door.door) {
      case 'approveRescope':
        return 'operator approved the re-scope'
      case 'end':
        return `operator ended (${door.closedAs})`
      case 'verifyStep':
        return `operator ${door.verified ? 'ticked' : 'un-ticked'} ${door.stepId}`
      case 'addCheck':
        return `operator added a check on ${door.stepId}`
      case 'tickCheck':
        return `operator ${door.ticked ? 'ticked' : 'un-ticked'} ${door.checkId} on ${door.stepId}`
      case 'deleteCheck':
        return `operator deleted ${door.checkId} on ${door.stepId}`
      case 'chooseDecision':
        return `operator chose "${chosenOption(door, applied)}"`
      // Campaign spec §3.4: these two are `steward` Log entries (the heading's kind tag).
      case 'pauseSteward':
        return 'steward · operator paused the steward'
      case 'resumeSteward':
        return 'steward · operator resumed the steward'
    }
  })()
  const body =
    door.door === 'end'
      ? [door.reason?.trim() || '(no reason given)', ...recordedLines(recorded)].join('\n')
      : door.door === 'addCheck'
        ? door.label
        : door.door === 'pauseSteward'
          ? (applied.stewardPause?.reason ?? '')
          : door.door === 'chooseDecision'
            ? // Campaign spec §3.2 — the Log entry kind: a decision, for what reads the Log.
              `kind: decision\nstep: ${door.stepId}\n${applied.steps.find((s) => s.id === door.stepId)?.decision?.title ?? ''}`
            : ''
  return `\n### ${at} · ${what}\n${body ? `\n${body}\n` : ''}`
}

/** The Log lines saying what "Also record" wrote to memory, and what it could not. */
function recordedLines(recorded: RecordResult | undefined): string[] {
  if (!recorded) return []
  return [
    ...(recorded.written.length ? [`recorded to memory: ${recorded.written.join(', ')}`] : []),
    ...recorded.failed.map((f) => `not recorded: ${f.id} (${f.error})`)
  ]
}

/** The option text a Choose door picked, read off the mission it produced. */
function chosenOption(door: Extract<MissionDoor, { door: 'chooseDecision' }>, m: Mission): string {
  return m.steps.find((s) => s.id === door.stepId)?.decision?.options[door.index] ?? ''
}

const DOORS: ReadonlySet<string> = new Set([
  'approveRescope',
  'end',
  'verifyStep',
  'addCheck',
  'tickCheck',
  'deleteCheck',
  'chooseDecision',
  'pauseSteward',
  'resumeSteward'
])

/** A door's own required fields, or the BAD_ARGS refusal naming them. */
function doorArgsProblem(door: Partial<Record<string, unknown>>): string | null {
  const str = (k: string): boolean => typeof door[k] === 'string'
  switch (door.door) {
    case 'end':
      if (
        !(door.closedAs === 'delivered' || door.closedAs === 'discarded') ||
        !(door.reason === undefined || str('reason'))
      ) {
        return 'BAD_ARGS: end needs closedAs (delivered | discarded) and an optional string reason'
      }
      return door.record === undefined ||
        (Array.isArray(door.record) && door.record.every((id) => typeof id === 'string'))
        ? null
        : 'BAD_ARGS: end record must be an array of draft ids'
    case 'verifyStep':
      return str('stepId') && typeof door.verified === 'boolean'
        ? null
        : 'BAD_ARGS: verifyStep needs stepId and verified'
    case 'addCheck':
      return str('stepId') && str('label') ? null : 'BAD_ARGS: addCheck needs stepId and label'
    case 'tickCheck':
      return str('stepId') && str('checkId') && typeof door.ticked === 'boolean'
        ? null
        : 'BAD_ARGS: tickCheck needs stepId, checkId and ticked'
    case 'deleteCheck':
      return str('stepId') && str('checkId')
        ? null
        : 'BAD_ARGS: deleteCheck needs stepId and checkId'
    case 'chooseDecision':
      return str('stepId') && typeof door.index === 'number'
        ? null
        : 'BAD_ARGS: chooseDecision needs stepId and a numeric index'
    case 'pauseSteward':
      return typeof door.reason === 'string' && door.reason.trim() !== ''
        ? null
        : 'BAD_ARGS: pauseSteward needs a reason — say why the steward is paused'
    default:
      return null
  }
}

/**
 * Run one operator door: a locked read → apply → atomic write of the mission's
 * frontmatter, the Log body carried over unchanged — then, outside the lock,
 * re-derive THAT mission for the answer (Mission v3 §3.2). The door's own
 * refusal (nothing staged, a closed mission, the close re-validation) comes
 * back as `{ ok: false, error }`, never a throw across IPC. A second end on a
 * closed mission is `MISSION_CLOSED` — the lock serializes a double click.
 */
export async function runOperatorDoor(
  raw: unknown,
  now: () => string = () => new Date().toISOString()
): Promise<MissionDoorResult> {
  const door = raw as Partial<MissionDoor> | null
  if (
    !door ||
    typeof door.door !== 'string' ||
    !DOORS.has(door.door) ||
    typeof door.root !== 'string' ||
    typeof door.missionId !== 'string'
  ) {
    return { ok: false, error: 'BAD_ARGS: unknown door or missing root/missionId' }
  }
  const argsProblem = doorArgsProblem(door as Partial<Record<string, unknown>>)
  if (argsProblem) return { ok: false, error: argsProblem }
  // Re-resolve the root in main — never trust a renderer-supplied storage path.
  const root = missionRoot(door.root)
  const missionId = door.missionId
  const written = await withMissionIdMintLock(
    missionId,
    async (): Promise<
      | { ok: true; mission: Mission; log: string; deduped?: true; recorded?: RecordResult }
      | { ok: false; error: string }
    > => {
      const loaded = await loadMission(root, missionId)
      if (!loaded.ok) return { ok: false, error: loaded.error }
      try {
        const at = now()
        const mission = applyDoor(door as MissionDoor, loaded.mission, at)
        // Campaign ch.6 (T610): "Also record" — only a delivered end writes memory, only the
        // ticked drafts, and only after the end itself validated (a closed mission throws above).
        let recorded: RecordResult | undefined
        if (door.door === 'end' && door.closedAs === 'delivered' && door.record?.length) {
          const unknown = unknownDraftIds(loaded.mission.memoryDrafts, door.record)
          if (unknown.length) {
            return {
              ok: false,
              error: `UNKNOWN_DRAFT: no stored memory draft ${unknown.join(', ')} on ${missionId}`
            }
          }
          recorded = await recordMemoryDrafts(
            root,
            loaded.mission.memoryDrafts,
            door.record,
            Date.parse(at)
          )
        }
        if (door.door === 'addCheck') {
          const count = (m: Mission): number =>
            m.steps.find((s) => s.id === door.stepId)?.checks?.length ?? 0
          // A label already on the step (any case): no write, no log line, no
          // updatedAt bump — the audit trail only says what actually happened.
          if (count(mission) === count(loaded.mission)) {
            return { ok: true, mission: loaded.mission, log: loaded.log, deduped: true }
          }
        }
        const log =
          loaded.log +
          (loaded.log.endsWith('\n') ? '' : '\n') +
          doorLogEntry(door as MissionDoor, at, mission, recorded)
        await atomicWriteFile(loaded.file, buildMissionFileContent(mission, log), 0o644)
        return { ok: true, mission, log, ...(recorded ? { recorded } : {}) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
  if (!written.ok) return written
  // Ended: it leaves every surface — nothing to derive.
  if (written.mission.status === 'closed') {
    // Campaign ch.5a: the mission's steward (a system worker) and its hooks end with the mission.
    await retireStewardForClosedMission({
      missionId: written.mission.id,
      ownerFolder: written.mission.owner.folder
    })
    return { ok: true, view: null, ...(written.recorded ? { recorded: written.recorded } : {}) }
  }
  try {
    const ctx: ToolHandlerCtx = {
      folder: root,
      folders: await scanFoldersMemo(),
      denyFolders: [],
      bridge: undefined
    }
    const view = await buildMissionView(root, written.mission, written.log, ctx, Date.now(), {
      prWaitMs: DOOR_PR_WAIT_MS
    })
    return written.deduped ? { ok: true, view, deduped: true } : { ok: true, view }
  } catch (err) {
    // The write landed; the next list poll shows it. Never fail a door that took effect.
    console.error('[mission-ipc] door re-derive failed', err)
    return written.deduped ? { ok: true, view: null, deduped: true } : { ok: true, view: null }
  }
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
 * One observer pass: derive every open mission of `folders` (or the ones linking `onlySessions`)
 * and let the observer record what each reading saw. It does what one `mission:list` poll does
 * — the same file read, the same fleet scan (memoized), one derive per mission, which joins the
 * same single-flight pull request cache — and nothing more: no extra `git` or `gh` call. With no
 * open mission it stops after reading the mission files. Returns how many missions it observed.
 */
export async function observeOpenMissions(
  folders: readonly string[],
  now = Date.now(),
  opts: {
    onlySessions?: ReadonlySet<string>
    /** Test seam: the fleet scan that feeds the linked children's live state. */
    scan?: () => Promise<FolderEntry[]>
    /** Test seam: the sources the v4 leg gathers a step's facts from (default: the real ones). */
    v4Facts?: (root: string) => FactsDeps
  } = {}
): Promise<number> {
  const roots = [...new Set(folders.filter((f) => typeof f === 'string').map(missionRoot))]
  if (roots.length === 0) return 0
  const observed = await observeV3Missions(roots, now, opts)
  // Missions v4 S-16a (V-4): the v4 leg runs after the v3 loop and can never fail it.
  try {
    await observeV4Records(roots, opts)
  } catch (err) {
    console.warn('[mission-observer] the v4 leg failed:', err)
  }
  return observed
}

/** The v3 loop of the pass: unchanged from chapter 2. Returns how many missions it observed. */
async function observeV3Missions(
  roots: readonly string[],
  now: number,
  opts: { onlySessions?: ReadonlySet<string>; scan?: () => Promise<FolderEntry[]> }
): Promise<number> {
  const read = await readMissionsDeduped([...roots], { includeClosed: true })
  await copyClosedMissionLedgers(read.missions)
  const jobs = pickJobs(
    read.missions.filter((m) => m.mission.status !== 'closed'),
    opts.onlySessions
  )
  if (jobs.length === 0) return 0
  const folderRows = await (opts.scan ?? scanFoldersMemo)()
  await mapLimit(jobs, LIST_CONCURRENCY, async ({ root, mission, log }) => {
    try {
      const reading = await deriveMissionReading(
        root,
        mission,
        log,
        { folder: root, folders: folderRows, denyFolders: [], bridge: undefined },
        now
      )
      // Missions v4 S-4: load the rows the repo already stores (and copy in what the userData
      // cache carries) before the observer dedupes against them. Never under a read.
      await ensureLinkCacheLoaded()
      await hydrateMissionLedger(root, mission.id)
      observeMission(mission, reading, now)
    } catch (err) {
      // One mission that cannot be read never stops the pass for the others.
      console.warn(`[mission-observer] could not observe ${mission.id}:`, err)
    }
  })
  return jobs.length
}

// ---- Missions v4 S-16a: the facts' real sources, the view channel and the observer's v4 leg ----------

/** How long the view waits for GitHub; past it a step reads its sticky last-known state (like a door). */
const VIEW_PR_WAIT_MS = 1500

/**
 * The real sources of {@link FactsDeps} for one repo: the board's files, chapter 2's pull request join
 * (which shares the single-flight cache a `mission:list` poll already warms), its last-known cache, the
 * filesystem and the task-state hub. `waitMs` bounds how long the join waits for GitHub.
 */
async function realFactsDeps(root: string, waitMs?: number): Promise<FactsDeps> {
  await ensureLinkCacheLoaded()
  return {
    board: async () => {
      const { roadmapDir } = await resolveRoadmap(root)
      const names = (await fs.readdir(roadmapDir)).filter((n) => n.endsWith('.md'))
      return Promise.all(
        names.map(async (n) => ({
          slug: n.slice(0, -3),
          content: await fs.readFile(path.join(roadmapDir, n), 'utf8')
        }))
      )
    },
    findPrs: (refs) => findPrsForWorktrees(root, refs, { waitMs }),
    findMainCi: (numbers) => findMainCi(root, numbers, { waitMs }),
    lastKnown: (kind, ref) => getLastKnown(root, kind, ref),
    pathExists: async (abs) => {
      try {
        await fs.stat(abs)
        return true
      } catch {
        return false
      }
    },
    taskState: (id) => getTaskState(id)
  }
}

/** What the view channel is asked: the folder the caller works in, who asks, and optionally which mission. */
export interface MissionV4ViewRequest {
  folder: string
  sessionId: string
  missionId?: string
  /** The percentage the operator last said "Not now" to the hand-off offer at, if any (S-16b). */
  dismissedPercent?: number
}

/**
 * What the view channel answers. `mission`: everything the pane reads about one mission (`detail` is
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
      /** What the end dialog warns about, counted with the facts (the close door's own reply has none). */
      closeWarnings: V4CloseWarning[]
      /** The Done when a session staged for the operator to approve, or `null`. */
      pendingDoneWhen: { text: string; at?: string } | null
      sessions: SessionHistoryRow[]
      /**
       * Whether to offer "Continue in a new session…": the leader's context from a LIVE reading, 80
       * percent or more, quiet after a "Not now" until it grows five points. An offer only: nothing
       * starts until the operator confirms the hand-off (S-16b).
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
 */
async function missionOfSession(
  root: string,
  sessionId: string
): Promise<
  | { ok: true; view: MissionRecordView }
  | { ok: false; code: string; error: string }
  | { ok: 'none' }
> {
  const { records } = await listMissionRecords(root)
  const mine = records.filter(
    (v) => v.record.status === 'open' && openEntry(v.record, sessionId) !== undefined
  )
  if (mine.length === 0) return { ok: 'none' }
  if (mine.length === 1) return { ok: true, view: mine[0] }
  const leading = mine.filter((v) => v4LeaderOf(v.record) === sessionId)
  if (leading.length === 1) return { ok: true, view: leading[0] }
  return {
    ok: false,
    code: 'AMBIGUOUS_MISSION',
    error: `this session is attached to ${mine.length} open missions (${mine
      .map((v) => v.record.id)
      .join(', ')}); name one with missionId.`
  }
}

/** The status line's LIVE readings: one record per running session. The last-known ones are never used. */
const liveContexts = (): readonly ContextReading[] => getTelemetryPayload().perSession

/**
 * Missions v4 S-16a (V-1, V-3) — the view of one mission for the Mission pane. It READS and never
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
          ? { state: 'none', missions: list.missions }
          : { state: 'refused', code: list.code, error: list.error }
      }
      if (found.ok === false) return refusedView(found.code, found.error)
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
      closeWarnings: closeWarningsOf(record, inputs),
      pendingDoneWhen: stagedDoneWhenOf(record),
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
 * Who the observer's v4 leg writes as. ONE constant: the app attaching what it found, on the operator's
 * behalf. S-11's final head adds the actor `{ kind: 'harnu' }` for exactly this; until it is merged
 * here the code allows only the operator.
 */
const OBSERVER_ACTOR: Actor = { kind: 'operator' }

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
    for (const { record } of open) {
      try {
        const deps = opts.v4Facts ? opts.v4Facts(root) : await realFactsDeps(root)
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

/** Where the observer looks for open missions: what the renderer asked about, the pinned folders, the stewards'. */
async function observerFolders(): Promise<string[]> {
  const out = new Set<string>(askedFolders)
  for (const s of listStewards()) out.add(s.folder)
  try {
    for (const p of (await readUserProjects()).projects) out.add(p.path)
  } catch {
    // No projects file yet: the other two sources still stand.
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
  ipcMain.handle('mission:operatorDoor', async (_e, door: unknown): Promise<MissionDoorResult> =>
    runOperatorDoor(door)
  )
  // Missions v4 S-15 — the operator's doors on a v4 record (mark, clear a blocker, approve a Done when,
  // close, allow or deny a join, attach from the picker). Additive: nothing above changes. It has no
  // preload entry until S-16, so the renderer cannot reach it yet. The reply carries the outcome and the
  // close warnings, never the record or a file path.
  ipcMain.handle('mission:v4Door', async (_e, door: unknown) => doorReply(await runDoor(door)))
  // Missions v4 S-16a — the view of one mission for the Mission pane. It reads and never writes. No
  // renderer calls it until S-17. It also notes the folder, so the observer's v4 leg looks there.
  ipcMain.handle('mission:v4View', async (_e, args: unknown): Promise<MissionV4ViewReply> => {
    const folder = (args as { folder?: unknown } | null)?.folder
    if (typeof folder === 'string') noteAskedFolders([folder])
    return buildMissionV4View(args)
  })
  // Missions v4 S-16b — the hand-off: the one thing that changes who leads. The pane's confirm dialog
  // calls it; it starts a normal session with the mission summary as its first prompt, waits for its
  // real id and writes once as the operator. No renderer calls it until S-20.
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
  // Campaign spec §4 — the Choose door has its own channel; it is the same door.
  ipcMain.handle('mission:choose', async (_e, args: unknown): Promise<MissionDoorResult> => {
    const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    return runOperatorDoor({ ...a, door: 'chooseDecision' })
  })
}
