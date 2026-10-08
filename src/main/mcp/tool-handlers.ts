/**
 * T120: the ACTUATION half of every MCP verb — one handler function per op,
 * the body that used to live in a `server.ts` `runRead`/`runMutation` `case`.
 * This is the SHELL layer for the catalog (Electron/fs/renderer-bridge/git —
 * excluded from `vitest.config.mts` coverage exactly like `server.ts`,
 * `roadmap-ipc.ts`, `worktree-ipc.ts`): `tool-catalog.ts` stays framework-free
 * (ADR-0001) by declaring the `handler` FIELD but never populating it; this
 * module populates it, once, in {@link WIRED_TOOLS} — the array `server.ts`
 * actually iterates to register + dispatch tools. `MCP_TOOLS` (the raw
 * catalog) never carries a handler.
 *
 * Adding a new verb: one entry in `tool-catalog.ts` (schema + gate fields) +
 * one function here, added to {@link TOOL_HANDLERS}. Nothing else changes.
 */

import * as path from 'node:path'
import * as os from 'node:os'
import { promises as fs, constants as fsConstants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { MCP_TOOLS, type McpOp, type McpToolDef } from './tool-catalog'
import { strField } from './plan-input'
import { asRecord, dispatchSucceeded, errorResult, steerError, textResult } from './tool-result'
import { runCreateSession, type CreateSessionDeps } from './create-session-core'
import type { DeadlineFlag } from './deadline'
import {
  attachSyntheticId,
  inFlightFolderFor,
  releaseIfCurrentHolder,
  releaseInFlight,
  tryReserveInFlight
} from './agent-inflight-registry'
import { getStashedApproval } from './approval-stash'
import { appendAudit } from './audit-log'
import type { ApprovalStatusResult } from './approval-status'
import type { ManifestCardDisclosure } from './confirm-core'
import type { CommandBridge } from '../command-bridge'
import type { FolderEntry } from '../folder-model'
import type { TaskState, FailureReason } from '../hook-state'
import { addTaskEventObserver, getTaskStates } from '../hook-bridge'
import { listPendingApprovals } from '../approval-resolver'
import { findPrsForWorktrees, type MissionPrJoin } from '../pr-stack'
import {
  ensureLinkCacheLoaded,
  forgetResolved,
  getLastKnown,
  rememberResolved
} from '../mission-link-cache'
import type { PrEntry } from '../pr-stack-core'
import { getScreenStates, getShellSessions } from '../detect/screen-detect'
import {
  liveSessionKeys,
  sessionOwnedByHarnu,
  spawnOriginForSession,
  waitForSessionReady
} from '../pty'
import { peerAddressForSession, sendPeerMessage } from '../messaging'
import {
  activityDescription,
  isMessageableOwner,
  MESSAGE_MAX_CHARS,
  messageAuditSummary
} from '../messaging-socket'
import { arm, disarm, listArmedSessionIds } from '../orchestrator-guard'
import { resolveAgentTarget } from './target-scope'
import {
  DATA_DIR,
  LEGACY_DATA_DIRS,
  dataDirAt,
  dataDirReady,
  mapLegacyDataPath,
  mkdirDataDir,
  repoRoot
} from '../data-dir'
import { hibernatedKeys, isHibernated } from '../hibernation'
import {
  applyAddCheck,
  buildMissionFileContent,
  CHECK_LABEL_MAX,
  createMissionFile,
  OPERATOR_VERIFIER,
  declaredEndHash,
  isStarted,
  missionScope,
  mintMissionId,
  missionsDir,
  parseMissionFile,
  readMissionLog,
  requestCloseRefusal,
  withMissionIdMintLock,
  MISSION_ID_RE,
  MISSION_STEP_CONTROLLED_FIELDS,
  type Blocker,
  type DeclaredEnd,
  type Mission,
  type MissionStep,
  type StepLink
} from '../mission-core'
import { probeGitMeta } from '../git-probe'
import { computeProgress, progressSteps, type MissionProgress } from '../mission-progress'
import { importLegacyGoalFile } from '../mission-migration'
import { atomicWriteFile } from './atomic-write'
import {
  buildFleetSnapshot,
  buildMissionFleetProjection,
  filterFleetSnapshot,
  type FleetFolderInput,
  type MissionChildState,
  type FleetSessionInput,
  type SessionStatus
} from './fleet-snapshot'
import { redactTranscript } from './transcript-redact'
import {
  collectWorktreeListing,
  createWorktree,
  adoptExistingFolder,
  removeGhostFolderFromSidebar
} from '../worktree-ipc'
import { toWorktreeListing } from '../worktree-core'
import { provisionErrorPayload, WorktreeProvisionError } from '../worktree-manifest'
import { readUserProjects } from '../user-projects'
import {
  appendMemoryEntry,
  queryMemory,
  readMemoryOverview,
  readMemoryPage,
  resolveMemoryLocation
} from './memory-store'
import { checkMarkdownReadAllowed, markdownKnownRoots } from '../markdown-read'
import { readAgentSpeechPrefs } from '../speech'
import { resolveSpeakGate, speakUnspokenHint, SPEAK_GATE_ERRORS } from '../speech-gate-core'
import { clampSpokenText, normalizeSpokenText } from '../speech-text'
import { recordSpeakAttempt } from './speak-rate-registry'
import { emptyCanvasDocument, type CanvasDocument } from '../canvas-core'
import { copyCanvasAssets } from '../canvas-assets'
import { readCanvasFile } from '../canvas-read'
import { writeCanvasFile } from '../canvas-write'
import {
  applyCanvasOps,
  canvasAssetsDir,
  canvasShapeCatalogAck,
  canvasVerbCode,
  planCanvasAssets,
  resolveCanvasWritePath
} from './canvas-ops'
import { resolveCreateSessionBoot } from './agent-boot'
import { getResolvedConfig } from '../claude-config'
import { type ClaudeBootConfig } from '../claude-args'
import { parsePlanMission } from './validate'
import { pokeManifestDrain } from '../manifest-drain'
import { isFolderDenied, isWithinRoot, normalizePath, resolveKnownFolder } from './permission-core'
import { scanFolders } from '../claude-reader'
import { createGrant } from './grant-registry'
import {
  evictObservedSessions,
  listInflightSessions,
  registerInflightSession,
  type InflightEntry
} from './inflight-session-registry'
import { clearInjectionEscalation, getInjectionEscalations } from './injection-escalation-registry'
import { pushShadowEntry } from '../responder-registry'
import {
  appendCardAssetEmbeds,
  buildCardAssetFilename,
  buildNewCardContent,
  checkParent,
  formatCardAssetEmbeds,
  isCardKind,
  isCardComplexity,
  isCardSubstrate,
  mintNextCardId,
  planCardMove,
  planCardSet,
  resolveCardAssetDestination,
  resolveCardAssetSource,
  resolveUniqueSlug,
  serializeByKey,
  shouldSeedTemplate,
  slugifyTitle,
  CARD_ASSET_MAX_BYTES,
  CARD_ASSET_MAX_PER_CALL,
  MANIFEST_BOOT_LABELS,
  type CardAssetSourceError,
  type CardComplexity,
  type CardKind,
  type CardMoveTarget,
  type CardSubstrate
} from '../roadmap-core'
import { claudeTmpRoot, confirmTmpImageSource } from '../claude-tmp-images'
import {
  archiveCardFile,
  buildManifestDisclosure,
  createCardFile,
  deleteCardFile,
  listCardIds,
  listCardSlugs,
  loadBoardTemplate,
  readCard,
  replaceCardBodyCore,
  resolveRoadmap,
  stampManifestApprovals,
  withCardIdMintLock,
  writeCardFields,
  type ManifestBuildError,
  type ManifestCardRequest,
  type ManifestCardResolved,
  type RoadmapWriteCode
} from '../roadmap-ipc'
import {
  createWorkerForAgent,
  deleteWorkerForAgent,
  isSchedulerNotReady,
  isWorkerNotFound,
  listWorkersForAgent,
  updateWorkerForAgent,
  type UpdateWorkerPatch
} from '../scheduler-shell'
import type { Effort, NotifyOn, WorkerMode } from '../scheduler-core'
import { getContainersService } from '../containers/containers-ipc'
import type { AgentActVerb } from '../containers/containers-wire'
import {
  blockedStackIds,
  containersActAck,
  containersListing,
  containersScopeRoots,
  dockerUnavailableRefusal
} from './containers-listing'
import { getGcService } from '../gc/gc-service-registry'
import { cleanupListing, planRelease } from './cleanup-listing'

/** Everything a handler may need beyond its own validated `input`. */
export interface ToolHandlerCtx {
  /** The resolved gate/target folder for a mutation; `''` if unresolved. */
  folder: string
  /** The full scanned folder list — the fan-out reads (get_fleet/get_session/list_worktrees) use this. */
  folders: FolderEntry[]
  /**
   * The live policy's BLOCKED folders (`Policy.denyFolders`). Drives the
   * `agentControllable` / `controllable` flags on the read disclosures — which post
   * reversal mean "not blocked", not "on an allowlist".
   */
  denyFolders: string[]
  /** The renderer command bridge; undefined before the server is fully wired. */
  bridge: CommandBridge | undefined
  /**
   * BUG-33 AC5: set by `server.ts`'s `actuate()` on EVERY call, `fired`
   * flips to `true` the instant the 120s tool deadline wins the race against
   * this handler. A verb whose shape allows it (a single commit point, no
   * side effect committed earlier in the same handler) checks this right
   * before that commit and aborts instead of applying — the response already
   * went out as `TOOL_TIMEOUT`, so committing now would be invisible to the
   * caller and, without the idempotency registry's dedup, indistinguishable
   * from the double-apply this card exists to close.
   */
  deadlineFlag?: DeadlineFlag
  /**
   * Present ONLY on the human-confirm actuation path (T61/T104) — see
   * `server.ts`'s `parkMutationConfirm`/`runOptsFor` for how these are built.
   */
  opts?: {
    worktreeInherit?: { optedOut: boolean }
    manifest?: {
      resolved: ManifestCardDisclosure[]
      selectedSlugs: string[]
      substrateOverrides: Record<string, string>
    }
  }
}

type Handler = (input: Record<string, unknown>, ctx: ToolHandlerCtx) => Promise<CallToolResult>

// ---- shared read-side helpers (get_fleet / get_session) --------------------

/**
 * T215: resolve `{ pid, socket }` for every LIVE session key, concurrently.
 *
 * Bounded by construction — it only ever probes keys with a live Harnu-owned
 * PTY (`liveSessionKeys()`), which is the fleet cap, not the number of sessions
 * on disk. Each probe is a `stat` plus a connect that is immediately closed;
 * nothing is memoized, so a recycled pid or a park→wake can never replay a
 * stale address into a later `message_session` call.
 */
async function resolvePeerAddresses(
  only?: string
): Promise<Map<string, { pid: number; socket: string }>> {
  const live = liveSessionKeys()
  // `get_session` asks about ONE id, so probing the whole fleet for it would be
  // a stat + connect per live session to answer a question about one of them.
  const keys = only === undefined ? [...live] : live.has(only) ? [only] : []
  const entries = await Promise.all(
    keys.map(async (key) => [key, await peerAddressForSession(key)] as const)
  )
  const out = new Map<string, { pid: number; socket: string }>()
  for (const [key, address] of entries) if (address) out.set(key, address)
  return out
}

/** Flatten scanned folders into the fleet-snapshot's redactable inputs. */
function toFleetInputs(
  folders: FolderEntry[],
  armedSessionIds: ReadonlySet<string>,
  parkedSessionIds: ReadonlySet<string>,
  peers: ReadonlyMap<string, { pid: number; socket: string }> = new Map()
): {
  folderInputs: FleetFolderInput[]
  sessionInputs: FleetSessionInput[]
} {
  const folderInputs: FleetFolderInput[] = folders.map((f) => {
    const out: FleetFolderInput = { path: f.path }
    if (f.repoId !== undefined) out.repoId = f.repoId
    if (f.gitBranch !== undefined) out.gitBranch = f.gitBranch
    if (f.isMainWorktree !== undefined) out.isMainWorktree = f.isMainWorktree
    return out
  })
  const sessionInputs: FleetSessionInput[] = []
  for (const f of folders) {
    for (const s of f.sessions) {
      sessionInputs.push({
        sessionId: s.sessionId,
        folderPath: s.projectPath,
        status: s.status as SessionStatus,
        isSidechain: s.isSidechain,
        modified: s.modified,
        ...(armedSessionIds.has(s.sessionId) ? { orchestrator: true } : {}),
        // T119: parked by Harnu to reclaim memory. Sourced from the hibernation registry,
        // NOT from PTY liveness — a parked session has no PTY, and `taskStateRecord()`
        // below filters by `liveSessionKeys()`, so liveness would erase it exactly where
        // an agent needs to read "parked, not dead" (spec §5.1).
        ...(parkedSessionIds.has(s.sessionId) ? { hibernated: true } : {}),
        // T215: the resolved cross-session address, only when a socket actually
        // answered — absence is "not addressable right now", never "dead".
        ...(peers.has(s.sessionId) ? { peer: peers.get(s.sessionId) } : {})
      })
    }
  }
  // Fold in the renderer-reported folder terminals (A2 W6.2) so a non-Claude
  // pane shows up cross-agent. Their screen-derived `taskState` is already in the
  // merged `taskStates` record; here we only contribute the redacted session row
  // (id + folder alias + active status — never a transcript or last line).
  for (const sh of getShellSessions()) {
    sessionInputs.push({
      sessionId: sh.sessionId,
      folderPath: sh.folderPath,
      status: 'active',
      isSidechain: false,
      modified: sh.modified
    })
  }
  return { folderInputs, sessionInputs }
}

/**
 * Project the in-flight registry's entries (BUG-30) into the redactable
 * `FleetSessionInput` shape `buildFleetSnapshot` merges in as `inflightAgentSessions`.
 * A dispatched-but-not-yet-observed synthetic has no real `status`/`isSidechain`
 * yet, so it is rendered as a freshly `active` session, `modified` at its
 * `createdAt` — the snapshot's own dedupe (disk row wins) supersedes this the
 * moment the real session lands.
 */
function inflightToFleetInputs(entries: readonly InflightEntry[]): FleetSessionInput[] {
  return entries.map((e) => ({
    sessionId: e.syntheticId,
    folderPath: e.folderPath,
    status: 'active' as SessionStatus,
    isSidechain: false,
    modified: new Date(e.createdAt).toISOString()
  }))
}

/**
 * BUG-58: for every BUG-30 registration `evictObservedSessions` just resolved
 * (materialized late, or reaped past the TTL), release the matching BUG-33
 * per-folder single-occupancy reservation — the ownership `runCreateSession`
 * hands off instead of releasing itself on a materialization timeout. A no-op
 * for entries whose reservation was already released on the ordinary
 * materialize-in-time path (`releaseIfCurrentHolder` guards on identity).
 *
 * Exported so `command-bridge-ipc.ts` can reuse this EXACT release path
 * (BUG-89 AC-1) for its own, earlier active-eviction trigger — the renderer's
 * `renderer:session-materialized` report — rather than growing a second,
 * divergent release.
 */
export function releaseResolvedInflightReservations(evicted: readonly InflightEntry[]): void {
  for (const entry of evicted) {
    releaseIfCurrentHolder(entry.folderPath, entry.syntheticId)
    // BUG-64: a resolved entry (materialized OR aged past the TTL) is done —
    // an escalation recorded against it must not keep reporting `failed`
    // forever for an id nothing will ever query again this way.
    clearInjectionEscalation(entry.syntheticId)
  }
}

/**
 * The unified per-session task-state map for the snapshot (`taskStates` shape):
 * the screen-derived states (A2 — folder terminals running codex/aider/…) merged
 * UNDER the hook FSM (the hook is authoritative on the impossible id overlap),
 * with a renderer-reported delivery escalation (BUG-64) folded in last — it is
 * the only source for an id that never reaches a real Claude Code hook at all
 * (a synthetic sitting on an unresolved first-run prompt), so there is nothing
 * for it to lose a conflict against.
 */
function taskStateRecord(): Record<string, TaskState> {
  const out: Record<string, TaskState> = {}
  for (const [id, state] of getScreenStates()) out[id] = state // screen already prunes on detach
  // Hook FSM: only disclose a state whose session still has a live PTY (T13/BUG-1
  // backstop). A killed/closed session's stale `working`/`needs-input` is filtered
  // out — including the pre-migration race the exit-prune alone can't reach.
  const live = liveSessionKeys()
  for (const [id, state] of getTaskStates()) if (live.has(id)) out[id] = state // hook FSM wins on overlap
  for (const [id] of getInjectionEscalations()) out[id] = 'failed'
  return out
}

/**
 * Why a session's `taskState` reads `'failed'` (BUG-64) — today, exclusively
 * the renderer-reported injection-escalation registry. A genuinely hook-driven
 * `StopFailure` reason (`rate_limit`/`overloaded`/`billing_error`) is folded
 * into `hook-bridge.ts`'s own task-state map without its classified reason
 * ever leaving that module, so it is out of scope here — adding that is a
 * separate, unrelated widening of the MCP disclosure contract.
 */
function failureReasonRecord(): Record<string, FailureReason> {
  const out: Record<string, FailureReason> = {}
  for (const [id, entry] of getInjectionEscalations()) out[id] = entry.reason
  return out
}

// ---- read handlers -----------------------------------------------------------

const getApprovalHandler: Handler = async (args) => {
  // T44 S4: poll a parked async approval by id. No folders/git needed.
  const approvalId = strField(args, 'approvalId') ?? ''
  const rec = getStashedApproval(approvalId)
  if (!rec) return textResult({ status: 'unknown' } satisfies ApprovalStatusResult)
  const out: ApprovalStatusResult = { status: rec.status }
  if (rec.result !== undefined) out.result = rec.result
  if (rec.reason !== undefined) out.reason = rec.reason
  return textResult(out)
}

const memoryReadHandler: Handler = async (args) => {
  // T79: project-memory reads. Gated by the allowlist (like get_session — memory
  // discloses project content); the memory is resolved to the repo's main
  // checkout so every worktree reads the SAME spotlight.
  const folder = strField(args, 'folder') ?? ''
  const { memoryDir } = await resolveMemoryLocation(folder)
  const page = strField(args, 'page')
  if (page) {
    const read = await readMemoryPage(memoryDir, page)
    if (!read.ok) return textResult({ ok: false, error: read.error, detail: read.detail })
    return textResult({ ok: true, page: read.page, content: read.content })
  }
  const overview = await readMemoryOverview(memoryDir)
  if (!overview) {
    return textResult({
      ok: true,
      memory: null,
      message:
        'No project memory yet for this repo. The first memory_append (e.g. page:decisions or page:hot) scaffolds `.harnu/memory/`.'
    })
  }
  return textResult({ ok: true, memory: overview })
}

const memoryQueryHandler: Handler = async (args) => {
  const folder = strField(args, 'folder') ?? ''
  const query = strField(args, 'query') ?? ''
  const { memoryDir } = await resolveMemoryLocation(folder)
  const { matches, truncated } = await queryMemory(memoryDir, query)
  return textResult({ ok: true, query, matches, truncated })
}

const listWorktreesHandler: Handler = async (args, ctx) => {
  // T44 S3b: list_worktrees reflects REAL `git worktree list` per known repo
  // (not the stale fleet snapshot — the wrong-today face of BUG-4). Scoped to
  // `folder` when given, else one representative path per distinct repo.
  const scope = strField(args, 'folder')
  const repoRoots = scope
    ? [scope]
    : [
        ...new Map(
          ctx.folders.filter((f) => f.repoId).map((f) => [f.repoId as string, f.path])
        ).values()
      ]
  const { entries, dirtyByPath } = await collectWorktreeListing(repoRoots)
  const redactPaths = true
  const rows = toWorktreeListing(entries, {
    denyFolders: ctx.denyFolders,
    dirtyByPath,
    redactPaths
  })
  // T191: `toWorktreeListing` sorts+filters `entries` internally (bare dropped,
  // sorted by path) — replicate that exact ordering here so index `i` of `rows`
  // lines up with `sortedPaths[i]`, letting us look up each row's `bornFrom`
  // without threading a path through the (out-of-scope) `WorktreeListingRow`
  // shape. A redacted row never exposes the mother's absolute path (only its
  // basename `bornFromAlias`), mirroring `alias`'s own path/basename split.
  const sortedPaths = entries
    .filter((e) => !e.bare)
    .map((e) => e.path)
    .sort()
  const projectsFile = await readUserProjects()
  const bornFromByPath = new Map(
    projectsFile.projects.filter((p) => p.bornFrom).map((p) => [p.path, p.bornFrom as string])
  )
  const worktrees = rows.map((row, i) => {
    const bornFrom = bornFromByPath.get(sortedPaths[i] ?? '')
    if (!bornFrom) return row
    return {
      ...row,
      bornFromAlias: path.basename(bornFrom),
      ...(redactPaths ? {} : { bornFrom })
    }
  })
  return textResult({ worktrees })
}

const getSessionHandler: Handler = async (args, ctx) => {
  const armedSessionIds = new Set(await listArmedSessionIds())
  const parkedSessionIds = hibernatedKeys()
  const { folderInputs, sessionInputs } = toFleetInputs(
    ctx.folders,
    armedSessionIds,
    parkedSessionIds,
    await resolvePeerAddresses(strField(args, 'sessionId') ?? '')
  )
  // BUG-30 D5: disk-appearance eviction, as a side effect of this same read —
  // any in-flight entry whose syntheticId now has a real disk row is dropped.
  // BUG-58: also release the matching per-folder reservation for anything
  // this evicts (materialized late or reaped past the TTL).
  releaseResolvedInflightReservations(evictObservedSessions(sessionInputs.map((s) => s.sessionId)))
  const taskStates = taskStateRecord()
  const sessionId = strField(args, 'sessionId') ?? ''
  const one = sessionInputs.filter((s) => s.sessionId === sessionId)
  const inflightAgentSessions = inflightToFleetInputs(listInflightSessions()).filter(
    (s) => s.sessionId === sessionId
  )
  if (one.length === 0 && inflightAgentSessions.length === 0) {
    // This card (AC5): a `create_session` in flight for `sessionId` (its
    // syntheticId) is genuinely still pending, not gone — `SESSION_NOT_FOUND`
    // is ambiguous between "never happened" and "still coming", and that
    // ambiguity is what drives the retry storms this card exists to end.
    // Falls back to the per-folder in-flight registry (BUG-33) for the sliver
    // of time before BUG-30's registry has recorded the dispatch.
    const inFlightFolder = inFlightFolderFor(sessionId)
    if (inFlightFolder) {
      return textResult({
        session: { sessionId, status: 'spawning', folderAlias: path.basename(inFlightFolder) },
        preview: ''
      })
    }
    return errorResult('SESSION_NOT_FOUND')
  }
  const snap = buildFleetSnapshot(
    {
      folders: folderInputs,
      sessions: one,
      taskStates,
      failureReasons: failureReasonRecord(),
      inflightAgentSessions
    },
    { redactPaths: true, denyFolders: ctx.denyFolders, home: os.homedir() }
  )
  // Best-effort transcript scrub over the only text we surface (first prompt +
  // summary). Never the raw PTY bytes — those are never projected.
  const found = ctx.folders.flatMap((f) => f.sessions).find((s) => s.sessionId === sessionId)
  const raw = found ? [found.firstPrompt, found.summary].filter(Boolean).join('\n') : ''
  const preview = redactTranscript(raw, { home: os.homedir() }).text
  return textResult({ session: snap.sessions[0] ?? null, preview })
}

const getFleetHandler: Handler = async (args, ctx) => {
  const armedSessionIds = new Set(await listArmedSessionIds())
  const parkedSessionIds = hibernatedKeys()
  const { folderInputs, sessionInputs } = toFleetInputs(
    ctx.folders,
    armedSessionIds,
    parkedSessionIds,
    await resolvePeerAddresses()
  )
  // BUG-30 D5: disk-appearance eviction, as a side effect of this same read.
  // BUG-58: also release the matching per-folder reservation for anything
  // this evicts (materialized late or reaped past the TTL).
  releaseResolvedInflightReservations(evictObservedSessions(sessionInputs.map((s) => s.sessionId)))
  const taskStates = taskStateRecord()
  const inflightAgentSessions = inflightToFleetInputs(listInflightSessions())
  // get_fleet: the bounded, filtered fleet board (T44 S3a — BUG-4, no more
  // 67k-char firehose).
  const snap = buildFleetSnapshot(
    {
      folders: folderInputs,
      sessions: sessionInputs,
      taskStates,
      failureReasons: failureReasonRecord(),
      inflightAgentSessions
    },
    { redactPaths: true, denyFolders: ctx.denyFolders, home: os.homedir() }
  )
  const activeOnly = args.activeOnly === true
  const sinceMinutes = typeof args.sinceMinutes === 'number' ? args.sinceMinutes : undefined
  const limit = typeof args.limit === 'number' ? args.limit : undefined
  return textResult(filterFleetSnapshot(snap, { activeOnly, sinceMinutes, limit, now: Date.now() }))
}

// ---- T96 board-verb anti-runaway rate cap (per folder, per day) -------------

/**
 * `create_card`/`update_card`/`move_card`/`archive_card`/`delete_card` writes
 * allowed per BOARD (folder) per UTC day (T96 amendment A2 — per-session is
 * impossible: the shared-loopback MCP transport has no per-session identity).
 * High on purpose (§2): a loop-abandon backstop, not day-to-day friction.
 */
const BOARD_RATE_LIMIT_PER_DAY = 300

interface BoardRateCounter {
  day: string
  count: number
}
const boardWriteCounters = new Map<string, BoardRateCounter>()

/** Today's UTC date key (`YYYY-MM-DD`) — the rate window boundary. */
function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * Count one board write against `folder`'s daily cap, resetting the counter on
 * a new UTC day. Returns the counter AFTER incrementing so the steering message
 * can echo it — or `null` when the cap is already spent (the write must not
 * proceed; the caller does not increment past the cap).
 */
function takeBoardRateSlot(folder: string, now: number): number | null {
  const day = utcDayKey(now)
  const existing = boardWriteCounters.get(folder)
  const current = existing && existing.day === day ? existing.count : 0
  if (current >= BOARD_RATE_LIMIT_PER_DAY) return null
  const next = current + 1
  boardWriteCounters.set(folder, { day, count: next })
  return next
}

/** T96: the dirigible board-write-cap message, naming the counter (§2 anti-runaway). */
function boardRateLimitMessage(): string {
  return `BOARD_RATE_LIMIT: this board already made ${BOARD_RATE_LIMIT_PER_DAY} agent writes today (create_card/update_card/move_card/archive_card/delete_card combined) — the cap resets at UTC midnight. It's a loop-abandon backstop, not a normal ceiling; ask the operator if the board genuinely needs more today.`
}

/**
 * T148: shared refusal for `archive_card`/`delete_card` on an `in-progress`
 * card — its bound session keeps running either way, but pulling the card out
 * from under it mid-flight would lose the live record of the dispatch.
 */
function cardInProgressMessage(action: 'archiving' | 'deleting'): string {
  return `CARD_IN_PROGRESS: this card has a bound session — ask the operator to move it to Review before ${action} it.`
}

/** T96: render a `checkParent` refusal as a dirigible `create_card` error message. */
function parentCheckMessage(
  code: 'PARENT_NOT_FOUND' | 'PARENT_HAS_PARENT',
  parent: string
): string {
  return code === 'PARENT_NOT_FOUND'
    ? `PARENT_NOT_FOUND: no card "${parent}" exists on this board.`
    : `PARENT_HAS_PARENT: "${parent}" already has its own parent — cards nest ONE level deep only.`
}

/** T96: render a `planCardSet` refusal as a dirigible `update_card` error message. */
function cardSetErrorMessage(err: Exclude<ReturnType<typeof planCardSet>, { ok: true }>): string {
  switch (err.code) {
    case 'CARD_CLOSED':
      return 'CARD_CLOSED: this card is done — Done is immutable by verb; ask the operator to reopen it on the board if it needs more work.'
    case 'CONTROLLED_FIELD':
      return `CONTROLLED_FIELD: update_card cannot write ${err.fields.join(', ')} — status changes go through move_card (backlog|ready|review only); session/evidence/provenance/approved/approvedBodyHash are Harnu/human-owned channels (the last two are written ONLY by the manifest go — submit_manifest).`
    case 'UNKNOWN_FIELD':
      return `BAD_ARGS: unknown set field(s) ${err.fields.join(', ')} — editable fields are title/kind/complexity/parent/deps/substrate/priority/spec/prd/adr.`
    case 'SUBSTRATE_LOCKED':
      return 'SUBSTRATE_LOCKED: substrate is immutable once a session is bound to this card (Q20).'
    case 'INVALID_VALUE':
      return `BAD_ARGS: ${err.field} — ${err.detail}`
    case 'EMPTY_SET':
      return 'BAD_ARGS: set must contain at least one field.'
  }
}

// ---- board-verb screenshot attachment (T-screenshots) ------------------------

/** T-screenshots: render a `resolveCardAssetSource` refusal as a dirigible error. */
function cardAssetSourceErrorMessage(code: CardAssetSourceError, raw: string): string {
  return code === 'SOURCE_NOT_IMAGE'
    ? `BAD_ARGS: image "${raw}" is not a recognized image type (png/jpg/jpeg/gif/webp/bmp/svg/ico).`
    : `BAD_ARGS: image "${raw}" must be under ~/.claude/image-cache/, a Claude <tmpdir>/claude-<uid>/<slug>/<session>/images/<n>.png, or inside this repo folder — a path elsewhere on the machine is refused.`
}

/**
 * Validate + copy `rawImages` into `<memoryDir>/assets/`, naming each file
 * `<slug>-<n><ext>` (n starting at 1, retried past any existing file so a
 * later attach never overwrites an earlier one). All I/O — the source jail
 * itself is the pure `resolveCardAssetSource` (roadmap-core.ts); this only
 * adds what needs fs (existence, size, the exclusive copy). Validates every
 * source BEFORE copying any of them, so a bad image never leaves a partial
 * attach on disk.
 */
async function attachCardAssets(
  memoryDir: string,
  folder: string,
  slug: string,
  rawImages: string[]
): Promise<{ ok: true; filenames: string[] } | { ok: false; message: string }> {
  if (rawImages.length > CARD_ASSET_MAX_PER_CALL) {
    return { ok: false, message: `BAD_ARGS: at most ${CARD_ASSET_MAX_PER_CALL} images per call.` }
  }
  const resolved: { path: string; ext: string; raw: string }[] = []
  for (const raw of rawImages) {
    const src = resolveCardAssetSource(raw, os.homedir(), folder, claudeTmpRoot(os.tmpdir()))
    if (!src.ok) return { ok: false, message: cardAssetSourceErrorMessage(src.code, raw) }
    // A Claude tmp-root source is read from its realpath, after the symlink
    // check — the root is shared with every session's scratchpad (BUG-149).
    let readPath = src.path
    if (src.tmpRoot) {
      const real = await confirmTmpImageSource(src.path, src.tmpRoot)
      if (real === null)
        return { ok: false, message: cardAssetSourceErrorMessage('SOURCE_NOT_ALLOWED', raw) }
      readPath = real
    }
    let size: number
    try {
      const st = await fs.stat(readPath)
      if (!st.isFile()) throw new Error('not a file')
      size = st.size
    } catch {
      return { ok: false, message: `SOURCE_NOT_FOUND: image "${raw}" does not exist on disk.` }
    }
    if (size > CARD_ASSET_MAX_BYTES) {
      return {
        ok: false,
        message: `IMAGE_TOO_LARGE: image "${raw}" is ${size} bytes — cap is ${CARD_ASSET_MAX_BYTES} bytes (~2 MB).`
      }
    }
    resolved.push({ path: readPath, ext: src.ext, raw })
  }

  const assetsDir = path.join(memoryDir, 'assets')
  await mkdirDataDir(assetsDir)

  const filenames: string[] = []
  let cursor = 1
  for (const { path: srcPath, ext, raw } of resolved) {
    let copied = false
    for (let attempt = 0; attempt < 1000 && !copied; attempt++) {
      const filename = buildCardAssetFilename(slug, cursor, ext)
      const dest = resolveCardAssetDestination(assetsDir, filename)
      if (!dest) return { ok: false, message: `WRITE_FAILED: could not place image "${raw}".` }
      try {
        await fs.copyFile(srcPath, dest, fsConstants.COPYFILE_EXCL)
        filenames.push(filename)
        copied = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          cursor++
          continue
        }
        return { ok: false, message: `WRITE_FAILED: could not copy image "${raw}".` }
      }
    }
    cursor++
    if (!copied) {
      return {
        ok: false,
        message: `WRITE_FAILED: could not place image "${raw}" (too many collisions).`
      }
    }
  }
  return { ok: true, filenames }
}

// ---- mutation handlers --------------------------------------------------------

/**
 * 2026-07-13 agent-pane-routing design — routing fix, second (hidden) cause.
 * `ctx.folder` is the RAW gate-anchor string the agent supplied; it is only
 * ever normalized inside the permission gate (`normalizePath`,
 * `plan-tool-call.ts`), never before it becomes a pane-routing key. Resolve
 * it against the KNOWN folders (`ctx.folders`, the live scan) via the shared
 * pure core (`resolveKnownFolder`, unit-tested in isolation) and route by
 * the matching `FolderEntry.path` instead — `undefined` when nothing
 * matches, so the caller can steer instead of silently no-opping.
 */
function resolvePaneFolder(ctx: ToolHandlerCtx): string | undefined {
  return resolveKnownFolder(
    ctx.folder,
    ctx.folders.map((f) => f.path)
  )
}

/**
 * Poll cadence/budget for confirming a just-adopted folder is visible to the
 * renderer's store before retrying `session.create`. Bounded so a renderer
 * that never catches up (no window, HMR reload, teardown mid-flight) fails
 * deterministically instead of hanging — but each attempt is a REAL correlated
 * dispatch through the command bridge, not a blind sleep: it observes the
 * renderer's actual current state, so the loop exits the instant the
 * debounced reload (`RELOAD_DEBOUNCE_MS` in `stores/sessions.ts`, ~250ms)
 * lands, rather than gambling on a single fixed delay.
 */
const FOLDER_ADOPT_POLL_MS = 150
const FOLDER_ADOPT_BUDGET_MS = 4_000

/**
 * 2026-07-14: the permission gate had already allowed this `create_session`
 * call (the free-by-default reversal killed the folder allowlist) — but the
 * renderer's `folderExists` check is a SEPARATE, independent existence gate
 * against its own store, and treating an unknown folder as a hard refusal
 * there reintroduced the exact idle-machine failure the reversal was meant to
 * kill: a git worktree made outside Harnu, or a folder an agent just
 * `create_worktree`'d moments earlier, dead-ended here even though the agent
 * had every right to act in it (`FOLDER_NOT_FOUND` standing in for the old
 * `FOLDER_NOT_ALLOWED`).
 *
 * Adopts the folder (persists to `projects.json`, broadcasts
 * `folders:adopted`) then polls the SAME correlated dispatch — a real round
 * trip through the renderer each time — until it reflects the adoption or the
 * budget is exhausted. A path that genuinely doesn't exist on disk (or isn't a
 * directory) is a real, distinct failure, never disguised as "Harnu hadn't
 * heard of it".
 */
async function ensureFolderThenRetryCreate(
  folder: string,
  payload: Record<string, unknown>,
  bridge: CommandBridge
): Promise<unknown> {
  try {
    await adoptExistingFolder(folder)
  } catch {
    return { error: 'FOLDER_MISSING' }
  }

  const deadline = Date.now() + FOLDER_ADOPT_BUDGET_MS
  let last: unknown = { error: 'FOLDER_NOT_FOUND' }
  while (Date.now() < deadline) {
    last = await bridge.dispatch('session.create', payload)
    if (asRecord(last).error !== 'FOLDER_NOT_FOUND') return last
    await new Promise((resolve) => setTimeout(resolve, FOLDER_ADOPT_POLL_MS))
  }
  return { error: 'FOLDER_ADOPT_TIMEOUT' }
}

const createSessionHandler: Handler = async (args, ctx) => {
  if (!ctx.bridge) return errorResult('NO_BRIDGE')
  const bridge = ctx.bridge
  const folder = ctx.folder
  const payload: Record<string, unknown> = { folder }
  const prePrompt = strField(args, 'prePrompt')
  if (prePrompt) payload.prePrompt = prePrompt
  // T33-A′: forward ONLY the allowlisted capacity knobs (model/effort) — never
  // an arbitrary boot flag (matches agent-boot's ALLOWED_KEYS). handleToolCall
  // already validated + normalized args.bootOverride (T63), so a malformed
  // override never reaches here — it returned INVALID_BOOT_OVERRIDE upstream.
  const boot = asRecord(args.bootOverride)
  const model = strField(boot, 'model')
  const effort = strField(boot, 'effort')
  const override: ClaudeBootConfig = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
  // T76/BUG-18: derive the FORWARD payload and the ACK echo from the SAME
  // override object, so the echoed `effectiveModel`/`effectiveEffort` can never
  // drift from what is actually dispatched to the spawn (an ACK claiming haiku
  // while the session launched opus). `getResolvedConfig` supplies global ⊕ folder.
  const resolvedBoot = resolveCreateSessionBoot(override, await getResolvedConfig(folder))
  if (resolvedBoot.forward) payload.bootOverride = resolvedBoot.forward

  // This card (ADR-0003): `ok:true` must mean the session MATERIALIZED — a real
  // process AND a transcript on disk — not merely that the renderer accepted the
  // dispatch. `runCreateSession` (pure core) owns that decision; this shell only
  // supplies the electron/fs-bound collaborators (the bridge round trip + the
  // per-folder single-occupancy registry).
  const deps: CreateSessionDeps = {
    dispatchCreate: async (p) => {
      let result = await bridge.dispatch('session.create', p)
      if (asRecord(result).error === 'FOLDER_NOT_FOUND') {
        result = await ensureFolderThenRetryCreate(folder, p, bridge)
      }
      // BUG-30 D3: register ONLY on a successful dispatch — a failed one must
      // register nothing, or the registry re-creates the ok:true-but-no-session
      // lie. Registering here (as soon as the syntheticId is known, before
      // materialization is awaited below) is what makes the just-created
      // session visible to get_session/get_fleet immediately, even though
      // create_session's own ACK now blocks until materialization resolves.
      if (dispatchSucceeded(result)) {
        const rec = asRecord(result)
        const syntheticId = strField(rec, 'syntheticId')
        if (syntheticId) {
          const correlationId = strField(rec, 'correlationId')
          registerInflightSession({
            syntheticId,
            folderPath: folder,
            ...(correlationId ? { correlationId } : {})
          })
        }
      }
      return result
    },
    awaitMaterialization: (syntheticId, timeoutMs) =>
      bridge.awaitMaterialization(syntheticId, timeoutMs),
    tryReserve: (f) => tryReserveInFlight(f),
    attachSyntheticId: (f, syntheticId) => attachSyntheticId(f, syntheticId),
    release: (f) => releaseInFlight(f),
    deadlineFired: () => ctx.deadlineFlag?.fired === true
  }
  return runCreateSession(
    folder,
    payload,
    { effectiveModel: resolvedBoot.effectiveModel, effectiveEffort: resolvedBoot.effectiveEffort },
    deps
  )
}

const spawnTerminalHandler: Handler = async (_args, ctx) => {
  if (!ctx.bridge) return errorResult('NO_BRIDGE')
  const targetFolder = resolvePaneFolder(ctx)
  if (!targetFolder) return steerError('PANE_FOLDER_UNKNOWN', ctx.folder)
  const result = await ctx.bridge.dispatch('pane.split', {
    target: 'split',
    worktreePath: targetFolder,
    cwd: targetFolder,
    kind: 'shell'
  })
  return textResult({ ok: true, op: 'spawn_terminal', result })
}

const createWorktreeHandler: Handler = async (args, ctx) => {
  const branch = strField(args, 'branch')
  if (!branch) return errorResult('BAD_ARGS: branch is required')
  // This card: optional `base` forks the new branch from an explicit ref instead
  // of the remote default (BUG-26 stays fixed: absent → unchanged behavior).
  const base = strField(args, 'base')
  // T44 S2: optional `ref` checks out an existing local/remote branch (or
  // detaches if it's checked out elsewhere) instead of branching from `from:`.
  const ref = strField(args, 'ref')
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before
  // cutting a worktree nobody will read the ACK for. A genuine retry is
  // covered by the idempotency registry (server.ts actuate()), not this
  // per-verb guard.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  // T61: pass the disclosed-create inherit opt-out through to the actuator (only
  // present on the human-confirm path; the grant path leaves it undefined → no
  // birth marker, dynamicFolders scope only).
  // T191: `ctx.folder` doubles as the lineage origin — the only caller-identity
  // signal available (see docs/specs/T191-worktree-lineage-sidebar.md). Always
  // passed, independent of `inherit`; the guarded recording happens downstream.
  try {
    const result = await createWorktree(ctx.folder, branch, base, ref, undefined, {
      origin: ctx.folder,
      ...(ctx.opts?.worktreeInherit
        ? { inherit: { optedOut: ctx.opts.worktreeInherit.optedOut } }
        : {})
    })
    // T64/BUG-12: echo the base the worktree was actually cut from (the passed
    // folder's HEAD, not the main checkout's) + the branch, so the agent has
    // proprioception for stacked fan-out instead of a silently wrong base.
    return textResult({
      ok: true,
      op: 'create_worktree',
      path: result.path,
      base: result.base,
      branch: result.branch,
      // T191: the resolved lineage mother — absent when a recording guard
      // dropped the edge (e.g. this session's cwd IS the repo's main checkout).
      ...(result.bornFrom ? { bornFrom: result.bornFrom } : {}),
      // This card: surface non-fatal diagnostics (e.g. an explicit local base
      // behind its remote counterpart) — absent when there's nothing to say.
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      // BUG-40 §3.5 / BUG-50 absorbed: non-blocking — a branch or worktree
      // already embedding this card's slug. Warn only; the create already
      // succeeded above.
      ...(result.existingWork && result.existingWork.length > 0
        ? { existingWork: result.existingWork }
        : {})
    })
  } catch (err) {
    // BUG-28: a seed/setup/delegated-create failure is a STRUCTURED provision
    // error (stage/command/kind/binary/rolledBack/branchDeleted), not a bare
    // stderr string — return it as-is (isError:true) so an agent never has to
    // probe `list_worktrees` to learn whether the worktree still exists. Every
    // other create-time failure (bad branch, unsafe target, …) is unaffected.
    if (err instanceof WorktreeProvisionError) {
      return {
        content: [{ type: 'text', text: JSON.stringify(provisionErrorPayload(err)) }],
        isError: true
      }
    }
    throw err
  }
}

const adoptFolderHandler: Handler = async (_args, ctx) => {
  // No disk mutation — pins an existing folder into the sidebar (T34).
  await adoptExistingFolder(ctx.folder)
  return textResult({ ok: true, op: 'adopt_folder', path: ctx.folder })
}

const removeFolderHandler: Handler = async (_args, ctx) => {
  // BUG-56 — the ghost-cleanup verb (ADR-0016). No disk/git mutation: refuses
  // outright when `ctx.folder` still exists on disk.
  const result = await removeGhostFolderFromSidebar(ctx.folder)
  if (!result.ok) return errorResult(result.error)
  return textResult({ ok: true, op: 'remove_folder', ...result.removed })
}

const planMissionHandler: Handler = async (args) => {
  // T44 S5: mint a bounded capability grant after the ONE human approval.
  const parsed = parsePlanMission(args)
  if (!parsed.ok) return errorResult(`BAD_ARGS: ${parsed.detail}`)
  const { goal, folders: reqFolders, verbs, budget, ttlMinutes } = parsed.value
  // Containment: every granted folder must be inside a CURRENT known root
  // (invariant — a grant can never authorize outside the tracked repos).
  const home = os.homedir()
  const roots = (await scanFolders()).map((f) => f.path)
  const outside = reqFolders.filter(
    (f) => !roots.some((r) => isWithinRoot(normalizePath(f, home), normalizePath(r, home)))
  )
  if (outside.length > 0) {
    return errorResult(`grant folders outside known repos: ${outside.join(', ')}`)
  }
  const grant = createGrant({
    goal,
    folders: reqFolders,
    verbs,
    budget,
    ttlMinutes,
    homeDir: home
  })
  // BUG-43 (07-16 repro): a grant minted AFTER a manifest Allow must wake the
  // drain — stamped cards that fell to `no-grant` moments ago are now coverable.
  for (const f of reqFolders) pokeManifestDrain(f)
  return textResult({
    ok: true,
    op: 'plan_mission',
    grantId: grant.id,
    expiresAt: grant.expiresAt,
    budget,
    verbs,
    folders: reqFolders
  })
}

const memoryAppendHandler: Handler = async (args, ctx) => {
  // T79: serialized project-memory write. Body-append only (frontmatter/
  // status untouched); provenance is stamped SERVER-SIDE — `author` is
  // 'agent' because the caller is an MCP session (never trusted from args),
  // and `branch` is derived from the folder's git meta. The page/entry were
  // already validated (caps + anti-secret lint) at the gate.
  const page = strField(args, 'page')
  const entry = strField(args, 'entry')
  if (!page || !entry) return errorResult('BAD_ARGS: page and entry are required')
  const { memoryDir, branch, mode, checkout } = await resolveMemoryLocation(ctx.folder)
  const res = await appendMemoryEntry({
    memoryDir,
    page,
    entry,
    author: 'agent',
    ...(branch ? { branch } : {}),
    // T89: central storage seeds a `where.md` backlink to the source project.
    ...(mode === 'central' ? { backlink: { sourcePath: checkout } } : {}),
    now: Date.now()
  })
  if (!res.ok) return errorResult(`${res.error}: ${res.detail}`)
  return textResult({
    ok: true,
    op: 'memory_append',
    page: res.page,
    file: res.file,
    bytes: res.bytes
  })
}

const openFileHandler: Handler = async (args, ctx) => {
  // T74 S4 (broadened by Cluster G to any text file). Two-layer containment:
  // (1) the `folder` gate anchor was already allowlist-checked by
  // planToolCall above; (2) the file `path` is confined here to the live
  // known roots — the SAME policy the viewer's `markdown:read` re-enforces
  // when the pane loads (belt + suspenders). A path outside the roots
  // STEERS the agent (T44 S1) instead of opening a pane that would only
  // error. A binary or oversized file is no longer refused at this layer —
  // it opens the pane, same as a human's eye-icon click, and the pane
  // itself shows the refusal once it reads the content.
  if (!ctx.bridge) return errorResult('NO_BRIDGE')
  const rawPath = strField(args, 'path')
  if (!rawPath) return errorResult('BAD_ARGS: path is required')
  const gate = checkMarkdownReadAllowed(path.resolve(rawPath), await markdownKnownRoots())
  if (!gate.ok) {
    return steerError('MARKDOWN_OUTSIDE_ROOTS', rawPath)
  }
  // 2026-07-13 agent-pane-routing design: route by the CALLER's folder,
  // canonicalized against the known set (`resolvePaneFolder`) — never the
  // operator's live selection (that hijack lived in the renderer's
  // `command-dispatch.ts` and is gone) and never the raw, uncanonicalized
  // `ctx.folder` (that was the phantom-key trap). An unresolvable folder
  // steers instead of appending to a stack nobody renders.
  const targetFolder = resolvePaneFolder(ctx)
  if (!targetFolder) return steerError('PANE_FOLDER_UNKNOWN', ctx.folder)
  // Background-open (T78): the renderer's `pane.openMarkdown` appends the viewer
  // to the target worktree's stack HEADLESSLY — it never selects the session or
  // switches worktrees, so N grant-driven open_file calls can't yank the operator
  // (who may be in another session) around. dedup-by-filePath + the per-worktree
  // cap live in `addMarkdownHelper`, so grant×budget N never stacks N panes.
  const result = await ctx.bridge.dispatch('pane.openMarkdown', {
    worktreePath: targetFolder,
    filePath: rawPath
  })
  return textResult({ ok: true, op: 'open_file', path: rawPath, result })
}

// ---- draw_canvas (T218 U5) -------------------------------------------------

const drawCanvasHandler: Handler = async (args, ctx) => {
  // T218 U5 (spec §8). The SHELL: resolve + confine the path, read the current
  // document (or start an empty one), hand the ops to the PURE applier, copy
  // any images, write atomically, then open the pane. Every decision that can
  // be made without the disk is in `canvas-ops.ts`; every document-level rule
  // is U1's `validateCanvasDocument`, which the applier runs as its final gate.
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const rawPath = strField(args, 'path')
  // A worktree's board lives in its own `.harnu/out/`: bring its legacy `.capy/out/` across first.
  await dataDirReady(folder)

  // Rule 2 — the agent may only write under `.harnu/out/canvas/` or
  // `docs/canvas/`. Refused with a code, never clamped into an allowed dir.
  const target = resolveCanvasWritePath(folder, rawPath)
  if (!target.ok) return errorResult(`${target.code}: ${target.error}`)

  // The confined reader also re-checks containment against the LIVE known
  // roots — belt + suspenders with the folder gate the call already passed.
  // `not-found` is the ordinary first-call case, not a failure: a fresh
  // worktree has no board until something draws on it.
  const nowIso = new Date().toISOString()
  let doc: CanvasDocument
  const read = await readCanvasFile(target.path)
  if (read.ok) {
    doc = read.doc
  } else if (read.code === 'not-found') {
    doc = emptyCanvasDocument(nowIso)
  } else {
    return errorResult(`${canvasVerbCode(read.code)}: ${read.error}`)
  }

  // Images are validated (jail + extension + count) BEFORE any op is applied
  // and before any byte is copied (§4.6, §8.3 rule 11).
  const rawImages = Array.isArray(args.images) ? args.images : []
  const planned = planCanvasAssets(
    target.name,
    rawImages,
    os.homedir(),
    folder,
    claudeTmpRoot(os.tmpdir())
  )
  if (!planned.ok) return errorResult(`${planned.code}: ${planned.error}`)

  const applied = applyCanvasOps({
    doc,
    ops: args.ops,
    // Opaque, short and collision-retried: `n-7f3a` / `e-91cc` (§4.3). Random
    // rather than sequential so two concurrent sessions drawing on sibling
    // worktrees never mint the same id for different nodes.
    mintId: (prefix) => `${prefix}-${randomBytes(2).toString('hex')}`
  })
  if (!applied.ok) return errorResult(`${applied.code}: ${applied.error}`)

  let assetSrcs: string[] = []
  if (planned.assets.length > 0) {
    const copied = await copyCanvasAssets(canvasAssetsDir(target.path), target.name, planned.assets)
    if (!copied.ok) return errorResult(`${copied.code}: ${copied.message}`)
    assetSrcs = copied.srcs
  }

  const next: CanvasDocument = {
    ...applied.doc,
    meta: {
      ...applied.doc.meta,
      createdAt: applied.doc.meta.createdAt ?? nowIso,
      updatedAt: nowIso
    }
  }
  const written = await writeCanvasFile(target.path, next)
  if (!written.ok) return errorResult(`${canvasVerbCode(written.code)}: ${written.error}`)

  // §6.3 path 3: the verb opens the pane the same way `open_file` does —
  // headlessly, in the CALLER's folder, never stealing the operator's focus.
  // Best-effort: a drawing that landed on disk must not be reported as failed
  // because no renderer window was up to show it.
  let opened = false
  const wantsOpen = args.open === undefined ? true : args.open === true
  if (wantsOpen && ctx.bridge) {
    const paneFolder = resolvePaneFolder(ctx)
    if (paneFolder) {
      const res = await ctx.bridge
        .dispatch('pane.openMarkdown', { worktreePath: paneFolder, filePath: target.path })
        .catch(() => ({ error: 'DISPATCH_FAILED' }))
      opened = dispatchSucceeded(res)
    }
  }

  return textResult({
    ok: true,
    op: 'draw_canvas',
    path: target.path,
    nodeCount: next.nodes.length,
    edgeCount: next.edges.length,
    applied: applied.applied,
    ...(assetSrcs.length > 0 ? { assets: assetSrcs } : {}),
    opened,
    shapes: canvasShapeCatalogAck()
  })
}

const NOTIFICATION_KINDS = new Set(['info', 'success', 'warning', 'danger'])

const notifyHandler: Handler = async (args, ctx) => {
  // T116: appends one row to the notification history (`stores/notifications.ts`)
  // via the SAME renderer command-bridge round-trip `open_file` uses — no new
  // transport, just a new `notify.push` command the router dispatches to the
  // real store action.
  if (!ctx.bridge) return errorResult('NO_BRIDGE')
  const title = strField(args, 'title')
  if (!title) return errorResult('BAD_ARGS: title is required')
  const description = strField(args, 'description')
  const kindArg = strField(args, 'kind')
  const kind = kindArg && NOTIFICATION_KINDS.has(kindArg) ? kindArg : 'info'
  const sessionId = strField(args, 'sessionId')

  const result = await ctx.bridge.dispatch('notify.push', {
    folderPath: ctx.folder,
    title,
    ...(description ? { description } : {}),
    kind,
    ...(sessionId ? { sessionId } : {})
  })
  return textResult({ ok: true, op: 'notify', result })
}

/**
 * T238 `speak` — say one line out loud, and leave nothing behind.
 *
 * The contrast with `notifyHandler` above is the verb's whole reason to exist:
 * this one dispatches `speech.say`, NEVER `notify.push`. No Activity row, no
 * toast, no history — an utterance is heard once or not at all.
 *
 * Four gates, in this order, and the order matters:
 *  1. the operator's FOLDER BLOCK, which outranks every voice setting (the base
 *     MCP gate already denied a blocked folder before this handler ran; this is
 *     the belt-and-braces half, so voice can never become a back door into a
 *     folder the operator closed);
 *  2. the VOICE CASCADE (`folder ?? global ?? false`) — refusing with a code that
 *     names WHICH switch is off, so the agent asks for the right thing;
 *  3. the RATE LIMIT, per session (per folder when the caller gave no id);
 *  4. the FOCUS RULE, which is the renderer's to apply — it is the only side that
 *     knows what the operator is looking at — and comes back in the ACK as
 *     `spoken:false, reason:'focused'`, a success, not a failure.
 */
const speakHandler: Handler = async (args, ctx) => {
  if (!ctx.bridge) return errorResult('NO_BRIDGE')

  // AC-4: over-cap text is TRUNCATED at a word boundary, never rejected. Only an
  // utterance that is empty once normalised is a bad call. `flat` is the same
  // normalisation with no cap, so the ACK can report truthfully whether anything
  // was actually dropped.
  const flat = normalizeSpokenText(strField(args, 'text') ?? '')
  const text = clampSpokenText(flat)
  if (!text) return errorResult('BAD_ARGS: text is required')
  const sessionId = strField(args, 'sessionId')

  // An unresolved gate folder must never fall through to `path.resolve('')` —
  // that is the app's cwd, and the gate would then answer for a folder nobody
  // asked about. The catalog + gate validator both require an absolute `folder`,
  // so this is unreachable in practice and refuses rather than guessing if it is.
  if (!ctx.folder) return errorResult('BAD_ARGS: folder is required')
  const home = os.homedir()
  const folder = normalizePath(ctx.folder, home)
  const blocked = isFolderDenied(ctx.folder, ctx.denyFolders, home)
  const gate = resolveSpeakGate(await readAgentSpeechPrefs(), folder, blocked)
  if (gate !== 'allowed') return steerError(SPEAK_GATE_ERRORS[gate], ctx.folder)

  const rate = recordSpeakAttempt(sessionId ?? folder, Date.now())
  if (!rate.allowed) return steerError('SPEAK_RATE_LIMITED', ctx.folder)

  const result = await ctx.bridge
    .dispatch('speech.say', { folderPath: ctx.folder, text, ...(sessionId ? { sessionId } : {}) })
    .catch(() => ({ error: 'DISPATCH_FAILED' }))

  // `ok:true` must mean the effect happened, so a renderer-side failure is
  // reported as a FAILURE and never nested under a cheerful ACK
  // (docs/lessons/code-patterns/004-ok-true-ack-must-not-carry-a-nested-error.md).
  if (!dispatchSucceeded(result)) {
    return errorResult(`SPEAK_FAILED: ${String(asRecord(result).error ?? 'unknown')}`)
  }

  const ack = asRecord(result)
  // `spoken:false` here is NOT a failure — it is the focus rule (or the operator's
  // mute) correctly dropping an utterance, which is why `reason` rides alongside
  // instead of an error: an agent that retried this would say a line the operator
  // can already read.
  const reason = typeof ack.reason === 'string' ? ack.reason : undefined
  const hint = speakUnspokenHint(reason)
  return textResult({
    ok: true,
    op: 'speak',
    spoken: ack.spoken === true,
    ...(reason ? { reason } : {}),
    // `engine-off` in particular: voice has a SECOND switch this verb's gate does
    // not control, so without this the agent would read "allowed, spoken:false"
    // and have no idea what to ask for.
    ...(hint ? { hint } : {}),
    // Reported so an agent can see its line was shortened and stop writing
    // paragraphs at the room, rather than discovering it by ear.
    truncated: text.length < flat.length,
    chars: text.length,
    rateRemaining: rate.remaining
  })
}

const createCardHandler: Handler = async (args, ctx) => {
  // T96 §1.1: born backlog always, provenance stamped server-side WITHOUT a
  // sessionId (A1 — the shared-loopback MCP transport has no per-session
  // identity), template seeded when body is empty/short and kind is given.
  const folder = ctx.folder
  const title = strField(args, 'title')
  if (!title) return errorResult('BAD_ARGS: title is required')
  const rawBody = strField(args, 'body') ?? ''
  const kindArg = strField(args, 'kind')
  const kind: CardKind | undefined = kindArg && isCardKind(kindArg) ? kindArg : undefined
  const complexityArg = strField(args, 'complexity')
  const complexity: CardComplexity | undefined =
    complexityArg && isCardComplexity(complexityArg) ? complexityArg : undefined
  const substrateArg = strField(args, 'substrate')
  const substrate: CardSubstrate | undefined =
    substrateArg && isCardSubstrate(substrateArg) ? substrateArg : undefined
  const parent = strField(args, 'parent')
  const priority = strField(args, 'priority')
  const spec = strField(args, 'spec')
  const deps = Array.isArray(args.deps)
    ? args.deps.filter((d): d is string => typeof d === 'string')
    : undefined
  const images = Array.isArray(args.images)
    ? args.images.filter((i): i is string => typeof i === 'string')
    : undefined

  const { repoKey } = await resolveRoadmap(folder)
  if (takeBoardRateSlot(repoKey, Date.now()) === null) {
    return errorResult(boardRateLimitMessage())
  }

  if (parent) {
    const parentResult = await readCard(folder, parent)
    const check = checkParent(parentResult.ok ? parentResult.card : null)
    if (!check.ok) return errorResult(parentCheckMessage(check.code, parent))
  }

  const seedTemplate = shouldSeedTemplate(rawBody, kind)
  const templateBody = seedTemplate && kind ? await loadBoardTemplate(kind) : null
  const body = templateBody ?? rawBody
  const seededTemplate = templateBody !== null

  const { branch, memoryDir } = await resolveMemoryLocation(folder)

  // Mint (scan existing ids → T<n>/BUG-<n>) and write are one critical
  // section, serialized per repo — otherwise two racing calls could both scan
  // the same max and mint the same id (different filenames, so `createCardFile`'s
  // `wx` exclusive write can't catch it). Screenshot attachment (T-screenshots)
  // happens INSIDE this same section too — the destination filename is
  // `<slug>-<n><ext>`, and the slug only exists once minted.
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before
  // minting + writing a card nobody will read the ACK for.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')

  type MintedCard =
    | { ok: true; file: string; slug: string; id: string }
    | { ok: false; code: RoadmapWriteCode; message?: string }
  const minted: MintedCard = await withCardIdMintLock(repoKey, async () => {
    const [existingIds, existingSlugs] = await Promise.all([
      listCardIds(folder),
      listCardSlugs(folder).then((s) => new Set(s))
    ])
    const id = mintNextCardId(existingIds, kind)
    const slug = resolveUniqueSlug(`${id}-${slugifyTitle(title)}`, existingSlugs)

    let finalBody = body
    if (images && images.length > 0) {
      const attached = await attachCardAssets(memoryDir, folder, slug, images)
      if (!attached.ok) return { ok: false, code: 'bad-args', message: attached.message }
      finalBody = appendCardAssetEmbeds(body, attached.filenames)
    }

    const content = buildNewCardContent({
      slug,
      id,
      title,
      body: finalBody,
      ...(kind ? { kind } : {}),
      ...(complexity ? { complexity } : {}),
      ...(parent ? { parent } : {}),
      ...(deps && deps.length > 0 ? { deps } : {}),
      ...(substrate ? { substrate } : {}),
      ...(priority ? { priority } : {}),
      ...(spec ? { spec } : {}),
      provenance: { author: 'agent', at: new Date().toISOString(), ...(branch ? { branch } : {}) }
    })
    const created = await createCardFile(folder, slug, content)
    return created.ok ? { ok: true, file: created.file, slug, id } : created
  })

  if (!minted.ok) {
    return errorResult(minted.message ?? `WRITE_FAILED: could not create card "${title}"`)
  }
  return textResult({
    ok: true,
    op: 'create_card',
    id: minted.id,
    slug: minted.slug,
    path: minted.file,
    column: 'backlog',
    seededTemplate
  })
}

const updateCardHandler: Handler = async (args, ctx) => {
  // T96 §1.2: `set` is field-level validated by the pure `planCardSet`
  // (controlled fields refused, substrate locked post-dispatch, closed cards
  // immutable); `appendBody` reuses the EXACT `memory_append` write (a
  // provenance-stamped body append to `roadmap/<slug>`).
  const folder = ctx.folder
  const slug = strField(args, 'slug')
  if (!slug) return errorResult('BAD_ARGS: slug is required')

  const { repoKey } = await resolveRoadmap(folder)
  if (takeBoardRateSlot(repoKey, Date.now()) === null) {
    return errorResult(boardRateLimitMessage())
  }

  const found = await readCard(folder, slug)
  if (!found.ok) {
    return errorResult(
      found.code === 'bad-args' ? 'BAD_ARGS: invalid slug' : 'NOT_FOUND: card not found'
    )
  }
  const card = found.card
  if (card.status === 'done')
    return errorResult(cardSetErrorMessage({ ok: false, code: 'CARD_CLOSED' }))

  const rawSet = args.set
  const set =
    typeof rawSet === 'object' && rawSet !== null ? (rawSet as Record<string, unknown>) : undefined
  const appendBody = strField(args, 'appendBody')
  // BUG-79: `replaceBody`'s schema deliberately allows an empty string (clears
  // the body) — `strField` folds `''` into "absent", which would make an
  // explicit empty replaceBody indistinguishable from not passing it at all.
  const replaceBody = typeof args.replaceBody === 'string' ? args.replaceBody : undefined
  const rawImages = Array.isArray(args.images)
    ? args.images.filter((i): i is string => typeof i === 'string')
    : undefined
  // An explicit `images: []` is truthy but carries nothing to attach — treat it
  // the same as "not provided" for the required-one-of check below.
  const images = rawImages && rawImages.length > 0 ? rawImages : undefined
  if (!set && !appendBody && replaceBody === undefined && !images)
    return errorResult('BAD_ARGS: at least one of set/appendBody/replaceBody/images is required')

  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before
  // the first of this verb's (possibly several) writes nobody will read the
  // ACK for.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')

  const changed: string[] = []
  // T104 §2.3: editing title/spec/body invalidates a manifest stamp — but the
  // edit still succeeds (zero friction, §2.3 "permitidos"). The gate re-hashes
  // from disk at DISPATCH time regardless, so this flag is purely an ACK
  // courtesy warning, never a write-time refusal.
  let touchesFingerprint = false
  if (set) {
    const plan = planCardSet({ set, hasSession: Boolean(card.session), isClosed: false })
    if (!plan.ok) return errorResult(cardSetErrorMessage(plan))
    const writeRes = await writeCardFields(folder, slug, plan.updates)
    if (!writeRes.ok) return errorResult(`WRITE_FAILED: ${writeRes.code}`)
    changed.push(...plan.changed)
    touchesFingerprint = plan.changed.some((f) => f === 'title' || f === 'spec')
  }
  if (appendBody) {
    const { memoryDir, branch, mode, checkout } = await resolveMemoryLocation(folder)
    const res = await appendMemoryEntry({
      memoryDir,
      page: `roadmap/${slug}`,
      entry: appendBody,
      author: 'agent',
      ...(branch ? { branch } : {}),
      ...(mode === 'central' ? { backlink: { sourcePath: checkout } } : {}),
      now: Date.now()
    })
    if (!res.ok) return errorResult(`${res.error}: ${res.detail}`)
    changed.push('body')
    touchesFingerprint = true
  }
  if (replaceBody !== undefined) {
    // S2: full-replace door — the SAME serialized `replaceCardBodyCore` the
    // human `roadmap:replaceBody` IPC uses (frontmatter untouched). Its own
    // `stampVoided` verdict is folded into `touchesFingerprint` below rather
    // than read directly, so the ACK warning stays worded identically for
    // every fingerprint-touching write on this verb (set/appendBody/images).
    const writeRes = await replaceCardBodyCore(folder, slug, replaceBody)
    if (!writeRes.ok) return errorResult(`WRITE_FAILED: ${writeRes.code}`)
    changed.push('body')
    touchesFingerprint = true
  }
  if (images && images.length > 0) {
    const { memoryDir, branch, mode, checkout } = await resolveMemoryLocation(folder)
    const attached = await attachCardAssets(memoryDir, folder, slug, images)
    if (!attached.ok) return errorResult(attached.message)
    const res = await appendMemoryEntry({
      memoryDir,
      page: `roadmap/${slug}`,
      entry: formatCardAssetEmbeds(attached.filenames),
      author: 'agent',
      ...(branch ? { branch } : {}),
      ...(mode === 'central' ? { backlink: { sourcePath: checkout } } : {}),
      now: Date.now()
    })
    if (!res.ok) return errorResult(`${res.error}: ${res.detail}`)
    changed.push('body')
    touchesFingerprint = true
  }
  const warning =
    card.approved && touchesFingerprint
      ? 'this card had a manifest approval; this edit voids the stamp — dispatch will fall back to a per-card confirm (manifest-stale) until it goes through a manifest again.'
      : undefined
  return textResult({ ok: true, op: 'update_card', slug, changed, ...(warning ? { warning } : {}) })
}

const moveCardHandler: Handler = async (args, ctx) => {
  // T96 §1.3: origin free (Q10) except a `done` card (CARD_CLOSED); the
  // destination is already constrained to backlog|ready|review by the
  // schema (done/in-progress cannot even parse — see validate.ts). Writes
  // via the SAME serialized path the human IPC uses.
  const folder = ctx.folder
  const slug = strField(args, 'slug')
  const to = strField(args, 'to') as CardMoveTarget | undefined
  if (!slug || !to) return errorResult('BAD_ARGS: slug and to are required')

  const { repoKey } = await resolveRoadmap(folder)
  if (takeBoardRateSlot(repoKey, Date.now()) === null) {
    return errorResult(boardRateLimitMessage())
  }

  const found = await readCard(folder, slug)
  if (!found.ok) {
    return errorResult(
      found.code === 'bad-args' ? 'BAD_ARGS: invalid slug' : 'NOT_FOUND: card not found'
    )
  }
  const from = found.card.status
  const plan = planCardMove({ from, to })
  if (!plan.ok) {
    return errorResult(
      'CARD_CLOSED: this card is done — Done is immutable by verb; ask the operator to reopen it on the board if it needs more work.'
    )
  }
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before
  // writing a move nobody will read the ACK for.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const writeRes = await writeCardFields(folder, slug, { status: to })
  if (!writeRes.ok) return errorResult(`WRITE_FAILED: ${writeRes.code}`)
  return textResult({ ok: true, op: 'move_card', slug, from, to })
}

const archiveCardHandler: Handler = async (args, ctx) => {
  // T148: reversible — moves the card's file into `roadmap-archive/`. Same
  // rate-slot + in-progress guard as move_card; no `planCardMove`/status write
  // involved, so no CARD_CLOSED check (an archived card leaves the board
  // entirely, `done` or not).
  const folder = ctx.folder
  const slug = strField(args, 'slug')
  if (!slug) return errorResult('BAD_ARGS: slug is required')

  const { repoKey } = await resolveRoadmap(folder)
  if (takeBoardRateSlot(repoKey, Date.now()) === null) {
    return errorResult(boardRateLimitMessage())
  }

  const found = await readCard(folder, slug)
  if (!found.ok) {
    return errorResult(
      found.code === 'bad-args' ? 'BAD_ARGS: invalid slug' : 'NOT_FOUND: card not found'
    )
  }
  if (found.card.status === 'in-progress') return errorResult(cardInProgressMessage('archiving'))

  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before
  // archiving a card nobody will read the ACK for.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await archiveCardFile(folder, slug)
  if (!res.ok) return errorResult(`WRITE_FAILED: ${res.code}`)
  return textResult({ ok: true, op: 'archive_card', slug })
}

const deleteCardHandler: Handler = async (args, ctx) => {
  // T148: irreversible — this verb is never silent-allowed (see tool-catalog.ts),
  // so reaching this handler always means the operator already confirmed it.
  const folder = ctx.folder
  const slug = strField(args, 'slug')
  if (!slug) return errorResult('BAD_ARGS: slug is required')

  const { repoKey } = await resolveRoadmap(folder)
  if (takeBoardRateSlot(repoKey, Date.now()) === null) {
    return errorResult(boardRateLimitMessage())
  }

  const found = await readCard(folder, slug)
  if (!found.ok) {
    return errorResult(
      found.code === 'bad-args' ? 'BAD_ARGS: invalid slug' : 'NOT_FOUND: card not found'
    )
  }
  if (found.card.status === 'in-progress') return errorResult(cardInProgressMessage('deleting'))

  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before
  // an irreversible delete nobody will read the ACK for.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await deleteCardFile(folder, slug)
  if (!res.ok) return errorResult(`WRITE_FAILED: ${res.code}`)
  return textResult({ ok: true, op: 'delete_card', slug })
}

/** T104: narrow `submit_manifest`'s raw `cards` arg into typed per-card requests
 *  — mirrors `server.ts`'s `manifestCardRequestsFrom` (the confirm-disclosure
 *  builder needs the identical narrowing; kept local here instead of imported
 *  to avoid a `server.ts` → `tool-handlers.ts` → `server.ts` cycle, since
 *  `server.ts` already imports `WIRED_TOOLS` from this module). */
function manifestCardRequestsFromArgs(args: Record<string, unknown>): ManifestCardRequest[] {
  if (!Array.isArray(args.cards)) return []
  const out: ManifestCardRequest[] = []
  for (const raw of args.cards) {
    if (typeof raw !== 'object' || raw === null) continue
    const rec = raw as Record<string, unknown>
    const slug = strField(rec, 'slug')
    if (!slug) continue
    const entry: ManifestCardRequest = { slug }
    const substrateArg = strField(rec, 'substrate')
    if (substrateArg && isCardSubstrate(substrateArg)) entry.substrate = substrateArg
    const model = strField(rec, 'model')
    if (model) entry.model = model
    const effort = strField(rec, 'effort')
    if (effort) entry.effort = effort
    out.push(entry)
  }
  return out
}

/** Mirrors `server.ts`'s `manifestBuildErrorMessage` — a dirigible message for
 *  why `submit_manifest` couldn't resolve one card, for the silent path's ACK
 *  (the confirm path surfaces the same codes via the parked disclosure text). */
function manifestBuildErrorMessage(err: ManifestBuildError): string {
  switch (err.code) {
    case 'card-done':
      return `CARD_CLOSED: card "${err.slug}" is already done — a manifest cannot include a closed card.`
    case 'contains-secret':
      return `CONTAINS_SECRET: card "${err.slug}"'s body looks like it contains a secret — refusing to fold it into a boot prompt.`
    case 'not-found':
      return `NOT_FOUND: no card "${err.slug}" exists on this board.`
    default:
      return `BAD_ARGS: invalid slug "${err.slug}".`
  }
}

/**
 * The shared "stamp checked cards → build the ACK" body (T104 §2.2, extracted
 * T187 so the silently-allowed path reaches the EXACT same stamping code as
 * the operator-Allow path): stamps `approved` + the disclosed body fingerprint
 * on every selected slug, computes the untouched `skipped` list, shadow-logs
 * the outcome, and returns the `submit_manifest` ACK. `resolved` must always
 * be rows a server-side disk read produced (never the agent's own text) —
 * both callers uphold that, just at different times (Allow reuses the rows
 * disclosed at parking time; the silent path resolves them fresh, since there
 * is no confirm to have parked them earlier).
 */
async function stampManifestAndAck(
  folder: string,
  resolved: readonly ManifestCardResolved[],
  selectedSlugs: readonly string[],
  substrateOverrides: Readonly<Record<string, string>>,
  shadow: { event: string; by: string; verb: string }
): Promise<CallToolResult> {
  const stampResult = await stampManifestApprovals(
    folder,
    resolved,
    selectedSlugs,
    Date.now(),
    substrateOverrides
  )
  const skipped = resolved.map((r) => r.slug).filter((slug) => !selectedSlugs.includes(slug))
  pushShadowEntry({
    sessionId: '',
    event: shadow.event,
    by: shadow.by,
    summary: `${shadow.verb} in ${folder}: ${stampResult.stamped.length}/${resolved.length} card(s) stamped (${stampResult.stamped.join(', ') || 'none'})`,
    ts: Date.now()
  })
  return textResult({
    ok: true,
    op: 'submit_manifest',
    stamped: stampResult.stamped,
    skipped,
    ...(stampResult.failed.length ? { failed: stampResult.failed } : {})
  })
}

const submitManifestHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before
  // stamping approvals nobody will read the ACK for.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')

  // T104 §2.2: the Allow actuation. `ctx.opts.manifest` is populated ONLY by
  // `parkMutationConfirm`'s `actuateAllow` (reached only under "Ask before
  // agent actions" — the base gate never leaves `submit_manifest` free there,
  // T187 tool-catalog.ts) — its `resolved` list is the EXACT disclosure the
  // operator reviewed, not a fresh disk read.
  if (ctx.opts?.manifest) {
    const { resolved, selectedSlugs, substrateOverrides } = ctx.opts.manifest
    if (resolved.length === 0) {
      return errorResult('BAD_ARGS: no cards to stamp — this manifest was never disclosed.')
    }
    // Partial-go (§2.2): unchecked cards are UNTOUCHED, not denied — including
    // the all-unchecked case, which is a legal no-op Allow, never an error.
    return stampManifestAndAck(folder, resolved, selectedSlugs, substrateOverrides, {
      event: 'mcp:submit_manifest',
      by: 'operator-go',
      verb: 'manifest go'
    })
  }

  // T187: the silently-allowed path — reached with "Ask before agent actions"
  // off (the default) in a folder that isn't blocked (`plan-tool-call.ts`'s
  // `silentAllowInAgentFolder` branch). There is no operator to hand a
  // disclosure to, so this resolves the SAME rows a confirm would have —
  // fresh from disk, never from the agent's own text (the invariant
  // `buildManifestDisclosure` already enforces) — and treats every named slug
  // as checked: partial-go is a UI affordance of the confirm, not of the verb,
  // and there is no operator here to uncheck anything.
  const cards = manifestCardRequestsFromArgs(args)
  if (cards.length === 0) {
    return errorResult('BAD_ARGS: submit_manifest requires at least one card.')
  }
  const built = await buildManifestDisclosure(folder, cards, MANIFEST_BOOT_LABELS)
  if (!built.ok) {
    return errorResult(manifestBuildErrorMessage(built))
  }
  const selectedSlugs = built.resolved.map((r) => r.slug)
  // The agent's own per-card substrate request (`cards[].substrate`) already
  // shaped `row.substrate` in the disclosure above; carry it through to the
  // actual stamp too — there is no operator substrate-picker on this path to
  // separately confirm it, so the agent's own request is authoritative.
  const substrateOverrides: Record<string, string> = {}
  for (const c of cards) {
    if (c.substrate) substrateOverrides[c.slug] = c.substrate
  }
  const res = await stampManifestAndAck(folder, built.resolved, selectedSlugs, substrateOverrides, {
    event: 'roadmap:manifest-stamp',
    by: 'agent-silent-allow',
    verb: 'manifest self-approved (agent, ask off)'
  })
  // T187 Change 3: the confirm modal is gone, so this is the operator's only
  // synchronous signal that a batch just self-approved and started draining.
  // Best-effort — no live renderer window (or a dispatch failure) must never
  // fail a stamp that already committed.
  if (ctx.bridge) {
    const count = built.resolved.length
    void ctx.bridge
      .dispatch('notify.push', {
        folderPath: folder,
        title: `Dispatch manifest self-approved (${count} card${count === 1 ? '' : 's'})`,
        description: `${selectedSlugs.join(', ')} — draining now.`,
        kind: 'info'
      })
      .catch(() => {})
  }
  return res
}

// ---- T215 `message_session` ------------------------------------------------

/**
 * How long Harnu waits for a woken session's PTY to report ready. A
 * `claude --resume` of a long transcript can take a while; a wake that never
 * arrives must surface as `WAKE_TIMEOUT` with the message NOT sent, never as a
 * silent drop and never as a retry loop that could put a second process on one
 * transcript.
 */
const WAKE_READY_TIMEOUT_MS = 40_000

/**
 * How long Harnu keeps looking for the peer's socket AFTER the PTY is live. A
 * live PTY is not yet a bound socket: `startUdsMessaging` runs inside the CLI's
 * own `setup`, after exec. Reading once and giving up would report
 * `PEER_NO_SOCKET` for a session that is merely still booting.
 */
const SOCKET_POLL_WINDOW_MS = 10_000
const SOCKET_POLL_INTERVAL_MS = 500

/**
 * Per-recipient anti-runaway cap (spec O-10). Nothing else stops a looping
 * agent from writing thousands of messages into one inbox AND thousands of rows
 * into a 200-entry audit ring, which would evict every other record — i.e. the
 * loop would destroy the very trail that makes it visible. High on purpose: a
 * loop-abandon backstop, not day-to-day friction. Per UTC day, like the board
 * cap, and for the same reason — the MCP transport has no per-session identity,
 * so per-SENDER is impossible; the recipient is the only party Harnu can name.
 */
const PEER_MESSAGE_LIMIT_PER_DAY = 200
const peerMessageCounters = new Map<string, BoardRateCounter>()

function takePeerMessageSlot(sessionId: string, now: number): number | null {
  const day = utcDayKey(now)
  const existing = peerMessageCounters.get(sessionId)
  const current = existing && existing.day === day ? existing.count : 0
  if (current >= PEER_MESSAGE_LIMIT_PER_DAY) return null
  const next = current + 1
  peerMessageCounters.set(sessionId, { day, count: next })
  return next
}

/** Resolve once the peer's socket answers, or `null` after the poll window. */
async function pollPeerSocket(
  sessionKey: string,
  deadlineMs: number
): Promise<{ pid: number; socket: string } | null> {
  for (;;) {
    const address = await peerAddressForSession(sessionKey)
    if (address) return address
    if (Date.now() >= deadlineMs) return null
    await new Promise((r) => setTimeout(r, SOCKET_POLL_INTERVAL_MS))
  }
}

/**
 * T215: broker ONE message into another Harnu session's Claude Code inbox.
 *
 * Check order is deterministic and deliberate (spec §3.5):
 *  1. the id resolves in the fleet (scan ∪ both in-flight registries), else
 *     `SESSION_NOT_FOUND`;
 *  2. the RECIPIENT's folder gate — already applied upstream in `server.ts`, so
 *     a blocked folder never reaches here;
 *  3. `harnuOwnsSession`, else `RECIPIENT_NOT_HARNU_SPAWNED`;
 *  4. the ownership marker, else `RECIPIENT_OPERATOR_OWNED`;
 *  5. wake if parked, else `WAKE_TIMEOUT` with nothing sent;
 *  6. resolve the socket and write.
 *
 * Steps 3 and 4 run BEFORE any wake and before any socket work, so a refused
 * recipient costs no side effect at all — not a resumed process, not a connect,
 * not a byte.
 *
 * NOT in that list, deliberately: a self-message guard. The MCP transport has
 * no per-session identity, so Harnu cannot know who is calling and therefore
 * cannot refuse a session messaging itself. The verb's description says so
 * rather than pretending to a check.
 */
const messageSessionHandler: Handler = async (args, ctx) => {
  const sessionId = strField(args, 'sessionId') ?? ''
  const message = strField(args, 'message') ?? ''
  if (!sessionId) return steerError('SESSION_NOT_FOUND', ctx.folder)
  if (!message) return errorResult('BAD_ARGS: message is required')
  if (message.length > MESSAGE_MAX_CHARS) return steerError('MESSAGE_TOO_LARGE', ctx.folder)

  // 1. Known at all? The scan lists sessions with a transcript on disk; a
  //    live born-synthetic has none, so both in-flight registries are consulted
  //    too — the same widening the gate folder needed.
  const onDisk = ctx.folders.some((f) => f.sessions.some((sn) => sn.sessionId === sessionId))
  const inflight =
    listInflightSessions().some((e) => e.syntheticId === sessionId) ||
    inFlightFolderFor(sessionId) !== undefined
  if (!onDisk && !inflight) return steerError('SESSION_NOT_FOUND', ctx.folder)

  // 3. The recipient predicate. An index hit is causal proof Harnu spawned the
  //    process and it is still alive; the parked arm covers the gap
  //    `hibernateSession` opens by removing the index entry before flagging.
  if (!sessionOwnedByHarnu(sessionId)) {
    return steerError('RECIPIENT_NOT_HARNU_SPAWNED', ctx.folder)
  }

  // 4. The ownership marker (T215 DoD). `harnuOwnsSession` cannot tell an
  //    agent-dispatched session from one the operator opened in Harnu — both go
  //    through the same spawn — so the origin is stamped at the spawn site and
  //    read back here. Fails closed: an unmarked recipient is the operator's.
  if (!isMessageableOwner(spawnOriginForSession(sessionId))) {
    return steerError('RECIPIENT_OPERATOR_OWNED', ctx.folder)
  }

  if (takePeerMessageSlot(sessionId, Date.now()) === null) {
    return errorResult(
      `PEER_MESSAGE_RATE_LIMIT: this recipient already received ${PEER_MESSAGE_LIMIT_PER_DAY} brokered messages today — the cap resets at UTC midnight. It is a loop-abandon backstop, not a normal ceiling; if the two sessions genuinely need to talk more, ask the operator.`
    )
  }

  // 5. Wake a parked recipient. `session.wake` is HEADLESS: the renderer
  //    resumes it through the ordinary `activate()` machinery without selecting
  //    it, so an agent's message cannot yank an operator who is looking
  //    somewhere else. The bridge ack only says the resume was QUEUED — the
  //    real signal is the session's own `pty:sessionReady`, which main awaits,
  //    because a long transcript's resume outlives the bridge deadline.
  let woke = false
  if (isHibernated(sessionId)) {
    if (!ctx.bridge) return errorResult('NO_BRIDGE')
    const dispatched = await ctx.bridge.dispatch('session.wake', { sessionId })
    if (!dispatchSucceeded(dispatched)) return steerError('WAKE_TIMEOUT', ctx.folder)
    const ready = await waitForSessionReady(sessionId, WAKE_READY_TIMEOUT_MS)
    if (!ready) return steerError('WAKE_TIMEOUT', ctx.folder)
    woke = true
  }

  // 6. A live PTY is not yet a bound socket (the CLI binds inside its own
  //    `setup`, after exec), so poll with a bounded backoff instead of reading
  //    once. Only a session Harnu just woke needs the full window.
  if (woke) {
    const address = await pollPeerSocket(sessionId, Date.now() + SOCKET_POLL_WINDOW_MS)
    if (!address) return steerError('PEER_NO_SOCKET', ctx.folder)
  }

  const sent = await sendPeerMessage(sessionId, message)
  if (!sent.ok) return steerError(sent.code, ctx.folder)

  // The audit row `handleToolCall` already wrote for this call carries only the
  // coarse gate summary. Add the one that names the RECIPIENT, the pid, the
  // length and a HASH of the body — never the body itself: 200 entries x 4 KiB
  // of plaintext persisted to userData would be a transcript of every
  // inter-agent message, which is a disclosure liability, not an audit.
  appendAudit({
    ts: Date.now(),
    tool: 'message_session',
    folder: ctx.folder,
    verdict: 'allow',
    disclosedPayloadSummary: messageAuditSummary({
      sessionId,
      pid: sent.pid,
      chars: message.length,
      bytes: sent.bytes,
      body: message
    }),
    result: 'ok'
  })

  // The operator-readable copy: one Activity row through the EXISTING
  // `notify.push` command — no new transport, and no new COMMAND_OPS member for
  // this half. Best-effort: a missing window must never fail a message that
  // already landed in the peer's inbox.
  if (ctx.bridge) {
    // The title is a session LABEL, not a raw uuid — folder basename plus a
    // short id, which is what the operator can actually recognize in a list.
    // `sessionId` still rides along in full so the row's deep-link lands on the
    // exact recipient. NOTE this field normally carries the CALLING session's
    // id (a link back to the author); here the recipient is the useful
    // destination — the operator reading "a message went to X" wants to open X.
    const label = `${path.basename(ctx.folder) || 'session'} · ${sessionId.slice(0, 8)}`
    void ctx.bridge
      .dispatch('notify.push', {
        folderPath: ctx.folder,
        title: `Message → ${label}`,
        description: activityDescription(message),
        kind: 'info',
        sessionId
      })
      .catch(() => {})
  }

  return textResult({
    ok: true,
    op: 'message_session',
    sessionId,
    peer: { pid: sent.pid, socket: sent.socket },
    // `queued`, NOT `delivered`. Harnu binds no socket of its own, so it never
    // sees the recipient's `peer_message_status` receipt — it cannot tell you
    // the message was held, denied, expired or read.
    status: 'queued',
    woke,
    bytes: sent.bytes
  })
}

// ---- T308: Scheduler worker verbs -------------------------------------------

const EFFORTS = new Set<Effort>(['low', 'medium', 'high', 'xhigh', 'max'])
const NOTIFY_ON_ARGS = new Set<NotifyOn>(['silent', 'failure', 'every'])

/**
 * A positive-integer field, re-derived from RAW args exactly as strictly as
 * `CreateWorkerSchema`/`UpdateWorkerSetSchema` enforce it upstream (BUG-121):
 * `undefined` when absent, `null` when present but not a positive integer —
 * shared by `everyMinutes` and `timeoutSeconds` on both create_worker and
 * update_worker.
 */
function positiveIntField(args: Record<string, unknown>, key: string): number | undefined | null {
  const v = args[key]
  if (v === undefined) return undefined
  return Number.isInteger(v) && (v as number) > 0 ? (v as number) : null
}

const createWorkerHandler: Handler = async (args, ctx) => {
  // T10 already structurally validated this call (parseCreateWorker) before the
  // gate ever dispatched it — this handler still re-derives its own fields from
  // the RAW args, the same convention every other handler follows (the
  // validated value never crosses into `actuate`; see `handleToolCall`).
  const name = strField(args, 'name')
  if (!name) return errorResult('BAD_ARGS: name is required')
  const prompt = strField(args, 'prompt')
  if (!prompt) return errorResult('BAD_ARGS: prompt is required')
  // BUG-121: matches `CreateWorkerSchema`'s `z.number().int().positive()`
  // EXACTLY. It used to accept any positive number, so this second line of
  // defence was weaker than the first one — which is the opposite of what
  // defence-in-depth means. `0.5` is rejected here now, as it already was there.
  const everyMinutes = positiveIntField(args, 'everyMinutes')
  if (!everyMinutes) return errorResult('BAD_ARGS: everyMinutes must be a positive integer')
  const modeArg = strField(args, 'mode')
  const mode: WorkerMode = modeArg === 'act' ? 'act' : 'observe'
  const model = strField(args, 'model')
  const effortArg = strField(args, 'effort')
  const effort = effortArg && EFFORTS.has(effortArg as Effort) ? (effortArg as Effort) : undefined
  // T316 AC-5: matches `CreateWorkerSchema`'s `z.number().int().positive()` too.
  const timeoutSeconds = positiveIntField(args, 'timeoutSeconds')
  if (timeoutSeconds === null) {
    return errorResult('BAD_ARGS: timeoutSeconds must be a positive integer')
  }

  // BUG-121: the scheduler store refuses a write that lands before it has read
  // `schedulers.json` — such a write would whole-file overwrite the operator's
  // workers with just this one. Surface that refusal as an ordinary tool error
  // so the caller sees WHY nothing was created, instead of the throw escaping
  // the handler.
  let created: Awaited<ReturnType<typeof createWorkerForAgent>>
  try {
    created = await createWorkerForAgent({
      folder: ctx.folder,
      name,
      prompt,
      everyMinutes,
      mode,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {})
    })
  } catch (err) {
    // Matched on the error's `code`, not `instanceof`: a duplicated module
    // instance would give a different class object and silently answer false,
    // turning a handled refusal back into an unhandled throw. Pinned at THIS
    // boundary by "the handler recognises a refusal raised by a DIFFERENT
    // module instance" in tests/mcp-create-worker-handler.test.ts, which raises
    // the refusal from a second, separately-resolved instance of
    // scheduler-shell and goes red if this line becomes `instanceof`.
    if (isSchedulerNotReady(err)) return errorResult((err as Error).message)
    throw err
  }
  const { worker, missingSkills } = created

  return textResult({
    ok: true,
    op: 'create_worker',
    id: worker.id,
    name: worker.name,
    folder: worker.folder,
    mode: worker.mode,
    everyMinutes: worker.everyMinutes,
    enabled: worker.enabled,
    // AC-6: reported, never silently dropped — the worker IS created either way.
    ...(missingSkills.length > 0
      ? {
          warning: `Prompt names skill(s) nothing on this machine answers to, so they will never stage: ${missingSkills.join(', ')}`
        }
      : {})
  })
}

const listWorkersHandler: Handler = async (args, ctx) => {
  const scope = strField(args, 'folder')
  const rows = await listWorkersForAgent(scope)
  // AC-4: redacted like every other fleet read — the raw folder path never
  // leaves the process, only its basename alias, plus the SAME
  // `agentControllable` truth get_fleet/list_worktrees disclose.
  const workers = rows.map((w) => ({
    id: w.id,
    name: w.name,
    folderAlias: path.basename(w.folder) || w.folder,
    mode: w.mode,
    everyMinutes: w.everyMinutes,
    enabled: w.enabled,
    agentControllable: !isFolderDenied(w.folder, ctx.denyFolders),
    ...(w.lastRun ? { lastRun: w.lastRun } : {})
  }))
  return textResult({ workers })
}

/**
 * Re-derive `update_worker`'s `set` from RAW args into the shell's
 * {@link UpdateWorkerPatch} shape — same convention as `createWorkerHandler`
 * (the T10-validated value never crosses into actuation). Returns `null` for
 * an out-of-range numeric/enum field so the handler can refuse with a precise
 * BAD_ARGS instead of silently dropping it.
 */
function patchFromSetArg(setRaw: Record<string, unknown>): UpdateWorkerPatch | 'BAD_ARGS' {
  const patch: UpdateWorkerPatch = {}
  const name = strField(setRaw, 'name')
  if (name !== undefined) patch.name = name
  const prompt = strField(setRaw, 'prompt')
  if (prompt !== undefined) patch.prompt = prompt
  const everyMinutes = positiveIntField(setRaw, 'everyMinutes')
  if (everyMinutes === null) return 'BAD_ARGS'
  if (everyMinutes !== undefined) patch.everyMinutes = everyMinutes
  const mode = strField(setRaw, 'mode')
  if (mode !== undefined) {
    if (mode !== 'observe' && mode !== 'act') return 'BAD_ARGS'
    patch.mode = mode
  }
  const model = strField(setRaw, 'model')
  if (model !== undefined) patch.model = model
  const effort = strField(setRaw, 'effort')
  if (effort !== undefined) {
    if (!EFFORTS.has(effort as Effort)) return 'BAD_ARGS'
    patch.effort = effort as Effort
  }
  const timeoutSeconds = positiveIntField(setRaw, 'timeoutSeconds')
  if (timeoutSeconds === null) return 'BAD_ARGS'
  if (timeoutSeconds !== undefined) patch.timeoutSeconds = timeoutSeconds
  if (typeof setRaw.enabled === 'boolean') patch.enabled = setRaw.enabled
  if (typeof setRaw.runOnBoot === 'boolean') patch.runOnBoot = setRaw.runOnBoot
  if (typeof setRaw.carryLastResult === 'boolean') patch.carryLastResult = setRaw.carryLastResult
  const notifyOn = strField(setRaw, 'notifyOn')
  if (notifyOn !== undefined) {
    if (!NOTIFY_ON_ARGS.has(notifyOn as NotifyOn)) return 'BAD_ARGS'
    patch.notifyOn = notifyOn as NotifyOn
  }
  if (Array.isArray(setRaw.extraReadCommands)) {
    patch.extraReadCommands = setRaw.extraReadCommands.filter(
      (v): v is string => typeof v === 'string'
    )
  }
  const systemPrompt = strField(setRaw, 'systemPrompt')
  if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt
  return patch
}

const updateWorkerHandler: Handler = async (args) => {
  const id = strField(args, 'id')
  if (!id) return errorResult('BAD_ARGS: id is required')
  const setRaw = asRecord(args.set)
  if (Object.keys(setRaw).length === 0) {
    return errorResult('BAD_ARGS: set must include at least one field')
  }
  const patch = patchFromSetArg(setRaw)
  if (patch === 'BAD_ARGS' || Object.keys(patch).length === 0) {
    return errorResult('BAD_ARGS: set must include at least one recognized, valid field')
  }

  let result: Awaited<ReturnType<typeof updateWorkerForAgent>>
  try {
    result = await updateWorkerForAgent({ id, set: patch })
  } catch (err) {
    // Same cross-module-instance reasoning as `createWorkerHandler` above —
    // matched on `code`, never `instanceof`.
    if (isSchedulerNotReady(err)) return errorResult((err as Error).message)
    if (isWorkerNotFound(err)) return errorResult((err as Error).message)
    throw err
  }
  const { worker, missingSkills, tickInFlight } = result

  return textResult({
    ok: true,
    op: 'update_worker',
    id: worker.id,
    name: worker.name,
    mode: worker.mode,
    everyMinutes: worker.everyMinutes,
    enabled: worker.enabled,
    // T316 decision 4: whether a tick was already running with the PRE-edit
    // worker at the moment this call landed — the edit itself never touches it.
    tickInFlight,
    ...(missingSkills.length > 0
      ? {
          warning: `Prompt names skill(s) nothing on this machine answers to, so they will never stage: ${missingSkills.join(', ')}`
        }
      : {})
  })
}

const deleteWorkerHandler: Handler = async (args) => {
  const id = strField(args, 'id')
  if (!id) return errorResult('BAD_ARGS: id is required')

  let result: Awaited<ReturnType<typeof deleteWorkerForAgent>>
  try {
    result = await deleteWorkerForAgent(id)
  } catch (err) {
    if (isSchedulerNotReady(err)) return errorResult((err as Error).message)
    if (isWorkerNotFound(err)) return errorResult((err as Error).message)
    throw err
  }
  return textResult({ ok: true, op: 'delete_worker', id, wasRunning: result.wasRunning })
}

// ---- T309 `orchestrator_arm` / `orchestrator_disarm` -----------------------

/**
 * T309: arm the orchestrator drift-brake guard for a session, live (ADR-0013).
 * Target scope is IDENTICAL to `message_session`'s recipient scope — see
 * {@link resolveAgentTarget}. `arm()` itself is idempotent (orchestrator-guard.ts):
 * re-arming an already-armed session just re-confirms the hook registration.
 */
const orchestratorArmHandler: Handler = async (args, ctx) => {
  const sessionId = strField(args, 'sessionId') ?? ''
  if (!sessionId) return steerError('SESSION_NOT_FOUND', ctx.folder)

  switch (resolveAgentTarget(sessionId, ctx.folders)) {
    case 'not_found':
      return steerError('SESSION_NOT_FOUND', ctx.folder)
    case 'not_harnu_spawned':
      return steerError('TARGET_NOT_HARNU_SPAWNED', ctx.folder)
    case 'operator_owned':
      return steerError('TARGET_OPERATOR_OWNED', ctx.folder)
  }

  await arm(sessionId, ctx.folder)

  appendAudit({
    ts: Date.now(),
    tool: 'orchestrator_arm',
    folder: ctx.folder,
    verdict: 'allow',
    disclosedPayloadSummary: `armed ${sessionId}`,
    result: 'ok'
  })

  return textResult({
    ok: true,
    op: 'orchestrator_arm',
    sessionId,
    folder: ctx.folder,
    armed: true
  })
}

/**
 * T309: disarm the orchestrator drift-brake guard for a session (ADR-0013).
 * Same target scope as {@link orchestratorArmHandler}. `disarm()` itself is a
 * safe no-op for a session with no armed entry (orchestrator-guard.ts) — this
 * handler never distinguishes "was armed" from "was never armed" in its ACK.
 */
const orchestratorDisarmHandler: Handler = async (args, ctx) => {
  const sessionId = strField(args, 'sessionId') ?? ''
  if (!sessionId) return steerError('SESSION_NOT_FOUND', ctx.folder)

  switch (resolveAgentTarget(sessionId, ctx.folders)) {
    case 'not_found':
      return steerError('SESSION_NOT_FOUND', ctx.folder)
    case 'not_harnu_spawned':
      return steerError('TARGET_NOT_HARNU_SPAWNED', ctx.folder)
    case 'operator_owned':
      return steerError('TARGET_OPERATOR_OWNED', ctx.folder)
  }

  await disarm(sessionId)

  appendAudit({
    ts: Date.now(),
    tool: 'orchestrator_disarm',
    folder: ctx.folder,
    verdict: 'allow',
    disclosedPayloadSummary: `disarmed ${sessionId}`,
    result: 'ok'
  })

  return textResult({ ok: true, op: 'orchestrator_disarm', sessionId, armed: false })
}

// ---- T328 `list_containers` --------------------------------------------------

/**
 * The Containers takeover's facts for an agent (T328). Reads through the SAME
 * service the takeover uses (`getContainersService`, T330) and never derives a
 * verdict; `containers-listing.ts` only redacts paths and applies the scope.
 */
const listContainersHandler: Handler = async (args, ctx) => {
  const svc = getContainersService()
  if (!svc) {
    return errorResult(
      'CONTAINERS_NOT_READY: the Containers service has not started yet. Retry in a moment.'
    )
  }
  // A fresh scan, not the cached snapshot: a worker polling for zombies must
  // never read verdicts from before its own call. The service single-flights it.
  const snap = await svc.scan()
  const home = os.homedir()
  // AC-3: docker missing or down is a refusal, never an empty list.
  if (!snap.dockerAvailable) {
    return {
      content: [{ type: 'text', text: JSON.stringify(dockerUnavailableRefusal(snap, home)) }],
      isError: true
    }
  }
  const scope = strField(args, 'folder')
  const listing = containersListing(snap, {
    denyFolders: ctx.denyFolders,
    home,
    scopeRoots: scope ? containersScopeRoots(scope, ctx.folders, home) : null
  })
  return textResult({ ok: true, ...listing })
}

// ---- T329 `stop_containers` / `start_containers` / `remove_containers` -------

function stackIdsOf(args: Record<string, unknown>): string[] {
  return Array.isArray(args.stacks)
    ? args.stacks.filter((s): s is string => typeof s === 'string')
    : []
}

/**
 * Runs one Containers action for an agent through U1's single action function
 * (`svc.act(raw, 'agent')`, T330): the tiers, the refusal codes and the ONE
 * journal line all come from there, never from this handler.
 *
 * The one thing added here is the folder block, per stack. These verbs name
 * stacks, never a folder, so the MCP gate cannot see which folder a stack lives
 * in: a stack a blocked folder covers is refused FOLDER_NOT_ALLOWED and never
 * reaches the action, while the rest of the batch still runs.
 */
async function actOnContainers(
  verb: AgentActVerb,
  raw: Record<string, unknown>,
  targets: string[],
  ctx: ToolHandlerCtx
): Promise<CallToolResult> {
  const svc = getContainersService()
  if (!svc) {
    return errorResult(
      'CONTAINERS_NOT_READY: the Containers service has not started yet. Retry in a moment.'
    )
  }
  const home = os.homedir()
  let blocked: string[] = []
  if (ctx.denyFolders.length > 0) {
    const snap = await svc.scan()
    // Fail closed: without a scan the block cannot be checked, and a daemon that
    // came back before the action's own scan would let a blocked stack through.
    if (!snap.dockerAvailable) {
      return {
        content: [{ type: 'text', text: JSON.stringify(dockerUnavailableRefusal(snap, home)) }],
        isError: true
      }
    }
    blocked = blockedStackIds(snap, targets, ctx.denyFolders, home)
  }
  const allowed = targets.filter((id) => !blocked.includes(id))
  // The action is this verb's single commit point: past the 120s deadline the
  // caller already got TOOL_TIMEOUT, so acting now would be invisible to it.
  if (allowed.length > 0 && ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const result =
    allowed.length === 0
      ? null
      : await svc.act(verb === 'remove' ? raw : { ...raw, stacks: allowed }, 'agent')
  const ack = containersActAck(verb, { requested: targets, blocked, result, home })
  return ack.isError
    ? { content: [{ type: 'text', text: JSON.stringify(ack.payload) }], isError: true }
    : textResult(ack.payload)
}

const stopContainersHandler: Handler = (args, ctx) => {
  const stacks = stackIdsOf(args)
  return actOnContainers('stop', { verb: 'stop', stacks, force: args.force === true }, stacks, ctx)
}

const startContainersHandler: Handler = (args, ctx) => {
  const stacks = stackIdsOf(args)
  return actOnContainers('start', { verb: 'start', stacks }, stacks, ctx)
}

const removeContainersHandler: Handler = (args, ctx) => {
  const stack = typeof args.stack === 'string' ? args.stack : ''
  // No bulk form: a `stacks` list is passed through so the action function
  // refuses it BAD_REQUEST, even if the schema were ever loosened.
  const raw: Record<string, unknown> = {
    verb: 'remove',
    stack,
    removeVolumes: args.removeVolumes === true,
    ...(args.stacks !== undefined ? { stacks: args.stacks } : {})
  }
  return actOnContainers('remove', raw, [stack], ctx)
}

// ---- T445 `list_cleanup` / `release_worktree` --------------------------------

const GC_NOT_READY =
  'GC_NOT_READY: the workspace cleanup service has not started yet. Retry in a moment.'

/**
 * The workspace GC's facts for an agent (T445). Reads through the SAME service the Cleanup
 * surface uses and never decides a bucket; `cleanup-listing.ts` only redacts paths and applies
 * the scope. The service handle the agent gets can read a snapshot and mark a release, so
 * this verb cannot remove anything.
 */
const listCleanupHandler: Handler = async (args, ctx) => {
  const svc = getGcService()
  if (!svc) return errorResult(GC_NOT_READY)
  const home = os.homedir()
  const scope = strField(args, 'folder')
  if (scope && isFolderDenied(scope, ctx.denyFolders, home)) {
    return steerError('FOLDER_NOT_ALLOWED', scope)
  }
  // A fresh gather, not the cached snapshot: a watchdog counting corpses must never read
  // buckets from before its own call. The service single-flights it.
  const snap = await svc.snapshot({ refresh: true })
  const listing = cleanupListing(snap, {
    denyFolders: ctx.denyFolders,
    home,
    scope: scope ?? null,
    scopeRoots: scope ? containersScopeRoots(scope, ctx.folders, home) : null
  })
  return textResult({ ok: true, ...listing })
}

/**
 * The agent says it is done with a merged worktree (T445). Marks the bundle released and
 * deletes nothing: the bucket rules still decide whether it ever becomes a corpse, and only
 * the operator (or the autopilot, once acknowledged) cleans one.
 */
const releaseWorktreeHandler: Handler = async (args, ctx) => {
  const svc = getGcService()
  if (!svc) return errorResult(GC_NOT_READY)
  const home = os.homedir()
  const folder = strField(args, 'folder') ?? ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  if (isFolderDenied(folder, ctx.denyFolders, home)) return steerError('FOLDER_NOT_ALLOWED', folder)

  const snap = await svc.snapshot()
  const now = Date.now()
  const plan = planRelease(snap, folder, { home, now, folders: ctx.folders })
  if (!plan.ok) {
    return { content: [{ type: 'text', text: JSON.stringify(plan.refusal) }], isError: true }
  }
  // A repo the operator blocked is as closed as the worktree folder itself.
  const bundle = snap.bundles.find((b) => b.item.id === plan.bundleId)
  if (bundle && isFolderDenied(bundle.item.repoPath, ctx.denyFolders, home)) {
    return steerError('FOLDER_NOT_ALLOWED', folder)
  }
  // The single commit point: past the 120s deadline the caller already got TOOL_TIMEOUT.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  if (!plan.ack.alreadyReleased) await svc.release(plan.bundleId, now)
  return textResult(plan.ack)
}

// ---- mission_* verbs (T358 S3 — design.md §4) -------------------------------
//
// Missions are repo-scoped and shared by every worktree (design §9, decision 17):
// each handler resolves the MAIN checkout from the gate `folder` with the SAME
// resolver S2's hibernation exemption reads through (`mainCheckoutRoot`), so a
// mission written from a worktree is the mission the exemption finds. Outside a
// git repo the folder itself is the root.
//
// Every read-modify-write runs under `withMissionIdMintLock(id)` exactly ONCE —
// the lock is not re-entrant (S1 F3), so no helper below takes it on its own
// and `createMissionFile` (which takes it internally) is never called inside it.

/** A Claude session UUID — the id shape S2's exemption and `get_fleet` key sessions by. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DECLARED_END_KINDS: readonly DeclaredEnd['kind'][] = [
  'code',
  'ui',
  'research',
  'decision',
  'other'
]

/** The fixed end's title (design §1.2, decision 4). Mission v3 §3.3: there is no fixed start. */
const FIXED_END_TITLE = 'Delivered and verified'

/** The repo root whose `.harnu/missions/` holds `folder`'s missions. */
export function missionRoot(folder: string): string {
  return repoRoot(folder)
}

function badSessionIdMessage(field: string, value: string): string {
  return `BAD_SESSION_ID: ${field} "${value}" is not a Claude session UUID — pass the session's transcript id (the uuid get_fleet reports, never a synthetic-… id). Mission owners and session links are matched by that id; any other shape silently never matches.`
}

/** Which `declaredEnd` fields are missing or invalid (`[]` = complete). */
function declaredEndProblems(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return ['declaredEnd']
  const end = raw as Record<string, unknown>
  const problems: string[] = []
  if (!DECLARED_END_KINDS.includes(end.kind as DeclaredEnd['kind'])) problems.push('kind')
  for (const key of ['target', 'evidence'] as const) {
    const v = end[key]
    if (typeof v !== 'string' || v.trim().length === 0) problems.push(key)
  }
  return problems
}

interface MissionFileEntry {
  id: string
  slug: string
  name: string
}

/** Every `<id>-<slug>.md` in `root`'s missions dir; `[]` when there is none yet. */
async function listMissionEntries(root: string): Promise<MissionFileEntry[]> {
  await dataDirReady(root)
  let names: string[]
  try {
    names = await fs.readdir(missionsDir(root))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: MissionFileEntry[] = []
  for (const name of names.sort()) {
    const m = /^(mnt-[0-9a-f]{8})-(.+)\.md$/.exec(name)
    if (m) out.push({ id: m[1], slug: m[2], name })
  }
  return out
}

type LoadedMission =
  | { ok: true; file: string; raw: string; mission: Mission; log: string }
  | { ok: false; error: string }

/** Read + parse one mission by id; a steerable error when absent or corrupt. */
export async function loadMission(root: string, id: string): Promise<LoadedMission> {
  if (!MISSION_ID_RE.test(id)) {
    return { ok: false, error: `BAD_ARGS: missionId "${id}" is not a mission id (mnt-<8 hex>).` }
  }
  const entry = (await listMissionEntries(root)).find((e) => e.id === id)
  if (!entry) {
    return {
      ok: false,
      error: `MISSION_NOT_FOUND: no mission ${id} in this repo — mission_list shows the ones that exist.`
    }
  }
  const file = path.join(missionsDir(root), entry.name)
  const raw = await fs.readFile(file, 'utf8')
  const parsed = parseMissionFile(raw)
  if ('error' in parsed) {
    return { ok: false, error: `MISSION_UNREADABLE: ${entry.name} — ${parsed.error}` }
  }
  return { ok: true, file, raw, mission: parsed, log: readMissionLog(raw) }
}

/** Per-repo create lock: serializes id-mint + slug pick so concurrent creates stay unique. */
const missionCreateLocks = new Map<string, Promise<unknown>>()

/** A mission slug from its title; `mission` when the title has nothing slug-able. */
function missionSlugBase(title: string): string {
  const slug = slugifyTitle(title)
  // `slugifyTitle` falls back to `card` for an empty result — wrong noun here.
  return slug === 'card' && !/card/i.test(title) ? 'mission' : slug
}

/**
 * A new mission's steps (Mission v3 §3.3): its plan, numbered from `stp-1`, then
 * the fixed end. No fixed start — scope is an attachment, not a step. Planning
 * steps carry no `addedReason`: they are the plan, not growth (§3.4).
 */
function planWithEnd(
  plan: readonly Pick<MissionStep, 'title' | 'verification' | 'links'>[]
): MissionStep[] {
  const steps: MissionStep[] = plan.map((p, i) => ({
    id: `stp-${i + 1}`,
    ordinal: i + 1,
    kind: 'custom',
    title: p.title,
    verification: p.verification,
    proof: 'unproven',
    links: p.links,
    blockers: []
  }))
  steps.push({
    id: `stp-${plan.length + 1}`,
    ordinal: plan.length + 1,
    kind: 'fixed-end',
    title: FIXED_END_TITLE,
    verification: 'verifier',
    proof: 'unproven',
    links: [],
    blockers: []
  })
  return steps
}

/** Most steps `mission_create { steps }` takes in one call. */
const MISSION_PLAN_MAX = 50
const STEP_VERIFICATIONS: readonly MissionStep['verification'][] = [
  'existence',
  'verifier',
  'human'
]

/** `mission_create`'s `steps`: `{ title, verification }[]`, or a BAD_ARGS refusal. */
function parsePlan(
  raw: unknown
):
  | { ok: true; plan: Pick<MissionStep, 'title' | 'verification' | 'links'>[] }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, plan: [] }
  const bad = {
    ok: false as const,
    error: `BAD_ARGS: steps must be an array of at most ${MISSION_PLAN_MAX} { title (1..200 chars), verification (${STEP_VERIFICATIONS.join(' | ')}) }.`
  }
  if (!Array.isArray(raw) || raw.length > MISSION_PLAN_MAX) return bad
  const plan: Pick<MissionStep, 'title' | 'verification' | 'links'>[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return bad
    const r = item as Record<string, unknown>
    const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : ''
    if (!title || title.length > 200) return bad
    if (!STEP_VERIFICATIONS.includes(r.verification as MissionStep['verification'])) return bad
    plan.push({ title, verification: r.verification as MissionStep['verification'], links: [] })
  }
  return { ok: true, plan }
}

/**
 * `mission_add_step`'s `links` (Mission v3 §3.9 — a step can be born provable):
 * the same shapes `mission_link_child` takes, deduped. A session ref must be a
 * Claude session UUID, like everywhere else.
 */
function parseStepLinks(
  raw: unknown
): { ok: true; links: StepLink[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, links: [] }
  const bad = {
    ok: false as const,
    error:
      'BAD_ARGS: links must be an array of at most 20 { kind: session | worktree | card | pr, ref }.'
  }
  if (!Array.isArray(raw) || raw.length > 20) return bad
  const links: StepLink[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return bad
    const r = item as Record<string, unknown>
    const ref = typeof r.ref === 'string' ? r.ref.trim() : ''
    const kind = r.kind
    if (kind !== 'session' && kind !== 'worktree' && kind !== 'card' && kind !== 'pr') return bad
    if (!ref) return bad
    if (kind === 'session' && !SESSION_UUID_RE.test(ref)) {
      return { ok: false, error: badSessionIdMessage('links.ref', ref) }
    }
    if (!links.some((l) => l.kind === kind && l.ref === ref)) links.push({ kind, ref })
  }
  return { ok: true, links }
}

/** Most scope documents `mission_create` attaches (Mission v2 §3.1, v3 §3.3). */
const MISSION_SCOPE_MAX = 20

/**
 * Why a physically-resolved path cannot prove "Scope confirmed" (Mission v2
 * §3.1, BUG-145): it lies outside the repo, it is the repo root, it has a
 * `.git` / `.harnu` (or legacy `.capy`) component at any depth, or it is — or is inside — a git
 * checkout (a directory holding a `.git` entry, file or dir: a linked worktree,
 * a submodule, a nested clone) or Harnu's worktree home `.claude/worktrees`.
 * All of those exist in, or next to, every repo, so like the root they would
 * prove the step trivially. Components compare case-insensitively (a
 * case-insensitive file system resolves `.HARNU` to `.harnu`). `null` = a scope
 * path.
 */
type ScopeTargetProblem = 'outside' | 'root' | 'internal' | 'checkout'

async function scopeTargetProblem(
  real: string,
  realRoot: string
): Promise<ScopeTargetProblem | null> {
  if (real === realRoot) return 'root'
  if (!isInside(real, realRoot)) return 'outside'
  const parts = path.relative(realRoot, real).split(path.sep)
  const lower = parts.map((c) => c.toLowerCase())
  if (lower.some((c) => c === '.git' || c === DATA_DIR || LEGACY_DATA_DIRS.includes(c)))
    return 'internal'
  if (lower[0] === '.claude' && lower[1] === 'worktrees') return 'checkout'
  // The path itself, or any directory between the root and it, being a checkout.
  // Fails CLOSED: only "no such entry" (ENOENT / ENOTDIR) means no `.git` there;
  // any other error (EACCES on an unsearchable dir, …) could hide one, so it
  // counts as a checkout rather than as proof there is none.
  for (let i = 1; i <= parts.length; i++) {
    try {
      await fs.lstat(path.join(realRoot, ...parts.slice(0, i), '.git'))
      return 'checkout'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'checkout'
    }
  }
  return null
}

const SCOPE_PROBLEM_TEXT: Record<ScopeTargetProblem, string> = {
  outside: 'resolves outside the repo',
  root: 'is the repo root',
  internal: 'is inside .git, .harnu or .capy',
  checkout: 'is a worktree checkout (or inside one)'
}

function badScopePathMessage(p: string, problem: ScopeTargetProblem): string {
  const why: Record<ScopeTargetProblem, string> = {
    outside:
      'is outside this repo — scope paths (and paths linked to the fixed start) are files or directories inside the repo.',
    root: 'is the repo root — name the scope documents, not the repo.',
    internal:
      "is inside .git, .harnu or .capy — git internals and Harnu's own state exist in every repo and prove nothing about the scope; name the scope documents.",
    checkout:
      "is a worktree checkout (or inside one) — a linked worktree, a nested clone or Harnu's .claude/worktrees is another checkout, not this repo's scope documents."
  }
  return `BAD_SCOPE_PATH: ${JSON.stringify(p)} ${why[problem]}`
}

/** Most symlinks one scope path may traverse before it counts as a loop (Linux's MAXSYMLINKS). */
const SCOPE_MAX_SYMLINKS = 40

/** `x`'s components after its root, e.g. `/a/b/../c` → `['a', 'b', '..', 'c']`. */
function pathComponents(x: string): string[] {
  return x
    .slice(path.parse(x).root.length)
    .split(/[\\/]+/)
    .filter((c) => c !== '' && c !== '.')
}

/**
 * Where `p` (absolute, NOT normalized) lands on disk, resolved one component at
 * a time the way the kernel does: every symlink is followed through `readlink`
 * (relative to the link's directory), `..` is taken physically, and a DANGLING
 * link is resolved to its would-be target instead of being dropped — so a link
 * whose target outside the repo does not exist yet still resolves outside. The
 * first missing component ends the walk; the rest joins lexically. Throws after
 * {@link SCOPE_MAX_SYMLINKS} links (a loop).
 */
async function resolvePhysicalPath(p: string): Promise<string> {
  let cur = path.parse(p).root
  const pending = pathComponents(p)
  let links = 0
  while (pending.length > 0) {
    const comp = pending.shift()!
    if (comp === '..') {
      cur = path.dirname(cur)
      continue
    }
    const next = path.join(cur, comp)
    let isLink: boolean
    try {
      isLink = (await fs.lstat(next)).isSymbolicLink()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return path.resolve(next, ...pending)
      throw err
    }
    if (!isLink) {
      cur = next
      continue
    }
    if (++links > SCOPE_MAX_SYMLINKS) throw new Error(`too many symlinks resolving ${p}`)
    const target = await fs.readlink(next)
    if (path.isAbsolute(target)) cur = path.parse(target).root
    pending.unshift(...pathComponents(target))
  }
  return cur
}

/**
 * One path for the fixed start — a `scope` entry, or a `worktree` link placed on
 * the fixed start by `mission_link_child` (Mission v2 §3.1, BUG-145). Resolved
 * PHYSICALLY ({@link resolvePhysicalPath}): a symlink anywhere on the path is
 * followed to its target, existing or not, and `..` climbs from where a link
 * lands. Refused `BAD_SCOPE_PATH` when that lands outside the repo, on the repo
 * root, or under `.git` / `.harnu` / `.capy` ({@link scopeTargetProblem}). What is returned
 * — and stored — is the repo-relative path that was checked, never the caller's
 * spelling, so what is stored is what is proven. A path that does not exist yet
 * is accepted: the fixed start stays unproven until it does. This only probes
 * paths, never reads a file, so it is not the legacy import's O_NOFOLLOW reader.
 */
async function checkScopePath(
  root: string,
  p: string
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
  const trimmed = p.trim()
  // Unnormalized on purpose: `link/..` must climb from where the link lands.
  const unnormalized = path.isAbsolute(trimmed) ? trimmed : `${root}${path.sep}${trimmed}`
  let realRoot: string
  let real: string
  try {
    realRoot = await fs.realpath(root)
    real = await resolvePhysicalPath(unnormalized)
  } catch {
    return { ok: false, error: badScopePathMessage(p, 'outside') }
  }
  const problem = await scopeTargetProblem(real, realRoot)
  if (problem) return { ok: false, error: badScopePathMessage(p, problem) }
  return { ok: true, ref: path.relative(realRoot, real) }
}

/**
 * `mission_create`'s `scope` as `worktree` links for the fixed start (Mission v2
 * §3.1): each entry checked by {@link checkScopePath}, deduped by the stored
 * path. Read time re-checks containment ({@link scopeLinkProblems}), since a
 * path accepted here can later be swapped for a symlink.
 */
async function resolveScopeLinks(
  root: string,
  raw: unknown
): Promise<{ ok: true; links: StepLink[] } | { ok: false; error: string }> {
  if (raw === undefined) return { ok: true, links: [] }
  if (
    !Array.isArray(raw) ||
    raw.length > MISSION_SCOPE_MAX ||
    raw.some((p) => typeof p !== 'string' || p.trim().length === 0)
  ) {
    return {
      ok: false,
      error: `BAD_ARGS: scope must be an array of at most ${MISSION_SCOPE_MAX} non-empty repo-relative paths.`
    }
  }
  const refs: string[] = []
  for (const p of raw as string[]) {
    const checked = await checkScopePath(root, p)
    if (!checked.ok) return checked
    if (!refs.includes(checked.ref)) refs.push(checked.ref)
  }
  return { ok: true, links: refs.map((ref) => ({ kind: 'worktree', ref })) }
}

type MissionWrite = { ok: true; mission: Mission } | { ok: false; error: string }

/**
 * Mint a fresh id and a repo-unique slug (from `title`) and exclusively write the
 * mission `build` returns, with `log` as its body. Runs under the repo's create
 * lock, so concurrent creates never pick the same slug; `precheck` (a refusal it
 * returns aborts the write) runs inside that lock too, so a check against the
 * missions already on disk cannot race another create. `createMissionFile`
 * rejects EEXIST on a genuine id collision (another Harnu process, or a file this
 * scan raced) — the id is redrawn rather than failing the call.
 */
async function writeNewMission(
  root: string,
  title: string,
  build: (id: string, slug: string, now: string) => Mission,
  log: string,
  precheck?: (entries: MissionFileEntry[]) => Promise<string | null>
): Promise<MissionWrite> {
  return serializeByKey(missionCreateLocks, root, async (): Promise<MissionWrite> => {
    const entries = await listMissionEntries(root)
    const refused = precheck ? await precheck(entries) : null
    if (refused) return { ok: false, error: refused }
    const takenIds = entries.map((e) => e.id)
    const slug = resolveUniqueSlug(missionSlugBase(title), new Set(entries.map((e) => e.slug)))
    for (let attempt = 0; attempt < 4; attempt++) {
      const mission = build(mintMissionId(takenIds), slug, new Date().toISOString())
      try {
        await createMissionFile(root, mission, log)
        return { ok: true, mission }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          return { ok: false, error: `WRITE_FAILED: ${(err as Error).message}` }
        }
        takenIds.push(mission.id)
      }
    }
    return { ok: false, error: 'WRITE_FAILED: could not mint a free mission id' }
  })
}

const missionCreateHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const title = strField(args, 'title')?.replace(/\s+/g, ' ').trim()
  if (!title) return errorResult('BAD_ARGS: title is required')
  const problems = declaredEndProblems(args.declaredEnd)
  if (problems.length > 0) {
    return errorResult(
      `DECLARED_END_INCOMPLETE: missing or invalid ${problems.join(', ')} — a mission needs a complete declared end at creation: kind (${DECLARED_END_KINDS.join(' | ')}), a concrete target, and the evidence that proves it (design decision 5). There is no "draft with no target" state.`
    )
  }
  const rawEnd = args.declaredEnd as Record<string, string>
  const declaredEnd: DeclaredEnd = {
    kind: rawEnd.kind as DeclaredEnd['kind'],
    target: rawEnd.target.trim(),
    evidence: rawEnd.evidence.trim()
  }
  const sessionId = strField(args, 'sessionId') ?? ''
  if (!SESSION_UUID_RE.test(sessionId))
    return errorResult(badSessionIdMessage('sessionId', sessionId))
  const linkedCard = strField(args, 'linkedCard')

  const root = missionRoot(folder)
  // The gate checked the raw `folder` arg; a worktree outside its main checkout's
  // tree would slip past it and write into a blocked root. Check the root too.
  const refusal = missionFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)
  const plan = parsePlan(args.steps)
  if (!plan.ok) return errorResult(plan.error)
  const scope = await resolveScopeLinks(root, args.scope)
  if (!scope.ok) return errorResult(scope.error)
  const { gitBranch } = await probeGitMeta(folder)

  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before writing.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')

  const created = await writeNewMission(
    root,
    title,
    (id, slug, now) => ({
      id,
      slug,
      folder: root,
      owner: { sessionId, folder: path.resolve(folder) },
      ...(linkedCard ? { linkedCard } : {}),
      // Mission v3 §3.4: born active — the end agreed in chat is the agreement.
      status: 'active',
      declaredEnd,
      declaredEndApproval: { at: now, bodyHash: declaredEndHash(declaredEnd), via: 'chat' },
      // Mission v3 §3.3: scope is an attachment, never a step.
      ...(scope.links.length > 0 ? { scope: scope.links } : {}),
      steps: planWithEnd(plan.plan),
      blockers: [],
      openQuestions: [],
      createdAt: now,
      updatedAt: now,
      provenance: { author: 'agent', at: now, ...(gitBranch ? { branch: gitBranch } : {}) }
    }),
    // The title has no Mission field (design §1.1); it heads the Log body.
    `# ${title}\n\n## Log\n`
  )
  if (!created.ok) return errorResult(created.error)
  return textResult({
    ok: true,
    op: 'mission_create',
    missionId: created.mission.id,
    slug: created.mission.slug,
    steps: created.mission.steps,
    ...(created.mission.scope ? { scope: created.mission.scope } : {})
  })
}

// ---- T358 S7: legacy goal-file migration (design §9) -------------------------

/** Past this, a legacy file is refused rather than carried in every mission rewrite. */
const LEGACY_MAX_BYTES = 1024 * 1024

/** A bare board id (`T231`, `BUG-42`) — a card link the import may resolve to a slug. */
const BARE_CARD_ID_RE = /^(?:T\d+|BUG-\d+)$/

function badLegacyPathMessage(legacyPath: string): string {
  return `BAD_LEGACY_PATH: "${legacyPath}" is not a .md file under this folder's (or its main checkout's) .harnu/goals/ — mission_import_legacy only reads legacy goal files.`
}

/** `p` is strictly inside `dir`. */
function isInside(p: string, dir: string): boolean {
  return p.startsWith(dir + path.sep)
}

/** Test seam: runs between validation and the open (TOCTOU tests only). */
let legacyImportBeforeOpen: (() => Promise<void>) | null = null
export function _setLegacyImportBeforeOpen(fn: (() => Promise<void>) | null): void {
  legacyImportBeforeOpen = fn
}

type LegacyRead = { ok: true; file: string; bytes: Buffer } | { ok: false; error: string }

/**
 * Validate `legacyPath` and read it — reading exactly what was validated. The
 * target must be a `.md` file inside `<folder>/.harnu/goals/` or
 * `<root>/.harnu/goals/`, checked lexically (no `..` escape, no other directory),
 * with `.harnu` and `.harnu/goals` themselves real directories (never symlinks),
 * and after `realpath` (a symlink planted in goals/ must not reach outside it).
 * Every check after the lexical one is against the ONE base whose goals/ holds
 * the path — never "inside any goals dir": the realpath must sit under the
 * realpath of that same base's goals/.
 *
 * Check-then-read would let a process that can write goals/ swap a path between
 * the check and the read (PR #385 review). So the file is opened ONCE, by the
 * validated real path with `O_NOFOLLOW` (the final component cannot be a symlink
 * swapped in since), the handle is `fstat`ed (regular file, size cap), and after
 * the open the path must STILL resolve inside goals/ to the very inode the
 * handle holds — a directory swapped for a symlink in between fails that. The
 * bytes then come from the handle, never from a fresh path lookup. Returns the
 * lexical absolute path — the one recorded as `source`.
 */
async function readLegacyGoalFile(
  folder: string,
  root: string,
  legacyPath: string
): Promise<LegacyRead> {
  const bad: LegacyRead = { ok: false, error: badLegacyPathMessage(legacyPath) }
  await Promise.all([dataDirReady(folder), dataDirReady(root)])
  const file = path.resolve(folder, legacyPath)
  const goalDirs = [...new Set([path.resolve(folder), root])].map((b) =>
    path.join(dataDirAt(b), 'goals')
  )
  // The ONE base whose goals/ lexically holds `file`. Containment is then judged
  // against that base alone: a union across bases would let a symlink in one
  // base's goals/ reach through the other base's symlinked goals/ (delta 3).
  const holders = goalDirs.filter((d) => isInside(file, d))
  if (!/\.md$/i.test(file) || holders.length !== 1) return bad
  const goals = holders[0]
  // `.harnu` and `.harnu/goals` of that base must be real directories: were either a
  // symlink already, realpath would resolve "inside goals/" to wherever it points
  // (delta 2 of the S7 review).
  for (const dir of [path.dirname(goals), goals]) {
    const st = await fs.lstat(dir).catch(() => null)
    if (st?.isSymbolicLink()) return bad
  }
  // Resolved ONCE, at validation: re-resolving after the open would let a goals/
  // directory swapped for a symlink redefine what "inside goals/" means.
  const realGoals = await fs.realpath(goals).catch(() => goals)
  let real: string
  try {
    real = await fs.realpath(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        error: `LEGACY_NOT_FOUND: no goal file at ${file} — list .harnu/goals/ to see the ones that exist.`
      }
    }
    throw err
  }
  if (!isInside(real, realGoals)) return bad

  await legacyImportBeforeOpen?.()
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        ok: false,
        error: `LEGACY_NOT_FOUND: no goal file at ${file} — it disappeared during the import.`
      }
    }
    if (code === 'ELOOP' || code === 'EISDIR') return bad
    throw err
  }
  try {
    const held = await handle.stat()
    if (!held.isFile()) return bad
    // The opened path must still resolve inside the same goals/, to the inode this handle holds.
    const again = await fs.realpath(real).catch(() => null)
    const now = again && isInside(again, realGoals) ? await fs.stat(again).catch(() => null) : null
    if (!now || now.dev !== held.dev || now.ino !== held.ino) return bad
    if (held.size > LEGACY_MAX_BYTES) {
      return {
        ok: false,
        error: `LEGACY_TOO_LARGE: ${file} is ${held.size} bytes — over the ${LEGACY_MAX_BYTES}-byte cap a mission record carries. Nothing was written.`
      }
    }
    // Read-only, and only ever read: the source is never written, moved or deleted.
    const bytes = await handle.readFile()
    if (bytes.length > LEGACY_MAX_BYTES) {
      return {
        ok: false,
        error: `LEGACY_TOO_LARGE: ${file} grew past the ${LEGACY_MAX_BYTES}-byte cap while it was read. Nothing was written.`
      }
    }
    return { ok: true, file, bytes }
  } finally {
    await handle.close()
  }
}

const missionImportLegacyHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const legacyPath = strField(args, 'legacyPath')?.trim()
  if (!legacyPath) return errorResult('BAD_ARGS: legacyPath is required')
  const root = missionRoot(folder)
  const refusal = missionFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)
  const sessionArg = strField(args, 'sessionId')
  if (sessionArg !== undefined && !SESSION_UUID_RE.test(sessionArg)) {
    return errorResult(badSessionIdMessage('sessionId', sessionArg))
  }

  const read = await readLegacyGoalFile(folder, root, legacyPath)
  if (!read.ok) return errorResult(read.error)
  const { file: source, bytes } = read
  const raw = bytes.toString('utf8')
  if (!Buffer.from(raw, 'utf8').equals(bytes)) {
    return errorResult(
      `LEGACY_NOT_UTF8: ${source} is not valid UTF-8, so it cannot be kept byte-for-byte in legacyRaw — nothing was written. Re-save it as UTF-8 and import again.`
    )
  }
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const imported = importLegacyGoalFile(raw, {
    now: new Date().toISOString(),
    fileName: path.basename(source)
  })
  const owner = sessionArg ?? imported.session
  if (!owner) {
    return errorResult(
      `BAD_SESSION_ID: ${source} names no session UUID in its frontmatter — pass sessionId (your own Claude session UUID) to own the imported mission.`
    )
  }

  // A bare card id resolves to its board slug when exactly one card carries it,
  // so the derived signals (design §7) can read that card's state.
  const slugs = await listCardSlugs(root).catch(() => [] as string[])
  const steps = imported.steps.map((step) => ({
    ...step,
    links: step.links.map((l) => {
      if (l.kind !== 'card' || !BARE_CARD_ID_RE.test(l.ref)) return l
      const hits = slugs.filter((sl) => sl === l.ref || sl.startsWith(`${l.ref}-`))
      return hits.length === 1 ? { kind: l.kind, ref: hits[0] } : l
    })
  }))
  // Mission v3 §3.3: the v3 shape — the imported units, numbered from stp-1, then
  // the fixed end; no fixed start (a goal file names no scope documents).
  const ends = planWithEnd([])
  const allSteps: MissionStep[] = [
    ...steps.map((st, i) => ({ ...st, id: `stp-${i + 1}`, ordinal: i + 1 })),
    { ...ends[0], id: `stp-${steps.length + 1}`, ordinal: steps.length + 1 }
  ]
  const { gitBranch } = await probeGitMeta(folder)

  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before writing.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')

  const created = await writeNewMission(
    root,
    imported.title,
    (id, slug, now) => ({
      id,
      slug,
      folder: root,
      owner: { sessionId: owner, folder: path.resolve(folder) },
      // Mission v3 §3.4: no draft. A placeholder end (legacy.needsReview) is put
      // on the operator's `you` list instead, until a re-scope is approved.
      status: 'active',
      declaredEnd: imported.declaredEnd,
      steps: allSteps,
      blockers: imported.blockers,
      openQuestions: imported.openQuestions,
      createdAt: now,
      updatedAt: now,
      provenance: { author: 'agent', at: now, ...(gitBranch ? { branch: gitBranch } : {}) },
      legacy: { source, sha256, needsReview: imported.needsReview },
      legacyRaw: imported.legacyRaw
    }),
    // The legacy Log section is carried over verbatim (design §9), under the title.
    `# ${imported.title}\n\n## Log\n${imported.log}`,
    async (entries) => {
      for (const e of entries) {
        const loaded = await loadMission(root, e.id)
        if (loaded.ok && loaded.mission.legacy?.source === source) {
          return `ALREADY_IMPORTED: ${source} was already imported as mission ${e.id} — mission_get it instead of importing twice.`
        }
      }
      return null
    }
  )
  if (!created.ok) return errorResult(created.error)
  return textResult({
    ok: true,
    op: 'mission_import_legacy',
    missionId: created.mission.id,
    slug: created.mission.slug,
    extractedFields: imported.extractedFields,
    needsReview: imported.needsReview,
    legacyPreserved: true
  })
}

/** The `you` line when the operator owes this mission nothing (design §4). */
const YOU_CLEAR = "— nothing, you're clear"

/**
 * Mission v3 §3.12 — one thing the operator owes a mission. `mission_get` reports
 * the whole ordered list as `youItems` (and its first item as the `you` line);
 * the UI translates each item and shows "+N more" below the first.
 */
export type MissionYouItem =
  | { kind: 'rescope'; end: DeclaredEnd }
  | { kind: 'close' }
  | { kind: 'blocker'; reason: string; unblocks: string }
  | { kind: 'checks'; count: number; stepIds: string[] }
  | { kind: 'human-steps'; stepIds: string[] }
  | { kind: 'review-import' }
  | { kind: 'approvals'; count: number; sessionId: string }
  | { kind: 'needs-input'; sessionId: string }

/**
 * What the operator owes this mission (Mission v3 §3.12), in this order: a
 * re-scope to approve, a pending close, each operator-owned blocker, the due
 * checks (unticked checks on a reached step — not `todo`/`blocked`), the `human`
 * steps that are current or left behind and not ticked, an imported end to
 * review, and the linked children's parked approvals and needs-input. A closed
 * mission owes nothing. A dead legacy draft (read as active) owes nothing either:
 * stale is not an owed kind.
 */
export function youItems(
  m: Mission,
  children: readonly MissionChildState[],
  progress: MissionProgress
): MissionYouItem[] {
  if (m.status === 'closed') return []
  const items: MissionYouItem[] = []
  if (m.pendingRescope) items.push({ kind: 'rescope', end: m.pendingRescope })
  if (m.pendingClose) items.push({ kind: 'close' })
  for (const b of [...m.blockers, ...m.steps.flatMap((s) => s.blockers)]) {
    if (b.owner === 'operator')
      items.push({ kind: 'blocker', reason: b.reason, unblocks: b.unblocks })
  }
  const reached = (stepId: string): boolean => {
    const st = progress.states[stepId]
    return st !== undefined && st !== 'todo' && st !== 'blocked'
  }
  const due = m.steps.flatMap((s) =>
    reached(s.id) ? (s.checks ?? []).filter((c) => !c.ticked).map(() => s.id) : []
  )
  if (due.length > 0) items.push({ kind: 'checks', count: due.length, stepIds: [...new Set(due)] })
  // A `human` step is the operator's gate: it is owed until the OPERATOR ticks it
  // (proof verified by the 'operator' verifier) — a claim by the owner reads `done`
  // in progress but never clears it, and a gate the work moved past (a later step
  // running, or the mission otherwise reached it) must not drop off the list.
  const current = progress.current
  const counted = m.steps.filter((s) => s.kind !== 'fixed-start')
  const humans = counted
    .filter((s, i) => {
      if (s.verification !== 'human') return false
      if (s.proof === 'verified' && s.verifiedBy?.sessionId === OPERATOR_VERIFIER) return false
      const isCurrent = current !== null && i + 1 >= current.from && i + 1 <= current.to
      return reached(s.id) || isCurrent || progress.leftBehind.includes(s.id)
    })
    .map((s) => s.id)
  if (humans.length > 0) items.push({ kind: 'human-steps', stepIds: humans })
  if (m.legacy?.needsReview.includes('declaredEnd')) items.push({ kind: 'review-import' })
  for (const c of children) {
    if (c.pendingApprovals > 0) {
      items.push({ kind: 'approvals', count: c.pendingApprovals, sessionId: c.sessionId })
    }
  }
  for (const c of children) {
    if (c.taskState === 'needs-input') items.push({ kind: 'needs-input', sessionId: c.sessionId })
  }
  return items
}

/** One {@link MissionYouItem} as an English sentence. */
function youSentence(item: MissionYouItem): string {
  const s = (n: number): string => (n === 1 ? '' : 's')
  switch (item.kind) {
    case 'rescope':
      return `Approve the new declared end (${item.end.kind}: ${item.end.target}).`
    case 'close':
      return 'Close the mission — its end is verified and a close was requested.'
    case 'blocker':
      return `Unblock: ${item.reason} — unblocks when ${item.unblocks}.`
    case 'checks':
      return `Tick ${item.count} due check${s(item.count)} — on ${item.stepIds.join(', ')}.`
    case 'human-steps':
      return `Confirm the human step${s(item.stepIds.length)} ${item.stepIds.join(', ')}.`
    case 'review-import':
      return 'Review the imported end — it is a placeholder until you approve a re-scope.'
    case 'approvals':
      return `Answer ${item.count} pending approval${s(item.count)} in the Approval Inbox — from linked session ${item.sessionId.slice(0, 8)}.`
    case 'needs-input':
      return `Linked session ${item.sessionId.slice(0, 8)} is waiting on you (needs-input) — open it and answer.`
  }
}

/** The `you` line `mission_get` reports: the first item, plus "(+N more)". */
export function youLine(items: readonly MissionYouItem[]): string {
  if (items.length === 0) return YOU_CLEAR
  const more = items.length > 1 ? ` (+${items.length - 1} more)` : ''
  return `${youSentence(items[0])}${more}`
}

// ---- T358 S6: derived live signals + the stall rule (design §7, §8) ---------

/** design §8 — a mission with no new evidence for longer than this, and no linked session working, is stale. */
export const MISSION_STALL_AFTER_MS = 60 * 60 * 1000

/**
 * The last observed `taskState` TRANSITION per session — design §8's "any
 * linked session's last taskState transition". Fed by the hook FSM's in-main
 * edge; a repeated event that leaves the state unchanged is not a transition.
 * In-memory: after a Harnu restart only transitions since then are known, which
 * can only make evidence look OLDER, never fresher than it is.
 */
const lastTransitions = new Map<string, { state: TaskState; at: number }>()
/** Bound on {@link lastTransitions} — the oldest entry is dropped past it. */
const LAST_TRANSITIONS_MAX = 2000

addTaskEventObserver((ev) => {
  const prev = lastTransitions.get(ev.sessionId)
  if (prev?.state === ev.taskState) return
  lastTransitions.delete(ev.sessionId) // re-insert last: Map order = recency
  lastTransitions.set(ev.sessionId, { state: ev.taskState, at: ev.ts })
  if (lastTransitions.size > LAST_TRANSITIONS_MAX) {
    const oldest = lastTransitions.keys().next().value
    if (oldest !== undefined) lastTransitions.delete(oldest)
  }
})

/** What {@link evaluateMissionStall} decided, and from what — reported verbatim in the ACK. */
export interface MissionStall {
  stale: boolean
  /** ISO time of the newest evidence; `null` only when no timestamp parsed at all. */
  lastEvidenceAt: string | null
  thresholdMs: number
  /** Linked sessions whose `taskState` is `working` — any one of them keeps the mission active. */
  workingSessions: string[]
}

/** Every `### <ISO>` heading `mission_log` writes into the Log body. */
function missionLogTimestamps(log: string): string[] {
  return [...log.matchAll(/^### (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/gm)].map((m) => m[1])
}

/**
 * design §8, exactly, with no model call:
 *
 *     stale := (mission.status == 'active')
 *           && (now - lastEvidenceAt > 1h)
 *           && every linked session's taskState != 'working'
 *
 * `lastEvidenceAt` = max of the mission's `updatedAt`, its steps' and blockers'
 * own timestamps, every `mission_log` entry, and every linked session's last
 * `taskState` transition. The verdict lives only in `mission_get`'s `derived`
 * block — `stale` is never written to the stored status (§3), so the rule
 * always reads the operator-approved `active`, and `draft`/`delivered`/`closed`
 * never go stale. Pure; `now` is injected.
 */
export function evaluateMissionStall(
  mission: Mission,
  log: string,
  children: readonly Pick<MissionChildState, 'sessionId' | 'taskState' | 'lastTransitionAt'>[],
  now: number
): MissionStall {
  const stamps = [
    mission.updatedAt,
    ...mission.blockers.map((b) => b.raisedAt),
    ...mission.steps.flatMap((s) => [
      ...(s.verifiedBy ? [s.verifiedBy.at] : []),
      ...s.blockers.map((b) => b.raisedAt)
    ]),
    ...missionLogTimestamps(log),
    ...children.flatMap((c) => (c.lastTransitionAt ? [c.lastTransitionAt] : []))
  ]
  const last = stamps.map((t) => Date.parse(t)).filter(Number.isFinite)
  const lastMs = last.length > 0 ? Math.max(...last) : null
  const workingSessions = children.filter((c) => c.taskState === 'working').map((c) => c.sessionId)
  const stale =
    mission.status === 'active' &&
    (lastMs === null || now - lastMs > MISSION_STALL_AFTER_MS) &&
    workingSessions.length === 0
  return {
    stale,
    lastEvidenceAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    thresholdMs: MISSION_STALL_AFTER_MS,
    workingSessions
  }
}

/** A PR as a mission reports it — the canvas's `PrEntry`, trimmed to what an owner reads. */
export interface MissionPrSummary {
  number: number
  title: string
  state: PrEntry['state']
  isDraft: boolean
  ci: PrEntry['ci']
  url: string
  /** The branch the PR merges INTO (Mission v2 §3.6) — informative, no derived flag. */
  baseRefName: string
}

function prSummary(p: PrEntry): MissionPrSummary {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    ci: p.ci,
    url: p.url,
    baseRefName: p.base
  }
}

/** One resolved non-session link (design §7): what it points at, and whether that exists. */
export type MissionLinkSignal =
  | {
      kind: 'worktree'
      ref: string
      exists: boolean
      branch: string | null
      head: { sha: string; subject: string; at: string } | null
      prs: MissionPrSummary[]
      /**
       * Mission v3 §3.7 — the path is gone, but its branch was seen with this
       * merged PR: the link stays resolved (Reaper/dehydrate cleanup does not
       * undo proof). Present only with `stale: true`.
       */
      mergedPr?: number
      /** Mission v3 §3.7 — resolved from the last-known state, not a live read. */
      stale?: true
    }
  | {
      kind: 'card'
      ref: string
      exists: boolean
      status?: string
      executedIn?: string
      prs: MissionPrSummary[]
    }
  | {
      kind: 'pr'
      ref: string
      number: number | null
      exists: boolean
      state?: PrEntry['state']
      url?: string
      /** The branch the PR merges INTO (Mission v2 §3.6); absent when the PR is unknown. */
      baseRefName?: string
      /**
       * Mission v3 §3.7 — GitHub could not say (unreachable, or the PR is not
       * among the recent ones): the last-known state is shown, or, if the link
       * never resolved, it reads unknown (`exists: false`). Never a downgrade.
       */
      stale?: true
    }

export interface MissionStepSignals {
  stepId: string
  /** Live state of this step's `session` links, from the scoped fleet projection. */
  children: MissionChildState[]
  /** This step's `worktree`/`card`/`pr` links, resolved. */
  links: MissionLinkSignal[]
  /** Computed proof for an `existence`-level step; `null` for any other level. */
  existence: { proven: boolean; reason?: string } | null
}

/** The PR number a `pr` link names: `owner/repo#123`, `#123`, `123` or a `/pull/123` URL. */
function prNumberOf(ref: string): number | null {
  const m = /(?:#|\/pull\/|^)(\d+)\/?\s*$/.exec(ref.trim())
  return m ? Number(m[1]) : null
}

/**
 * A `worktree` link's ref as an absolute path (a relative one is read from the repo root).
 * A stored `.harnu/…` ref resolves under the current data dir, so links written before
 * the rename keep resolving (the mission file itself is never rewritten).
 */
export function linkPath(root: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.resolve(root, mapLegacyDataPath(ref))
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * The fixed start's `worktree` links (repo-relative or absolute) that cannot
 * prove it right now, with why ({@link scopeTargetProblem}): a path accepted at
 * create/link time can later be swapped for a symlink out of the repo, and a
 * mission written before BUG-145 may hold an absolute path, the root or `.git`
 * — so the existence proof re-checks every one, by `realpath`, on every read
 * (Mission v2 §3.1). Only paths that exist are checked; a missing one is
 * already unproven. `worktree` links on every other step resolve as before.
 */
async function scopeLinkProblems(
  root: string,
  scopeLinks: readonly StepLink[]
): Promise<Map<string, ScopeTargetProblem>> {
  const problems = new Map<string, ScopeTargetProblem>()
  const refs = scopeLinks.filter((l) => l.kind === 'worktree')
  if (refs.length === 0) return problems
  let realRoot: string | null
  try {
    realRoot = await fs.realpath(root)
  } catch {
    // Fails closed: with no resolvable root, no link can be shown to be inside it.
    realRoot = null
  }
  for (const l of refs) {
    const p = linkPath(root, l.ref)
    if (!(await pathExists(p))) continue
    let problem: ScopeTargetProblem | null
    try {
      problem = realRoot ? await scopeTargetProblem(await fs.realpath(p), realRoot) : 'outside'
    } catch {
      // It existed a moment ago; unresolvable now is not proof of containment.
      problem = 'outside'
    }
    if (problem) problems.set(l.ref, problem)
  }
  return problems
}

/** Is this resolved link the artifact it claims (design §7 — PR open/merged, card in review/done)? */
function linkResolves(l: MissionLinkSignal): boolean {
  if (l.kind === 'worktree') return l.exists || l.mergedPr !== undefined
  if (l.kind === 'card') return l.exists && (l.status === 'review' || l.status === 'done')
  return l.exists
}

function existenceOf(
  links: readonly MissionLinkSignal[],
  gh: MissionPrJoin['ghAvailable']
): { proven: boolean; reason?: string } {
  if (links.length === 0) {
    return {
      proven: false,
      reason: 'no artifact link (a path in the repo, a card or a PR) to check'
    }
  }
  const failing = links.find((l) => !linkResolves(l))
  if (!failing) return { proven: true }
  if (failing.kind === 'pr' && gh === false) {
    return { proven: false, reason: `gh is unavailable — PR ${failing.ref} cannot be checked` }
  }
  const why =
    failing.kind === 'card'
      ? failing.exists
        ? `is in ${failing.status}, not review/done`
        : 'is not on the board'
      : failing.kind === 'pr'
        ? failing.state
          ? `is ${failing.state}`
          : 'was not found'
        : 'does not exist'
  return { proven: false, reason: `${failing.kind} ${failing.ref} ${why}` }
}

/**
 * Mission v3 §3.3 — the scope attachment, resolved: each path link and whether
 * every one exists inside the repo right now. Never part of progress; the popover
 * reads an unresolved path as "on a branch". The same read-time containment
 * re-check (BUG-145) a legacy fixed start had applies.
 */
export interface MissionScopeSignals {
  links: MissionLinkSignal[]
  resolved: { proven: boolean; reason?: string }
}

/** Everything `mission_get` derives (design §7, §8). */
export interface MissionDerived {
  live: true
  computedAt: string
  stale: boolean
  stall: MissionStall
  /** Whether PR data was read: `not-needed` when no link asked for it. */
  gh: 'available' | 'unavailable' | 'not-needed'
  /** Approval Inbox requests parked by linked sessions right now. */
  pendingApprovals: number
  scope: MissionScopeSignals
  steps: MissionStepSignals[]
  /**
   * Mission v3 §3.1 — where the work is, computed ONCE here from the stored steps
   * and the live signals above. Every surface renders it; none recounts.
   */
  progress: MissionProgress
}

/**
 * Mission v3 §3.10 — the last progress every derive computed, per mission, so
 * `mission_list` can report it without deriving (it may be one poll old;
 * `computedAt` says when). Shared by the MCP and IPC paths (one main process).
 */
const lastProgress = new Map<string, MissionProgress>()
/** Bound on {@link lastProgress} — the oldest entry is dropped past it. */
const LAST_PROGRESS_MAX = 1000

function rememberProgress(missionId: string, progress: MissionProgress): void {
  lastProgress.delete(missionId) // re-insert last: Map order = recency
  lastProgress.set(missionId, progress)
  if (lastProgress.size > LAST_PROGRESS_MAX) {
    const oldest = lastProgress.keys().next().value
    if (oldest !== undefined) lastProgress.delete(oldest)
  }
}

/** The scoped live state of `ids` — never the unscoped fleet (design §7, T360 Q4). */
async function missionChildren(
  missionId: string,
  ids: readonly string[],
  ctx: ToolHandlerCtx
): Promise<MissionChildState[]> {
  if (ids.length === 0) return []
  const peers = new Map<string, { pid: number; socket: string }>()
  for (const id of ids) for (const [k, v] of await resolvePeerAddresses(id)) peers.set(k, v)
  const { sessionInputs } = toFleetInputs(ctx.folders, new Set(), hibernatedKeys(), peers)
  const lastTransitionAt: Record<string, number> = {}
  for (const id of ids) {
    const t = lastTransitions.get(id)
    if (t) lastTransitionAt[id] = t.at
  }
  return buildMissionFleetProjection(
    missionId,
    ids,
    {
      folders: [],
      sessions: sessionInputs,
      taskStates: taskStateRecord(),
      failureReasons: failureReasonRecord(),
      inflightAgentSessions: inflightToFleetInputs(listInflightSessions()),
      pendingApprovals: listPendingApprovals(),
      lastTransitionAt
    },
    { redactPaths: true, denyFolders: ctx.denyFolders, home: os.homedir() }
  ).sessions
}

/**
 * Derive design §7's live signals for one mission: each step's linked children
 * (scoped projection), its worktree/card/pr links joined to commits and PRs
 * (one `pr-stack` join for the whole mission), the computed existence proofs,
 * and §8's stall verdict. Read-only; computed fresh on every call.
 */
export async function deriveMissionSignals(
  root: string,
  mission: Mission,
  log: string,
  ctx: ToolHandlerCtx,
  now: number,
  /** `prWaitMs`: how long to wait for GitHub before reading the sticky last-known states. */
  opts: { prWaitMs?: number } = {}
): Promise<{ derived: MissionDerived; children: MissionChildState[] }> {
  const scopeLinks = missionScope(mission)
  const links = [...mission.steps.flatMap((s) => s.links), ...(mission.scope ?? [])]
  const sessionIds = [...new Set(links.filter((l) => l.kind === 'session').map((l) => l.ref))]
  const children = await missionChildren(mission.id, sessionIds, ctx)
  const childById = new Map(children.map((c) => [c.sessionId, c]))

  const cards = new Map<string, { status: string; executedIn?: string } | null>()
  for (const l of links) {
    if (l.kind !== 'card' || cards.has(l.ref)) continue
    try {
      const read = await readCard(root, l.ref)
      cards.set(
        l.ref,
        read.ok
          ? {
              status: read.card.status,
              ...(read.card.executedIn ? { executedIn: read.card.executedIn } : {})
            }
          : null
      )
    } catch {
      cards.set(l.ref, null)
    }
  }
  const worktreePaths = [
    ...new Set(links.filter((l) => l.kind === 'worktree').map((l) => linkPath(root, l.ref)))
  ]
  const branches = [
    ...new Set([...cards.values()].flatMap((c) => (c?.executedIn ? [c.executedIn] : [])))
  ]
  const numbers = [
    ...new Set(
      links.flatMap((l) => (l.kind === 'pr' ? [prNumberOf(l.ref)] : [])).filter((n) => n !== null)
    )
  ] as number[]
  const exists = new Map<string, boolean>()
  for (const p of worktreePaths) exists.set(p, await pathExists(p))
  // git/gh only for the paths that exist (a plain file link needs neither).
  const gitPaths = worktreePaths.filter((p) => exists.get(p))
  const join: MissionPrJoin =
    gitPaths.length + branches.length + numbers.length > 0
      ? await findPrsForWorktrees(
          root,
          { worktrees: gitPaths, branches, numbers },
          { waitMs: opts.prWaitMs }
        )
      : { ghAvailable: null, worktrees: {}, branches: {}, numbers: {} }

  // Mission v3 §3.7 — sticky proof: a link that resolved once keeps that state
  // through an unreachable GitHub or a PR that aged out of the recent list
  // (`stale: true`); only a contrary observation downgrades it. The last-known
  // states live in a userData sidecar — never in the mission file.
  await ensureLinkCacheLoaded()
  const resolve = (l: StepLink): MissionLinkSignal | null => {
    if (l.kind === 'worktree') {
      const p = linkPath(root, l.ref)
      const w = join.worktrees[p]
      const onDisk = exists.get(p) ?? false
      const merged = w?.prs.find((pr) => pr.state === 'MERGED')
      if (onDisk && merged && w?.branch) {
        rememberResolved(root, 'worktree', p, {
          state: 'MERGED',
          prNumber: merged.number,
          branch: w.branch
        })
      }
      const known = onDisk ? null : getLastKnown(root, 'worktree', p)
      if (known?.state === 'MERGED' && known.prNumber !== undefined) {
        return {
          kind: 'worktree',
          ref: l.ref,
          exists: false,
          branch: known.branch ?? null,
          head: null,
          prs: [],
          mergedPr: known.prNumber,
          stale: true
        }
      }
      return {
        kind: 'worktree',
        ref: l.ref,
        exists: onDisk,
        branch: w?.branch ?? null,
        head: w?.head ?? null,
        prs: (w?.prs ?? []).map(prSummary)
      }
    }
    if (l.kind === 'card') {
      const c = cards.get(l.ref)
      if (!c) return { kind: 'card', ref: l.ref, exists: false, prs: [] }
      return {
        kind: 'card',
        ref: l.ref,
        exists: true,
        status: c.status,
        ...(c.executedIn ? { executedIn: c.executedIn } : {}),
        prs: (c.executedIn ? (join.branches[c.executedIn] ?? []) : []).map(prSummary)
      }
    }
    if (l.kind === 'pr') {
      const number = prNumberOf(l.ref)
      if (number === null) return { kind: 'pr', ref: l.ref, number, exists: false }
      const pr = join.numbers[number] ?? null
      if (pr) {
        if (pr.state === 'OPEN' || pr.state === 'MERGED') {
          rememberResolved(root, 'pr', String(number), {
            state: pr.state,
            prNumber: number,
            url: pr.url,
            baseRefName: pr.base
          })
        } else {
          // Closed unmerged: the one contrary observation that downgrades.
          forgetResolved(root, 'pr', String(number))
        }
        return {
          kind: 'pr',
          ref: l.ref,
          number,
          exists: pr.state === 'OPEN' || pr.state === 'MERGED',
          state: pr.state,
          url: pr.url,
          baseRefName: pr.base
        }
      }
      // gh unreachable, or the PR is not among the recent ones: unknown.
      const known = getLastKnown(root, 'pr', String(number))
      if (!known) return { kind: 'pr', ref: l.ref, number, exists: false, stale: true }
      return {
        kind: 'pr',
        ref: l.ref,
        number,
        exists: true,
        state: known.state as PrEntry['state'],
        ...(known.url ? { url: known.url } : {}),
        ...(known.baseRefName ? { baseRefName: known.baseRefName } : {}),
        stale: true
      }
    }
    return null
  }

  const fixedStart = mission.steps.find((s) => s.kind === 'fixed-start')
  // Scope paths (v3's attachment, or a legacy fixed start's links) are re-checked
  // for containment on every read (BUG-145).
  const scopeProblems = await scopeLinkProblems(root, scopeLinks)
  const unfitOf = (resolved: readonly MissionLinkSignal[]): MissionLinkSignal | undefined =>
    resolved.find((l) => l.kind === 'worktree' && scopeProblems.has(l.ref))
  const unfitReason = (l: MissionLinkSignal): string =>
    `worktree ${l.ref} ${SCOPE_PROBLEM_TEXT[scopeProblems.get(l.ref)!]}`
  const scopeResolved = scopeLinks.map(resolve).filter((l): l is MissionLinkSignal => l !== null)
  const scopeUnfit = unfitOf(scopeResolved)
  const scope: MissionScopeSignals = {
    links: scopeResolved,
    resolved: scopeUnfit
      ? { proven: false, reason: unfitReason(scopeUnfit) }
      : existenceOf(scopeResolved, join.ghAvailable)
  }
  const steps = mission.steps.map((s): MissionStepSignals => {
    const resolved = s.links.map(resolve).filter((l): l is MissionLinkSignal => l !== null)
    const unfit = s === fixedStart ? unfitOf(resolved) : undefined
    return {
      stepId: s.id,
      children: s.links
        .filter((l) => l.kind === 'session')
        .flatMap((l) => {
          const c = childById.get(l.ref)
          return c ? [c] : []
        }),
      links: resolved,
      existence:
        s.verification !== 'existence'
          ? null
          : unfit
            ? { proven: false, reason: unfitReason(unfit) }
            : existenceOf(resolved, join.ghAvailable)
    }
  })
  const stall = evaluateMissionStall(mission, log, children, now)
  const progress: MissionProgress = computeProgress(
    mission,
    steps.map((s) => ({
      stepId: s.stepId,
      children: s.children.map((c) => ({ sessionId: c.sessionId, taskState: c.taskState })),
      existenceProven: s.existence?.proven === true
    })),
    now
  )
  rememberProgress(mission.id, progress)
  return {
    children,
    derived: {
      live: true,
      computedAt: new Date(now).toISOString(),
      stale: stall.stale,
      stall,
      gh: join.ghAvailable === null ? 'not-needed' : join.ghAvailable ? 'available' : 'unavailable',
      pendingApprovals: children.reduce((n, c) => n + c.pendingApprovals, 0),
      scope,
      steps,
      progress
    }
  }
}

/** The mission title — the `# <title>` heading its Log body opens with (no Mission field holds it). */
export function missionTitle(log: string, fallback: string): string {
  return /^# (.+)$/m.exec(log)?.[1]?.trim() ?? fallback
}

/** A refusal for a folder (or its repo root) the operator blocked for agents. */
function missionFolderRefusal(folder: string, root: string, ctx: ToolHandlerCtx): string | null {
  if (isFolderDenied(folder, ctx.denyFolders) || isFolderDenied(root, ctx.denyFolders)) {
    return 'FOLDER_NOT_ALLOWED: the operator blocked this folder for agents — its missions are off limits. Tell the operator; they can unblock it from the folder menu.'
  }
  return null
}

/** Every readable mission under `root`, with its Log; corrupt files are reported, not thrown. */
export async function readAllMissions(root: string): Promise<{
  missions: Array<{ mission: Mission; log: string; file: string }>
  unreadable: string[]
}> {
  const missions: Array<{ mission: Mission; log: string; file: string }> = []
  const unreadable: string[] = []
  for (const entry of await listMissionEntries(root)) {
    const loaded = await loadMission(root, entry.id)
    if (loaded.ok) missions.push({ mission: loaded.mission, log: loaded.log, file: loaded.file })
    else unreadable.push(entry.name)
  }
  return { missions, unreadable }
}

const missionGetHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const missionId = strField(args, 'missionId')
  const ownerSessionId = strField(args, 'ownerSessionId')
  if (!missionId === !ownerSessionId) {
    return errorResult('BAD_ARGS: pass exactly one of missionId / ownerSessionId')
  }
  const root = missionRoot(folder)
  const refusal = missionFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)

  let found: { mission: Mission; log: string; file: string }
  if (missionId) {
    const loaded = await loadMission(root, missionId)
    if (!loaded.ok) return errorResult(loaded.error)
    found = loaded
  } else {
    const owned = (await readAllMissions(root)).missions
      .filter((m) => m.mission.owner.sessionId === ownerSessionId && m.mission.status !== 'closed')
      .sort((a, b) => b.mission.updatedAt.localeCompare(a.mission.updatedAt))
    if (owned.length === 0) {
      return errorResult(
        `MISSION_NOT_FOUND: session ${ownerSessionId} owns no open mission in this repo.`
      )
    }
    found = owned[0]
  }
  const { mission, log, file } = found
  // design §3/§8: `active ↔ stale` is derived on every read and NEVER written back —
  // the stored status stays `active`, so nothing that reads it (S2's never-park
  // exemption) loses a mission exactly when it stalls.
  const { derived, children } = await deriveMissionSignals(root, mission, log, ctx, Date.now())
  const items = youItems(mission, children, derived.progress)
  // design §9: an imported mission's legacyRaw (up to the whole legacy file) is
  // left out of the projection — every tick reads this — and pointed at instead.
  const { legacyRaw, ...projected } = mission
  return textResult({
    ok: true,
    op: 'mission_get',
    mission: projected,
    ...(legacyRaw !== undefined
      ? { legacyRaw: { bytes: Buffer.byteLength(legacyRaw, 'utf8'), file } }
      : {}),
    title: missionTitle(log, mission.slug),
    log,
    derived,
    // Mission v3 §3.12: the ordered list, and its first item as the one line.
    you: youLine(items),
    youItems: items,
    // Mission v2 §3.5: what mission_request_close would refuse right now, or null.
    closeReadiness: requestCloseRefusal(mission)
  })
}

const missionListHandler: Handler = async (_args, ctx) => {
  const folder = ctx.folder
  let roots: string[]
  if (folder) {
    const root = missionRoot(folder)
    const refusal = missionFolderRefusal(folder, root, ctx)
    if (refusal) return errorResult(refusal)
    roots = [root]
  } else {
    roots = [...new Set(ctx.folders.map((f) => missionRoot(f.path)))].filter(
      (root) => !isFolderDenied(root, ctx.denyFolders)
    )
  }
  const missions: Record<string, unknown>[] = []
  const unreadable: string[] = []
  for (const root of roots) {
    const read = await readAllMissions(root)
    unreadable.push(...read.unreadable.map((n) => path.join(missionsDir(root), n)))
    for (const { mission: m, log } of read.missions) {
      missions.push({
        id: m.id,
        slug: m.slug,
        title: missionTitle(log, m.slug),
        status: m.status,
        folder: m.folder,
        ownerSessionId: m.owner.sessionId,
        ...(m.linkedCard ? { linkedCard: m.linkedCard } : {}),
        // Mission v3 §3.10: the last derive's progress (null before any derive);
        // read mission_get for exact numbers.
        progress: lastProgress.get(m.id) ?? null,
        // Deprecated (kept one release): proof counts, a legacy fixed start excluded.
        steps: {
          total: progressSteps(m).length,
          verified: progressSteps(m).filter((s) => s.proof === 'verified').length,
          claimed: progressSteps(m).filter((s) => s.proof === 'claimed').length
        },
        blocked: m.blockers.length > 0 || m.steps.some((s) => s.blockers.length > 0),
        updatedAt: m.updatedAt
      })
    }
  }
  return textResult({
    ok: true,
    op: 'mission_list',
    missions,
    ...(unreadable.length > 0 ? { unreadable } : {})
  })
}

/**
 * `logAppend`, when set, is appended to the Log body in the same locked write.
 * `unchanged: true` — the verb changed nothing (a deduped check): skip the write
 * entirely, so `updatedAt` (the stall rule's evidence) and the file stay as they were.
 */
type MissionEdit =
  | {
      ok: true
      mission: Mission
      ack: Record<string, unknown>
      logAppend?: string
      unchanged?: true
    }
  | { ok: false; error: string }

/** The step fields `mission_update_step` may set (anything else is refused). */
const MISSION_STEP_EDITABLE_FIELDS = ['title', 'proof'] as const

function missionClosedMessage(id: string): string {
  return `MISSION_CLOSED: mission ${id} was closed by the operator — a closed mission is immutable by verb.`
}

function stepNotFoundMessage(id: string, stepId: string): string {
  return `STEP_NOT_FOUND: mission ${id} has no step ${stepId} — mission_get lists its steps.`
}

/** Next free `stp-<n>` — ids are never reused, even when ordinals shift. */
function nextStepId(steps: readonly MissionStep[]): string {
  const max = steps.reduce((n, s) => Math.max(n, Number(/^stp-(\d+)$/.exec(s.id)?.[1] ?? 0)), 0)
  return `stp-${max + 1}`
}

/**
 * One locked read → mutate → write of a mission's frontmatter (design §9).
 * `fn` gets a private copy; its result is re-validated by
 * `buildMissionFileContent` before an atomic replace, and `updatedAt` is
 * stamped here so no verb forgets it. The Log body is carried over unchanged.
 */
async function editMission(
  args: Record<string, unknown>,
  ctx: ToolHandlerCtx,
  fn: (mission: Mission) => MissionEdit
): Promise<CallToolResult> {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const id = strField(args, 'missionId') ?? ''
  const root = missionRoot(folder)
  const refusal = missionFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)
  return withMissionIdMintLock(id, async () => {
    const loaded = await loadMission(root, id)
    if (!loaded.ok) return errorResult(loaded.error)
    if (loaded.mission.status === 'closed') return errorResult(missionClosedMessage(id))
    const edit = fn(structuredClone(loaded.mission))
    if (!edit.ok) return errorResult(edit.error)
    if (edit.unchanged) return textResult(edit.ack)
    const next: Mission = { ...edit.mission, updatedAt: new Date().toISOString() }
    let content: string
    try {
      content = buildMissionFileContent(next, loaded.log + (edit.logAppend ?? ''))
    } catch (err) {
      return errorResult(`BAD_ARGS: ${(err as Error).message}`)
    }
    // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort the write.
    if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
    await atomicWriteFile(loaded.file, content, 0o644)
    return textResult(edit.ack)
  })
}

const missionAddStepHandler: Handler = async (args, ctx) => {
  const title = strField(args, 'title')?.replace(/\s+/g, ' ').trim()
  if (!title) return errorResult('BAD_ARGS: title is required')
  const verification = args.verification
  if (verification !== 'existence' && verification !== 'verifier' && verification !== 'human') {
    return errorResult('BAD_ARGS: verification must be one of existence | verifier | human')
  }
  const reason = strField(args, 'reason')?.trim() || undefined
  const afterStepId = strField(args, 'afterStepId')
  const links = parseStepLinks(args.links)
  if (!links.ok) return errorResult(links.error)
  return editMission(args, ctx, (m) => {
    // Mission v3 §3.4: keyed on "started" (a step has a link or a proof), never on
    // a status — planning steps added before any work need no reason.
    const started = isStarted(m)
    if (started && !reason) {
      return {
        ok: false,
        error: `REASON_REQUIRED: mission ${m.id} has started (a step has a link or a proof) — a step added after the mission started needs a reason (design decision 7); it is shown next to the new total.`
      }
    }
    // The fixed end is always last (design §1.2); a new step never goes after it.
    let insertAt = m.steps.findIndex((s) => s.kind === 'fixed-end')
    if (insertAt < 0) insertAt = m.steps.length
    if (afterStepId) {
      const idx = m.steps.findIndex((s) => s.id === afterStepId)
      if (idx < 0) return { ok: false, error: stepNotFoundMessage(m.id, afterStepId) }
      if (m.steps[idx].kind === 'fixed-end') {
        return {
          ok: false,
          error: `BAD_POSITION: ${afterStepId} is the fixed end — "Delivered and verified" is always the last step.`
        }
      }
      insertAt = idx + 1
    }
    const step: MissionStep = {
      id: nextStepId(m.steps),
      ordinal: 0,
      kind: 'custom',
      title,
      verification,
      proof: 'unproven',
      links: links.links,
      blockers: [],
      // Only real growth carries a reason (the "total changed" marker); a
      // planning step added before the start carries none.
      ...(started && reason ? { addedReason: reason } : {}),
      addedAt: new Date().toISOString()
    }
    m.steps.splice(insertAt, 0, step)
    m.steps.forEach((s, i) => (s.ordinal = i + 1))
    return {
      ok: true,
      mission: m,
      ack: { ok: true, op: 'mission_add_step', stepId: step.id, totalSteps: m.steps.length }
    }
  })
}

const missionUpdateStepHandler: Handler = async (args, ctx) => {
  const stepId = strField(args, 'stepId')
  if (!stepId) return errorResult('BAD_ARGS: stepId is required')
  const set =
    typeof args.set === 'object' && args.set !== null && !Array.isArray(args.set)
      ? (args.set as Record<string, unknown>)
      : undefined
  const keys = set ? Object.keys(set) : []
  if (!set || keys.length === 0) return errorResult('BAD_ARGS: set must contain at least one field')
  // `proof` is controlled EXCEPT the owner's one claim (design §1.3: unproven → claimed).
  const controlled = keys.filter(
    (k) =>
      (MISSION_STEP_CONTROLLED_FIELDS as readonly string[]).includes(k) &&
      !(k === 'proof' && set.proof === 'claimed')
  )
  if (controlled.length > 0) {
    return errorResult(
      `CONTROLLED_FIELD: mission_update_step cannot write ${controlled.join(', ')} — proof reaches verified/self-verified only through verification (and a human step only through the operator), and verifiedBy is recorded by that same path. The one proof value this verb sets is 'claimed'.`
    )
  }
  const unknown = keys.filter(
    (k) => !(MISSION_STEP_EDITABLE_FIELDS as readonly string[]).includes(k)
  )
  if (unknown.length > 0) {
    return errorResult(
      `BAD_ARGS: unknown set field(s) ${unknown.join(', ')} — editable fields are title | proof ('claimed').`
    )
  }
  let title: string | undefined
  if ('title' in set) {
    title = typeof set.title === 'string' ? set.title.replace(/\s+/g, ' ').trim() : ''
    if (!title || title.length > 200) return errorResult('BAD_ARGS: title must be 1..200 chars')
  }
  return editMission(args, ctx, (m) => {
    const step = m.steps.find((s) => s.id === stepId)
    if (!step) return { ok: false, error: stepNotFoundMessage(m.id, stepId) }
    const changed: string[] = []
    if (title !== undefined) {
      if (step.kind !== 'custom') {
        return {
          ok: false,
          error: `FIXED_STEP: ${stepId} is the mission's fixed ${step.kind === 'fixed-start' ? 'start' : 'end'} — its title is part of the frame and cannot change.`
        }
      }
      step.title = title
      changed.push('title')
    }
    if (set.proof === 'claimed') {
      if (step.verification === 'existence') {
        return {
          ok: false,
          error: `PROOF_NOT_CLAIMABLE: ${stepId} is an existence step — Harnu proves it from its links at read time; there is nothing to claim.`
        }
      }
      if (step.proof !== 'unproven' && step.proof !== 'claimed') {
        return {
          ok: false,
          error: `PROOF_NOT_CLAIMABLE: ${stepId} is already ${step.proof} — a claim never overwrites a verification.`
        }
      }
      step.proof = 'claimed'
      changed.push('proof')
    }
    return { ok: true, mission: m, ack: { ok: true, op: 'mission_update_step', stepId, changed } }
  })
}

const missionLinkChildHandler: Handler = async (args, ctx) => {
  const stepId = strField(args, 'stepId')
  const toScope = args.scope === true
  if (toScope && stepId) {
    return errorResult(
      'BAD_ARGS: pass stepId OR scope: true — a scope link belongs to the mission, not to a step.'
    )
  }
  if (!toScope && !stepId) {
    return errorResult('BAD_ARGS: stepId is required (or scope: true to attach a scope document)')
  }
  const raw =
    typeof args.link === 'object' && args.link !== null
      ? (args.link as Record<string, unknown>)
      : {}
  const kind = raw.kind
  const ref = typeof raw.ref === 'string' ? raw.ref.trim() : ''
  if (kind !== 'session' && kind !== 'worktree' && kind !== 'card' && kind !== 'pr') {
    return errorResult('BAD_ARGS: link.kind must be one of session | worktree | card | pr')
  }
  if (!ref) return errorResult('BAD_ARGS: link.ref is required')
  if (kind === 'session' && !SESSION_UUID_RE.test(ref)) {
    return errorResult(badSessionIdMessage('link.ref', ref))
  }
  if (toScope) {
    // Mission v3 §3.3: scope documents are paths in the repo, under BUG-145's rules.
    if (kind !== 'worktree') {
      return errorResult(
        'BAD_ARGS: a scope link is a path (kind: worktree) — the spec / PRD / ADR documents in the repo.'
      )
    }
    const checked = ctx.folder ? await checkScopePath(missionRoot(ctx.folder), ref) : null
    if (checked && !checked.ok) return errorResult(checked.error)
    const stored = checked?.ref ?? ref
    return editMission(args, ctx, (m) => {
      // A legacy mission's scope lives on its fixed start: carry it over first.
      const scope = [...missionScope(m)]
      if (!scope.some((l) => l.kind === 'worktree' && l.ref === stored)) {
        scope.push({ kind: 'worktree', ref: stored })
      }
      m.scope = scope
      return { ok: true, mission: m, ack: { ok: true, op: 'mission_link_child', scope } }
    })
  }
  // BUG-145: a path on the fixed start is a scope path, whichever verb put it
  // there. The check is async and the edit is not, so it runs up front; its
  // verdict applies only if the step turns out to be the fixed start.
  const scoped =
    kind === 'worktree' && ctx.folder ? await checkScopePath(missionRoot(ctx.folder), ref) : null
  return editMission(args, ctx, (m) => {
    const step = m.steps.find((s) => s.id === stepId)
    if (!step || !stepId) return { ok: false, error: stepNotFoundMessage(m.id, stepId ?? '') }
    let stored = ref
    if (scoped && step.kind === 'fixed-start') {
      if (!scoped.ok) return { ok: false, error: scoped.error }
      stored = scoped.ref
    }
    if (!step.links.some((l) => l.kind === kind && l.ref === stored)) {
      step.links.push({ kind, ref: stored })
    }
    return {
      ok: true,
      mission: m,
      ack: { ok: true, op: 'mission_link_child', stepId, links: step.links }
    }
  })
}

/**
 * The blocker list a blocker verb targets: the step's with `stepId`, else the
 * mission's own (design §1.4 — a blocker flags a mission OR a step).
 */
function blockerTarget(
  m: Mission,
  stepId: string | undefined
): { ok: true; blockers: Blocker[] } | { ok: false; error: string } {
  if (!stepId) return { ok: true, blockers: m.blockers }
  const step = m.steps.find((s) => s.id === stepId)
  if (!step) return { ok: false, error: stepNotFoundMessage(m.id, stepId) }
  return { ok: true, blockers: step.blockers }
}

const missionSetBlockerHandler: Handler = async (args, ctx) => {
  const reason = strField(args, 'reason')?.trim()
  const unblocks = strField(args, 'unblocks')?.trim()
  const owner = args.owner
  if (!reason) return errorResult('BAD_ARGS: reason is required')
  if (!unblocks) return errorResult('BAD_ARGS: unblocks is required')
  if (owner !== 'agent' && owner !== 'operator') {
    return errorResult('BAD_ARGS: owner must be agent | operator')
  }
  const stepId = strField(args, 'stepId')
  return editMission(args, ctx, (m) => {
    const target = blockerTarget(m, stepId)
    if (!target.ok) return target
    // A flag, never a status (design §1.4): `m.status` is deliberately untouched.
    const existing = target.blockers.find((b) => b.reason === reason)
    if (existing) {
      existing.unblocks = unblocks
      existing.owner = owner
    } else {
      target.blockers.push({ reason, unblocks, owner, raisedAt: new Date().toISOString() })
    }
    return {
      ok: true,
      mission: m,
      ack: {
        ok: true,
        op: 'mission_set_blocker',
        ...(stepId ? { stepId } : {}),
        blockers: target.blockers
      }
    }
  })
}

const missionClearBlockerHandler: Handler = async (args, ctx) => {
  const reason = strField(args, 'reason')
  const index = typeof args.index === 'number' ? args.index : undefined
  if ((reason === undefined) === (index === undefined)) {
    return errorResult('BAD_ARGS: pass exactly one of reason / index')
  }
  const stepId = strField(args, 'stepId')
  return editMission(args, ctx, (m) => {
    const target = blockerTarget(m, stepId)
    if (!target.ok) return target
    const at =
      index !== undefined
        ? Number.isInteger(index) && index >= 0 && index < target.blockers.length
          ? index
          : -1
        : target.blockers.findIndex((b) => b.reason === reason)
    if (at < 0) {
      return {
        ok: false,
        error: `BLOCKER_NOT_FOUND: no blocker ${index !== undefined ? `at index ${index}` : `with reason "${reason}"`} on ${stepId ?? `mission ${m.id}`} — mission_get lists the open ones.`
      }
    }
    target.blockers.splice(at, 1)
    return {
      ok: true,
      mission: m,
      ack: {
        ok: true,
        op: 'mission_clear_blocker',
        ...(stepId ? { stepId } : {}),
        blockers: target.blockers
      }
    }
  })
}

/** One timestamped Log entry, led by a newline when `before` does not end with one. */
function missionLogEntry(before: string, tag: string, text: string): string {
  const lead = before.endsWith('\n') ? '' : '\n'
  return `${lead}\n### ${new Date().toISOString()}${tag}\n\n${text}\n`
}

function formatDeclaredEnd(end: DeclaredEnd): string {
  return `${end.kind} · ${end.target} · evidence: ${end.evidence}`
}

const missionSetEndHandler: Handler = async (args, ctx) => {
  const problems = declaredEndProblems(args.declaredEnd)
  if (problems.length > 0) {
    return errorResult(
      `DECLARED_END_INCOMPLETE: missing or invalid ${problems.join(', ')} — a re-scope needs a complete declared end: kind (${DECLARED_END_KINDS.join(' | ')}), a concrete target, and the evidence that proves it.`
    )
  }
  const reason = strField(args, 'reason')?.trim()
  if (!reason) return errorResult('BAD_ARGS: reason is required — say why the end changes')
  const rawEnd = args.declaredEnd as Record<string, string>
  const proposed: DeclaredEnd = {
    kind: rawEnd.kind as DeclaredEnd['kind'],
    target: rawEnd.target.trim(),
    evidence: rawEnd.evidence.trim()
  }
  return editMission(args, ctx, (m) => {
    const cur = m.declaredEnd
    if (
      cur.kind === proposed.kind &&
      cur.target === proposed.target &&
      cur.evidence === proposed.evidence
    ) {
      return {
        ok: false,
        error: `END_UNCHANGED: that is already mission ${m.id}'s declared end — nothing to re-scope.`
      }
    }
    // Staged, never applied (design §3): `declaredEnd` is deliberately untouched —
    // only the operator's approval (`applyApprovedRescope`, UI-only) promotes it.
    m.pendingRescope = proposed
    return {
      ok: true,
      mission: m,
      ack: { ok: true, op: 'mission_set_end', pendingRescope: true },
      logAppend: `\n### ${new Date().toISOString()} · re-scope requested\n\nwas: ${formatDeclaredEnd(cur)}\nnow: ${formatDeclaredEnd(proposed)}\n\nReason: ${reason}\n`
    }
  })
}

/**
 * Mission v3 §3.6 — the agent adds a human check to a step. It can never tick or
 * delete one: those are the operator's doors (`mission-ipc.ts`), and no input of
 * this verb carries `ticked`. A label already on the step (any case) is kept.
 */
const missionAddCheckHandler: Handler = async (args, ctx) => {
  const stepId = strField(args, 'stepId')
  if (!stepId) return errorResult('BAD_ARGS: stepId is required')
  const label = strField(args, 'label') ?? ''
  return editMission(args, ctx, (m) => {
    let next: Mission
    try {
      next = applyAddCheck(m, stepId, label, 'agent', new Date().toISOString())
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    const checks = next.steps.find((s) => s.id === stepId)?.checks ?? []
    // The label was already on the step (any case): nothing changed, nothing is
    // written, and the ACK says so — the first creator's check stands.
    const before = m.steps.find((s) => s.id === stepId)?.checks?.length ?? 0
    if (checks.length === before) {
      return {
        ok: true,
        mission: m,
        unchanged: true,
        ack: { ok: true, op: 'mission_add_check', stepId, checks, deduped: true }
      }
    }
    return { ok: true, mission: next, ack: { ok: true, op: 'mission_add_check', stepId, checks } }
  })
}

const MISSION_VERDICTS = ['met', 'unmet', 'blocked', 'needs-human'] as const
type MissionVerdict = (typeof MISSION_VERDICTS)[number]

/**
 * design §1.3 / §13 Resolved A — `verified` only when the step has at least one
 * author session and the DECLARED caller id is none of them; otherwise
 * `self-verified`. A custom step's authors are its own `session` links. The
 * fixed end is built by the whole mission, so its authors are its own `session`
 * links plus every custom step's (Mission v2 §3.5) — the owner, who built none,
 * lands `verified`; with no author at all the end stays `self-verified`. The id
 * is self-declared (no per-session identity on this transport), so this labels
 * by convention + audit — it never refuses.
 */
function verificationLabel(
  mission: Mission,
  step: MissionStep,
  callerId: string
): 'verified' | 'self-verified' {
  const sources =
    step.kind === 'fixed-end' ? [step, ...mission.steps.filter((s) => s.kind === 'custom')] : [step]
  const authors = sources.flatMap((s) =>
    s.links.filter((l) => l.kind === 'session').map((l) => l.ref)
  )
  return authors.length > 0 && !authors.includes(callerId) ? 'verified' : 'self-verified'
}

const missionVerifyStepHandler: Handler = async (args, ctx) => {
  const stepId = strField(args, 'stepId')
  if (!stepId) return errorResult('BAD_ARGS: stepId is required')
  const verdict = args.verdict as MissionVerdict
  if (!MISSION_VERDICTS.includes(verdict)) {
    return errorResult(`BAD_ARGS: verdict must be one of ${MISSION_VERDICTS.join(' | ')}`)
  }
  const evidence = strField(args, 'evidence')?.trim()
  if (!evidence) return errorResult('BAD_ARGS: evidence is required — say what you checked')
  const callerId = strField(args, 'sessionId') ?? ''
  if (!SESSION_UUID_RE.test(callerId))
    return errorResult(badSessionIdMessage('sessionId', callerId))
  // Mission v3 §3.6: a needs-human verdict creates a check — `checkLabel`, else
  // the first line of the evidence (clamped to a label's length).
  const checkLabel =
    strField(args, 'checkLabel')?.replace(/\s+/g, ' ').trim() ||
    (evidence.split('\n').find((l) => l.trim().length > 0) ?? evidence)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CHECK_LABEL_MAX)
  return editMission(args, ctx, (m) => {
    const step = m.steps.find((s) => s.id === stepId)
    if (!step) return { ok: false, error: stepNotFoundMessage(m.id, stepId) }
    // Not a self-verification refusal (there is none, §13 A): a step's level is
    // fixed at plan time, and only a verifier-level step is proven by this verb.
    if (step.verification === 'human') {
      return {
        ok: false,
        error: `WRONG_VERIFICATION_LEVEL: ${stepId} is a human step — only the operator marks it proven, from the UI. Claim it with mission_update_step (proof: 'claimed') and tell them.`
      }
    }
    if (step.verification === 'existence') {
      return {
        ok: false,
        error: `WRONG_VERIFICATION_LEVEL: ${stepId} is an existence step — Harnu proves it from its links every time the mission is read; there is nothing to verify by hand.`
      }
    }
    const label = verificationLabel(m, step, callerId)
    const at = new Date().toISOString()
    // A verification that did not find the step done is no proof: the claim it
    // tested (if any) is void, and mission_request_close keeps refusing.
    // Mission v3 §3.6: `needs-human` means the machine part is met — the proof
    // keeps its label — and the human part becomes a check on the step.
    step.proof = verdict === 'met' || verdict === 'needs-human' ? label : 'unproven'
    step.verifiedBy = { sessionId: callerId, at, verdict }
    if (verdict === 'needs-human') {
      try {
        m = applyAddCheck(m, stepId, checkLabel, 'verifier', at)
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
    return {
      ok: true,
      mission: m,
      ack: { ok: true, op: 'mission_verify_step', stepId, proof: step.proof, verdict },
      logAppend: `\n### ${at} · ${stepId} · ${step.proof} (${verdict}) by ${callerId}\n\n${evidence}\n`
    }
  })
}

const missionRequestCloseHandler: Handler = async (args, ctx) => {
  const requestedBy = strField(args, 'sessionId')
  if (requestedBy !== undefined && !SESSION_UUID_RE.test(requestedBy)) {
    return errorResult(badSessionIdMessage('sessionId', requestedBy))
  }
  return editMission(args, ctx, (m) => {
    // The same checks mission_get reports as `closeReadiness` (Mission v2 §3.5).
    const refused = requestCloseRefusal(m)
    if (refused) return { ok: false, error: `${refused.code}: ${refused.reason}` }
    // design §3: the agent's request lands on `delivered` + `pendingClose`; only
    // the operator's UI (`applyOperatorEnd`) reaches `closed`.
    m.status = 'delivered'
    m.pendingClose = { at: new Date().toISOString(), requestedBy: requestedBy ?? m.owner.sessionId }
    return {
      ok: true,
      mission: m,
      ack: { ok: true, op: 'mission_request_close', pendingClose: true }
    }
  })
}

const missionLogHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const note = strField(args, 'note')?.trim()
  if (!note) return errorResult('BAD_ARGS: note is required')
  const id = strField(args, 'missionId') ?? ''
  const stepId = strField(args, 'stepId')
  const root = missionRoot(folder)
  const refusal = missionFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)
  return withMissionIdMintLock(id, async () => {
    const loaded = await loadMission(root, id)
    if (!loaded.ok) return errorResult(loaded.error)
    if (loaded.mission.status === 'closed') return errorResult(missionClosedMessage(id))
    if (stepId && !loaded.mission.steps.some((s) => s.id === stepId)) {
      return errorResult(stepNotFoundMessage(id, stepId))
    }
    // Append to the raw file: the frontmatter bytes stay exactly as they were.
    const entry = missionLogEntry(loaded.raw, stepId ? ` · ${stepId}` : '', note)
    if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
    await atomicWriteFile(loaded.file, loaded.raw + entry, 0o644)
    return textResult({ ok: true, op: 'mission_log' })
  })
}

/** The single dispatch table: every {@link McpOp} maps to exactly one handler. */
const TOOL_HANDLERS: Record<McpOp, Handler> = {
  get_fleet: getFleetHandler,
  get_session: getSessionHandler,
  list_worktrees: listWorktreesHandler,
  get_approval: getApprovalHandler,
  create_session: createSessionHandler,
  create_worktree: createWorktreeHandler,
  spawn_terminal: spawnTerminalHandler,
  adopt_folder: adoptFolderHandler,
  remove_folder: removeFolderHandler,
  plan_mission: planMissionHandler,
  memory_read: memoryReadHandler,
  memory_append: memoryAppendHandler,
  memory_query: memoryQueryHandler,
  open_file: openFileHandler,
  draw_canvas: drawCanvasHandler,
  notify: notifyHandler,
  create_card: createCardHandler,
  update_card: updateCardHandler,
  move_card: moveCardHandler,
  archive_card: archiveCardHandler,
  delete_card: deleteCardHandler,
  submit_manifest: submitManifestHandler,
  message_session: messageSessionHandler,
  speak: speakHandler,
  create_worker: createWorkerHandler,
  list_workers: listWorkersHandler,
  list_containers: listContainersHandler,
  list_cleanup: listCleanupHandler,
  release_worktree: releaseWorktreeHandler,
  stop_containers: stopContainersHandler,
  start_containers: startContainersHandler,
  remove_containers: removeContainersHandler,
  update_worker: updateWorkerHandler,
  delete_worker: deleteWorkerHandler,
  orchestrator_arm: orchestratorArmHandler,
  orchestrator_disarm: orchestratorDisarmHandler,
  mission_create: missionCreateHandler,
  mission_get: missionGetHandler,
  mission_list: missionListHandler,
  mission_add_step: missionAddStepHandler,
  mission_update_step: missionUpdateStepHandler,
  mission_link_child: missionLinkChildHandler,
  mission_log: missionLogHandler,
  mission_set_blocker: missionSetBlockerHandler,
  mission_clear_blocker: missionClearBlockerHandler,
  mission_set_end: missionSetEndHandler,
  mission_verify_step: missionVerifyStepHandler,
  mission_request_close: missionRequestCloseHandler,
  mission_import_legacy: missionImportLegacyHandler,
  mission_add_check: missionAddCheckHandler
}

/**
 * {@link MCP_TOOLS} enriched with its `handler` — the array the server actually
 * registers + dispatches through. `MCP_TOOLS` itself (the pure catalog) never
 * carries a handler; this is the ONE place the two are fused.
 */
export const WIRED_TOOLS: McpToolDef[] = MCP_TOOLS.map((t) => ({
  ...t,
  handler: TOOL_HANDLERS[t.op]
}))
