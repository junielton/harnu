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
 * delivered or discard), and add / tick / delete a human check. Each is a pure
 * function in `mission-core.ts` applied under the same per-mission-id lock the
 * `mission_*` verbs use, then written atomically with a Log line saying what
 * the operator did. No MCP verb reaches this module (pinned by
 * tests/mission-operator-doors.test.ts), which is what makes these doors the
 * operator's: an agent can only stage (`mission_set_end`,
 * `mission_request_close`) or add a check, never apply.
 */

import { ipcMain } from 'electron'
import { scanFolders } from './claude-reader'
import type { FolderEntry } from './folder-model'
import { mapLimit } from './map-limit'
import {
  applyAddCheck,
  applyApprovedRescope,
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
import {
  deriveMissionSignals,
  loadMission,
  missionRoot,
  missionTitle,
  readMissionsDeduped,
  youItems,
  type MissionDerived,
  type MissionYouItem,
  type RootedMission,
  type ToolHandlerCtx
} from './mcp/tool-handlers'

/** One open mission as the renderer reads it (design.md §6 "Mission progress"). */
export interface MissionView {
  /** The repo root whose `.harnu/missions/` holds the file — the door's `root`. */
  root: string
  /** `legacyRaw` is left out, like `mission_get` does (design §9). */
  mission: Omit<Mission, 'legacyRaw'>
  title: string
  derived: MissionDerived
  /** Mission v3 §3.12 — what the operator owes, in order; `[]` = nothing. */
  you: MissionYouItem[]
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

/**
 * Mission v3 §3.2 — a door answers with the mission it changed, re-derived on
 * its own (never a full list), so the renderer patches that one view at once.
 * `view: null` when the door ended the mission (it leaves every surface), or in
 * the rare case the re-derive failed after the write landed.
 * `deduped`: an `addCheck` whose label was already on the step — nothing was written or logged.
 */
export type MissionDoorResult =
  { ok: true; view: MissionView | null; deduped?: true } | { ok: false; error: string }

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
    you: youItems(mission, children, derived.progress),
    progress: derived.progress,
    closeWarnings: closeWarnings(mission, derived.progress)
  }
}

/**
 * Every open mission under the repos of `folders`, newest first. Missions are
 * derived {@link LIST_CONCURRENCY} at a time (Mission v3 §3.8), taken round-robin
 * across repos so every repo's first `gh` fetch starts in the first wave — the
 * rest of that repo's missions then join the single-flight fetch in pr-stack.
 */
export async function listMissionViews(
  folders: readonly string[],
  now = Date.now()
): Promise<MissionListResult> {
  const roots = [...new Set(folders.filter((f) => typeof f === 'string').map(missionRoot))]
  if (roots.length === 0) return { views: [], unreadable: [], shadowed: [] }
  const [read, folderRows] = await Promise.all([
    readMissionsDeduped(roots, { includeClosed: false }),
    scanFoldersMemo()
  ])
  const unreadable = read.unreadable.map((u) => u.name)
  // One list per repo root, so the jobs below can be taken round-robin across repos.
  const perRoot = new Map<string, RootedMission[]>()
  for (const m of read.missions) perRoot.set(m.root, [...(perRoot.get(m.root) ?? []), m])
  const lists = [...perRoot.values()]
  const jobs: Array<{ root: string; mission: Mission; log: string }> = []
  for (let k = 0; lists.some((list) => k < list.length); k++) {
    for (const list of lists) if (k < list.length) jobs.push(list[k])
  }
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
  }
}

/**
 * The Log line a door leaves (Mission v3 §3.5, F8): the owner reads its mission's
 * Log, so it learns what the operator did — and a closed mission refuses its
 * verbs with MISSION_CLOSED.
 */
function doorLogEntry(door: MissionDoor, at: string): string {
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
    }
  })()
  const body =
    door.door === 'end'
      ? door.reason?.trim() || '(no reason given)'
      : door.door === 'addCheck'
        ? door.label
        : ''
  return `\n### ${at} · ${what}\n${body ? `\n${body}\n` : ''}`
}

const DOORS: ReadonlySet<string> = new Set([
  'approveRescope',
  'end',
  'verifyStep',
  'addCheck',
  'tickCheck',
  'deleteCheck'
])

/** A door's own required fields, or the BAD_ARGS refusal naming them. */
function doorArgsProblem(door: Partial<Record<string, unknown>>): string | null {
  const str = (k: string): boolean => typeof door[k] === 'string'
  switch (door.door) {
    case 'end':
      return (door.closedAs === 'delivered' || door.closedAs === 'discarded') &&
        (door.reason === undefined || str('reason'))
        ? null
        : 'BAD_ARGS: end needs closedAs (delivered | discarded) and an optional string reason'
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
      { ok: true; mission: Mission; log: string; deduped?: true } | { ok: false; error: string }
    > => {
      const loaded = await loadMission(root, missionId)
      if (!loaded.ok) return { ok: false, error: loaded.error }
      try {
        const at = now()
        const mission = applyDoor(door as MissionDoor, loaded.mission, at)
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
          doorLogEntry(door as MissionDoor, at)
        await atomicWriteFile(loaded.file, buildMissionFileContent(mission, log), 0o644)
        return { ok: true, mission, log }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
  if (!written.ok) return written
  // Ended: it leaves every surface — nothing to derive.
  if (written.mission.status === 'closed') return { ok: true, view: null }
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

/** Registers the renderer-facing channels. Called once from `src/main/index.ts`. */
export function registerMissionIpc(): void {
  ipcMain.handle('mission:list', async (_e, folders: unknown): Promise<MissionListResult> =>
    listMissionViews(Array.isArray(folders) ? (folders as string[]) : [])
  )
  ipcMain.handle('mission:operatorDoor', async (_e, door: unknown): Promise<MissionDoorResult> =>
    runOperatorDoor(door)
  )
}
