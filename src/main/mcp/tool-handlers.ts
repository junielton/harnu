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
import { randomBytes, randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { MCP_TOOLS, type McpOp, type McpToolDef } from './tool-catalog'
import { strField } from './plan-input'
import { asRecord, dispatchSucceeded, errorResult, steerError, textResult } from './tool-result'
import {
  runCreateSession,
  type CreateSessionDeps,
  type Materialization
} from './create-session-core'
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
import { YOUR_MOVE_LIMIT_PER_HOUR, fileFromVerb, type YourMoveCard } from '../your-move/core'
import { effectiveMode, isFolderDisabled, readYourMovePrefs } from '../your-move/prefs'
import { getYourMoveStore, type YourMoveStore } from '../your-move/store'
import type { ApprovalStatusResult } from './approval-status'
import type { ManifestCardDisclosure } from './confirm-core'
import type { CommandBridge } from '../command-bridge'
import type { FolderEntry } from '../folder-model'
import type { TaskState, FailureReason } from '../hook-state'
import { getTaskStates } from '../hook-bridge'
import { gatherStepInputs } from '../missions/facts'
import { getTaskState } from '../detect/task-state-hub'
import { findBaseCi, findMainCi, findPrsForWorktrees } from '../pr-stack'
import { getLastKnown, ensureLinkCacheLoaded } from '../mission-link-cache'
import type { FactsDeps } from '../missions/facts'
import type { Actor } from '../missions/guard'
import type { MissionV4 } from '../missions/model'
import type { StepInput } from '../missions/state'
import { runV4, type V4Deps, type V4Op } from '../missions/verbs'
import { listPendingApprovals } from '../approval-resolver'
import { githubBudget } from '../github-budget-tracker'
import { githubBudgetPayload } from './github-budget-view'
import { getScreenStates, getShellSessions } from '../detect/screen-detect'
import {
  createTerminalPty,
  ShelvedRestoreError,
  discardTerminalPty,
  ensureTerminalScreenModel,
  liveSessionKeys,
  sessionOwnedByHarnu,
  spawnOriginForSession,
  waitForSessionReady,
  writeTerminalPty
} from '../pty'
import { ensureShelvedRestored } from '../gc/shelve-restore-shell'
import {
  AGENT_TERMINAL_SIZE,
  MAX_AGENT_TERMINALS_PER_FOLDER,
  terminalRegistry
} from '../terminal-registry'
import { canStillWrite, gateTerminalOp } from '../terminal-gate-core'
import { readAgentTerminalWrites } from './prefs'
import { beginPaneVerb, runWithRevival, withRevivedFlag } from '../browser/verbs-core'
import {
  browserRegistry,
  makeBrowserActDeps,
  makeBrowserDeviceDeps,
  makeBrowserReadDeps,
  makeBrowserVerbDeps
} from '../browser/browser-service'
import { clickVerb, evalVerb, fillVerb, pressVerb, typeVerb } from '../browser/act-verbs'
import { downloadVerb, emulateVerb, uploadVerb } from '../browser/device-verbs'
import type { ConsoleLevel } from '../browser/console-buffer'
import {
  consoleVerb,
  networkVerb,
  screenshotVerb,
  snapshotVerb,
  waitForVerb
} from '../browser/read-verbs'
import { closeVerb, listVerb, navigateVerb, openVerb } from '../browser/verbs-core'
import { patchVerb, setDataVerb } from '../browser/page-verbs'
import { resolveTerminalGate } from '../terminal-gate'
import { terminalLeases } from '../terminal-lease'
import { scrubTerminalText } from '../scrub-terminal'
import { paneSplitFor } from '../terminal-lifecycle'
import { buildSend } from '../terminal-keys'
import {
  SETTLE_CAP_MS,
  settleAfterSend,
  terminalWriteQueue,
  writeSegments
} from '../terminal-write-queue'
import { BARRIER_TIMEOUT_MS } from '../terminal-screen'
import {
  matchSurface,
  redactMatch,
  TIMEOUT_DEFAULT_MS,
  waitForOutput,
  type WaitSpec
} from '../terminal-wait'
import {
  TERMINAL_NOTE,
  pruneScreenModels,
  type ReadMode,
  type ReadOptions
} from '../terminal-screen'
import { peerAddressForSession, sendPeerMessage } from '../messaging'
import {
  activityDescription,
  isMessageableOwner,
  MESSAGE_MAX_CHARS,
  messageAuditSummary
} from '../messaging-socket'
import { arm, disarm, listArmedSessionIds } from '../orchestrator-guard'
import { resolveAgentTarget } from './target-scope'
import { dataDirReady, mkdirDataDir, repoRoot } from '../data-dir'
import { listMissionRecords, readMissionRecord } from '../missions/record-store'
import { createWalkProbe } from '../walk/walk-links'
import { walkServiceFor } from '../walk/walk-service'
import {
  missionFactsOf,
  walkExtend,
  walkGet,
  walkOpen,
  walkReport,
  type WalkVerbEnv,
  type WalkVerbResult
} from './walk-handlers'
import {
  dispatchAck,
  dispatchStep,
  realBoardIo,
  reportBindFailure,
  stampCardForStep
} from '../missions/dispatch'
import { awaitSessionBoot, spawnedSessionId } from './session-boot'
import {
  anonymousKey,
  createProactiveTally,
  isAttached,
  noteWork,
  someoneLeads,
  type Work
} from '../missions/proactive'
import { hibernatedKeys, isHibernated } from '../hibernation'
import { bindMissionRoot, recordObserved } from '../missions/ledger-store'
import { pickLedgerTargets, type LedgerHints, type LedgerRowInput } from '../mission-ledger'
// Missions v4 S-2 (R-25): the mission-file readers live in `missions/store.ts`. They are
// re-exported so the callers that still import them from here keep working.
import { loadMission, missionRoot, readAllMissions } from '../missions/store'
export { loadMission, missionRoot, readAllMissions }
// Types the retired v3 view still names (the list's wire, Your move's stored pointer, the pulse). No runtime.
export type { MissionDerived, MissionLinkSignal } from '../missions/derive'
export type { MissionYouItem, WaitingItem } from '../missions/waiting'
import {
  buildFleetSnapshot,
  filterFleetSnapshot,
  terminalsOfSession,
  toTerminalListing,
  type FleetFolderInput,
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
import {
  normalizePath as normalizeStoredPath,
  readUserProjects,
  terminalReadOptIns,
  transactHiddenPaths
} from '../user-projects'
import {
  appendMemoryEntry,
  queryMemory,
  readMemoryOverview,
  readMemoryPage,
  recallForScope,
  resolveMemoryLocation
} from './memory-store'
import type { RecallHit, RecallQuery } from './memory-entries'
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
  canvasEdgeStyleAck,
  canvasShapeCatalogAck,
  canvasVerbCode,
  planCanvasAssets,
  resolveCanvasWritePath
} from './canvas-ops'
import { resolveCreateSessionBoot } from './agent-boot'
import { getResolvedConfig } from '../claude-config'
import { type ClaudeBootConfig } from '../claude-args'
import { parsePlanMission } from './validate'
import { dropPendingSpawn, registerPendingSpawn, type PendingSpawn, type Scope } from './scope'
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
import { rebaseStackV4 } from '../missions/rebase'
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
import { realPathLookup } from './real-paths'
import { getSessionArchive } from '../session-archive-core'
import { planArchiveSession, summarizeArchive, type ArchivePlan } from './archive-session-core'
import { planHideFolder, summarizeHide } from './hide-folder-core'

/**
 * The caller the transport proved: a session Harnu spawned (its own session id, the mission and the step it
 * was started for) or the observe worker of a folder (a scoped bearer, Missions v4 S-25). Absent = an ordinary MCP
 * client (the main bearer).
 */
export type HandlerCaller = { kind: 'scoped'; scope: Scope }

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
   * Who is calling, as the TRANSPORT knows it (Missions v4 S-24): present only for a scoped bearer (a
   * session Harnu spawned for a step, or an observe worker). Absent = an ordinary MCP client (the main
   * bearer). The v4 mission verbs build the caller's `Actor` from this and never from an argument.
   */
  caller?: HandlerCaller
  /**
   * Present ONLY on the human-confirm actuation path (T61/T104) — see
   * `server.ts`'s `parkMutationConfirm`/`runOptsFor` for how these are built.
   */
  opts?: {
    /**
     * T474 B6: the call was let through by the operator's write lease (the ask-mode path). The
     * handler checks that lease again right before it writes, for any terminal origin.
     */
    viaLease?: boolean
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
        session: {
          sessionId,
          status: 'spawning',
          folderAlias: path.basename(inFlightFolder),
          terminals: sessionTerminals(sessionId, ctx)
        },
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
  const row = snap.sessions[0]
  return textResult({
    session: row ? { ...row, terminals: sessionTerminals(sessionId, ctx) } : null,
    preview
  })
}

/** T474: the connected terminals a session owns, none from a folder the operator blocked. */
function sessionTerminals(
  sessionId: string,
  ctx: ToolHandlerCtx
): ReturnType<typeof terminalsOfSession> {
  return terminalsOfSession(terminalRegistry.list(), sessionId, {
    denyFolders: ctx.denyFolders,
    home: os.homedir()
  })
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

/**
 * The step a `create_session` is for (Missions v4 S-25), or the refusal. Nothing to note for a plain
 * session (no mission and step), and `role` alone stays the label it always was.
 */
async function stepSpawnOf(
  args: Record<string, unknown>,
  folder: string
): Promise<PendingSpawn | { error: string } | undefined> {
  const missionId = strField(args, 'missionId')
  const stepId = strField(args, 'stepId')
  const role = strField(args, 'role')
  if (missionId === undefined && stepId === undefined) {
    return role === 'worker'
      ? {
          error:
            "BAD_ARGS: role 'worker' is a session started for a step: pass missionId and stepId."
        }
      : undefined
  }
  if (missionId === undefined || stepId === undefined) {
    return { error: 'BAD_ARGS: pass missionId and stepId together.' }
  }
  const read = await readMissionRecord(repoRoot(folder), missionId)
  if (!read.ok) {
    return {
      error: `MISSION_NOT_FOUND: no mission ${missionId} in this repo. mission_list { folder } shows the open ones.`
    }
  }
  if (read.source !== 'v4') {
    return {
      error: `MISSION_NOT_V4: ${missionId} is a v3 mission, and a session on one of its steps would convert it by its first write. Convert it first with a v4 verb such as mission_add_milestone, or start the session without missionId and stepId.`
    }
  }
  if (read.record.status === 'closed') {
    return {
      error: `MISSION_CLOSED: ${missionId} is closed; no session is started for one of its steps. Start a new mission instead.`
    }
  }
  if (!read.record.steps.some((st) => st.id === stepId)) {
    return {
      error: `STEP_NOT_FOUND: ${missionId} has no step ${stepId}; it has ${read.record.steps.map((st) => st.id).join(', ') || 'no steps'}.`
    }
  }
  return { role: role === 'verifier' ? 'verifier' : 'worker', missionId, stepId }
}

/** How long a step's session that missed the ACK's deadline is still waited for. */
const LATE_BOOT_WAIT_MS = 15 * 60_000

/**
 * Attach the session `create_session` started for a step, and report a failure on the mission Log and
 * in Activity (AC-13). Returns what the ACK gains. The id attached is the one Harnu minted for the
 * spawn (its credential carries it), else the one the renderer reported.
 */
async function bindCreatedStepSession(
  folder: string,
  spawn: PendingSpawn,
  booted: { syntheticId: string; sessionId: string },
  bridge: CommandBridge
): Promise<Record<string, unknown>> {
  let reason: string
  try {
    const done = await dispatchStep(
      folder,
      {
        missionId: spawn.missionId,
        stepId: spawn.stepId,
        sessionId: spawnedSessionId(booted.syntheticId) ?? booted.sessionId,
        role: spawn.role,
        to: 'session'
      },
      await realBoardIo(folder)
    )
    if (done.ok) return dispatchAck(done)
    reason = done.error
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }
  await reportStepBindFailure(folder, spawn, reason, bridge)
  return { bindError: reason }
}

/** The report of a step session that could not be attached, naming the step's card when it has one. */
async function reportStepBindFailure(
  folder: string,
  spawn: PendingSpawn,
  reason: string,
  bridge: CommandBridge
): Promise<void> {
  const read = await readMissionRecord(repoRoot(folder), spawn.missionId).catch(() => null)
  const card = read?.ok ? read.record.steps.find((s) => s.id === spawn.stepId)?.card : undefined
  await reportBindFailure(
    {
      folder,
      missionId: spawn.missionId,
      stepId: spawn.stepId,
      reason,
      ...(card ? { card } : {})
    },
    (notice) => bridge.dispatch('notify.push', notice)
  )
}

/**
 * Missions v4 S-34 (AC-82): what each counted caller has started since Harnu booted. The count lives in
 * the process on purpose: a hint is a backstop, and a restart starting every caller from zero costs one
 * sentence.
 */
const proactiveTally = createProactiveTally()

/**
 * The `sessionId` a call of `create_session`, `create_worktree` or `submit_manifest` declares about itself,
 * or the refusal. Optional: these verbs never needed one, and it only lets Harnu say whether the caller
 * leads a mission. Self-declared, like every v4 caller; a value that is not a session UUID is refused.
 */
function declaredCaller(
  args: Record<string, unknown>
): { ok: true; sessionId: string | undefined } | { ok: false; error: string } {
  const sessionId = strField(args, 'sessionId')
  if (sessionId !== undefined && !SESSION_UUID_RE.test(sessionId)) {
    return { ok: false, error: badSessionIdMessage('sessionId', sessionId) }
  }
  return { ok: true, sessionId }
}

/**
 * The fields the ACK gains when a session that leads no mission has started work: `{ missionHint }` once,
 * else `{}`. Never creates a mission, never throws into the ACK. A caller the transport proved (a session
 * Harnu spawned for a step, an observe worker) is never hinted; an anonymous caller is counted
 * per repo and left alone where a mission is led.
 */
async function proactiveHintFor(
  args: Record<string, unknown>,
  ctx: ToolHandlerCtx,
  work: Work
): Promise<Record<string, unknown>> {
  if (ctx.caller || !ctx.folder) return {}
  try {
    const root = missionRoot(ctx.folder)
    if (isFolderDenied(ctx.folder, ctx.denyFolders) || isFolderDenied(root, ctx.denyFolders)) {
      return {}
    }
    const sessionId = strField(args, 'sessionId')
    const records = (await listMissionRecords(root)).records.map((r) => r.record)
    return noteWork(
      proactiveTally,
      sessionId ?? anonymousKey(root),
      work,
      sessionId !== undefined ? isAttached(records, sessionId) : someoneLeads(records)
    )
  } catch {
    return {}
  }
}

const createSessionHandler: Handler = async (args, ctx) => {
  if (!ctx.bridge) return errorResult('NO_BRIDGE')
  const bridge = ctx.bridge
  const folder = ctx.folder
  const caller = declaredCaller(args)
  if (!caller.ok) return errorResult(caller.error)
  // U2.3a (design C3): a session opened in a shelved worktree brings it back first, here as well as
  // in `createPty`, so a failure is this call's error and not an `ok:true` with a session that never
  // materializes.
  const restored = await ensureShelvedRestored(folder)
  if (restored.status === 'failed') {
    return steerError(`SHELVED_RESTORE_FAILED: ${restored.reason}: ${restored.message}`, ctx.folder)
  }
  // Missions v4 S-25 (BUG-253): a session started for one step of a v4 mission holds the scoped verbs of
  // its role. The mission and the step are checked here, before anything starts; the credential itself
  // is minted when the spawn reaches `pty:create` (that is where the session id is fixed).
  const stepSpawn = await stepSpawnOf(args, folder)
  if (stepSpawn && 'error' in stepSpawn) return errorResult(stepSpawn.error)
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
      // Noted only once the folder's single-occupancy reservation is held (this runs after it), so a
      // refused duplicate never replaces the note of the spawn that is really in flight.
      if (stepSpawn) registerPendingSpawn(folder, stepSpawn, Date.now(), { agentOnly: true })
      let result = await bridge.dispatch('session.create', p)
      if (asRecord(result).error === 'FOLDER_NOT_FOUND') {
        result = await ensureFolderThenRetryCreate(folder, p, bridge)
      }
      if (stepSpawn && !dispatchSucceeded(result)) dropPendingSpawn(folder)
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
    deadlineFired: () => ctx.deadlineFlag?.fired === true,
    // Missions v4 S-34 (AC-82): a session started for a step of a mission is already inside one.
    ...(stepSpawn
      ? {}
      : { hint: () => proactiveHintFor(args, ctx, { kind: 'sessions', count: 1 }) }),
    // Missions v4 S-26 (AC-68): the session is alive, so the step it was started for is bound: its card
    // is created (or the one it has is bound) and the session is attached as a worker. A step the
    // leader does itself is never dispatched, so it never reaches here and never gets a card.
    ...(stepSpawn
      ? {
          bindMaterialized: (mat: Materialization) =>
            bindCreatedStepSession(folder, stepSpawn, mat, bridge),
          // The ACK says the spawn did not materialize; the step is still owed its attach (BUG-296).
          onNotMaterialized: (syntheticId: string) => {
            void awaitSessionBoot(syntheticId, LATE_BOOT_WAIT_MS)
              .then(async (boot) => {
                if (boot) {
                  await bindCreatedStepSession(folder, stepSpawn, boot, bridge)
                  return
                }
                await reportStepBindFailure(
                  folder,
                  stepSpawn,
                  'SESSION_NOT_BOOTED: the session did not boot in time. Attach it from the Mission dropdown.',
                  bridge
                )
              })
              .catch((err) => console.warn('[create_session] the late bind failed:', err))
          }
        }
      : {})
  }
  const res = await runCreateSession(
    folder,
    payload,
    { effectiveModel: resolvedBoot.effectiveModel, effectiveEffort: resolvedBoot.effectiveEffort },
    deps
  )
  // Campaign spec §3.2: the dispatch is a ledger event — written here, once, on success.
  const sessionId = createdSessionId(res)
  if (sessionId) {
    await recordLedgerEvent(folder, { folder }, { kind: 'dispatched', ref: sessionId, sessionId })
  }
  return res
}

/** The session id a successful `create_session` ACK names (materialized, else synthetic). */
function createdSessionId(res: CallToolResult): string | null {
  if (res.isError) return null
  const first = res.content[0]
  if (!first || first.type !== 'text') return null
  try {
    const ack = asRecord(JSON.parse(first.text))
    if (ack.ok !== true) return null
    const result = asRecord(ack.result)
    return strField(result, 'sessionId') ?? strField(result, 'syntheticId') ?? null
  } catch {
    return null
  }
}

/** Whether Harnu knows `sessionId`: the scan, or either in-flight registry (a live born-synthetic). */
function sessionKnown(sessionId: string, ctx: ToolHandlerCtx): boolean {
  const onDisk = ctx.folders.some((f) => f.sessions.some((sn) => sn.sessionId === sessionId))
  return (
    onDisk ||
    listInflightSessions().some((e) => e.syntheticId === sessionId) ||
    inFlightFolderFor(sessionId) !== undefined
  )
}

/**
 * T474: open a shell terminal an agent can address. Main spawns the PTY itself (the pane
 * cannot back a `terminalId` for a folder nobody is viewing), registers it, then asks the
 * renderer to show it. Any failure after the PTY exists kills it and leaves no record.
 */
const spawnTerminalHandler: Handler = async (args, ctx) => {
  if (!ctx.bridge) return errorResult('NO_BRIDGE')
  const targetFolder = resolvePaneFolder(ctx)
  if (!targetFolder) return steerError('PANE_FOLDER_UNKNOWN', ctx.folder)
  const ownerSessionId = strField(args, 'ownerSessionId') ?? null
  // Attribution only (spec §3.3): any KNOWN session may be named, the operator's own included.
  if (ownerSessionId !== null && !sessionKnown(ownerSessionId, ctx)) {
    return steerError('SESSION_NOT_FOUND', ctx.folder)
  }
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — do not spawn a shell nobody
  // will ever be told about.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  // The slot is claimed synchronously: `createTerminalPty` is async, and `spawn_terminal` is not
  // replayable, so parallel calls would otherwise all pass a count that only moves on register.
  if (!terminalRegistry.reserveSlot(targetFolder, MAX_AGENT_TERMINALS_PER_FOLDER)) {
    return steerError('TERMINAL_LIMIT', ctx.folder)
  }

  const terminalId = `h-${randomUUID()}`
  let ptyId: string
  try {
    ptyId = await createTerminalPty({ terminalId, folder: targetFolder, ownerSessionId })
  } catch (err) {
    // U2.3a: `createPty` restores a shelved worktree before the shell starts; a failed restore is
    // the agent's steering error, not a thrown tool failure.
    if (err instanceof ShelvedRestoreError) {
      return steerError(`SHELVED_RESTORE_FAILED: ${err.reason}: ${err.message}`, ctx.folder)
    }
    throw err
  } finally {
    // Registered by now (or the spawn failed): the record, not the reservation, holds the slot.
    terminalRegistry.releaseSlot(targetFolder)
  }
  let result: unknown
  try {
    const rec = terminalRegistry.get(terminalId)
    if (!rec) throw new Error('terminal record missing right after its PTY was created')
    result = await ctx.bridge.dispatch('pane.split', paneSplitFor(rec))
  } catch (err) {
    discardTerminalPty(ptyId)
    throw err
  }
  if (!dispatchSucceeded(result)) {
    discardTerminalPty(ptyId)
    return textResult({ ok: true, op: 'spawn_terminal', result })
  }
  return textResult({
    ok: true,
    op: 'spawn_terminal',
    terminalId,
    ownerSessionId,
    state: 'running',
    size: { ...AGENT_TERMINAL_SIZE },
    result
  })
}

/** T474: the terminals Harnu knows about, redacted like every fleet read. */
const listTerminalsHandler: Handler = async (args, ctx) => {
  const folderArg = strField(args, 'folder')
  const folder =
    folderArg === undefined
      ? undefined
      : (resolveKnownFolder(
          folderArg,
          ctx.folders.map((f) => f.path)
        ) ?? folderArg)
  const records = terminalRegistry.list()
  // The folder opt-in (T481): which of these terminals' folders let agents read what the
  // operator opens. Exact folder only.
  const optedIn = await terminalReadOptIns(
    await readUserProjects(),
    records.map((r) => r.folder)
  )
  const terminals = toTerminalListing(records, {
    denyFolders: ctx.denyFolders,
    home: os.homedir(),
    readOptIn: (f) => optedIn.has(f),
    // The global kill-switch (spec §6.5): off reads `writable: 'off'` + `writableReason`.
    writesEnabled: await readAgentTerminalWrites(),
    leaseActive: (r) => terminalLeases.isActive(r.terminalId, r.ptyId),
    ...(folder !== undefined ? { folder } : {}),
    ...(strField(args, 'ownerSessionId') !== undefined
      ? { ownerSessionId: strField(args, 'ownerSessionId') }
      : {})
  })
  return textResult({ terminals })
}

/**
 * T474 B3/B4: read the resolved screen of a terminal (spec §4.3). The access rules run at PLAN
 * level first (`terminal-gate-core`, spec §6.2); the same pure gate runs again here as the
 * last line, because the state it judged can change between the plan and the dispatch (the
 * operator turns the opt-in off, a terminal ends and is swept). The text is scrubbed (§4.5) on
 * every terminal, whoever opened it.
 */
const readTerminalHandler: Handler = async (args, ctx) => {
  const terminalId = strField(args, 'terminalId') ?? ''
  const mode = (strField(args, 'mode') ?? 'tail') as ReadMode
  const since = strField(args, 'since')
  if (mode === 'since' && since === undefined) {
    return errorResult("BAD_ARGS: since is required when mode is 'since'")
  }
  // A swept tombstone's model has no reader left; drop it before looking one up.
  pruneScreenModels((id) => terminalRegistry.get(id) !== undefined)
  const { rec, state } = await resolveTerminalGate(terminalId)
  const refusal = gateTerminalOp('read_terminal', state)
  if (refusal || !rec) return steerError(refusal ?? 'TERMINAL_NOT_FOUND', ctx.folder)
  // An agent terminal is born with its model (spec §5.2); an operator one is built now, from the
  // ring. Neither exists only if the record is being torn down.
  const model = ensureTerminalScreenModel(terminalId)
  if (!model) return steerError('TERMINAL_NOT_FOUND', ctx.folder)
  const home = os.homedir()

  const numArg = (key: string): number | undefined =>
    typeof args[key] === 'number' ? (args[key] as number) : undefined
  const read = await model.read({
    mode,
    ...(since !== undefined ? { since } : {}),
    ...(numArg('lines') !== undefined ? { lines: numArg('lines') } : {}),
    ...(numArg('maxChars') !== undefined ? { maxChars: numArg('maxChars') } : {}),
    scrub: (text) => scrubTerminalText(text, home)
  })
  if (!read.ok) return steerError(read.error, ctx.folder)
  terminalRegistry.noteAgentRead(terminalId)
  const { ok: _ok, ...screen } = read
  return textResult({
    ok: true,
    terminalId,
    state: rec.state,
    ...(rec.exit ? { exit: { code: rec.exit.code, reason: rec.exit.reason } } : {}),
    ...screen,
    note: TERMINAL_NOTE
  })
}

/**
 * T484: whether a send to `rec` must be covered by the operator's lease. Always for a terminal
 * the operator opened; for an agent terminal only when the plan let the call through on a lease
 * (`ask` mode). A free agent terminal needs none.
 */
const needsLease = (rec: { origin: string }, ctx: ToolHandlerCtx): boolean =>
  rec.origin === 'operator' || ctx.opts?.viaLease === true

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * T482 B5: type into a terminal (spec §4.4). The access rules ran at PLAN level; the same pure gate
 * runs again here as the last line, and once more after the queue wait, because the terminal can
 * end or be disconnected while a call waits its turn. Right before EACH `pty.write` the state is
 * judged once more (exited, disconnected, folder blocked since, deadline fired): the barrier and
 * the 50 ms gap after an `Esc` are real time in which the operator can act.
 *
 * Order: take the place in line (synchronously, on entry: arrival order) → admit (rate limit) →
 * wait for the head of this terminal's line (≤ 10 s) → barrier, read the input modes and mark the
 * cursor line → write (ONE `pty.write`, two when an `Esc` is followed by more bytes) → release the
 * line → settle → read the screen since the mark. The line is held only while bytes go out;
 * settling does not hold it. Output is scrubbed on every terminal. Without `waitFor` the call
 * returns after the settle (≤ 1 s); with it, on the first of pattern / idle / timeout / exit /
 * disconnect (unit B8, spec §4.4). The matcher sees unscrubbed text, the result never does.
 *
 * A send that stopped after some of its bytes went out (the terminal ended or was disconnected
 * between two writes) says so: `SEND_INCOMPLETE`, with `sent` listing only what was written.
 */
const sendTerminalHandler: Handler = async (args, ctx) => {
  const terminalId = strField(args, 'terminalId') ?? ''
  // First, before any `await`: this call's place in the line is when it ARRIVED (see the queue).
  const ticket = terminalWriteQueue.claim(args, terminalId)
  const input = typeof args.input === 'string' ? args.input : undefined
  const keys = Array.isArray(args.keys) ? (args.keys as string[]) : []
  const known = (id: string): boolean => terminalRegistry.get(id) !== undefined
  let model: ReturnType<typeof ensureTerminalScreenModel>
  let sendMark: string | null = null
  try {
    pruneScreenModels(known)
    terminalWriteQueue.prune(known)
    terminalLeases.prune(known)

    const first = await resolveTerminalGate(terminalId)
    const refusal = gateTerminalOp('send_terminal', first.state)
    if (refusal || !first.rec) return steerError(refusal ?? 'TERMINAL_NOT_FOUND', ctx.folder)
    // Last line of defence for the operator's say-so (spec §6.3): the plan lets a send through
    // only under an active lease. If it ended in the gap between the plan and now, nothing is typed.
    if (needsLease(first.rec, ctx) && !first.state.leaseActive) {
      return steerError('TERMINAL_LEASE_ENDED', ctx.folder)
    }
    model = ensureTerminalScreenModel(terminalId)
    if (!model) return steerError('TERMINAL_NOT_FOUND', ctx.folder)

    const admitted = terminalWriteQueue.admit(terminalId, ticket)
    if (!admitted.ok) return steerError(admitted.error, ctx.folder)
    const scope = admitted.scope
    try {
      if (!(await terminalWriteQueue.acquire(terminalId, scope))) {
        return steerError('TERMINAL_BUSY', ctx.folder)
      }
      let sentAt = 0
      let prep: Awaited<ReturnType<typeof model.prepareSend>>
      let built: Extract<ReturnType<typeof buildSend>, { ok: true }>
      let stopped = null as string | null
      let written: { written: number; complete: boolean }
      try {
        // The terminal may have ended or been disconnected while this call waited its turn.
        const again = await resolveTerminalGate(terminalId)
        const lateRefusal = gateTerminalOp('send_terminal', again.state)
        if (lateRefusal) return steerError(lateRefusal, ctx.folder)
        // …and the lease may have ended while this call waited its turn (after the ticket wait).
        if (again.rec && needsLease(again.rec, ctx) && !again.state.leaseActive) {
          return steerError('TERMINAL_LEASE_ENDED', ctx.folder)
        }
        prep = await model.prepareSend()
        sendMark = prep.cursor
        const b = buildSend(
          { input, keys, paste: args.paste === true },
          {
            applicationCursorKeys: prep.applicationCursorKeys,
            bracketedPaste: prep.bracketedPaste
          }
        )
        if (!b.ok) return errorResult(`${b.error}: ${b.detail}`)
        built = b
        // The state judged right before one `pty.write`: it is read fresh, every time, because the
        // plan, the queue wait and the barrier all ran before it.
        const mayWrite = async (): Promise<boolean> => {
          const file = await readUserProjects()
          const folder = terminalRegistry.get(terminalId)?.folder
          const optedIn =
            folder === undefined ? new Set<string>() : await terminalReadOptIns(file, [folder])
          // Nothing awaits between here and the `pty.write`: the record is read last.
          const writesEnabled = await readAgentTerminalWrites()
          const rec = terminalRegistry.get(terminalId)
          const blocked = file.projects.filter((p) => p.agentDenied === true).map((p) => p.path)
          stopped = canStillWrite(rec, {
            folderBlocked: rec !== undefined && isFolderDenied(rec.folder, blocked, os.homedir()),
            deadlineFired: ctx.deadlineFlag?.fired === true,
            readOptIn: rec !== undefined && optedIn.has(rec.folder),
            // The kill-switch, read just now with the record (spec §6.5).
            writesEnabled,
            // The lease table answers synchronously, so it is read here, last, with the record.
            leaseNeeded: rec !== undefined && needsLease(rec, ctx),
            leaseActive: rec !== undefined && terminalLeases.isActive(terminalId, rec.ptyId)
          })
          return stopped === null
        }
        written = await writeSegments(built.segments, {
          write: async (data) => {
            if (!(await mayWrite())) return false
            const ok = writeTerminalPty(terminalId, data)
            if (ok) {
              terminalWriteQueue.noteWrite(terminalId, scope)
              // A write under a lease keeps it alive: it ends 10 minutes after the LAST write.
              terminalLeases.noteWrite(terminalId)
            } else {
              // The PTY ended, or the operator disconnected, between the check and the write.
              stopped = terminalRegistry.get(terminalId)?.disconnected
                ? 'TERMINAL_DISCONNECTED'
                : 'TERMINAL_EXITED'
            }
            return ok
          },
          sleep: sleepMs
        })
        sentAt = Date.now()
      } finally {
        terminalWriteQueue.release(terminalId, scope)
      }

      // What actually reached the PTY, never what was asked for.
      const wrote = built.parts.slice(0, written.written)
      const inputWritten = wrote.some((part) => part.input)
      const sent = {
        inputChars: inputWritten && input !== undefined ? [...input].length : 0,
        keys: keys.slice(
          0,
          wrote.reduce((n, part) => n + part.keys, 0)
        ),
        pasted: inputWritten && built.pasted
      }
      if (!written.complete) {
        const reason = stopped ?? 'TERMINAL_EXITED'
        // Nothing reached the PTY: an ordinary refusal.
        if (written.written === 0) {
          return reason === 'DEADLINE_FIRED'
            ? errorResult('DEADLINE_FIRED')
            : steerError(reason, ctx.folder)
        }
        // Some bytes are out and the rest is not (e.g. an `Esc`, then the terminal ended).
        return {
          ...textResult({
            ok: false,
            error: 'SEND_INCOMPLETE',
            reason,
            terminalId,
            sent,
            message:
              'Only part of this send reached the terminal; `sent` lists exactly what did. ' +
              'Read the terminal before sending again.'
          }),
          isError: true
        }
      }

      const home = os.homedir()
      const scrub = (text: string): string => scrubTerminalText(text, home)
      const waitSpec = (args.waitFor ?? undefined) as WaitSpec | undefined
      // Everything after the write has to fit inside this: the settle's 1 s, or the caller's
      // `timeoutMs`. A stalled model may not push the call past it (spec §4.4, the total bound).
      const postDeadline =
        sentAt + (waitSpec ? (waitSpec.timeoutMs ?? TIMEOUT_DEFAULT_MS) : SETTLE_CAP_MS)
      const barrierBudget = (): number =>
        Math.max(50, Math.min(BARRIER_TIMEOUT_MS, postDeadline - Date.now()))
      // The line the cursor sat on at the send, read back to the end. A full-screen program has no
      // such line: its whole screen is the answer (spec §4.4, "Alternate screen").
      const readOpts = (barrierMs?: number): ReadOptions => ({
        ...(prep.altScreen || prep.cursor === null
          ? { mode: 'screen' as const }
          : { mode: 'since' as const, since: prep.cursor }),
        scrub,
        ...(barrierMs !== undefined ? { barrierMs } : {})
      })

      // Disconnect while the call is waiting for output (spec §6.4): the wait ends at once and the
      // output is what the screen showed AT THAT INSTANT, so the read is started inside the
      // listener, in the same tick as the disconnect, not after the call has woken up. It keeps the
      // full barrier: a short budget would resolve it late, and a late read shows later output.
      const liveModel = model
      const cut: {
        read: ReturnType<typeof liveModel.read> | null
        /** The tail read, started at the same instant, for when the send's line scrolled away. */
        tail: ReturnType<typeof liveModel.read> | null
      } = { read: null, tail: null }
      let wake: () => void = () => {}
      const woken = new Promise<void>((resolve) => {
        wake = resolve
      })
      const unwatch = terminalRegistry.onDisconnect(terminalId, () => {
        cut.read ??= liveModel.read(readOpts())
        cut.tail ??= liveModel.read({ mode: 'tail', lines: 500, scrub })
        wake()
      })
      const abort = { is: () => cut.read !== null, wake: () => woken }
      let wait: { reason: string; waitedMs: number; match?: string; patternDisabled?: true }
      try {
        if (waitSpec) {
          // What a pattern may match: the program's output after the send, minus the echo of
          // `input`, read without scrubbing and without taking a cursor.
          const surface = async (budgetMs: number): Promise<string> => {
            const barrierMs = Math.min(BARRIER_TIMEOUT_MS, budgetMs)
            const r = await liveModel.matchText({
              since: prep.cursor,
              altRows: prep.altRows,
              barrierMs
            })
            if (!r.ok) return '' // the send's anchor is gone: nothing is safely "since the send"
            return r.altScreen
              ? r.text
              : matchSurface(r.text, r.onCursorRow ? prep.cursorOffset : 0, input)
          }
          const result = await waitForOutput(
            {
              now: Date.now,
              sleep: sleepMs,
              sentAt,
              lastOutputAt: () => terminalRegistry.get(terminalId)?.lastOutputAt ?? 0,
              hasExited: () => (terminalRegistry.get(terminalId)?.state ?? 'exited') === 'exited',
              surface,
              abort
            },
            waitSpec
          )
          wait = {
            reason: result.reason,
            waitedMs: result.waitedMs,
            ...(result.match !== undefined
              ? { match: redactMatch(result.match, result.matchLine ?? result.match, scrub) }
              : {}),
            ...(result.patternDisabled ? { patternDisabled: true as const } : {})
          }
        } else {
          const waitedMs = await settleAfterSend({
            now: Date.now,
            sleep: sleepMs,
            lastOutputAt: () => terminalRegistry.get(terminalId)?.lastOutputAt ?? 0,
            sentAt,
            abort
          })
          wait = { reason: cut.read !== null ? 'disconnected' : 'none', waitedMs }
        }
      } finally {
        unwatch()
      }

      let read = await (cut.read ?? model.read(readOpts(barrierBudget())))
      // The send's anchor is gone: the last 500 lines are the best left, and not exact.
      const lostAnchor = !read.ok
      if (!read.ok) read = await (cut.tail ?? model.read({ mode: 'tail', lines: 500, scrub }))
      if (!read.ok) return steerError('CURSOR_EXPIRED', ctx.folder)

      const rec = terminalRegistry.get(terminalId)
      const { ok: _ok, cursorPos: _cursorPos, size: _size, ...screen } = read
      return textResult({
        ok: true,
        terminalId,
        state: rec?.state ?? 'exited',
        ...(rec?.exit ? { exit: { code: rec.exit.code, reason: rec.exit.reason } } : {}),
        sent,
        wait,
        output: screen.text,
        truncated: screen.truncated,
        droppedLines: screen.droppedLines,
        altScreen: screen.altScreen,
        approximate: screen.approximate || prep.approximate || lostAnchor,
        othersWrote: scope.othersWrote,
        operatorTyped:
          rec?.lastOperatorWriteAt != null && rec.lastOperatorWriteAt >= scope.startedAt,
        note: TERMINAL_NOTE,
        cursor: screen.cursor
      })
    } finally {
      terminalWriteQueue.finish(terminalId, scope)
    }
  } finally {
    // The mark was private to this call; the agent's cursor is the one the read returned.
    model?.releaseSend(sendMark)
    terminalWriteQueue.abandonTicket(terminalId, ticket)
  }
}

const createWorktreeHandler: Handler = async (args, ctx) => {
  const branch = strField(args, 'branch')
  if (!branch) return errorResult('BAD_ARGS: branch is required')
  const caller = declaredCaller(args)
  if (!caller.ok) return errorResult(caller.error)
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
    // Campaign spec §3.2: the cut is a ledger event, written once the worktree exists.
    await recordLedgerEvent(
      ctx.folder,
      { folder: result.path, branch: result.branch },
      { kind: 'worktree', ref: result.path, worktree: result.path, branch: result.branch }
    )
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
        : {}),
      // Missions v4 S-34 (AC-82): a backstop, once per session; Harnu never creates the mission itself.
      ...(await proactiveHintFor(args, ctx, { kind: 'worktree' }))
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
  //
  // Removing a folder closes its Your move cards, and no verb may close a card the operator can
  // still see: refuse while the folder (exactly, not its subfolders) holds an open live card.
  // A folder that still exists keeps its own refusal below.
  const guard = await yourMoveGuardStore()
  if (guard) {
    const normalized = await normalizeStoredPath(ctx.folder)
    const trim = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)
    const spellings = new Set([trim(ctx.folder), trim(normalized)])
    const holds = guard
      .state()
      .cards.some((c) => isQueueVisibleCard(c) && spellings.has(trim(c.folder)))
    const exists = await fs.access(normalized).then(
      () => true,
      () => false
    )
    if (holds && !exists) {
      return errorResult(
        'OPEN_CARDS: this folder still has a Your move card open for the operator, and only the operator may close a card. Nothing was removed. Leave the folder in the sidebar.'
      )
    }
  }
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
    // The entry's chain and recall metadata (validated at the gate).
    ...(strField(args, 'supersedes') ? { supersedes: strField(args, 'supersedes') } : {}),
    ...(Array.isArray(args.watches) ? { watches: args.watches.map(String) } : {}),
    ...(strField(args, 'mission') ? { mission: strField(args, 'mission') } : {}),
    now: Date.now()
  })
  if (!res.ok) return errorResult(`${res.error}: ${res.detail}`)
  return textResult({
    ok: true,
    op: 'memory_append',
    page: res.page,
    file: res.file,
    bytes: res.bytes,
    ...(res.entryId ? { entryId: res.entryId } : {})
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
  // Not the pane's own Save (no `selfWrite`): an open pane must hear about this write.
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
    shapes: canvasShapeCatalogAck(),
    edgeStyle: canvasEdgeStyleAck()
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
  shadow: { event: string; by: string; verb: string },
  /** Fields the ACK gains, decided once the stamped cards are known (the proactive hint, S-34). */
  extra?: (stamped: readonly string[]) => Promise<Record<string, unknown>>
): Promise<CallToolResult> {
  const stampResult = await stampManifestApprovals(
    folder,
    resolved,
    selectedSlugs,
    Date.now(),
    substrateOverrides
  )
  const skipped = resolved.map((r) => r.slug).filter((slug) => !selectedSlugs.includes(slug))
  // Campaign spec §3.2: each stamped card drains into a dispatch — one ledger row per card.
  for (const slug of stampResult.stamped) {
    await recordLedgerEvent(
      folder,
      { card: slug },
      { kind: 'dispatched', ref: slug, detail: 'manifest' }
    )
  }
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
    ...(stampResult.failed.length ? { failed: stampResult.failed } : {}),
    ...(extra ? await extra(stampResult.stamped) : {})
  })
}

/**
 * Missions v4 S-26 (AC-68): the step a manifest card is the work of. A card entry that carries
 * `missionId` and `stepId` is stamped for that step when the manifest is stamped, so the session the
 * drain starts for it is attached to the step as a worker. Read from the raw args, since the confirm's
 * disclosure rows (which the Allow reuses) carry no step.
 */
interface ManifestStepBinding {
  slug: string
  missionId: string
  stepId: string
}

function manifestStepsFromArgs(args: Record<string, unknown>): ManifestStepBinding[] {
  if (!Array.isArray(args.cards)) return []
  const out: ManifestStepBinding[] = []
  for (const raw of args.cards) {
    if (typeof raw !== 'object' || raw === null) continue
    const rec = raw as Record<string, unknown>
    const slug = strField(rec, 'slug')
    const missionId = strField(rec, 'missionId')
    const stepId = strField(rec, 'stepId')
    if (slug && missionId && stepId) out.push({ slug, missionId, stepId })
  }
  return out
}

/**
 * Judge every card of the manifest that names a step, and only when they all hold, stamp each one for its
 * step. A refusal names the card and stamps nothing, so a batch is never half bound. `selected` are the
 * cards that will be stamped `approved` (an operator may have unchecked some: those are left alone).
 */
async function bindManifestSteps(
  folder: string,
  args: Record<string, unknown>,
  resolved: readonly ManifestCardResolved[],
  selected: readonly string[]
): Promise<string | null> {
  const steps = manifestStepsFromArgs(args).filter((st) => selected.includes(st.slug))
  if (steps.length === 0) return null
  const seen = new Set<string>()
  for (const st of steps) {
    const key = `${st.missionId}/${st.stepId}`
    if (seen.has(key)) {
      return `BAD_ARGS: two cards of this manifest name the step ${st.stepId} of ${st.missionId}; a step has one card.`
    }
    seen.add(key)
  }
  const board = await realBoardIo(folder)
  const to = (slug: string): CardSubstrate | undefined => {
    const substrate = resolved.find((r) => r.slug === slug)?.substrate
    return substrate !== undefined && isCardSubstrate(substrate) ? substrate : undefined
  }
  for (const dryRun of [true, false]) {
    for (const st of steps) {
      const res = await stampCardForStep(
        folder,
        {
          slug: st.slug,
          missionId: st.missionId,
          stepId: st.stepId,
          ...(to(st.slug) ? { to: to(st.slug) } : {}),
          dryRun
        },
        board
      )
      if (!res.ok) return `${res.error} (card "${st.slug}": nothing in this manifest was stamped.)`
    }
  }
  return null
}

const submitManifestHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before
  // stamping approvals nobody will read the ACK for.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const caller = declaredCaller(args)
  if (!caller.ok) return errorResult(caller.error)

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
    const refusedStep = await bindManifestSteps(folder, args, resolved, selectedSlugs)
    if (refusedStep) return errorResult(refusedStep)
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
  const refusedStep = await bindManifestSteps(folder, args, built.resolved, selectedSlugs)
  if (refusedStep) return errorResult(refusedStep)
  // The agent's own per-card substrate request (`cards[].substrate`) already
  // shaped `row.substrate` in the disclosure above; carry it through to the
  // actual stamp too — there is no operator substrate-picker on this path to
  // separately confirm it, so the agent's own request is authoritative.
  const substrateOverrides: Record<string, string> = {}
  for (const c of cards) {
    if (c.substrate) substrateOverrides[c.slug] = c.substrate
  }
  const res = await stampManifestAndAck(
    folder,
    built.resolved,
    selectedSlugs,
    substrateOverrides,
    {
      event: 'roadmap:manifest-stamp',
      by: 'agent-silent-allow',
      verb: 'manifest self-approved (agent, ask off)'
    },
    (stamped) =>
      // Missions v4 S-34 (AC-82): each stamped card drains into one session. The operator's own Allow
      // (above) is never hinted: the operator is not a session that should lead a mission.
      proactiveHintFor(args, ctx, { kind: 'sessions', count: stamped.length })
  )
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
  if (!sessionKnown(sessionId, ctx)) return steerError('SESSION_NOT_FOUND', ctx.folder)

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

/**
 * The ACK `warning` for a worker prompt's skill mentions: ones nothing answers to (T305 AC-6) and,
 * for an observe worker, ones refused because the skill declares frontmatter hooks (BUG-169). The
 * worker is created or edited either way; this only says which mentions will never stage.
 */
function skillWarning(
  missingSkills: readonly string[],
  rejectedSkills: readonly string[]
): { warning: string } | Record<string, never> {
  const parts: string[] = []
  if (missingSkills.length > 0) {
    parts.push(
      `Prompt names skill(s) nothing on this machine answers to, so they will never stage: ${missingSkills.join(', ')}`
    )
  }
  if (rejectedSkills.length > 0) {
    parts.push(
      `Prompt names skill(s) an observe worker never stages (they declare hooks or contain files it will not copy): ${rejectedSkills.join(', ')}`
    )
  }
  return parts.length > 0 ? { warning: parts.join('. ') } : {}
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
  // BUG-166: opt-in to WebFetch. Only the literal `true` counts; anything else is off.
  const allowNetwork = args.allowNetwork === true

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
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
      allowNetwork
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
  const { worker, missingSkills, rejectedSkills } = created

  return textResult({
    ok: true,
    op: 'create_worker',
    id: worker.id,
    name: worker.name,
    folder: worker.folder,
    mode: worker.mode,
    everyMinutes: worker.everyMinutes,
    enabled: worker.enabled,
    // BUG-166: what actually took effect, so the agent reads it instead of assuming.
    allowNetwork: worker.allowNetwork === true,
    // AC-6: reported, never silently dropped — the worker IS created either way.
    ...skillWarning(missingSkills, rejectedSkills)
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
  if (typeof setRaw.allowNetwork === 'boolean') patch.allowNetwork = setRaw.allowNetwork
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
  const { worker, missingSkills, rejectedSkills, tickInFlight } = result

  return textResult({
    ok: true,
    op: 'update_worker',
    id: worker.id,
    name: worker.name,
    mode: worker.mode,
    everyMinutes: worker.everyMinutes,
    enabled: worker.enabled,
    allowNetwork: worker.allowNetwork === true,
    // T316 decision 4: whether a tick was already running with the PRE-edit
    // worker at the moment this call landed — the edit itself never touches it.
    tickInFlight,
    ...skillWarning(missingSkills, rejectedSkills)
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

// ---- T614 `github_budget` -----------------------------------------------------

/** The shared GitHub budget (T611). Reads the in-memory tracker: no `gh` call, no folder, no write. */
const githubBudgetHandler: Handler = async () => {
  githubBudget.tick()
  return textResult(githubBudgetPayload(githubBudget.snapshot()))
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
  // The current snapshot, never a forced gather: an observe read must not write (a gather
  // clears marks and prunes files), so the timer and the operator keep that to themselves.
  // `scannedAt` tells the caller how old the picture is.
  const snap = await svc.snapshot()
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
 * deletes nothing: the bucket rules still decide whether it ever becomes ready to clean, and only
 * the operator (or the autopilot, once acknowledged) cleans one.
 */
const releaseWorktreeHandler: Handler = async (args, ctx) => {
  const svc = getGcService()
  if (!svc) return errorResult(GC_NOT_READY)
  const home = os.homedir()
  const folder = strField(args, 'folder') || ctx.folder || undefined
  const id = strField(args, 'id') || undefined
  if (!folder && !id) return errorResult('BAD_ARGS: pass a folder or an id from list_cleanup')
  if (folder && isFolderDenied(folder, ctx.denyFolders, home)) {
    return steerError('FOLDER_NOT_ALLOWED', folder)
  }

  const snap = await svc.snapshot()
  const now = Date.now()
  // A symlinked spelling is the same folder: compare real paths, not spellings.
  const real = await realPathLookup(
    [
      folder,
      ...snap.bundles.flatMap((b) => [b.item.path, b.item.repoPath]),
      ...ctx.folders.map((f) => f.path)
    ],
    home
  )
  const plan = planRelease(
    snap,
    { ...(folder ? { folder } : {}), ...(id ? { id } : {}) },
    {
      denyFolders: ctx.denyFolders,
      home,
      now,
      folders: ctx.folders,
      real
    }
  )
  if (!plan.ok) {
    // A repo the operator blocked is as closed as the worktree folder itself. An id names no
    // folder, so none is echoed.
    if (plan.blocked) return steerError('FOLDER_NOT_ALLOWED', folder)
    return { content: [{ type: 'text', text: JSON.stringify(plan.refusal) }], isError: true }
  }
  // The single commit point: past the 120s deadline the caller already got TOOL_TIMEOUT.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  if (!plan.ack.alreadyReleased) await svc.release(plan.bundleId, now, plan.from)
  return textResult(plan.ack)
}

// ---- T655 `archive_session` ---------------------------------------------------

/**
 * Archive or restore sessions through the main-process archive store, the same set the
 * sidebar's Archive action writes. Each id is judged on its own (see
 * {@link planArchiveSession}) inside the store's own serialized write, which commits once;
 * the renderer hears about it through the store's change event, so a window that is open
 * updates live and one that is closed simply reads the file at boot. This handler never touches a transcript or a worktree: the only file it can write is the store.
 */
const archiveSessionHandler: Handler = async (args, ctx) => {
  const store = getSessionArchive()
  if (!store) {
    return errorResult(
      'ARCHIVE_NOT_READY: the session archive has not started yet. Retry in a moment.'
    )
  }
  const sessionIds = Array.isArray(args.sessionIds)
    ? args.sessionIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  if (sessionIds.length === 0) return errorResult('BAD_ARGS: pass 1..100 session ids')
  const unarchive = args.unarchive === true

  // An agent's archive must never close a Your move card (the archive listener would): a
  // session with a card the operator can still see is refused below. The cards are read inside
  // the store's transaction, so a card filed an instant ago is seen. Mode Off, or no store, and
  // an unarchive, skip the guard.
  const guard = unarchive ? null : await yourMoveGuardStore()

  const home = os.homedir()
  const folderBySession = new Map<string, string>()
  for (const f of ctx.folders) {
    for (const s of f.sessions) folderBySession.set(s.sessionId, s.projectPath ?? f.path)
  }

  // Every row is decided INSIDE the store's serialized write, against the set as it stands
  // after all earlier writes, so concurrent calls read as one serial order and an ACK row can
  // never describe a state the store did not hold. The deadline check is the commit point:
  // past the 120s deadline the caller already got TOOL_TIMEOUT, so nothing is written.
  let plan: ArchivePlan | null
  try {
    plan = await store.transact((archived) => {
      if (ctx.deadlineFlag?.fired) return { result: null }
      const states = taskStateRecord()
      const withApproval = new Set(listPendingApprovals().map((a) => a.sessionId))
      const withCard = new Set(
        guard
          ? guard
              .state()
              .cards.filter(isQueueVisibleCard)
              .map((c) => c.sessionId)
          : []
      )
      const p = planArchiveSession(sessionIds, unarchive, {
        archived,
        folderOf: (id) => folderBySession.get(id),
        isDenied: (folder) => isFolderDenied(folder, ctx.denyFolders, home),
        taskStateOf: (id) => states[id],
        hasPendingApproval: (id) => withApproval.has(id),
        hasOpenCard: (id) => withCard.has(id)
      })
      return { archive: p.toArchive, unarchive: p.toRestore, result: p }
    })
  } catch (err) {
    // The write failed: the store is exactly as it was, so no row may claim otherwise.
    return errorResult(
      `ARCHIVE_WRITE_FAILED: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`
    )
  }
  if (!plan) return errorResult('DEADLINE_FIRED')

  const counts: Record<string, number> = {}
  for (const r of plan.rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
  appendAudit({
    ts: Date.now(),
    tool: 'archive_session',
    folder: '',
    verdict: 'allow',
    disclosedPayloadSummary: summarizeArchive(unarchive, plan.rows),
    result: 'ok'
  })
  return textResult({
    ok: !plan.rows.some((r) => r.outcome === 'refused' || r.outcome === 'notFound'),
    op: 'archive_session',
    unarchive,
    results: plan.rows,
    counts
  })
}

// ---- T661 `hide_folder` -------------------------------------------------------

/**
 * Hide or show sidebar folders through the SAME `hiddenPaths` the folder menu writes. Every
 * row is decided inside the user-projects write lock ({@link transactHiddenPaths}), on the
 * file just read, so N concurrent calls (and the menu action) read as one serial order and
 * the ACK always matches what was persisted. A failed write rejects the whole call with
 * nothing changed. The renderer hears the change through the store's listener (forwarded as
 * `userProjects:hiddenChanged`), so an open sidebar updates live. Nothing on disk is touched.
 *
 * The transaction is entered before the first `await`, so calls reach the lock in arrival order.
 */
const hideFolderHandler: Handler = (args, ctx) => {
  const requested = Array.isArray(args.folders)
    ? args.folders.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  if (requested.length === 0) {
    return Promise.resolve(errorResult('BAD_ARGS: pass 1..100 absolute folder paths'))
  }
  const unhide = args.unhide === true
  const home = os.homedir()
  const states = taskStateRecord()
  const withApproval = new Set(listPendingApprovals().map((a) => a.sessionId))

  // Group the scanned sessions by the folder they run in, keyed by the normalized path the
  // store persists (a session counts for its own folder only, never for a parent or child).
  const sessionsByRawFolder = new Map<string, string[]>()
  for (const f of ctx.folders) {
    for (const s of f.sessions) {
      const raw = s.projectPath ?? f.path
      const list = sessionsByRawFolder.get(raw)
      if (list) list.push(s.sessionId)
      else sessionsByRawFolder.set(raw, [s.sessionId])
    }
  }
  const scannedFolders = ctx.folders.map((f) => f.path)

  return transactHiddenPaths(async ({ hidden, projects }) => {
    const paths = await Promise.all(requested.map((p) => normalizeStoredPath(p)))
    const known = new Set<string>([...hidden, ...projects.map((p) => p.path)])
    for (const p of await Promise.all(scannedFolders.map((p) => normalizeStoredPath(p)))) {
      known.add(p)
    }
    const sessionsByFolder = new Map<string, string[]>()
    for (const [raw, ids] of sessionsByRawFolder) {
      const key = await normalizeStoredPath(raw)
      sessionsByFolder.set(key, [...(sessionsByFolder.get(key) ?? []), ...ids])
    }

    // The single commit point: past the 120s deadline the caller already got TOOL_TIMEOUT.
    if (ctx.deadlineFlag?.fired) return { toHide: [], toShow: [], result: null }
    const plan = planHideFolder(paths, unhide, {
      hidden,
      isKnown: (p) => known.has(p),
      isDenied: (p) => isFolderDenied(p, ctx.denyFolders, home),
      hasWorkingSession: (p) =>
        (sessionsByFolder.get(p) ?? []).some((id) => states[id] === 'working'),
      hasPendingApproval: (p) => (sessionsByFolder.get(p) ?? []).some((id) => withApproval.has(id))
    })
    return { toHide: plan.toHide, toShow: plan.toShow, result: plan }
  }).then(
    ({ result: plan }) => {
      if (plan === null) return errorResult('DEADLINE_FIRED')
      const counts: Record<string, number> = {}
      for (const r of plan.rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
      appendAudit({
        ts: Date.now(),
        tool: 'hide_folder',
        folder: '',
        verdict: 'allow',
        disclosedPayloadSummary: summarizeHide(unhide, plan.rows),
        result: 'ok'
      })
      return textResult({
        ok: !plan.rows.some((r) => r.outcome === 'refused' || r.outcome === 'notFound'),
        op: 'hide_folder',
        unhide,
        results: plan.rows,
        counts
      })
    },
    (err: unknown) =>
      errorResult(
        `HIDE_WRITE_FAILED: could not read or save the hidden folders, nothing changed (${
          err instanceof Error ? err.message : String(err)
        })`
      )
  )
}

// ---- Your move `your_move` ----------------------------------------------------

/** Calls per session and UTC hour: the count is kept per session, reset when the hour turns. */
const yourMoveCounters = new Map<string, { hour: number; count: number }>()

function takeYourMoveSlot(sessionId: string, now: number): boolean {
  const hour = Math.floor(now / 3_600_000)
  const existing = yourMoveCounters.get(sessionId)
  const current = existing && existing.hour === hour ? existing.count : 0
  if (current >= YOUR_MOVE_LIMIT_PER_HOUR) return false
  yourMoveCounters.set(sessionId, { hour, count: current + 1 })
  return true
}

/**
 * The file `src/main/your-move/ipc.ts` keeps the operator's mode in. The prefs are written
 * before the in-memory copy changes, so reading the file here always sees the current mode.
 */
const YOUR_MOVE_PREFS_FILE = 'your-move-prefs.json'

/** A card the operator can see in the queue: open and in the live lane (Observe cards show in no queue). */
const isQueueVisibleCard = (c: YourMoveCard): boolean =>
  c.closedAt === undefined && c.lane === 'live'

/**
 * The store to guard against agent actions that would close a card, or null when there is
 * nothing to guard: no store, or Your move is Off.
 */
async function yourMoveGuardStore(): Promise<YourMoveStore | null> {
  const store = getYourMoveStore()
  if (!store) return null
  const prefs = await readYourMovePrefs(path.join(app.getPath('userData'), YOUR_MOVE_PREFS_FILE))
  return effectiveMode(prefs) === 'off' ? null : store
}

/**
 * File or refresh one Your move card. Answers with a refusal, never a throw: a store that
 * could not be opened, a mode that is Off, a spent rate slot and a failed write each come
 * back as an error result naming what to do. A refused call files nothing. There is no close
 * path here by design: only the operator, the judge (with an operator entry) and a source
 * resolving can close a card.
 */
const yourMoveHandler: Handler = async (args) => {
  const store = getYourMoveStore()
  if (!store) {
    return errorResult(
      'YOUR_MOVE_UNAVAILABLE: the Your move queue could not be opened, so nothing was filed. Say what you need from the operator in your reply instead.'
    )
  }
  const folder = strField(args, 'folder') ?? ''
  const sessionId = strField(args, 'sessionId') ?? ''
  const kind = strField(args, 'kind')
  const ask = strField(args, 'ask')
  if (!folder || !sessionId || !kind || !ask || ask.trim() === '') {
    return errorResult('BAD_ARGS: folder, sessionId, kind and a non-blank ask are required')
  }
  const cardId = strField(args, 'cardId')

  const prefs = await readYourMovePrefs(path.join(app.getPath('userData'), YOUR_MOVE_PREFS_FILE))
  const mode = effectiveMode(prefs)
  if (mode === 'off' || isFolderDisabled(prefs, folder)) {
    return errorResult(
      'YOUR_MOVE_OFF: Your move is off (for everything, or for this folder), so nothing was filed. Do not retry; say what you need from the operator in your reply instead.'
    )
  }

  const now = Date.now()
  if (!takeYourMoveSlot(sessionId, now)) {
    appendAudit({
      ts: now,
      tool: 'your_move',
      folder,
      verdict: 'deny',
      disclosedPayloadSummary: `session ${sessionId.slice(0, 8)} reached ${YOUR_MOVE_LIMIT_PER_HOUR} cards this hour`,
      result: 'YOUR_MOVE_RATE_LIMIT'
    })
    return errorResult(
      `YOUR_MOVE_RATE_LIMIT: this session already filed ${YOUR_MOVE_LIMIT_PER_HOUR} cards this UTC hour, so this one was refused and logged. It is a loop-abandon backstop; say what you need in your reply instead.`
    )
  }

  const options = Array.isArray(args.options)
    ? args.options.filter((o): o is string => typeof o === 'string')
    : undefined
  try {
    type Filed = { cardId: string; refreshed: boolean } | { error: 'CARD_NOT_FOUND' }
    const out = await store.transact<Filed>((s) => {
      const filed = fileFromVerb(
        s,
        {
          folder,
          sessionId,
          kind: kind as 'decide' | 'go_no_go' | 'provide' | 'do' | 'check',
          ask,
          blocks: strField(args, 'blocks'),
          options,
          recommended: strField(args, 'recommended'),
          cardId,
          lane: mode === 'live' ? 'live' : 'observe'
        },
        () => randomUUID(),
        now
      )
      return 'error' in filed
        ? { next: s, result: filed }
        : { next: filed.state, result: { cardId: filed.cardId, refreshed: filed.refreshed } }
    })
    if ('error' in out) {
      return errorResult(
        "CARD_NOT_FOUND: no open card of yours has that cardId (it is unknown, already closed, or another session's). File a new card without cardId."
      )
    }
    return textResult({ ok: true, op: 'your_move', cardId: out.cardId, refreshed: out.refreshed })
  } catch (err) {
    return errorResult(
      `YOUR_MOVE_WRITE_FAILED: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`
    )
  }
}

// ---- mission_* verbs (Missions v4) ---------------------------------------------------------
//
// Every mission verb is a v4 verb (`missions/verbs.ts` runs them). This file is the MCP side: the
// caller built from the transport, the facts gathered on the server and the folder's gate. A mission
// still held in a v3 file answers the same verbs: the store reads it in memory and the first write
// converts it by copy (spec "Design · Compatibility with records written by v3").

/** A Claude session UUID — the id shape `get_fleet` keys sessions by. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function badSessionIdMessage(field: string, value: string): string {
  return `BAD_SESSION_ID: ${field} "${value}" is not a Claude session UUID — pass the session's transcript id (the uuid get_fleet reports, never a synthetic-… id). Mission leaders and session links are matched by that id; any other shape silently never matches.`
}

/**
 * The live memory entries whose `watches` overlap what a new mission is about. Best-effort — memory
 * trouble must never fail a create, so it recalls nothing.
 */
async function recallFor(folder: string, query: RecallQuery): Promise<RecallHit[]> {
  try {
    const { memoryDir } = await resolveMemoryLocation(folder)
    return await recallForScope(memoryDir, query)
  } catch (err) {
    console.warn('[recall] could not read memory:', err)
    return []
  }
}

/** A refusal for a folder (or its repo root) the operator blocked for agents. */
function missionFolderRefusal(folder: string, root: string, ctx: ToolHandlerCtx): string | null {
  if (isFolderDenied(folder, ctx.denyFolders) || isFolderDenied(root, ctx.denyFolders)) {
    return 'FOLDER_NOT_ALLOWED: the operator blocked this folder for agents — its missions are off limits. Tell the operator; they can unblock it from the folder menu.'
  }
  return null
}

/**
 * Record a write-time event (dispatch, worktree cut, manifest drain) on the mission it belongs to: the
 * one whose step links the worktree or names the card, else the repo's only open mission. The row goes
 * to the ledger store beside the mission (`missions/ledger-store.ts`); no mission file is written, so a
 * v3 file stays as a v3 build left it. Best-effort; never throws.
 */
export async function recordLedgerEvent(
  folder: string,
  hints: LedgerHints,
  row: LedgerRowInput
): Promise<void> {
  try {
    const root = missionRoot(folder)
    const open = (await listMissionRecords(root)).records
      .map((r) => r.record)
      .filter((r) => r.status === 'open')
    const at = new Date().toISOString()
    for (const t of pickLedgerTargets(open, hints)) {
      bindMissionRoot(t.missionId, root)
      recordObserved(t.missionId, [{ at, ...row, ...(t.stepId ? { stepId: t.stepId } : {}) }])
    }
  } catch (err) {
    console.warn(`[mission-ledger] could not record ${row.kind}:`, err)
  }
}

/**
 * `rebase_stack`: the leader of a mission rebases one of its steps' own worktrees, never pushing. The
 * git half and the ownership rules are `missions/rebase.ts`'s; this is the transport around it.
 */
const rebaseStackHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const missionId = strField(args, 'missionId') ?? ''
  const onto = strField(args, 'onto') ?? ''
  const from = strField(args, 'from')
  const wantedStep = strField(args, 'stepId')
  const root = missionRoot(folder)
  const refusal = missionFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)

  const who = actorOf(args, ctx)
  if (!who.ok) return errorResult(who.error)
  const read = await readMissionRecord(root, missionId)
  if (!read.ok) return errorResult(read.error)
  const out = await rebaseStackV4(
    {
      root,
      record: read.record,
      actor: who.actor,
      onto,
      ...(from ? { from } : {}),
      ...(wantedStep ? { stepId: wantedStep } : {})
    },
    {
      executedIn: async (slug) => {
        const card = await readCard(root, slug).catch(() => null)
        return card?.ok ? card.card.executedIn : undefined
      },
      otherOpenMissions: async () =>
        (await listMissionRecords(root)).records
          .map((r) => r.record)
          .filter((r) => r.id !== missionId)
    }
  )
  return out.ok ? textResult(out.ack) : errorResult(out.error)
}

/**
 * `mission_update_step` stays in the catalog (fate table: keep, shrink to `title`, `milestone`,
 * `waitsFor`, `optional`), but no v4 write for it has been built: no slice of the Missions v4 delivery
 * owns one. It refuses, names what to use instead, and writes nothing, as it already did on a v4 mission.
 */
const missionUpdateStepUnbuilt: Handler = async (_args, ctx) => {
  if (ctx.folder) {
    const refusal = missionFolderRefusal(ctx.folder, missionRoot(ctx.folder), ctx)
    if (refusal) return errorResult(refusal)
  }
  return errorResult(
    'NOT_AVAILABLE: mission_update_step has no v4 write yet. Add what is missing with mission_add_step (a new step), mission_add_ac (a criterion) or mission_link, or tell the operator.'
  )
}

/* ---- T564 U1: the browser verbs ------------------------------------------------------------------- */

/** The bits of this call's context the browser verbs need, over the real singletons. */
function browserEnv(ctx: ToolHandlerCtx): Parameters<typeof makeBrowserVerbDeps>[0] {
  return {
    bridge: ctx.bridge,
    sessionKnown: (id) => sessionKnown(id, ctx),
    folderBlocked: (folder) => isFolderDenied(folder, ctx.denyFolders, os.homedir())
  }
}

function browserDeps(ctx: ToolHandlerCtx): ReturnType<typeof makeBrowserVerbDeps> {
  return makeBrowserVerbDeps(browserEnv(ctx))
}

/** A verb result: `ok:false` is the steering refusal shape of spec §6, returned as an error result. */
function browserResult(input: Record<string, unknown>): CallToolResult {
  const res = withRevivedFlag(input)
  if (res.ok === false) {
    return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: true }
  }
  // A screenshot rides as an image content block; the JSON beside it never repeats the bytes.
  const { image, ...rest } = res as { image?: { data: string; mimeType: string } } & Record<
    string,
    unknown
  >
  if (image) {
    return {
      content: [
        { type: 'image', data: image.data, mimeType: image.mimeType },
        { type: 'text', text: JSON.stringify(rest) }
      ]
    }
  }
  return textResult(res)
}

/** The strings a verb carries, with `undefined` for absent. */
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? (args[key] as string) : undefined
}

const browserOpenHandler: Handler = async (args, ctx) => {
  if (!ctx.bridge) return errorResult('NO_BRIDGE')
  const folder = resolvePaneFolder(ctx)
  if (!folder) return steerError('PANE_FOLDER_UNKNOWN', ctx.folder)
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT: do not open a page nobody will be told about.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await openVerb(
    {
      folder,
      ...(optStr(args, 'url') !== undefined ? { url: optStr(args, 'url') } : {}),
      ...(optStr(args, 'path') !== undefined ? { path: optStr(args, 'path') } : {}),
      ...(optStr(args, 'html') !== undefined ? { html: optStr(args, 'html') } : {}),
      ...(optStr(args, 'name') !== undefined ? { name: optStr(args, 'name') } : {}),
      ...(optStr(args, 'ownerSessionId') !== undefined
        ? { ownerSessionId: optStr(args, 'ownerSessionId') }
        : {}),
      ...(optStr(args, 'device') !== undefined ? { device: optStr(args, 'device') } : {}),
      ...(typeof args.background === 'boolean' ? { background: args.background } : {}),
      // `paneId` adds a tab to that agent pane of the folder (browser-tabs S-6).
      ...(optStr(args, 'paneId') !== undefined ? { paneId: optStr(args, 'paneId') } : {})
    },
    browserDeps(ctx)
  )
  return browserResult({ op: 'browser_open', ...res })
}

const browserListHandler: Handler = async (args, ctx) => {
  const folderArg = optStr(args, 'folder')
  const folder =
    folderArg === undefined
      ? undefined
      : (resolveKnownFolder(
          folderArg,
          ctx.folders.map((f) => f.path)
        ) ?? folderArg)
  const res = await listVerb(
    {
      ...(folder !== undefined ? { folder } : {}),
      ...(optStr(args, 'ownerSessionId') !== undefined
        ? { ownerSessionId: optStr(args, 'ownerSessionId') }
        : {})
    },
    browserDeps(ctx)
  )
  return browserResult(res)
}

const browserNavigateHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await navigateVerb(
    {
      ...paneArgs(args),
      ...(optStr(args, 'url') !== undefined ? { url: optStr(args, 'url') } : {}),
      ...(typeof args.action === 'string'
        ? { action: args.action as 'back' | 'forward' | 'reload' | 'stop' }
        : {}),
      ...(typeof args.hard === 'boolean' ? { hard: args.hard } : {}),
      ...(typeof args.waitUntil === 'string'
        ? { waitUntil: args.waitUntil as 'commit' | 'domcontentloaded' | 'load' }
        : {}),
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {})
    },
    browserDeps(ctx)
  )
  return browserResult({ op: 'browser_navigate', ...res })
}

const browserCloseHandler: Handler = async (args, ctx) => {
  const res = await closeVerb(paneArgs(args), browserDeps(ctx))
  return browserResult({ op: 'browser_close', ...res })
}

/* ---- T572 (T564 U5): zoom and device emulation, upload from the folder, download into it. ---- */

const browserEmulateHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await emulateVerb(
    {
      ...paneArgs(args),
      ...(typeof args.zoom === 'number' ? { zoom: args.zoom } : {}),
      ...(optStr(args, 'device') !== undefined ? { device: optStr(args, 'device') } : {}),
      ...(typeof args.width === 'number' ? { width: args.width } : {}),
      ...(typeof args.height === 'number' ? { height: args.height } : {}),
      ...(typeof args.dpr === 'number' ? { dpr: args.dpr } : {}),
      ...(typeof args.mobile === 'boolean' ? { mobile: args.mobile } : {}),
      ...(typeof args.touch === 'boolean' ? { touch: args.touch } : {}),
      ...(optStr(args, 'userAgent') !== undefined ? { userAgent: optStr(args, 'userAgent') } : {}),
      ...(args.colorScheme === 'light' || args.colorScheme === 'dark'
        ? { colorScheme: args.colorScheme }
        : {}),
      ...(typeof args.reducedMotion === 'boolean' ? { reducedMotion: args.reducedMotion } : {}),
      ...(typeof args.reset === 'boolean' ? { reset: args.reset } : {})
    },
    makeBrowserDeviceDeps(browserEnv(ctx)),
    args
  )
  return browserResult({ op: 'browser_emulate', ...res })
}

const browserUploadHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await uploadVerb(
    {
      ...paneArgs(args),
      ref: optStr(args, 'ref') ?? '',
      paths: Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : []
    },
    makeBrowserDeviceDeps(browserEnv(ctx)),
    args
  )
  return browserResult({ op: 'browser_upload', ...res })
}

const browserDownloadHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await downloadVerb(
    {
      ...paneArgs(args),
      ...(optStr(args, 'url') !== undefined ? { url: optStr(args, 'url') } : {}),
      ...(optStr(args, 'ref') !== undefined ? { ref: optStr(args, 'ref') } : {}),
      ...(optStr(args, 'name') !== undefined ? { name: optStr(args, 'name') } : {}),
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {})
    },
    makeBrowserDeviceDeps(browserEnv(ctx)),
    args
  )
  return browserResult({ op: 'browser_download', ...res })
}

/**
 * A pane-addressed browser verb is running: its pane is not discarded under it (T574, spec §10.1), and the ACK says
 * `revived: true` when the verb had to bring the pane back.
 */
function paneVerb(handler: Handler): Handler {
  return async (args, ctx) => {
    const paneId = typeof args.paneId === 'string' ? args.paneId : ''
    // A verb on a named tab keeps that tab from being discarded under it, not the pane's active one.
    const end = paneId
      ? beginPaneVerb(
          browserRegistry,
          paneId,
          typeof args.tabId === 'string' ? args.tabId : undefined
        )
      : undefined
    try {
      return await runWithRevival(() => handler(args, ctx))
    } finally {
      end?.()
    }
  }
}

// ---- Guided walks (S-2): the four core verbs ----------------------------------------------------------

/**
 * The real env of a walk verb for `folder`: the one service of its repo, and a probe that answers what a
 * script's source asks of Harnu (the folder's board, the mission record, the known folders). Both reads are
 * made BEFORE validating, so the validator itself stays synchronous.
 */
export function makeWalkEnv(folder: string, knownFolders: readonly string[]): WalkVerbEnv {
  return {
    service: walkServiceFor(folder),
    async probeFor(source) {
      const slugs = await listCardSlugs(folder).catch((): string[] => [])
      let facts: ReturnType<typeof missionFactsOf> | null = null
      const missionId =
        typeof source === 'object' &&
        source !== null &&
        (source as { kind?: unknown }).kind === 'mission' &&
        typeof (source as { missionId?: unknown }).missionId === 'string'
          ? (source as { missionId: string }).missionId
          : null
      if (missionId) {
        const read = await readMissionRecord(repoRoot(folder), missionId).catch(() => null)
        if (read?.ok) facts = missionFactsOf(read.record)
      }
      return createWalkProbe({
        folder,
        knownFolders,
        cardSlugs: () => slugs,
        mission: (id) => (id === missionId ? facts : null)
      })
    }
  }
}

/** The door the app itself uses to open a walk (dev only until the pane exists, S-3). */
export async function openWalkFromApp(
  folder: string,
  script: unknown,
  knownFolders: readonly string[],
  sessionId?: string
): Promise<WalkVerbResult> {
  return walkOpen(
    { script, ...(sessionId ? { sessionId } : {}) },
    makeWalkEnv(folder, knownFolders)
  )
}

function walkResult(res: WalkVerbResult): CallToolResult {
  // a refusal is an error result carrying the whole body (code, message, `rejected`), like the browser verbs
  if (res.ok === false)
    return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: true }
  return textResult(res)
}

const walkEnvOf = (ctx: ToolHandlerCtx): WalkVerbEnv =>
  makeWalkEnv(
    ctx.folder,
    ctx.folders.map((f) => f.path)
  )

const walkOpenHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  return walkResult(await walkOpen(args, walkEnvOf(ctx)))
}
const walkExtendHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  return walkResult(await walkExtend(args, walkEnvOf(ctx)))
}
const walkReportHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  return walkResult(await walkReport(args, walkEnvOf(ctx)))
}
const walkGetHandler: Handler = async (args, ctx) => walkResult(await walkGet(args, walkEnvOf(ctx)))

/** The single dispatch table: every {@link McpOp} maps to exactly one handler. */
/** The pane-addressed reading verbs share one shape: a `paneId` and the verb's own arguments. */
function paneArgs(args: Record<string, unknown>): { paneId: string; tabId?: string } {
  const tabId = optStr(args, 'tabId')
  return { paneId: optStr(args, 'paneId') ?? '', ...(tabId !== undefined ? { tabId } : {}) }
}

const browserSnapshotHandler: Handler = async (args, ctx) => {
  const res = await snapshotVerb(
    {
      ...paneArgs(args),
      ...(optStr(args, 'selector') !== undefined ? { selector: optStr(args, 'selector') } : {}),
      ...(typeof args.interactiveOnly === 'boolean'
        ? { interactiveOnly: args.interactiveOnly }
        : {}),
      ...(typeof args.maxNodes === 'number' ? { maxNodes: args.maxNodes } : {}),
      ...(Array.isArray(args.include) ? { include: args.include as string[] } : {}),
      ...(typeof args.frames === 'boolean' ? { frames: args.frames } : {})
    },
    makeBrowserReadDeps(browserEnv(ctx))
  )
  return browserResult({ op: 'browser_snapshot', ...res })
}

const browserScreenshotHandler: Handler = async (args, ctx) => {
  const res = await screenshotVerb(
    {
      ...paneArgs(args),
      ...(optStr(args, 'ref') !== undefined ? { ref: optStr(args, 'ref') } : {}),
      ...(optStr(args, 'selector') !== undefined ? { selector: optStr(args, 'selector') } : {}),
      ...(typeof args.fullPage === 'boolean' ? { fullPage: args.fullPage } : {}),
      ...(args.format === 'png' || args.format === 'jpeg' ? { format: args.format } : {}),
      ...(typeof args.quality === 'number' ? { quality: args.quality } : {}),
      ...(typeof args.maxDim === 'number' ? { maxDim: args.maxDim } : {}),
      ...(typeof args.save === 'boolean' ? { save: args.save } : {})
    },
    makeBrowserReadDeps(browserEnv(ctx))
  )
  return browserResult({ op: 'browser_screenshot', ...res })
}

const browserConsoleHandler: Handler = async (args, ctx) => {
  const res = await consoleVerb(
    {
      ...paneArgs(args),
      ...(args.mode === 'tail' || args.mode === 'since' ? { mode: args.mode } : {}),
      ...(typeof args.lines === 'number' ? { lines: args.lines } : {}),
      ...(optStr(args, 'since') !== undefined ? { since: optStr(args, 'since') } : {}),
      ...(Array.isArray(args.levels) ? { levels: args.levels as ConsoleLevel[] } : {}),
      ...(typeof args.clear === 'boolean' ? { clear: args.clear } : {})
    },
    makeBrowserReadDeps(browserEnv(ctx))
  )
  return browserResult({ op: 'browser_console', ...res })
}

const browserNetworkHandler: Handler = async (args, ctx) => {
  const res = await networkVerb(
    {
      ...paneArgs(args),
      action: args.action as 'start' | 'read' | 'stop',
      ...(typeof args.maxMinutes === 'number' ? { maxMinutes: args.maxMinutes } : {}),
      ...(typeof args.bodies === 'boolean' ? { bodies: args.bodies } : {}),
      ...(typeof args.headers === 'boolean' ? { headers: args.headers } : {}),
      ...(optStr(args, 'filter') !== undefined ? { filter: optStr(args, 'filter') } : {}),
      ...(optStr(args, 'since') !== undefined ? { since: optStr(args, 'since') } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {})
    },
    makeBrowserReadDeps(browserEnv(ctx))
  )
  return browserResult({ op: 'browser_network', ...res })
}

const browserWaitForHandler: Handler = async (args, ctx) => {
  const res = await waitForVerb(
    {
      ...paneArgs(args),
      ...(optStr(args, 'selector') !== undefined ? { selector: optStr(args, 'selector') } : {}),
      ...(optStr(args, 'text') !== undefined ? { text: optStr(args, 'text') } : {}),
      ...(optStr(args, 'textGone') !== undefined ? { textGone: optStr(args, 'textGone') } : {}),
      ...(optStr(args, 'url') !== undefined ? { url: optStr(args, 'url') } : {}),
      ...(typeof args.networkIdleMs === 'number' ? { networkIdleMs: args.networkIdleMs } : {}),
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {})
    },
    makeBrowserReadDeps(browserEnv(ctx))
  )
  return browserResult({ op: 'browser_wait_for', ...res })
}

/* ---- T571 (T564 U4): the acting verbs. `args` rides along as the write-queue key: the server reserved the
 * pane's place in line with that very object, on entry, before any await (spec §6.4). ---- */

const browserEvalHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await evalVerb(
    {
      ...paneArgs(args),
      expression: optStr(args, 'expression') ?? '',
      ...(typeof args.awaitPromise === 'boolean' ? { awaitPromise: args.awaitPromise } : {}),
      ...(optStr(args, 'frame') !== undefined ? { frame: optStr(args, 'frame') } : {}),
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {})
    },
    makeBrowserActDeps(browserEnv(ctx)),
    args
  )
  return browserResult({ op: 'browser_eval', ...res })
}

const browserClickHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const offset = args.offset as { x?: unknown; y?: unknown } | undefined
  const res = await clickVerb(
    {
      ...paneArgs(args),
      ref: optStr(args, 'ref') ?? '',
      ...(args.button === 'left' || args.button === 'middle' || args.button === 'right'
        ? { button: args.button }
        : {}),
      ...(typeof args.clickCount === 'number' ? { clickCount: args.clickCount } : {}),
      ...(Array.isArray(args.modifiers)
        ? { modifiers: args.modifiers as Array<'Alt' | 'Control' | 'Meta' | 'Shift'> }
        : {}),
      ...(offset && typeof offset.x === 'number' && typeof offset.y === 'number'
        ? { offset: { x: offset.x, y: offset.y } }
        : {})
    },
    makeBrowserActDeps(browserEnv(ctx)),
    args
  )
  return browserResult({ op: 'browser_click', ...res })
}

const browserTypeHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await typeVerb(
    {
      ...paneArgs(args),
      ...(optStr(args, 'ref') !== undefined ? { ref: optStr(args, 'ref') } : {}),
      text: optStr(args, 'text') ?? '',
      ...(typeof args.delayMs === 'number' ? { delayMs: args.delayMs } : {}),
      ...(typeof args.submit === 'boolean' ? { submit: args.submit } : {})
    },
    makeBrowserActDeps(browserEnv(ctx)),
    args
  )
  return browserResult({ op: 'browser_type', ...res })
}

const browserFillHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const fields = Array.isArray(args.fields)
    ? (args.fields as Array<Record<string, unknown>>).map((f) => ({
        ref: typeof f.ref === 'string' ? f.ref : '',
        value: typeof f.value === 'string' ? f.value : ''
      }))
    : []
  const res = await fillVerb(
    { ...paneArgs(args), fields },
    makeBrowserActDeps(browserEnv(ctx)),
    args
  )
  return browserResult({ op: 'browser_fill', ...res })
}

const browserPressHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await pressVerb(
    {
      ...paneArgs(args),
      keys: Array.isArray(args.keys) ? (args.keys as unknown[]).map(String) : [],
      ...(optStr(args, 'ref') !== undefined ? { ref: optStr(args, 'ref') } : {})
    },
    makeBrowserActDeps(browserEnv(ctx)),
    args
  )
  return browserResult({ op: 'browser_press', ...res })
}

const browserSetDataHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await setDataVerb(
    {
      paneId: optStr(args, 'paneId') ?? '',
      data: args.data,
      ...(typeof args.merge === 'boolean' ? { merge: args.merge } : {}),
      ...(typeof args.expectRev === 'number' ? { expectRev: args.expectRev } : {})
    },
    browserDeps(ctx)
  )
  return browserResult({ op: 'browser_set_data', ...res })
}

const browserPatchHandler: Handler = async (args, ctx) => {
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const res = await patchVerb(
    {
      paneId: optStr(args, 'paneId') ?? '',
      ...(optStr(args, 'selector') !== undefined ? { selector: optStr(args, 'selector') } : {}),
      ...(optStr(args, 'mode') !== undefined ? { mode: optStr(args, 'mode') } : {}),
      ...(optStr(args, 'html') !== undefined ? { html: optStr(args, 'html') } : {})
    },
    browserDeps(ctx)
  )
  return browserResult({ op: 'browser_patch', ...res })
}

// ---- Missions v4: the verbs' MCP side (S-24, S-40) ----------------------------------------------------
//
// `missions/verbs.ts` runs the v4 verbs; this block is the MCP side of it: the caller built from the
// transport and the facts gathered on the server.

/** How long a v4 verb waits for GitHub; past it a step reads its last-known state (like the view). */
const V4_PR_WAIT_MS = 1500

type StepInputsFor = (root: string, record: MissionV4) => Promise<Record<string, StepInput>>

let stepInputsOverride: StepInputsFor | null = null
/** Test seam: replaces the server-side gathering of each step's facts (no `gh`, no board). */
export function _setStepInputsForTest(fn: StepInputsFor | null): void {
  stepInputsOverride = fn
}

/**
 * The real sources of {@link FactsDeps} for one repo: the board's files, chapter 2's pull request join
 * (which shares the single-flight cache a `mission:list` poll already warms), its last-known cache, the
 * filesystem and the task-state hub. `waitMs` bounds how long the join waits for GitHub.
 */
export async function realFactsDeps(root: string, waitMs?: number): Promise<FactsDeps> {
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
    findBaseCi: (bases) => findBaseCi(root, bases, { waitMs }),
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

const v4Deps: V4Deps = {
  inputsFor: async (root, record) => {
    if (stepInputsOverride) return stepInputsOverride(root, record)
    try {
      return await gatherStepInputs(root, record, await realFactsDeps(root, V4_PR_WAIT_MS))
    } catch (err) {
      // A source that cannot be read leaves its fact out: absent is not false.
      console.warn('[mission] could not gather step facts:', err)
      return {}
    }
  },
  recall: async (folder, query) => (await recallFor(folder, query)).map((h) => ({ ...h }))
}

/**
 * The caller of a v4 verb, built from the transport and never from the call's arguments. Any other client is a
 * `session`, and this transport has no per-session identity, so the only id it can have is the call's
 * own `sessionId` argument: self-declared, like v3's owner ids (S-25 makes it real for the sessions
 * Harnu spawns). The argument names WHICH session; it never changes WHAT the caller is: `operator`
 * and `harnu` are not reachable here at all (the operator acts through the app's own interface, and
 * Harnu's own writes are made in-process), and a value that is not a session UUID is refused.
 */
function actorOf(
  args: Record<string, unknown>,
  ctx: ToolHandlerCtx,
  opts: { optional?: boolean } = {}
): { ok: true; actor: Actor } | { ok: false; error: string } {
  // Missions v4 S-25: a session Harnu spawned IS the session id in its credential. An argument never
  // names it (so a verifier that built its step stays a builder), and the observe worker of a folder is
  // a Harnu worker bound to that folder: it reads any mission of it and never writes.
  if (ctx.caller?.kind === 'scoped') {
    const scope = ctx.caller.scope
    return scope.role === 'observer'
      ? { ok: true, actor: { kind: 'worker' } }
      : { ok: true, actor: { kind: 'session', sessionId: scope.sessionId } }
  }
  const sessionId = strField(args, 'sessionId')
  if (sessionId === undefined) {
    if (opts.optional) return { ok: true, actor: { kind: 'session', sessionId: '' } }
    return {
      ok: false,
      error:
        'BAD_ARGS: sessionId is required — pass your own Claude session UUID (the transcript id get_fleet reports). A v4 mission answers the sessions attached to it, so it has to know which one is asking. It is self-declared, not authenticated.'
    }
  }
  if (!SESSION_UUID_RE.test(sessionId)) {
    return { ok: false, error: badSessionIdMessage('sessionId', sessionId) }
  }
  return { ok: true, actor: { kind: 'session', sessionId } }
}

/** Run one v4 verb: the folder's gate, the caller from the transport, then S-24's `runV4`. */
async function runV4Call(
  op: V4Op,
  args: Record<string, unknown>,
  ctx: ToolHandlerCtx
): Promise<CallToolResult> {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const refusal = missionFolderRefusal(folder, missionRoot(folder), ctx)
  if (refusal) return errorResult(refusal)
  const who = actorOf(args, ctx, { optional: op === 'mission_list' })
  if (!who.ok) return errorResult(who.error)
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before writing.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
  const out = await runV4(op, folder, who.actor, args, v4Deps)
  return out.ok ? textResult(out) : errorResult(out.error)
}

/** A mission verb: always the v4 verb. A mission still held in a v3 file is read in memory and converted by its first write. */
const missionVerb =
  (op: V4Op): Handler =>
  (args, ctx) =>
    runV4Call(op, args, ctx)

/** The single dispatch table: every {@link McpOp} maps to exactly one handler. */
const TOOL_HANDLERS: Record<McpOp, Handler> = {
  get_fleet: getFleetHandler,
  get_session: getSessionHandler,
  list_worktrees: listWorktreesHandler,
  get_approval: getApprovalHandler,
  create_session: createSessionHandler,
  create_worktree: createWorktreeHandler,
  spawn_terminal: spawnTerminalHandler,
  list_terminals: listTerminalsHandler,
  read_terminal: readTerminalHandler,
  send_terminal: sendTerminalHandler,
  browser_open: browserOpenHandler,
  browser_list: browserListHandler,
  browser_navigate: paneVerb(browserNavigateHandler),
  browser_close: paneVerb(browserCloseHandler),
  browser_snapshot: paneVerb(browserSnapshotHandler),
  browser_screenshot: paneVerb(browserScreenshotHandler),
  browser_console: paneVerb(browserConsoleHandler),
  browser_network: paneVerb(browserNetworkHandler),
  browser_wait_for: paneVerb(browserWaitForHandler),
  browser_eval: paneVerb(browserEvalHandler),
  browser_click: paneVerb(browserClickHandler),
  browser_type: paneVerb(browserTypeHandler),
  browser_fill: paneVerb(browserFillHandler),
  browser_press: paneVerb(browserPressHandler),
  browser_emulate: paneVerb(browserEmulateHandler),
  browser_upload: paneVerb(browserUploadHandler),
  browser_download: paneVerb(browserDownloadHandler),
  browser_set_data: paneVerb(browserSetDataHandler),
  browser_patch: paneVerb(browserPatchHandler),
  walk_open: walkOpenHandler,
  walk_extend: walkExtendHandler,
  walk_report: walkReportHandler,
  walk_get: walkGetHandler,
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
  github_budget: githubBudgetHandler,
  release_worktree: releaseWorktreeHandler,
  archive_session: archiveSessionHandler,
  hide_folder: hideFolderHandler,
  your_move: yourMoveHandler,
  stop_containers: stopContainersHandler,
  start_containers: startContainersHandler,
  remove_containers: removeContainersHandler,
  update_worker: updateWorkerHandler,
  delete_worker: deleteWorkerHandler,
  orchestrator_arm: orchestratorArmHandler,
  orchestrator_disarm: orchestratorDisarmHandler,
  mission_create: missionVerb('mission_create'),
  mission_get: missionVerb('mission_get'),
  mission_list: missionVerb('mission_list'),
  mission_add_step: missionVerb('mission_add_step'),
  mission_update_step: missionUpdateStepUnbuilt,
  mission_log: missionVerb('mission_log'),
  mission_set_blocker: missionVerb('mission_set_blocker'),
  mission_clear_blocker: missionVerb('mission_clear_blocker'),
  mission_request_close: missionVerb('mission_request_close'),
  rebase_stack: rebaseStackHandler,
  mission_add_milestone: missionVerb('mission_add_milestone'),
  mission_add_ac: missionVerb('mission_add_ac'),
  mission_link: missionVerb('mission_link'),
  mission_set_done_when: missionVerb('mission_set_done_when'),
  mission_settle_ac: missionVerb('mission_settle_ac'),
  mission_attach: missionVerb('mission_attach')
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
