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
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import { lastSubagentActivity } from '../subagent-activity'
import { buildStepPulse, withHelperActivity, type MissionStepPulse } from '../mission-pulse'
import { listPendingApprovals } from '../approval-resolver'
import {
  findMainCi,
  findPrsForWorktrees,
  type MissionPrJoin,
  type WorktreePrJoin
} from '../pr-stack'
import {
  addObservedLedger,
  ensureLinkCacheLoaded,
  forgetResolved,
  getLastKnown,
  getObservedLedger,
  rememberResolved
} from '../mission-link-cache'
import { computeStepGates, type GateCi, type GatePrFacts, type StepGates } from '../mission-gates'
import {
  appendLedgerRow,
  hasLedgerRow,
  lastLedgerDetail,
  ledgerTail,
  mergeLedger,
  pickLedgerTargets,
  type LedgerHints,
  type LedgerRowInput
} from '../mission-ledger'
import type { PrEntry } from '../pr-stack-core'
import { getScreenStates, getShellSessions } from '../detect/screen-detect'
import {
  createTerminalPty,
  discardTerminalPty,
  ensureTerminalScreenModel,
  liveSessionKeys,
  sessionOwnedByHarnu,
  spawnOriginForSession,
  waitForSessionReady,
  writeTerminalPty
} from '../pty'
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
  type LedgerRow,
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
  STEP_ID_RE,
  type Blocker,
  type DeclaredEnd,
  type Mission,
  type MissionStep,
  type StepDecision,
  type StepEdge,
  type StepLink
} from '../mission-core'
import { probeGitMeta } from '../git-probe'
import {
  computeProgress,
  progressHeadline,
  progressSteps,
  type MissionProgress
} from '../mission-progress'
import {
  applyAddChapter,
  buildCampaignFileContent,
  buildChapter,
  CAMPAIGN_ID_RE,
  campaignsDir,
  createCampaignFile,
  mintCampaignId,
  missingPrerequisites,
  parseCampaignFile,
  readCampaignLog,
  withCampaignLock,
  type Campaign,
  type Chapter,
  type MissingPrerequisite,
  type NewChapter
} from '../campaign-core'
import {
  campaignCloseRefusal,
  computeCampaignProgress,
  type CampaignProgress,
  type ChapterFacts
} from '../campaign-progress'
import { importLegacyGoalFile } from '../mission-migration'
import { atomicWriteFile } from './atomic-write'
import {
  buildFleetSnapshot,
  buildMissionFleetProjection,
  filterFleetSnapshot,
  terminalsOfSession,
  toTerminalListing,
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
import { readUserProjects, terminalReadOptIns } from '../user-projects'
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
  isWorkerIsSteward,
  isWorkerNotFound,
  listWorkersForAgent,
  updateWorkerForAgent,
  wakeStewardForMission,
  type UpdateWorkerPatch
} from '../scheduler-shell'
import { startStewardForMission } from '../steward-shell'
import { currentBranch, rebaseStack, repoCommonDir, worktreeToplevel } from '../steward-rebase'
import type { WakeReason } from '../steward-core'
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
    // Campaign ch.5a: a steward is a system worker — never agent-controllable, whatever the folder.
    agentControllable:
      w.category === 'steward' ? false : !isFolderDenied(w.folder, ctx.denyFolders),
    ...(w.category === 'steward' ? { category: w.category, missionId: w.missionId } : {}),
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
    if (isWorkerIsSteward(err)) return errorResult((err as Error).message)
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
    if (isWorkerIsSteward(err)) return errorResult((err as Error).message)
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
  // Campaign spec §3.2: the mission IS a chapter of a campaign — both ids, or neither.
  const campaignId = strField(args, 'campaignId')
  const chapterId = strField(args, 'chapterId')
  if ((campaignId === undefined) !== (chapterId === undefined)) {
    return errorResult(
      'BAD_ARGS: campaignId and chapterId go together — name the campaign and the chapter this mission IS, or neither.'
    )
  }

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

  const createMission = (): Promise<MissionWrite> =>
    writeNewMission(
      root,
      title,
      (id, slug, now) => ({
        id,
        slug,
        folder: root,
        owner: { sessionId, folder: path.resolve(folder) },
        ...(linkedCard ? { linkedCard } : {}),
        ...(campaignId && chapterId ? { campaignId, chapterId } : {}),
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
  // A chapter's mission is created and bound under the campaign's lock, so two creates
  // for one chapter can never both land (CHAPTER_ALREADY_BOUND); every campaign refusal
  // happens before the mission is written.
  const created: MissionWrite =
    campaignId && chapterId
      ? await bindMissionToChapter(root, campaignId, chapterId, createMission, ctx)
      : await createMission()
  if (!created.ok) return errorResult(created.error)
  // Campaign ch.5a (spec §3.4): a mission gets a steward unless it opts out. The mission is on disk
  // already, so a steward that cannot start is reported in the ACK, never a failed create.
  const steward =
    args.steward === false
      ? { created: false }
      : await startStewardForMission({
          missionId: created.mission.id,
          ownerFolder: path.resolve(folder),
          title
        })
  return textResult({
    ok: true,
    op: 'mission_create',
    missionId: created.mission.id,
    slug: created.mission.slug,
    steps: created.mission.steps,
    ...(created.mission.scope ? { scope: created.mission.scope } : {}),
    ...(campaignId && chapterId ? { campaignId, chapterId } : {}),
    steward
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
  /** Campaign spec §3.2 — a step is done, its PR merged, and the merge commit's CI on main is red. */
  | { kind: 'main-red'; stepId: string; pr: number }
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
  progress: MissionProgress,
  /** The derived steps, for the gates (campaign spec §3.2); omitted = no gate items. */
  steps: readonly Pick<MissionStepSignals, 'stepId' | 'gates' | 'prNumber'>[] = []
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
  // The headline's own steps: `current` counts positions among them, so a side step
  // (`required: false`, campaign spec §3.2) must not shift the index.
  const counted = m.steps.filter((s) => s.kind !== 'fixed-start' && s.required !== false)
  const humans = counted
    .filter((s, i) => {
      if (s.verification !== 'human') return false
      if (s.proof === 'verified' && s.verifiedBy?.sessionId === OPERATOR_VERIFIER) return false
      // A decision the operator has made is finished — nothing left to confirm.
      if (s.decision?.chosen !== undefined) return false
      const isCurrent = current !== null && i + 1 >= current.from && i + 1 <= current.to
      return reached(s.id) || isCurrent || progress.leftBehind.includes(s.id)
    })
    .map((s) => s.id)
  if (humans.length > 0) items.push({ kind: 'human-steps', stepIds: humans })
  if (m.legacy?.needsReview.includes('declaredEnd')) items.push({ kind: 'review-import' })
  // A red main after a merge downgrades nothing stored — the step stays as it was —
  // but it is the operator's to know about (campaign spec §8 AC-1).
  for (const st of steps) {
    const state = progress.states[st.stepId]
    if (
      st.gates.main === 'red' &&
      st.prNumber !== null &&
      (state === 'done' || state === 'verified')
    ) {
      items.push({ kind: 'main-red', stepId: st.stepId, pr: st.prNumber })
    }
  }
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
    case 'main-red':
      return `main is red after #${item.pr} — ${item.stepId} is merged but its merge commit fails CI.`
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
 * own timestamps, every `mission_log` entry, every linked session's last
 * `taskState` transition and its subagents' last hook, and (T547) the newest
 * commit on each linked worktree. The verdict lives only in `mission_get`'s `derived`
 * block — `stale` is never written to the stored status (§3), so the rule
 * always reads the operator-approved `active`, and `draft`/`delivered`/`closed`
 * never go stale. Pure; `now` is injected.
 */
export function evaluateMissionStall(
  mission: Mission,
  log: string,
  children: readonly Pick<
    MissionChildState,
    'sessionId' | 'taskState' | 'lastTransitionAt' | 'helperActivityAt'
  >[],
  now: number,
  /** T547: extra evidence timestamps (ISO) — the commits landed on linked worktrees. */
  extraEvidence: readonly string[] = []
): MissionStall {
  const stamps = [
    mission.updatedAt,
    ...mission.blockers.map((b) => b.raisedAt),
    ...mission.steps.flatMap((s) => [
      ...(s.verifiedBy ? [s.verifiedBy.at] : []),
      ...s.blockers.map((b) => b.raisedAt)
    ]),
    ...missionLogTimestamps(log),
    ...children.flatMap(
      (c) => [c.lastTransitionAt, c.helperActivityAt].filter((t) => !!t) as string[]
    ),
    ...extraEvidence
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
  /** When GitHub says the PR was opened / merged (ISO); present only when it said. */
  createdAt?: string
  mergedAt?: string
}

function prSummary(p: PrEntry): MissionPrSummary {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    ci: p.ci,
    url: p.url,
    baseRefName: p.base,
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    ...(p.mergedAt ? { mergedAt: p.mergedAt } : {})
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
      /** T547: commits beyond the open PR's base, else the repo's default branch; absent when git could not count. */
      commits?: number
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
      /** Campaign spec §3.2 — CI of the PR head (live, or the last known when `stale`). */
      ci?: GateCi
      /** When GitHub says the PR was opened / merged (ISO); present only when it said. */
      createdAt?: string
      mergedAt?: string
      /**
       * Mission v3 §3.7 — GitHub could not say (unreachable, or the PR is not
       * among the recent ones): the last-known state is shown, or, if the link
       * never resolved, it reads unknown (`exists: false`). Never a downgrade.
       */
      stale?: true
    }

/**
 * Commits a worktree link reports. Once the branch's PR merged (and no PR on it is
 * still open) nothing is left to land, whatever the merge style: a squash leaves the
 * branch's commits "ahead" of the default branch forever, so git's count would read
 * the finished unit as 10 commits of unmerged work. An open PR, or no PR, keeps the
 * git count (`undefined` = git could not count).
 */
function commitsOf(w: WorktreePrJoin | undefined): number | undefined {
  if (!w) return undefined
  const prs = w.prs ?? []
  if (prs.some((p) => p.state === 'MERGED') && !prs.some((p) => p.state === 'OPEN')) return 0
  return w.commits
}

/** A CI word from `pr-stack-core` (or the cache) as the gates' four states. */
function gateCiOf(ci: string | undefined): GateCi {
  return ci === 'passing' || ci === 'failing' || ci === 'pending' ? ci : 'unknown'
}

/**
 * The PR a step's gates read, from its resolved links: a `pr` link first, else a PR
 * joined through a linked worktree or card. An open or merged PR beats a closed one;
 * among equals the newest number wins. `stale` = the values are last-known.
 */
function stepPrFacts(
  links: readonly MissionLinkSignal[]
): { facts: GatePrFacts; stale: boolean } | null {
  const found: Array<{ facts: GatePrFacts; stale: boolean; direct: boolean }> = []
  for (const l of links) {
    if (l.kind === 'pr') {
      if (l.number !== null && l.state !== undefined) {
        found.push({
          facts: {
            number: l.number,
            state: l.state,
            ci: l.ci ?? 'unknown',
            ...(l.createdAt ? { createdAt: l.createdAt } : {}),
            ...(l.mergedAt ? { mergedAt: l.mergedAt } : {})
          },
          stale: l.stale === true,
          direct: true
        })
      }
    } else if (l.kind === 'worktree' || l.kind === 'card') {
      for (const p of l.prs) {
        if (p.state === 'OPEN' || p.state === 'MERGED' || p.state === 'CLOSED') {
          found.push({
            facts: {
              number: p.number,
              state: p.state,
              ci: gateCiOf(p.ci),
              ...(p.createdAt ? { createdAt: p.createdAt } : {}),
              ...(p.mergedAt ? { mergedAt: p.mergedAt } : {})
            },
            stale: false,
            direct: false
          })
        }
      }
    }
  }
  const rank = (f: { facts: GatePrFacts; direct: boolean }): number =>
    (f.facts.state === 'CLOSED' ? 0 : 2) + (f.direct ? 1 : 0)
  found.sort((a, b) => rank(b) - rank(a) || b.facts.number - a.facts.number)
  return found.length > 0 ? { facts: found[0].facts, stale: found[0].stale } : null
}

export interface MissionStepSignals {
  stepId: string
  /** Live state of this step's `session` links, from the scoped fleet projection. */
  children: MissionChildState[]
  /** This step's `worktree`/`card`/`pr` links, resolved. */
  links: MissionLinkSignal[]
  /** Computed proof for an `existence`-level step; `null` for any other level. */
  existence: { proven: boolean; reason?: string } | null
  /** T547 — signs of movement inside the step: commits landed and the newest activity. */
  pulse: MissionStepPulse
  /**
   * Campaign spec §3.2 — the facts that prove the step: PR, CI, main CI, verifier,
   * checks. Computed on every read, never stored; `stale: true` = last-known values.
   */
  gates: StepGates
  /** The PR the gates read, or `null` when the step has none. */
  prNumber: number | null
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
  const projected = buildMissionFleetProjection(
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
  // T547: an idle main thread whose own subagents are still calling tools is working.
  const now = Date.now()
  return projected.map((c) => withHelperActivity(c, lastSubagentActivity(c.sessionId), now))
}

/** How long `mission_get` waits for a merged PR's merge-commit CI before reading last-known. */
const MAIN_CI_GET_WAIT_MS = 3000
/** A merge commit that has been green this long is not asked about again. */
const MAIN_CI_FINAL_AFTER_MS = 30 * 60 * 1000

/**
 * CI of each merged PR's merge commit on the default branch (campaign spec §3.2
 * `main` gate), sticky: a result that has stayed green for {@link MAIN_CI_FINAL_AFTER_MS}
 * is final and not asked again, everything else is re-checked (`findMainCi` caches for
 * 60 s), and an unreachable GitHub — or a lookup still running past `waitMs` — reads
 * the last-known value (`stale: true`) or nothing. The lookup itself keeps running and
 * lands in the cache, so the next read has it. `pending` is live-only — never remembered.
 */
async function resolveMainCi(
  root: string,
  numbers: readonly number[],
  ghAvailable: boolean | null,
  waitMs: number
): Promise<Map<number, { ci: GateCi | null; stale: boolean }>> {
  const out = new Map<number, { ci: GateCi | null; stale: boolean }>()
  const ask: number[] = []
  for (const n of numbers) {
    const known = getLastKnown(root, 'pr-main', String(n))
    if (known?.state === 'passing' && Date.now() - Date.parse(known.at) > MAIN_CI_FINAL_AFTER_MS) {
      out.set(n, { ci: 'passing', stale: false })
    } else {
      ask.push(n)
    }
  }
  const live =
    ask.length > 0 && ghAvailable !== false
      ? await findMainCi(root, ask, { waitMs })
      : { ghAvailable: false as boolean | null, byNumber: {} as Record<number, GateCi | null> }
  for (const n of ask) {
    const seen = live.ghAvailable ? live.byNumber[n] : undefined
    if (seen !== undefined && seen !== null) {
      if (seen === 'passing' || seen === 'failing') {
        rememberResolved(root, 'pr-main', String(n), { state: seen, prNumber: n })
      }
      out.set(n, { ci: seen, stale: false })
      continue
    }
    const known = getLastKnown(root, 'pr-main', String(n))
    if (live.ghAvailable === false && known) {
      out.set(n, { ci: gateCiOf(known.state), stale: true })
    } else {
      out.set(n, { ci: null, stale: false })
    }
  }
  return out
}

/** `taskState`s of a session whose process has ended — the ledger's `session-died`. */
const SESSION_DEATH_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped'])
/** `taskState`s that prove a session is alive right now. */
const SESSION_ALIVE_STATES: ReadonlySet<string> = new Set(['working', 'needs-input', 'idle'])
/**
 * Linked sessions seen alive by a read in this process. A session whose PTY is gone has
 * no disclosed `taskState` at all (the hook state is hidden without a live PTY), so its
 * death is "alive before, no state now" — which needs the "before". The ledger's own
 * `dispatched` row is the same evidence across a restart.
 */
const seenAlive = new Set<string>()
const SEEN_ALIVE_MAX = 2000

/**
 * Campaign spec §3.2 — record what this read OBSERVED: a PR opened or merged, a CI
 * change, a linked builder ending. Only a new fact appends a row (deduped against the
 * ledger so far, file rows and observed rows together), so N reads of an unchanged
 * world record nothing. The rows go to the link-cache sidecar, never to the mission
 * file: a read does not rewrite it (Mission v3 §3.7). Synchronous on purpose — the
 * check and the insert share one tick, so two concurrent reads cannot both add a row.
 */
function observeLedger(
  mission: Mission,
  steps: readonly MissionStepSignals[],
  prByStep: ReadonlyArray<{ facts: GatePrFacts } | null>,
  now: number
): void {
  if (mission.status === 'closed') return
  const at = new Date(now).toISOString()
  const seen = { ledger: mergeLedger(mission.ledger, getObservedLedger(mission.id)) }
  const added: LedgerRow[] = []
  /**
   * `eventAt`: omitted = the event has no single time of its own (CI, a session end),
   * the observation time stands. A PR event passes GitHub's time (ISO) or `null` when
   * GitHub gave none, and then the row falls back to the observation, saying so.
   */
  const push = (row: LedgerRowInput, eventAt?: string | null): void => {
    const t = eventAt ? Date.parse(eventAt) : NaN
    const full: LedgerRow = Number.isFinite(t)
      ? { at: new Date(t).toISOString(), ...row }
      : eventAt === undefined
        ? { at, ...row }
        : { at, ...row, detail: 'observed' }
    added.push(full)
    seen.ledger.push(full)
  }
  steps.forEach((st, i) => {
    const stepId = st.stepId
    const facts = prByStep[i]?.facts
    if (facts) {
      const ref = `#${facts.number}`
      if (facts.state === 'OPEN' && !hasLedgerRow(seen, 'pr-opened', ref)) {
        push({ kind: 'pr-opened', stepId, ref, pr: facts.number }, facts.createdAt ?? null)
      }
      if (facts.state === 'MERGED' && !hasLedgerRow(seen, 'pr-merged', ref)) {
        push({ kind: 'pr-merged', stepId, ref, pr: facts.number }, facts.mergedAt ?? null)
      }
      if (
        facts.ci !== 'unknown' &&
        lastLedgerDetail(seen, 'ci', ref) !== facts.ci &&
        facts.state !== 'CLOSED'
      ) {
        push({ kind: 'ci', stepId, ref, pr: facts.number, detail: facts.ci })
      }
    }
    for (const c of st.children) {
      if (c.sessionId === mission.owner.sessionId || !c.known) continue
      if (c.taskState !== undefined && SESSION_ALIVE_STATES.has(c.taskState)) {
        seenAlive.add(c.sessionId)
        if (seenAlive.size > SEEN_ALIVE_MAX) {
          const oldest = seenAlive.values().next().value
          if (oldest !== undefined) seenAlive.delete(oldest)
        }
        continue
      }
      if (hasLedgerRow(seen, 'session-died', c.sessionId)) continue
      // Parked and still-spawning sessions are not dead; a session with no state and
      // no process is, once it is known to have lived.
      const exited = c.taskState === undefined && !c.hibernated && !c.inflight
      const ended = c.taskState !== undefined && SESSION_DEATH_STATES.has(c.taskState)
      const wasAlive = seenAlive.has(c.sessionId) || hasLedgerRow(seen, 'dispatched', c.sessionId)
      if (!ended && !(exited && wasAlive)) continue
      push({
        kind: 'session-died',
        stepId,
        ref: c.sessionId,
        sessionId: c.sessionId,
        detail: c.taskState ?? 'exited'
      })
    }
  })
  addObservedLedger(mission.id, added)
  // Campaign ch.5a: what this read OBSERVED is an event too — a CI change, a PR opening or merging,
  // a builder ending. One wake per read, named for the most specific thing seen.
  if (added.length > 0) {
    void wakeSteward(
      mission.id,
      added.some((r) => r.kind === 'ci')
        ? 'ci'
        : added.some((r) => r.kind === 'session-died')
          ? 'child-idle'
          : 'ledger'
    )
  }
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
  opts: { prWaitMs?: number; mainCiWaitMs?: number } = {}
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
        ...(commitsOf(w) !== undefined ? { commits: commitsOf(w) } : {}),
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
            baseRefName: pr.base,
            ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {})
          })
          if (pr.ci === 'passing' || pr.ci === 'failing') {
            rememberResolved(root, 'pr-ci', String(number), { state: pr.ci, prNumber: number })
          }
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
          baseRefName: pr.base,
          ci: gateCiOf(pr.ci),
          ...(pr.createdAt ? { createdAt: pr.createdAt } : {}),
          ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {})
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
        ...(known.mergedAt ? { mergedAt: known.mergedAt } : {}),
        ci: gateCiOf(getLastKnown(root, 'pr-ci', String(number))?.state),
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
  const stepRows = mission.steps.map((s): Omit<MissionStepSignals, 'gates' | 'prNumber'> => {
    const resolved = s.links.map(resolve).filter((l): l is MissionLinkSignal => l !== null)
    const unfit = s === fixedStart ? unfitOf(resolved) : undefined
    const stepChildren = s.links
      .filter((l) => l.kind === 'session')
      .flatMap((l) => {
        const c = childById.get(l.ref)
        return c ? [c] : []
      })
    return {
      stepId: s.id,
      children: stepChildren,
      links: resolved,
      pulse: buildStepPulse(resolved, stepChildren),
      existence:
        s.verification !== 'existence'
          ? null
          : unfit
            ? { proven: false, reason: unfitReason(unfit) }
            : existenceOf(resolved, join.ghAvailable)
    }
  })
  // Campaign spec §3.2 — the gates: the PR, its CI and the CI of its merge commit on
  // the default branch, read once per merged PR and kept sticky like every other fact.
  const prByStep = stepRows.map((st) => stepPrFacts(st.links))
  const mergedNumbers = [
    ...new Set(prByStep.flatMap((f) => (f?.facts.state === 'MERGED' ? [f.facts.number] : [])))
  ]
  const mainCi = await resolveMainCi(root, mergedNumbers, join.ghAvailable, opts.mainCiWaitMs ?? 0)
  const steps = stepRows.map((st, i): MissionStepSignals => {
    const found = prByStep[i]
    const merged = found?.facts.state === 'MERGED'
    const main = merged ? mainCi.get(found.facts.number) : undefined
    const step = mission.steps[i]
    return {
      ...st,
      prNumber: found?.facts.number ?? null,
      gates: computeStepGates({
        step,
        pr: found?.facts ?? null,
        mainCi: main?.ci ?? null,
        stale: found?.stale === true || main?.stale === true
      })
    }
  })
  // T547: a commit landing on a linked worktree is evidence the work moves, even
  // while the child session itself reads idle.
  const commitEvidence = steps.flatMap((st) =>
    st.pulse.lastCommitAt ? [st.pulse.lastCommitAt] : []
  )
  const stall = evaluateMissionStall(mission, log, children, now, commitEvidence)
  const progress: MissionProgress = computeProgress(
    mission,
    steps.map((s) => ({
      stepId: s.stepId,
      children: s.children.map((c) => ({ sessionId: c.sessionId, taskState: c.taskState })),
      existenceProven: s.existence?.proven === true,
      // Amendment (a): the gates govern `verified`, so progress reads the SAME gates the rows carry.
      gates: s.gates
    })),
    now
  )
  rememberProgress(mission.id, progress)
  observeLedger(mission, steps, prByStep, now)
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

/**
 * Campaign spec §3.2 — append one ledger row to each target mission, under its lock.
 * The ledger is Harnu's own record, so this is called by the handlers that DO the
 * thing (never from a verb argument), and it never fails the action it describes:
 * a mission that cannot be read or written is skipped with a warning. The append also
 * stamps `updatedAt` — a dispatch is real evidence the mission is moving (the stall
 * rule's input). A closed mission is a record and never receives a row.
 */
async function appendLedgerTo(
  root: string,
  targets: readonly { missionId: string; stepId?: string }[],
  row: LedgerRowInput
): Promise<void> {
  for (const t of targets) {
    try {
      await withMissionIdMintLock(t.missionId, async () => {
        const loaded = await loadMission(root, t.missionId)
        if (!loaded.ok || loaded.mission.status === 'closed') return
        const at = new Date().toISOString()
        const next: Mission = {
          ...appendLedgerRow(
            loaded.mission,
            { ...row, ...(t.stepId ? { stepId: t.stepId } : {}) },
            at
          ),
          updatedAt: at
        }
        await atomicWriteFile(loaded.file, buildMissionFileContent(next, loaded.log), 0o644)
      })
      // Campaign ch.5a: a ledger row is an event the mission's steward wakes on.
      await wakeSteward(t.missionId, row.kind === 'ci' ? 'ci' : 'ledger')
    } catch (err) {
      console.warn(`[mission-ledger] could not record ${row.kind} on ${t.missionId}:`, err)
    }
  }
}

/** Wake a mission's steward; fire-and-forget, and never a reason for the caller to fail. */
function wakeSteward(missionId: string, reason: WakeReason): Promise<unknown> {
  return wakeStewardForMission(missionId, reason).catch((err) => {
    console.warn(`[steward] could not wake the steward of ${missionId}:`, err)
  })
}

/** The open missions of `folder`'s repo, without creating a data dir where there is none. */
async function openMissionsOf(root: string): Promise<Mission[]> {
  if (!(await pathExists(missionsDir(root)))) return []
  return (await readAllMissions(root)).missions
    .map((m) => m.mission)
    .filter((m) => m.status !== 'closed')
}

/**
 * Campaign spec §3.2 — record a write-time event (dispatch, worktree cut, manifest
 * drain) on the mission it belongs to: the one whose step links the worktree or card,
 * else the repo's only open mission. Best-effort; never throws.
 */
export async function recordLedgerEvent(
  folder: string,
  hints: LedgerHints,
  row: LedgerRowInput
): Promise<void> {
  try {
    const root = missionRoot(folder)
    const missions = await openMissionsOf(root)
    await appendLedgerTo(root, pickLedgerTargets(missions, hints), row)
  } catch (err) {
    console.warn(`[mission-ledger] could not record ${row.kind}:`, err)
  }
}

/**
 * Campaign spec §3.2 — a session's context was compacted: note it on the open
 * mission(s) that session OWNS. Called by the compaction hook (chapter 5 installs it).
 */
export async function recordMissionCompaction(folder: string, sessionId: string): Promise<void> {
  try {
    const root = missionRoot(folder)
    const owned = (await openMissionsOf(root))
      .filter((m) => m.owner.sessionId === sessionId)
      .map((m) => ({ missionId: m.id }))
    await appendLedgerTo(root, owned, { kind: 'compaction', ref: sessionId, sessionId })
  } catch (err) {
    console.warn('[mission-ledger] could not record compaction:', err)
  }
}

/** One readable mission copy with the repo root it was read from. */
export interface RootedMission {
  root: string
  mission: Mission
  log: string
  file: string
}

/** `(id, root)` pairs already warned about, so a 20 s poll logs each shadowed copy once. */
const warnedShadowed = new Set<string>()

/**
 * Every readable mission across `roots`, at most ONE per `mission.id` (BUG-173 S1).
 * Two clones of one repo can hold the same mission files; both the renderer's
 * `mission:list` and the agent's `mission_list` read through here so neither lists
 * a mission twice.
 *
 * - Roots are canonicalised with `realpath` (the resolved string when that fails),
 *   so one directory reached through two spellings is read once. The root reported
 *   back is the first spelling given.
 * - The winner of an id is the copy with the newest `updatedAt`; a tie goes to the
 *   root that sorts first by path, so the answer never depends on poll order.
 * - The status rule runs on the WINNER: with `includeClosed: false` a closed winner
 *   drops the id even when an older twin elsewhere still says `active`.
 * - Losing copies in another root come back as `shadowed` (one `console.warn` per
 *   process per pair). Nothing is deleted or rewritten.
 */
export async function readMissionsDeduped(
  roots: readonly string[],
  { includeClosed }: { includeClosed: boolean }
): Promise<{
  missions: RootedMission[]
  unreadable: Array<{ root: string; name: string }>
  shadowed: Array<{ missionId: string; root: string }>
}> {
  const canonOf = new Map<string, string>() // canonical path → first spelling given
  for (const root of roots) {
    const canon = await fs.realpath(root).catch(() => path.resolve(root))
    if (!canonOf.has(canon)) canonOf.set(canon, root)
  }
  const reads = await Promise.all(
    [...canonOf].map(async ([canon, root]) => ({ canon, root, read: await readAllMissions(root) }))
  )
  const unreadable = reads.flatMap(({ root, read }) =>
    read.unreadable.map((name) => ({ root, name }))
  )

  const all = reads.flatMap(({ canon, root, read }) =>
    read.missions.map((m) => ({ canon, copy: { root, ...m } }))
  )
  const winners = new Map<string, (typeof all)[number]>()
  for (const entry of all) {
    const best = winners.get(entry.copy.mission.id)
    if (!best) {
      winners.set(entry.copy.mission.id, entry)
      continue
    }
    const a = entry.copy.mission.updatedAt
    const b = best.copy.mission.updatedAt
    if (a > b || (a === b && entry.canon < best.canon)) winners.set(entry.copy.mission.id, entry)
  }

  const shadowed: Array<{ missionId: string; root: string }> = []
  const missions: RootedMission[] = []
  for (const entry of all) {
    const winner = winners.get(entry.copy.mission.id)!
    if (winner === entry) {
      if (includeClosed || entry.copy.mission.status !== 'closed') missions.push(entry.copy)
      continue
    }
    // A repeated id inside ONE root is the same mission twice, not a second clone.
    if (winner.canon === entry.canon) continue
    const { id } = entry.copy.mission
    shadowed.push({ missionId: id, root: entry.copy.root })
    const key = `${id}\u0000${entry.canon}`
    if (!warnedShadowed.has(key)) {
      warnedShadowed.add(key)
      console.warn(
        `[missions] ${id} in ${entry.copy.root} is shadowed by a newer copy in ${winner.copy.root}`
      )
    }
  }
  return { missions, unreadable, shadowed }
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
  // An agent reading one mission waits a moment for the merge-commit CI of a merged PR;
  // the 20 s polls do not (the lookup runs on and lands in the cache for the next read).
  const { derived, children } = await deriveMissionSignals(root, mission, log, ctx, Date.now(), {
    mainCiWaitMs: MAIN_CI_GET_WAIT_MS
  })
  const items = youItems(mission, children, derived.progress, derived.steps)
  // design §9: an imported mission's legacyRaw (up to the whole legacy file) is
  // left out of the projection — every tick reads this — and pointed at instead. The
  // ledger is left out too: the tail below is the read (campaign spec §3.2).
  const { legacyRaw, ledger: _ledger, ...projected } = mission
  void _ledger
  const ledger = mergeLedger(mission.ledger, getObservedLedger(mission.id))
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
    // Campaign spec §3.2: what Harnu did and saw, last 20 rows (oldest first) + the total.
    ledger: ledgerTail({ ledger }),
    ledgerCount: ledger.length,
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
  const read = await readMissionsDeduped(roots, { includeClosed: true })
  const unreadable = read.unreadable.map((u) => path.join(missionsDir(u.root), u.name))
  const missions: Record<string, unknown>[] = read.missions.map(({ mission: m, log }) => ({
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
    // Campaign spec §3.2: how many rows the ledger holds; mission_get returns the tail.
    ledgerCount: mergeLedger(m.ledger, getObservedLedger(m.id)).length,
    updatedAt: m.updatedAt
  }))
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
const MISSION_STEP_EDITABLE_FIELDS = [
  'title',
  'proof',
  'required',
  'discoveredFrom',
  'edges',
  'decision'
] as const

function missionClosedMessage(id: string): string {
  return `MISSION_CLOSED: mission ${id} was closed by the operator — a closed mission is immutable by verb.`
}

function stepNotFoundMessage(id: string, stepId: string): string {
  return `STEP_NOT_FOUND: mission ${id} has no step ${stepId} — mission_get lists its steps.`
}

/** Campaign spec §3.2 — the optional relation fields a step can be declared with. */
interface StepRelations {
  required?: boolean
  discoveredFrom?: string
  edges?: StepEdge[]
  decision?: StepDecision
}

const STEP_EDGE_KINDS: readonly string[] = ['blocks', 'validates', 'related']
const isStepId = (v: unknown): v is string => typeof v === 'string' && STEP_ID_RE.test(v)

/**
 * Parse `required` / `discoveredFrom` / `edges` / `decision` from a verb's args (add)
 * or `set` (update). Shape only — whether the referenced steps exist is checked
 * against the mission in {@link checkStepRelations}. A `decision` that already carries
 * `chosen` is CONTROLLED_FIELD: only the operator's Choose door writes it.
 */
function parseStepRelations(
  src: Record<string, unknown>
): { ok: true; relations: StepRelations } | { ok: false; error: string } {
  const bad = (what: string): { ok: false; error: string } => ({
    ok: false,
    error: `BAD_ARGS: ${what}`
  })
  const relations: StepRelations = {}
  if (src.required !== undefined) {
    if (typeof src.required !== 'boolean') return bad('required must be a boolean')
    relations.required = src.required
  }
  if (src.discoveredFrom !== undefined) {
    if (!isStepId(src.discoveredFrom)) return bad('discoveredFrom must be a step id (stp-<n>)')
    relations.discoveredFrom = src.discoveredFrom
  }
  if (src.edges !== undefined) {
    if (!Array.isArray(src.edges) || src.edges.length > 20) {
      return bad('edges must be an array of at most 20 { kind: blocks | validates | related, to }')
    }
    const edges: StepEdge[] = []
    for (const e of src.edges as unknown[]) {
      const o = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>
      if (typeof o.kind !== 'string' || !STEP_EDGE_KINDS.includes(o.kind) || !isStepId(o.to)) {
        return bad('each edge needs kind (blocks | validates | related) and to (a step id)')
      }
      edges.push({ kind: o.kind as StepEdge['kind'], to: o.to })
    }
    relations.edges = edges
  }
  if (src.decision !== undefined) {
    const d = (
      typeof src.decision === 'object' && src.decision !== null ? src.decision : null
    ) as Record<string, unknown> | null
    if (!d) return bad('decision must be { title, options, blocks }')
    if ('chosen' in d) {
      return {
        ok: false,
        error:
          "CONTROLLED_FIELD: chosen is the operator's — a decision is declared without it, and only the Choose door in the UI records which option was picked."
      }
    }
    const title = typeof d.title === 'string' ? d.title.replace(/\s+/g, ' ').trim() : ''
    const options = d.options
    const blocks = d.blocks ?? []
    if (!title || title.length > 200) return bad('decision.title must be 1..200 chars')
    if (
      !Array.isArray(options) ||
      options.length < 2 ||
      options.length > 10 ||
      !options.every((o) => typeof o === 'string' && o.trim().length > 0 && o.length <= 200)
    ) {
      return bad('decision.options must be 2..10 non-empty strings (≤ 200 chars)')
    }
    if (!Array.isArray(blocks) || blocks.length > 20 || !blocks.every(isStepId)) {
      return bad('decision.blocks must be an array of at most 20 step ids')
    }
    relations.decision = {
      title,
      options: (options as string[]).map((o) => o.trim()),
      blocks: blocks as string[]
    }
  }
  return { ok: true, relations }
}

/** What a step stores of its relations: a default (`required: true`) or an empty list is not written. */
function storedRelations(r: StepRelations): StepRelations {
  return {
    ...(r.required === false ? { required: false } : {}),
    ...(r.discoveredFrom ? { discoveredFrom: r.discoveredFrom } : {}),
    ...(r.edges && r.edges.length > 0 ? { edges: r.edges } : {}),
    ...(r.decision ? { decision: r.decision } : {})
  }
}

/** Every step a relation names must exist in the mission, and none may name `selfId`. */
function checkStepRelations(m: Mission, r: StepRelations, selfId?: string): string | null {
  const named = [
    ...(r.discoveredFrom ? [r.discoveredFrom] : []),
    ...(r.edges ?? []).map((e) => e.to),
    ...(r.decision?.blocks ?? [])
  ]
  for (const id of named) {
    if (id === selfId) {
      return `BAD_ARGS: ${id} cannot name itself — a step is not its own origin, edge target or lock.`
    }
    if (!m.steps.some((s) => s.id === id)) return stepNotFoundMessage(m.id, id)
  }
  return null
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
  const relations = parseStepRelations(args)
  if (!relations.ok) return errorResult(relations.error)
  return editMission(args, ctx, (m) => {
    const dangling = checkStepRelations(m, relations.relations)
    if (dangling) return { ok: false, error: dangling }
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
      addedAt: new Date().toISOString(),
      ...storedRelations(relations.relations)
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
      `CONTROLLED_FIELD: mission_update_step cannot write ${controlled.join(', ')} — proof reaches verified/self-verified only through verification (and a human step only through the operator), and verifiedBy is recorded by that same path. The one proof value this verb sets is 'claimed'. A decision's chosen option is the operator's (the Choose door), never a verb's.`
    )
  }
  const unknown = keys.filter(
    (k) => !(MISSION_STEP_EDITABLE_FIELDS as readonly string[]).includes(k)
  )
  if (unknown.length > 0) {
    return errorResult(
      `BAD_ARGS: unknown set field(s) ${unknown.join(', ')} — editable fields are title | proof ('claimed') | required | discoveredFrom | edges | decision.`
    )
  }
  let title: string | undefined
  if ('title' in set) {
    title = typeof set.title === 'string' ? set.title.replace(/\s+/g, ' ').trim() : ''
    if (!title || title.length > 200) return errorResult('BAD_ARGS: title must be 1..200 chars')
  }
  const relations = parseStepRelations(set)
  if (!relations.ok) return errorResult(relations.error)
  const rel = relations.relations
  return editMission(args, ctx, (m) => {
    const step = m.steps.find((s) => s.id === stepId)
    if (!step) return { ok: false, error: stepNotFoundMessage(m.id, stepId) }
    const dangling = checkStepRelations(m, rel, stepId)
    if (dangling) return { ok: false, error: dangling }
    if (rel.required === false && step.kind !== 'custom') {
      return {
        ok: false,
        error: `FIXED_STEP: ${stepId} is the mission's fixed ${step.kind === 'fixed-start' ? 'start' : 'end'} — it is part of the frame and cannot be a side step.`
      }
    }
    if (rel.decision && step.decision?.chosen !== undefined) {
      return {
        ok: false,
        error: `DECISION_CHOSEN: ${stepId} was already decided by the operator — its decision can no longer be rewritten.`
      }
    }
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
    if (rel.required !== undefined) {
      // The default is not stored: `required: true` clears the key.
      if (rel.required) delete step.required
      else step.required = false
      changed.push('required')
    }
    if (rel.discoveredFrom !== undefined) {
      step.discoveredFrom = rel.discoveredFrom
      changed.push('discoveredFrom')
    }
    if (rel.edges !== undefined) {
      if (rel.edges.length > 0) step.edges = rel.edges
      else delete step.edges
      changed.push('edges')
    }
    if (rel.decision !== undefined) {
      step.decision = rel.decision
      changed.push('decision')
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
  const cleared = await editMission(args, ctx, (m) => {
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
  // Campaign ch.5a: a cleared blocker is a steward wake-up, once the write has landed.
  const missionId = strField(args, 'missionId')
  if (!cleared.isError && missionId) await wakeSteward(missionId, 'blocker-cleared')
  return cleared
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
    // Campaign spec §3.2: the verdict is a ledger event, written here — not by an argument.
    const withVerdict = (mm: Mission): Mission =>
      appendLedgerRow(
        mm,
        { kind: 'verified', stepId, ref: callerId, sessionId: callerId, detail: verdict },
        at
      )
    if (verdict === 'needs-human') {
      try {
        m = applyAddCheck(m, stepId, checkLabel, 'verifier', at)
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
    return {
      ok: true,
      mission: withVerdict(m),
      ack: { ok: true, op: 'mission_verify_step', stepId, proof: step.proof, verdict },
      logAppend: `\n### ${at} · ${stepId} · ${step.proof} (${verdict}) by ${callerId}\n\n${evidence}\n`
    }
  })
}

// ---- Campaign ch.5a: rebase_stack ---------------------------------------------

/** A step that is still open (its proof is not final). */
const stepIsOpen = (s: MissionStep): boolean =>
  s.kind === 'custom' && s.proof !== 'verified' && s.proof !== 'self-verified'

/** The linked worktrees (not the main checkout) a step's `worktree` links resolve to. */
async function stepWorktrees(root: string, step: MissionStep): Promise<string[]> {
  const found = new Set<string>()
  for (const l of step.links) {
    if (l.kind !== 'worktree') continue
    const p = linkPath(root, l.ref)
    const st = await fs.stat(p).catch(() => null)
    if (!st) continue
    const top = await worktreeToplevel(st.isDirectory() ? p : path.dirname(p))
    if (top) found.add(top)
  }
  return [...found]
}

/**
 * Why `worktree` is NOT `step`'s own (a reason), or `null` when it is. A worktree being linked on the
 * step proves little — a step may link a sibling it only reads — so ownership needs evidence:
 *
 *  1. if a card the step links was dispatched (`executedIn` is the owner branch Harnu stamped), the
 *     worktree's branch must be exactly that branch;
 *  2. otherwise (nothing names the branch) the worktree must be claimed by THIS step alone — not
 *     linked by any other step of this or another open mission — and must not be a trunk branch.
 */
async function foreignWorktreeReason(
  root: string,
  mission: Mission,
  step: MissionStep,
  worktree: string
): Promise<string | null> {
  const branch = await currentBranch(worktree)
  if (branch === 'main' || branch === 'master') return `it is on ${branch}`
  const owned = new Set<string>()
  for (const l of step.links) {
    if (l.kind !== 'card') continue
    const read = await readCard(root, l.ref).catch(() => null)
    if (read?.ok && read.card.executedIn) owned.add(read.card.executedIn)
  }
  if (owned.size > 0) {
    return branch && owned.has(branch)
      ? null
      : `its branch ${branch ?? '(detached)'} is not the branch ${[...owned].join(', ')} the step's card was dispatched to`
  }
  const others = (await readAllMissions(root)).missions
    .map((m) => m.mission)
    .filter((m) => m.status !== 'closed')
  for (const m of others) {
    for (const s of m.steps) {
      if (m.id === mission.id && s.id === step.id) continue
      if ((await stepWorktrees(root, s)).includes(worktree)) {
        return `${m.id === mission.id ? s.id : `${m.id}/${s.id}`} links it too, and nothing names which branch is this step's`
      }
    }
  }
  return null
}

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

  const loaded = await loadMission(root, missionId)
  if (!loaded.ok) return errorResult(loaded.error)
  if (loaded.mission.status === 'closed') return errorResult(missionClosedMessage(missionId))
  const mission = loaded.mission

  // Which step, and which of its linked worktrees.
  const candidates: Array<{ step: MissionStep; worktree: string }> = []
  const pool = wantedStep
    ? mission.steps.filter((s) => s.id === wantedStep)
    : mission.steps.filter(stepIsOpen)
  if (wantedStep && pool.length === 0)
    return errorResult(stepNotFoundMessage(missionId, wantedStep))
  const repoDir = await repoCommonDir(root)
  // Fail CLOSED: if the mission's own repository cannot be identified, no worktree can be shown to
  // belong to it, so nothing is rebased.
  if (!repoDir) {
    return errorResult(
      `WORKTREE_NOT_IN_REPO: could not identify the repository of ${root}, so no worktree can be shown to belong to it — rebase_stack rebases nothing.`
    )
  }
  for (const step of pool) {
    for (const wt of await stepWorktrees(root, step)) {
      if (wt === root) continue // never the main checkout: the rebase core would refuse it anyway
      if ((await repoCommonDir(wt)) !== repoDir) {
        return errorResult(
          `WORKTREE_NOT_IN_REPO: ${wt}, linked on ${step.id}, belongs to a different repository than this mission — rebase_stack only rebases this repo's own worktrees.`
        )
      }
      candidates.push({ step, worktree: wt })
    }
  }
  if (candidates.length === 0) {
    return errorResult(
      `NO_STEP_WORKTREE: ${wantedStep ? wantedStep : 'no open step of this mission'} links a linked worktree — mission_link_child { kind: 'worktree', ref: <path> } the step's worktree first.`
    )
  }
  // Path trust: a worktree linked on the step is not yet the step's OWN. Keep only the ones that are —
  // a sibling (the operator's, another mission's) is never rewritten.
  const own: typeof candidates = []
  const foreign: string[] = []
  for (const c of candidates) {
    const why = await foreignWorktreeReason(root, mission, c.step, c.worktree)
    if (why) foreign.push(`${c.worktree} (${why})`)
    else own.push(c)
  }
  if (own.length === 0) {
    return errorResult(
      `NOT_STEP_WORKTREE: none of the worktrees linked on ${wantedStep ?? 'the open steps'} is this step's own — ${foreign.join('; ')}. rebase_stack rewrites only a step's own branch.`
    )
  }
  candidates.splice(0, candidates.length, ...own)
  if (candidates.length > 1) {
    return errorResult(
      `STEP_AMBIGUOUS: several steps link a worktree (${candidates.map((c) => `${c.step.id} → ${c.worktree}`).join('; ')}) — pass stepId.`
    )
  }
  const { step, worktree } = candidates[0]

  const res = await rebaseStack({ worktree, onto, ...(from ? { from } : {}) })
  if (res.ok) {
    return textResult({
      ok: true,
      op: 'rebase_stack',
      stepId: step.id,
      branch: res.branch,
      before: res.before,
      after: res.after,
      rebased: res.rebased,
      // The local branch moved; no remote ref did. Publishing is the owner's move.
      pushed: false
    })
  }
  if (res.code === 'REBASE_CONFLICT') {
    const reason = `Rebase of ${res.branch} onto ${onto} conflicted in ${res.conflicts.join(', ')}`
    // The tree is exactly as it was (the core verified). Flag the step, once; the retry of an
    // unchanged conflict updates the existing blocker instead of stacking a second.
    await editMission(args, ctx, (m) => {
      const target = m.steps.find((s) => s.id === step.id)
      if (!target) return { ok: false, error: stepNotFoundMessage(m.id, step.id) }
      const unblocks =
        'Resolve the conflict by hand (rebase the branch yourself, or fix the overlap), then clear this blocker.'
      const existing = target.blockers.find((b) => b.reason === reason)
      if (existing) {
        existing.unblocks = unblocks
        return { ok: true, mission: m, unchanged: true, ack: { ok: true } }
      }
      target.blockers.push({ reason, unblocks, owner: 'agent', raisedAt: new Date().toISOString() })
      return { ok: true, mission: m, ack: { ok: true } }
    })
    return errorResult(
      `REBASE_CONFLICT: ${reason}. The rebase was aborted and ${worktree} is exactly as it was (HEAD ${res.head}). An agent-owned blocker is set on ${step.id}; do not retry — tell the operator.`
    )
  }
  return errorResult(`${res.code}: ${res.detail}`)
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

/** Campaign spec §3.2: what a Log entry can be. */
const LOG_KINDS: ReadonlySet<string> = new Set(['note', 'decision', 'surprise', 'steward'])

/**
 * Campaign ch.5a (spec §3.4): "every action it takes is a `steward` Log entry". Called by the
 * control server after a steward's successful write, so the entry exists whether or not the model
 * remembers to write one. Never throws: the action already happened.
 */
export async function appendStewardLog(
  folder: string,
  missionId: string,
  op: string,
  args: Record<string, unknown>
): Promise<void> {
  try {
    const root = missionRoot(folder)
    await withMissionIdMintLock(missionId, async () => {
      const loaded = await loadMission(root, missionId)
      if (!loaded.ok || loaded.mission.status === 'closed') return
      const { folder: _f, missionId: _m, ...rest } = args
      void _f
      void _m
      const brief = JSON.stringify(rest, (_k, v) =>
        typeof v === 'string' && v.length > 200 ? `${v.slice(0, 199)}…` : v
      )
      const text = `${op} ${brief.length > 600 ? `${brief.slice(0, 599)}…` : brief}`
      await atomicWriteFile(
        loaded.file,
        loaded.raw + missionLogEntry(loaded.raw, ' · steward', text),
        0o644
      )
    })
  } catch (err) {
    console.warn(`[steward] could not log ${op} on ${missionId}:`, err)
  }
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
    // Append to the raw file: the frontmatter bytes stay exactly as they were. The heading carries the
    // entry's kind (`### <time> · steward · stp-2`), so the Log can be read by kind; a plain note keeps
    // the heading it always had.
    const kind = strField(args, 'kind')
    const kindTag = kind && kind !== 'note' && LOG_KINDS.has(kind) ? ` · ${kind}` : ''
    const entry = missionLogEntry(loaded.raw, `${kindTag}${stepId ? ` · ${stepId}` : ''}`, note)
    if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
    await atomicWriteFile(loaded.file, loaded.raw + entry, 0o644)
    return textResult({ ok: true, op: 'mission_log' })
  })
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
      ...(typeof args.background === 'boolean' ? { background: args.background } : {})
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
      paneId: optStr(args, 'paneId') ?? '',
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
  const res = await closeVerb({ paneId: optStr(args, 'paneId') ?? '' }, browserDeps(ctx))
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
    const end = paneId ? beginPaneVerb(browserRegistry, paneId) : undefined
    try {
      return await runWithRevival(() => handler(args, ctx))
    } finally {
      end?.()
    }
  }
}

/** The single dispatch table: every {@link McpOp} maps to exactly one handler. */
/** The pane-addressed reading verbs share one shape: a `paneId` and the verb's own arguments. */
function paneArgs(args: Record<string, unknown>): { paneId: string } {
  return { paneId: optStr(args, 'paneId') ?? '' }
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

/** The single dispatch table: every {@link McpOp} maps to exactly one handler. */
// ---- campaign_* verbs (T595, chapter 3a — campaign spec §3.1/§3.3/§3.5) ------
//
// A campaign is the quest line ABOVE a mission: ordered chapters, each of which IS a
// mission. Stored in the repo's MAIN checkout like missions (`missionRoot`), so every
// worktree shares it. No verb here merges, chooses a decision, ticks a check or closes a
// campaign: `campaign_request_close` only signals. Same locking rule as missions: each
// read-modify-write runs under `withCampaignLock(id)` exactly ONCE (the lock is not
// re-entrant), and no helper below takes it on its own.

interface CampaignFileEntry {
  id: string
  slug: string
  name: string
}

/** Every `<id>-<slug>.md` in `root`'s campaigns dir; `[]` when there is none yet. */
async function listCampaignEntries(root: string): Promise<CampaignFileEntry[]> {
  await dataDirReady(root)
  let names: string[]
  try {
    names = await fs.readdir(campaignsDir(root))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: CampaignFileEntry[] = []
  for (const name of names.sort()) {
    const m = /^(cmp-[0-9a-f]{8})-(.+)\.md$/.exec(name)
    if (m) out.push({ id: m[1], slug: m[2], name })
  }
  return out
}

type LoadedCampaign =
  | { ok: true; file: string; raw: string; campaign: Campaign; log: string }
  | { ok: false; error: string }

/** Read + parse one campaign by id; a steerable error when absent or corrupt. */
export async function loadCampaign(root: string, id: string): Promise<LoadedCampaign> {
  if (!CAMPAIGN_ID_RE.test(id)) {
    return { ok: false, error: `BAD_ARGS: campaignId "${id}" is not a campaign id (cmp-<8 hex>).` }
  }
  const entry = (await listCampaignEntries(root)).find((e) => e.id === id)
  if (!entry) {
    return {
      ok: false,
      error: `CAMPAIGN_NOT_FOUND: no campaign ${id} in this repo — campaign_list shows the ones that exist.`
    }
  }
  const file = path.join(campaignsDir(root), entry.name)
  const raw = await fs.readFile(file, 'utf8')
  const parsed = parseCampaignFile(raw)
  if ('error' in parsed) {
    return { ok: false, error: `CAMPAIGN_UNREADABLE: ${entry.name} — ${parsed.error}` }
  }
  return { ok: true, file, raw, campaign: parsed, log: readCampaignLog(raw) }
}

/** Every readable campaign under `root`, with its Log; corrupt files are reported, not thrown. */
async function readAllCampaigns(root: string): Promise<{
  campaigns: Array<{ campaign: Campaign; log: string; file: string }>
  unreadable: string[]
}> {
  const campaigns: Array<{ campaign: Campaign; log: string; file: string }> = []
  const unreadable: string[] = []
  for (const entry of await listCampaignEntries(root)) {
    const loaded = await loadCampaign(root, entry.id)
    if (loaded.ok) campaigns.push({ campaign: loaded.campaign, log: loaded.log, file: loaded.file })
    else unreadable.push(entry.name)
  }
  return { campaigns, unreadable }
}

/** A refusal for a folder (or its repo root) the operator blocked for agents. */
function campaignFolderRefusal(folder: string, root: string, ctx: ToolHandlerCtx): string | null {
  if (isFolderDenied(folder, ctx.denyFolders) || isFolderDenied(root, ctx.denyFolders)) {
    return 'FOLDER_NOT_ALLOWED: the operator blocked this folder for agents — its campaigns are off limits. Tell the operator; they can unblock it from the folder menu.'
  }
  return null
}

function campaignClosedMessage(id: string): string {
  return `CAMPAIGN_CLOSED: campaign ${id} was closed by the operator — a closed campaign is immutable by verb.`
}

function chapterNotFoundMessage(campaignId: string, chapterId: string): string {
  return `CHAPTER_NOT_FOUND: campaign ${campaignId} has no chapter ${chapterId} — campaign_get lists its chapters.`
}

/** A campaign slug from its title; `campaign` when the title has nothing slug-able. */
function campaignSlugBase(title: string): string {
  const slug = slugifyTitle(title)
  // `slugifyTitle` falls back to `card` for an empty result — wrong noun here.
  return slug === 'card' && !/card/i.test(title) ? 'campaign' : slug
}

/** Per-repo create lock: serializes id-mint + slug pick so concurrent creates stay unique. */
const campaignCreateLocks = new Map<string, Promise<unknown>>()

const CHAPTERS_MAX = 50
const TOKENS_MAX = 20

/** A token list as stored: trimmed, deduped, non-empty; `undefined` when absent. */
function parseTokens(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > TOKENS_MAX) return null
  const out: string[] = []
  for (const t of raw) {
    if (typeof t !== 'string') return null
    const token = t.trim()
    if (!token || token.length > 100) return null
    if (!out.includes(token)) out.push(token)
  }
  return out
}

/**
 * One chapter's declared fields (the shape shared by `campaign_create`'s `chapters[]` and
 * `campaign_add_chapter`), or a BAD_ARGS refusal. The id, ordinal and `missionId` are never
 * taken from an argument.
 */
function parseChapterInput(
  raw: unknown
): { ok: true; chapter: NewChapter } | { ok: false; error: string } {
  const bad = (why: string): { ok: false; error: string } => ({
    ok: false,
    error: `BAD_ARGS: a chapter is { title (1..200 chars), required?, consumes?, produces?, radiant? } — ${why}.`
  })
  if (typeof raw !== 'object' || raw === null) return bad('not an object')
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : ''
  if (!title || title.length > 200) return bad('title must be 1..200 characters')
  if (r.required !== undefined && typeof r.required !== 'boolean')
    return bad('required must be a boolean')
  const consumes = parseTokens(r.consumes)
  const produces = parseTokens(r.produces)
  if (consumes === null || produces === null) {
    return bad(`consumes/produces are arrays of at most ${TOKENS_MAX} non-empty tokens`)
  }
  let radiant: NewChapter['radiant']
  if (r.radiant !== undefined) {
    const rd = r.radiant as Record<string, unknown> | null
    const template = typeof rd?.template === 'string' ? rd.template.trim() : ''
    const total = rd?.total
    if (!template || typeof total !== 'number' || !Number.isInteger(total) || total < 1) {
      return bad('radiant is { template, total >= 1 }')
    }
    radiant = { template, total }
  }
  return {
    ok: true,
    chapter: {
      title,
      required: r.required !== false,
      ...(consumes ? { consumes } : {}),
      ...(produces ? { produces } : {}),
      ...(radiant ? { radiant } : {})
    }
  }
}

/** The PREREQ_MISSING refusal (spec §3.5): names every gap, and the way out. */
function prereqMessage(missing: readonly MissingPrerequisite[]): string {
  const lines = missing.map(
    (m) =>
      `chapter "${m.title}" (${m.chapterId}) consumes "${m.token}", which no earlier chapter produces`
  )
  return `PREREQ_MISSING: ${lines.join('; ')} — put the chapter that produces it first, or pass force: true to accept the gap (it is logged as a surprise). Nothing was written.`
}

/** The Log entry a forced prerequisite gap leaves (campaign spec §3.5: `force` logs a `surprise`). */
function surpriseEntry(at: string, missing: readonly MissingPrerequisite[]): string {
  const lines = missing.map(
    (m) =>
      `PREREQ_MISSING accepted with force: chapter "${m.title}" (${m.chapterId}) consumes "${m.token}", which no earlier chapter produces.`
  )
  return `\n### ${at} · surprise\n\n${lines.join('\n')}\n`
}

type CampaignWrite = { ok: true; campaign: Campaign } | { ok: false; error: string }

/**
 * Mint a fresh id and a repo-unique slug (from `title`) and exclusively write the campaign
 * `build` returns, with `log` as its body. Runs under the repo's campaign-create lock;
 * `createCampaignFile` rejects EEXIST on a genuine id collision — the id is redrawn.
 */
async function writeNewCampaign(
  root: string,
  title: string,
  build: (id: string, slug: string, now: string) => Campaign,
  log: (now: string) => string
): Promise<CampaignWrite> {
  return serializeByKey(campaignCreateLocks, root, async (): Promise<CampaignWrite> => {
    const entries = await listCampaignEntries(root)
    const takenIds = entries.map((e) => e.id)
    const slug = resolveUniqueSlug(campaignSlugBase(title), new Set(entries.map((e) => e.slug)))
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = new Date().toISOString()
      const campaign = build(mintCampaignId(takenIds), slug, now)
      try {
        await createCampaignFile(root, campaign, log(now))
        return { ok: true, campaign }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          return { ok: false, error: `WRITE_FAILED: ${(err as Error).message}` }
        }
        takenIds.push(campaign.id)
      }
    }
    return { ok: false, error: 'WRITE_FAILED: could not mint a free campaign id' }
  })
}

const campaignCreateHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const title = strField(args, 'title')?.replace(/\s+/g, ' ').trim()
  if (!title) return errorResult('BAD_ARGS: title is required')
  const problems = declaredEndProblems(args.declaredEnd)
  if (problems.length > 0) {
    return errorResult(
      `DECLARED_END_INCOMPLETE: missing or invalid ${problems.join(', ')} — a campaign needs a complete declared end at creation: kind (${DECLARED_END_KINDS.join(' | ')}), a concrete target, and the evidence that proves it.`
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
  const root = missionRoot(folder)
  const refusal = campaignFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)

  const rawChapters = args.chapters
  if (!Array.isArray(rawChapters) || rawChapters.length < 1 || rawChapters.length > CHAPTERS_MAX) {
    return errorResult(`BAD_ARGS: chapters must be an array of 1..${CHAPTERS_MAX} chapters.`)
  }
  const chapters: Chapter[] = []
  for (const raw of rawChapters) {
    const parsed = parseChapterInput(raw)
    if (!parsed.ok) return errorResult(parsed.error)
    chapters.push(buildChapter(parsed.chapter, chapters.length + 1))
  }
  // Spec §3.5: the prerequisite pass — before any write.
  const missing = missingPrerequisites(chapters)
  const force = args.force === true
  if (missing.length > 0 && !force) return errorResult(prereqMessage(missing))

  const scope = await resolveScopeLinks(root, args.scope)
  if (!scope.ok) return errorResult(scope.error)
  const { gitBranch } = await probeGitMeta(folder)
  // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before writing.
  if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')

  const created = await writeNewCampaign(
    root,
    title,
    (id, slug, now) => ({
      id,
      slug,
      folder: root,
      owner: { sessionId, folder: path.resolve(folder) },
      title,
      declaredEnd,
      chapters,
      status: 'active',
      ...(scope.links.length > 0 ? { scope: scope.links } : {}),
      createdAt: now,
      updatedAt: now,
      provenance: { author: 'agent', at: now, ...(gitBranch ? { branch: gitBranch } : {}) }
    }),
    (now) => `# ${title}\n\n## Log\n${missing.length > 0 ? surpriseEntry(now, missing) : ''}`
  )
  if (!created.ok) return errorResult(created.error)
  return textResult({
    ok: true,
    op: 'campaign_create',
    campaignId: created.campaign.id,
    slug: created.campaign.slug,
    chapters: created.campaign.chapters,
    ...(created.campaign.scope ? { scope: created.campaign.scope } : {}),
    ...(missing.length > 0
      ? { forced: missing.map((m) => ({ chapterId: m.chapterId, token: m.token })) }
      : {})
  })
}

type CampaignEdit =
  | {
      ok: true
      campaign: Campaign
      ack: Record<string, unknown>
      logAppend?: string
    }
  | { ok: false; error: string }

/**
 * One locked read → mutate → write of a campaign's frontmatter. `fn` gets a private copy; its
 * result is re-validated by `buildCampaignFileContent` before an atomic replace, and
 * `updatedAt` is stamped here so no verb forgets it. The Log body is carried over, plus
 * `logAppend`. A closed campaign is a record: refused CAMPAIGN_CLOSED before `fn` runs.
 */
async function editCampaign(
  args: Record<string, unknown>,
  ctx: ToolHandlerCtx,
  fn: (campaign: Campaign, root: string) => CampaignEdit | Promise<CampaignEdit>
): Promise<CallToolResult> {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const id = strField(args, 'campaignId') ?? ''
  const root = missionRoot(folder)
  const refusal = campaignFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)
  return withCampaignLock(id, async () => {
    const loaded = await loadCampaign(root, id)
    if (!loaded.ok) return errorResult(loaded.error)
    if (loaded.campaign.status === 'closed') return errorResult(campaignClosedMessage(id))
    const edit = await fn(structuredClone(loaded.campaign), root)
    if (!edit.ok) return errorResult(edit.error)
    const next: Campaign = { ...edit.campaign, updatedAt: new Date().toISOString() }
    let content: string
    try {
      content = buildCampaignFileContent(next, loaded.log + (edit.logAppend ?? ''))
    } catch (err) {
      return errorResult(`BAD_ARGS: ${(err as Error).message}`)
    }
    // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort the write.
    if (ctx.deadlineFlag?.fired) return errorResult('DEADLINE_FIRED')
    await atomicWriteFile(loaded.file, content, 0o644)
    return textResult(edit.ack)
  })
}

const campaignAddChapterHandler: Handler = async (args, ctx) => {
  const parsed = parseChapterInput(args)
  if (!parsed.ok) return errorResult(parsed.error)
  const input: NewChapter = { ...parsed.chapter }
  const df = args.discoveredFrom as Record<string, unknown> | undefined
  if (df !== undefined) {
    if (typeof df?.chapterId !== 'string' || !df.chapterId) {
      return errorResult('BAD_ARGS: discoveredFrom is { chapterId, stepId? }.')
    }
    input.discoveredFrom = {
      chapterId: df.chapterId,
      ...(typeof df.stepId === 'string' && df.stepId ? { stepId: df.stepId } : {})
    }
  }
  const un = args.unlocks as Record<string, unknown> | undefined
  if (un !== undefined) {
    if (
      !['decision', 'chapter', 'pr'].includes(un?.kind as string) ||
      typeof un.ref !== 'string' ||
      !un.ref
    ) {
      return errorResult("BAD_ARGS: unlocks is { kind: 'decision' | 'chapter' | 'pr', ref }.")
    }
    input.unlocks = { kind: un.kind as ChapterUnlockKind, ref: un.ref }
  }
  const force = args.force === true
  return editCampaign(args, ctx, (c) => {
    const known = new Set(c.chapters.map((x) => x.id))
    if (input.discoveredFrom && !known.has(input.discoveredFrom.chapterId)) {
      return { ok: false, error: chapterNotFoundMessage(c.id, input.discoveredFrom.chapterId) }
    }
    if (input.unlocks?.kind === 'chapter' && !known.has(input.unlocks.ref)) {
      return { ok: false, error: chapterNotFoundMessage(c.id, input.unlocks.ref) }
    }
    const at = new Date().toISOString()
    const next = applyAddChapter(c, input, at)
    // Spec §3.5: only the chapter being added is judged — earlier ones were accepted (or forced).
    const missing = missingPrerequisites(next.chapters, next.chapters.length - 1)
    if (missing.length > 0 && !force) return { ok: false, error: prereqMessage(missing) }
    const added = next.chapters[next.chapters.length - 1]
    return {
      ok: true,
      campaign: next,
      ack: {
        ok: true,
        op: 'campaign_add_chapter',
        campaignId: c.id,
        chapterId: added.id,
        totalChapters: next.chapters.length,
        ...(missing.length > 0
          ? { forced: missing.map((m) => ({ chapterId: m.chapterId, token: m.token })) }
          : {})
      },
      ...(missing.length > 0 ? { logAppend: surpriseEntry(at, missing) } : {})
    }
  })
}

type ChapterUnlockKind = 'decision' | 'chapter' | 'pr'

/**
 * Each chapter's bound-mission facts from what is on disk plus the last progress derive —
 * no GitHub, no live signals. Enough for everything a campaign decides from a mission's
 * STATUS (done), and the best last-known for the rest (`campaign_list`, the close check).
 */
async function cachedChapterFacts(root: string, campaign: Campaign): Promise<ChapterFacts[]> {
  return Promise.all(
    campaign.chapters.map(async (c): Promise<ChapterFacts> => {
      if (!c.missionId) return { chapterId: c.id, mission: null }
      const loaded = await loadMission(root, c.missionId)
      if (!loaded.ok) return { chapterId: c.id, mission: null }
      const m = loaded.mission
      return {
        chapterId: c.id,
        mission: {
          status: m.status,
          ...(m.closedAs ? { closedAs: m.closedAs } : {}),
          progress: lastProgress.get(m.id) ?? null
        }
      }
    })
  )
}

const campaignGetHandler: Handler = async (args, ctx) => {
  const folder = ctx.folder
  if (!folder) return errorResult('BAD_ARGS: folder is required')
  const campaignId = strField(args, 'campaignId')
  const ownerSessionId = strField(args, 'ownerSessionId')
  if (!campaignId === !ownerSessionId) {
    return errorResult('BAD_ARGS: pass exactly one of campaignId / ownerSessionId')
  }
  const root = missionRoot(folder)
  const refusal = campaignFolderRefusal(folder, root, ctx)
  if (refusal) return errorResult(refusal)

  let found: { campaign: Campaign; log: string }
  if (campaignId) {
    const loaded = await loadCampaign(root, campaignId)
    if (!loaded.ok) return errorResult(loaded.error)
    found = loaded
  } else {
    const owned = (await readAllCampaigns(root)).campaigns
      .filter(
        (c) => c.campaign.owner.sessionId === ownerSessionId && c.campaign.status !== 'closed'
      )
      .sort((a, b) => b.campaign.updatedAt.localeCompare(a.campaign.updatedAt))
    if (owned.length === 0) {
      return errorResult(
        `CAMPAIGN_NOT_FOUND: session ${ownerSessionId} owns no open campaign in this repo.`
      )
    }
    found = owned[0]
  }
  const { campaign, log } = found
  const now = Date.now()
  // Each chapter's mission is derived fresh (the same derive `mission_get` runs), so the
  // chapter states below come from live facts, not from a poll that may be a minute old.
  const facts: ChapterFacts[] = []
  const missions = new Map<string, Mission>()
  for (const c of campaign.chapters) {
    if (!c.missionId) {
      facts.push({ chapterId: c.id, mission: null })
      continue
    }
    const loaded = await loadMission(root, c.missionId)
    if (!loaded.ok) {
      facts.push({ chapterId: c.id, mission: null })
      continue
    }
    missions.set(c.id, loaded.mission)
    const m = loaded.mission
    const progress =
      m.status === 'closed'
        ? null
        : (await deriveMissionSignals(root, m, loaded.log, ctx, now)).derived.progress
    facts.push({
      chapterId: c.id,
      mission: { status: m.status, ...(m.closedAs ? { closedAs: m.closedAs } : {}), progress }
    })
  }
  const progress = computeCampaignProgress(campaign, facts, now)
  const rows = campaign.chapters.map((c, i) => {
    const m = missions.get(c.id)
    const mp = facts[i].mission?.progress ?? null
    return {
      chapterId: c.id,
      ordinal: c.ordinal,
      title: c.title,
      required: c.required,
      state: progress.states[c.id],
      missionId: c.missionId ?? null,
      mission: m
        ? {
            status: m.status,
            ...(m.closedAs ? { closedAs: m.closedAs } : {}),
            headline: mp ? progressHeadline(mp) : null
          }
        : null,
      ...(c.missionId && !m ? { missionProblem: 'the bound mission could not be read' } : {})
    }
  })
  return textResult({
    ok: true,
    op: 'campaign_get',
    campaign,
    title: campaign.title,
    log,
    derived: { computedAt: new Date(now).toISOString(), progress, chapters: rows },
    closeReadiness: campaignCloseRefusal(campaign, progress)
  })
}

const campaignListHandler: Handler = async (_args, ctx) => {
  const folder = ctx.folder
  let roots: string[]
  if (folder) {
    const root = missionRoot(folder)
    const refusal = campaignFolderRefusal(folder, root, ctx)
    if (refusal) return errorResult(refusal)
    roots = [root]
  } else {
    roots = [...new Set(ctx.folders.map((f) => missionRoot(f.path)))].filter(
      (root) => !isFolderDenied(root, ctx.denyFolders)
    )
  }
  const now = Date.now()
  const rows: Record<string, unknown>[] = []
  const unreadable: string[] = []
  for (const root of roots) {
    const read = await readAllCampaigns(root)
    unreadable.push(...read.unreadable.map((n) => path.join(campaignsDir(root), n)))
    for (const { campaign: c } of read.campaigns) {
      const progress = computeCampaignProgress(c, await cachedChapterFacts(root, c), now)
      rows.push({
        id: c.id,
        slug: c.slug,
        title: c.title,
        status: c.status,
        folder: c.folder,
        ownerSessionId: c.owner.sessionId,
        // Last-known (see computedAt): campaign_get derives each mission fresh.
        progress,
        updatedAt: c.updatedAt
      })
    }
  }
  return textResult({
    ok: true,
    op: 'campaign_list',
    campaigns: rows,
    ...(unreadable.length > 0 ? { unreadable } : {})
  })
}

const campaignRequestCloseHandler: Handler = async (args, ctx) => {
  const requestedBy = strField(args, 'sessionId')
  if (requestedBy !== undefined && !SESSION_UUID_RE.test(requestedBy)) {
    return errorResult(badSessionIdMessage('sessionId', requestedBy))
  }
  return editCampaign(args, ctx, async (c, root) => {
    // The same check campaign_get reports as `closeReadiness`.
    const progress: CampaignProgress = computeCampaignProgress(
      c,
      await cachedChapterFacts(root, c),
      Date.now()
    )
    const refused = campaignCloseRefusal(c, progress)
    if (refused) return { ok: false, error: `${refused.code}: ${refused.reason}` }
    // The agent's request lands on `delivered` + `pendingClose`; only the operator's UI
    // reaches `closed`.
    c.status = 'delivered'
    c.pendingClose = { at: new Date().toISOString(), requestedBy: requestedBy ?? c.owner.sessionId }
    return {
      ok: true,
      campaign: c,
      ack: { ok: true, op: 'campaign_request_close', pendingClose: true }
    }
  })
}

/**
 * Create a chapter's mission and bind it to the chapter, under the campaign's lock: validate
 * the campaign and chapter first (nothing is written on a refusal), write the mission via
 * `create`, then record its id on the chapter. If the campaign cannot be rewritten after the
 * mission landed, the error says so and names the mission — it is never silently half-bound.
 */
async function bindMissionToChapter(
  root: string,
  campaignId: string,
  chapterId: string,
  create: () => Promise<MissionWrite>,
  ctx: ToolHandlerCtx
): Promise<MissionWrite> {
  return withCampaignLock(campaignId, async (): Promise<MissionWrite> => {
    const loaded = await loadCampaign(root, campaignId)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { campaign } = loaded
    if (campaign.status === 'closed') return { ok: false, error: campaignClosedMessage(campaignId) }
    const chapter = campaign.chapters.find((c) => c.id === chapterId)
    if (!chapter) return { ok: false, error: chapterNotFoundMessage(campaignId, chapterId) }
    if (chapter.missionId) {
      return {
        ok: false,
        error: `CHAPTER_ALREADY_BOUND: chapter ${chapterId} of campaign ${campaignId} already is mission ${chapter.missionId} — a chapter takes one mission; add a chapter (campaign_add_chapter) for further work.`
      }
    }
    // BUG-33 AC5: the response already went out as TOOL_TIMEOUT — abort before writing.
    if (ctx.deadlineFlag?.fired) return { ok: false, error: 'DEADLINE_FIRED' }
    const made = await create()
    if (!made.ok) return made
    const next: Campaign = {
      ...campaign,
      chapters: campaign.chapters.map((c) =>
        c.id === chapterId ? { ...c, missionId: made.mission.id } : c
      ),
      updatedAt: new Date().toISOString()
    }
    try {
      await atomicWriteFile(loaded.file, buildCampaignFileContent(next, loaded.log), 0o644)
    } catch (err) {
      return {
        ok: false,
        error: `WRITE_FAILED: mission ${made.mission.id} was created but campaign ${campaignId} could not record it on chapter ${chapterId}: ${(err as Error).message}`
      }
    }
    return made
  })
}

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
  mission_add_check: missionAddCheckHandler,
  campaign_create: campaignCreateHandler,
  campaign_add_chapter: campaignAddChapterHandler,
  campaign_get: campaignGetHandler,
  rebase_stack: rebaseStackHandler,
  campaign_list: campaignListHandler,
  campaign_request_close: campaignRequestCloseHandler
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
