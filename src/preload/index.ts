import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { SessionEntry, SessionStatus } from '../main/claude-reader'
import type { FolderEntry, GitMeta } from '../main/folder-model'
import type {
  AvailableSkill,
  BundledSkillsView,
  UserLevelInstallResult
} from '../main/bundled-skills'
import type {
  DegradedCode,
  SessionUpdatePayload,
  SubagentUpdatePayload
} from '../main/claude-watcher'
import type { UserProject, UserProjectWorktree } from '../main/user-projects'
import type { WorktreeHelperState } from '../main/helpers-store'
import type { UsageSnapshot } from '../main/usage-parse'
import type { TelemetryPayload } from '../main/statusline'
import type { TaskState, FailureReason } from '../main/hook-state'
import type { PtyExitReason } from '../main/pty'
import type { ReviewCorrective } from '../main/review-corrective'
import type { ResponderMode } from '../main/responder-dispatch'
import type { ShadowEntry } from '../main/responder-registry'
import type {
  BranchRef,
  WorktreePlanResult,
  WorktreeProgress,
  ExistingWorkMatch
} from '../main/worktree-core'
import type { PendingApprovalWire, ApprovalResolvedReason } from '../main/approval-parse'
import type { NotifyPayload } from '../main/notifications'
import type { SpeechSayRequest, SpeechSayResult } from '../main/speech'
import type { KokoroInstallPlan, KokoroProgress, KokoroStatus } from '../main/speech-kokoro-plan'
import type { AgentSpeechPrefs } from '../main/speech-gate-core'
import type { ClaudeChangelogState } from '../main/claude-changelog-state'
import type { ClaudeStatusSnapshot } from '../main/claude-status-parse'
import type { ClaudeBootConfig, EndpointProfile } from '../main/claude-args'
import type { Worker, Run } from '../main/scheduler-core'
import type { SchedulerState } from '../main/scheduler-shell'
import type { CompanionDiagnostics } from '../main/companion/host-core'
import type { IdentityClaim, IdentityOutcome } from '../main/companion/identity-core'
import type { RoutingTable, ResolvedRouting } from '../main/routing-policy'
import type { PrStackSnapshot, WorktreeNode as PrStackWorktree } from '../main/pr-stack-core'
import type { PrStackPrefs } from '../main/pr-stack-prefs'
import type { MissionDoor, MissionDoorResult, MissionListResult } from '../main/mission-ipc'
import type {
  ReviewSnapshot,
  ReviewLoadArgs,
  ReviewSetViewedArgs,
  ReviewSetViewedResult,
  ReviewSubmitArgs,
  ReviewSubmitResult,
  BlastRadiusConfig
} from '../main/review-ipc'
import type { PushChannel, PushConfig, PushSendPayload, PushTestResult } from '../main/push'
import type {
  ClaudeSettingsRead,
  ClaudeSettingsWire,
  ClaudeSettingsPatchResult
} from '../main/claude-settings-ipc'
import type { PlanFitResult, TierRecommendation } from '../main/usage-history-core'
import type {
  UsageHistoryPrefs,
  UsageHistorySummary,
  DailyBudgetBaseline
} from '../main/usage-history'
import type { UsageCostSummary } from '../main/usage-cost'
import type { UsageBiSnapshot, UsageBiRange } from '../main/usage-bi'
import type { HeapSample, MonitorSample } from '../main/monitor/types'
import type { Policy } from '../main/fleet-policy'
import type { ImageEntry } from '../main/image-cache'
import type {
  SubfolderEntry,
  SubfolderScan,
  ChildFolderEntry,
  ChildFolderScan
} from '../main/folder-ops'
import type { FolderGitStatus } from '../main/folder-git-status'
import type { ExplorerListing, ExplorerSearchResult, ResolvedPath } from '../main/explorer-ipc'
import type { MarkdownReadResult } from '../main/markdown-read'
import type { MarkdownWriteResult } from '../main/markdown-write'
import type { CanvasAttachInput, CanvasAttachResult } from '../main/canvas-assets'
import type { CanvasReadResult } from '../main/canvas-read'
import type { CanvasWriteResult } from '../main/canvas-write'
import type { WorktreeMdProbeResult, WorktreeMdCreateResult } from '../main/worktree-md-ipc'
import type { MemoryReadResult } from '../main/memory-ipc'
import type {
  FolderMemoryLocationResult,
  SetGlobalResult,
  SetOverrideResult,
  MigrateFolderResult,
  MigrateKnownResult
} from '../main/memory-location-ipc'
import type { MemoryLocationConfig } from '../main/mcp/memory-core'
import type {
  RoadmapCard,
  CardStatus,
  CardProvenance,
  BootPromptLabels,
  ArtifactKey,
  GeneratorPromptLabels
} from '../main/roadmap-core'
import type {
  RoadmapLoadResult,
  RoadmapPeekResult,
  RoadmapWriteCode,
  RoadmapDispatchPlan,
  RoadmapMergeEvidence
} from '../main/roadmap-ipc'
// Reaper cleanup engine wire types (T5/T6). `scan-core.ts` and `reaper-core.ts`
// are pure modules; `executor-core.ts` and `journal.ts` are node modules whose
// TYPES are pure. All re-exported type-only for the renderer's Cleanup view.
import type { ReaperSnapshot } from '../main/reaper/scan-core'
import type {
  ReapItem,
  ReapItemKind,
  CheckpointId,
  CheckpointState,
  Checkpoint,
  ReapVerdict,
  MergeSignal,
  HydrationInfo,
  DehydrateSkip,
  DehydrateSkipReason
} from '../main/reaper/reaper-core'
import type { CleanResult, CleanStepId, CleanStepResult } from '../main/reaper/executor-core'
import type {
  DehydrateResult,
  RehydrateResult,
  RehydrateFailure
} from '../main/reaper/dehydrate-core'
import type { Tombstone } from '../main/reaper/journal'
import type { ReaperPrefs } from '../main/reaper/prefs'
import type { HarvestableAlert } from '../main/reaper/reaper-ipc'
// Containers wire types (T320, ADR-0014 §1): the ONLY containers module the
// preload and the renderer may import — plain JSON-safe types, no main internals.
import type {
  ContainersSnapshot,
  ContainersTotals,
  StackRow,
  ContainerRow,
  VolumeRow as ContainersVolumeRow,
  Verdict as ContainersVerdict,
  Tombstone as ContainersTombstone,
  ActRequest as ContainersActRequest,
  ActResult as ContainersActResult,
  StackActResult as ContainersStackActResult,
  ActErrorCode as ContainersActErrorCode,
  ContainersPrefs,
  NewZombiesAlert as ContainersNewZombiesAlert
} from '../main/containers/containers-wire'

// Renderer-facing aliases. The shapes are defined once on the main side
// (claude-reader.ts) and re-exported under the renderer's preferred names so
// `import type { Session } from '../../../preload'` matches the vocabulary
// used in `src/renderer/src/stores/sessions.ts`.
//
// `UserProject` / `UserProjectWorktree` are the user-intent folder records
// owned by `src/main/user-projects.ts` (U-2.1). The renderer imports them as
// type-only — they are the wire format of the `userProjects:*` IPC payloads.
export type {
  DegradedCode,
  SessionStatus,
  SessionEntry as Session,
  UserProject,
  UserProjectWorktree
}

// Folder-first model wire types (spec 2026-06-11). `folder-model.ts` is a pure
// shaping module (no node deps beyond `node:path`), so the renderer imports
// `FolderEntry`/`GitMeta` directly. `FolderEntry` is the wire shape; the store
// enriches it into its own `Folder` (adds `expanded`/`pinned`).
export type { FolderEntry, GitMeta }

// Bundled skills (T217). `bundled-skills.ts` is a node module (electron `app` +
// fs), so the renderer imports the pane's wire types type-only.
export type {
  AvailableSkill,
  BundledSkillsView,
  SkillOrigin,
  UserLevelInstallResult
} from '../main/bundled-skills'
export type { BundledSkill } from '../main/bundled-skills-core'

// Folder-ops wire types (T69). `folder-ops.ts` is a node module (fs), so the
// renderer imports these as type-only — the shape of the "Open subfolder" picker
// rows (`SubfolderEntry`) and the capped scan result (`SubfolderScan`). T73 adds
// the lazy-tree pair (`ChildFolderEntry`/`ChildFolderScan`) — one level at a time.
export type { SubfolderEntry, SubfolderScan, ChildFolderEntry, ChildFolderScan }

// Explorer tree wire types (Cluster C). `explorer-ipc.ts` is a node module (fs),
// so the renderer imports these type-only: one child row (`ExplorerEntry`) and
// the capped, error-or-truncated listing (`ExplorerListing`).
export type {
  ExplorerEntry,
  ExplorerListing,
  ExplorerSearchResult,
  ResolvedPath
} from '../main/explorer-ipc'

// Folder git-status wire type (T52 Slice 3). The hover card's expensive fields.
export type { FolderGitStatus }

// Confined markdown-read result (T74). `markdown-read.ts` is a node module (fs),
// so the renderer imports the envelope shape as type-only.
export type { MarkdownReadResult } from '../main/markdown-read'
export type { WorktreeMdProbeResult, WorktreeMdCreateResult } from '../main/worktree-md-ipc'

// Confined markdown-WRITE result (T74 phase 2 — editor / New markdown). Same
// type-only re-export so the renderer never crosses the node boundary directly.
export type { MarkdownWriteResult } from '../main/markdown-write'
// Confined canvas read/write envelopes (T218 U1). `canvas-{read,write}.ts` are
// node modules (fs), so the renderer imports the wire shapes type-only. The
// document type itself comes from the PURE `canvas-core.ts`, which the renderer
// may import directly — it has no fs and no electron.
export type { CanvasAttachInput, CanvasAttachResult } from '../main/canvas-assets'
export type { CanvasReadResult } from '../main/canvas-read'
export type { CanvasWriteResult } from '../main/canvas-write'
export type {
  CanvasDocument,
  CanvasNode,
  CanvasEdge,
  CanvasOrigin,
  CanvasDenyCode
} from '../main/canvas-core'
// Confined project-memory read result (T79 S3). The memory UI's wire shape: the
// `{ ok, data }` bundle (hot/decisions/timeline) or a `{ ok:false, code }` steer.
// `DigestMeta` is the timeline row; `MemoryPaneData` the bundle.
export type { MemoryReadResult } from '../main/memory-ipc'
export type { MemoryPaneData } from '../main/mcp/memory-store'
export type { DigestMeta } from '../main/mcp/memory-core'
// T89 configurable memory location: the config union + the IPC envelopes the
// Settings pane and folder dialog consume.
export type { MemoryLocationConfig, MemoryStorageMode } from '../main/mcp/memory-core'
export type { MemoryMigrationReport } from '../main/mcp/memory-store'
export type {
  FolderMemoryLocation,
  FolderMemoryLocationResult,
  SetGlobalResult,
  SetOverrideResult,
  MigrateFolderResult,
  MigrateKnownResult,
  MemoryLocationDenyCode
} from '../main/memory-location-ipc'
// Roadmap Kanban wire types (T80 S1). `roadmap-core.ts` is a pure module and
// `roadmap-ipc.ts` a node module (fs) — the renderer imports the card shape +
// column/status/provenance/labels + the load/write-code envelopes as type-only.
export type {
  RoadmapCard,
  ColumnKey,
  CardStatus,
  CardProvenance,
  BootPromptLabels,
  DispatchConfirmReason,
  CardSubstrate,
  ArtifactKey,
  GeneratorPromptLabels
} from '../main/roadmap-core'
export type {
  RoadmapLoadResult,
  RoadmapPeekCard,
  RoadmapPeekResult,
  RoadmapWriteCode,
  RoadmapDispatchPlan,
  RoadmapMergeEvidence
} from '../main/roadmap-ipc'
export type {
  ReaperSnapshot,
  ReapItem,
  ReapItemKind,
  CheckpointId,
  CheckpointState,
  Checkpoint,
  ReapVerdict,
  MergeSignal,
  HydrationInfo,
  DehydrateSkip,
  DehydrateSkipReason,
  DehydrateResult,
  RehydrateResult,
  RehydrateFailure,
  CleanResult,
  CleanStepId,
  CleanStepResult,
  Tombstone,
  ReaperPrefs,
  HarvestableAlert
}
export type {
  ContainersSnapshot,
  ContainersTotals,
  StackRow,
  ContainerRow,
  ContainersVolumeRow,
  ContainersVerdict,
  ContainersTombstone,
  ContainersActRequest,
  ContainersActResult,
  ContainersStackActResult,
  ContainersActErrorCode,
  ContainersPrefs,
  ContainersNewZombiesAlert
}
// PR Stack Canvas wire types (T198). The snapshot and its worktree rows come
// from the pure core; the prefs are the Settings → PR Stack contract.
export type { PrStackSnapshot, PrStackWorktree, PrStackPrefs }
// Model routing policy wire types (T97). Pure module (no node deps beyond the
// JSON-file persistence, which never crosses the IPC boundary) — the renderer
// imports the table/resolution shapes as type-only for the dispatch confirm +
// the folder-settings routing editor.
export type { RoutingTable, RoutingEntry, ResolvedRouting } from '../main/routing-policy'

// Helpers (split layout) state — re-exported so renderer stores/components
// can `import type { HelperPane, WorktreeHelperState } from '../../../preload'`
// without crossing the main-process module boundary directly.
export type { WorktreeHelperState, HelperPane, HelperPaneType } from '../main/helpers-store'

// Branch list for the New-worktree dialog base-ref select (T48). Re-exported so
// the dialog can type its `<select>` options without crossing the main boundary.
export type { BranchRef } from '../main/worktree-core'

// BUG-40 §3.5 / BUG-50 absorbed: `worktreeCreate`'s non-blocking collision
// warning, re-exported so the renderer can type it without crossing the
// main-process boundary directly.
export type { ExistingWorkMatch } from '../main/worktree-core'

// Claude config (raw settings.json) wire types (issue #16). `claude-settings-ipc.ts`
// keeps these framework-free shapes so the renderer's config pane can import them.
export type {
  ClaudeSettingsRead,
  ClaudeSettingsWire,
  ClaudeSettingsPatchResult
} from '../main/claude-settings-ipc'

// Plan-usage wire types (plan-usage-widget spec). `usage-parse.ts` is a pure
// module (no node deps), so the renderer imports its shapes directly.
export type { UsageSnapshot, UsageBucket, UsageStatus } from '../main/usage-parse'
export type { SessionTelemetry, RateWindow, FleetTelemetry } from '../main/statusline-parse'
export type { TelemetryPayload } from '../main/statusline'

// Usage-history + BI wire types (issue #19). `usage-history-core.ts` and
// `plan-tiers.ts` are pure modules (no node deps), so the renderer imports their
// shapes directly; `usage-history.ts` only contributes the IPC payload shapes.
export type {
  UsageSample,
  WindowRecord,
  DailyRollup,
  UsageHeatmap,
  HeatCell,
  PlanFitResult,
  PlanFitWindowStat,
  PlanFitVerdict,
  TierRecommendation
} from '../main/usage-history-core'
export type { PlanTier } from '../main/plan-tiers'
export type {
  UsageHistoryPrefs,
  UsageHistorySummary,
  DailyBudgetBaseline
} from '../main/usage-history'
export type { UsageCostSummary } from '../main/usage-cost'
export type { ModelCostRollup, ProjectCostRollup } from '../main/usage-cost-core'
export type {
  UsageBiSnapshot,
  UsageBiRange,
  UsageBiNow,
  UsageBiRateWindowNow,
  UsageBiDay
} from '../main/usage-bi'

// System Monitor wire types (T127 S1). `monitor/types.ts` is a pure module (no
// node deps), so the renderer imports its shapes directly; `Policy` is likewise
// plain data from the pure `fleet-policy.ts`.
export type { HeapSample, ProcSample, SessionSample, MonitorSample } from '../main/monitor/types'
export type { Policy } from '../main/fleet-policy'
export type { SessionAnatomy, EnrichedWindow, EnrichedWindowSession } from '../main/usage-bi-core'
// Pasted-images gallery: `image-cache.ts` keeps its type next to the pure core.
export type { ImageEntry } from '../main/image-cache'

// Hook-derived task-state (session-state real-state spec). `hook-state.ts` is a
// pure module, so the renderer imports the type directly.
export type { TaskState, FailureReason } from '../main/hook-state'

// Transcript-derived turn-over state (T91). Ground truth read from the JSONL,
// consumed by the canonical fleet classifier when no live hook signal is present.
export type { TranscriptState } from '../main/claude-reader'

// Stagnation verdict (T175/T176): a repeated-tool-target fold over the tail,
// merged into `stuck` alongside the silence-only rule (`fleet-state.ts`).
export type { StagnationVerdict } from '../main/claude-reader'

// Hook responder dispatch (hook-responder-dispatch spec). Pure module shapes —
// the renderer imports the mode + shadow-entry shapes directly.
export type { ResponderMode } from '../main/responder-dispatch'
export type { ShadowEntry } from '../main/responder-registry'
// Approval Inbox (approval-inbox spec). Pure module shapes.
export type {
  PendingApprovalWire,
  ApprovalKind,
  ApprovalResolvedReason
} from '../main/approval-parse'

export type { ClaudeRelease } from '../main/claude-changelog-parse'
export type { ClaudeChangelogState } from '../main/claude-changelog-state'

// Claude service-status wire types (issue #17). `claude-status-parse.ts` is a
// pure module (no node deps), so the renderer imports its shapes directly.
export type {
  ClaudeStatusSnapshot,
  StatusComponent,
  StatusIncident,
  StatusMaintenance,
  Severity
} from '../main/claude-status-parse'

// "Claude Boot" launch-options config (global + per-folder). `claude-args.ts`
// is a pure module (no node deps), so the renderer imports the shape directly.
// `EndpointProfile` is the custom-endpoint registry record (local-provider spec).
export type { ClaudeBootConfig, EndpointProfile } from '../main/claude-args'

// Scheduler workers (T294 / T291 U4): `scheduler-core.ts` is a pure module (no
// node deps), so the renderer imports its shape directly, the same way
// `claude-args.ts`'s Boot config does.
export type { Worker, Run, RunStatus, WorkerMode, Effort, NotifyOn } from '../main/scheduler-core'
export type { SchedulerState } from '../main/scheduler-shell'

// Remote push notifications (remote-push spec): channel registry + send/test.
export type {
  PushChannel,
  PushChannelKind,
  PushChannelEvents,
  PushConfig,
  PushEventKind,
  PushSendPayload,
  PushTestResult
} from '../main/push'

/**
 * What the spawned process is. Mirrors `PtyKind` in `src/main/pty.ts`. The
 * renderer never imports from `src/main`, so the type is duplicated here as
 * the wire format — kept narrow and string-literal so the IPC payload is
 * type-checked on both sides.
 */
type PtyKind = 'shell' | 'claude-new' | 'claude-resume' | 'claude-fork'

interface PtyCreateOpts {
  cwd?: string
  cols: number
  rows: number
  /** Default `'shell'` for back-compat. */
  kind?: PtyKind
  /**
   * Required when `kind === 'claude-resume'` or `'claude-fork'`: the session
   * uuid to resume (filename of the JSONL).
   *
   * Optional — and inverted — for `kind === 'claude-new'`, where it is a uuid
   * the RENDERER minted, emitted by main as `--session-id <uuid>` so the new
   * session's transcript lands at a filename the app already knows (T245).
   */
  claudeSessionId?: string
  /**
   * The renderer's logical session key (its `liveTerminals` map key). Lets the
   * main process dedup duplicate spawns for the same session (I1) and survive
   * renderer reloads. Mirrors `sessionKey` in `src/main/pty.ts`.
   */
  sessionKey?: string
  /** Only honored when `kind === 'shell'`. Ignored otherwise. */
  cmd?: string
  /** Only honored when `kind === 'shell'`. Ignored otherwise. */
  args?: string[]
  /**
   * When true, spawn with `CLAUDE_CODE_NO_FLICKER=1` in the env (alt-screen
   * Claude renderer; sidesteps the SIGWINCH scrollback leak — see
   * `findings/04-pty-xterm-production.md` §4). The env var is read by Claude
   * only at spawn time, so this only applies on the next PTY creation.
   */
  noFlicker?: boolean
  /**
   * One-shot per-session launch overrides (New session dialog). Merged on top of
   * the global + per-folder Claude Boot config in the main process. Not persisted.
   */
  bootOverride?: ClaudeBootConfig
  /**
   * `true` for an MCP **agent**-created session. Main then withholds the
   * app-managed `--mcp-config` (no recursive Conductor) and force-downgrades the
   * permission posture (never inherits skip-perms). Mirrors `agentControlled` in
   * `src/main/pty.ts`. Omitted (⇒ `false`) for every user-initiated spawn.
   */
  agentControlled?: boolean
  /**
   * `true` for T245's read-only review companion. Main forces
   * `--permission-mode plan`, hard-denies the file-writing tools, scrubs the
   * permission-bypass escape hatches out of the user's own Claude Boot config,
   * and withholds the app-managed `--mcp-config`. Mirrors `readOnly` in
   * `src/main/pty.ts`. Omitted (⇒ `false`) for every ordinary spawn.
   */
  readOnly?: boolean
  /**
   * T247: what a read-only REVIEW companion is told about the review it was
   * opened beside — base + head commit SHAs, the head's readability state,
   * whether the folder is a repo, and the PR number when there is one. Main
   * composes it into `--append-system-prompt` (never a positional pre-prompt,
   * never a `ptyWrite`) and re-narrows it on arrival. Five scalars wide by
   * design: nothing about the diff's CONTENT can cross this boundary. Mirrors
   * `reviewCorrective` in `src/main/pty.ts`.
   */
  reviewCorrective?: ReviewCorrective
  /**
   * T123/T138: boot mode — main resolves the mode's contract and injects it
   * into the preamble. `string`, not the closed `SessionModeId` union: an id
   * may name a builtin or an installed extension's `contributes.modes` entry
   * (see `SessionModeWire`, below).
   */
  mode?: string
  /**
   * T215 ownership marker: WHO caused this spawn. `'agent'` for an MCP
   * `create_session` synthetic and a board/manifest dispatch; `'operator'` for
   * "+ New session" and for a selection-driven resume. Mirrors `spawnedBy` in
   * `src/main/pty.ts`, which stamps it on the PTY record — `message_session`
   * reads it back and refuses an operator-owned recipient. Omitted ⇒ main
   * treats it as `'operator'` (fail closed).
   */
  spawnedBy?: 'operator' | 'agent'
  /**
   * BUG-70 §4 park ledger: how this session is being woken. Threaded through
   * so an AGENT-driven wake (`message_session` on a parked recipient, T215) is
   * distinguishable from a human's selection in the ledger. Omitted ⇒
   * `'unknown'`.
   */
  wakeGesture?: 'select' | 'restart' | 'notification-click' | 'peer-message' | 'unknown'
}

interface PtyExitEvent {
  exitCode: number
  signal?: number
  /**
   * BUG-70 §3: `'park'` means the process was killed to reclaim memory, not a
   * lifecycle outcome — consumers that treat every exit as "session finished"
   * must gate on this. Absent means `'natural'` (back-compat wire shape).
   */
  reason?: PtyExitReason
}

// Multiplexed PTY IPC payloads — see `findings/05-ipc-streaming-perf.md` §3.
// The main process emits a single `pty:data` / `pty:exit` channel and the
// preload-side dispatcher fans the payloads out to per-PTY callbacks
// registered via `onPtyData(id, …)` / `onPtyExit(id, …)`.
interface PtyDataPayload {
  id: string
  data: string
  /** Cumulative bytes emitted by this PTY after this chunk (for adoption dedup). */
  seq: number
}

interface PtyExitPayload {
  id: string
  exitCode: number
  signal?: number
  reason?: PtyExitReason
}

/** One live PTY as enumerated by `pty:list` (re-adoption on renderer mount). */
export interface LivePty {
  sessionKey: string
  ptyId: string
  kind: PtyKind
  cols: number
  rows: number
}

/** Result of `pty:replay`: the ring-buffer snapshot + its end byte offset. */
export interface PtyReplay {
  data: string
  seq: number
}

// Per-PTY callback sets. We keep a Set rather than a single function so the
// renderer can have multiple observers for the same PTY (e.g. the terminal
// host and a future devtools/stress probe) without trampling each other.
const ptyDataListeners = new Map<string, Set<(data: string, seq: number) => void>>()
const ptyExitListeners = new Map<string, Set<(evt: PtyExitEvent) => void>>()

// Single, lifetime-scoped dispatchers — registered once at preload boot. This
// is the optimization called out in `findings/05` §3.2: it eliminates the
// "N listeners per PTY" pattern of the previous `pty:data:<id>` design.
ipcRenderer.on('pty:data', (_e, payload: PtyDataPayload) => {
  const set = ptyDataListeners.get(payload.id)
  if (!set) return
  for (const cb of set) cb(payload.data, payload.seq)
})

ipcRenderer.on('pty:exit', (_e, payload: PtyExitPayload) => {
  const set = ptyExitListeners.get(payload.id)
  if (!set) return
  const evt: PtyExitEvent = {
    exitCode: payload.exitCode,
    signal: payload.signal,
    reason: payload.reason
  }
  for (const cb of set) cb(evt)
})

// IPC payload shapes for watcher events. Kept inline (rather than importing
// from claude-watcher.ts) so the preload's contract is self-documenting and
// independent of internal watcher refactors. Match the `send()` calls in
// `src/main/claude-watcher.ts` exactly.
interface ProjectAddedEvent {
  slug: string
}
/**
 * `fleet:changed` (sidebar-liveness spec §4.A A3/A4): main's fleet model
 * refreshed and its membership (sessions per folder, git identity) moved.
 * `slugs`/`full` say what the model looked at since the previous push — the
 * renderer reloads on it and uses the coverage to settle migrated rows (D8).
 * Mirrors `FleetChange` in `src/main/fleet-model.ts`.
 */
export interface FleetChangedEvent {
  version: number
  /** Slugs whose refresh produced this change; empty when `full` is true. */
  slugs: string[]
  /** True when a full rescan (boot, ready, degraded poll, Rescan) produced it. */
  full: boolean
}
/**
 * One worktree of a tracked repo, as `worktrees:changed` carries it (T388,
 * sidebar-liveness spec §4.B B2). Mirrors `TrackedWorktree` in
 * `src/main/worktree-tracker.ts`: `path` is already reconciled to a folder path
 * the renderer knows when both name the same directory (D9).
 */
export interface TrackedWorktreeWire {
  path: string
  /** Branch name without `refs/heads/`; empty when detached. */
  branch: string
  isMainWorktree: boolean
  locked: boolean
}
/** `worktrees:changed` push: the full current listing of one tracked repo. */
export interface WorktreesChangedEvent {
  repoId: string
  entries: TrackedWorktreeWire[]
}
/** One repo the renderer asks main to track (`worktrees:track`), mirrors `TrackedRepo`. */
export interface TrackedRepoWire {
  /** Realpath'd git common dir (`GitMeta.repoId`). */
  repoId: string
  /** Any existing folder of the repo, for `git -C`. */
  probePath: string
  /** The repo's folder paths the renderer knows (D9 matching). */
  memberPaths: string[]
}
interface ProjectRemovedEvent {
  slug: string
}
interface SessionAddedEvent {
  slug: string
  sessionId: string
}
interface SessionRemovedEvent {
  slug: string
  sessionId: string
}
/**
 * `claude:session:updated` — fields the watcher DERIVED from the delta; the raw
 * transcript lines never cross IPC (sidebar-liveness C3). Optional fields are
 * present only when the delta determined them; the renderer keeps its prior value
 * otherwise (never a downgrade to `unknown`).
 */
type SessionUpdatedEvent = SessionUpdatePayload
interface IndexUpdatedEvent {
  slug: string
}
interface WatcherDegradedEvent {
  code: DegradedCode
  message: string
}
/** `claude:subagent:updated` — `meta` is read in main, first defined value per field. */
type SubagentUpdatedEvent = SubagentUpdatePayload
// Roadmap Kanban watcher events (T80 S1 §3.2). Match the `send()` calls in
// `src/main/roadmap-watcher.ts`. `repoKey` (the repo's memory dir) rides
// on every event so the store can ignore a late event from a since-closed board.
interface RoadmapCardEvent {
  repoKey: string
  card: RoadmapCard
}
interface RoadmapCardRemovedEvent {
  repoKey: string
  slug: string
}
/**
 * T113: one background manifest-drain progress tick. Mirrors `DrainEvent` in
 * `src/main/manifest-drain.ts` — `active: false` is the terminal tick of a pass.
 */
export interface RoadmapDrainEvent {
  folder: string
  total: number
  dispatched: number
  confirmNeeded: number
  confirmCards: Array<{ slug: string; reason: string }>
  /** BUG-62: how many stamped cards failed to dispatch this pass. */
  failed: number
  /** BUG-62: which cards failed and why — a rolled-back worktree is never silent. */
  failedCards: Array<{ slug: string; reason: string }>
  wipBlocked: number
  active: boolean
}
interface SubagentRemovedEvent {
  slug: string
  parentSessionId: string
  agentId: string
}

/**
 * A Claude Code hook event forwarded by the Hook Bridge (session-state spec
 * §4.1). `event` is the hook name (`Notification`, `Stop`, `StopFailure`, …) and
 * `matcher` is the semantic discriminator (`permission_prompt`/`idle_prompt`,
 * SessionEnd `reason`, …). Mirrors `BridgeEvent` in `src/main/hook-bridge.ts`.
 */
interface HookEvent {
  sessionId: string
  /** The folded task-state (reducer runs in main; the store just applies this). */
  taskState: TaskState
  /** Raw hook name, for debugging/telemetry. */
  event: string
  ts: number
  /** Only present on a StopFailure (taskState 'failed'): classified error_type. */
  failureReason?: FailureReason
  /** Epoch-ms of the rate-limit reset, when the StopFailure body carries it. */
  resetsAt?: number
}

/**
 * BUG-54 (D8): the terminal ledger's last-shutdown record — sessions still
 * `working` at the previous quit. Written in `before-quit`; `null` before the
 * first quit ever recorded one. Mirrors `LastShutdown` in
 * `src/main/terminal-ledger.ts`. T167 will consume this to render an
 * `interrupted` fleet state; this wire only exposes the record.
 */
interface LastShutdownWire {
  at: number
  sessionIds: string[]
}

/**
 * A Claude PID session-registry update (T92 §3), from `~/.claude/sessions/<pid>.json`.
 * `taskState` is the mapped `busy|waiting|idle` (or `null` to CLEAR the override
 * when the file was removed / the process exited). Layered BELOW injected hooks in
 * the fleet classifier — it's the cheap signal for external sessions. Mirrors
 * `SessionRegistryWire` in `src/main/session-registry-watch.ts`.
 */
interface SessionRegistryEvent {
  sessionId: string
  taskState: TaskState | null
  /** When waiting: what it's waiting for (`approve <tool>`, `input needed`, …). */
  waitingFor?: string
  /** Freshness anchor (epoch ms) for the stuck timer. */
  updatedAt?: number
}

/**
 * The bottom-buffer snapshot the renderer pushes to main for screen-mode panes
 * (A2 two-tier state detection). Only folder terminals (`isShellTerminal`) emit
 * these — a hooked Claude pane is never scraped. `lines` are the normalized
 * bottom rows of the xterm grid; `title` is the pane's OSC title (or `null`).
 */
interface ScreenSnapshotWire {
  sessionId: string
  lines: string[]
  title: string | null
}

/**
 * Main's screen-derived dot for a pane (mirrors `ScreenStateMessage` in
 * `src/main/detect/screen-detect.ts`). `taskState: null` means "revert to the
 * legacy activity heuristic" — the recognized agent exited back to a plain shell.
 */
interface ScreenStateWire {
  sessionId: string
  taskState: TaskState | null
}

/**
 * A validated `contributes.themes` entry from an installed extension (T137).
 * Mirrors `ExtensionTheme` in `src/main/extensions/extension-manifest-core.ts` —
 * kept duplicated as the wire format so the renderer doesn't reach into
 * main-process modules. `id` is already namespaced (`ext-<extensionId>-<rawId>`),
 * so the renderer never needs to compute it.
 */
export interface ExtensionThemeWire {
  id: string
  rawId: string
  extensionId: string
  extensionLabel: string
  label: string
  dark: boolean
  tokens: {
    bg: string
    sidebar: string
    surface: string
    surface2: string
    border: string
    border2: string
    text: string
    text2: string
    text3: string
    text4: string
    textDisabled: string
    accent: string
    accentSoft: string
    accentLine: string
    accentInk: string
    green: string
    greenSoft: string
    red: string
    redSoft: string
    warning: string
    /**
     * T291 — badge-token grammar (design.md §2). Optional: an extension
     * manifest predates these four tokens, so absence is the norm, not an
     * error. `deriveOptionalTokens` (extension-themes.ts) alpha-blends them
     * from the theme's declared green/red/warning base when missing.
     */
    greenLine?: string
    redLine?: string
    warningSoft?: string
    warningLine?: string
    ansi: {
      black: string
      red: string
      green: string
      yellow: string
      blue: string
      magenta: string
      cyan: string
      white: string
      brightBlack: string
      brightRed: string
      brightGreen: string
      brightYellow: string
      brightBlue: string
      brightMagenta: string
      brightCyan: string
      brightWhite: string
    }
  }
}

/**
 * The builtin `SESSION_MODES` ∪ every installed extension's `contributes.modes`,
 * merged main-side (T138) — mirrors `extensions-loader.ts`'s `SessionModeWire`,
 * kept duplicated as the wire format so the renderer doesn't reach into
 * main-process modules. `labelKey` is set for builtins (the renderer resolves
 * it via `$t()`); `label` is set for extension modes (a plain, self-localizing
 * string, ADR-0002 §2). `FolderMenu.vue` no longer imports `session-modes.ts`
 * directly — this wire type + `modesList()`/`onModesChanged()` are the only
 * contract.
 */
export interface SessionModeWire {
  id: string
  labelKey?: string
  label?: string
  icon: string
  origin: 'builtin' | 'extension'
  extensionId?: string
  extensionLabel?: string
}

/**
 * Result returned by `window.api.sessionDelete()`. Mirrors `DeleteResult` in
 * `src/main/session-ops.ts`; kept duplicated as the wire format so the
 * renderer doesn't reach into main-process modules.
 *
 * `ok: true` means the file is gone (or was already gone — idempotent).
 * `ok: false` is reserved for hard validation / I/O failures; the renderer
 * surfaces `error` in a toast.
 */
interface SessionDeleteResult {
  ok: boolean
  error?: string
}

/** One transcript turn in a context digest (T38). Mirrors `SessionTurn` in main. */
export interface SessionDigestTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Result of `window.api.sessionDigest()`. Mirrors `DigestResult` in `session-ops.ts`. */
interface SessionDigestResult {
  ok: boolean
  turns?: SessionDigestTurn[]
  error?: string
}

/**
 * Payload returned by every `userProjects:*` IPC. Always `{ projects,
 * hiddenPaths }` so the renderer can refresh both pieces of persisted
 * state from a single round-trip — see the IPC handlers in
 * `src/main/index.ts` that funnel through `toUserProjectsPayload`.
 */
export interface UserProjectsPayload {
  projects: UserProject[]
  hiddenPaths: string[]
}

/**
 * On-disk settings schema (terminal-font-settings spec §5). Mirrors
 * `SettingsData` in `src/main/settings.ts`; duplicated here as the wire format
 * so the renderer store can import it without crossing into main-process code.
 * Keep both definitions in sync — see CLAUDE.md.
 */
export interface SettingsData {
  terminalFontSize: number
  uiZoom: number
}

// ---- Harnu MCP control server wire types (2026-06-25 design) ---------------
// The agent-drives-Harnu surface. Kept inline (the preload's self-documenting
// wire-contract convention) so the renderer never crosses into `src/main/mcp`.
// Mirrors `McpRendererApi` in `stores/command-dispatch.ts` (the renderer half)
// and the channels registered by `command-bridge-ipc.ts` / `confirm-resolver.ts`
// / `worktree-ipc.ts` / `mcp/server.ts`.

/** A correlated command pushed from main's CommandBridge — the renderer routes it and acks `requestId`. */
interface RendererCommandMessage {
  requestId: string
  command: string
  payload: unknown
}
/** `pty:sessionReady` payload: a spawned session's REPL is up (gates agent-prompt injection). */
interface SessionReadyWire {
  sessionKey: string
  ptyId: string
}
/** `folders:adopted` payload: a just-created worktree + its probed git meta (groups under its repo). */
type FolderAdoptedWire = { path: string; select?: boolean } & GitMeta
/** `folders:removed` payload. */
interface FolderRemovedWire {
  path: string
}
/** `markdown:changed` payload: a watched MarkdownPane's backing file changed on disk. */
export interface MarkdownChangedWire {
  path: string
}
/** `canvas:changed` payload: a watched DiagramPane's backing canvas changed on disk. */
export interface CanvasChangedWire {
  path: string
}
/** Live MCP server status for the Settings pane. */
export interface McpServerStatus {
  enabled: boolean
  port: number
  connected?: boolean
  /**
   * T93: whether Harnu auto-registers its MCP server into spawned `claude` sessions
   * (inject `--mcp-config` + `--allowedTools mcp__harnu`). Default ON; independent of
   * `enabled` (injection needs BOTH the server running AND this on).
   */
  autoRegister?: boolean
  /**
   * ADR-0004 / BUG-35 (D3): non-null only when this boot had to fall back to a
   * fresh ephemeral port because the previously-stored one was taken. Sessions
   * spawned before the restart cannot reach the new port and must be resumed.
   */
  portFallbackWarning?: string | null
}
/** One audited MCP tool call (mirrors `AuditRecord` in `mcp/audit-log.ts`). */
export interface McpAuditRecord {
  ts: number
  tool: string
  folder?: string
  verdict: string
  disclosedPayloadSummary?: string
  result?: string
}
/** One active mission grant, redacted for the UI (mirrors `GrantView` in `mcp/grant-registry.ts`). */
export interface McpGrantView {
  id: string
  goal: string
  /** Folder basenames (paths aliased). */
  folders: string[]
  dynamicFolders: string[]
  verbs: string[]
  budget: number
  spent: number
  remaining: number
  /** Epoch ms the grant expires. */
  expiresAt: number
  revoked: boolean
  /** Whether the grant can still auto-allow (not revoked/expired/exhausted). */
  live: boolean
}
/**
 * A held agent action awaiting the operator's Allow/Deny (disclosure payload).
 *
 * Wire reality (type-only mirror — see `mcp/confirm-core.ts` `ConfirmWire`, sent
 * verbatim on `mcp:confirm:pending` by `confirm-resolver.ts`): the gate parks a
 * `{ prompt, permissionMode, nonDefaultFlags, commands }` disclosure and the core
 * stamps the correlation `id` + the auto-deny `deadline` (epoch ms). There is no
 * `tool`/`folder`/`summary`/`flags` field on the wire — `prompt` already carries
 * the human-readable target (e.g. `MCP agent requests "create_session" in <folder>`).
 */
/**
 * One card's row in a `submit_manifest` confirm's checklist (T104 §2.1) —
 * type-only mirror of `mcp/confirm-core.ts`'s `ManifestCardDisclosure`, built
 * server-side from the on-disk card (never agent-supplied text).
 */
export interface McpManifestCardWire {
  slug: string
  title: string
  kind?: string
  complexity?: string
  substrate?: string
  model?: string
  effort?: string
  gaps: string[]
  prompt: string
  bodyHash: string
}

export interface McpConfirmPending {
  /** Correlation id minted by the confirm core; echoed back on respond. */
  id: string
  /** The effective prompt/target disclosed to the operator (verbatim). */
  prompt: string
  /** The resolved permission mode the agent would run under. */
  permissionMode: string
  /** Non-default boot flags being requested (empty array when none). */
  nonDefaultFlags: string[]
  /** Shell commands (sh -c) a create_worktree confirm will run, verbatim (empty when none). */
  commands: string[]
  /**
   * T61: when true, this create_worktree confirm offers agent-control inheritance —
   * the overlay renders an opt-out checkbox (default checked) whose state rides back
   * on `mcpConfirmRespond`'s `inheritWorktreeControl`.
   */
  worktreeInheritOffer?: boolean
  /**
   * T72: when true, this is an inheritance-DISCOVERY confirm — the agent tried to act
   * in a canonical `.claude/worktrees/*` worktree whose parent repo is already
   * allowed. The overlay renders a `'always' | 'once'` scope selector (default
   * `'once'`) whose choice rides back on `mcpConfirmRespond`'s `inheritScope`; the
   * parked Inbox row (no selector) resolves to `'once'` server-side.
   */
  inheritDiscoveryOffer?: boolean
  /**
   * T93: when true, this confirm offers "always allow this verb here" — the surface
   * renders a checkbox whose state rides back on `mcpConfirmRespond`'s `alwaysAllow`.
   * On Allow, the verb's `mcp__harnu__<verb>` rule is written to the folder's
   * `.claude/settings.local.json` so it runs without a confirm there from then on.
   */
  alwaysAllowOffer?: boolean
  /**
   * T93: the initial "always allow" checkbox state — checked for ordinary verbs,
   * unchecked for the dangerous ones (`create_worktree`/`spawn_terminal`). Only
   * meaningful when `alwaysAllowOffer` is true.
   */
  alwaysAllowDefault?: boolean
  /**
   * T104: for a `submit_manifest` confirm, the per-card checklist — the PRIMARY
   * content of this disclosure (not an extra like the checkboxes above). The
   * overlay/row renders one checkbox per entry (default ALL checked); the
   * checked slugs ride back on `mcpConfirmRespond`'s `manifestSelectedSlugs`.
   */
  manifestCards?: McpManifestCardWire[]
  /** T104: the whole-batch cost-estimate note ("no history yet" until T47 lands). */
  manifestCostNote?: string
  /** Epoch ms at which this confirm fails closed (PARK_TTL) if unanswered. */
  deadline: number
  /**
   * Render hint (T44 S4): `modal` → show the fast confirm overlay (window was
   * focused); `parked` → show a row in the Approval Inbox + chime + OS attention
   * (window was not focused).
   */
  mode: 'modal' | 'parked'
}

/**
 * Build a typed `on*` subscription helper for a single watcher channel.
 * Returns an unsubscribe function so callers can clean up in `onUnmounted`
 * (or any other lifecycle hook). Captures the wrapped handler so the same
 * function reference is passed to `ipcRenderer.off`.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api = {
  ptyCreate: (opts: PtyCreateOpts): Promise<string> => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', id, cols, rows),
  ptyDestroy: (id: string): void => {
    ptyDataListeners.delete(id)
    ptyExitListeners.delete(id)
    ipcRenderer.send('pty:destroy', id)
  },
  /**
   * BUG-69: park a session — kill + flag + broadcast `pty:hibernated`, all in
   * one main-side transaction (`hibernateSession`). Replaces the old two-call
   * `ptyDestroy` + `monitorPark` dance, which could flag a session parked
   * without ever disposing its renderer terminal.
   */
  ptyPark: (sessionKey: string): Promise<void> => ipcRenderer.invoke('pty:park', sessionKey),
  ptyPauseFlow: (id: string): void => ipcRenderer.send('pty:flow:pause', id),
  ptyResumeFlow: (id: string): void => ipcRenderer.send('pty:flow:resume', id),
  /**
   * Tell the main process to move a session's pty-index binding from one
   * logical key to another — used when a synthetic session migrates to its
   * real uuid. Keeps the main-side dedup (I1) correct across the migration.
   */
  ptyRekey: (fromKey: string, toKey: string): void => ipcRenderer.send('pty:rekey', fromKey, toKey),
  /**
   * Tell main the operator just selected this session (T119). Feeds the hibernation LRU's
   * focus axis and marks the one session the policy may never park.
   */
  ptyTouchFocus: (sessionKey: string): void => ipcRenderer.send('pty:touchFocus', sessionKey),
  /** Enumerate the live Claude PTYs so the renderer can re-adopt them on mount (I4). */
  ptyListLive: (): Promise<LivePty[]> => ipcRenderer.invoke('pty:list'),
  /** Drain + snapshot a PTY's scrollback ring buffer for re-adoption replay (I4). */
  ptyReplay: (ptyId: string): Promise<PtyReplay> => ipcRenderer.invoke('pty:replay', ptyId),
  /** Snapshot a PTY's scrollback by sessionKey (Fleet status board last-line). */
  ptyReplayForSession: (sessionKey: string): Promise<PtyReplay> =>
    ipcRenderer.invoke('pty:replayForSession', sessionKey),
  onPtyData: (id: string, cb: (data: string, seq: number) => void): (() => void) => {
    let set = ptyDataListeners.get(id)
    if (!set) {
      set = new Set()
      ptyDataListeners.set(id, set)
    }
    set.add(cb)
    return () => {
      const s = ptyDataListeners.get(id)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) ptyDataListeners.delete(id)
    }
  },
  onPtyExit: (id: string, cb: (evt: PtyExitEvent) => void): (() => void) => {
    let set = ptyExitListeners.get(id)
    if (!set) {
      set = new Set()
      ptyExitListeners.set(id, set)
    }
    set.add(cb)
    return () => {
      const s = ptyExitListeners.get(id)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) ptyExitListeners.delete(id)
    }
  },
  /** Toggle the main window's fullscreen state (B-3 — topbar Maximize button). */
  windowToggleFullscreen: (): Promise<void> => ipcRenderer.invoke('window:toggleFullscreen'),
  /**
   * Open a URL in the OS default browser via `shell.openExternal`, bypassing
   * `window.open()` (and thus `setWindowOpenHandler`) entirely. Used by
   * xterm.js WebLinksAddon handlers so clicked terminal links actually open.
   * The main process validates the protocol (http/https/mailto) before
   * calling `shell.openExternal` — never trust this to be pre-validated.
   */
  shellOpenExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  /**
   * Open the native directory picker (Electron's `showOpenDialog` with the
   * `openDirectory` property). Resolves with `{ path: null }` if the user
   * cancels — never throws.
   */
  dialogOpenDirectory: (): Promise<{ path: string | null }> =>
    ipcRenderer.invoke('dialog:openDirectory'),

  // ---- Open in external app (Topbar buttons) -------------------------------
  // `openPath` reveals a folder in the OS file manager (resolves with '' on
  // success, or an error message string). `openInVSCode` spawns the `code` CLI
  // detached; it resolves `{ ok, error? }` and never rejects, so a missing
  // `code` binary degrades gracefully instead of crashing.
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('external:openPath', path),
  // Reveal a file highlighted in the OS file manager (T46 — Pasted-images "Reveal").
  showItemInFolder: (path: string): Promise<string> =>
    ipcRenderer.invoke('external:showItemInFolder', path),
  // T45: pull + pin the folder Harnu was launched with (`harnu .`), if any.
  cliOpenPending: (): Promise<void> => ipcRenderer.invoke('cli:openPending'),
  openInVSCode: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('external:openInVSCode', path),
  // The folder's `origin` as its github.com `/pulls` URL, or `null` when there
  // is no GitHub origin (the Topbar hides its button then). Never rejects.
  githubPullsUrl: (path: string): Promise<string | null> =>
    ipcRenderer.invoke('external:githubPullsUrl', path),

  // ---- Pasted-images gallery -----------------------------------------------
  // Read-only window over ~/.claude/image-cache/<uuid>/. `list` returns the
  // entries (path built in main); `read` returns a base64 data URL for one
  // thumbnail; `copy` writes the PNG to the OS clipboard. Open/Reveal reuse
  // `openPath` / `settingsReveal` above — no new channel for those.
  imageCacheList: (uuid: string): Promise<ImageEntry[]> =>
    ipcRenderer.invoke('imageCache:list', uuid),
  imageCacheRead: (uuid: string, name: string): Promise<string> =>
    ipcRenderer.invoke('imageCache:read', { uuid, name }),
  imageCacheCopy: (uuid: string, name: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('imageCache:copy', { uuid, name }),

  // ---- Claude model + watcher ----------------------------------------------
  /**
   * Folder-first model load (spec 2026-06-11). Kicks off the initial scan of
   * `~/.claude/projects/` and (on the first call) starts the chokidar watcher.
   * Returns the per-cwd `FolderEntry[]` the sidebar consumes synchronously —
   * subsequent diffs flow via the `on*` subscriptions below.
   */
  foldersLoad: (): Promise<FolderEntry[]> => ipcRenderer.invoke('folders:load'),

  /**
   * Manual rescan (BUG-55 spec §3.2): the escape hatch for any watcher gap —
   * a session move the watcher missed, a burst it dropped — without a full
   * app restart. Forces a fresh disk scan and returns it the same shape as
   * {@link foldersLoad}; the caller reconciles it into the store.
   */
  rescan: (): Promise<FolderEntry[]> => ipcRenderer.invoke('claude:rescan'),

  /**
   * Probe additive git metadata (branch / repoId / isMainWorktree) for a batch
   * of folder paths. Powers folder-first repo grouping for pinned placeholder
   * folders (T70A): the store calls it at pin time (to persist the meta onto the
   * `projects.json` record) and on reload (to backfill records saved before
   * pin-time probing existed). Each result is keyed by the INPUT path; a folder
   * outside a repo simply comes back with no git fields.
   */
  probeGit: (paths: string[]): Promise<Array<{ path: string } & GitMeta>> =>
    ipcRenderer.invoke('git:probe', paths),

  /**
   * Create a subfolder `name` inside `parentPath` (recursive mkdir) and return
   * its normalized absolute path (T69 — FolderMenu "New folder…"). Rejects on an
   * invalid name (traversal / absolute), a missing parent, or a file already
   * occupying the target. Idempotent for an existing directory.
   */
  foldersCreateSubfolder: (parentPath: string, name: string): Promise<string> =>
    ipcRenderer.invoke('folders:createSubfolder', { parentPath, name }),
  /**
   * Recursively enumerate the directories under `rootPath` (T69 — FolderMenu
   * "Open subfolder…"): bounded depth, skipping node_modules/.git/vendor/dist/
   * target + dot-dirs, capped at 2000 rows (`truncated` flags the cap).
   */
  foldersListSubfolders: (rootPath: string): Promise<SubfolderScan> =>
    ipcRenderer.invoke('folders:listSubfolders', { rootPath }),
  /**
   * Enumerate the DIRECT child directories of `dirPath` — one level only (T73's
   * lazy "Open subfolder" tree, read a level per chevron-expand). Same ignore
   * list; each row carries `hasChildren` so the picker knows whether to draw an
   * expand chevron. Capped per level (`truncated` flags it).
   */
  foldersListChildFolders: (dirPath: string): Promise<ChildFolderScan> =>
    ipcRenderer.invoke('folders:listChildFolders', { dirPath }),
  /**
   * Explorer tree (Cluster C): lazily list one directory's immediate children
   * (files + folders), CONFINED to `root` and respecting `.gitignore`. `dir`
   * must resolve within `root` or the result carries `error: 'out-of-root'`.
   * Directories sort first, then files, each alpha; capped (`truncated` flags
   * the cap). Read-only — never mutates the filesystem.
   */
  explorerListDir: (root: string, dir: string): Promise<ExplorerListing> =>
    ipcRenderer.invoke('explorer:listDir', { root, dir }),
  /**
   * Explorer search (Cluster F): RECURSIVE, project-wide file finder confined to
   * `root`, respecting `.gitignore` (gitignored + `.git` dirs are pruned during
   * descent — `node_modules` is never walked). `query` is matched case-insensitive
   * against each entry's path relative to `root` (contiguous substring preferred,
   * subsequence as fallback). Files AND dirs match. A query under 2 chars returns
   * `{ entries: [] }`; results are capped (`truncated` flags the cap). Read-only.
   */
  explorerSearch: (root: string, query: string): Promise<ExplorerSearchResult> =>
    ipcRenderer.invoke('explorer:search', { root, query }),
  /**
   * Explorer resolve: turn path tokens read off a terminal line into real
   * entries. A candidate survives only if it EXISTS, is INSIDE `root`, and is
   * NOT gitignored (so a link always matches something the tree can reveal).
   * Relative candidates resolve against `cwd`, a leading `~` against $HOME.
   * Input is capped at 32 candidates. Read-only.
   */
  explorerResolve: (root: string, cwd: string, candidates: string[]): Promise<ResolvedPath[]> =>
    ipcRenderer.invoke('explorer:resolve', { root, cwd, candidates }),
  /**
   * Hover-triggered per-folder git status (T52 Slice 3 — FolderPreview's
   * expensive fields): dirty count + ahead/behind vs upstream. Throttled + cached
   * in main, never throws — a non-repo / no-upstream folder returns `null` fields.
   */
  foldersGitStatus: (folderPath: string): Promise<FolderGitStatus> =>
    ipcRenderer.invoke('folders:gitStatus', { folderPath }),

  // Resolve the absolute path of a dropped `File` (sidebar drag-to-pin).
  // `File.path` was removed in Electron 32+, so the renderer must go through
  // `webUtils.getPathForFile` exposed here.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ---- User-intent folder persistence (U-2.2) ------------------------------
  // The renderer calls `userProjectsList()` alongside `foldersLoad()` at store
  // init and merges the two streams so user-added folders survive across
  // launches even before Claude writes a `sessions-index.json` for them.
  // `userProjectsAdd` is upsert-by-normalized-path (see user-projects.ts),
  // so calling it twice with the same path replaces the existing entry —
  // useful for refreshing the saved worktree snapshot. `userProjectsRemove`
  // is idempotent (no-op when the path is absent).
  userProjectsList: (): Promise<UserProjectsPayload> => ipcRenderer.invoke('userProjects:list'),
  userProjectsAdd: (entry: UserProject): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:add', entry),
  userProjectsRemove: (targetPath: string): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:remove', targetPath),
  /**
   * Mark a folder as hidden from the sidebar by absolute path. The
   * `hiddenPaths` returned in the payload is the new persisted state — the
   * renderer should mirror it directly. Idempotent: hiding a hidden path
   * returns the unchanged list.
   */
  userProjectsHide: (targetPath: string): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:hide', targetPath),
  /** Companion to `userProjectsHide`. Idempotent. */
  userProjectsUnhide: (targetPath: string): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:unhide', targetPath),

  // ---- Helpers (split layout) persistence (F2) -----------------------------
  // Per-worktree helper-pane state lives in `<userData>/helpers.json` (see
  // `src/main/helpers-store.ts`). The renderer hydrates on worktree-switch
  // and pushes the full state on debounced mutations (resize drag, add/
  // remove/promote helper). `helpersRemoveWorktree` is the explicit cascade
  // hook for the user-projects remove flow (F12).
  helpersGet: (args: { worktreePath: string }): Promise<WorktreeHelperState | null> =>
    ipcRenderer.invoke('helpers:get', args),

  helpersSet: (args: { worktreePath: string; state: WorktreeHelperState }): Promise<void> =>
    ipcRenderer.invoke('helpers:set', args),

  helpersRemoveWorktree: (args: { worktreePath: string }): Promise<void> =>
    ipcRenderer.invoke('helpers:removeWorktree', args),

  /**
   * Delete a session's JSONL transcript from disk and, best-effort, remove its
   * entry from the parent project's `sessions-index.json` (if present). The
   * watcher fires `claude:session:removed` once the file is unlinked, which
   * the renderer's existing subscription consumes — no extra plumbing here.
   *
   * Returns `{ ok, error? }`. The `ok: false` path is reserved for hard
   * failures (validation, EACCES, …); already-deleted files return `ok: true`
   * so the operation is idempotent from the caller's perspective.
   */
  sessionDelete: (sessionId: string, fullPath: string): Promise<SessionDeleteResult> =>
    ipcRenderer.invoke('session:delete', { sessionId, fullPath }),
  // T38: read a session's transcript tail (for the "Copy context digest" action).
  sessionDigest: (fullPath: string, turns?: number): Promise<SessionDigestResult> =>
    ipcRenderer.invoke('session:digest', { fullPath, turns }),

  // T74: read a markdown file for the viewer pane, confined to the known Harnu
  // folders. `base` (optional) resolves a relative link from an already-open
  // document against its directory; the FINAL path is re-confined in main.
  markdownRead: (path: string, base?: string): Promise<MarkdownReadResult> =>
    ipcRenderer.invoke('markdown:read', { path, base }),

  // T74 phase 2: write a markdown file for the editor / "New markdown" flow,
  // confined to the SAME known Harnu folders + extension allowlist + size cap as
  // the reader (atomic tmp+rename). Resolves the `{ ok, path, bytes }` envelope
  // (or `{ ok:false, code, error }`); a path outside the roots is refused here.
  markdownWrite: (path: string, content: string): Promise<MarkdownWriteResult> =>
    ipcRenderer.invoke('markdown:write', { path, content }),
  // T171: register/unregister a MarkdownPane's live-reload watch for its backing
  // file. Ref-counted in main (multiple panes on the same path share one watcher).
  markdownWatchStart: (path: string): Promise<void> =>
    ipcRenderer.invoke('markdown:watchStart', { path }),
  markdownWatchStop: (path: string): Promise<void> =>
    ipcRenderer.invoke('markdown:watchStop', { path }),

  // T218 U1: read a `*.capycanvas.json` document, confined to the known Harnu
  // folders. Resolves the validated + label-normalized document, or a
  // `{ ok:false, code, error }` steer — a bad path is REFUSED, never clamped.
  canvasRead: (path: string, base?: string): Promise<CanvasReadResult> =>
    ipcRenderer.invoke('canvas:read', { path, base }),
  // T218 U1: write a canvas document (the pane's explicit Save). Main validates
  // the payload again before any byte lands and writes atomically, so a Save
  // that fails validation writes nothing at all.
  canvasWrite: (path: string, doc: unknown): Promise<CanvasWriteResult> =>
    ipcRenderer.invoke('canvas:write', { path, doc }),
  // T218 U6: externalise pasted/dropped image bytes into the canvas's `assets/`
  // sibling dir and resolve the RELATIVE `assets/<file>` paths to store on the
  // nodes (spec §4.6 — image bytes never enter the canvas file). Runs through
  // the same server-side pipeline `draw_canvas` uses; the destination filename
  // is generated in main, never sent from here.
  canvasAttachAssets: (path: string, images: CanvasAttachInput[]): Promise<CanvasAttachResult> =>
    ipcRenderer.invoke('canvas:attachAssets', { path, images }),
  // T218 U1: register/unregister a DiagramPane's live-reload watch. Ref-counted
  // in main (multiple panes on the same path share one watcher).
  canvasWatchStart: (path: string): Promise<void> =>
    ipcRenderer.invoke('canvas:watchStart', { path }),
  canvasWatchStop: (path: string): Promise<void> =>
    ipcRenderer.invoke('canvas:watchStop', { path }),
  // T87: probe a git folder for a WORKTREE.md creator — resolves the repo root,
  // reports whether a manifest already exists, and returns the deterministic
  // findings (lockfile/.env/node_modules/default branch) that drive the template.
  worktreeMdProbe: (folderPath: string): Promise<WorktreeMdProbeResult> =>
    ipcRenderer.invoke('worktreeMd:probe', { folderPath }),
  // T87: create the manifest PROPOSAL (idempotent — an existing manifest is opened,
  // never overwritten). Writes the heuristic template at the repo root; the human
  // reviews it in the markdown pane and commits. Harnu never executes it.
  worktreeMdCreate: (folderPath: string): Promise<WorktreeMdCreateResult> =>
    ipcRenderer.invoke('worktreeMd:create', { folderPath }),
  // T79 S3: read a repo's project memory (hot/decisions/timeline) for the memory
  // UI, resolved to the repo's shared `.harnu/memory/` and confined to the known
  // Harnu folders. Reads never scaffold — an absent memory returns `exists:false`.
  memoryRead: (folder: string): Promise<MemoryReadResult> =>
    ipcRenderer.invoke('memory:read', { folder }),
  // T89: configurable memory location. The GLOBAL default (Settings → Memory):
  memoryLocationGetGlobal: (): Promise<MemoryLocationConfig> =>
    ipcRenderer.invoke('memoryLocation:getGlobal'),
  memoryLocationSetGlobal: (config: MemoryLocationConfig): Promise<SetGlobalResult> =>
    ipcRenderer.invoke('memoryLocation:setGlobal', { config }),
  // The PER-PROJECT override (folder menu → "Store this project's memory in…").
  // `getForFolder` returns the effective config + resolved dir + whether memory
  // exists there (drives the "move now" offer). `setOverride(null)` clears it.
  memoryLocationGetForFolder: (folder: string): Promise<FolderMemoryLocationResult> =>
    ipcRenderer.invoke('memoryLocation:getForFolder', { folder }),
  memoryLocationSetOverride: (
    folder: string,
    override: MemoryLocationConfig | null
  ): Promise<SetOverrideResult> =>
    ipcRenderer.invoke('memoryLocation:setOverride', { folder, override }),
  // Assisted migration: move one repo's memory (`from` → `to`), or every known
  // repo's memory when the global default flips (skips repos with an override).
  memoryLocationMigrateFolder: (
    folder: string,
    from: MemoryLocationConfig,
    to: MemoryLocationConfig
  ): Promise<MigrateFolderResult> =>
    ipcRenderer.invoke('memoryLocation:migrateFolder', { folder, from, to }),
  memoryLocationMigrateKnown: (
    from: MemoryLocationConfig,
    to: MemoryLocationConfig
  ): Promise<MigrateKnownResult> => ipcRenderer.invoke('memoryLocation:migrateKnown', { from, to }),
  // ---- Roadmap Kanban board (T80 S1) ---------------------------------------
  // Open (or re-open) the per-repo board: resolves the folder to the checkout
  // that owns `.harnu/memory/roadmap/`, (re)targets the watcher there, and returns
  // the initial parsed-card scan. Live diffs then flow via `onRoadmapCard*` below.
  roadmapLoad: (folder: string): Promise<RoadmapLoadResult> =>
    ipcRenderer.invoke('roadmap:load', { folder }),
  // T212 — read-only board summary (per-column counts + the in-progress/review
  // cards) for the Folder View. Unlike `roadmapLoad`, this NEVER re-targets the
  // roadmap watcher, so peeking at one folder cannot break another folder's
  // open board.
  // T284 — pass `branch` to ALSO get `owned`: the card whose `executedIn` is
  // that branch ("what is this branch FOR"), searched across all five columns.
  // Omit it and the result is exactly the pre-T284 `{ counts, active }` shape.
  roadmapPeek: (folder: string, branch?: string): Promise<RoadmapPeekResult> =>
    ipcRenderer.invoke('roadmap:peek', {
      folder,
      ...(branch === undefined ? {} : { branch })
    }),
  // Move a card between columns (drag / Close). The ONLY status writer — human
  // IPC only, validated enum (T80 §0/§6.4). Returns `{ ok }` or a write-code.
  roadmapSetStatus: (args: {
    folder: string
    slug: string
    status: CardStatus
  }): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:setStatus', args),
  // Bind a dispatched session to a card + flip it to in-progress (§3.3 step 5).
  // T97: `dispatchedWith` ("model·effort") is appended as an audit body line
  // when present — see `roadmap-ipc.ts#roadmap:bindSession`.
  roadmapBindSession: (args: {
    folder: string
    slug: string
    sessionId: string
    dispatchedWith?: string
    /** T102: the resolved substrate this dispatch actually ran on — written onto the card. */
    substrate?: string
    /** T190: the spawn folder's short branch name — the card's durable OWNER. */
    executedIn?: string
  }): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:bindSession', args),
  // S2 (card-detail edit engine): replace a card's BODY only, frontmatter
  // untouched. `stampVoided` reports whether the card carried a manifest
  // `approved` stamp BEFORE this write, for the "manifest ✓ was invalidated"
  // toast — the write itself never blocks on it.
  roadmapReplaceBody: (args: {
    folder: string
    slug: string
    body: string
  }): Promise<{ ok: true; stampVoided: boolean } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:replaceBody', args),
  // T130 S4 (E7): the human counterpart to `update_card.appendBody` — a
  // provenance-stamped body append (`author: 'human'`). The card-detail
  // modal's Open-questions Send composes the `> answers: …` anchor via
  // `buildAnswerAppend` before calling this — a general append door, not
  // question-specific.
  roadmapAppendBody: (args: {
    folder: string
    slug: string
    entry: string
  }): Promise<{ ok: true; stampVoided: boolean } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:appendBody', args),
  // S2: the title inline-edit affordance — writes `title` through the same
  // serialized frontmatter writer as every other controlled field.
  roadmapSetTitle: (args: {
    folder: string
    slug: string
    title: string
  }): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:setTitle', args),
  // Generate the dispatch boot prompt SERVER-SIDE from the on-disk card
  // (secret-linted + capped), returned verbatim for the operator's confirm
  // (§6.3/§6.4). `labels` carry the localized framing/closure so assembly stays
  // i18n-agnostic; `provenanceAuthor` lets the UI flag agent-authored cards.
  roadmapBootPrompt: (args: {
    folder: string
    slug: string
    labels: BootPromptLabels
  }): Promise<
    | { ok: true; prompt: string; provenanceAuthor: CardProvenance['author'] }
    | { ok: false; code: RoadmapWriteCode }
  > => ipcRenderer.invoke('roadmap:bootPrompt', args),
  // T80 S2: decide auto-under-grant vs human confirm for a dispatch, reserving a
  // grant budget unit server-side on the auto path (§3.4). The renderer spawns +
  // binds; on spawn failure it must call `roadmapReleaseDispatch` to refund.
  roadmapPlanDispatch: (args: {
    folder: string
    slug: string
    labels: BootPromptLabels
  }): Promise<RoadmapDispatchPlan> => ipcRenderer.invoke('roadmap:planDispatch', args),
  // T130 S4 (M8-Generate, E8): the SAME auto-vs-confirm gate as planDispatch —
  // "no new free path" — building the 3-tier GENERATOR prompt for the
  // requested artifact instead of the card's own boot prompt.
  roadmapPlanGenerate: (args: {
    folder: string
    slug: string
    artifact: ArtifactKey
    labels: GeneratorPromptLabels
  }): Promise<RoadmapDispatchPlan> => ipcRenderer.invoke('roadmap:planGenerate', args),
  // Refund a grant unit reserved by planDispatch when the spawn failed (§3.4).
  roadmapReleaseDispatch: (grantId: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('roadmap:releaseDispatch', { grantId }),
  // Resolve the id of a live grant that currently covers auto-dispatch for the
  // board folder (or null) — drives the board's grant strip (§3.4).
  roadmapGrantStatus: (folder: string): Promise<{ grantId: string | null }> =>
    ipcRenderer.invoke('roadmap:grantStatus', { folder }),
  // T80 S3: merge-evidence for a bound card's branch (commits ahead of origin/main
  // + refs) — read-only git probe driving the "suggest Review" reconciliation.
  roadmapMergeEvidence: (args: {
    folder: string
    branch?: string
  }): Promise<RoadmapMergeEvidence> => ipcRenderer.invoke('roadmap:mergeEvidence', args),
  // T80 S3: the human-approved move of a bound In Progress card to Review, with
  // evidence attached. Lands in Review, never Done (§3.5 rule of gold).
  roadmapMoveToReview: (args: {
    folder: string
    slug: string
    evidence?: string[]
  }): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:moveToReview', args),
  // T103: the human Close (Review → Done) — writes `status: done` and appends a
  // mechanical, dated close entry to the card (+ `decisions.md` when the card is
  // an epic with children). `epic` tells the renderer which memory pages changed.
  roadmapCloseCard: (args: {
    folder: string
    slug: string
  }): Promise<{ ok: true; epic: boolean } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:closeCard', args),
  // T148: archive a card — moves it out of the active board into
  // `roadmap-archive/`, reversible via `roadmapRestoreCard` below.
  roadmapArchiveCard: (args: {
    folder: string
    slug: string
  }): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:archiveCard', args),
  // T148: undo for `roadmapArchiveCard`. Returns the restored card so the
  // caller can upsert it back into the local set without waiting on the watcher.
  roadmapRestoreCard: (args: {
    folder: string
    slug: string
  }): Promise<{ ok: true; card: RoadmapCard } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:restoreCard', args),
  // T148: permanently delete a card file. Irreversible — the caller confirms
  // with the operator before invoking this.
  roadmapDeleteCard: (args: {
    folder: string
    slug: string
  }): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> =>
    ipcRenderer.invoke('roadmap:deleteCard', args),
  // T80 S2 PR3: the board's `+ New card` (M14/B8/E5) — reuses the SAME id-mint/
  // slug/template engine as the agent's `create_card`, stamping `provenance.author:
  // 'human'`. Returns the freshly parsed card so the caller can open its detail
  // modal immediately, without waiting on the watcher's own `card:added` event.
  roadmapCreateCard: (args: {
    folder: string
    title: string
    kind: string
    complexity: string
    body: string
  }): Promise<
    { ok: true; slug: string; card: RoadmapCard } | { ok: false; code: RoadmapWriteCode }
  > => ipcRenderer.invoke('roadmap:createCard', args),
  // T80 S2 PR3: the per-kind delegation-packet templates (T105 §3, `resources/
  // board-templates/<kind>.md`) — fetched once by the create-mode modal so
  // switching the Kind picker reseeds the body textarea client-side.
  roadmapCardTemplates: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('roadmap:cardTemplates'),
  // T130 S3 (E6): convention-scan for a card's prd/adr (docs/prds/<id>-*.md /
  // docs/adr/<id>-*.md) — display-only hint for the modal's Docs row; never
  // writes anything, only the explicit `prd:`/`adr:` field is durable.
  roadmapScanArtifacts: (args: {
    folder: string
    id: string
  }): Promise<{ prd: string | null; adr: string | null }> =>
    ipcRenderer.invoke('roadmap:scanArtifacts', args),
  // ---- Model routing policy (T97) ------------------------------------------
  // Human-owned per-folder routing table (card kind → model+effort). NEVER
  // exposed to an MCP verb — the only callers are the folder-settings editor
  // and the dispatch resolution the board calls before spawning (§ security
  // posture in `routing-policy.ts`).
  routingPolicyGetFolder: (folderPath: string): Promise<RoutingTable> =>
    ipcRenderer.invoke('routingPolicy:getFolder', folderPath),
  routingPolicySetFolder: (folderPath: string, table: RoutingTable): Promise<RoutingTable> =>
    ipcRenderer.invoke('routingPolicy:setFolder', folderPath, table),
  routingPolicyResolve: (args: { folder: string; kind?: string }): Promise<ResolvedRouting> =>
    ipcRenderer.invoke('routingPolicy:resolve', args),
  onRoadmapCardAdded: (cb: (payload: RoadmapCardEvent) => void): (() => void) =>
    subscribe('roadmap:card:added', cb),
  onRoadmapCardChanged: (cb: (payload: RoadmapCardEvent) => void): (() => void) =>
    subscribe('roadmap:card:changed', cb),
  onRoadmapCardRemoved: (cb: (payload: RoadmapCardRemovedEvent) => void): (() => void) =>
    subscribe('roadmap:card:removed', cb),
  // T113: background manifest-drain progress (main-driven). The board renders
  // the batch strip from these; an app-level listener toasts the confirm-needed
  // summary even with the board closed.
  onRoadmapDrainEvent: (cb: (payload: RoadmapDrainEvent) => void): (() => void) =>
    subscribe('roadmap:drainEvent', cb),

  /**
   * Main parked a cold session to reclaim memory (T119). Drop its xterm — the sidebar row
   * stays, and clicking it respawns via the normal `claude-resume` path.
   */
  onPtyHibernated: (cb: (payload: { sessionKey: string }) => void): (() => void) =>
    subscribe('pty:hibernated', cb),
  onProjectAdded: (cb: (payload: ProjectAddedEvent) => void): (() => void) =>
    subscribe('claude:project:added', cb),
  onFleetChanged: (cb: (payload: FleetChangedEvent) => void): (() => void) =>
    subscribe('fleet:changed', cb),
  /**
   * Replace the set of repos whose git worktrees main keeps listed (T388). Pass
   * the set ordered by priority (pinned, then active): main tracks the first 64.
   */
  worktreesTrack: (repos: TrackedRepoWire[]): Promise<void> =>
    ipcRenderer.invoke('worktrees:track', repos),
  /** A tracked repo's worktree listing changed (T388): `entries` is the full list. */
  onWorktreesChanged: (cb: (payload: WorktreesChangedEvent) => void): (() => void) =>
    subscribe('worktrees:changed', cb),
  onProjectRemoved: (cb: (payload: ProjectRemovedEvent) => void): (() => void) =>
    subscribe('claude:project:removed', cb),
  onSessionAdded: (cb: (payload: SessionAddedEvent) => void): (() => void) =>
    subscribe('claude:session:added', cb),
  onSessionRemoved: (cb: (payload: SessionRemovedEvent) => void): (() => void) =>
    subscribe('claude:session:removed', cb),
  onSessionUpdated: (cb: (payload: SessionUpdatedEvent) => void): (() => void) =>
    subscribe('claude:session:updated', cb),
  onIndexUpdated: (cb: (payload: IndexUpdatedEvent) => void): (() => void) =>
    subscribe('claude:index:updated', cb),
  onWatcherDegraded: (cb: (payload: WatcherDegradedEvent) => void): (() => void) =>
    subscribe('claude:watcher:degraded', cb),

  /**
   * Subscribe to nested parallel-agent (subagent) appends (issue #9). Fires
   * when a `<slug>/<parentSessionId>/subagents/agent-*.jsonl` is created or
   * grows; the renderer nests the agent under its parent session and flips its
   * running/done status from these events. `onSubagentRemoved` is the rare
   * teardown companion.
   */
  onSubagentUpdated: (cb: (payload: SubagentUpdatedEvent) => void): (() => void) =>
    subscribe('claude:subagent:updated', cb),
  onSubagentRemoved: (cb: (payload: SubagentRemovedEvent) => void): (() => void) =>
    subscribe('claude:subagent:removed', cb),

  /**
   * Subscribe to action IDs emitted by the application menu (see
   * `src/main/menu.ts`). The handler receives the canonical action ID
   * string (e.g. `'session.new'`, `'folder.add'`) and is responsible for
   * dispatching the renderer-side work — typically through the
   * `useShortcuts` composable in T-4.2.
   *
   * Returns an unsubscribe function so callers can clean up in
   * `onUnmounted` / `onScopeDispose`. Multiple subscribers are supported;
   * each receives every event.
   */
  onShortcut: (cb: (actionId: string) => void): (() => void) => {
    const handler = (_e: unknown, actionId: string): void => cb(actionId)
    ipcRenderer.on('shortcut:fired', handler)
    return () => ipcRenderer.off('shortcut:fired', handler)
  },

  // ---- electron-updater event bridge ---------------------------------------
  // Wraps the five lifecycle channels emitted by `src/main/updater.ts`. The
  // payload shapes come from electron-updater (`UpdateInfo`, `ProgressInfo`)
  // but we keep them as `unknown` here to avoid leaking the electron-updater
  // type graph into the preload bundle (it is a main-process-only dep). The
  // renderer can refine the shape at the call site if it wants typed access.
  onUpdateAvailable: (cb: (info: unknown) => void): (() => void) =>
    subscribe('updater:available', cb),
  onUpdateNone: (cb: () => void): (() => void) => subscribe<void>('updater:none', cb),
  onUpdateProgress: (cb: (p: unknown) => void): (() => void) => subscribe('updater:progress', cb),
  onUpdateDownloaded: (cb: (info: unknown) => void): (() => void) =>
    subscribe('updater:downloaded', cb),
  onUpdateError: (cb: (e: { message: string }) => void): (() => void) =>
    subscribe('updater:error', cb),
  onUpdateManualAvailable: (
    cb: (e: { version: string; releaseUrl: string }) => void
  ): (() => void) => subscribe('updater:manualAvailable', cb),

  /**
   * Trigger `autoUpdater.quitAndInstall()` in the main process. Wired to the
   * "Restart now" action of the update-ready toast (see `App.vue`). The
   * promise resolves as Electron begins its quit sequence — callers should
   * not expect normal settlement because the process is exiting.
   *
   * Safe to call in dev: the main-side handler is registered unconditionally,
   * but `autoUpdater.quitAndInstall()` is a no-op without a staged update,
   * so a stray invocation simply quits the app without restarting.
   */
  updaterInstallAndRestart: (): Promise<void> => ipcRenderer.invoke('updater:install'),

  // ---- Settings (terminal font size, JSON-on-disk) -------------------------
  // The renderer store (`stores/settings.ts`) owns the location pointer in
  // localStorage and threads it through every call. Main owns the file + the
  // chokidar watch; `onSettingsChanged` streams external edits back.
  /** OS-default settings.json path — `<userData>/settings.json`. */
  settingsDefaultPath: (): Promise<string> => ipcRenderer.invoke('settings:defaultPath'),
  /** Create-if-missing, read+parse, and (re)start the watch on `path`. */
  settingsLoad: (path: string): Promise<{ path: string; data: SettingsData }> =>
    ipcRenderer.invoke('settings:load', { path }),
  /** Read-modify-write merge of `data` into the file at `path`. */
  settingsSave: (path: string, data: Partial<SettingsData>): Promise<void> =>
    ipcRenderer.invoke('settings:save', { path, data }),
  /** Native folder picker; relocates settings.json into the chosen dir. */
  settingsChangeLocation: (data: SettingsData): Promise<{ path: string } | null> =>
    ipcRenderer.invoke('settings:changeLocation', { data }),
  /** Reveal the settings.json in the OS file manager. */
  settingsReveal: (path: string): Promise<void> => ipcRenderer.invoke('settings:reveal', { path }),
  /** Open settings.json in the OS default editor (the "Edit raw JSON" action). */
  settingsOpenExternal: (path: string): Promise<void> =>
    ipcRenderer.invoke('settings:openExternal', { path }),
  /**
   * T54: apply the whole-UI zoom to this frame. `webFrame.setZoomFactor` scales
   * everything uniformly — px typography, lucide icons (`:size` in px), layout,
   * and the xterm canvas — which is exactly "zoom the UI". Runs in the preload
   * (the renderer is sandbox-isolated and can't import `electron`). The store
   * owns persistence to settings.json; this only touches the live frame.
   */
  uiZoomApply: (factor: number): void => {
    webFrame.setZoomFactor(factor)
  },
  /**
   * Subscribe to external edits of the active settings.json. Fires with
   * `{ data }` on a valid reload, or `{ error: true }` when the file became
   * invalid JSON (renderer keeps last-good + toasts).
   */
  onSettingsChanged: (cb: (p: { data?: SettingsData; error?: boolean }) => void): (() => void) =>
    subscribe('settings:changed', cb),

  // ---- Plan usage (claude -p "/usage" poller) ------------------------------
  // Main spawns the official client and parses its panel; the renderer store
  // (`stores/usage.ts`) calls `usageGet()` at init and subscribes to pushes.
  usageGet: (): Promise<UsageSnapshot> => ipcRenderer.invoke('usage:get'),
  usageRefresh: (): Promise<UsageSnapshot> => ipcRenderer.invoke('usage:refresh'),
  onUsageUpdated: (cb: (snapshot: UsageSnapshot) => void): (() => void) =>
    subscribe('usage:updated', cb),

  // ---- statusLine telemetry (statusline-telemetry spec) ---------------------
  // Per-session cost/context/rate-limit telemetry tailed from the statusLine
  // inbox. `telemetryGet` seeds the store; `onTelemetryUpdated` streams pushes;
  // the status pair backs the Settings opt-out toggle.
  telemetryGet: (): Promise<TelemetryPayload> => ipcRenderer.invoke('telemetry:get'),
  onTelemetryUpdated: (cb: (payload: TelemetryPayload) => void): (() => void) =>
    subscribe('telemetry:updated', cb),
  statuslineStatus: (): Promise<{ enabled: boolean; foreignPreserved: boolean }> =>
    ipcRenderer.invoke('statusline:status'),
  statuslineSetEnabled: (enabled: boolean): Promise<{ enabled: boolean }> =>
    ipcRenderer.invoke('statusline:setEnabled', enabled),

  // ---- Usage history + BI (issue #19) ---------------------------------------
  // Main persists the per-turn telemetry to JSONL and serves rollups + a
  // deterministic plan-fit projection + an on-demand chat over the aggregates.
  // The Settings → Usage history tab calls `summary()` on open, `planFit()` for
  // the calculator, `chat()` on demand, and `getPrefs`/`setPrefs` for config.
  usageHistorySummary: (): Promise<UsageHistorySummary> =>
    ipcRenderer.invoke('usageHistory:summary'),
  usageHistoryGetPrefs: (): Promise<UsageHistoryPrefs> =>
    ipcRenderer.invoke('usageHistory:getPrefs'),
  /** Start-of-day 7d baseline for the daily-budget row (cheap; 3 sample files). */
  usageHistoryDailyBudget: (): Promise<DailyBudgetBaseline> =>
    ipcRenderer.invoke('usageHistory:dailyBudget'),
  usageHistorySetPrefs: (patch: Partial<UsageHistoryPrefs>): Promise<UsageHistoryPrefs> =>
    ipcRenderer.invoke('usageHistory:setPrefs', patch),
  usageHistoryPlanFit: (args: {
    fromTier: string
    toTier: string
    ratioOverride?: number
    /** Recency scope in days; absent/null = all-time. */
    sinceDays?: number | null
  }): Promise<PlanFitResult> => ipcRenderer.invoke('usageHistory:planFit', args),
  usageHistoryRecommend: (args: {
    fromTier: string
    sinceDays?: number | null
  }): Promise<TierRecommendation | null> => ipcRenderer.invoke('usageHistory:recommend', args),
  usageHistoryChat: (args: { question: string }): Promise<{ ok: boolean; answer?: string }> =>
    ipcRenderer.invoke('usageHistory:chat', args),

  // ---- Real cost engine (T47 P5) ---------------------------------------------
  // Scans ~/.claude/projects/**/*.jsonl (dedupe + price per request, incremental
  // per-file cache) and returns real daily/model/project/session spend. The
  // Settings → Usage history tab calls this once on open to upgrade the
  // notional Cost/day chart to REAL spend when engine data exists.
  usageCostSummary: (): Promise<UsageCostSummary> => ipcRenderer.invoke('usageCost:summary'),

  // ---- Usage BI dashboard snapshot (T47 P6 S1) ------------------------------
  // One call joins the P5/P6 cost+anatomy engine, usage-history rollups/
  // windows/heatmap, and live fleet telemetry into the full dashboard payload
  // for a given range. Fail-safe: any missing source degrades to null/[]
  // inside the snapshot rather than rejecting.
  usageBiSnapshot: (args: { range: UsageBiRange }): Promise<UsageBiSnapshot> =>
    ipcRenderer.invoke('usageBi:snapshot', args),

  // ---- Haiku service (cheap-AI substrate) -----------------------------------
  // Auto-name a synthetic session from its first prompt. Main runs Haiku under
  // --model haiku, neutral cwd, single-flight by sessionId, content-hash cached.
  // Resolves { ok, title?, summary? }; never throws (ok:false on any failure).
  haikuAutoname: (args: {
    sessionId: string
    firstUserText: string
  }): Promise<{ ok: boolean; title?: string; summary?: string }> =>
    ipcRenderer.invoke('haiku:autoname', args),

  /**
   * Set the OS dock/taskbar attention badge to `count` needs-input sessions.
   * Fire-and-forget; main picks the per-OS path (setBadgeCount on macOS/Linux,
   * setOverlayIcon on Windows) and no-ops gracefully where unsupported. `0` clears it.
   */
  setAttentionBadge: (count: number): void => ipcRenderer.send('badge:set', count),
  // T44 S4: flash the taskbar / bounce the dock (parked confirm while unfocused).
  requestAttention: (): void => ipcRenderer.send('window:requestAttention'),

  // ---- Hook Bridge (real per-session task-state) ----------------------------
  // `onHook` streams Claude Code hook events; the store folds them into each
  // session's `taskState` (working / needs-input / idle / failed / …). The
  // status pair lets a settings toggle opt out of the global-config hooks.
  onHook: (cb: (ev: HookEvent) => void): (() => void) => subscribe('claude:hook', cb),
  // Pull main's current folded hook state for a uuid (T13/BUG-1 half a): called at
  // synthetic→real migration to resync the state whose early hooks were dropped.
  hooksStateFor: (sessionId: string): Promise<TaskState | null> =>
    ipcRenderer.invoke('hooks:stateFor', sessionId),
  hooksStatus: (): Promise<{ enabled: boolean; injectPerSession: boolean; port: number }> =>
    ipcRenderer.invoke('hooks:status'),
  hooksSetEnabled: (enabled: boolean): Promise<{ enabled: boolean }> =>
    ipcRenderer.invoke('hooks:setEnabled', enabled),
  // T92: opt out of the per-session `--settings` hook injection (independent of the
  // global install toggle above). Default ON; the next spawn honors the change.
  hooksSetInjectEnabled: (enabled: boolean): Promise<{ injectPerSession: boolean }> =>
    ipcRenderer.invoke('hooks:setInjectEnabled', enabled),
  // T92: PID session-registry updates (`~/.claude/sessions/`), a cheap fleet signal
  // for external sessions. The store applies it BELOW hook `taskState`.
  onSessionRegistry: (cb: (ev: SessionRegistryEvent) => void): (() => void) =>
    subscribe('claude:sessionRegistry', cb),
  // BUG-64 C: push the renderer's own "this session's pre-prompt was never
  // delivered" verdict to main, so `get_session`/`get_fleet` stop reporting a
  // stuck session as `active` (`sessions.ts`'s `markPromptUndelivered`).
  // `clearPromptUndelivered` mirrors the renderer's own recovery path
  // (`retryPromptInjection`). Fire-and-forget, same shape as `paneScreenSnapshot`.
  reportPromptUndelivered: (sessionId: string): void =>
    ipcRenderer.send('injection:markUndelivered', sessionId),
  clearPromptUndelivered: (sessionId: string): void =>
    ipcRenderer.send('injection:clearUndelivered', sessionId),

  // ---- Screen detection (A2 two-tier state) ---------------------------------
  // The renderer pushes a debounced bottom-buffer snapshot per screen-mode pane;
  // main matches it against agent manifests and streams back the resolved dot via
  // `onScreenState`. `paneScreenDetach` drops a closed pane's detector memory.
  paneScreenSnapshot: (snapshot: ScreenSnapshotWire): void =>
    ipcRenderer.send('pane:screen-snapshot', snapshot),
  paneScreenDetach: (sessionId: string): void =>
    ipcRenderer.send('pane:screen-detach', { sessionId }),
  onScreenState: (cb: (s: ScreenStateWire) => void): (() => void) => subscribe('screen:state', cb),
  /**
   * Report the live folder terminals (A2 W6.2) so the MCP fleet can disclose them
   * cross-agent. Sent on change; main replaces its set wholesale. Only
   * id/folder/timestamp — never transcript or last line.
   */
  fleetReportShellSessions: (
    list: { sessionId: string; folderPath: string; modified: string }[]
  ): void => ipcRenderer.send('fleet:shell-sessions', list),

  // ---- Extension SDK Phase 1 (T137) -----------------------------------------
  // `contributes.themes` from `~/.claude/capy-extensions/<id>/manifest.json`.
  // `extensionsListThemes` is a pull (called on init and on every
  // `onExtensionsThemesChanged`); `contributes.boardTemplates` needs no wire
  // surface at all — `loadBoardTemplate` (main-side) reads it on demand.
  extensionsListThemes: (): Promise<ExtensionThemeWire[]> =>
    ipcRenderer.invoke('extensions:listThemes'),
  onExtensionsThemesChanged: (cb: () => void): (() => void) =>
    subscribe('extensions:themes-changed', cb),

  // ---- Extension SDK Phase 2 (T138) -----------------------------------------
  // `contributes.modes` merged with the builtin registry — the renderer's
  // `Modes ▸` submenu source of truth. `modesList` is a pull (called on init
  // and on every `onModesChanged`, mirroring the themes pair above).
  modesList: (): Promise<SessionModeWire[]> => ipcRenderer.invoke('modes:list'),
  onModesChanged: (cb: () => void): (() => void) => subscribe('modes:changed', cb),

  // ---- Hook responder dispatch (hook-responder-dispatch spec §4.6) ----------
  // The interceptor mode (off/shadow/active). Default 'shadow'. Inert when the
  // hooks themselves are off (nothing is installed to hold requests).
  responderStatus: (): Promise<{ mode: ResponderMode; trustAll: boolean; hooksEnabled: boolean }> =>
    ipcRenderer.invoke('responder:status'),
  responderSetMode: (mode: ResponderMode): Promise<{ mode: ResponderMode }> =>
    ipcRenderer.invoke('responder:setMode', mode),
  // T30: the "Trust all folders" fleet-active escape hatch for the trust ramp.
  responderSetTrustAll: (enabled: boolean): Promise<{ trustAll: boolean }> =>
    ipcRenderer.invoke('responder:setTrustAll', enabled),
  // Shadow-decision ring (consumed by the Approval Inbox shadow-log view, T30).
  responderGetShadowLog: (): Promise<ShadowEntry[]> => ipcRenderer.invoke('responder:getShadowLog'),

  // ---- Approval Inbox (approval-inbox spec §4.3) ----------------------------
  // Stream: a new approval was parked by the resolver (active mode only).
  onApprovalPending: (cb: (a: PendingApprovalWire) => void): (() => void) =>
    subscribe('hook:approval:pending', cb),
  // Stream: a parked approval left the queue (decided, timed out, or superseded).
  onApprovalResolved: (
    cb: (p: { requestId: string; reason: ApprovalResolvedReason }) => void
  ): (() => void) => subscribe('hook:approval:resolved', cb),
  // Resolve a parked approval with a decision. { ok: false } = already settled.
  hookRespond: (requestId: string, decision: 'allow' | 'deny'): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('hook:respond', { requestId, decision }),
  // Snapshot of live parked approvals (re-hydrates the queue on renderer reload).
  approvalsList: (): Promise<PendingApprovalWire[]> => ipcRenderer.invoke('hook:approvals:list'),

  // ---- OS notifications (os-notifications spec §6) --------------------------
  // The store decides whether/what to notify (`session-notify.ts`) and fires
  // `notify`; main renders the native toast. A clicked toast comes back as
  // `notify:activate` so the store can select that session.
  notify: (payload: NotifyPayload): void => ipcRenderer.send('notify:show', payload),
  onNotifyActivate: (cb: (p: { sessionId: string }) => void): (() => void) =>
    subscribe('notify:activate', cb),
  // T44 S4: an inbox-activate notification (parked MCP confirm) was clicked.
  onNotifyActivateInbox: (cb: () => void): (() => void) => subscribe('notify:activate-inbox', cb),

  // ---- Voice engine (T237) --------------------------------------------------
  // The renderer owns the speech engine (queue, mute, focus gate, state) — the
  // one thing it cannot do is start a process, so the system-command backend
  // speaks through here. `speechSay` resolves when the TTS process EXITS, which
  // is what lets the renderer queue serialise on real completion; `speechCancel`
  // kills an in-flight utterance when the engine is stopped or muted.
  speechSay: (req: SpeechSayRequest): Promise<SpeechSayResult> =>
    ipcRenderer.invoke('speech:say', req),
  speechCancel: (id: string): void => ipcRenderer.send('speech:cancel', id),
  // The TTS command lives in main, NOT in the renderer's prefs blob: a
  // `speech:say` must never be able to name the executable it spawns. Reading
  // and changing it is this explicit door instead.
  speechCommandGet: (): Promise<string> => ipcRenderer.invoke('speech:commandGet'),
  speechCommandSet: (command: string): Promise<string> =>
    ipcRenderer.invoke('speech:commandSet', command),
  // T238: the agent-speech gate behind the `speak` MCP verb — a global default
  // plus per-folder overrides, resolved `folder ?? global ?? false`. Also main-
  // owned, because the verb's handler must decide BEFORE any renderer round-trip.
  // `speechAgentPrefsSet` with a `folder` writes that folder's override (`null`
  // clears it, returning the folder to inheritance); WITHOUT a folder it flips the
  // global — which never writes a per-folder value, so explicit mutes survive it.
  speechAgentPrefsGet: (): Promise<AgentSpeechPrefs> => ipcRenderer.invoke('speech:agentPrefsGet'),
  speechAgentPrefsSet: (patch: {
    folder?: string
    value: boolean | null
  }): Promise<AgentSpeechPrefs> => ipcRenderer.invoke('speech:agentPrefsSet', patch),

  // ---- Offline voice download (T241, ADR-0012 option C) ---------------------
  // The Kokoro backend runs in the renderer, but its code AND its weights are
  // fetched at runtime into <userData> — nothing ships in the installer,
  // because `phonemizer` inlines a GPLv3 espeak-ng. `speechKokoroInstall` is
  // the ONLY door that touches the network, and it is only ever called by an
  // explicit operator action: enabling voice never starts a download (AC-3).
  // `speechKokoroPlan` is what a consent step reads before that: the size, the
  // asset list, the target directory and the licence terms (AC-4/AC-7).
  speechKokoroStatus: (): Promise<KokoroStatus> => ipcRenderer.invoke('speech:kokoro:status'),
  speechKokoroPlan: (voices?: string[]): Promise<KokoroInstallPlan> =>
    ipcRenderer.invoke('speech:kokoro:plan', voices ?? []),
  speechKokoroInstall: (voices?: string[]): Promise<KokoroStatus> =>
    ipcRenderer.invoke('speech:kokoro:install', voices ?? []),
  speechKokoroCancel: (): Promise<boolean> => ipcRenderer.invoke('speech:kokoro:cancel'),
  speechKokoroRemove: (): Promise<KokoroStatus> => ipcRenderer.invoke('speech:kokoro:remove'),
  onSpeechKokoroProgress: (cb: (p: KokoroProgress) => void): (() => void) =>
    subscribe('speech:kokoro:progress', cb),

  // ---- Remote push notifications (remote-push spec) -------------------------
  // The same notification funnel (`maybeNotify`) fans out to user-configured
  // remote channels (ntfy topic / generic webhook) when it picks the `os`
  // channel. Config lives in `<userData>/push.json` (main-side, 0600 — tokens
  // never reach the renderer except via the explicit Settings editor); the HTTP
  // POST leaves from main. `pushSend` is fire-and-forget so a slow relay can
  // never block the hook-stream path.
  pushConfigGet: (): Promise<PushConfig> => ipcRenderer.invoke('push:config:get'),
  pushConfigSet: (cfg: PushConfig): Promise<PushConfig> =>
    ipcRenderer.invoke('push:config:set', cfg),
  pushSend: (payload: PushSendPayload): void => ipcRenderer.send('push:send', payload),
  /** Send a localized test message to one channel (unsaved drafts included). */
  pushTest: (
    channel: Partial<PushChannel>,
    message: { title: string; body: string }
  ): Promise<PushTestResult> => ipcRenderer.invoke('push:test', channel, message),

  // Claude Code changelog watcher (spec 2026-06-18). Main polls the CLI changelog
  // and pushes `claude-changelog:updated`; a clicked OS notification comes back as
  // `claude-changelog:activate` so the renderer can open the Claude Code tab.
  claudeChangelogGet: (): Promise<ClaudeChangelogState> =>
    ipcRenderer.invoke('claude-changelog:get'),
  claudeChangelogMarkRead: (): Promise<void> => ipcRenderer.invoke('claude-changelog:markRead'),
  claudeChangelogRefresh: (): Promise<void> => ipcRenderer.invoke('claude-changelog:refresh'),
  claudeChangelogOpenExternal: (): Promise<void> =>
    ipcRenderer.invoke('claude-changelog:openExternal'),
  onClaudeChangelogUpdated: (cb: (s: ClaudeChangelogState) => void): (() => void) =>
    subscribe<ClaudeChangelogState>('claude-changelog:updated', cb),
  onClaudeChangelogActivate: (cb: () => void): (() => void) =>
    subscribe<void>('claude-changelog:activate', cb),
  onClaudeChangelogNewVersion: (cb: () => void): (() => void) =>
    subscribe<void>('claude-changelog:new-version', cb),

  // ---- Claude service status (issue #17) -----------------------------------
  // Main polls the status.claude.com Statuspage summary; the renderer store
  // (`stores/claude-status.ts`) seeds via `claudeStatusGet()` and subscribes to
  // `onClaudeStatusUpdated`. `claudeStatusSetNotify` mirrors the localStorage
  // mute into main (which fires the native transition alerts). A clicked alert
  // comes back as `claude-status:activate` so the footer can open the panel.
  claudeStatusGet: (): Promise<ClaudeStatusSnapshot> => ipcRenderer.invoke('claude-status:get'),
  claudeStatusRefresh: (): Promise<ClaudeStatusSnapshot> =>
    ipcRenderer.invoke('claude-status:refresh'),
  claudeStatusHistoryUrl: (): Promise<string> => ipcRenderer.invoke('claude-status:history'),
  claudeStatusSetNotify: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('claude-status:setNotify', enabled),
  onClaudeStatusUpdated: (cb: (s: ClaudeStatusSnapshot) => void): (() => void) =>
    subscribe<ClaudeStatusSnapshot>('claude-status:updated', cb),
  onClaudeStatusActivate: (cb: () => void): (() => void) =>
    subscribe<void>('claude-status:activate', cb),

  // ---- Claude Boot (launch-options config) ---------------------------------
  // Global + per-folder `claude` launch flags, persisted in
  // `<userData>/claude-boot.json` by `src/main/claude-config.ts`. The renderer
  // store (`stores/claudeBoot.ts`) drives the Settings → Startup tab and the
  // per-folder dialog; the spawn path reads the same file directly to build the
  // argv, so these are write-through edits, not a spawn channel.
  claudeConfigGetGlobal: (): Promise<ClaudeBootConfig> =>
    ipcRenderer.invoke('claudeConfig:getGlobal'),
  claudeConfigSetGlobal: (cfg: ClaudeBootConfig): Promise<ClaudeBootConfig> =>
    ipcRenderer.invoke('claudeConfig:setGlobal', cfg),
  claudeConfigGetFolder: (folderPath: string): Promise<ClaudeBootConfig> =>
    ipcRenderer.invoke('claudeConfig:getFolder', folderPath),
  /**
   * Resolved config a new session inherits, read main-side (the single source of
   * truth for the "(inherited)" pre-fill, T57 #2). With a folder path → global ⊕
   * folder; with `undefined` → just the global config (what a per-folder dialog
   * inherits from above).
   */
  claudeConfigGetResolved: (folderPath?: string): Promise<ClaudeBootConfig> =>
    ipcRenderer.invoke('claudeConfig:getResolved', folderPath),
  claudeConfigSetFolder: (folderPath: string, cfg: ClaudeBootConfig): Promise<ClaudeBootConfig> =>
    ipcRenderer.invoke('claudeConfig:setFolder', folderPath, cfg),

  // ---- Harnu self-awareness (T55) -------------------------------------------
  // Toggle for injecting the versioned `docs/harnu-features.md` environment doc
  // into every `claude` session's --append-system-prompt (default ON). Read
  // main-side at spawn; this is just the Settings editing surface.
  harnuFeaturesGet: (): Promise<boolean> => ipcRenderer.invoke('harnuFeatures:get'),
  harnuFeaturesSetEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('harnuFeatures:setEnabled', enabled),

  // ---- Bundled skills (T217) -----------------------------------------------
  // Harnu's own skill catalog + the per-skill on/off panel. `get` returns the
  // whole view in one round-trip (catalog, global flags, user-level installs,
  // name collisions with the operator's personal skills). The FOLDER scope is
  // tri-state: `null` CLEARS the override so the folder inherits the global
  // value again — it is not a synonym for `false`.
  bundledSkillsGet: (): Promise<BundledSkillsView> => ipcRenderer.invoke('bundledSkills:get'),
  bundledSkillsSetGlobal: (name: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('bundledSkills:setGlobal', name, enabled),
  bundledSkillsGetFolder: (folder: string): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('bundledSkills:getFolder', folder),
  bundledSkillsSetFolder: (
    folder: string,
    name: string,
    enabled: boolean | null
  ): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('bundledSkills:setFolder', folder, name, enabled),
  bundledSkillsSetUserLevel: (name: string, install: boolean): Promise<UserLevelInstallResult> =>
    ipcRenderer.invoke('bundledSkills:setUserLevel', name, install),

  // ---- Skills a tick could stage (T305) ------------------------------------
  // Every skill a scheduler tick in `folder` can be told to stage, tagged with
  // its origin: Harnu's bundled catalog ∪ `~/.claude/skills/` ∪
  // `<folder>/.claude/skills/`. FOLDER-DEPENDENT — the Prompt field's `/`
  // autocomplete re-reads it whenever the worker's Folder changes. A tick runs
  // with `--setting-sources ''`, so nothing here reaches it unless the prompt
  // names it and Harnu stages it.
  skillsAvailable: (folder: string): Promise<AvailableSkill[]> =>
    ipcRenderer.invoke('skills:available', folder),

  // T85: push the effective UI locale to main so the self-awareness preamble can
  // tell every spawned session which language to write project memory in. Sent by
  // the renderer i18n layer on boot + on every language change; returns the cached
  // locale main settled on.
  setAppLocale: (locale: string): Promise<string> => ipcRenderer.invoke('settings:locale', locale),

  // --- Claude config (raw ~/.claude/settings.json GUI editor, issue #16) ---
  // Read the global settings file and apply field-level patches through the
  // hardened atomic + locked + guarded write layer. `set` carries dot-path →
  // value; `unset` carries dot-paths to delete (the UNSET Symbol can't cross IPC).
  claudeSettingsRead: (): Promise<ClaudeSettingsRead> => ipcRenderer.invoke('claudeSettings:read'),
  claudeSettingsPatch: (wire: ClaudeSettingsWire): Promise<ClaudeSettingsPatchResult> =>
    ipcRenderer.invoke('claudeSettings:patch', wire),

  // ---- Custom endpoint registry (local-provider-endpoints spec) ------------
  // Global list of Anthropic-compatible endpoints (local model fallback). A
  // session's `provider` references one of these by `id`; the spawn path
  // resolves the reference to `ANTHROPIC_*` env in the main process so the auth
  // token never crosses into the renderer except via this explicit editor.
  claudeConfigListEndpoints: (): Promise<EndpointProfile[]> =>
    ipcRenderer.invoke('claudeConfig:listEndpoints'),
  /** Upsert by id (generates one when absent). Returns the full updated list. */
  claudeConfigSaveEndpoint: (draft: Partial<EndpointProfile>): Promise<EndpointProfile[]> =>
    ipcRenderer.invoke('claudeConfig:saveEndpoint', draft),
  /** Remove by id. Idempotent. Returns the full updated list. */
  claudeConfigDeleteEndpoint: (id: string): Promise<EndpointProfile[]> =>
    ipcRenderer.invoke('claudeConfig:deleteEndpoint', id),

  // ---- Harnu MCP control server (agent-drives-Harnu, 2026-06-25) -------------
  // OFF by default. `server.ts` (loopback HTTP) lets a Claude agent SEE the
  // fleet and — gated by per-folder allow + a per-action confirm — create
  // sessions / spawn split terminals / create auto-listing worktrees.

  // Server lifecycle + audit (Settings → Control server pane).
  mcpStatus: (): Promise<McpServerStatus> => ipcRenderer.invoke('mcp:status'),
  mcpSetEnabled: (enabled: boolean): Promise<McpServerStatus> =>
    ipcRenderer.invoke('mcp:setEnabled', enabled),
  // T93: auto-register opt-out (inject Harnu's server into spawned sessions). Default ON.
  mcpAutoRegisterGet: (): Promise<boolean> => ipcRenderer.invoke('mcp:autoRegister:get'),
  mcpAutoRegisterSet: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('mcp:autoRegister:set', enabled),
  mcpGetAudit: (): Promise<McpAuditRecord[]> => ipcRenderer.invoke('mcp:getAudit'),
  // T44 S5: active mission grants — list, revoke, and a live-change subscription.
  mcpGrantsList: (): Promise<McpGrantView[]> => ipcRenderer.invoke('mcp:grants:list'),
  mcpGrantsRevoke: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('mcp:grants:revoke', { id }),
  onMcpGrantsChanged: (cb: (grants: McpGrantView[]) => void): (() => void) =>
    subscribe('mcp:grants:changed', cb),

  // Per-action agent-confirm overlay (fail-CLOSED; physically distinct from hook:*).
  onMcpConfirmPending: (cb: (p: McpConfirmPending) => void): (() => void) =>
    subscribe('mcp:confirm:pending', cb),
  // T44 S4: a parked confirm settled (respond/TTL/cancel/quit) — prune its Inbox row.
  onMcpConfirmResolved: (cb: (p: { id: string; reason: string }) => void): (() => void) =>
    subscribe('mcp:confirm:resolved', cb),
  // BUG-25: snapshot of every still-live confirm (re-hydrates the queue on
  // renderer reload — `onMcpConfirmPending` only fires once, at park time).
  mcpConfirmsList: (): Promise<McpConfirmPending[]> => ipcRenderer.invoke('mcp:confirm:list'),
  mcpConfirmRespond: (
    id: string,
    verdict: 'allow' | 'deny',
    // T61: for a create_worktree confirm that offered inheritance, the opt-out
    // checkbox state at Allow (false = the operator unchecked "inherit control").
    // T72: for an inheritance-discovery confirm, the scope the operator picked at
    // Allow ('always' turns on the global opt-in + marks the worktree; 'once' allows
    // it just this app session). Absent → server defaults to 'once' (least privilege).
    // T93: `alwaysAllow` = the "always allow this verb here" checkbox at Allow; true
    // persists a `mcp__harnu__<verb>` rule to the folder's settings.local.json.
    // T104: `manifestSelectedSlugs` = the manifest checklist's checked slugs at
    // Allow — only these are stamped `approved` (absent/omitted stamps nothing).
    // T102: `manifestSubstrateOverrides` = the operator's per-card substrate pick
    // at Allow (slug -> substrate), written alongside the approval stamp.
    data?: {
      inheritWorktreeControl?: boolean
      inheritScope?: 'always' | 'once'
      alwaysAllow?: boolean
      manifestSelectedSlugs?: string[]
      manifestSubstrateOverrides?: Record<string, string>
    }
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke('mcp:confirm:respond', { id, verdict, data }),
  /**
   * BUG-32 D3: defer a promoted modal confirm — "not now", not "no". Leaves
   * the confirm `pending` (no verdict, TTL untouched) and returns it to the
   * Approval Inbox "Needs you" tab. `ok: false` when `id` isn't a currently
   * `modal` live confirm (nothing to dismiss).
   */
  mcpConfirmDismiss: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('mcp:confirm:dismiss', id),

  // The friction opt-in: put a human confirm back in front of EVERY mutating agent
  // action. Default OFF (agents act freely). Global — not per folder.
  mcpAskGet: (): Promise<boolean> => ipcRenderer.invoke('mcp:ask:get'),
  mcpAskSet: (ask: boolean): Promise<boolean> => ipcRenderer.invoke('mcp:ask:set', ask),
  // T31: the Sentinel auto-denied a catastrophic command — surface it prominently.
  onSentinelBlocked: (cb: (p: { reason: string; sessionId: string }) => void): (() => void) =>
    subscribe('sentinel:blocked', cb),

  // Per-folder agent-control OPT-OUT: block agents in this folder + its subtree
  // (folder context menu toggle / Settings → Control server).
  userProjectsSetAgentDenied: (targetPath: string, denied: boolean): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:setAgentDenied', { targetPath, denied }),
  // T30: per-folder Approval Inbox intercept ramp opt-in (folder menu + Settings).
  userProjectsSetInterceptActive: (
    targetPath: string,
    allowed: boolean
  ): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:setInterceptActive', { targetPath, allowed }),
  // T52: rename a folder's sidebar label (blank resets to the basename).
  userProjectsSetAlias: (targetPath: string, alias: string): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:setAlias', { targetPath, alias }),
  // T52: per-folder "use branch name as label" auto-alias opt-in.
  userProjectsSetAliasFromBranch: (
    targetPath: string,
    enabled: boolean
  ): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:setAliasFromBranch', { targetPath, enabled }),
  // T106 (D6): per-repo "auto-organize conversation into draft cards" toggle
  // (folder menu). `get` resolves the effective value (own, else inherited
  // from the parent repo for a canonical worktree, else default ON).
  userProjectsGetAutoOrganize: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke('userProjects:getAutoOrganize', targetPath),
  userProjectsSetAutoOrganize: (
    targetPath: string,
    enabled: boolean
  ): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:setAutoOrganize', { targetPath, enabled }),
  // T344: per-folder "new sessions start as Orchestrator" default (FolderMenu
  // toggle). EXACT-PATH ONLY — unlike auto-organize, `get` never inherits a
  // parent repo's value for a linked worktree (AC-5).
  userProjectsGetOrchestratorDefault: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke('userProjects:getOrchestratorDefault', targetPath),
  userProjectsSetOrchestratorDefault: (
    targetPath: string,
    enabled: boolean
  ): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:setOrchestratorDefault', { targetPath, enabled }),
  // T191: "Set parent folder" / "Clear parent folder" (folder menu) — the manual
  // override for the `bornFrom` lineage edge. Pass `null` to clear.
  userProjectsSetBornFrom: (
    targetPath: string,
    bornFrom: string | null
  ): Promise<UserProjectsPayload> =>
    ipcRenderer.invoke('userProjects:setBornFrom', { targetPath, bornFrom }),
  // T191: sibling worktrees of the same repo — the "Set parent folder" submenu's
  // candidate list.
  userProjectsListBornFromCandidates: (
    repoId: string,
    excludePath: string
  ): Promise<Array<{ path: string; alias: string }>> =>
    ipcRenderer.invoke('userProjects:listBornFromCandidates', { repoId, excludePath }),

  // T98: "Promote to orchestrator" session context-menu toggle. `arm`/`disarm`
  // delegate to `orchestrator-guard.ts` (T109's Harnu-managed guard); `list`
  // hydrates the renderer's visible-role mirror at store init.
  orchestratorArm: (sessionId: string, folder: string): Promise<void> =>
    ipcRenderer.invoke('orchestratorGuard:arm', { sessionId, folder }),
  orchestratorDisarm: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('orchestratorGuard:disarm', sessionId),
  orchestratorListArmed: (): Promise<string[]> => ipcRenderer.invoke('orchestratorGuard:list'),

  // BUG-54 (D8): the terminal ledger's last-shutdown record. `errored`/`done`
  // states themselves need no new channel — they restore over the existing
  // `claude:hook` subscription below. T167 will consume this for `interrupted`.
  fleetLastShutdown: (): Promise<LastShutdownWire | null> =>
    ipcRenderer.invoke('fleet:lastShutdown'),

  // CommandBridge: correlated dispatch from main → renderer actuation → ack.
  // Wired by `stores/command-dispatch.ts`; the renderer-ready handshake opens
  // the dispatch gate so main never actuates against an unsubscribed window.
  onRendererCommand: (cb: (msg: RendererCommandMessage) => void): (() => void) =>
    subscribe('renderer:command', cb),
  rendererCommandAck: (requestId: string, result: unknown): Promise<void> =>
    ipcRenderer.invoke('renderer:command:ack', { requestId, result }),
  rendererReady: (): void => ipcRenderer.send('renderer:ready'),
  /**
   * This card (ADR-0003): report that an MCP agent's synthetic session id
   * migrated to a real, on-disk session — the materialization signal
   * `create_session`'s ACK awaits before ever claiming `ok:true`. Fire-and-
   * forget (`send`, not `invoke`): the store's migration codepath must never
   * block on this.
   */
  notifySessionMaterialized: (info: {
    syntheticId: string
    sessionId: string
    folder: string
  }): void => ipcRenderer.send('renderer:session-materialized', info),

  // Session-ready gate (single channel; payload carries the sessionKey).
  onSessionReady: (cb: (p: SessionReadyWire) => void): (() => void) =>
    subscribe('pty:sessionReady', cb),
  /** Resolve the live PTY id for a session key, or `null` if none is running. */
  ptyIdForSession: (sessionKey: string): Promise<string | null> =>
    ipcRenderer.invoke('pty:idForSession', sessionKey),

  // Worktree auto-adopt: a created worktree appears in the sidebar grouped under its repo.
  onFolderAdopted: (cb: (p: FolderAdoptedWire) => void): (() => void) =>
    subscribe('folders:adopted', cb),
  onFolderRemoved: (cb: (p: FolderRemovedWire) => void): (() => void) =>
    subscribe('folders:removed', cb),

  // T171: a watched markdown pane's backing file changed on disk (path only —
  // the renderer re-reads via the existing confined markdownRead).
  onMarkdownChanged: (cb: (p: MarkdownChangedWire) => void): (() => void) =>
    subscribe('markdown:changed', cb),

  // T218 U1: a watched canvas pane's backing file changed on disk (path only —
  // the renderer re-reads via the confined canvasRead, then decides per §7.3
  // whether to reload silently or raise the stale-on-disk banner).
  onCanvasChanged: (cb: (p: CanvasChangedWire) => void): (() => void) =>
    subscribe('canvas:changed', cb),

  // Worktree IPC (UI-only create/list/remove; `remove` is never exposed to an agent).
  worktreeCreate: (args: {
    repoPath: string
    branch: string
    baseRef?: string
    /**
     * T44 S2: check out an EXISTING local/remote branch (PR review) instead of
     * cutting a new one. When set, `branch` only names the worktree directory.
     */
    ref?: string
    /** When set, main streams per-stage progress on `worktree:progress:<id>`. */
    id?: string
    /** T61: the New-worktree dialog's "inherit agent control" opt-out (unchecked). */
    optOutInherit?: boolean
  }): Promise<{
    path: string
    base: string
    branch: string
    /**
     * BUG-40 §3.1: the SAME payload `folders:adopted` broadcasts, echoed
     * directly in this call's own resolution — a caller that needs the folder
     * registered before it does anything else (e.g. `RoadmapBoard.vue`'s
     * `spawnAndBind`, which used to lose the 250ms `onFolderAdopted` debounce
     * race) can register it synchronously instead of waiting on that push.
     */
    adopted: FolderAdoptedWire
    warnings: string[]
    /** BUG-40 §3.5 / BUG-50 absorbed: non-blocking slug-collision warning. */
    existingWork?: ExistingWorkMatch[]
  }> => ipcRenderer.invoke('worktree:create', args),
  /** T61: whether a create in this repo/branch offers agent-control inheritance. */
  worktreeInheritOffer: (args: {
    repoPath: string
    branch: string
    baseRef?: string
  }): Promise<boolean> => ipcRenderer.invoke('worktree:inheritOffer', args),
  /** Subscribe to a create's per-stage progress (pair the `id` with `worktreeCreate`). */
  onWorktreeProgress: (id: string, cb: (ev: WorktreeProgress) => void): (() => void) =>
    subscribe(`worktree:progress:${id}`, cb),
  worktreeList: (args: { repoPath: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('worktree:list', args),
  // Local + remote branches of the repo, for the New-worktree base-ref select.
  worktreeBranches: (args: { repoPath: string }): Promise<BranchRef[]> =>
    ipcRenderer.invoke('worktree:branches', args),
  // Read-only dry-run: resolve the plan (target/base/seed/commands) + AC6
  // pre-checks WITHOUT mutating anything, for the New-worktree dialog preview.
  worktreePlan: (args: {
    repoPath: string
    branch: string
    baseRef?: string
    /** T44 S2: preview a checkout of this existing ref instead of a new-branch create. */
    ref?: string
  }): Promise<WorktreePlanResult> => ipcRenderer.invoke('worktree:plan', args),
  worktreeRemove: (args: {
    repoPath: string
    worktreePath: string
    force?: boolean
    deleteBranch?: boolean
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('worktree:remove', args),

  // ---- PR Stack Canvas (T198, UI-only; read-only against GitHub) -----------
  /**
   * Merge-chain graph of one repo's open PRs. Scoped per repo on purpose: the
   * arrangement rule is "every chain converges on ONE base node", and two
   * repos have no common default branch to converge on.
   *
   * `worktrees` is passed IN so the Reaper's verdict is reused rather than
   * recomputed — the canvas and the Cleanup view must never disagree about
   * whether a worktree is done with.
   */
  prStackLoad: (repoPath: string, worktrees?: PrStackWorktree[]): Promise<PrStackSnapshot> =>
    ipcRenderer.invoke('pr-stack:load', repoPath, worktrees),
  /**
   * Option+click on a PR link in a transcript: `{ prNumber }` when `url` is an
   * OPEN pull request of the folder's own repo (checked with `gh`), else `null`.
   */
  prStackResolveLink: (folderPath: string, url: string): Promise<{ prNumber: number } | null> =>
    ipcRenderer.invoke('pr-stack:resolveLink', folderPath, url),
  /** Foreground-refresh prefs (Settings → PR Stack). Whole-object GET/PUT. */
  prStackPrefs: (): Promise<PrStackPrefs> => ipcRenderer.invoke('pr-stack:prefs'),
  prStackSetPrefs: (prefs: PrStackPrefs): Promise<PrStackPrefs> =>
    ipcRenderer.invoke('pr-stack:setPrefs', prefs),

  // ---- Mission progress (T370, T358 S9; UI-only, never exposed to an agent) --
  /**
   * Every open mission in the repos of `folders`, as `mission_get` projects it
   * (stored fields + the `derived` block) plus a structured `you` item and the
   * close door's current refusal. Read-only.
   */
  missionList: (folders: string[]): Promise<MissionListResult> =>
    ipcRenderer.invoke('mission:list', folders),
  /**
   * The operator's doors — approve a draft, approve a staged re-scope, tick a
   * human step, close a delivered mission. The only writes the mission UI
   * makes; no MCP verb reaches them. A refusal comes back `{ ok: false, error }`.
   */
  missionOperatorDoor: (door: MissionDoor): Promise<MissionDoorResult> =>
    ipcRenderer.invoke('mission:operatorDoor', door),

  // ---- Review pane (T164; UI-only, never exposed to an agent) --------------
  /**
   * Everything about "branch X vs base Y" in one round-trip: the parsed
   * branch-vs-base diff plus the evidence header's receipts and its structured
   * discrepancies. Works with no remote and no `gh` — git-only evidence is a
   * first-class result, not a degraded one, so this never rejects for a missing
   * PR (PRD AC4).
   */
  reviewLoad: (args: ReviewLoadArgs): Promise<ReviewSnapshot> =>
    ipcRenderer.invoke('review:load', args),
  /**
   * The repo's sensitive-path globs. Operator-owned and agent-unreadable by
   * design, exactly like the model routing table: no MCP verb touches the file
   * these come from.
   */
  reviewBlastRadius: (folder: string): Promise<BlastRadiusConfig> =>
    ipcRenderer.invoke('review:blastRadius', folder),
  reviewSetBlastRadius: (folder: string, config: BlastRadiusConfig): Promise<BlastRadiusConfig> =>
    ipcRenderer.invoke('review:setBlastRadius', folder, config),
  /**
   * Mark ONE file as read, or unread (T243). Local always; pushed to GitHub's
   * own `viewerViewedState` when the snapshot carried a PR node id.
   *
   * A point edit by design — the pane patches the file it touched and nothing
   * else. Re-loading the snapshot to reflect a mark would re-seed every other
   * file's expand/collapse state, which is the "loses their place" problem this
   * whole surface exists to fix, self-inflicted on every click.
   */
  reviewSetViewed: (args: ReviewSetViewedArgs): Promise<ReviewSetViewedResult> =>
    ipcRenderer.invoke('review:setViewed', args),
  /**
   * Submit a review to GitHub — approve, request changes, or comment (T244).
   *
   * The pane's ONE write, and the only thing anywhere in Harnu that speaks under
   * the operator's GitHub identity. It runs `gh pr review`, so Harnu never holds
   * a token; the body travels over stdin, never argv.
   *
   * **A human gesture reaches this and nothing else does.** There is no MCP
   * verb behind it, no session and no skill: approving someone's code is an
   * accept door, and those stay shut to everything but a person. The main-side
   * guard re-reads the PR's base and the reviewed ref's sha before it spawns
   * anything, and refuses — with a named reason — when the diff on screen is
   * not the diff being approved.
   */
  reviewSubmitReview: (args: ReviewSubmitArgs): Promise<ReviewSubmitResult> =>
    ipcRenderer.invoke('review:submitReview', args),
  /** Fires after a blast-radius edit so an open pane re-flags its files. */
  onReviewBlastRadiusChanged: (
    cb: (payload: { folder: string; globs: string[] }) => void
  ): (() => void) => subscribe('review:blastRadiusChanged', cb),

  // ---- Reaper cleanup engine (UI-only; never exposed to an agent) -----------
  /** The last computed snapshot, or `null` before the first scan this session. */
  reaperSnapshot: (): Promise<ReaperSnapshot | null> => ipcRenderer.invoke('reaper:snapshot'),
  /** Scan every known repo (bypassing the gh cache when `force`). */
  reaperScan: (force?: boolean): Promise<ReaperSnapshot> =>
    ipcRenderer.invoke('reaper:scan', force),
  /** Clean one harvestable item; re-scans its repo and pushes `reaper:update`. */
  reaperClean: (payload: { itemId: string; deleteRemote: boolean }): Promise<CleanResult> =>
    ipcRenderer.invoke('reaper:clean', payload),
  /** Batch-clean; streams `reaper:progress` per item, then re-scans affected repos. */
  reaperSweep: (payload: { itemIds: string[]; deleteRemote: boolean }): Promise<CleanResult[]> =>
    ipcRenderer.invoke('reaper:sweep', payload),
  /** Recent tombstones (newest first) for the "Recent cleanups" list. */
  reaperJournal: (): Promise<Tombstone[]> => ipcRenderer.invoke('reaper:journal'),
  /** Dehydrate items (T250): per-item guarded removal; streams `reaper:dehydrateProgress`, then re-scans. */
  reaperDehydrate: (payload: { itemIds: string[] }): Promise<DehydrateResult[]> =>
    ipcRenderer.invoke('reaper:dehydrate', payload),
  /** Rehydrate one item (T250): re-runs the manifest's `setup`, then re-scans its repo. */
  reaperRehydrate: (payload: { itemId: string }): Promise<RehydrateResult> =>
    ipcRenderer.invoke('reaper:rehydrate', payload),
  onReaperDehydrateProgress: (cb: (result: DehydrateResult) => void): (() => void) =>
    subscribe('reaper:dehydrateProgress', cb),
  onReaperUpdate: (cb: (snap: ReaperSnapshot) => void): (() => void) =>
    subscribe('reaper:update', cb),
  onReaperProgress: (cb: (result: CleanResult) => void): (() => void) =>
    subscribe('reaper:progress', cb),
  /** Current background-scan prefs (interval, kill switch, protected branches, ...). */
  reaperPrefs: (): Promise<ReaperPrefs> => ipcRenderer.invoke('reaper:prefs'),
  /** Whole-object write; reschedules the background timer. */
  reaperSetPrefs: (prefs: ReaperPrefs): Promise<ReaperPrefs> =>
    ipcRenderer.invoke('reaper:setPrefs', prefs),
  /** Fires after a background tick finds items that just became harvestable. */
  onReaperHarvestable: (cb: (alert: HarvestableAlert) => void): (() => void) =>
    subscribe('reaper:harvestable', cb),

  // ---- Containers (T320) ------------------------------------------------------
  /** The last snapshot, or `null` before the first scan this session. */
  containersSnapshot: (): Promise<ContainersSnapshot | null> =>
    ipcRenderer.invoke('containers:snapshot'),
  /** Scan docker now; also pushes `containers:update`. */
  containersScan: (): Promise<ContainersSnapshot> => ipcRenderer.invoke('containers:scan'),
  /** Stop / start / remove. Main enforces every tier and refuses what they forbid. */
  containersAct: (req: ContainersActRequest): Promise<ContainersActResult> =>
    ipcRenderer.invoke('containers:act', req),
  /** Recent tombstones, newest first. */
  containersJournal: (): Promise<ContainersTombstone[]> => ipcRenderer.invoke('containers:journal'),
  containersPrefs: (): Promise<ContainersPrefs> => ipcRenderer.invoke('containers:prefs'),
  /** Whole-object write, clamped in main; reschedules the background scan. */
  containersSetPrefs: (prefs: ContainersPrefs): Promise<ContainersPrefs> =>
    ipcRenderer.invoke('containers:setPrefs', prefs),
  /** Fires after every scan, background or manual, and after every action. */
  onContainersUpdate: (cb: (snap: ContainersSnapshot) => void): (() => void) =>
    subscribe('containers:update', cb),
  /** Fires once per stack, on the scan where it first becomes a zombie (pref-gated in main). */
  onContainersNewZombies: (cb: (alert: ContainersNewZombiesAlert) => void): (() => void) =>
    subscribe('containers:newZombies', cb),

  // ---- System Monitor (T127 S1) ---------------------------------------------
  // The always-on heap heartbeat (`onMonitorHeap`) feeds the footer gauge and
  // needs no start/stop. The full sampler (`onMonitorSample`) only runs between a
  // `monitorStart`/`monitorStop` pair — refcounted in main, so a double-mount of
  // the takeover pane is safe and one unmount can't silence a still-open sibling.
  onMonitorHeap: (cb: (sample: HeapSample) => void): (() => void) => subscribe('monitor:heap', cb),
  onMonitorSample: (cb: (sample: MonitorSample) => void): (() => void) =>
    subscribe('monitor:sample', cb),
  monitorStart: (): Promise<void> => ipcRenderer.invoke('monitor:start'),
  monitorStop: (): Promise<void> => ipcRenderer.invoke('monitor:stop'),
  monitorPolicyGet: (): Promise<Policy> => ipcRenderer.invoke('monitor:policyGet'),
  monitorPolicySet: (patch: Partial<Policy>): Promise<Policy> =>
    ipcRenderer.invoke('monitor:policySet', patch),

  // ---- Scheduler workers (T294 / T291 U4) -----------------------------------
  // A worker runs one prompt in one folder on a cadence, headless (`claude -p`),
  // never in the fleet. `schedulerSave` upserts by id (main mints one for a new
  // worker) and returns the full updated list, matching the endpoint registry's
  // write-through shape above.
  schedulerList: (): Promise<Worker[]> => ipcRenderer.invoke('scheduler:list'),
  schedulerSave: (worker: Partial<Worker>): Promise<Worker[]> =>
    ipcRenderer.invoke('scheduler:save', worker),
  schedulerDelete: (id: string): Promise<Worker[]> => ipcRenderer.invoke('scheduler:delete', id),
  schedulerRunNow: (id: string): Promise<void> => ipcRenderer.invoke('scheduler:runNow', id),
  schedulerStop: (id: string): Promise<void> => ipcRenderer.invoke('scheduler:stop', id),
  schedulerRuns: (id: string): Promise<Run[]> => ipcRenderer.invoke('scheduler:runs', id),
  /** Fires whenever the definitions or the running set change. */
  onSchedulerChanged: (cb: (state: SchedulerState) => void): (() => void) =>
    subscribe('scheduler:changed', cb),
  /** Harnu mod host snapshot (T389): listener state, totals and bindings. Token-free. */
  companionDiagnostics: (): Promise<CompanionDiagnostics> =>
    ipcRenderer.invoke('companion:diagnostics'),
  /**
   * Dev only: mints a spawn token for a throwaway owner so a recipe can drive the real socket.
   * A packaged build registers no handler, so this rejects there.
   */
  companionDevMintSpawn: (): Promise<{ spawnToken: string; runId: string } | null> =>
    ipcRenderer.invoke('companion:devMintSpawn'),
  /**
   * T389 P1W3: the identity claims ("PTY row `key` is session `sid`"), pulled at store init so a
   * window reload loses nothing. A claim never re-keys a row by itself (spec §7.1).
   */
  companionIdentityClaims: (): Promise<{ claims: IdentityClaim[] }> =>
    ipcRenderer.invoke('companion:identityClaims'),
  /**
   * Reports which binder migrated which row (`fireMigrate`), so main can compare it with the
   * claim. Evidence only: it changes nothing.
   */
  companionIdentityOutcome: (o: IdentityOutcome): void =>
    ipcRenderer.send('companion:identityOutcome', o),
  /** The full claim list again, whenever it changes (main pushes the whole list). */
  onCompanionIdentity: (cb: (payload: { claims: IdentityClaim[] }) => void): (() => void) =>
    subscribe('companion:identity', cb),
  /** Dev only: stops and starts the companion listener (LV-P1W3-g). Rejects in a packaged build. */
  companionDevRestartListener: (): Promise<void> =>
    ipcRenderer.invoke('companion:devRestartListener')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore exposed in dts
  window.electron = electronAPI
  // @ts-ignore exposed in dts
  window.api = api
}

export type Api = typeof api
