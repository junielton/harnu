import { defineStore } from 'pinia'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type {
  DegradedCode,
  FolderEntry,
  GitMeta,
  UserProject,
  TaskState,
  TranscriptState,
  StagnationVerdict,
  FailureReason,
  ClaudeBootConfig,
  FleetChangedEvent,
  TrackedRepoWire,
  TrackedWorktreeWire,
  WorktreesChangedEvent
} from '../../../preload'
import {
  classifyFolder,
  groupByRepo,
  groupByParentDir,
  isFolderGroup,
  groupKey,
  type ClassifyCtx,
  type FolderGroup
} from './folder-zones'
import { persistedRef, persistedSet } from './persisted'
import { useApprovalQueue } from './session-approvals'
import { useMcpConfirmQueue } from './session-mcp-confirms'
import { useLiveRegistry } from './session-live-registry'
import { useSessionAutoname } from './session-autoname'
import { useSidebarCursor } from './session-cursor'
import {
  applyGitListings,
  mergeFolders,
  pickGitMeta,
  stripGitListings,
  type GitListing
} from './merge-folders'
import { bindMigration, type AgentSession, type SyntheticCandidate } from './agent-create-core'
import {
  wireCommandDispatch,
  getMcpApi,
  type FolderAdoptedPayload,
  type FolderRemovedPayload
} from './command-dispatch'
import { countNeedsInput } from './attention'
import { selectForgotten, FORGOTTEN_THRESHOLD_MS } from './closure-core'
import { AGENT_BOOT_TIMEOUT_MS, shouldReapUndeliveredPrompt } from './synthetic-reaper'
import {
  resolveActivity,
  classifyFleetState,
  STUCK_AFTER_MS,
  type FleetActivity,
  type FleetState
} from './fleet-state'
import { sortSessions, type SessionSortMode } from '../components/session-sort'
import {
  buildBoard,
  type BoardBucket,
  type BoardSession,
  type BoardState
} from '../components/fleet-board'
import { sortFolders, type FolderSortMode } from '../components/folder-sort'
import { isSidebarDensity, type SidebarDensity } from '../components/sidebar-density'
import { teamHex } from '../components/teammate-grouping'
import { isForkSyntheticLike, sessionTitle } from '../lib/session-label'
import { injectionLedger } from './injection-ledger'
import {
  clampSessionWindow,
  keepSession,
  DEFAULT_SESSION_WINDOW_MS,
  SESSION_WINDOW_PRESETS,
  type WindowCtx
} from './session-window'
import {
  decideNotification,
  parseNotifyPrefs,
  type NotifyPrefs,
  type NotifyKind
} from './session-notify'
import { useUiStore } from './ui'
import { useRoadmapDrainStore } from './roadmap-drain'
import { useLayoutStore } from './layout'
import { dispatchNotification } from './notify-dispatch'
import { speech } from '../lib/speech'
import { playNotificationSound } from '../lib/notification-sound'
import {
  renderVoicePhrase,
  normalizeFolderForSpeech,
  normalizeSessionForSpeech
} from '../lib/voice-phrase'
import { VOICE_EVENT_KEY, needsChimeFallback } from './voice-notify'
import { useUsageStore } from './usage'
import { shouldNotifyUsageReset } from './usage-reset-notify'
import { useDailyBudgetStore } from './daily-budget'
import {
  isBudgetNotifyMark,
  shouldNotifyDailyBudget,
  type BudgetNotifyMark,
  type BudgetThreshold
} from './daily-budget-notify'
import type { DailyBudget } from '../components/daily-budget'
import { encodePathToSlug, resolveFolderPathBySlug } from '../lib/folder-slug'
import { writeToSession } from '../lib/terminal-bus'
import { shellEscapePath } from '../lib/path-inject'
import { i18n } from '../i18n'

/**
 * Session lifecycle state. Derived from the JSONL stream and the index entry —
 * not part of `sessions-index.json` itself. T-1.2/T-1.3 set this from main.
 */
export type SessionStatus = 'active' | 'idle' | 'archived'

/**
 * Lifecycle of a nested parallel agent (issue #9). Mirrors `AgentStatus` in
 * `src/main/claude-reader.ts`. `running` = the subagent transcript is being
 * appended; `done` = finished (heuristic — recency-based, no clean end marker).
 */
export type AgentStatus = 'running' | 'done'

/**
 * One nested parallel agent (Task-tool subagent) under a parent session.
 * Mirrors `SubagentEntry` in `src/main/claude-reader.ts` (the wire format).
 * Hard-linked to the parent via the `<sessionId>/subagents/` directory — the
 * subdir name IS `parentSessionId`, so there is no attribution guesswork.
 */
export interface SessionAgent {
  agentId: string
  parentSessionId: string
  fullPath: string
  fileMtime: number
  /** `attributionAgent` (e.g. `general-purpose`); '' → render the generic label. */
  agentType: string
  /** `attributionSkill` origin (e.g. `superpowers:…`); '' if absent. */
  skill: string
  /** `attributionPlugin` origin; '' if absent. */
  plugin: string
  /** Model id from the first assistant line; '' if unknown. */
  model: string
  /** The agent's task (first user message), de-wrappered + truncated. */
  task: string
  status: AgentStatus
  created: string
  modified: string
}

/**
 * One row in `~/.claude/projects/<slug>/sessions-index.json#entries[]`.
 *
 * Field names are camelCase as they appear on disk — see finding 01 §4. We do
 * not transform; this interface IS the wire format.
 */
/**
 * T215 ownership marker: WHO caused a session to exist. Stamped on the session
 * entry at creation — the renderer is the only layer that knows the gesture —
 * and forwarded to `ptyCreate` on every spawn (`resolveSpawnSpec`) so
 * `pty.ts` can put it on the PTY record. `message_session` reads it back and
 * refuses an `'operator'`-owned recipient: an agent does not get to inject
 * input into the session the human is driving.
 */
export type SpawnOrigin = 'operator' | 'agent'

export interface Session {
  /** UUID; also the filename of the JSONL transcript. */
  sessionId: string
  /** Absolute path to the JSONL on disk. May not exist (dead session). */
  fullPath: string
  /** JS milliseconds. From `fs.stat` on the JSONL. */
  fileMtime: number
  /** User's first prompt, truncated to ~120 chars. Strings like "clear", "No prompt". */
  firstPrompt: string
  /** Haiku-generated session title shown in `/resume` and the sidebar. */
  summary: string
  /** Pre-counted message count (cheap badge). */
  messageCount: number
  /** ISO timestamp. */
  created: string
  /** ISO timestamp. */
  modified: string
  /** Last known branch. Empty string if not a repo. */
  gitBranch: string
  /** cwd Claude thinks the session is in. This IS the folder key. */
  projectPath: string
  /** true for subagent transcripts. Top-level sessions are always false. */
  isSidechain: boolean
  /** Derived in main, not in the index file. */
  status: SessionStatus
  /**
   * Hook-derived task-state (session-state real-state spec). Distinguishes
   * blocked-on-approval (`needs-input`) from finished (`idle`) — what the legacy
   * `status` activity-heuristic cannot represent. Undefined until the first hook
   * arrives; the sidebar then falls back to `status` (the working/idle dot).
   */
  taskState?: TaskState
  /**
   * Transcript ground truth (T91): the turn-over state the reader/watcher derived
   * from this session's JSONL (`working`/`idle`/`needs-input`/`unknown`). Consumed
   * by the canonical fleet classifier when there's no live hook `taskState`, so a
   * session with no hooks still gets an accurate dot/queue verdict. Optional —
   * synthetic Session literals and index-path entries omit it.
   */
  transcriptState?: TranscriptState
  /**
   * The CLI's "while you were away" recap (T91 §4) — the latest `away_summary`
   * content, verbatim. Empty/undefined when none. Shown in the hover preview.
   */
  awaySummary?: string
  /**
   * Stagnation verdict (T175/T176): a pure fold over the transcript tail that
   * flags a session repeating the same tool targets with no mutation between
   * them — the "noisy stall" the silence-only `stuck` rule can't see on its
   * own. Consumed by `fleet-state.ts`'s `workingOrStuck` (OR'd with the quiet
   * timer) and rendered as the line-2 reason on the Fleet card / the tally in
   * `SessionPreview.vue`. Undefined until the first delta/scrape determines it.
   */
  stagnation?: StagnationVerdict
  /**
   * "What's happening now" (T91 §3): `task-summary` → `last-prompt` → first user
   * message. Optional; falls back to `firstPrompt` at the callsite when absent.
   */
  whatsHappening?: string
  /**
   * Context-window used % (0–100) computed from the JSONL (T91 §5). Preferred
   * over statusline telemetry where Harnu shows ctx%; undefined/null when the
   * transcript has no usage yet (consumers fall back to statusline).
   */
  ctxPct?: number | null
  /**
   * Haiku-generated summary (auto-name substrate). `title` feeds the label
   * cascade ONLY when `summary` (custom/ai-title) is empty; `summary` (one line)
   * is the row tooltip. Runtime-only (not on disk) — re-applied across reloads by
   * id, like `taskState`. Never gated by age (lesson 001).
   */
  aiSummary?: { title: string; summary: string }
  /**
   * Why the session failed (StopFailure error_type). Only meaningful when
   * `taskState === 'failed'`; cleared on any transition out of failed.
   */
  failureReason?: FailureReason
  /** Epoch-ms of the rate-limit reset (StopFailure body or, preferred, statusLine). */
  resetsAt?: number
  /**
   * Parked by the T119 hibernation policy: Harnu killed the `claude` process (~420 MB) after
   * this session went cold. NOT dead and NOT stuck — the conversation is intact on disk and
   * selecting the row respawns it via the normal `claude-resume` path. Runtime-only (not on
   * disk), like `taskState`.
   */
  hibernated?: boolean
  /**
   * Mirrors `SessionEntry.resumable` from `claude-reader`. `false` for
   * cloud/bridge metadata-only stubs (no local conversation turns) — resuming
   * them with `claude --resume` fails with "No conversation found …", so the
   * UI renders the cloud panel instead of spawning a PTY. Synthetics are always
   * `true` (a freshly-spawned session writes a real transcript).
   */
  resumable: boolean
  /**
   * Mirrors `SessionEntry.bridged` — `true` when the session is mirrored to a
   * claude.ai cloud session. Drives the sidebar cloud affordance; orthogonal to
   * `resumable`. Synthetics are `false` until reconciliation pulls disk truth.
   */
  bridged: boolean
  /**
   * `true` when this entry was created locally by `createNewSession()` or
   * `createForkedSession()` ahead of Claude writing a JSONL to disk (U-1.5,
   * fork-session). Synthetic sessions carry a `synthetic-<uuid>` sessionId
   * and an empty `fullPath`.
   *
   * In `TerminalPane`, plain synthetics (no `forkSourceId`) resolve to kind
   * `'claude-new'`; synthetics with `forkSourceId` resolve to `'claude-fork'`.
   * Cleared (the entry is replaced) when the watcher first reports the real
   * JSONL for the same folder — see U-1.6 reconciliation in `init()`.
   */
  synthetic?: boolean
  /**
   * For synthetic sessions created via `createForkedSession`: the
   * `sessionId` of the source session this fork branches from. Read by
   * `TerminalPane` to spawn with kind `'claude-fork'` and forward the
   * source uuid as `claudeSessionId`. Cleared during synth→real migration
   * (`reconcileSessionAdded`) — once the real JSONL exists on disk the
   * field is no longer meaningful.
   */
  forkSourceId?: string
  /**
   * One-shot launch overrides set in the New session dialog (Claude Boot,
   * session scope). Only present on plain synthetics created via the dialog;
   * read by `TerminalPane` and forwarded to `ptyCreate` so the main process
   * merges it on top of global + per-folder config (session wins). Transient
   * and renderer-only — never persisted, cleared on synth→real migration.
   */
  bootOverride?: ClaudeBootConfig
  /**
   * T123: the mode the session was born in (`Modes ▸ Learning`). Set once, on
   * the plain synthetic created via `createNewSession`'s third parameter — but
   * it must OUTLIVE that synthetic: it survives the in-place synth→real
   * migration (`collapseSyntheticInto` mutates the same object rather than
   * replacing it) and every later `reconcileSessions` pass against a
   * disk-rebuilt row, because `mode` is listed in `RENDERER_ONLY_SESSION_KEYS`
   * — real sessions sourced from disk NEVER carry this field, so a future
   * "simplification" that drops it from that allowlist silently wipes the
   * teaching contract on the next folder rescan. Read by `resolveSpawnSpec` on
   * EVERY `sessionEntry`-derived branch — `claude-fork`, `claude-new`, AND
   * `claude-resume` — → `ptyCreate({ mode })`, so `pty.ts` resolves the mode's
   * contract (`resolveModeContract`, `extensions-loader.ts`) and injects it
   * into the `--append-system-prompt` preamble, alongside the orchestrator
   * contract, on every respawn — not just the first boot. `string`, not the
   * closed `SessionModeId` union (T138): a builtin or an extension's
   * `contributes.modes` id, both resolved the same way.
   */
  mode?: string
  /**
   * `true` for an MCP **agent**-created synthetic (`insertAgentSession`). Threaded
   * through `resolveSpawnSpec` → `ptyCreate({ agentControlled: true })` so the main
   * process **withholds the app-managed `--mcp-config`** (no recursive Conductor)
   * and **force-downgrades** the permission posture (never inherits skip-perms).
   * Set ONLY on the agent's own synthetic; a user synthetic leaves it `undefined`.
   * Security-critical: without this marker an agent-spawned session would launch
   * privileged + as a Conductor (the M1 `agentControlled` consumer in `pty.ts` is
   * inert until this flag actually reaches the spawn). Cleared on synth→real
   * migration (the PTY is created once, at synthetic time — the migrate reuses it).
   */
  agentControlled?: boolean
  /**
   * T215 ownership marker: WHO caused this session to exist.
   *
   * `'agent'` for every session an agent brought into being — an MCP
   * `create_session` synthetic (`insertAgentSession`) AND a board/manifest
   * dispatch (`dispatchCardSession`), which is deliberately BROADER than
   * `agentControlled` above (that one is set only on the MCP path, so reusing
   * it would have left every manifest-dispatched session unmarked).
   * `'operator'` for a session the human asked for: "+ New session", a fork.
   *
   * Forwarded to `ptyCreate` on every spawn of the session (`resolveSpawnSpec`)
   * so `pty.ts` can stamp it on the PTY record, where `message_session` reads
   * it back and REFUSES an operator-owned recipient. Preserved across disk
   * reconciles (`RENDERER_ONLY_SESSION_KEYS`) — it never appears in the JSONL,
   * and losing it would silently reopen the operator's own session to agent
   * traffic. Absent on a cold transcript the operator opens; the spawn site
   * supplies the gesture fallback and main fails closed to `'operator'`.
   */
  spawnedBy?: SpawnOrigin
  /**
   * Nested parallel agents (Task-tool subagents) hard-linked to this session
   * via `<sessionId>/subagents/agent-*.jsonl` (issue #9). Seeded by the reader
   * and reconciled live from `claude:subagent:updated`. Optional so synthetic
   * Session literals (which never have agents) don't need to set it.
   */
  agents?: SessionAgent[]
  /**
   * `true` when this entry is a **folder terminal** — a plain shell bound to the
   * folder's cwd (`createFolderTerminal`), NOT a Claude session. Carries a
   * `shellterm-<uuid>` sessionId and an empty `fullPath`; it has no JSONL on disk
   * and never will. It is explicitly NOT `synthetic`, so it never enters the
   * synthetic→real migration / collapse / auto-name / slug-reconcile machinery
   * (`docs/lessons/synthetic-sessions/003`). `resolveSpawnSpec` resolves it to
   * kind `'shell'` first of all; the sidebar renders it in its own "Terminals"
   * sub-group rather than the normal session list. Ephemeral runtime state —
   * survives a renderer reload (re-injected like a synthetic, by empty
   * `fullPath`) but not a full app restart.
   */
  isShellTerminal?: true
  /**
   * `session-<8 hex>` when this session is an agent-teams TEAMMATE (T99 — this
   * is a plain on-disk JSONL fact, present on every line of a teammate
   * transcript). The hex suffix is the first 8 chars of the team lead's own
   * sessionId, used to find the lead session in the same folder
   * (`teammate-grouping.ts#buildSessionRows`). Empty/`undefined` for a
   * lead/normal session — mirrors `SessionEntry.teamName` (always `''` there).
   */
  teamName?: string
  /** The teammate's short name (e.g. `spec-ui`), alongside `teamName`. */
  agentName?: string
}

/**
 * Type guard for fork synthetics — narrows `Session` to the shape consumers
 * actually use (synthetic + non-undefined `forkSourceId`). Without this, the
 * three callsites (`TerminalPane`'s kind-detection branch, `SidebarFolder`'s
 * `labelFor`, `Topbar`'s `displayTitle`) duplicate the truthiness check
 * `s.synthetic === true && s.forkSourceId` and burn TypeScript's narrowing
 * on each property access. The guard centralizes the invariant in a function
 * name — adding a 4th synth flavor later means updating one predicate, not
 * three.
 */
export function isForkSynthetic(
  s: Session
): s is Session & { synthetic: true; forkSourceId: string } {
  return isForkSyntheticLike(s)
}

/**
 * A folder — the first-class unit of the folder-first model (spec
 * 2026-06-11). Replaces both `Project` and `Worktree`: a folder IS what a
 * worktree was (an absolute path that directly hosts sessions). Keyed by
 * absolute `path` (the session cwd).
 *
 * Built from the wire shape `FolderEntry`, with `sessions` re-typed to the
 * renderer's `Session` (which adds `synthetic`/`forkSourceId`/`taskState` and a
 * narrower `agents`), plus two renderer-only flags: `expanded` (sidebar
 * disclosure state) and `pinned` (membership in `projects.json#projects[]` —
 * i.e. the user explicitly added it). `FolderEntry.sessions` (`SessionEntry[]`)
 * is structurally assignable to `Session[]`, so the disk shape flows in cleanly.
 */
/**
 * One entry of the jump palette's recent-search list (T288). The counts are a
 * SNAPSHOT taken when the search ran — the tree moves on, and re-running every
 * historical query on every palette open to keep them live would be both slow
 * and a lie about what the operator saw.
 */
export interface RecentJumpSearch {
  query: string
  folders: number
  hidden: number
  sessions: number
}

export interface Folder extends Omit<FolderEntry, 'sessions'> {
  sessions: Session[]
  expanded: boolean
  pinned: boolean
  /**
   * T191: the folder whose session cut this worktree — the orchestrator.
   * Absolute path, mirrored from `UserProject.bornFrom` by `mergeFolders`
   * (`merge-folders.ts`). Absent means no mother; the folder renders flat.
   */
  bornFrom?: string
  /**
   * T388: `git worktree list` of a repo the sidebar shows reported this path, so
   * it always lists (with or without sessions). Set by `mergeFolders`.
   */
  gitListed?: boolean
}

/** Result of {@link dispatchCardSession} (BUG-40 §3.2) — a named reason on failure. */
export type DispatchCardSessionResult =
  { ok: true; sessionId: string } | { ok: false; reason: string }

/**
 * Probe additive git meta for `paths` via the main-process batch probe (T70A).
 * Returns a `Map<path, GitMeta>` carrying only entries that actually resolved a
 * git field (an omitted field never lands as an explicit `undefined` key —
 * `pickGitMeta`). Degrades to an empty Map on any failure (probe API absent in a
 * test harness, git outage) so callers never break: an unenriched folder just
 * stays an ungrouped standalone.
 */
async function probePathsGitMeta(paths: string[]): Promise<Map<string, GitMeta>> {
  const out = new Map<string, GitMeta>()
  if (paths.length === 0) return out
  if (typeof window.api?.probeGit !== 'function') return out
  try {
    const results = await window.api.probeGit(paths)
    for (const r of results) {
      const meta = pickGitMeta(r)
      if (meta) out.set(r.path, meta)
    }
  } catch {
    /* degrade: unprobed paths stay ungrouped */
  }
  return out
}

/**
 * Lightweight snapshot of the chokidar watcher's health. `degraded: false` is
 * the happy path; on ENOSPC / EMFILE / EACCES we flip `degraded` and surface
 * the code + raw message so the sidebar status pill (T-1.7) can render it.
 */
export interface WatcherStatus {
  degraded: boolean
  code: DegradedCode | null
  message: string
}

/**
 * Module-level cleanup registry for IPC subscriptions. We keep this outside
 * the store closure so the same registry survives Pinia HMR — `init()` flushes
 * and re-installs on each run. Not strictly required for v1 but very cheap.
 */
const cleanupFns: Array<() => void> = []

/**
 * Per-session timer that flips `status` back from `'active'` to `'idle'` after
 * a quiet window. Reset on every `onSessionUpdated` so a noisy session stays
 * active. Keyed by `sessionId` — that's globally unique across folders.
 */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Quiet window before a session flips back to idle. Drives the green pulse
 * dot's hold time in the sidebar — set to 5 s to match T-1.6's spec.
 */
const ACTIVE_TO_IDLE_MS = 5000

/**
 * How long an MCP agent-created synthetic's correlation-bound migrate stays
 * armed (MCP fleet, T16/T25). After this window the binding is discarded —
 * `claude` either wrote its JSONL (and the synthetic migrated in place) or it
 * never launched, and we must not bind a much-later, unrelated on-disk session
 * to a stale agent synthetic.
 *
 * BUG-59: this window is armed at BOOT (`armAgentCorrelationForBoot`, called
 * by `TerminalPane` right before the PTY spawn), not at `insertAgentSession`
 * (enqueue). The meaningful start of the synth→real race is the spawn, not
 * the queueing — `agentBootQueue` drains serially, so arming at enqueue
 * routinely expired before a queued boot even started under fan-out.
 */
export const AGENT_MIGRATE_WINDOW_MS = 10_000

/**
 * Per-agent timer that flips a subagent's `status` from `'running'` back to
 * `'done'` after a quiet window. Re-armed on every `claude:subagent:updated`
 * append. Keyed by `agentId` (globally unique). Mirrors the session
 * `idleTimers` pattern but with a longer window — a subagent is a job, not a
 * conversation, so we don't want it flickering to done between tool calls.
 */
const agentDoneTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Quiet window before a running subagent is considered done. */
const SUBAGENT_ACTIVE_WINDOW_MS = 15000

/** localStorage key for the per-session agent-list expand/collapse state. */
const AGENTS_EXPANDED_KEY = 'om2tab.agentsExpanded'

/**
 * localStorage key for the teammate-group expand/collapse state (T99), keyed
 * by the team LEAD's `sessionId`. A group with no lead in the folder is
 * orphaned and hidden (T168) — see `teammate-grouping.ts#buildSessionRows`.
 */
const TEAMMATES_EXPANDED_KEY = 'om2tab.teammatesExpanded'

/** localStorage key for the set of archived session ids (Archive action). */
const ARCHIVED_SESSIONS_KEY = 'om2tab.archivedSessions'

/**
 * Per-session UX preferences. Kept in-memory only (no persistence in v1); lost
 * on app quit, restored to default OFF.
 *  - `noFlicker` (T-3.7) — flips the `CLAUDE_CODE_NO_FLICKER` env var at PTY
 *    spawn time.
 *  - `remoteControl` (RC-UI) — mirrors whether this session's boot config
 *    carries the operator-only `--remote-control` flag. The authoritative value
 *    for the spawn lives on the session entry's `bootOverride.remoteControl`
 *    (forwarded to `claude --resume` by `resolveSpawnSpec`); this pref is the
 *    reload-surviving copy the context-menu toggle reflects, so a routine
 *    folder rescan that rebuilds entries doesn't visually flip the toggle off.
 */
export interface SessionPrefs {
  noFlicker?: boolean
  remoteControl?: boolean
}

/**
 * One position in the sidebar's keyboard-navigation cursor. Separate from
 * `selectedId` — the cursor walks the visible tree (groups → folders →
 * sessions) and only flips `selectedId` (or toggles expansion) on
 * `cursorActivate()`. T-4.6.
 *
 * `id` is namespaced by `kind` so a folder path, a group key, and a session
 * UUID can coexist without collision: folder rows use the absolute folder
 * `path`, group rows use the group's NAMESPACED key (`repo:…` / `path:…`),
 * session rows use the session UUID.
 */
export type SidebarCursorKind = 'folder' | 'group' | 'session'

export interface SidebarCursor {
  kind: SidebarCursorKind
  id: string
}

/** localStorage key for the persisted session-sort preference. */
const SESSION_SORT_KEY = 'om2tab.sessionSort'

/**
 * Empirical ceiling of agents that can demand your consent before decision
 * quality degrades (supervisor study — Cummings, 4–5). Above it the triage
 * queue's load meter turns amber ("you are the bottleneck"). Names a limit;
 * blocks nothing.
 */
export const SUPERVISION_CEILING = 5

/**
 * Retired localStorage key — the sidebar's folders↔board segmented toggle
 * (T153 removed the Fleet status board view; the sidebar is folders-only now).
 */
const LEGACY_SIDEBAR_VIEW_KEY = 'om2tab.sidebarView'

/** localStorage key for the persisted folder-sort preference (folder-sort spec §4). */
const FOLDER_SORT_KEY = 'om2tab.folderSort'

/** localStorage key for the persisted sidebar density preset (design.md §4 "Row density"). */
const SIDEBAR_DENSITY_KEY = 'om2tab.sidebarDensity'

/** localStorage key for the persisted active-elsewhere window (ms). */
const ACTIVE_WINDOW_KEY = 'om2tab.activeWindowMs'

/** Default active-elsewhere window — 48h (spec §4.3 / §5.2). */
const DEFAULT_ACTIVE_WINDOW_MS = 172_800_000

/** Allowed presets for the active-elsewhere window (spec §7 — 24h / 48h / 7d). */
const ACTIVE_WINDOW_PRESETS = [
  24 * 60 * 60 * 1000,
  48 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000
] as const

/** Retired localStorage key — the old "Hide inactive (>7d)" toggle (spec §4.3). */
const LEGACY_HIDE_INACTIVE_KEY = 'om2tab.hideInactive'

/** localStorage key for the persisted session-age window (ms). `0` = "All". */
const SESSION_WINDOW_KEY = 'om2tab.sessionWindowMs'

/** localStorage key for the set of collapsed sidebar groups (by namespaced group key). */
const REPO_GROUPS_COLLAPSED_KEY = 'om2tab.repoGroupsCollapsed'

/** localStorage key for per-repo group aliases (T88), a `{ repoId: alias }` map. */
const REPO_ALIASES_KEY = 'om2tab.repoAliases'

/** localStorage key for the jump palette's recent-search list (T288). */
const JUMP_SEARCHES_KEY = 'om2tab.jumpRecentSearches'

/** localStorage key for the jump palette's recently-visited folder paths (T288). */
const JUMP_VISITS_KEY = 'om2tab.jumpRecentVisits'

/** localStorage key for the persisted OS-notification preferences. */
const NOTIFY_PREFS_KEY = 'om2tab.notify'

/** localStorage key for the last daily-budget threshold notified (daily-budget spec). */
const BUDGET_NOTIFY_KEY = 'om2tab.budget-notify'

/** Title i18n key per notify-kind (resolved in the store, which has i18n). */
const NOTIFY_TITLE_KEY: Record<NotifyKind, string> = {
  'needs-input': 'notifications.needsInput.title',
  completed: 'notifications.completed.title',
  failed: 'notifications.failed.title'
}

/**
 * Toast accent per notify-kind, for the focused-window in-app channel
 * (os-notifications spec §4). Mirrors the OS-notification semantics + the
 * sidebar dot colors: needs-input → amber/warning, completed → green/success,
 * failed → red/danger.
 */
const TOAST_KIND: Record<NotifyKind, 'info' | 'success' | 'warning' | 'danger'> = {
  'needs-input': 'warning',
  completed: 'success',
  failed: 'danger'
}

/**
 * Prompts at or under this length attach to the synthetic's `bootOverride`
 * and deliver as a deterministic `claude` argv positional at spawn
 * (`buildClaudeArgs` already pushes `cfg.prePrompt` with a `--` separator —
 * see `src/main/claude-args.ts:578`). This eliminates the paste-after-boot
 * race for the common case. Prompts over this length still queue into
 * `pendingAgentPrompts` below, unchanged.
 *
 * BUG-85: MUST equal `PROMPT_ARGV_BUDGET_CHARS` in `src/main/roadmap-core.ts`,
 * which is the cap main applies to the ASSEMBLED prompt. While this was 8_000
 * and main capped only the card BODY at 8_000, every long card overflowed by
 * exactly the framing and fell onto the paste path — which then dropped the
 * prompt. `tests/prompt-argv-budget.test.ts` locks the two constants together;
 * change them as a pair or that test fails.
 */
export const AGENT_PREPROMPT_ARGV_MAX_CHARS = 24_000

/** Initial window-focus state — `false` outside a DOM (tests, early boot). */
function initialWindowFocus(): boolean {
  return typeof document !== 'undefined' ? document.hasFocus() : false
}

/**
 * What main's fleet model has looked at, per `fleet:changed` push (sidebar-
 * liveness D8): each covered slug — and `full`, for a full rescan — maps to the
 * store's `coverageSeq` at the moment that coverage arrived (0 = none).
 */
interface Coverage {
  slugs: Map<string, number>
  full: number
}

/**
 * True when `coverage` can speak for an entry recorded at `entrySeq` under
 * `slug`: the model looked at that slug (or everywhere) in a push that arrived
 * AFTER the entry was recorded. An earlier push is stale for it.
 */
function coverageJudges(coverage: Coverage, slug: string, entrySeq: number): boolean {
  return coverage.full > entrySeq || (coverage.slugs.get(slug) ?? 0) > entrySeq
}

export const useSessionsStore = defineStore('sessions', () => {
  // Empty until `init()` populates it from the main process. While
  // `folders.length === 0` the Onboarding state is shown.
  const folders = ref<Folder[]>([])
  // T180: true until init()'s first reloadModel() resolves. Lets the sidebar
  // distinguish "still scanning ~/.claude/projects/" from "genuinely empty".
  const foldersLoading = ref(true)
  const selectedId = ref<string | null>(null)

  /**
   * T212 — the selected FOLDER. A folder is a selectable entity in its own right
   * (clicking one opens `FolderView`), exactly like a session. The two selections
   * are mutually exclusive BY CONSTRUCTION: `select` and `selectFolder` each clear
   * the other, so no caller has to remember the invariant. Both null = the global
   * `EmptyState`.
   */
  const selectedFolderPath = ref<string | null>(null)

  // T69 fix: path of a folder the sidebar should scroll into view + focus after a
  // CLI-driven adoption (`harnu .`). A signal, not persisted state — the Sidebar
  // watches it, scrolls the matching row into view, then clears it. Never set on an
  // MCP adopt (an agent must not steal the operator's view — T78).
  const revealFolderPath = ref<string | null>(null)

  // BUG-31 fix: sessionId of a row the sidebar should scroll into view after
  // `activateSession` (OS-notification click and its five other callers) —
  // twin of `revealFolderPath` but at the session-row grain, since a folder
  // can be expanded and on screen while a long session list still scrolls
  // the target row itself out of view. The Sidebar watches it, scrolls the
  // matching `[data-session-id]` row into view, then clears it.
  const revealSessionId = ref<string | null>(null)

  // T37 closure axis: when you LAST looked at each session (epoch ms), persisted.
  // A `needs-input` session you haven't viewed in a while is "forgotten". Seeded
  // at app-boot time so a session becomes forgotten only THRESHOLD after launch
  // (no "everything forgotten" storm). Written by a single watch(selectedId).
  const appBootMs = Date.now()
  const lastViewed = persistedRef<Record<string, number>>(
    'om2tab.lastViewed',
    {},
    {
      serialize: JSON.stringify,
      validate: (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
    }
  )
  /** A reactive clock, ticked so the forgotten set recomputes as sessions age out. */
  const closureNow = ref(Date.now())
  const lastViewedAt = (id: string): number => lastViewed.value[id] ?? appBootMs
  function stampViewed(id: string): void {
    lastViewed.value = { ...lastViewed.value, [id]: Date.now() }
  }
  /** Mark a forgotten session as seen (the "return here" dismiss) — drops it from the zone. */
  function markSessionSeen(id: string): void {
    stampViewed(id)
  }
  const watcherStatus = ref<WatcherStatus>({
    degraded: false,
    code: null,
    message: ''
  })

  /**
   * Per-session preferences. Not persisted in v1 — when the app quits the map
   * is dropped and every session reverts to defaults. Keyed by `sessionId`.
   */
  const prefsBySession = ref<Map<string, SessionPrefs>>(new Map())

  /**
   * Sidebar quick-wins state (filter morph). `filterActive` is the header
   * morph on/off; `filterQuery` is the current case-insensitive substring
   * (empty string when no text typed). The "Hide inactive" toggle and the
   * reveal-hidden escape hatch are gone in the folder-first model — zones
   * (pinned / active-elsewhere / dismissed) replace them (spec §5).
   */
  const filterActive = ref<boolean>(false)
  const filterQuery = ref<string>('')

  /**
   * Jump palette history (T288) — the empty-query state of the sidebar's jump
   * palette. Deliberately separate from `filterQuery`: the palette never
   * filters the tree, so its history is not the filter's history.
   *
   * `recentJumpSearches` keeps the last {@link JUMP_SEARCHES_CAP} queries that
   * actually returned something, newest first, with the per-group hit counts
   * captured at search time (the spec's "3 folders" / "1 session" hint).
   * `recentJumpVisits` keeps the last {@link JUMP_VISITS_CAP} folder paths the
   * operator landed on — by jumping, or by selecting any session in them.
   */
  const recentJumpSearches = persistedRef<RecentJumpSearch[]>(JUMP_SEARCHES_KEY, [], {
    validate: (v) => Array.isArray(v)
  })
  const recentJumpVisits = persistedRef<string[]>(JUMP_VISITS_KEY, [], {
    validate: (v) => Array.isArray(v)
  })

  /**
   * The row a jump just landed on — a `folder:<path>` / `session:<id>` token
   * `Sidebar.vue` consumes to flash the row once (design.md §7 — "Jump
   * flash"). A monotonic `seq` rides along so jumping to the SAME row twice
   * still re-triggers the flash.
   */
  const jumpFlash = ref<{ token: string; seq: number } | null>(null)
  let jumpFlashSeq = 0

  /**
   * Session sort preference (spec §7). Applied within each folder for display
   * only (never mutates `folder.sessions`). Persisted to localStorage.
   */
  const sessionSort = persistedRef<SessionSortMode>(SESSION_SORT_KEY, 'attention', {
    validate: (v) => v === 'attention' || v === 'recent' || v === 'name'
  })

  /**
   * Which sidebar groups are collapsed, by NAMESPACED group key (`repo:<repoId>`
   * or `path:<parentDir>`). A collapsed group hides its member-folder rows behind
   * the group header — a distinct gesture from expanding/collapsing an inner
   * folder's own session list (which lives on the folder's `expanded` flag).
   * Default is all-expanded (empty set); persisted to localStorage. Forced open
   * while a text filter is active (see `visibleFolders`).
   *
   * Entries written before path groups existed are bare repoIds; `migrate` lifts
   * them to `repo:<repoId>` on load so an upgrade doesn't silently re-expand
   * every group the operator had collapsed.
   */
  const collapsedGroupsSet = persistedSet<string>(REPO_GROUPS_COLLAPSED_KEY, {
    migrate: (x) => (x.startsWith('repo:') || x.startsWith('path:') ? x : groupKey('repo', x))
  })
  const collapsedGroups = collapsedGroupsSet.set

  /** Legacy boolean drill-in preference, read once for migration (see DRILL_DEPTH_KEY). */
  const DRILL_MODE_KEY = 'om2tab.sidebarDrillMode'

  /** localStorage key for the drill-in navigation depth preference. */
  const DRILL_DEPTH_KEY = 'om2tab.sidebarDrillDepth'

  /** localStorage key for the drill-in navigation stack (T289 — where you were). */
  const DRILL_STACK_KEY = 'om2tab.sidebarDrillStack'

  /**
   * Deepest reachable drill level. The hierarchy is group → folder → sessions,
   * so two pushes exhaust it; there is no level 3.
   */
  const DRILL_MAX_DEPTH = 2

  /**
   * One entry of the drill-in navigation stack — a group's member-folder list
   * (by namespaced group key), or a single folder's session list. `drillStack`
   * is empty at the root screen.
   * See docs/specs/2026-07-19-sidebar-drill-in-navigation.md.
   */
  type DrillNode = { kind: 'group'; key: string } | { kind: 'folder'; path: string }

  /**
   * One-shot migration off the pre-2026-07-29 boolean preference: an operator
   * who already ran drill-in gets depth 2, which is exactly the behavior that
   * boolean produced. Only consulted when the depth key is absent, and never
   * written back — `persistedRef` owns the new key from here on.
   */
  function legacyDrillDepthDefault(): number {
    try {
      return localStorage.getItem(DRILL_MODE_KEY) === 'true' ? DRILL_MAX_DEPTH : 0
    } catch {
      return 0
    }
  }

  /**
   * How many drill-in screens the sidebar may push before rows fall back to
   * the classic inline tree (docs/specs/2026-07-29-sidebar-drill-depth-levels.md).
   * `0` is the classic tree; `1` drills into a group and renders its folders
   * inline; `2` is one screen at a time all the way to a folder's sessions.
   */
  const drillDepth = persistedRef<number>(DRILL_DEPTH_KEY, legacyDrillDepthDefault(), {
    validate: (v) => Number.isInteger(v) && v >= 0 && v <= DRILL_MAX_DEPTH
  })

  /**
   * Whether the sidebar shows the drill-in navigator instead of the classic
   * tree. Derived from {@link drillDepth} so every pre-existing consumer
   * (`App.vue`'s shortcut gate, `Sidebar.vue`'s classic-tree `v-if`) keeps
   * working untouched.
   */
  const drillModeEnabled = computed(() => drillDepth.value > 0)

  /** Shape guard for one stored {@link DrillNode} — a corrupt entry invalidates the whole stack. */
  function isDrillNode(v: unknown): v is DrillNode {
    if (typeof v !== 'object' || v === null) return false
    const n = v as Record<string, unknown>
    if (n.kind === 'group') return typeof n.key === 'string' && n.key.length > 0
    if (n.kind === 'folder') return typeof n.path === 'string' && n.path.length > 0
    return false
  }

  /**
   * The current drill-in navigation path — persisted (T289), so reopening the
   * app lands on the screen you left instead of bouncing back to the root.
   *
   * Persistence is deliberately in two halves. This `persistedRef` only
   * validates the stored SHAPE; whether each node still points at a real
   * folder/group can't be known at store-construction time (the model loads
   * asynchronously). {@link reconcileDrillStack} runs that resolution check
   * once `init()` has the folders, and empties the stack if any node is gone —
   * so a stale entry can never strand the sidebar on a screen that renders
   * nothing.
   */
  const drillStack = persistedRef<DrillNode[]>(DRILL_STACK_KEY, [], {
    validate: (v) => Array.isArray(v) && v.every(isDrillNode)
  })

  /**
   * Whether one restored {@link DrillNode} still names a screen worth landing
   * on. A group must still be RENDERING (`groupInVisible`); a folder must still
   * be known AND not one the user dismissed.
   *
   * The two halves are deliberately asymmetric. A folder is checked against
   * `folders.value` rather than `visibleFolders`, because `folderScreen`
   * renders off exactly that lookup — and because a folder that merely went
   * `stale` overnight (no recent session, not pinned) is still a legitimate
   * place to be; demanding visibility there would empty the stack every
   * morning. `hidden` is the one exclusion that must be honored: the user
   * explicitly dismissed that folder, and restoring straight onto its screen
   * would resurface it as the sidebar's entire content (the leak shape
   * `docs/lessons/code-patterns/001` describes — a new projection over the
   * folder model forgetting a visibility axis the existing views apply).
   */
  function drillNodeStillResolves(node: DrillNode): boolean {
    if (node.kind === 'group') return groupInVisible(node.key) !== null
    return findFolderByPath(node.path) !== null && !manuallyHiddenPaths.value.has(node.path)
  }

  /**
   * Drop a restored {@link drillStack} that no longer resolves. Called from
   * `init()` after the folder model is loaded: every node must still pass
   * {@link drillNodeStillResolves}, otherwise the whole stack is emptied (a
   * partial stack would put the operator on a screen whose parent no longer
   * exists). Also clamped to the current {@link drillDepth}, matching
   * `cycleDrillDepth`'s truncation.
   */
  function reconcileDrillStack(): void {
    if (drillStack.value.length === 0) return
    const resolves = drillStack.value.every(drillNodeStillResolves)
    drillStack.value = resolves ? drillStack.value.slice(0, drillDepth.value) : []
  }

  /**
   * Sidebar GROUP aliases (T88), keyed by namespaced group key → custom label.
   * Renames the group header, distinct from the per-FOLDER alias (T52, in
   * projects.json): it covers the no-main-worktree case and reads as "rename this
   * organizer". A blank alias removes the entry (label falls back to the derived
   * basename). Renderer-only sidebar state, persisted to localStorage exactly like
   * `collapsedGroups` (also namespaced), so no main-process / projects.json
   * round-trip. Read by `groupByRepo`/`groupByParentDir`, written by
   * {@link setGroupAlias}.
   *
   * The localStorage key is deliberately left at its original name — renaming it
   * would strip every alias the operator has already set. Bare (pre-namespace)
   * repoId keys are lifted to `repo:<repoId>` on load, same rationale.
   */
  const groupAliases = persistedRef<Record<string, string>>(
    REPO_ALIASES_KEY,
    {},
    {
      deserialize: (raw) => {
        const parsed = JSON.parse(raw) as Record<string, string>
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed)) {
          out[k.startsWith('repo:') || k.startsWith('path:') ? k : groupKey('repo', k)] = v
        }
        return out
      },
      validate: (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    }
  )

  /**
   * Set (or clear) a group's alias, by namespaced group key. A non-empty value
   * labels the group; a blank/whitespace value removes the alias so the header
   * reverts to the derived basename. Reassigns the map identity so the persist
   * watcher + zone computeds react.
   */
  function setGroupAlias(key: string, alias: string): void {
    const trimmed = alias.trim()
    const next = { ...groupAliases.value }
    if (trimmed) next[key] = trimmed
    else delete next[key]
    groupAliases.value = next
  }

  /**
   * Folder sort preference (folder-sort spec §4). Applied to each sidebar zone
   * for display only (never mutates `folders.value`). `recent` reproduces the
   * legacy activity order; `name` is stable so a folder stops jumping to the top
   * when a background session emits output. Persisted to localStorage.
   */
  const folderSort = persistedRef<FolderSortMode>(FOLDER_SORT_KEY, 'recent', {
    validate: (v) => v === 'recent' || v === 'name'
  })

  /**
   * Sidebar density preset (design.md §4 "Row density"). Scales the sidebar's
   * own row heights, session-row gap, and left indent — Comfortable (default)
   * or Compact — without touching any surface outside the sidebar. Persisted to
   * localStorage; read by `SidebarFolder` / `SidebarDrillView` via
   * `densityMetrics`.
   */
  const sidebarDensity = persistedRef<SidebarDensity>(SIDEBAR_DENSITY_KEY, 'comfortable', {
    validate: isSidebarDensity
  })

  /**
   * Active-elsewhere window in ms (spec §5.2 / §7). A non-pinned folder lands
   * in the Active-elsewhere zone if it is live OR has a session modified within
   * this window. Clamped to the {24h, 48h, 7d} preset set.
   */
  const activeWindowMs = persistedRef<number>(ACTIVE_WINDOW_KEY, DEFAULT_ACTIVE_WINDOW_MS, {
    serialize: String,
    deserialize: Number,
    validate: (n) => (ACTIVE_WINDOW_PRESETS as readonly number[]).includes(n)
  })

  /**
   * Session-age window in ms (session-age-filter spec §3). Hides session rows
   * older than this inside an expanded folder. `0` = "All" (no filtering).
   * Independent of `activeWindowMs` (which governs folder-zone placement).
   */
  const sessionWindowMs = persistedRef<number>(SESSION_WINDOW_KEY, DEFAULT_SESSION_WINDOW_MS, {
    serialize: String,
    deserialize: Number,
    validate: (n) => (SESSION_WINDOW_PRESETS as readonly number[]).includes(n)
  })

  /**
   * Folders whose older sessions are temporarily revealed (spec §5). NOT
   * persisted — a momentary peek that resets on reload. Keyed by `folder.path`.
   */
  const revealedOlderPaths = ref<Set<string>>(new Set())

  /**
   * OS-notification preferences (os-notifications spec §4). Master switch +
   * per-state opt-out, persisted to localStorage. Read by `maybeNotify`.
   */
  const notifyPrefs = persistedRef<NotifyPrefs>(NOTIFY_PREFS_KEY, parseNotifyPrefs(null), {
    deserialize: parseNotifyPrefs,
    serialize: JSON.stringify
  })

  /**
   * Whether the app window is currently focused. Drives notification
   * suppression (don't notify the session you're already looking at). Seeded
   * from `document.hasFocus()` and kept live by `window` focus/blur listeners
   * wired in `init()`.
   */
  const windowFocused = ref<boolean>(initialWindowFocus())

  /**
   * `resetsAtMs` of the 5h usage window we last notified for (usage-reset-
   * notify spec). In-memory only — not persisted, so a window that rolls
   * over during app startup can notify once more after a relaunch; that's
   * cheap enough that persisting a timestamp isn't worth it.
   */
  const lastNotifiedUsageResetMs = ref<number | null>(null)

  /**
   * The most recently observed `resetsAtMs` for the 5h window (usage-reset-
   * notify spec) — the PREVIOUS value at the time of each check, used to
   * detect a rollover by supersession rather than by "now >= resetsAtMs" on
   * the current value (see usage-reset-notify.ts's doc comment for why the
   * latter can never be observed live).
   */
  const lastSeenUsageResetsAtMs = ref<number | null>(null)

  /**
   * The highest daily-budget threshold already notified, stamped with the local
   * day it belongs to (daily-budget spec). PERSISTED, unlike
   * `lastNotifiedUsageResetMs`: this one fires at most twice a day, so a relaunch
   * mid-afternoon replaying both alerts is a real annoyance rather than a cheap
   * duplicate. The day stamp is what re-arms it — a mark from yesterday never
   * suppresses today.
   */
  const lastBudgetNotify = persistedRef<BudgetNotifyMark | null>(
    BUDGET_NOTIFY_KEY,
    null,
    // A corrupt/hand-edited mark must degrade to "never notified", not silently
    // suppress the alert for good.
    { validate: isBudgetNotifyMark }
  )

  /**
   * Set of session ids that currently own a running PTY. Maintained by
   * `TerminalPane` via `registerLiveSession` (on PTY create / adopt) and
   * `unregisterLiveSession` (on dispose / pty exit). Read by the zone
   * classifier so a folder with a live process always surfaces in the
   * Active-elsewhere zone regardless of session age. The Set is reassigned
   * on every mutation so Vue picks up the change in the zone computeds.
   */
  // Live-PTY registry (T25 wave 2) — owned by the dependency-free
  // `useLiveRegistry` composable. Destructured so internal callers + the return
  // object reference the same members unchanged.
  const { livePtySessionIds, registerLiveSession, unregisterLiveSession, isSessionLive } =
    useLiveRegistry()

  /**
   * Inject an arbitrary absolute file path into a SPECIFIC session's live PTY
   * the way a terminal-native file drop does: shell-escape it (backslash-escape
   * spaces + shell-special chars, via `shellEscapePath`) and write the escaped
   * path plus ONE trailing space. Claude Code's paste-path detection parses the
   * backslash-escaped form and turns a recognised path into an `[Image #N]` /
   * file reference; the trailing space both triggers that detection and
   * separates back-to-back injections so two paths don't concatenate into one
   * unparseable string. We do NOT send a newline — the user reviews the result
   * and submits the prompt. No-op (returns false) when the session has no live
   * PTY (a dormant session). Never throws — the writer-bus write is a safe no-op
   * for a session without a terminal. Shared plumbing for the footer
   * Pasted-images popover, the file-explorer drop targets, and row actions.
   */
  function injectPathIntoSession(sessionId: string, absPath: string): boolean {
    if (!isSessionLive(sessionId)) return false
    return writeToSession(sessionId, shellEscapePath(absPath) + ' ')
  }

  /**
   * Re-attach an on-disk pasted image into the FOCUSED session — the
   * selected-session convenience wrapper over `injectPathIntoSession`. No-op
   * (returns false) when there's no selection. Used by the footer Pasted-images
   * popover. Image paths are UUID dirs with no special chars, so escaping is a
   * pass-through and the observable write is unchanged (`path + ' '`).
   */
  function reattachImage(absPath: string): boolean {
    const id = selectedId.value
    if (!id) return false
    return injectPathIntoSession(id, absPath)
  }

  // ---- Approval Inbox (approval-inbox spec §4.4) ----
  // Fleet-wide queue of tool calls the responder is HOLDING for the operator
  // (active mode only). Keyed by `requestId`; the Map is reassigned on every
  // mutation so the zone computeds pick up the change. The folder alias + session
  // summary are resolved on the fly by the getter, never duplicated here.
  // Approval Inbox queue (T25 wave 1) — owned by the `useApprovalQueue` composable,
  // which takes the two cross-cutting readers by injection (`folderAliasOf`,
  // `findSessionById` are hoisted function declarations below). Destructured so
  // internal callers + the return object reference the same members unchanged.
  const {
    pendingApprovals,
    pendingApprovalList,
    pendingApprovalCount,
    addPendingApproval,
    removePendingApproval,
    removeApprovalsForSession,
    resolveApproval
  } = useApprovalQueue({
    folderAliasOf,
    findSessionById,
    allSessions: () => allSessions.value
  })

  // ---- Parked MCP confirms (T44 S4c) ----
  // The async sibling of the hook approval queue: agent-action confirms that
  // arrived while the window was unfocused park here (the focused-modal fast
  // path is `McpConfirmOverlay`). Owned by `useMcpConfirmQueue` (no cross-cutting
  // readers — a parked confirm has no owning session/folder to enrich). The count
  // folds into `attentionCount` (title + OS badge) and `inboxCount` (inbox badge).
  const {
    parkedConfirms,
    parkedConfirmList,
    parkedConfirmCount,
    addParkedConfirm,
    removeParkedConfirm,
    resolveParkedConfirm
  } = useMcpConfirmQueue()

  /**
   * Set of session ids whose nested agent list is expanded in the sidebar
   * (issue #9). Persisted to `localStorage` so the choice survives restarts.
   * A session not in the set renders its agents collapsed.
   */
  const agentsExpandedSet = persistedSet(AGENTS_EXPANDED_KEY)
  const agentsExpanded = agentsExpandedSet.set

  /** Whether a session's nested agent list is currently expanded. */
  function isAgentsExpanded(sessionId: string): boolean {
    return agentsExpanded.value.has(sessionId)
  }

  /** Toggle (and persist) a session's nested agent list expand/collapse state. */
  function toggleAgents(sessionId: string): void {
    agentsExpandedSet.toggle(sessionId)
  }

  /**
   * Teammate-group expand/collapse (T99). Groups start COLLAPSED (unlike
   * `agentsExpandedSet`, which is per-session but shares the same collapsed
   * default) — the key is the lead's `sessionId`.
   */
  const teammatesExpandedSet = persistedSet(TEAMMATES_EXPANDED_KEY)

  /** Whether a teammate group (keyed by lead sessionId) is expanded. */
  function isTeammatesExpanded(key: string): boolean {
    return teammatesExpandedSet.set.value.has(key)
  }

  /** Toggle (and persist) a teammate group's expand/collapse state. */
  function toggleTeammatesExpanded(key: string): void {
    teammatesExpandedSet.toggle(key)
  }

  /**
   * Set of archived session ids (the Archive context-menu action). This Set is
   * the AUTHORITATIVE source of truth — display derives from it via `isArchived`
   * rather than mutating each `Session.status`, so an archived session survives
   * watcher reloads (which rebuild every real session from disk) without any
   * re-application step. Persisted to `localStorage`.
   */
  const archivedIdsSet = persistedSet(ARCHIVED_SESSIONS_KEY)
  const archivedIds = archivedIdsSet.set

  /**
   * Folders whose archived sessions are temporarily revealed (mirrors
   * `revealedOlderPaths`). NOT persisted — a momentary peek that resets on
   * reload. Keyed by `folder.path`.
   */
  const revealedArchivedPaths = ref<Set<string>>(new Set())

  /** Whether a session is currently archived. Reactive (reads `archivedIds`). */
  function isArchived(sessionId: string): boolean {
    return archivedIds.value.has(sessionId)
  }

  /**
   * Set of normalized absolute paths the user explicitly dismissed via the
   * per-folder right-click menu (`FolderMenu.vue` → `dismissFolder`). Hydrated
   * from `<userData>/projects.json#hiddenPaths` on `reloadModel()` and
   * mirrored from every `userProjects:hide` / `:unhide` IPC response.
   */
  const manuallyHiddenPaths = ref<Set<string>>(new Set())

  /**
   * Set of normalized absolute paths where the user BLOCKED agents (the
   * `agentDenied` flag in `projects.json#projects[]`) — the per-folder opt-out of
   * the free-by-default posture, and the ONLY per-folder gate left (the old
   * `agentAllowed` allowlist is gone: an absent path means agents may act).
   * Hydrated from `userProjectsList()` on `reloadModel()` and mirrored from every
   * `userProjects:setAgentDenied` response. Same source as the Settings → Control
   * server list and the folder context-menu toggle.
   *
   * Membership here is EXACT-PATH. The gate itself blocks the whole subtree of a
   * blocked folder (`isFolderDenied`), so a worktree of a blocked repo is refused
   * even though it is not in this set — the set drives UI state, not the decision.
   */
  const agentDeniedPaths = ref<Set<string>>(new Set())

  /**
   * Set of normalized absolute paths the user put on the Approval Inbox **trust
   * ramp** (the `interceptActive` flag in `projects.json#projects[]`, T30). Under
   * global responder mode `active`, only folders in this set (or all folders when
   * "Trust all folders" is on) actually park tool calls for a human; every other
   * folder falls back to shadow behavior (logged, never blocked). Twin of
   * `agentDeniedPaths`: hydrated from `userProjectsList()` on `reloadModel()` and
   * mirrored from every `userProjects:setInterceptActive` response. Same source as
   * the Settings → responder ramp list and the Folder context-menu toggle.
   */
  const interceptFolders = ref<Set<string>>(new Set())

  /**
   * Set of normalized absolute paths the user opted into **auto-alias** (the
   * `aliasFromBranch` flag in `projects.json#projects[]`, T52). When a path is in
   * this set, the sidebar label falls back to the folder's git branch if the
   * directory basename differs from it (a custom rename still wins). Hydrated from
   * `userProjectsList()` on `reloadModel()` and mirrored from every
   * `userProjects:setAliasFromBranch` response — the same lockstep pattern as
   * `agentDeniedPaths`. Consumed via `displayAlias` (`folder-alias.ts`).
   */
  const aliasFromBranchPaths = ref<Set<string>>(new Set())

  /**
   * Set of normalized absolute paths that have EXPLICITLY turned OFF
   * "auto-organize conversation into draft cards" (T106/D6). Same
   * track-the-OFF-set convention as `agentDeniedPaths`: the toggle defaults ON, so
   * storing only the opt-outs means an absent path reads as ON without any extra
   * bookkeeping. Hydrated from `userProjectsList()` on `reloadModel()` and
   * mirrored from every `userProjects:setAutoOrganize` response. This is a
   * per-REPO setting (`FolderMenu.vue` hides the toggle for a linked
   * worktree, which inherits the main worktree's value server-side) — no
   * per-worktree entry ever lands in this set.
   */
  const autoOrganizeOffPaths = ref<Set<string>>(new Set())

  /**
   * Set of session ids currently promoted to Orchestrator (T98) — the
   * renderer's mirror of `orchestrator-guard.ts`'s `armed.json`, the durable
   * main-process truth. Hydrated via `orchestratorListArmed()` on
   * `reloadModel()` (so a restart doesn't visually demote a still-armed
   * session) and mutated locally by `toggleOrchestrator` alongside the
   * `arm`/`disarm` IPC call. Drives the SessionMenu toggle state, the
   * Sidebar badge, and the Topbar pill.
   */
  const orchestratorSessionIds = ref<Set<string>>(new Set())

  /**
   * Set of normalized absolute paths with "new sessions start as Orchestrator"
   * ON (the `orchestratorDefault` flag in `projects.json#projects[]`, T344).
   * Same track-the-ON-set convention as `interceptFolders`/`aliasFromBranchPaths`
   * (default OFF, so an absent path reads as OFF with no extra bookkeeping).
   * EXACT-PATH ONLY — unlike `autoOrganizeOffPaths`, a linked worktree never
   * inherits a path's membership here (AC-5; see the main-process field's own
   * doc comment). Hydrated from `userProjectsList()` on `reloadModel()` and
   * mirrored from every `userProjects:setOrchestratorDefault` response.
   */
  const orchestratorDefaultPaths = ref<Set<string>>(new Set())

  /**
   * Close-handlers registered by panes that own a live xterm for a session.
   * When `closeSession()` fires the store dispatches to every registered
   * handler so each pane can tear down its own resources. Multi-subscriber
   * after R1 — pre-R1 only one pane (TerminalPane) registered; the new
   * helper pane in the split feature also needs to listen.
   */
  const closeHandlers = new Set<(sessionId: string) => void>()

  function registerCloseHandler(fn: (sessionId: string) => void): () => void {
    closeHandlers.add(fn)
    return () => {
      closeHandlers.delete(fn)
    }
  }

  /**
   * Migrate-handlers fired by `reconcileSessionAdded` when a synthetic
   * session's local id is replaced by the real uuid Claude wrote to disk.
   * Each pane re-keys its own `liveTerminals` map; the underlying PTY does
   * NOT restart — same xterm, same Claude — only the key changes.
   * Multi-subscriber after R1.
   */
  const migrateHandlers = new Set<(fromId: string, toId: string) => void>()

  function registerMigrateHandler(fn: (fromId: string, toId: string) => void): () => void {
    migrateHandlers.add(fn)
    return () => {
      migrateHandlers.delete(fn)
    }
  }

  /**
   * Reload-handlers registered by panes that own a live xterm for a session.
   * `reloadSession()` fires them so the owning pane can tear down the running
   * `claude` process and respawn it (`claude --resume <uuid>`) — the way to
   * pick up a newly-installed skill / changed config, which `claude` only reads
   * at launch. Unlike `closeSession` this KEEPS the row in the model (only the
   * process restarts); unlike `fireMigrate` the PTY DOES restart. Same
   * multi-subscriber shape as the close/migrate handlers.
   */
  const reloadHandlers = new Set<(sessionId: string) => void>()

  function registerReloadHandler(fn: (sessionId: string) => void): () => void {
    reloadHandlers.add(fn)
    return () => {
      reloadHandlers.delete(fn)
    }
  }

  /**
   * Sessions born as Harnu synthetics this run ("+ New session" / fork rows),
   * tracked so Haiku auto-name fires ONLY for them — never for pre-existing
   * on-disk sessions. The id is carried across the synthetic→real promotion in
   * `fireMigrate`. Owned here (shared with synthetic create/fork/migrate) and
   * injected into the auto-name composable.
   */
  const bornSyntheticIds = new Set<string>()

  // ---- MCP agent-created sessions (T16/T25) ----
  // An MCP `session.create` mints a FRESH, non-deduped synthetic carrying an
  // opaque correlation token (`agent-create-core`). Unlike the user "+ New
  // session" path, its synth→real migrate is bound by THAT token (not by the
  // "newest synthetic in the folder" recency heuristic), so a coexisting user
  // synthetic in the same folder is never hijacked. Each binding is armed for
  // AGENT_MIGRATE_WINDOW_MS then discarded.
  const agentCorrelations = new Map<
    string,
    { syntheticId: string; folderPath: string; timer: ReturnType<typeof setTimeout> }
  >()
  // Correlation metadata recorded at `insertAgentSession` (enqueue), keyed by
  // syntheticId — but the AGENT_MIGRATE_WINDOW_MS timer above is NOT started
  // yet (BUG-59). `armAgentCorrelationForBoot` starts it later, at the moment
  // `TerminalPane` actually begins spawning this synthetic's PTY. Kept (not
  // deleted) after arming so a later `retrySyntheticBoot` can re-arm a fresh
  // window for the same syntheticId; cleared only once the synthetic is gone
  // for good (migrated or dismissed).
  const agentCorrelationMeta = new Map<string, { correlationId: string; folderPath: string }>()
  // Pre-prompt an agent asked us to inject into a created session, keyed by the
  // synthetic id (carried to the real id on migrate via `fireMigrate`). Consumed
  // ONCE by `TerminalPane`, gated on the session's `onSessionReady` event.
  const pendingAgentPrompts = new Map<string, string>()
  // Volatile git meta pushed by `folders:adopted` (T26), keyed by worktree path.
  // Threaded into `mergeFolders` so a just-adopted worktree groups under its repo
  // from the first frame, before Claude has written a `sessions-index.json` under
  // it. Survives reloads within the session (a later disk probe supersedes it).
  const adoptedGitByPath = new Map<string, GitMeta>()

  /** Arm a one-shot, token-bound migrate for an agent synthetic (auto-expires). */
  function armAgentCorrelation(
    correlationId: string,
    syntheticId: string,
    folderPath: string
  ): void {
    clearAgentCorrelation(correlationId)
    const timer = setTimeout(() => agentCorrelations.delete(correlationId), AGENT_MIGRATE_WINDOW_MS)
    agentCorrelations.set(correlationId, { syntheticId, folderPath, timer })
  }

  /**
   * Start the correlation window NOW for a synthetic whose meta was recorded
   * by `insertAgentSession` (BUG-59). Called by `TerminalPane` right before
   * the actual PTY spawn — the meaningful start of the synth→real race — so
   * the window's clock reflects the boot, never the (serial) queue wait ahead
   * of it. No-op for a user synthetic or an unknown/already-migrated id, so
   * it's safe to call unconditionally from the boot path.
   */
  function armAgentCorrelationForBoot(syntheticId: string): void {
    const meta = agentCorrelationMeta.get(syntheticId)
    if (!meta) return
    armAgentCorrelation(meta.correlationId, syntheticId, meta.folderPath)
  }

  /** Disarm + forget an agent correlation (its timer is cleared). Idempotent. */
  function clearAgentCorrelation(correlationId: string): void {
    const entry = agentCorrelations.get(correlationId)
    if (!entry) return
    clearTimeout(entry.timer)
    agentCorrelations.delete(correlationId)
  }

  // ---- Background boot queue (BUG-23) ----
  // BUG-23 root cause: a synthetic's PTY boot was SELECTION-DRIVEN — the only
  // trigger was `TerminalPane`'s `watch(selectedId) → activate()`. A burst of MCP
  // `create_session` calls each overwrote the single `selectedId` scalar, Vue's
  // watcher coalesced the intermediate values, and every synthetic that didn't win
  // the final selection NEVER booted (no PTY, no JSONL, no migrate — an eternal
  // "working" row). This reactive queue decouples boot from selection: every agent
  // synthetic is enqueued here and `TerminalPane` drains it, SERIALLY booting each
  // one in the background (detached, no focus steal) regardless of what is
  // selected. Buffered as a ref so ids enqueued before the pane mounts survive
  // until its `immediate` drain watcher runs.
  const agentBootQueue = ref<string[]>([])

  /** Enqueue a synthetic id for a guaranteed background boot (dedup, FIFO). */
  function enqueueAgentBoot(syntheticId: string): void {
    if (agentBootQueue.value.includes(syntheticId)) return
    agentBootQueue.value = [...agentBootQueue.value, syntheticId]
  }

  /**
   * Drain the pending background-boot ids (clears the queue). Called by
   * `TerminalPane` once it has claimed them into its own serialized runner. A
   * no-op returns the same empty array so the watcher can early-out.
   */
  function takeAgentBoots(): string[] {
    if (agentBootQueue.value.length === 0) return []
    const out = agentBootQueue.value
    agentBootQueue.value = []
    return out
  }

  /** Drop a synthetic id from the pending boot queue (e.g. it was dismissed). */
  function dequeueAgentBoot(syntheticId: string): void {
    if (!agentBootQueue.value.includes(syntheticId)) return
    agentBootQueue.value = agentBootQueue.value.filter((id) => id !== syntheticId)
  }

  // ---- T215 background WAKE queue (`session.wake`) ----
  // Same decoupling as `agentBootQueue` above, and for the same reason: the ONE
  // wake path in the app is `TerminalPane`'s `activate()`, which is driven by
  // selection — and an agent messaging a parked peer must not move the
  // operator's view. This queue lets a wake take the identical
  // `createLiveTerminal` path with no selection at all. Separate from
  // `agentBootQueue` because that one boots SYNTHETICS; a parked session is a
  // real, on-disk one, and folding the two would have meant loosening the
  // synthetic guard for every id in the queue.
  const sessionWakeQueue = ref<string[]>([])

  /**
   * Enqueue a parked session for a background resume (dedup, FIFO). Returns
   * `false` when the id names no session in the model — the caller reports that
   * as a refusal rather than acking a wake that will never happen.
   */
  function enqueueSessionWake(sessionId: string): boolean {
    if (!allSessions.value.some((s) => s.sessionId === sessionId)) return false
    if (!sessionWakeQueue.value.includes(sessionId)) {
      sessionWakeQueue.value = [...sessionWakeQueue.value, sessionId]
    }
    return true
  }

  /** Drain the pending wake ids (clears the queue), for `TerminalPane`'s runner. */
  function takeSessionWakes(): string[] {
    if (sessionWakeQueue.value.length === 0) return []
    const out = sessionWakeQueue.value
    sessionWakeQueue.value = []
    return out
  }

  // ---- Dead-synthetic reaper (BUG-23, armed from every creation path since BUG-37) ----
  // Per-synthetic boot deadline. On fire, if the row is still an unbooted,
  // PTY-less synthetic (`shouldReapAtDeadline`), it is marked visibly FAILED
  // (`taskState:'failed'` + `failureReason:'boot_timeout'`) so it leaves the fleet
  // board's WORKING section and offers Retry / Dismiss — never lingers as working.
  // Armed by `createNewSession`, `dispatchCardSession`, and `insertAgentSession`
  // alike: any unbooted synthetic gets this correction mechanism, regardless of
  // how it was created.
  const agentBootDeadlines = new Map<string, ReturnType<typeof setTimeout>>()

  /** Arm (or re-arm) the boot-timeout reaper for a synthetic id. */
  function armAgentBootDeadline(syntheticId: string): void {
    clearAgentBootDeadline(syntheticId)
    const timer = setTimeout(() => {
      agentBootDeadlines.delete(syntheticId)
      reapSyntheticBoot(syntheticId)
    }, AGENT_BOOT_TIMEOUT_MS)
    agentBootDeadlines.set(syntheticId, timer)
  }

  /** Disarm the boot-timeout reaper for a synthetic id. Idempotent. */
  function clearAgentBootDeadline(syntheticId: string): void {
    const timer = agentBootDeadlines.get(syntheticId)
    if (timer) {
      clearTimeout(timer)
      agentBootDeadlines.delete(syntheticId)
    }
  }

  /**
   * The reaper verdict at the deadline. Two independent failure modes, checked in
   * order:
   *
   *  - No live PTY at all (BUG-23/37, `shouldReapAtDeadline`'s original job): a
   *    dropped boot, surfaced as `boot_timeout`.
   *  - A live PTY — `shouldReapAtDeadline`/`bootVerdict` alone call this "booted"
   *    and stop looking — whose queued pre-prompt was never confirmed delivered
   *    (BUG-60) → `shouldReapUndeliveredPrompt`, reading the SAME T172 ledger
   *    signal BUG-61's injection watchdog consumes. This is a backstop for a
   *    session that boots a live REPL and is never spoken to. On the best-effort
   *    (hooks-off) path the watchdog's own retry budget still resolves in a few
   *    seconds, well inside this 120s deadline. But on the hook-required paste
   *    path, this branch raised `INJECT_HOOK_WAIT_MS` to 30s, and with
   *    `INJECTION_WATCHDOG_MAX_ATTEMPTS = 4` the worst-case aggregate wait (the
   *    initial gate plus four retry gates) is now ~150s — so this 120s reaper CAN
   *    now fire while delivery is still genuinely in flight. That requires BOTH a
   *    prompt long enough to hit every retry AND a session stalled with no JSONL
   *    activity for the full 120s, which is a genuinely broken session either way.
   *    If this balance is ever revisited, `INJECT_HOOK_WAIT_MS` and
   *    `INJECTION_WATCHDOG_MAX_ATTEMPTS` are the two levers — `MAX_ATTEMPTS` is
   *    shared with the best-effort path (2.5s cap there) and must not move for
   *    this reason alone.
   *
   * A migrated (real uuid landed) or removed row is a no-op either way.
   */
  function reapSyntheticBoot(syntheticId: string): void {
    const s = findSessionById(syntheticId)
    if (s === null || s.synthetic !== true) return
    const live = isSessionLive(syntheticId)
    if (live) {
      if (
        s.taskState !== 'failed' &&
        shouldReapUndeliveredPrompt({
          promptQueued: hasAgentPrompt(syntheticId),
          ledgerStatus: injectionLedger.statusFor(syntheticId)
        })
      ) {
        markPromptUndelivered(syntheticId)
      }
      return
    }
    // live is false here — present && !live is the only case shouldReapAtDeadline's
    // three-way verdict still calls 'failed', so this is unconditional.
    markSyntheticBootFailed(syntheticId)
  }

  /**
   * Surface a dropped background boot as a visible FAILED state. Routes through
   * `applyTaskState` so it reuses the red `failed` dot, the board `errored` bucket,
   * and the OS-notification path (a silent fan-out loss is exactly what BUG-23 is
   * about). Guarded to a still-synthetic row so a late fire can't stomp a session
   * that migrated in the meantime.
   */
  function markSyntheticBootFailed(syntheticId: string): void {
    const s = findSessionById(syntheticId)
    if (!s || s.synthetic !== true) return
    applyTaskState(syntheticId, 'failed', { failureReason: 'boot_timeout' })
  }

  /**
   * Surface the injection watchdog's escalation (docs/specs/2026-07-15-preprompt-
   * injection-watchdog.md §5.4): the session's PTY came up live but its queued
   * pre-prompt was never acquired within the retry budget. Distinct from
   * `markSyntheticBootFailed` — the PTY here is genuinely alive, so this must NOT
   * reuse `retrySyntheticBoot` for recovery (see `retryPromptInjection` below).
   * Called from two places: `TerminalPane`'s own injection watchdog (the fast
   * path, seconds after PTY-live) and `reapSyntheticBoot`'s live-PTY branch
   * (BUG-60's 120s backstop, for whenever the fast path never got the chance to
   * run at all).
   *
   * BUG-64 C: also pushes this verdict to main (`window.api.reportPromptUndelivered`)
   * — this function used to ONLY mutate renderer Pinia state, so `get_session`/
   * `get_fleet` had no way to learn a session was stuck; T174's live validation
   * confirmed a session in exactly this state polled back `status: "active"` for
   * its entire observation window.
   */
  function markPromptUndelivered(sessionId: string): void {
    applyTaskState(sessionId, 'failed', { failureReason: 'prompt_undelivered' })
    window.api.reportPromptUndelivered(sessionId)
  }

  /**
   * Retry a boot-failed synthetic: clear the failed state and re-enqueue it for a
   * fresh background boot (+ re-arm the reaper). When nothing is selected we also
   * grab selection so `TerminalPane` mounts to drive the boot; when the operator is
   * already in a session we leave their view untouched (the queue boots it in the
   * background). No-op for a non-synthetic / unknown id.
   *
   * BUG-102: "Retry boot" is a human gesture (SessionMenu), not a background
   * event, so the selection grab must route through `select()` — a direct
   * `selectedId.value = …` here left an open takeover (e.g. the Roadmap board)
   * on screen, and `TerminalPane` — the only thing that drains the boot queue —
   * never mounted behind it, so the retried boot silently never ran.
   */
  function retrySyntheticBoot(syntheticId: string): void {
    const s = findSessionById(syntheticId)
    if (!s || s.synthetic !== true) return
    s.taskState = undefined
    s.failureReason = undefined
    s.status = 'active'
    s.modified = new Date().toISOString()
    enqueueAgentBoot(syntheticId)
    armAgentBootDeadline(syntheticId)
    if (selectedId.value === null) select(syntheticId)
  }

  /** Carry an agent pre-prompt across a synth→real id change. No-op when absent. */
  function carryAgentPrompt(fromId: string, toId: string): void {
    const prompt = pendingAgentPrompts.get(fromId)
    if (prompt === undefined) return
    pendingAgentPrompts.delete(fromId)
    pendingAgentPrompts.set(toId, prompt)
  }

  /**
   * Take (and remove) the pending agent pre-prompt for a session id. Returns
   * `undefined` when none is queued. Called by `TerminalPane` exactly once, after
   * the session's `onSessionReady` fires — so the prompt is injected into a REPL
   * that's actually up, never raced ahead of `claude`'s prompt.
   */
  function takeAgentPrompt(sessionId: string): string | undefined {
    const prompt = pendingAgentPrompts.get(sessionId)
    if (prompt !== undefined) pendingAgentPrompts.delete(sessionId)
    return prompt
  }

  /**
   * Put a consumed pre-prompt BACK on the queue (BUG-85). `acquireInjectionTarget`
   * takes the one-shot prompt before the gate can know whether it will ever get a
   * composer-ready hook; when the gate gives up, this is how the prompt survives
   * for the watchdog's next re-arm and for `retryPromptInjection`. Never
   * overwrites a prompt already queued for this id — a fresher queue entry always
   * wins over one a settling gate is handing back.
   */
  function requeueAgentPrompt(sessionId: string, prompt: string): void {
    if (pendingAgentPrompts.has(sessionId)) return
    pendingAgentPrompts.set(sessionId, prompt)
  }

  /**
   * Non-consuming peek: is a pre-prompt still queued for this session id? Lets the
   * last-mile injection resolve its PTY target BEFORE it commits to consuming the
   * one-shot prompt (`acquireInjectionTarget`) — so a session-ready that can't yet
   * reach a PTY leaves the prompt queued instead of dropping it. Also spares a
   * normal (promptless) session an async PTY resolve on every `sessionReady`.
   */
  function hasAgentPrompt(sessionId: string): boolean {
    return pendingAgentPrompts.has(sessionId)
  }

  /**
   * Retry-handlers registered by panes that own the actual PTY/inject plumbing
   * for a session (today: `TerminalPane`'s injection watchdog). The store cannot
   * re-attempt delivery itself — `armInjectGate` is PTY/xterm-bound thin-shell
   * code — so `retryPromptInjection` clears the failed state and dispatches to
   * these handlers, mirroring the close/migrate/reload handler-registry pattern
   * above. Multi-subscriber for the same reason those are.
   */
  const promptRetryHandlers = new Set<(sessionId: string) => void>()

  function registerPromptRetryHandler(fn: (sessionId: string) => void): () => void {
    promptRetryHandlers.add(fn)
    return () => {
      promptRetryHandlers.delete(fn)
    }
  }

  /**
   * Retry an undelivered pre-prompt (docs/specs/2026-07-15-preprompt-injection-
   * watchdog.md §5.5). Deliberately NOT `retrySyntheticBoot`: that path only
   * usefully re-boots a DEAD synthetic (`drainBgBoot` no-ops on an id whose
   * `liveTerminals` entry already exists and isn't `dead`), but a
   * `prompt_undelivered` session's PTY is genuinely alive — this verdict is only
   * reached once the watchdog's retry budget is exhausted. Only clears state when
   * the CURRENT failure is `prompt_undelivered`, so it never steps on an
   * unrelated failure (e.g. a `boot_timeout` from a different retry path). The
   * prompt itself needs no requeue here — since BUG-61 `acquireInjectionTarget`
   * CONSUMES the one-shot prompt before the gate knows whether delivery will
   * succeed, so `hasAgentPrompt` is only still `true` at this point because
   * BUG-85's `settleWithoutInjecting` hands the prompt back via `requeueAgentPrompt`
   * when the gate gives up. Deleting that requeue would silently re-create BUG-85.
   */
  function retryPromptInjection(sessionId: string): void {
    const s = findSessionById(sessionId)
    if (!s || s.failureReason !== 'prompt_undelivered') return
    s.taskState = undefined
    s.failureReason = undefined
    // BUG-64 C: undo the `markPromptUndelivered` push — a retried session must
    // not keep reporting `failed` to `get_session`/`get_fleet` forever.
    window.api.clearPromptUndelivered(sessionId)
    for (const fn of promptRetryHandlers) {
      fn(sessionId)
    }
  }

  // Haiku auto-name (T25 wave 3) — owned by the `useSessionAutoname` composable.
  // Injects `findSessionById` (to write onto the live row) and the store-owned
  // `bornSyntheticIds`. Destructured so the return object + the init handler
  // reference the same member unchanged.
  const { maybeAutoname } = useSessionAutoname({ findSessionById, bornSyntheticIds })

  /**
   * Notify every pane that a session's id changed (synthetic → real). The PTY
   * does NOT restart — each pane just re-keys its `liveTerminals` map. A handler
   * throwing must never break the model, hence the per-handler try/catch.
   */
  function fireMigrate(fromId: string, toId: string): void {
    if (fromId === toId) return
    // A migrated synthetic booted successfully (it wrote a JSONL) — retire its
    // background-boot bookkeeping so a stale reaper timer never fires on the old id.
    clearAgentBootDeadline(fromId)
    dequeueAgentBoot(fromId)
    if (bornSyntheticIds.delete(fromId)) bornSyntheticIds.add(toId)
    // An agent pre-prompt queued against the synthetic must follow it to the
    // real id so a `session:ready` that arrives post-migrate still injects.
    carryAgentPrompt(fromId, toId)
    // The injection trail (T172) must survive this exact rekey — it's the one
    // signal that can answer "was it actually injected?" post-migrate, and a
    // trail left behind under the stale synthetic id would be unreachable to
    // anyone querying by the real uuid.
    injectionLedger.rekey(fromId, toId)
    for (const fn of migrateHandlers) {
      try {
        fn(fromId, toId)
      } catch {
        /* swallow — never let a pane error break the model */
      }
    }
    // Resync the hook FSM state main recorded while the row was still synthetic
    // (BUG-1a): early hooks were dropped by `findSessionById(realUuid) === null`,
    // and nothing re-applied them at migration. Now that the row is keyed by
    // `toId`, pull main's current state. Fire-and-forget + best-effort (guarded
    // so a missing api / rejection can never break the migration — fireMigrate is
    // critical path); route through `applyTaskState` so a session that BLOCKED
    // during the synthetic window (needs-input) still raises its ping.
    const resync = window.api.hooksStateFor?.(toId)
    if (resync) {
      void resync
        .then((st) => {
          if (st) applyTaskState(toId, st)
        })
        .catch(() => {})
    }
  }

  function getPrefs(sessionId: string): SessionPrefs {
    return prefsBySession.value.get(sessionId) ?? {}
  }

  /**
   * Flip the `noFlicker` flag for one session. The env var (`CLAUDE_CODE_NO_FLICKER`)
   * only takes effect at Claude spawn time, so toggling this does NOT change
   * the running process; callers must recreate the PTY for the new value to
   * take effect. The menu surfaces a hint to that effect.
   */
  function toggleNoFlicker(sessionId: string): void {
    const cur = prefsBySession.value.get(sessionId) ?? {}
    const next: SessionPrefs = { ...cur, noFlicker: !cur.noFlicker }
    // Reassign the Map so Vue reactivity picks up the change in templates.
    const m = new Map(prefsBySession.value)
    m.set(sessionId, next)
    prefsBySession.value = m
  }

  /** Whether this session's boot config carries the `--remote-control` flag. */
  function isSessionRemoteControlOn(sessionId: string): boolean {
    return prefsBySession.value.get(sessionId)?.remoteControl === true
  }

  /**
   * Enable/disable Claude Code's own Remote Control (`--remote-control`, the
   * phone bridge) for one session, then restart it so it relaunches with the new
   * flag — exactly the `reloadSession` mechanism behind "Restart session".
   *
   * Two writes, by design:
   *  1. The session entry's `bootOverride.remoteControl` — the value
   *     `resolveSpawnSpec` snapshots into `ptyCreate` for the `claude --resume`
   *     respawn, where `buildClaudeArgs` turns it into the actual flag. Setting
   *     an explicit `false` (rather than deleting it) ensures a per-session
   *     "off" wins over a global/folder `remoteControl: true` via `mergeBootConfig`.
   *  2. The reload-surviving `prefsBySession` mirror the menu toggle reflects.
   *
   * OPERATOR-ONLY: `remoteControl` lives in `ClaudeBootConfig` but is excluded
   * from the agent `bootOverride` allowlist (`mcp/agent-boot.ts#ALLOWED_KEYS`),
   * so an MCP-spawned agent can never reach this. Non-destructive: the
   * conversation is resumed from the JSONL by `--resume`. No-op for synthetics
   * (no on-disk JSONL to resume) and unknown ids.
   */
  function setSessionRemoteControl(sessionId: string, enabled: boolean): void {
    const entry = findSessionById(sessionId)
    if (!entry || entry.synthetic === true) return

    // 1) Authoritative spawn value on the entry's bootOverride.
    entry.bootOverride = { ...(entry.bootOverride ?? {}), remoteControl: enabled }

    // 2) Reload-surviving mirror for the toggle's on/off reflection.
    const cur = prefsBySession.value.get(sessionId) ?? {}
    const m = new Map(prefsBySession.value)
    m.set(sessionId, { ...cur, remoteControl: enabled })
    prefsBySession.value = m

    // Relaunch so the running `claude` picks up (or drops) `--remote-control`.
    reloadSession(sessionId)
  }

  /** Whether this session is currently promoted to Orchestrator (T98). */
  function isSessionOrchestratorOn(sessionId: string): boolean {
    return orchestratorSessionIds.value.has(sessionId)
  }

  /**
   * Promote/demote a session to Orchestrator (T98), then restart it so the
   * relaunch picks up (or drops) the injected contract — exactly the
   * `reloadSession` mechanic behind `setSessionRemoteControl`. Unlike that
   * one, there is no `bootOverride` field to set: the contract injection is
   * resolved FRESH at every spawn
   * from `orchestrator-guard.ts#isArmed` (`pty.ts`), so arming/disarming the
   * durable `armed.json` entry is the only state that needs to change before
   * the restart. No-op for synthetics (no on-disk JSONL to `--resume`, and no
   * real session id yet to arm) and unknown ids.
   */
  async function toggleOrchestrator(sessionId: string, enabled: boolean): Promise<void> {
    const entry = findSessionById(sessionId)
    if (!entry || entry.synthetic === true) return

    if (enabled) {
      await window.api.orchestratorArm(sessionId, entry.projectPath)
    } else {
      await window.api.orchestratorDisarm(sessionId)
    }

    const next = new Set(orchestratorSessionIds.value)
    if (enabled) next.add(sessionId)
    else next.delete(sessionId)
    orchestratorSessionIds.value = next

    // Relaunch so the running `claude` picks up (or drops) the orchestrator preamble.
    reloadSession(sessionId)
  }

  const allSessions = computed<Session[]>(() => {
    const out: Session[] = []
    for (const folder of folders.value) {
      out.push(...folder.sessions)
    }
    return out
  })

  /** Count of a session's nested sub-agents still RUNNING — the BUG-15 aggregation
   *  input: a parent with a live child counts as working (`fleet-state.ts`). */
  function runningAgentCount(s: Session): number {
    const agents = s.agents
    if (!agents || agents.length === 0) return 0
    let n = 0
    for (const a of agents) if (a.status === 'running') n++
    return n
  }

  /**
   * T92 overlay signals, kept in reactive maps beside `taskState` (which lives on
   * the Session). `registryStates` is the PID-registry task-state per session
   * (`~/.claude/sessions/<pid>.json`), applied BELOW hook `taskState`; `lastEventMs`
   * is the epoch ms of the last hook/registry event per session (the stuck-timer
   * freshness anchor). Both are reassigned (new Map) on update so computeds
   * relying on them re-run.
   */
  const registryStates = ref<Map<string, TaskState>>(new Map())
  const lastEventMs = ref<Map<string, number>>(new Map())

  /**
   * Proof of life (BUG-53) for the `isLive` precondition on `FleetSignals`: a
   * live Harnu PTY (`isSessionLive`) ∪ a PID-registry entry (registry files are
   * PID-keyed and unlinked on process exit, so presence ≈ liveness) ∪ a hook
   * event received in THIS app run (`lastEventMs` is per-run memory — any entry
   * proves current-run life). A session with none of the three is either
   * external-and-quiet or, after a restart, simply dead; its transcript tail then
   * describes how its last turn ENDED, not what it's doing now.
   */
  function isLiveSignal(sessionId: string): boolean {
    return (
      isSessionLive(sessionId) ||
      registryStates.value.has(sessionId) ||
      lastEventMs.value.has(sessionId)
    )
  }

  /** Record an event's timestamp for a session (monotonic — ignore stale). */
  function bumpLastEvent(sessionId: string, ts: number): void {
    if (!Number.isFinite(ts)) return
    const cur = lastEventMs.value.get(sessionId)
    if (cur !== undefined && cur >= ts) return
    const next = new Map(lastEventMs.value)
    next.set(sessionId, ts)
    lastEventMs.value = next
  }

  /** Apply a PID-registry update: set (or clear, on `null`) the registry override
   *  and bump the freshness anchor. */
  function setRegistryState(
    sessionId: string,
    taskState: TaskState | null,
    updatedAt?: number
  ): void {
    const next = new Map(registryStates.value)
    if (taskState === null) next.delete(sessionId)
    else next.set(sessionId, taskState)
    registryStates.value = next
    bumpLastEvent(sessionId, updatedAt ?? Date.now())
  }

  /**
   * Flag a session as parked by the T119 policy (main killed its process). The row stays in
   * the sidebar; the next `activate()` respawns it. Also drops the stale `taskState`, which
   * described a process that no longer exists — a parked session is doing nothing, and
   * leaving a `working` dot on it would be a lie. Also clears any PID-registry overlay
   * (T178 row #13) — that overlay is never cleared on its own, so `isLiveSignal` could
   * otherwise still resolve a dot for a session with no process.
   */
  function markHibernated(sessionId: string): void {
    const s = allSessions.value.find((x) => x.sessionId === sessionId)
    if (!s) return
    s.hibernated = true
    s.taskState = undefined
    setRegistryState(sessionId, null)
  }

  /** Clear the parked flag — the session was woken and has a live PTY again. */
  function clearHibernated(sessionId: string): void {
    const s = allSessions.value.find((x) => x.sessionId === sessionId)
    if (s) s.hibernated = undefined
  }

  /** Resolve a session's canonical live-activity verdict (working / stuck / idle)
   *  via the shared `resolveActivity` — the SAME source the sidebar dot and the
   *  board consume, so every surface agrees. `nowMs` is passed so callers share
   *  one clock read per recompute. */
  function activityOf(s: Session, nowMs: number): FleetActivity {
    return resolveActivity(
      {
        taskState: s.taskState,
        transcriptState: s.transcriptState,
        stagnation: s.stagnation,
        registryState: registryStates.value.get(s.sessionId),
        status: s.status,
        modifiedMs: Date.parse(s.modified),
        liveAgentCount: runningAgentCount(s),
        lastEventMs: lastEventMs.value.get(s.sessionId),
        isLive: isLiveSignal(s.sessionId)
      },
      { nowMs, stuckAfterMs: STUCK_AFTER_MS }
    )
  }

  /**
   * The canonical fleet-state of a session by id (T80 S3 — the live dot on a
   * roadmap card). Reuses the SAME `classifyFleetState` the sidebar dot and
   * `supervisionLoad` read (never a fork), so a card's dot can never disagree with
   * the session's dot elsewhere. `null` when the id is unknown (an unbound card, or
   * a bound session Harnu hasn't loaded yet). Reads `closureNow` so it recomputes on
   * the shared closure tick like the other surfaces.
   */
  function fleetStateFor(sessionId: string): FleetState | null {
    const s = findSessionById(sessionId)
    if (!s) return null
    const now = closureNow.value
    const hasParkedApproval = [...pendingApprovals.value.values()].some(
      (w) => w.sessionId === sessionId
    )
    return classifyFleetState(
      {
        taskState: s.taskState,
        transcriptState: s.transcriptState,
        stagnation: s.stagnation,
        registryState: registryStates.value.get(sessionId),
        status: s.status,
        modifiedMs: Date.parse(s.modified),
        liveAgentCount: runningAgentCount(s),
        lastEventMs: lastEventMs.value.get(sessionId),
        hasParkedApproval,
        lastViewedMs: lastViewedAt(sessionId),
        isViewing: sessionId === selectedId.value,
        isLive: isLiveSignal(sessionId)
      },
      { nowMs: now, stuckAfterMs: STUCK_AFTER_MS, forgottenAfterMs: FORGOTTEN_THRESHOLD_MS }
    )
  }

  // Report live folder terminals to main for the MCP fleet (A2 W6.2). Watched on
  // a stable id|folder signature so it fires on add/remove of a terminal — NOT on
  // every taskState tick (the screen-derived state reaches the fleet separately
  // via `getScreenStates`). Main folds these into the redacted fleet snapshot.
  watch(
    () =>
      allSessions.value
        .filter((s) => s.isShellTerminal)
        .map((s) => `${s.sessionId}|${s.projectPath}`)
        .join('\n'),
    () => {
      const list = allSessions.value
        .filter((s) => s.isShellTerminal)
        .map((s) => ({ sessionId: s.sessionId, folderPath: s.projectPath, modified: s.modified }))
      try {
        window.api.fleetReportShellSessions(list)
      } catch {
        /* main not ready / preload missing in a test — no-op */
      }
    },
    { immediate: true }
  )

  /** Fleet sessions waiting on you (`needs-input`) + parked agent confirms —
   *  drives the window title + OS badge. Parked MCP confirms are fail-CLOSED and
   *  actionable, so they demand attention too (T44 S4c). */
  const attentionCount = computed<number>(
    () =>
      // An archived session must never demand attention (title badge / OS badge).
      countNeedsInput(allSessions.value.filter((s) => !archivedIds.value.has(s.sessionId))) +
      parkedConfirmCount.value
  )

  /** T37: the "return here" set — needs-input sessions you haven't viewed in a
   *  while (and aren't currently viewing). A strict subset of `attentionCount`. */
  const forgottenSessions = computed<Session[]>(() =>
    selectForgotten(allSessions.value, {
      nowMs: closureNow.value,
      thresholdMs: FORGOTTEN_THRESHOLD_MS,
      selectedId: selectedId.value,
      lastViewedAt,
      isArchived: (id) => archivedIds.value.has(id)
    })
  )

  /** "Needs you" total for the Approval Inbox badge (rail header + minimized strip):
   *  parked hook approvals + parked MCP confirms. All are rows in the "Needs you"
   *  tab (unlike the read-only "Would-have" shadow log). */
  const inboxCount = computed<number>(() => pendingApprovalCount.value + parkedConfirmCount.value)

  /** Drives the rail's rising-edge auto-summon (App.vue): a real approval/confirm
   *  force-expands a minimized rail. Currently identical to `inboxCount` — kept as
   *  a separate name so a future informational-only (non-actionable) inbox term
   *  can be added without also changing the auto-summon trigger. */
  const actionableInboxCount = computed<number>(
    () => pendingApprovalCount.value + parkedConfirmCount.value
  )

  /**
   * Supervision load (T67 §3) — how many live sessions are actively on you right
   * now: those the canonical classifier puts in `working` OR `needs-you`. A plain
   * count, derived from the same `classifyFleetState` the dot/board use, surfaced
   * as a discreet number in the footer (no alarm/ceiling in v1). The supervisor
   * study puts the comfortable ceiling around 4–5 concurrent agents. `stuck` and
   * `return-here` are excluded by definition — they are their own signals.
   */
  const supervisionLoad = computed<number>(() => {
    const now = closureNow.value
    const parked = new Set<string>()
    for (const w of pendingApprovals.value.values()) parked.add(w.sessionId)
    let n = 0
    for (const s of allSessions.value) {
      if (s.isSidechain || s.isShellTerminal) continue
      if (archivedIds.value.has(s.sessionId)) continue
      const state = classifyFleetState(
        {
          taskState: s.taskState,
          transcriptState: s.transcriptState,
          stagnation: s.stagnation,
          registryState: registryStates.value.get(s.sessionId),
          status: s.status,
          modifiedMs: Date.parse(s.modified),
          liveAgentCount: runningAgentCount(s),
          lastEventMs: lastEventMs.value.get(s.sessionId),
          hasParkedApproval: parked.has(s.sessionId),
          lastViewedMs: lastViewedAt(s.sessionId),
          isViewing: s.sessionId === selectedId.value,
          isLive: isLiveSignal(s.sessionId)
        },
        { nowMs: now, stuckAfterMs: STUCK_AFTER_MS, forgottenAfterMs: FORGOTTEN_THRESHOLD_MS }
      )
      if (state === 'working' || state === 'needs-you') n++
    }
    return n
  })

  /**
   * The triage queue (T90 — design.md §6). A cross-folder, urgency-ordered
   * list of the sessions that demand you: `needs-you` → `stuck` → `return-here`,
   * each state derived from the canonical `classifyFleetState` (never self-report).
   * Generalizes the T37 RETURN HERE zone with two more states above it.
   *
   * Membership is calm-tech + never times out:
   *  - `needs-you` / `stuck` — shown only while UNACKNOWLEDGED, i.e. you haven't
   *    viewed the session since its last change (`lastViewed < modified`). The `×`
   *    ack (`markSessionSeen` → lastViewed = now) then drops it; a later change
   *    (new output / re-block advances `modified`) re-surfaces it. Nothing leaves
   *    by timeout — only by ack or by the state resolving.
   *  - `return-here` — already gated on the forgotten timer inside the classifier
   *    (you saw it, then ignored it ≥10 min); ack flips it out of forgotten and
   *    the `needs-you` gate excludes it, so it clears too.
   * The session you're viewing is never in the queue.
   */
  const triageQueue = computed<Array<{ session: Session; state: FleetState; quietMs: number }>>(
    () => {
      const now = closureNow.value
      const parked = new Set<string>()
      for (const w of pendingApprovals.value.values()) parked.add(w.sessionId)
      const rank: Record<string, number> = { 'needs-you': 0, stuck: 1, 'return-here': 2 }
      const out: Array<{ session: Session; state: FleetState; quietMs: number }> = []
      for (const s of allSessions.value) {
        if (s.isSidechain || s.isShellTerminal) continue
        if (archivedIds.value.has(s.sessionId)) continue
        if (s.sessionId === selectedId.value) continue
        const state = classifyFleetState(
          {
            taskState: s.taskState,
            transcriptState: s.transcriptState,
            stagnation: s.stagnation,
            registryState: registryStates.value.get(s.sessionId),
            status: s.status,
            modifiedMs: Date.parse(s.modified),
            liveAgentCount: runningAgentCount(s),
            lastEventMs: lastEventMs.value.get(s.sessionId),
            hasParkedApproval: parked.has(s.sessionId),
            lastViewedMs: lastViewedAt(s.sessionId),
            isViewing: false,
            isLive: isLiveSignal(s.sessionId)
          },
          { nowMs: now, stuckAfterMs: STUCK_AFTER_MS, forgottenAfterMs: FORGOTTEN_THRESHOLD_MS }
        )
        if (state !== 'needs-you' && state !== 'stuck' && state !== 'return-here') continue
        const modMs = Date.parse(s.modified)
        // needs-you / stuck are gated on "unseen since last change" so the × ack
        // (which stamps lastViewed = now) removes them. return-here is already
        // gated on the forgotten timer, so it passes through.
        if (state !== 'return-here' && lastViewedAt(s.sessionId) >= modMs) continue
        out.push({ session: s, state, quietMs: Number.isFinite(modMs) ? now - modMs : 0 })
      }
      return out.sort((a, b) => rank[a.state] - rank[b.state])
    }
  )

  const selectedSession = computed<Session | null>(() =>
    selectedId.value
      ? (allSessions.value.find((s) => s.sessionId === selectedId.value) ?? null)
      : null
  )

  /**
   * T212 — the folder every folder-scoped action operates on: the explicitly
   * selected folder, else the folder of the selected session. Before this,
   * Roadmap / PR Stack / Browse files / VS Code / Open folder / shell all read
   * `selectedSession?.projectPath`, which made six folder-level actions
   * unreachable in a folder with no sessions.
   */
  const activeFolderPath = computed<string | null>(
    () => selectedFolderPath.value ?? selectedSession.value?.projectPath ?? null
  )

  const selectedPath = computed<{ folder: string } | null>(() => {
    if (!selectedId.value) return null
    for (const folder of folders.value) {
      if (folder.sessions.some((s) => s.sessionId === selectedId.value)) {
        return { folder: folder.alias }
      }
    }
    return null
  })

  /**
   * Substring matcher with case-insensitive normalization. Used by the inline
   * filter (spec §5.2 — filter overrides zones).
   */
  function matchesFilter(s: string, q: string): boolean {
    if (!q) return true
    return s.toLowerCase().includes(q.toLowerCase())
  }

  /** Build the zone-classification context fresh from current state. */
  function buildClassifyCtx(): ClassifyCtx {
    return {
      nowMs: Date.now(),
      activeWindowMs: activeWindowMs.value,
      hiddenPaths: manuallyHiddenPaths.value,
      livePtySessionIds: livePtySessionIds.value
    }
  }

  /**
   * Folders whose inline-filter match should override the zone layout. A
   * folder matches when its alias, git branch, filesystem PATH, or any
   * session's summary / firstPrompt / displayed name (`sessionTitle`) contains
   * the query. Empty query ⇒ no
   * filtering (returns [] and the zone computeds take over).
   *
   * The path was added by T288: the jump palette matches on it, and `⇥` hands
   * the palette's query straight to this filter — a query that found a folder
   * by its path must not come up empty the moment it is applied to the tree.
   */
  const filteredFolders = computed<Folder[]>(() => {
    const q = filterQuery.value.trim()
    if (!q) return []
    return folders.value.filter((f) => {
      if (matchesFilter(f.alias, q)) return true
      if (f.gitBranch && matchesFilter(f.gitBranch, q)) return true
      if (matchesFilter(f.path, q)) return true
      for (const s of f.sessions) {
        if (matchesFilter(s.summary, q)) return true
        if (matchesFilter(s.firstPrompt, q)) return true
        // BUG-78: also the name the row shows (Haiku title, fork label, teammate).
        if (matchesFilter(sessionTitle(s, allSessions.value, i18n.global.t), q)) return true
      }
      return false
    })
  })

  /**
   * The single flat sidebar list (BUG-39 — replaces the old `pinnedZone` +
   * `activeZone` split): every visible folder (pinned ∪ active, minus hidden)
   * classified, sorted, grouped by shared repo (`groupByRepo`), then by shared
   * DIRECT parent directory (`groupByParentDir`, T182) — all in ONE pass.
   *
   * The single pass is the duplicate-header fix: the old two independent
   * `groupByRepo` calls (one per zone) each produced their own group header for
   * a repo with members split across both zones; one combined pass yields
   * exactly one. Both stages emit the same `FolderGroup` node, and neither ever
   * puts a group inside a group — that's what caps the list at one level of
   * indentation (T70's anti-VS-Code rule).
   *
   * When the inline filter is active it overrides classification entirely: all
   * matching folders render here regardless of pinned/active status (spec §5.2).
   */
  const visibleFolders = computed<Array<Folder | FolderGroup<Folder>>>(() => {
    // An active filter forces every group open (a collapsed group would hide
    // matches): pass no collapsed set.
    if (filterQuery.value.trim())
      return groupByParentDir(
        groupByRepo(
          sortFolders(filteredFolders.value, folderSort.value),
          undefined,
          groupAliases.value
        ),
        undefined,
        groupAliases.value
      )
    const ctx = buildClassifyCtx()
    return groupByParentDir(
      groupByRepo(
        sortFolders(
          folders.value.filter((f) => {
            const status = classifyFolder(f, ctx)
            return status === 'pinned' || status === 'active'
          }),
          folderSort.value
        ),
        collapsedGroups.value,
        groupAliases.value
      ),
      collapsedGroups.value,
      groupAliases.value
    )
  })

  // ── Always-listed git worktrees (T388, sidebar-liveness spec §4.B B2) ──────

  /**
   * Latest `git worktree list` per tracked repo, pushed by main's worktree
   * tracker (`worktrees:changed`). Replaced wholesale on every push so readers
   * see a new Map. Entries for repos that leave the known-repo set are pruned.
   */
  const gitWorktrees = shallowRef(new Map<string, TrackedWorktreeWire[]>())
  /** repoIds of the last set sent to `worktreesTrack`; pushes for others are ignored. */
  let trackedRepoIds = new Set<string>()
  /**
   * Disk + user-project paths of the last merge — what `stripGitListings` needs
   * to tell a git placeholder from a real (possibly sessionless) folder.
   */
  let lastBasePaths: ReadonlySet<string> = new Set()

  function gitListings(): GitListing[] {
    return [...gitWorktrees.value].map(([repoId, worktrees]) => ({ repoId, worktrees }))
  }

  /**
   * Re-apply the current listings to the live folders without a disk read (a
   * worktree push must never cost a `foldersLoad`): drop stale placeholders and
   * flags, re-flag, inject new placeholders, then reconcile in place.
   */
  function applyWorktreeListings(): void {
    commitFolders(applyGitListings(stripGitListings(folders.value, lastBasePaths), gitListings()))
  }

  function onWorktreesChanged({ repoId, entries }: WorktreesChangedEvent): void {
    // A late emit for a repo we already dropped must not resurrect its rows.
    if (!trackedRepoIds.has(repoId)) return
    const next = new Map(gitWorktrees.value)
    next.set(repoId, Array.isArray(entries) ? entries : [])
    gitWorktrees.value = next
    applyWorktreeListings()
  }

  /**
   * The known-repo set (D3): repos with a folder that is pinned (user-project
   * placeholders included) or classifies active ON ITS OWN SESSIONS — the
   * classification runs with `gitListed` ignored, so a repo's git-listed rows
   * never keep the repo itself tracked. Ordered by priority (pinned repos, then
   * active ones) because main tracks only the first 64 (B1).
   */
  const knownRepos = computed<TrackedRepoWire[]>(() => {
    const ctx = buildClassifyCtx()
    const members = new Map<string, string[]>()
    const mainPath = new Map<string, string>()
    const pinnedIds: string[] = []
    const activeIds: string[] = []
    for (const f of folders.value) {
      if (!f.repoId) continue
      const zone = classifyFolder({ ...f, gitListed: false }, ctx)
      if (zone === 'pinned') pinnedIds.push(f.repoId)
      else if (zone === 'active') activeIds.push(f.repoId)
      // A git placeholder came FROM the listing; it is not a known spelling (D9).
      if (f.gitListed && f.sessions.length === 0 && !f.pinned) continue
      const list = members.get(f.repoId)
      if (list) list.push(f.path)
      else members.set(f.repoId, [f.path])
      if (f.isMainWorktree && !mainPath.has(f.repoId)) mainPath.set(f.repoId, f.path)
    }
    const out: TrackedRepoWire[] = []
    const seen = new Set<string>()
    for (const repoId of [...pinnedIds, ...activeIds]) {
      if (seen.has(repoId)) continue
      seen.add(repoId)
      const memberPaths = members.get(repoId) ?? []
      const probePath = mainPath.get(repoId) ?? memberPaths[0]
      if (!probePath) continue
      out.push({ repoId, probePath, memberPaths })
    }
    return out
  })

  /** Order-insensitive identity of a tracked set — a reorder alone is not re-sent. */
  function trackKey(repos: TrackedRepoWire[]): string {
    return JSON.stringify(
      repos.map((r) => [r.repoId, r.probePath, [...r.memberPaths].sort()]).sort()
    )
  }
  let lastTrackKey = trackKey([])
  const TRACK_DEBOUNCE_MS = 500
  let trackTimer: ReturnType<typeof setTimeout> | null = null

  /** Send the current known-repo set when it changed; prune listings of dropped repos. */
  function syncTrackedRepos(): void {
    if (typeof window === 'undefined' || typeof window.api?.worktreesTrack !== 'function') return
    const repos = knownRepos.value
    const key = trackKey(repos)
    if (key === lastTrackKey) return
    lastTrackKey = key
    trackedRepoIds = new Set(repos.map((r) => r.repoId))
    const kept = new Map([...gitWorktrees.value].filter(([id]) => trackedRepoIds.has(id)))
    if (kept.size !== gitWorktrees.value.size) {
      gitWorktrees.value = kept
      applyWorktreeListings()
    }
    void window.api.worktreesTrack(repos).catch((err: unknown) => {
      console.warn('[sessions] worktreesTrack failed:', err)
    })
  }

  // Debounced 500 ms from the FIRST change (never slid by later ones), so a
  // steady stream of session updates cannot starve the send; the timer reads
  // the latest set when it fires.
  watch(knownRepos, (repos) => {
    if (trackTimer || trackKey(repos) === lastTrackKey) return
    trackTimer = setTimeout(() => {
      trackTimer = null
      syncTrackedRepos()
    }, TRACK_DEBOUNCE_MS)
  })

  /** Test-only: the repoIds last sent to `worktreesTrack`. */
  function __knownReposForTests(): string[] {
    return [...trackedRepoIds]
  }

  /**
   * Tiers whose bucket sorts oldest-waiting-first (Fleet rail, T151 — "the
   * most neglected surfaces on top"), the inverse of `buildBoard`'s default
   * most-recent-first. Applies to every `boardBuckets` consumer (not just the
   * rail) — `buildBoard`/`fleet-board.ts` itself stays untouched; this
   * re-sorts its output per bucket.
   */
  const ASCENDING_TIME_TIERS: ReadonlySet<BoardState> = new Set(['needs-input', 'errored', 'stuck'])

  function oldestFirst(sessions: readonly BoardSession[]): BoardSession[] {
    return [...sessions].sort((a, b) => {
      const am = Date.parse(a.modified)
      const bm = Date.parse(b.modified)
      const ak = Number.isFinite(am) ? am : Infinity
      const bk = Number.isFinite(bm) ? bm : Infinity
      return ak - bk
    })
  }

  /**
   * Fleet status board projection (fleet-status-board spec §4.3): the same
   * `folders` data the zones read, re-grouped by session state into urgency
   * buckets. Resolves `folderAlias` once per folder, drops sidechains, honours
   * the inline `filterQuery` per-card, then delegates ordering/grouping to the
   * pure `buildBoard`. Orthogonal to the zones — never touches folder-zones.ts.
   */
  const boardBuckets = computed<BoardBucket[]>(() => {
    const q = filterQuery.value.trim()
    const now = closureNow.value // dep: recompute on the 30s tick so `stuck` ages in
    const slices: BoardSession[] = []
    for (const f of folders.value) {
      for (const s of f.sessions) {
        if (s.isSidechain) continue
        // Folder terminals are not Claude sessions — they never appear on the
        // by-state board.
        if (s.isShellTerminal) continue
        // Archived sessions are "put away" everywhere else in the sidebar
        // (hidden from the tree, excluded from attentionCount) — keep them out
        // of the board too, so archiving still removes a session from view.
        if (archivedIds.value.has(s.sessionId)) continue
        if (q) {
          const hit =
            matchesFilter(f.alias, q) ||
            (f.gitBranch ? matchesFilter(f.gitBranch, q) : false) ||
            matchesFilter(s.summary, q) ||
            matchesFilter(s.firstPrompt, q) ||
            matchesFilter(sessionTitle(s, allSessions.value, i18n.global.t), q)
          if (!hit) continue
        }
        slices.push({
          sessionId: s.sessionId,
          taskState: s.taskState,
          transcriptState: s.transcriptState,
          status: s.status,
          isSidechain: s.isSidechain,
          modified: s.modified,
          activity: activityOf(s, now),
          folderAlias: f.alias
        })
      }
    }
    return buildBoard(slices).map((bucket) =>
      ASCENDING_TIME_TIERS.has(bucket.state)
        ? { state: bucket.state, sessions: oldestFirst(bucket.sessions) }
        : bucket
    )
  })

  /**
   * Folders the user explicitly dismissed (matches `manuallyHiddenPaths`
   * against the current `folders`). Drives the "Hidden" list in
   * `SidebarHiddenPopover.vue`.
   */
  const dismissedFolders = computed<Folder[]>(() =>
    folders.value.filter((f) => manuallyHiddenPaths.value.has(f.path))
  )

  /** Build the per-folder session-age filter context (session-age-filter spec §4). */
  function buildWindowCtx(folder: Folder): WindowCtx {
    return {
      nowMs: Date.now(),
      windowMs: sessionWindowMs.value,
      searchActive: filterQuery.value.trim() !== '',
      revealed: revealedOlderPaths.value.has(folder.path),
      selectedId: selectedId.value,
      livePtySessionIds: livePtySessionIds.value
    }
  }

  /**
   * Sessions within a folder, age-filtered then ordered by the current sort
   * preference (display only — never mutates `folder.sessions`).
   */
  function sessionsForDisplay(folder: Folder): Session[] {
    const ctx = buildWindowCtx(folder)
    const archivedRevealed = revealedArchivedPaths.value.has(folder.path)
    const visible = folder.sessions.filter((s) => {
      // Folder terminals are NOT Claude sessions — they render in their own
      // "Terminals" sub-group (`terminalsForFolder`), never the session list.
      if (s.isShellTerminal) return false
      // Archived sessions are pulled out of the normal flow entirely — shown
      // only when the folder's archived peek is open, regardless of age.
      if (archivedIds.value.has(s.sessionId)) return archivedRevealed
      return keepSession(s, ctx)
    })
    return sortSessions(visible, sessionSort.value)
  }

  /**
   * Candidate pool for the T99 teammate-lead lookup (`teammate-grouping.ts`) —
   * every non-terminal, non-archived session in the folder, IGNORING the age
   * window that `sessionsForDisplay` applies. A team lead's own activity
   * typically goes idle the moment its teammates start working (it dispatched
   * them and is waiting), so an age-filtered pool would drop the lead out from
   * under its own team the instant it stops being "recent" — even though its
   * session still exists, in the same folder, right where its teammates are.
   * Archived is still respected: that's an explicit user action, unlike the
   * implicit age cutoff.
   */
  function teammateLeadCandidates(folder: Folder): Session[] {
    const archivedRevealed = revealedArchivedPaths.value.has(folder.path)
    return folder.sessions.filter((s) => {
      if (s.isShellTerminal) return false
      if (archivedIds.value.has(s.sessionId)) return archivedRevealed
      return true
    })
  }

  /**
   * How many of a folder's sessions the age window would hide, IGNORING the
   * per-folder reveal toggle — so the count stays stable whether or not the
   * folder is currently revealed (drives the "Show N older" row, spec §5).
   * `0` when the window is "All" or a search is active.
   */
  function olderSessionCount(folder: Folder): number {
    const ctx: WindowCtx = { ...buildWindowCtx(folder), revealed: false }
    // Archived sessions are surfaced by their own "Show N archived" row, so they
    // must not be double-counted as "older" here. Folder terminals are never
    // "older" — they live in their own sub-group, not the age-filtered list.
    return folder.sessions.reduce(
      (n, s) =>
        s.isShellTerminal || archivedIds.value.has(s.sessionId) || keepSession(s, ctx) ? n : n + 1,
      0
    )
  }

  /** Whether a folder's older sessions are currently revealed (spec §5). */
  function isOlderRevealed(path: string): boolean {
    return revealedOlderPaths.value.has(path)
  }

  /** Toggle the ephemeral "show older sessions" reveal for one folder. */
  function toggleRevealOlder(path: string): void {
    const next = new Set(revealedOlderPaths.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    revealedOlderPaths.value = next
  }

  function countSessions(folder: Folder): number {
    // Archived sessions are "put away" — exclude them from the folder badge.
    // Folder terminals are not sessions, so they never count toward the badge.
    return folder.sessions.reduce(
      (n, s) => (s.isShellTerminal || archivedIds.value.has(s.sessionId) ? n : n + 1),
      0
    )
  }

  /**
   * The folder's shell terminals (`createFolderTerminal`), oldest-first by
   * creation so their displayed index (`Terminal 1`, `Terminal 2`, …) is stable
   * as more are opened. Rendered in the sidebar's "Terminals" sub-group, never
   * the normal session list (`sessionsForDisplay` filters them out).
   */
  function terminalsForFolder(folder: Folder): Session[] {
    return folder.sessions
      .filter((s) => s.isShellTerminal === true)
      .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0))
  }

  /**
   * Select a session — the USER-INTENT path (a sidebar row, a palette result, an
   * approval row, a board card). Picking a session means "show me that session",
   * so any main-pane takeover covering the transcript (board, PR Stack, Cleanup,
   * Usage Dashboard, System Monitor) yields first.
   *
   * Deliberately scoped to this function: the ~14 programmatic
   * `selectedId.value = …` assignments (synth→real migration, spawn, closure
   * fallbacks) keep their direct write, so a background reconcile can never yank
   * an open view out from under the operator.
   */
  function select(id: string): void {
    useUiStore().closeAllTakeovers()
    selectedId.value = id
    selectedFolderPath.value = null
  }

  /** T212 — select a FOLDER, which opens its `FolderView` in the main pane. */
  function selectFolder(path: string): void {
    selectedFolderPath.value = path
    selectedId.value = null
  }

  function clearSelection(): void {
    selectedId.value = null
    selectedFolderPath.value = null
  }

  /**
   * Reveal a folder in the sidebar after a CLI-driven adoption (`harnu .` — T69 fix):
   * expand it (so its sessions show) and raise the `revealFolderPath` signal the
   * Sidebar watches to scroll the row into view. No-op for an unknown path — the
   * folder may not have merged into the model yet, in which case the caller retries
   * after a reload. Deliberately does NOT select a session (which would resume/spawn
   * a PTY); it only brings the folder into view.
   */
  function revealFolder(path: string): void {
    const folder = findFolderByPath(path)
    if (folder) folder.expanded = true
    revealFolderPath.value = path
  }

  /** Consume the reveal signal once the Sidebar has scrolled to the folder. */
  function clearRevealFolder(): void {
    revealFolderPath.value = null
  }

  /** Consume the session reveal signal once the Sidebar has scrolled to the row. */
  function clearRevealSession(): void {
    revealSessionId.value = null
  }

  // --- Jump palette (T288) --------------------------------------------------

  /** Cap on the persisted recent-search list (spec: "last 8 queries"). */
  const JUMP_SEARCHES_CAP = 8

  /** Cap on the persisted recently-visited list (spec: "last 5 folders"). */
  const JUMP_VISITS_CAP = 5

  /**
   * Raise the one-shot flash signal for a row a jump just landed on.
   * `Sidebar.vue` owns the actual paint (the row components belong to other
   * units) — it resolves the token to a DOM node and runs `.anim-jump-flash`.
   */
  function raiseJumpFlash(token: string): void {
    jumpFlashSeq += 1
    jumpFlash.value = { token, seq: jumpFlashSeq }
  }

  /** Consume the flash signal once `Sidebar.vue` has started the animation. */
  function clearJumpFlash(): void {
    jumpFlash.value = null
  }

  /**
   * Record that the operator landed on a folder — by jumping to it, or by
   * selecting any session inside it. Most-recent-first, de-duplicated, capped.
   */
  function recordJumpVisit(path: string): void {
    const next = [path, ...recentJumpVisits.value.filter((p) => p !== path)]
    recentJumpVisits.value = next.slice(0, JUMP_VISITS_CAP)
  }

  /**
   * Record a jump-palette query and the hit counts it produced. A query that
   * found nothing is NOT recorded — the history is a shortcut list, and an
   * entry that leads to an empty palette is worse than no entry.
   */
  function recordJumpSearch(entry: RecentJumpSearch): void {
    const query = entry.query.trim()
    if (!query) return
    if (entry.folders + entry.hidden + entry.sessions === 0) return
    const next = [{ ...entry, query }, ...recentJumpSearches.value.filter((e) => e.query !== query)]
    recentJumpSearches.value = next.slice(0, JUMP_SEARCHES_CAP)
  }

  /** Drop the whole recent-search list (the palette eyebrow's "clear" action). */
  function clearJumpSearches(): void {
    recentJumpSearches.value = []
  }

  /**
   * Jump to a FOLDER: OPEN it (select it, so its `FolderView` renders in the
   * main pane — "search means take me there", not "highlight it in the tree"),
   * expand the repo group it renders under, expand the folder itself, re-target
   * the drill-in stack when drill-in is on, then raise the scroll-into-view +
   * flash signals `Sidebar.vue` consumes.
   *
   * The selection closes any open takeover for the same reason `select()` does:
   * a takeover renders BEFORE `FolderView` in `App.vue`'s chain, so leaving one
   * up would land the jump behind it and the palette would look dead.
   *
   * The session twin of this is plain `select(sessionId)` — the
   * `watch(selectedId)` below already does the expand + re-drill + reveal for
   * EVERY selection, so a session jump must not duplicate any of it (see
   * `jumpToSession`).
   */
  function jumpToFolder(path: string): void {
    const folder = findFolderByPath(path)
    if (!folder) return
    useUiStore().closeAllTakeovers()
    selectFolder(path)
    for (const node of visibleFolders.value) {
      if (isFolderGroup(node) && node.folders.some((f) => f.path === path)) {
        collapsedGroupsSet.delete(node.key)
        break
      }
    }
    folder.expanded = true
    if (drillModeEnabled.value) {
      drillStack.value = drillNodeStackForFolder(path)
    }
    recordJumpVisit(path)
    revealFolderPath.value = path
    raiseJumpFlash(`folder:${path}`)
  }

  /**
   * Jump to a SESSION. `select()` carries the whole reveal contract already
   * (expand group + folder + teammate group, re-drill, scroll into view, record
   * the visit); this only adds the flash on top.
   */
  function jumpToSession(sessionId: string): void {
    if (!findSessionById(sessionId)) return
    select(sessionId)
    raiseJumpFlash(`session:${sessionId}`)
  }

  /**
   * Unhide a dismissed folder, then jump to it — the palette's "Unhide & go"
   * chip. The unhide has to settle before the jump: the folder does not render
   * in the tree (and `visibleFolders` does not carry its group) while it is
   * still on the hidden list.
   */
  async function unhideAndJump(path: string): Promise<void> {
    await unhideFolder(path)
    await nextTick()
    jumpToFolder(path)
  }

  /**
   * Hand the palette's query to the tree filter — the `⇥` fallback for when the
   * operator does want a narrowed tree rather than a jump target.
   */
  function applyQueryAsFilter(q: string): void {
    setFilterActive(true)
    setFilterQuery(q)
  }

  /**
   * Tear down a session's live terminal AND remove it from the in-memory
   * model. For v1 this is in-memory only — the JSONL on disk and the entry
   * in `sessions-index.json` are NOT touched.
   */
  function closeSession(sessionId: string): void {
    for (const fn of closeHandlers) {
      try {
        fn(sessionId)
      } catch {
        /* swallow — never let a teardown error block model removal */
      }
    }
    unregisterLiveSession(sessionId)
    dropArchived(sessionId)
    // Retire any pending background-boot bookkeeping (BUG-23): a dismissed dead
    // synthetic must not later boot from the queue or trip the reaper.
    clearAgentBootDeadline(sessionId)
    dequeueAgentBoot(sessionId)
    // BUG-59: forget its (possibly still-unarmed) correlation meta too — a
    // dismissed synthetic must never later arm a boot window for a row that's
    // gone.
    agentCorrelationMeta.delete(sessionId)
    for (const folder of folders.value) {
      const idx = folder.sessions.findIndex((s) => s.sessionId === sessionId)
      if (idx !== -1) {
        folder.sessions.splice(idx, 1)
        if (selectedId.value === sessionId) {
          // T212 — land on the folder's view rather than the global EmptyState: the
          // operator closed a session, not the folder they were working in.
          selectedId.value = null
          selectedFolderPath.value = folder.path
        }
        const t = idleTimers.get(sessionId)
        if (t) {
          clearTimeout(t)
          idleTimers.delete(sessionId)
        }
        return
      }
    }
  }

  /**
   * Restart a session's running `claude` process WITHOUT removing its row.
   * Fires the registered reload handlers (the owning pane kills the PTY and
   * respawns `claude --resume <uuid>`), so the relaunch picks up anything
   * `claude` only reads at startup — a freshly-installed skill, an edited
   * `settings.json`, a new MCP server. The conversation is preserved on disk
   * (the JSONL), so `--resume` restores it. No-op for a session with no live
   * PTY (nothing to restart). Each handler guards against an unknown id, so
   * firing for a session a given pane doesn't own is harmless.
   */
  function reloadSession(sessionId: string): void {
    for (const fn of reloadHandlers) {
      try {
        fn(sessionId)
      } catch {
        /* swallow — never let one pane's teardown error block the others */
      }
    }
  }

  /**
   * Archive a session: mark it archived (persisted) and tear down its live
   * terminal, KEEPING the row in the model so it can be restored. Unlike Delete,
   * the JSONL on disk is untouched — Unarchive brings the session back exactly
   * as it was. Reversible, so no `window.confirm`. No-op for synthetics (they
   * have no JSONL yet) and already-archived ids.
   */
  function archiveSession(sessionId: string): void {
    if (archivedIds.value.has(sessionId)) return
    // Put-away semantics: stop the live terminal (same teardown as closeSession)
    // but DON'T splice the row — it stays in the model for Unarchive.
    for (const fn of closeHandlers) {
      try {
        fn(sessionId)
      } catch {
        /* swallow — never let a teardown error block archiving */
      }
    }
    unregisterLiveSession(sessionId)
    archivedIdsSet.add(sessionId)
    if (selectedId.value === sessionId) selectedId.value = null
  }

  /**
   * Drop a session id from the archived set (+ persist). Shared by
   * `unarchiveSession` and the removal/delete paths so a deleted-from-disk
   * session never leaves an orphaned id behind. No-op when not archived.
   */
  function dropArchived(sessionId: string): void {
    if (!archivedIds.value.has(sessionId)) return
    archivedIdsSet.delete(sessionId)
  }

  /** Reverse an archive — the session reappears in normal display. Idempotent. */
  function unarchiveSession(sessionId: string): void {
    dropArchived(sessionId)
  }

  /** Whether a folder's archived sessions are currently revealed. */
  function isArchivedRevealed(path: string): boolean {
    return revealedArchivedPaths.value.has(path)
  }

  /** Toggle the ephemeral "show archived sessions" reveal for one folder. */
  function toggleRevealArchived(path: string): void {
    const next = new Set(revealedArchivedPaths.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    revealedArchivedPaths.value = next
  }

  /** Count of a folder's archived sessions (drives the "Show N archived" row). */
  function archivedSessionCount(folder: Folder): number {
    return folder.sessions.reduce((n, s) => (archivedIds.value.has(s.sessionId) ? n + 1 : n), 0)
  }

  /** Locate the folder hosting `path`. */
  function findFolderByPath(path: string): Folder | null {
    return folders.value.find((f) => f.path === path) ?? null
  }

  /** Last `'/'`-delimited segment, trailing slashes stripped (mirrors `folder-zones.ts`'s). */
  function basenameOfPath(p: string): string {
    if (!p) return ''
    return p.replace(/\/+$/, '').split('/').pop() ?? ''
  }

  /**
   * Insert a freshly-adopted folder into the live model SYNCHRONOUSLY, straight
   * from the `adopted` payload `worktreeCreate`'s own IPC response already
   * carries (BUG-40 §3.1) — instead of the caller waiting on the 250ms
   * `reloadModelDebounced()` roundtrip {@link onFolderAdopted} normally goes
   * through. A caller that needs to `dispatchCardSession` into a folder it JUST
   * created (`RoadmapBoard.vue`'s `spawnAndBind`) calls this first so
   * `findFolderByPath` sees it at t=0 — closing the race that used to return a
   * silent `null` and orphan the worktree on every retry.
   *
   * Idempotent: a folder already present (a real reload landed first, or this is
   * called twice) is returned as-is, never duplicated. Mirrors
   * `userProjectToFolder`'s placeholder shape: empty `sessions`, `pinned: true`
   * (`adoptFolder` always persists a create as a pinned user project), `alias`
   * derived from the path basename. A later `onFolderAdopted` reload still runs
   * and reconciles/enriches this placeholder exactly like any other adopted
   * folder — this function only wins the race for the FIRST synchronous lookup.
   */
  function registerFolderImmediate(payload: FolderAdoptedPayload): Folder {
    const existing = findFolderByPath(payload.path)
    if (existing) return existing
    const folder: Folder = {
      path: payload.path,
      alias: basenameOfPath(payload.path),
      sessions: [],
      expanded: false,
      pinned: true
    }
    if (payload.gitBranch !== undefined) folder.gitBranch = payload.gitBranch
    if (payload.repoId !== undefined) folder.repoId = payload.repoId
    if (payload.isMainWorktree !== undefined) folder.isMainWorktree = payload.isMainWorktree
    folders.value.push(folder)
    const meta = pickGitMeta(payload)
    if (meta) adoptedGitByPath.set(payload.path, meta)
    return folder
  }

  /**
   * Create a synthetic session entry for a folder (U-1.5). The entry lives in
   * `folder.sessions[]` like a real one but carries `synthetic: true` and a
   * locally-generated `synthetic-<uuid>` id so TerminalPane spawns `claude`
   * (no args) in `folder.path` instead of `claude --resume <uuid>`.
   *
   * Dedupe rule (per task brief): only one LIVE synthetic per folder at a time.
   * Calling this on a folder that already has a still-alive (pending/booting)
   * synthetic just re-selects the existing entry and returns its id rather than
   * stacking another. A DEAD synthetic — its `claude` process already exited,
   * `taskState` is `completed` or `failed` (e.g. the user hit Ctrl+C, BUG-24, or
   * a boot timed out, BUG-23) — is excluded from the dedupe: it has nothing left
   * to reuse, so reselecting it forever would trap "+ New session" in a loop the
   * user can never escape. The dead row is left in place (Dismiss/Retry in
   * `SessionMenu.vue` still recover it); a fresh synthetic is minted alongside it.
   *
   * Returns the synthetic's id (or the reused live one on dedupe), or `null` if
   * `folderPath` doesn't match anything in the current `folders` model.
   *
   * Arms the dead-synthetic reaper (`armAgentBootDeadline`, BUG-23/BUG-37) so a
   * boot that silently drops here — same as any other creation path — surfaces
   * as visibly FAILED instead of lingering in the fleet board's WORKING section
   * forever.
   */
  function createNewSession(
    folderPath: string,
    bootOverride?: ClaudeBootConfig,
    mode?: string
  ): string | null {
    const folder = findFolderByPath(folderPath)
    if (!folder) return null

    // Dedupe: surface the existing LIVE synthetic instead of spawning a second.
    // A dead one (completed/failed) is skipped — see doc comment above.
    const existing = folder.sessions.find(
      (s) => s.synthetic === true && s.taskState !== 'completed' && s.taskState !== 'failed'
    )
    if (existing) {
      folder.expanded = true
      // BUG-102 — a "+ New session" click is a focus intent: route through the
      // shared primitive so it closes any open takeover too, not just the folder
      // selection.
      select(existing.sessionId)
      return existing.sessionId
    }

    const sessionId = `synthetic-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const synthetic: Session = {
      sessionId,
      fullPath: '',
      fileMtime: Date.now(),
      firstPrompt: '',
      summary: '',
      messageCount: 0,
      created: now,
      modified: now,
      gitBranch: folder.gitBranch ?? '',
      projectPath: folder.path,
      isSidechain: false,
      status: 'active',
      resumable: true,
      bridged: false,
      synthetic: true,
      // T215: the OPERATOR asked for this one ("+ New session"), so an agent
      // may not inject peer messages into it.
      spawnedBy: 'operator',
      // One-shot launch overrides from the New session dialog. Only attach when
      // the user actually set something, so the common case stays a bare synthetic.
      ...(bootOverride && Object.keys(bootOverride).length ? { bootOverride } : {}),
      // T123: the mode this session was born in, if any (`Modes ▸ Learning`).
      ...(mode ? { mode } : {})
    }
    // Insert at the top so it appears immediately above the real sessions.
    folder.sessions.unshift(synthetic)
    bornSyntheticIds.add(sessionId)
    folder.expanded = true
    // BUG-102 — same focus intent as the dedupe branch above: the operator asked
    // for a session, so every takeover and the folder view must step aside.
    select(sessionId)
    // Arm the boot-timeout reaper (BUG-37): any unbooted synthetic gets a
    // correction mechanism, regardless of which path created it.
    armAgentBootDeadline(sessionId)
    return sessionId
  }

  /**
   * Dispatch a roadmap card (T80 S1 §3.3): mint a FRESH plain synthetic in
   * `folderPath` and queue `prePrompt` for the shared last-mile injection (T62/T75)
   * — the same `pendingAgentPrompts` path an agent-created session uses, consumed
   * once by `TerminalPane` on `pty:sessionReady` so it lands in a REPL that is
   * actually up. Unlike {@link createNewSession} this does NOT dedupe (a dispatch
   * is always a new, intentional session) and unlike {@link insertAgentSession} it
   * is NOT agent-controlled — a HUMAN clicked Dispatch, so the session gets full
   * permissions + the normal `--mcp-config` (no downgrade). The card↔session bind
   * (`session:` + `in-progress` in the card frontmatter) is written by the caller
   * via the human `roadmap:bindSession` IPC.
   *
   * BUG-40 §3.2: returns a discriminated {@link DispatchCardSessionResult} — a
   * NAMED reason on failure, not a bare `null` a caller could only report as a
   * generic toast. The one failure mode today is an unknown `folderPath`; for a
   * worktree dispatch that should never happen once the caller registers the
   * folder via {@link registerFolderImmediate} BEFORE calling this (closes the
   * race this bug was filed for).
   *
   * `bootOverride` (T97): the `{ model, effort }` resolved by the per-repo
   * routing table (kind → table → hardcoded default), attached to the synthetic
   * exactly like {@link createNewSession}'s one-shot override — `spawn-spec.ts`
   * already forwards a plain synthetic's `bootOverride` to the spawn, so no
   * further plumbing is needed downstream.
   *
   * Arms the dead-synthetic reaper (`armAgentBootDeadline`, BUG-23/BUG-37) so a
   * boot that silently drops here — same as any other creation path — surfaces
   * as visibly FAILED instead of lingering in the fleet board's WORKING section
   * forever.
   */
  function dispatchCardSession(
    folderPath: string,
    prePrompt: string,
    bootOverride?: ClaudeBootConfig,
    opts?: { select?: boolean }
  ): DispatchCardSessionResult {
    const folder = findFolderByPath(folderPath)
    if (!folder) return { ok: false, reason: `FOLDER_NOT_FOUND: ${folderPath}` }

    const sessionId = `synthetic-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const synthetic: Session = {
      sessionId,
      fullPath: '',
      fileMtime: Date.now(),
      firstPrompt: '',
      summary: '',
      messageCount: 0,
      created: now,
      modified: now,
      gitBranch: folder.gitBranch ?? '',
      projectPath: folder.path,
      isSidechain: false,
      status: 'active',
      resumable: true,
      bridged: false,
      synthetic: true,
      // T215: a board/manifest dispatch is agent-driven work, so it IS a valid
      // recipient. Deliberately broader than `agentControlled`, which this path
      // does not set — using that marker instead would have left every
      // manifest-dispatched session unreachable.
      spawnedBy: 'agent',
      ...(bootOverride && Object.keys(bootOverride).length ? { bootOverride } : {})
    }
    folder.sessions.unshift(synthetic)
    bornSyntheticIds.add(sessionId)
    const trimmedPrompt = prePrompt.trim()
    if (trimmedPrompt.length > 0 && trimmedPrompt.length <= AGENT_PREPROMPT_ARGV_MAX_CHARS) {
      synthetic.bootOverride = { ...synthetic.bootOverride, prePrompt: trimmedPrompt }
    } else if (trimmedPrompt.length > 0) {
      pendingAgentPrompts.set(sessionId, prePrompt)
    }
    folder.expanded = true
    // T113: the background drain spawns with `select: false` — selection is how
    // a MANUAL dispatch boots (TerminalPane activates on select), but the drain
    // must never steal focus; its caller queues the boot via `enqueueAgentBoot`.
    if (opts?.select !== false) {
      // BUG-102 — focusing the dispatched session means every takeover and the
      // folder view must yield the main pane.
      select(sessionId)
    }
    // Arm the boot-timeout reaper (BUG-37): any unbooted synthetic gets a
    // correction mechanism, regardless of which path created it.
    armAgentBootDeadline(sessionId)
    return { ok: true, sessionId }
  }

  /** True iff Harnu already knows about an (exact-path) folder. Router-injected. */
  function folderExists(path: string): boolean {
    return findFolderByPath(path) !== null
  }

  /**
   * Report a synth→real migrate to main (ADR-0003) so a `create_session` ACK
   * parked in `awaitMaterialization` can claim `ok:true` (BUG-59: also called
   * from the fallback recency migrate in `collapseSyntheticInto`, not just the
   * correlation-bound `tryBindAgentMigration`, so the signal doesn't depend
   * solely on the correlation window surviving). Best-effort and always safe:
   * a missing/old preload API must never break the migration itself, and
   * main's `notifyMaterialized` is a no-op when nobody is awaiting this
   * syntheticId (e.g. a plain user synthetic, never dispatched via MCP).
   */
  function reportMaterialized(syntheticId: string, sessionId: string, folder: string): void {
    try {
      window.api.notifySessionMaterialized?.({ syntheticId, sessionId, folder })
    } catch {
      /* never let a main-process report break the renderer-side migration */
    }
  }

  /**
   * Insert an MCP agent-created synthetic (T16/T25). The fresh `AgentSession`
   * (minted by `makeAgentSession` in the renderer command router) lands in its
   * folder's session list like a user "+ New session" — but via a DISTINCT,
   * NON-deduped path: it never reuses the folder's existing user synthetic, and
   * its synth→real migrate is bound by `correlationId` (see `tryBindAgentMigration`)
   * rather than the recency heuristic. The row is enqueued for a BACKGROUND boot
   * (`enqueueAgentBoot`) — `TerminalPane` drains the queue and spawns `claude`
   * serially, decoupled from selection (BUG-23: a burst of creates used to race on
   * the single `selectedId` scalar so trailing boots were dropped). That launch is
   * what writes the JSONL the bound migrate then upgrades to. An optional
   * `prePrompt` is queued for `onSessionReady`-gated injection by `TerminalPane`.
   * A reaper is armed so a boot that never produces a PTY surfaces as FAILED
   * instead of lingering as "working". No-op if the folder has gone (the router
   * validated existence, but the model can move between IPC and actuation).
   */
  function insertAgentSession(
    agent: AgentSession,
    prePrompt?: string,
    bootOverride?: { model?: string; effort?: string }
  ): void {
    const folder = findFolderByPath(agent.folderPath)
    if (!folder) return

    const now = new Date().toISOString()
    const synthetic: Session = {
      sessionId: agent.syntheticId,
      fullPath: '',
      fileMtime: Date.now(),
      firstPrompt: '',
      summary: '',
      messageCount: 0,
      created: now,
      modified: now,
      gitBranch: folder.gitBranch ?? '',
      projectPath: folder.path,
      isSidechain: false,
      status: 'active',
      resumable: true,
      bridged: false,
      synthetic: true,
      // Security: this is the agent's own session → the spawn must withhold the
      // app `--mcp-config` and force-downgrade permissions (BLOCKER-1 fix).
      agentControlled: true,
      // T215: an agent brought this session into being, so it is in
      // `message_session`'s recipient scope from its first turn.
      spawnedBy: 'agent',
      // T33-A′: the allowlisted capacity knobs (model/effort) the spawn applies.
      ...(bootOverride && Object.keys(bootOverride).length ? { bootOverride } : {})
    }
    folder.sessions.unshift(synthetic)
    folder.expanded = true

    // Record the token-bound migrate's metadata so the right synthetic (this
    // agent's, never a coexisting user one) is upgraded when its JSONL lands.
    // BUG-59: the window itself is armed later, at boot (`armAgentCorrelationForBoot`)
    // — not here at enqueue, which under a serial fan-out routinely expired
    // before the queued boot even started.
    agentCorrelationMeta.set(agent.syntheticId, {
      correlationId: agent.correlationId,
      folderPath: agent.folderPath
    })
    const trimmedPrompt = prePrompt?.trim()
    if (trimmedPrompt && trimmedPrompt.length <= AGENT_PREPROMPT_ARGV_MAX_CHARS) {
      synthetic.bootOverride = { ...synthetic.bootOverride, prePrompt: trimmedPrompt }
    } else if (trimmedPrompt) {
      pendingAgentPrompts.set(agent.syntheticId, prePrompt as string)
    }

    // BUG-23: boot is QUEUED, not selection-driven. Enqueue a guaranteed
    // background boot (TerminalPane drains + serializes it) and arm the reaper so a
    // boot that never produces a PTY within the deadline surfaces as FAILED rather
    // than lingering as "working". We only grab selection when the operator has
    // NOTHING selected — that usually mounts TerminalPane so the queue can run,
    // without stealing an active view; an agent fan-out must never yank the
    // operator's focus (T78). When a session IS selected, TerminalPane is already
    // mounted and the queue boots this synthetic detached in the background.
    //
    // Deliberately a bare write, never `select()`. `select()` would close
    // whatever takeover the operator is looking at, which is precisely the
    // focus theft T78 forbids for an agent-driven spawn (see the AC-7 case in
    // `tests/folder-selection.test.ts`). BUG-103 fixed the cost this used to
    // carry: `TerminalPane` (and `takeAgentBoots()`, the queue's only consumer)
    // used to exist only while it won an `App.vue` `v-if`/`v-else-if` chain, so
    // a boot enqueued while a takeover was open sat until the operator
    // dismissed it and could trip `armAgentBootDeadline` as `boot_timeout`
    // first. `TerminalPane` now renders unconditionally (merely covered,
    // never unmounted, by whichever view is foreground — see App.vue's
    // `showTerminalForeground`), so this grab drains the queue regardless of
    // what the operator is currently looking at.
    enqueueAgentBoot(agent.syntheticId)
    armAgentBootDeadline(agent.syntheticId)
    if (selectedId.value === null) selectedId.value = agent.syntheticId
  }

  /**
   * Try to migrate THIS folder's oldest armed agent synthetic to a freshly-landed
   * real uuid, binding by correlation token (`bindMigration`, T16) — not by the
   * recency heuristic the user path uses. Builds candidates from the folder's
   * current synthetics (tagging each with its correlation token when agent-minted)
   * so a coexisting user synthetic is left untouched. Performs the in-place
   * migrate (same row, same PTY via `fireMigrate`) and returns `true` when it
   * bound, so `reconcileSessionAdded` can skip the user path entirely. Returns
   * `false` when no correlation is armed for the folder (the common case).
   */
  function tryBindAgentMigration(folder: Folder, realUuid: string): boolean {
    // Oldest armed correlation for this folder (Map preserves insertion order).
    let correlationId: string | null = null
    for (const [cid, entry] of agentCorrelations) {
      if (entry.folderPath === folder.path) {
        correlationId = cid
        break
      }
    }
    if (!correlationId) return false

    const synthToCorr = new Map<string, string>()
    for (const [cid, entry] of agentCorrelations) synthToCorr.set(entry.syntheticId, cid)
    const candidates: SyntheticCandidate[] = folder.sessions
      .filter((s) => s.synthetic === true)
      .map((s) => {
        const cid = synthToCorr.get(s.sessionId)
        return cid ? { syntheticId: s.sessionId, correlationId: cid } : { syntheticId: s.sessionId }
      })

    const bound = bindMigration(correlationId, candidates, realUuid)
    clearAgentCorrelation(correlationId)
    if ('error' in bound) return false

    const synth = folder.sessions.find((s) => s.sessionId === bound.boundSyntheticId)
    if (!synth) return false
    const oldId = synth.sessionId
    synth.sessionId = realUuid
    synth.synthetic = false
    synth.forkSourceId = undefined
    agentCorrelationMeta.delete(oldId)
    if (selectedId.value === oldId) selectedId.value = realUuid
    fireMigrate(oldId, realUuid)
    // D8: same in-place swap as `collapseSyntheticInto` — wait for model evidence.
    awaitingConfirm.set(realUuid, {
      folderPath: folder.path,
      since: Date.now(),
      seq: ++coverageSeq
    })
    // BUG-88: same in-place identity swap as `collapseSyntheticInto` — the
    // row's disk metadata (fullPath/summary/firstPrompt/messageCount) is
    // still blank at this point, backfill it immediately.
    void backfillMigratedSessionMeta(realUuid)
    // This card (ADR-0003): this is THE materialization moment for an MCP
    // `create_session` — a real, on-disk session (the reader already found
    // `realUuid` via the disk-scan reconciliation that triggered this call) now
    // exists for the agent's own synthetic. Report it to main so `create_session`'s
    // ACK — parked in `awaitMaterialization` — can finally claim `ok:true`.
    reportMaterialized(oldId, realUuid, folder.path)
    return true
  }

  /**
   * Create a synthetic placeholder for a fork of an existing session.
   * Mirrors `createNewSession`'s shape but:
   *   - takes a sourceSessionId (the session to fork from), not a folderPath
   *     (the folder is inherited from the source's `projectPath`)
   *   - carries `forkSourceId` so `TerminalPane` spawns with kind
   *     `'claude-fork'` + `claudeSessionId: forkSourceId`
   *   - does NOT dedupe (unlike `createNewSession`): forks ARE meant to stack
   *
   * Returns the synthetic's id (a `synthetic-<uuid>` string), or `null` when
   * the source session can't be located in the current model.
   */
  function createForkedSession(sourceSessionId: string): string | null {
    for (const folder of folders.value) {
      const source = folder.sessions.find((s) => s.sessionId === sourceSessionId)
      if (!source) continue
      // Source must have a real JSONL — synthetics can't be forked.
      if (source.synthetic === true) return null

      const sessionId = `synthetic-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      const synthetic: Session = {
        sessionId,
        fullPath: '',
        fileMtime: Date.now(),
        firstPrompt: '',
        summary: '',
        messageCount: 0,
        created: now,
        modified: now,
        gitBranch: source.gitBranch,
        projectPath: source.projectPath,
        isSidechain: false,
        status: 'active',
        resumable: true,
        bridged: false,
        synthetic: true,
        // T215: a fork is a human gesture (the session context menu), so the
        // resulting session is the operator's, not an agent's.
        spawnedBy: 'operator',
        forkSourceId: sourceSessionId
      }
      folder.sessions.unshift(synthetic)
      bornSyntheticIds.add(sessionId)
      folder.expanded = true
      // BUG-102 — a fork is a focus intent too; route through `select()` so it
      // closes any open takeover and never leaves a folder selection behind.
      select(sessionId)
      return sessionId
    }
    return null
  }

  /**
   * Shared dispatcher for the ⌘N shortcut and the palette's "New session"
   * action (U-1.5). Resolves the most sensible folder for a fresh session:
   *   1. `activeFolderPath` — the explicit folder selection, else the selected
   *      session's folder (BUG-102: a folder selected with no session used to
   *      fall straight through to `folders.value[0]`, minting in the wrong repo).
   *   2. The first folder.
   *   3. None — emits a console warning and returns null.
   *
   * Returns the resolved session id (or null) so the caller can chain.
   */
  function newSessionInCurrentContext(): string | null {
    const active = activeFolderPath.value
    if (active) return createNewSession(active)

    const first = folders.value[0]
    if (first) return createNewSession(first.path)

    console.warn('[session.new] no folder selected — add a folder first')
    return null
  }

  /**
   * Create a **folder terminal** — a plain shell bound to the folder's cwd, for
   * running git / builds / worktree commands without Claude. Unlike
   * `createNewSession`, the entry is deliberately NOT `synthetic`: it carries an
   * explicit `isShellTerminal: true` marker and a distinct `shellterm-<uuid>` id,
   * so it never enters the synthetic→real migration / collapse / auto-name /
   * slug-reconcile paths (lesson 003) and `resolveSpawnSpec` resolves it to kind
   * `'shell'`. It is `resumable: true` (a shell trivially "is" its own live
   * process — this also keeps it out of the cloud-stub panel) but writes no JSONL.
   *
   * Terminals STACK (no dedupe — a folder can host several) and are ephemeral:
   * they survive a renderer reload (re-injected like a synthetic, keyed by the
   * empty `fullPath`) but not a full app restart. Returns the new id, or `null`
   * when `folderPath` doesn't match anything in the current model.
   */
  function createFolderTerminal(folderPath: string): string | null {
    const folder = findFolderByPath(folderPath)
    if (!folder) return null

    const sessionId = `shellterm-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const terminal: Session = {
      sessionId,
      fullPath: '',
      fileMtime: Date.now(),
      firstPrompt: '',
      summary: '',
      messageCount: 0,
      created: now,
      modified: now,
      gitBranch: folder.gitBranch ?? '',
      projectPath: folder.path,
      isSidechain: false,
      status: 'active',
      resumable: true,
      bridged: false,
      synthetic: false,
      isShellTerminal: true
    }
    folder.sessions.push(terminal)
    folder.expanded = true
    // BUG-102 — opening a folder terminal is a focus intent too: it was the one
    // mint site `select()` never reached, so it alone left a takeover or the
    // folder view stuck on top of the freshly-opened shell.
    select(sessionId)
    return sessionId
  }

  /**
   * Close a folder terminal: tear down its live shell PTY and remove the entry.
   * Delegates to `closeSession` (fires the registered close handlers so
   * `TerminalPane` disposes the PTY, then splices the row + clears selection).
   * Kept as a named entry point so the sidebar's per-terminal X reads clearly
   * and a future terminal-specific teardown has one place to live.
   */
  function closeFolderTerminal(sessionId: string): void {
    closeSession(sessionId)
  }

  /**
   * Drop a folder's ephemeral older/archived peek reveals. Called whenever a
   * folder collapses so the inline reveal cluster (folder row, spec 2026-06-24)
   * never shows a stale "revealed" accent on a closed folder, and re-opening a
   * folder starts from the age-filtered default instead of auto-showing a peek
   * the user opened and then closed.
   */
  function forgetPeeks(path: string): void {
    if (revealedOlderPaths.value.has(path)) {
      const next = new Set(revealedOlderPaths.value)
      next.delete(path)
      revealedOlderPaths.value = next
    }
    if (revealedArchivedPaths.value.has(path)) {
      const next = new Set(revealedArchivedPaths.value)
      next.delete(path)
      revealedArchivedPaths.value = next
    }
  }

  function toggleFolder(path: string): void {
    const f = findFolderByPath(path)
    if (!f) return
    f.expanded = !f.expanded
    if (!f.expanded) forgetPeeks(path)
  }

  /**
   * Toggle a group's collapse by namespaced key (and persist). Hides/shows the group's
   * member-folder ROWS behind its header — a SEPARATE piece of state from each
   * member folder's own `expanded` flag (which controls that folder's session
   * list). Collapsing the group leaves every inner folder's session-list state
   * untouched, so re-expanding the group restores exactly what was open before
   * (BUG: previously this flipped members' `expanded`, so clicking the group
   * header wrongly expanded/collapsed the inner folders' sessions instead).
   */
  function toggleGroup(key: string): void {
    collapsedGroupsSet.toggle(key)
  }

  /** Expand every folder's session list (spec §5 — expand all). */
  function expandAll(): void {
    for (const f of folders.value) f.expanded = true
  }

  /** Collapse every folder. Companion to `expandAll`. */
  function collapseAll(): void {
    for (const f of folders.value) {
      f.expanded = false
      forgetPeeks(f.path)
    }
  }

  /**
   * Pin a folder: add it to `projects.json#projects[]` AND unhide it — pinning
   * something you're actively hiding should surface it. This is a one-way
   * surfacing action, not an invariant: `pinned` and `hidden` CAN coexist
   * (e.g. right after `dismissFolder`, or a pinned folder hidden directly) —
   * `hidden` always wins at render time regardless of `pinned` (BUG-39; see
   * `classifyFolder`'s branch order: hidden > pinned > active > stale).
   * Mirrors the returned `hiddenPaths` back into the local Set, then reloads
   * so the merge re-flags `pinned`.
   */
  async function pinFolder(path: string): Promise<void> {
    const folder = findFolderByPath(path)
    const alias = folder?.alias ?? path.replace(/\/+$/, '').split('/').pop() ?? path
    const entry: UserProject = {
      path,
      alias,
      addedAt: new Date().toISOString(),
      worktrees: []
    }
    // Probe git at pin time so the persisted record carries repoId/gitBranch/
    // isMainWorktree (T70A). Without it, a worktree pinned before Claude wrote a
    // sessions-index.json under it never groups under its repo — `groupByRepo`
    // keys on `repoId`, and a placeholder record has none. The probe is cached
    // 60 s in main, so a folder the scan already probed is a cache hit; a
    // non-repo path just comes back empty and the folder stays a standalone.
    const meta = (await probePathsGitMeta([path])).get(path)
    if (meta) {
      if (meta.repoId !== undefined) entry.repoId = meta.repoId
      if (meta.gitBranch !== undefined) entry.gitBranch = meta.gitBranch
      if (meta.isMainWorktree !== undefined) entry.isMainWorktree = meta.isMainWorktree
    }
    await window.api.userProjectsAdd(entry)
    // Unhide so the invariant holds (D6).
    if (manuallyHiddenPaths.value.has(path)) {
      const payload = await window.api.userProjectsUnhide(path)
      manuallyHiddenPaths.value = new Set(payload.hiddenPaths)
    }
    await reloadModel()
  }

  /**
   * Dismiss a folder: mark its path hidden. Does NOT unpin (BUG-39 fix) — a
   * pinned folder can now be hidden while remaining pinned underneath, so
   * `unhideFolder` correctly restores it as pinned afterward instead of
   * relocating it into "active" (or dropping it entirely, if it had gone
   * stale while hidden). `hidden` always wins at render time regardless of
   * `pinned` (see `classifyFolder`'s branch order). Mirrors the returned
   * `hiddenPaths` locally.
   */
  async function dismissFolder(path: string): Promise<void> {
    const payload = await window.api.userProjectsHide(path)
    manuallyHiddenPaths.value = new Set(payload.hiddenPaths)
    await reloadModel()
  }

  /**
   * Reverse a dismissal. Removes the path from `hiddenPaths` on disk and
   * locally. Idempotent.
   */
  async function unhideFolder(path: string): Promise<void> {
    const payload = await window.api.userProjectsUnhide(path)
    manuallyHiddenPaths.value = new Set(payload.hiddenPaths)
  }

  /**
   * BLOCK (or unblock) agents in a folder — the per-folder opt-out of the
   * free-by-default posture. Writes the `agentDenied` flag through
   * `userProjectsSetAgentDenied` and mirrors the resulting denylist back into
   * `agentDeniedPaths` so the folder context-menu toggle and the Settings list stay
   * in lockstep. Returns the updated pinned-project list for callers that render it.
   */
  async function setFolderAgentDenied(path: string, denied: boolean): Promise<UserProject[]> {
    const payload = await window.api.userProjectsSetAgentDenied(path, denied)
    agentDeniedPaths.value = new Set(
      payload.projects.filter((p) => p.agentDenied).map((p) => p.path)
    )
    return payload.projects
  }

  /**
   * Put a folder on (or take it off) the Approval Inbox trust ramp (T30). Writes
   * the `interceptActive` flag through `userProjectsSetInterceptActive` and mirrors
   * the resulting list back into `interceptFolders` so the Folder context-menu
   * toggle and the Settings ramp list stay in lockstep. Returns the updated
   * pinned-project list for callers that render it.
   */
  async function setFolderInterceptActive(path: string, allowed: boolean): Promise<UserProject[]> {
    const payload = await window.api.userProjectsSetInterceptActive(path, allowed)
    interceptFolders.value = new Set(
      payload.projects.filter((p) => p.interceptActive).map((p) => p.path)
    )
    return payload.projects
  }

  /**
   * Rename a folder's sidebar label (T52). Persists the alias via
   * `userProjectsSetAlias` (which creates a pinned record for an auto-discovered
   * folder, or resets to the basename on a blank alias) and reloads so
   * `mergeFolders` re-applies the override. Optimistic: the in-memory folder's
   * alias is updated first so the row renames instantly, before the reload lands.
   */
  async function renameFolder(path: string, alias: string): Promise<void> {
    const folder = findFolderByPath(path)
    if (folder) {
      const trimmed = alias.trim()
      folder.alias =
        trimmed ||
        (path
          .replace(/[/\\]+$/, '')
          .split(/[/\\]/)
          .pop() ??
          path)
    }
    await window.api.userProjectsSetAlias(path, alias)
    await reloadModel()
  }

  /**
   * Toggle the per-folder "use branch name as label" auto-alias opt-in (T52).
   * Writes the `aliasFromBranch` flag through `userProjectsSetAliasFromBranch` and
   * mirrors the resulting set back into `aliasFromBranchPaths` so the Folder
   * context-menu toggle and the label derivation stay in lockstep.
   */
  async function setFolderAliasFromBranch(path: string, enabled: boolean): Promise<UserProject[]> {
    const payload = await window.api.userProjectsSetAliasFromBranch(path, enabled)
    aliasFromBranchPaths.value = new Set(
      payload.projects.filter((p) => p.aliasFromBranch).map((p) => p.path)
    )
    return payload.projects
  }

  /**
   * Toggle the per-folder "new sessions start as Orchestrator" default
   * (T344). Writes the `orchestratorDefault` flag through
   * `userProjectsSetOrchestratorDefault` and mirrors the resulting set back
   * into `orchestratorDefaultPaths` so the Folder context-menu toggle and the
   * sidebar row indicator stay in lockstep. EXACT-PATH ONLY (AC-5) — never
   * touches any other folder, worktree or not.
   */
  async function setFolderOrchestratorDefault(
    path: string,
    enabled: boolean
  ): Promise<UserProject[]> {
    const payload = await window.api.userProjectsSetOrchestratorDefault(path, enabled)
    orchestratorDefaultPaths.value = new Set(
      payload.projects.filter((p) => p.orchestratorDefault).map((p) => p.path)
    )
    return payload.projects
  }

  /**
   * Toggle the per-repo "auto-organize conversation into draft cards" opt-out
   * (T106/D6). Writes the `autoOrganizeCards` flag through
   * `userProjectsSetAutoOrganize` and mirrors the resulting OFF set back into
   * `autoOrganizeOffPaths`. Per REPO only — `FolderMenu.vue` never offers
   * this entry for a linked worktree, which inherits its main worktree's
   * value server-side instead.
   */
  async function setFolderAutoOrganize(path: string, enabled: boolean): Promise<UserProject[]> {
    const payload = await window.api.userProjectsSetAutoOrganize(path, enabled)
    autoOrganizeOffPaths.value = new Set(
      payload.projects.filter((p) => p.autoOrganizeCards === false).map((p) => p.path)
    )
    return payload.projects
  }

  /** Whether `path`'s auto-organize toggle is currently ON (default ON — see `autoOrganizeOffPaths`). */
  function isFolderAutoOrganizeOn(path: string): boolean {
    return !autoOrganizeOffPaths.value.has(path)
  }

  /**
   * T191: manually set (or clear) a worktree's `bornFrom` lineage edge — the
   * folder menu's "Set parent folder" / "Clear parent folder". Persists via
   * `userProjectsSetBornFrom` then reloads so `mergeFolders` re-applies the
   * edge onto the in-memory `Folder`: unlike `agentDenied`/`aliasFromBranch`,
   * `bornFrom` lives directly on `Folder` (see its own doc comment), not a
   * side-channel Set, so there's nothing to mirror optimistically here.
   */
  async function setFolderBornFrom(path: string, bornFrom: string | null): Promise<void> {
    await window.api.userProjectsSetBornFrom(path, bornFrom)
    await reloadModel()
  }

  /**
   * T191: sibling worktrees of `path`'s repo, eligible as a manual `bornFrom`
   * target (the "Set parent folder" submenu). Empty when `path` has no
   * `repoId` (not a git folder). Delegates to the main process so the
   * candidate list is correct even for a sibling this store hasn't loaded yet.
   */
  async function listBornFromCandidates(
    path: string
  ): Promise<Array<{ path: string; alias: string }>> {
    const folder = findFolderByPath(path)
    const repoId = folder?.repoId
    if (!repoId) return []
    return window.api.userProjectsListBornFromCandidates(repoId, path)
  }

  /** Set + persist the session-sort preference (spec §7). */
  function setSessionSort(mode: SessionSortMode): void {
    sessionSort.value = mode
  }

  /** Set + persist the folder-sort preference (folder-sort spec §4). */
  function setFolderSort(mode: FolderSortMode): void {
    folderSort.value = mode
  }

  /** Set + persist the sidebar density preset (design.md §4 "Row density"). */
  function setSidebarDensity(density: SidebarDensity): void {
    sidebarDensity.value = density
  }

  /**
   * Set + persist the active-elsewhere window. Clamps to the {24h, 48h, 7d}
   * preset set; an unknown value falls back to the 48h default.
   */
  function setActiveWindow(ms: number): void {
    const clamped = (ACTIVE_WINDOW_PRESETS as readonly number[]).includes(ms)
      ? ms
      : DEFAULT_ACTIVE_WINDOW_MS
    activeWindowMs.value = clamped
  }

  /**
   * Set + persist the session-age window (session-age-filter spec §3). Clamps to
   * the {All, 24h, 48h, 7d} preset set; an unknown value falls back to 48h.
   */
  function setSessionWindow(ms: number): void {
    const clamped = clampSessionWindow(ms)
    sessionWindowMs.value = clamped
  }

  /**
   * Set the inline filter substring. The header morph state (`filterActive`)
   * is controlled separately by `setFilterActive`.
   */
  function setFilterQuery(q: string): void {
    filterQuery.value = q
  }

  /**
   * Open / close the inline filter header morph. Closing it also clears the
   * query so a fresh open doesn't pre-populate.
   */
  function setFilterActive(v: boolean): void {
    filterActive.value = v
    if (!v) filterQuery.value = ''
  }

  // --- Sidebar keyboard cursor (T-4.6) --------------------------------------
  // Owned by the `useSidebarCursor` composable (T25 wave 4): it walks the visible
  // tree and moves the cursor over it. High read-coupling but strictly
  // one-directional — the `visibleFolders` computed, display helpers, and
  // select/toggle actions are all injected. `findFolderBySessionId` stays in
  // the store (also used by `activateSession`) and is injected here.
  const {
    keyboardCursor,
    cursorDown,
    cursorUp,
    cursorRight,
    cursorLeft,
    cursorActivate,
    setCursorToSession
  } = useSidebarCursor({
    visibleFolders,
    sessionsForDisplay,
    terminalsForFolder,
    findFolderByPath,
    findFolderBySessionId,
    select,
    selectFolder,
    isFolderSelected: (path: string) => selectedFolderPath.value === path,
    toggleFolder,
    toggleGroup
  })

  /** Locate `{ folder }` for a session UUID. */
  function findFolderBySessionId(sessionId: string): Folder | null {
    for (const f of folders.value) {
      if (f.sessions.some((s) => s.sessionId === sessionId)) return f
    }
    return null
  }

  // --- IPC-backed helpers ----------------------------------------------------

  /**
   * Find a folder by the disk slug. The watcher keeps slug-keyed event payloads
   * (a deliberate deviation from spec §8 which suggested rekeying events).
   *
   * Resolution is **lossless-first** (`resolveFolderPathBySlug`): it matches the
   * folder that owns any real session JSONL under `<slug>/`, falling back to the
   * lossy slug→path decode only as a last resort. Decoding alone silently fails
   * for any folder whose path contains a literal `-` (e.g. a
   * `TASK-1234-…` worktree), which previously made `reconcileSessionAdded` bail
   * and leave a duplicated synthetic "New session" row
   * (`docs/lessons/synthetic-sessions/003`).
   */
  function findFolderBySlugOrPath(slug: string): Folder | null {
    const path = resolveFolderPathBySlug(slug, folders.value)
    return path ? (folders.value.find((f) => f.path === path) ?? null) : null
  }

  /** Locate a session by uuid across all folders — globally unique. */
  function findSessionById(sessionId: string): Session | null {
    for (const f of folders.value) {
      const s = f.sessions.find((x) => x.sessionId === sessionId)
      if (s) return s
    }
    return null
  }

  /** Resolve a session's owning folder alias (for the notification body). */
  function folderAliasOf(sessionId: string): string {
    for (const f of folders.value) {
      if (f.sessions.some((s) => s.sessionId === sessionId)) return f.alias || f.path
    }
    return ''
  }

  /**
   * Focus a session — clear an active filter that would hide it, move the
   * keyboard cursor onto it, then select it. Expanding the owning folder,
   * group, and teammate group, plus raising the scroll-into-view
   * signal, is no longer done here: the `watch(selectedId, …)` below does
   * that for every selection, not just this "jump to session" entry point
   * (reactive-sidebar-sync, 2026-07-19 — see docs/specs/2026-07-19-sidebar-drill-in-navigation.md).
   */
  function activateSession(sessionId: string): void {
    const session = findSessionById(sessionId)
    if (!session) return
    const folder = findFolderBySessionId(sessionId)
    if (folder && filterQuery.value.trim() && !filteredFolders.value.includes(folder)) {
      setFilterQuery('')
    }
    setCursorToSession(sessionId)
    select(sessionId)
  }

  /** Find the `FolderGroup` (if any) currently rendering under a namespaced group key. */
  function groupInVisible(key: string): FolderGroup<Folder> | null {
    for (const node of visibleFolders.value) {
      if (isFolderGroup(node) && node.key === key) return node
    }
    return null
  }

  /**
   * Resolve the drill-in screen path for a session's folder: `[group, folder]`
   * when the folder renders under a group, else `[folder]`. Shared by
   * `cycleDrillDepth` (jump-on-enable) and the auto re-drill branch of the
   * `selectedId` watcher below.
   */
  function drillNodeStackForSession(sessionId: string): DrillNode[] {
    const folder = findFolderBySessionId(sessionId)
    if (!folder) return []
    for (const node of visibleFolders.value) {
      if (isFolderGroup(node) && node.folders.some((f) => f.path === folder.path)) {
        return [
          { kind: 'group', key: node.key },
          { kind: 'folder', path: folder.path }
        ].slice(0, drillDepth.value) as DrillNode[]
      }
    }
    return [{ kind: 'folder', path: folder.path }].slice(0, drillDepth.value) as DrillNode[]
  }

  /**
   * The folder-grain twin of {@link drillNodeStackForSession} (T288): the
   * drill-in screen path for a folder itself, `[group, folder]` when it renders
   * under a group and `[folder]` otherwise. Same depth clamp, so depth 1 stops
   * on the owning group screen (where the folder renders inline).
   */
  function drillNodeStackForFolder(path: string): DrillNode[] {
    for (const node of visibleFolders.value) {
      if (isFolderGroup(node) && node.folders.some((f) => f.path === path)) {
        return [
          { kind: 'group', key: node.key },
          { kind: 'folder', path }
        ].slice(0, drillDepth.value) as DrillNode[]
      }
    }
    return [{ kind: 'folder', path }].slice(0, drillDepth.value) as DrillNode[]
  }

  /**
   * Advance the drill-in depth one step, wrapping `0 → 1 → 2 → 0`. Entering a
   * non-zero level with a session selected drills straight to that session's
   * screen for the new depth (the resolver clamps, so depth 1 stops at the
   * owning group and the folder expands inline there). Lowering the depth
   * truncates the stack so the operator is never left on a screen the new
   * level cannot reach.
   */
  function cycleDrillDepth(): void {
    drillDepth.value = (drillDepth.value + 1) % (DRILL_MAX_DEPTH + 1)
    if (drillDepth.value === 0) {
      drillStack.value = []
      return
    }
    drillStack.value = selectedId.value
      ? drillNodeStackForSession(selectedId.value)
      : drillStack.value.slice(0, drillDepth.value)
  }

  function drillIntoGroup(key: string): void {
    drillStack.value = [...drillStack.value, { kind: 'group', key }]
  }

  function drillIntoFolder(path: string): void {
    drillStack.value = [...drillStack.value, { kind: 'folder', path }]
  }

  function drillBack(): void {
    drillStack.value = drillStack.value.slice(0, -1)
  }

  /**
   * The ONE place that reacts to a session becoming selected, regardless of
   * which of the ~14 call sites set `selectedId` (`select()`,
   * `activateSession()`, or a direct `selectedId.value = …` assignment
   * elsewhere in this store). Expands the owning group, folder, and
   * teammate group so the row actually renders, and raises the existing
   * scroll-into-view signal `Sidebar.vue` already watches.
   *
   * `flush: 'sync'` is load-bearing: callers (and the tests above) read the
   * expanded state immediately after `select()`/`activateSession()` returns,
   * with no `await nextTick()` — Vue's default (`'pre'`) flush would defer
   * this to the next microtask and break that synchronous contract.
   */
  watch(
    selectedId,
    (id) => {
      if (!id) return
      const session = findSessionById(id)
      if (!session) return
      const folder = findFolderBySessionId(id)
      if (!folder) return

      for (const node of visibleFolders.value) {
        if (isFolderGroup(node) && node.folders.some((f) => f.path === folder.path)) {
          collapsedGroupsSet.delete(node.key)
          break
        }
      }

      folder.expanded = true

      if (session.teamName) {
        const hex = teamHex(session.teamName)
        const leader = teammateLeadCandidates(folder).find(
          (s) => !s.teamName && hex.length > 0 && s.sessionId.startsWith(hex)
        )
        teammatesExpandedSet.add(leader ? leader.sessionId : folder.path)
      }

      if (drillModeEnabled.value) {
        drillStack.value = drillNodeStackForSession(id)
      }

      // T288: "recently visited" is folder-grained — every selection lands the
      // operator in a folder, whether they got there from the palette, the
      // tree, or a notification, so the list is recorded here rather than in
      // the palette's own jump path.
      recordJumpVisit(folder.path)

      revealSessionId.value = id
    },
    { flush: 'sync' }
  )

  /**
   * Say the notification out loud (T239). The phrase template is the whole point
   * of the feature — a chime already says "something happened"; only this says
   * WHICH session and WHAT — so the folder alias and the session summary are
   * substituted into the operator's own `{folder} / {session} / {event}` string.
   *
   * Fail-soft in both directions: the engine never rejects, and a failure that
   * would otherwise leave the operator with pure silence (they turned the chime
   * off and voice is what replaced it) falls back to the packaged chime. The
   * reason stays readable in Settings → Voice rather than being announced.
   *
   * `alias`/`label` are raw display values (a directory basename or full path,
   * a session summary) — BUG-129: read aloud verbatim they are a slug spelled
   * out letter by letter or, worse, a UUID. `normalizeFolderForSpeech` /
   * `normalizeSessionForSpeech` turn them into speakable text before they hit
   * the template; a value that normalizes to `''` is dropped by
   * `renderVoicePhrase` together with its separator.
   */
  async function speakNotification(
    kind: NotifyKind,
    alias: string,
    label: string,
    sessionId: string,
    chimeAlreadyPlayed: boolean
  ): Promise<void> {
    const phrase = renderVoicePhrase(speech.config.phrase, {
      folder: normalizeFolderForSpeech(alias),
      session: normalizeSessionForSpeech(label),
      event: i18n.global.t(VOICE_EVENT_KEY[kind])
    })
    if (!phrase) return
    const outcome = await speech.speak(phrase, {
      source: 'agent',
      sessionId,
      focus: { windowFocused: windowFocused.value, isSelected: selectedId.value === sessionId }
    })
    if (needsChimeFallback(outcome, chimeAlreadyPlayed)) {
      try {
        playNotificationSound()
      } catch {
        // The fallback is a courtesy, not a contract — never escape the caller.
      }
    }
  }

  /**
   * Surface a task-state edge, if the pure decision (os-notifications spec §4)
   * says so, on the channel it picks: an in-app **toast** when the window is
   * focused (you're in Harnu), a native **OS notification** when it isn't (pull
   * you back to a background session). The store resolves the human label
   * (folder alias + session summary) and the i18n title; the chime is gated by
   * `decision.sound` (off for the session you're staring at).
   */
  function maybeNotify(s: Session, prev: TaskState, next: TaskState): void {
    const decision = decideNotification(prev, next, {
      prefs: notifyPrefs.value,
      isSelected: selectedId.value === s.sessionId,
      windowFocused: windowFocused.value
    })
    if (!decision) return
    const alias = folderAliasOf(s.sessionId)
    const name = sessionTitle(s, allSessions.value, i18n.global.t)
    const label = name || s.sessionId
    const body = alias ? `${alias} · ${label}` : label
    const title = i18n.global.t(NOTIFY_TITLE_KEY[decision.kind])
    const delivered = dispatchNotification({
      title,
      body,
      channel: decision.channel,
      sound: decision.sound,
      sessionId: s.sessionId,
      toastKind: TOAST_KIND[decision.kind],
      toastAction: {
        label: 'toast.actions.goToSession',
        handler: () => activateSession(s.sessionId)
      }
    })
    // T239 — speech rides the SAME decision: the master switch and the three
    // event toggles above already gated it, so voice never needs a second set of
    // preferences to keep in sync. The engine applies its own gate on top (off,
    // muted, and "don't read me what I'm looking at"), which is why nothing here
    // re-checks those. Fire-and-forget: `speak` resolves when the AUDIO ends.
    //
    // BUG-129: unlike `label` above, the spoken value never falls back to the
    // raw `sessionId` — a session with no summary yet should be spoken as "harnu
    // is waiting for you", not as 32 hex characters read one by one.
    void speakNotification(decision.kind, alias, name, s.sessionId, decision.sound)

    if (decision.channel === 'os' && delivered) {
      // Remote push (remote-push spec) rides the OS channel only: the window
      // is unfocused, so the operator may be away from the machine entirely.
      // Master switch / pause / per-channel event opt-ins are resolved main-side.
      // Gated on `delivered`: before the dispatchNotification extraction both
      // calls lived in one try block, so a thrown window.api.notify skipped
      // pushSend too — preserve that (os-notifications spec, zero-behavior-
      // change bar for the extraction).
      try {
        window.api.pushSend({ kind: decision.kind, title, body })
      } catch {
        // Same rationale as dispatchNotification's own guard — never escape.
      }
    }
  }

  /**
   * Single entry point for every task-state transition (os-notifications spec
   * §3). Both the hook stream and the pty-exit overlay route through here so the
   * notification decision runs in exactly one place. No-op for unknown sessions.
   */
  function applyTaskState(
    sessionId: string,
    next: TaskState,
    meta?: { failureReason?: FailureReason; resetsAt?: number }
  ): void {
    const s = findSessionById(sessionId)
    if (!s) return
    // Folder terminals have no Claude task lifecycle — a shell exiting must not
    // set a task-state dot or fire a "task completed/failed" OS notification.
    if (s.isShellTerminal) return
    const prev: TaskState = s.taskState ?? 'idle'
    s.taskState = next
    // Left needs-input by another path (terminal answer, Stop, …) → drop its
    // parked approvals so the inbox doesn't show a row Claude already moved past.
    if (next !== 'needs-input') removeApprovalsForSession(sessionId)
    if (next === 'failed') {
      s.failureReason = meta?.failureReason ?? 'unknown'
      if (meta?.resetsAt) s.resetsAt = meta.resetsAt
    } else {
      // Left failed → clear the reason (sticky cleanup, spec §2.4).
      s.failureReason = undefined
      s.resetsAt = undefined
    }
    maybeNotify(s, prev, next)
  }

  /**
   * Apply a SCREEN-derived task-state to a folder terminal (A2 two-tier
   * detection). The parallel to `applyTaskState` for the non-hook panes the
   * lifecycle path deliberately skips: codex/aider/… running in a folder
   * terminal get their dot from the main-side screen scrape instead of hooks.
   *
   * - `next: null` → revert to the legacy activity heuristic (the recognized
   *   agent exited back to a plain shell — clear the override).
   * - otherwise → set working / needs-input / idle (never completed/failed; a
   *   screen can't observe lifecycle) and route through `maybeNotify` so a codex
   *   "needs input" still pings you.
   *
   * Guarded to `isShellTerminal`: a hooked Claude pane must never be
   * screen-overridden (and the main detector never scrapes one anyway).
   */
  function applyScreenState(sessionId: string, next: TaskState | null): void {
    const s = findSessionById(sessionId)
    if (!s || !s.isShellTerminal) return
    const prev: TaskState = s.taskState ?? 'idle'
    if (next === null) {
      s.taskState = undefined
      return
    }
    s.taskState = next
    maybeNotify(s, prev, next)
  }

  /**
   * Process-liveness overlay for task-state (session-state spec §3.3). Called on
   * a session's NATURAL pty exit only. Clean exit → `completed`, otherwise →
   * `failed`. Routes through `applyTaskState` so the exit also notifies.
   */
  function markSessionExited(sessionId: string, exitCode: number): void {
    applyTaskState(sessionId, exitCode === 0 ? 'completed' : 'failed')
  }

  /** Set one OS-notification preference and persist (os-notifications spec §4). */
  function setNotifyPref(key: keyof NotifyPrefs, value: boolean): void {
    notifyPrefs.value = { ...notifyPrefs.value, [key]: value }
  }

  /**
   * Notify once when the fleet-wide 5h rate-limit window actually resets
   * (usage-reset-notify spec). Standalone + directly callable (like
   * `applyTaskState`) so it's testable without needing `init()`'s full
   * subscription surface; `init()` wires a `watch()` that calls this
   * automatically whenever `useUsageStore().rateLimits.fiveHour` changes.
   *
   * Detects the reset by supersession: compares the newly-observed
   * `resetsAtMs` against the PREVIOUSLY-observed one (tracked internally in
   * `lastSeenUsageResetsAtMs`), because the caller's value only changes on a
   * new poll and by then already reports the next window's future
   * `resetsAtMs` — "now >= resetsAtMs" is never true on a live call.
   */
  function checkUsageResetNotification(resetsAtMs: number | null): void {
    const prevResetsAtMs = lastSeenUsageResetsAtMs.value
    lastSeenUsageResetsAtMs.value = resetsAtMs
    if (
      !shouldNotifyUsageReset(
        Date.now(),
        prevResetsAtMs,
        resetsAtMs,
        lastNotifiedUsageResetMs.value
      )
    ) {
      return
    }
    lastNotifiedUsageResetMs.value = prevResetsAtMs
    if (!notifyPrefs.value.enabled || !notifyPrefs.value.usageReset) return
    dispatchNotification({
      title: i18n.global.t('notifications.usageReset.title'),
      body: i18n.global.t('notifications.usageReset.body'),
      channel: windowFocused.value ? 'toast' : 'os',
      sound: notifyPrefs.value.sound,
      sessionId: '',
      toastKind: 'info'
    })
  }

  /**
   * Notify once per threshold per day when the daily budget crosses 80% / 100%
   * (daily-budget spec). Standalone and directly callable, like
   * `checkUsageResetNotification`, so it is testable without `init()`'s full
   * subscription surface; `init()` wires a `watch()` on the budget store.
   *
   * The mark is stamped BEFORE the preference gate on purpose: a threshold
   * crossed while the alert is switched off is still crossed, and must not fire
   * retroactively the moment the user turns the toggle back on later that day.
   */
  function checkDailyBudgetNotification(budget: DailyBudget, dayKey: string): void {
    const threshold: BudgetThreshold | null = shouldNotifyDailyBudget(
      budget,
      dayKey,
      lastBudgetNotify.value
    )
    if (threshold === null) return
    lastBudgetNotify.value = { day: dayKey, threshold }
    if (!notifyPrefs.value.enabled || !notifyPrefs.value.dailyBudget) return
    // The overrun copy quotes what the FOLLOWING days drop to, so it only makes
    // sense while there are following days: on the last working day of the
    // window `rebalancedPct` is null by construction, and quoting it as 0 would
    // render "The next 0 working days drop to 0%/day." Fall back to the
    // remaining-budget line, which reads 0% and is simply true.
    const canQuoteDamage = threshold === 100 && budget.rebalancedPct !== null
    dispatchNotification({
      title: i18n.global.t('notifications.dailyBudget.title'),
      body: canQuoteDamage
        ? i18n.global.t('notifications.dailyBudget.bodyOver', {
            spent: Math.round(budget.spentPct),
            budget: Math.round(budget.budgetPct),
            days: budget.remainingDays,
            pct: Math.round(budget.rebalancedPct ?? 0)
          })
        : i18n.global.t('notifications.dailyBudget.bodyNear', {
            pct: Math.max(0, Math.round(budget.budgetPct - budget.spentPct))
          }),
      channel: windowFocused.value ? 'toast' : 'os',
      sound: notifyPrefs.value.sound,
      sessionId: '',
      toastKind: threshold === 100 ? 'warning' : 'info'
    })
  }

  // `mergeFolders` + `userProjectToFolder` are extracted into the pure module
  // `./merge-folders` (T18) so the disk⊕user-intent merge is unit-testable on
  // its own. Behavior is identical; `mergeFolders` is imported at the top of
  // this file.

  /**
   * True when two arrays hold the same object references in the same order.
   * Lets the reconcilers skip a reactive write entirely when nothing moved.
   */
  function sameOrder<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  /**
   * Reconcile a folder's session array IN PLACE against a freshly-scanned list:
   * reuse the existing `Session` object for each surviving id (writing only the
   * fields that actually changed), insert genuinely-new sessions, drop removed
   * ones, and adopt the new order. Reused objects keep their identity, so a
   * folder whose sessions only had a field tweaked never forces its sidebar
   * `sessionList` computed to throw away and rebuild every row (sidebar-freeze
   * fix). `ex === ns` for a re-injected synthetic (same reference) — skipped.
   */
  // Session fields owned by the RENDERER (set by context-menu toggles or agent
  // create), which never appear on the on-disk session — so a disk reconcile must
  // PRESERVE them rather than clear them to `undefined`. See `reconcileSessions`.
  const RENDERER_ONLY_SESSION_KEYS = new Set<string>([
    'bootOverride', // New session dialog + remoteControl toggle
    'agentControlled', // MCP agent-created session (withhold mcp-config + downgrade)
    'mode', // T123: Modes ▸ Learning teaching contract, read on every claude-resume spawn
    'spawnedBy' // T215: who caused this session to exist — gates message_session's recipient scope
  ])

  function reconcileSessions(curArr: Session[], nextArr: Session[]): void {
    const curById = new Map(curArr.map((s) => [s.sessionId, s]))
    const result: Session[] = []
    for (const ns of nextArr) {
      const ex = curById.get(ns.sessionId)
      if (!ex) {
        result.push(ns)
        continue
      }
      if (ex !== ns) {
        const keys = new Set<string>([...Object.keys(ex), ...Object.keys(ns)])
        const exRec = ex as unknown as Record<string, unknown>
        const nsRec = ns as unknown as Record<string, unknown>
        for (const key of keys) {
          // Renderer-only spawn state (set by the context-menu toggles / agent
          // create) NEVER exists on the on-disk session, so this union-of-keys
          // reconcile would clear it to `undefined` on EVERY folder rescan —
          // wiping e.g. a running session's `remoteControl` bootOverride out
          // from under it so its next respawn loses the flag.
          // Same class of bug bit `mode` (T123): a Learning session's JSONL
          // lands on disk seconds after boot, the next `onIndexUpdated` rebuilds
          // this row from disk (which never carries `mode`), and an un-listed
          // key here would silently drop the teaching contract on any later
          // respawn (close the tab, reopen it → `claude-resume`) in the SAME app
          // run — no error, no signal. Preserve these when the disk session
          // lacks the key (a real value on disk would still win — none of these
          // ever appears there).
          if (RENDERER_ONLY_SESSION_KEYS.has(key) && !(key in nsRec)) continue
          // Assigning an unchanged value is a no-op for Vue reactivity, so only
          // genuine field changes notify dependents.
          if (exRec[key] !== nsRec[key]) exRec[key] = nsRec[key]
        }
      }
      result.push(ex)
    }
    if (!sameOrder(curArr, result)) curArr.splice(0, curArr.length, ...result)
  }

  /**
   * Apply a freshly-merged folder list onto the live reactive `folders` by
   * RECONCILING in place instead of reassigning wholesale. Folders are matched
   * by `path` (sessions by id, via `reconcileSessions`); matched objects keep
   * their identity and only changed fields are written. Reassigning
   * `folders.value` to all-new objects on every reload was what re-rendered the
   * entire sidebar and caused the visible stutter — this writes just the delta.
   */
  function commitFolders(next: Folder[]): void {
    const curByPath = new Map(folders.value.map((f) => [f.path, f]))
    const result: Folder[] = []
    for (const nf of next) {
      const ex = curByPath.get(nf.path)
      if (!ex) {
        result.push(nf)
        continue
      }
      reconcileSessions(ex.sessions, nf.sessions)
      // Copy scalar folder fields in place (everything except `sessions`, which
      // `reconcileSessions` already owns). Union of keys so a field that
      // disappeared on disk is cleared, matching the old wholesale semantics.
      const keys = new Set<string>([...Object.keys(ex), ...Object.keys(nf)])
      const exRec = ex as unknown as Record<string, unknown>
      const nfRec = nf as unknown as Record<string, unknown>
      for (const key of keys) {
        if (key === 'sessions') continue
        if (exRec[key] !== nfRec[key]) exRec[key] = nfRec[key]
      }
      result.push(ex)
    }
    // Only swap the array when membership or order changed; otherwise leave
    // `folders.value` untouched so the zone computeds stay cached.
    if (!sameOrder(folders.value, result)) folders.value = result
  }

  /**
   * In-flight reload promise + a "more arrived" flag. `reloadModel` is
   * single-flight: a burst of watcher events (one Claude turn fires
   * `index:updated` + `project:added` + …) coalesces onto one scan instead of
   * each launching its own concurrent full disk re-scan. See `reloadModel`.
   */
  let reloadInFlight: Promise<void> | null = null
  let reloadDirty = false

  /**
   * Public reload entry point — single-flight with dirty-reentry. Overlapping
   * callers share the in-flight scan; if new triggers land mid-scan, exactly
   * one more pass runs afterwards so nothing is missed. Callers that `await`
   * this (init, pin/dismiss) still observe a scan that
   * completes after their call. The heavy lifting lives in `reloadModelOnce`.
   */
  async function reloadModel(diskOverride?: FolderEntry[]): Promise<void> {
    if (reloadInFlight) {
      reloadDirty = true
      return reloadInFlight
    }
    reloadInFlight = (async () => {
      try {
        do {
          reloadDirty = false
          await reloadModelOnce(diskOverride)
          // Only the first pass consumes the override — a dirty re-entry (a new
          // trigger landed mid-scan) re-fetches ordinary disk truth rather than
          // replaying a now-stale snapshot.
          diskOverride = undefined
        } while (reloadDirty)
      } finally {
        reloadInFlight = null
      }
    })()
    return reloadInFlight
  }

  /**
   * Manual rescan (BUG-55 spec §3.2 / AC6) — the refresh affordance for any
   * watcher gap. `window.api.rescan()` runs ONE full rescan of main's fleet
   * model (sidebar-liveness SW-1) and returns the refreshed folders; that
   * snapshot is fed through the SAME merge/reconcile pipeline
   * (`reloadModelOnce`) so synthetics, expand state, and runtime overlays
   * survive exactly as they do on an ordinary reload. It counts as full
   * coverage for the migrated-row rule (D8): the model just looked everywhere.
   */
  async function rescan(): Promise<void> {
    // Stamped BEFORE the call: the scan starts after it, so it speaks for every
    // row migrated before this point — not for one migrated while it ran.
    const seq = ++coverageSeq
    const disk = await window.api.rescan()
    pendingCoverage.full = Math.max(pendingCoverage.full, seq)
    await reloadModel(disk)
  }

  /**
   * Trailing-edge debounce around `reloadModel`, for the fire-and-forget watcher
   * triggers (`project:added`, `index:updated`). A burst within
   * `RELOAD_DEBOUNCE_MS` collapses into ONE scan instead of running heavy scans
   * back-to-back (the single-flight above prevents overlap but not throughput —
   * perf spec §5.1b). The returned promise resolves only AFTER the trailing scan
   * completes, so `onIndexUpdated`'s `.then(collapseResolvedSynthetics)` runs
   * against post-scan state. Awaited, user-initiated callers (init / pin /
   * dismiss / add-folder) call `reloadModel()` directly — never this — so
   * nothing user-facing feels laggy.
   *
   * Max-wait (sidebar-liveness AC-5): a trigger stream with gaps under 250 ms
   * would slide a pure debounce forever; the timer is never pushed past
   * `RELOAD_MAX_WAIT_MS` after the first waiter of the current burst.
   */
  const RELOAD_DEBOUNCE_MS = 250
  const RELOAD_MAX_WAIT_MS = 1000
  let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let reloadDebounceWaiters: Array<() => void> = []
  let reloadDebounceFirstAt = 0
  function reloadModelDebounced(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (reloadDebounceWaiters.length === 0) reloadDebounceFirstAt = Date.now()
      reloadDebounceWaiters.push(resolve)
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer)
      const elapsed = Date.now() - reloadDebounceFirstAt
      const delay = Math.max(0, Math.min(RELOAD_DEBOUNCE_MS, RELOAD_MAX_WAIT_MS - elapsed))
      reloadDebounceTimer = setTimeout(() => {
        reloadDebounceTimer = null
        const waiters = reloadDebounceWaiters
        reloadDebounceWaiters = []
        void reloadModel().finally(() => {
          for (const w of waiters) w()
        })
      }, delay)
    })
  }

  /**
   * What main's fleet model has looked at since the last reload consumed it
   * (`fleet:changed` coverage, sidebar-liveness D8). `reloadModelOnce` takes a
   * snapshot at its start and clears it; the pending-collapse and migrated-row
   * rules below only conclude "the model has no such session" for a slug the
   * snapshot covers.
   *
   * Coverage is stamped with `coverageSeq` (one counter shared with the
   * `awaitingConfirm`/`pendingCollapse` entries) and only judges an entry
   * recorded BEFORE the push arrived: a push that arrived earlier describes a
   * model that predates the entry's `session:added`, so its "not there" is
   * stale. Main keeps the other half of that promise by never reporting a slug
   * that was dirty again when it emitted (`noteRefresh`).
   */
  let coverageSeq = 0
  const pendingCoverage: Coverage = { slugs: new Map(), full: 0 }
  let lastFleetReloadAt = 0

  /**
   * `fleet:changed` handler (sidebar-liveness §4.A A6): main's model just
   * changed membership, so reload — on the LEADING edge when no reload ran in
   * the last `RELOAD_DEBOUNCE_MS`, else trailing through the max-wait debounce.
   * This is the push that replaces the old stale-read fallback reload.
   */
  function reloadOnFleetChange(change: FleetChangedEvent): void {
    const seq = ++coverageSeq
    if (change.full) pendingCoverage.full = seq
    for (const slug of change.slugs) pendingCoverage.slugs.set(slug, seq)
    const now = Date.now()
    if (now - lastFleetReloadAt >= RELOAD_DEBOUNCE_MS && !reloadDebounceTimer) {
      lastFleetReloadAt = now
      void reloadModel()
      return
    }
    void reloadModelDebounced().then(() => {
      lastFleetReloadAt = Date.now()
    })
  }

  /**
   * Real session ids whose `session:added` found no synthetic to collapse yet
   * (slug unresolved, or the real row not in the model yet). Resolved inside
   * `reloadModelOnce` BEFORE commit (A7), so a synthetic and its real twin are
   * never committed together. `slug` is the watcher slug the id was announced
   * under — the coverage key that lets a reload give up on it.
   */
  const pendingCollapse = new Map<string, { since: number; slug: string; seq: number }>()

  /**
   * In-place migrated rows (a synthetic renamed to its real id before the model
   * knew it) waiting for model evidence (D8): kept across reloads until the model
   * confirms the id in any folder, or refreshes `folderPath`'s slug and omits it.
   * `since` feeds only the 60 s backstop against a lost push.
   */
  const awaitingConfirm = new Map<string, { folderPath: string; since: number; seq: number }>()
  const AWAITING_CONFIRM_BACKSTOP_MS = 60_000

  /**
   * Migrated-row survival (D8, A8), run on the merged snapshot before commit.
   * Confirmed anywhere → ordinary reconcile (a row the model placed under
   * another folder leaves this one, no duplicate). Absent, and the model
   * looked at its folder's slug → dropped (BUG-88 AC-7 parity). Absent and
   * not looked at → the SAME live object is re-injected, so selection and the
   * PTY keyed by its id ride along.
   */
  function keepRowsAwaitingConfirm(merged: Folder[], coverage: Coverage): void {
    if (awaitingConfirm.size === 0) return
    const liveRows = new Map<string, Session>()
    for (const f of folders.value) for (const s of f.sessions) liveRows.set(s.sessionId, s)
    const now = Date.now()
    for (const [id, w] of [...awaitingConfirm]) {
      if (merged.some((f) => f.sessions.some((s) => s.sessionId === id))) {
        awaitingConfirm.delete(id)
        continue
      }
      const looked = coverageJudges(coverage, encodePathToSlug(w.folderPath), w.seq)
      const row = liveRows.get(id)
      if (looked || !row || now - w.since > AWAITING_CONFIRM_BACKSTOP_MS) {
        awaitingConfirm.delete(id)
        continue
      }
      const target = merged.find((f) => f.path === w.folderPath)
      if (target && !target.sessions.includes(row)) target.sessions.unshift(row)
    }
  }

  /** Test-only: migrated rows still waiting for model evidence. */
  function __awaitingConfirmSizeForTests(): number {
    return awaitingConfirm.size
  }

  /** Test-only: pending-collapse ids still live (age-expired ones pruned first). */
  function __pendingCollapseSizeForTests(): number {
    const now = Date.now()
    for (const [id, e] of [...pendingCollapse]) {
      if (now - e.since > SYNTH_RESOLVE_WINDOW_MS) pendingCollapse.delete(id)
    }
    return pendingCollapse.size
  }

  /** Newest still-open, non-terminal synthetic in a live folder, or null. */
  function newestOpenSynthetic(folderPath: string): Session | null {
    const folder = folders.value.find((f) => f.path === folderPath)
    if (!folder) return null
    let synth: Session | null = null
    for (const s of folder.sessions) {
      if (s.synthetic !== true || s.isShellTerminal) continue
      if (!synth || s.created > synth.created) synth = s
    }
    return synth
  }

  /**
   * Pending-collapse resolution (A7), run on the merged snapshot before the
   * synthetic re-inject loop. Returns the synthetic ids it absorbed so the
   * caller skips re-injecting them.
   */
  function resolvePendingCollapses(merged: Folder[], coverage: Coverage): Set<string> {
    const absorbed = new Set<string>()
    const now = Date.now()
    for (const [realId, entry] of [...pendingCollapse]) {
      if (now - entry.since > SYNTH_RESOLVE_WINDOW_MS) {
        pendingCollapse.delete(realId)
        continue
      }
      let target: Folder | undefined
      let realRow: Session | undefined
      for (const f of merged) {
        realRow = f.sessions.find((s) => s.sessionId === realId)
        if (realRow) {
          target = f
          break
        }
      }
      if (!target || !realRow) {
        // The model looked at this slug (or everywhere) and has no such
        // session: a create-then-delete, or a transcript classified away.
        if (coverageJudges(coverage, entry.slug, entry.seq)) pendingCollapse.delete(realId)
        continue
      }
      pendingCollapse.delete(realId)
      if (bornSyntheticIds.has(realId)) continue // already collapsed — never re-grab
      const synth = newestOpenSynthetic(target.path)
      if (!synth) continue
      absorbed.add(synth.sessionId)
      absorbSyntheticIntoRealRow(synth, realRow, target.path)
    }
    return absorbed
  }

  /**
   * Full re-scan. The merge layer runs here, so every reload re-overlays the
   * user-intent JSON onto the disk-derived folders. Snapshots synthetics + each
   * folder's `expanded` flag (keyed by folder path) so neither the user's
   * disclosure choices nor a running synthetic's row are lost across a rescan.
   * Commits via `commitFolders` (in-place reconcile), not a wholesale reassign.
   */
  async function reloadModelOnce(diskOverride?: FolderEntry[]): Promise<void> {
    // What the model had looked at when this pass started (D8). Consumed here:
    // coverage that arrives during the disk read belongs to the next pass.
    const coverage: Coverage = { slugs: new Map(pendingCoverage.slugs), full: pendingCoverage.full }
    pendingCoverage.slugs.clear()
    pendingCoverage.full = 0
    // Snapshot expand state + every row the reader can NEVER independently
    // reproduce from disk: a still-open synthetic placeholder (`synthetic ===
    // true`), or a folder terminal (`isShellTerminal === true`) — the latter
    // writes no JSONL by design (lesson 003) and keeps `fullPath === ''`
    // forever, so it depends on this same re-injection to survive a reload.
    // BUG-88: a row already migrated to a real id (`synthetic === false`,
    // `isShellTerminal` falsy, `fullPath` still blank) used to be snapshotted
    // here too — that is what let a wrong-folder or never-found migration
    // become a PERMANENT ghost (see the resurrection guard below). Such a row
    // is now left entirely to the ordinary per-folder reconcile: if the fresh
    // disk read confirms it (under this same folder), reconcile below
    // updates it in place; if not, it is correctly dropped.
    const folderExpanded = new Map<string, boolean>()
    const synthSnapshot: Array<{ folderPath: string; session: Session }> = []
    // Runtime overlays (task-state / aiSummary / failure) are NOT disk fields —
    // the reader rebuilds each real session from scratch, which would reset
    // hook-driven state (and re-trigger notifications) on every rescan. We
    // re-apply them after the merge. Crucially they are populated AFTER the await
    // (Fix 3, T18), not here: a snapshot taken before the disk read is stale by
    // commit time, so a hook/auto-name landing during the ~150 ms reload would be
    // reverted (e.g. working→idle flipping back).
    const taskStateById = new Map<string, TaskState>()
    const aiSummaryById = new Map<string, { title: string; summary: string }>()
    const failureById = new Map<string, { failureReason?: FailureReason; resetsAt?: number }>()
    for (const f of folders.value) {
      folderExpanded.set(f.path, f.expanded)
      for (const s of f.sessions) {
        if (s.synthetic !== true && !s.isShellTerminal) continue
        synthSnapshot.push({ folderPath: f.path, session: s })
      }
    }

    const [disk, listResult, armedSessionIds] = await Promise.all([
      diskOverride ? Promise.resolve(diskOverride) : window.api.foldersLoad(),
      window.api.userProjectsList(),
      window.api.orchestratorListArmed()
    ])
    // Read runtime overlays from the LIVE model AFTER the await (Fix 3, T18) so a
    // hook / auto-name that mutated a session during the disk read is captured
    // (not reverted). Mirrors the resurrection guard below, which also reads
    // live state post-await.
    for (const f of folders.value) {
      for (const s of f.sessions) {
        if (s.taskState) taskStateById.set(s.sessionId, s.taskState)
        if (s.aiSummary) aiSummaryById.set(s.sessionId, s.aiSummary)
        if (s.failureReason || s.resetsAt)
          failureById.set(s.sessionId, { failureReason: s.failureReason, resetsAt: s.resetsAt })
      }
    }
    // Tolerate both the `{ projects, hiddenPaths }` shape and a bare array (an
    // HMR-staggered main process that predates the Hidden-folders feature).
    const userProjects: UserProject[] = Array.isArray(listResult) ? listResult : listResult.projects
    const hiddenPaths: string[] = Array.isArray(listResult) ? [] : listResult.hiddenPaths
    // Backfill git meta for pinned PLACEHOLDER folders whose persisted record
    // predates pin-time probing (T70A). Disk folders are already probed by
    // scanFolders, and records pinned since T70A carry persisted git meta — so
    // only user paths with NO disk counterpart AND no persisted `repoId` (and
    // not already covered by the volatile adopt map) need a runtime probe to
    // collapse under their repo. Merge the result over the adopt map (T26).
    const diskPaths = new Set(disk.map((d) => d.path))
    const needProbe = userProjects
      .filter(
        (up) => !diskPaths.has(up.path) && up.repoId === undefined && !adoptedGitByPath.has(up.path)
      )
      .map((up) => up.path)
    let gitByPath: Map<string, GitMeta> = adoptedGitByPath
    if (needProbe.length > 0) {
      const backfilled = await probePathsGitMeta(needProbe)
      if (backfilled.size > 0) {
        gitByPath = new Map(adoptedGitByPath)
        for (const [p, m] of backfilled) gitByPath.set(p, m)
      }
    }
    lastBasePaths = new Set([...disk.map((d) => d.path), ...userProjects.map((u) => u.path)])
    const merged = mergeFolders(disk, userProjects, hiddenPaths, gitByPath, gitListings())

    // Restore the expand state captured above (folders the user never touched
    // keep the disk default of collapsed).
    for (const f of merged) {
      const fe = folderExpanded.get(f.path)
      if (fe !== undefined) f.expanded = fe
    }

    // Restore runtime task-state captured above (direct assignment — NOT via
    // applyTaskState — so re-hydrating a reload never raises a notification).
    if (taskStateById.size > 0 || aiSummaryById.size > 0 || failureById.size > 0) {
      for (const f of merged) {
        for (const s of f.sessions) {
          const ts = taskStateById.get(s.sessionId)
          if (ts) s.taskState = ts
          const ai = aiSummaryById.get(s.sessionId)
          if (ai) s.aiSummary = ai
          const fail = failureById.get(s.sessionId)
          if (fail) {
            s.failureReason = fail.failureReason
            s.resetsAt = fail.resetsAt
          }
        }
      }
    }

    // Refresh the hidden-paths mirror in lockstep with the merge.
    manuallyHiddenPaths.value = new Set(hiddenPaths)
    // Refresh the MCP agent-DENYLIST mirror (the per-folder block) the same way.
    agentDeniedPaths.value = new Set(userProjects.filter((p) => p.agentDenied).map((p) => p.path))
    // Refresh the Approval Inbox trust-ramp mirror (T30) in lockstep too.
    interceptFolders.value = new Set(
      userProjects.filter((p) => p.interceptActive).map((p) => p.path)
    )
    // Refresh the auto-alias opt-in mirror (T52) the same way.
    aliasFromBranchPaths.value = new Set(
      userProjects.filter((p) => p.aliasFromBranch).map((p) => p.path)
    )
    // Refresh the auto-organize opt-out mirror (T106/D6) — inverted set (see
    // the ref's own doc comment): only EXPLICIT `false` lands here.
    autoOrganizeOffPaths.value = new Set(
      userProjects.filter((p) => p.autoOrganizeCards === false).map((p) => p.path)
    )
    // Refresh the orchestrator-role mirror (T98) from the durable main-process
    // truth (`armed.json`), so a restart never visually demotes a still-armed
    // session.
    orchestratorSessionIds.value = new Set(armedSessionIds)
    // Refresh the "new sessions start as Orchestrator" default mirror (T344)
    // the same way as `interceptFolders`/`aliasFromBranchPaths` — EXACT-PATH
    // only, no worktree inheritance (AC-5).
    orchestratorDefaultPaths.value = new Set(
      userProjects.filter((p) => p.orchestratorDefault).map((p) => p.path)
    )

    // Re-inject synthetics into matching folders (match by folder path).
    //
    // Resurrection guard (lesson 003 follow-up 1): the snapshot above was taken
    // BEFORE the `await` on disk I/O. While we awaited, a synchronous handler
    // (an in-place migrate, a collapse, or an explicit `closeSession`) may have
    // already removed one of these rows from the live model. Re-injecting its
    // stale snapshot would bring an already-gone row back — the timing-dependent
    // duplicate / stuck placeholder. So only re-inject synthetics still present
    // in the live `folders.value` at commit time (read AFTER the await).
    //
    // BUG-88: this loop only ever sees still-open synthetics and folder
    // terminals now (the snapshot above stopped capturing migrated real-id
    // rows). A row that migrated in-place is NOT force-reinjected here; its
    // survival is decided by `keepRowsAwaitingConfirm` below on MODEL
    // EVIDENCE (sidebar-liveness D8), never on age: kept while the model has
    // not looked at its folder's slug, dropped once a reload whose coverage
    // includes that slug still omits it, and left to the ordinary reconcile
    // the moment the model confirms it in any folder (so a wrong-folder
    // migration moves, never duplicates — BUG-88 AC-7). That is what stops a
    // migration the reader can never place from becoming a PERMANENT
    // "Untitled session" ghost, without dropping a just-migrated row on an
    // unrelated reload that raced main's model refresh (the old one-chance
    // trade-off). The 60 s cap is only a backstop against a lost push.
    // A7: a real row this reload brought in for a pending `session:added`
    // absorbs its synthetic HERE, before commit — one row, never both.
    const absorbedSynthIds = resolvePendingCollapses(merged, coverage)
    // A8: in-place migrated rows the model has not confirmed yet survive until
    // it confirms them or looks at their folder's slug and omits them.
    keepRowsAwaitingConfirm(merged, coverage)
    const liveSessionIds = new Set<string>()
    for (const f of folders.value) {
      for (const s of f.sessions) liveSessionIds.add(s.sessionId)
    }
    for (const { folderPath, session } of synthSnapshot) {
      if (!liveSessionIds.has(session.sessionId)) continue
      if (absorbedSynthIds.has(session.sessionId)) continue
      const target = merged.find((f) => f.path === folderPath)
      if (target && !target.sessions.some((s) => s.sessionId === session.sessionId)) {
        target.sessions.unshift(session)
      }
    }

    commitFolders(merged)
  }

  function scheduleIdle(sessionId: string): void {
    const prev = idleTimers.get(sessionId)
    if (prev) clearTimeout(prev)
    idleTimers.set(
      sessionId,
      setTimeout(() => {
        idleTimers.delete(sessionId)
        const s = findSessionById(sessionId)
        if (s) s.status = 'idle'
      }, ACTIVE_TO_IDLE_MS)
    )
  }

  /**
   * Re-arm the per-agent "back to done" timer (issue #9). A running subagent
   * flips to `done` after `SUBAGENT_ACTIVE_WINDOW_MS` of silence.
   */
  function scheduleAgentDone(parentSessionId: string, agentId: string): void {
    const prev = agentDoneTimers.get(agentId)
    if (prev) clearTimeout(prev)
    agentDoneTimers.set(
      agentId,
      setTimeout(() => {
        agentDoneTimers.delete(agentId)
        const agent = findAgent(parentSessionId, agentId)
        if (agent) agent.status = 'done'
      }, SUBAGENT_ACTIVE_WINDOW_MS)
    )
  }

  /** Locate a nested agent by parent session id + agent id. */
  function findAgent(parentSessionId: string, agentId: string): SessionAgent | null {
    for (const f of folders.value) {
      const parent = f.sessions.find((x) => x.sessionId === parentSessionId)
      if (!parent?.agents) continue
      const a = parent.agents.find((x) => x.agentId === agentId)
      if (a) return a
    }
    return null
  }

  /**
   * Handler body for `claude:subagent:updated` (issue #9). Finds the parent
   * session, then upserts the agent. No-ops if the parent isn't in the tree yet.
   * `meta` was read from the transcript lines in main (first defined value per
   * field); an absent field leaves the agent's existing value alone.
   */
  function applySubagentUpdate(
    slug: string,
    parentSessionId: string,
    agentId: string,
    meta: {
      agentType?: string
      skill?: string
      plugin?: string
      model?: string
      task?: string
    } = {}
  ): void {
    void slug
    const parent = findSessionById(parentSessionId)
    if (!parent) return
    if (!parent.agents) parent.agents = []
    const nowIso = new Date().toISOString()
    let agent = parent.agents.find((a) => a.agentId === agentId)
    if (!agent) {
      agent = {
        agentId,
        parentSessionId,
        fullPath: '',
        fileMtime: Date.now(),
        agentType: meta.agentType ?? '',
        skill: meta.skill ?? '',
        plugin: meta.plugin ?? '',
        model: meta.model ?? '',
        task: meta.task ?? '',
        status: 'running',
        created: nowIso,
        modified: nowIso
      }
      parent.agents.push(agent)
    } else {
      if (!agent.agentType && meta.agentType) agent.agentType = meta.agentType
      if (!agent.skill && meta.skill) agent.skill = meta.skill
      if (!agent.plugin && meta.plugin) agent.plugin = meta.plugin
      if (!agent.model && meta.model) agent.model = meta.model
      if (!agent.task && meta.task) agent.task = meta.task
    }
    agent.status = 'running'
    agent.modified = nowIso
    scheduleAgentDone(parentSessionId, agentId)
  }

  /** Handler body for `claude:subagent:removed`. Drops the agent if present. */
  function removeSubagent(slug: string, parentSessionId: string, agentId: string): void {
    void slug
    const parent = findSessionById(parentSessionId)
    if (!parent?.agents) return
    const idx = parent.agents.findIndex((a) => a.agentId === agentId)
    if (idx !== -1) parent.agents.splice(idx, 1)
    const t = agentDoneTimers.get(agentId)
    if (t) {
      clearTimeout(t)
      agentDoneTimers.delete(agentId)
    }
  }

  /**
   * Handler for `onSessionAdded`. Two branches:
   *  (a) a synthetic exists in this folder → migrate it to the real id **in
   *      place, with NO full reload** (perf spec §5.1a). This is the hot path
   *      for `+ New session` / forks; skipping the disk scan is what removes the
   *      app-freeze the user hit. The synthetic keeps its slot + PTY (via
   *      `fireMigrate`); `fullPath`/`summary`/`firstPrompt`/`messageCount` are
   *      backfilled immediately by `backfillMigratedSessionMeta` (BUG-88), with
   *      the subsequent `session:updated` `firstPromptCandidate`
   *      and the next organic reload as a fallback if that read still misses.
   *  (b) no synthetic (a session born outside this app) → no reload of its
   *      own: the id is recorded in `pendingCollapse` and the `fleet:changed`
   *      push that follows main's model refresh brings the row
   *      (sidebar-liveness A6).
   */
  /**
   * BUG-88: an in-place synth→real migration (`collapseSyntheticInto`'s
   * in-place branch, `tryBindAgentMigration`) renames the row's `sessionId`
   * synchronously — for PTY/selection continuity — before the reader has ever
   * scraped this id's disk identity, so `fullPath`/`summary`/`firstPrompt`/
   * `messageCount` stay blank and the label falls through to
   * `t('session.unnamed')`. This targeted, one-shot disk read backfills those
   * four fields directly onto the SAME row object the instant they're known,
   * instead of going through the full `reloadModel()`/`commitFolders`
   * pipeline (which would re-run the synthetic resurrection guard and folder
   * merge for every OTHER session, and — worse — could drop this exact row if
   * the read races ahead of the transcript actually being flushed). A miss
   * (the reader still doesn't know this id) is a silent no-op: the row keeps
   * its blank fields until a later organic reload's ordinary per-folder
   * reconcile catches it, or it's correctly left as a dropped ghost by the
   * `reloadModelOnce` resurrection guard (same card). Each field is filled
   * only if still empty — this read can resolve after a fresher concurrent
   * update (a `/rename`, the `onSessionUpdated` firstPrompt tail) already
   * landed, and must never clobber it.
   */
  async function backfillMigratedSessionMeta(sessionId: string): Promise<void> {
    // Deferred one microtask past the synchronous rename (perf §5.1a): the
    // in-place migrate itself must still complete with NO disk read on the
    // caller's stack (that contract is what keeps `+ New session` from
    // freezing) — this read starts right after, on the next tick.
    await Promise.resolve()
    const disk = await window.api.foldersLoad()
    for (const f of disk) {
      const match = f.sessions.find((s) => s.sessionId === sessionId)
      if (!match) continue
      const row = findSessionById(sessionId)
      if (!row) return // row is gone by the time the read resolved — nothing to backfill
      // Fill-if-empty, not overwrite: this read can resolve AFTER a fresher
      // concurrent update already landed (a `/rename` setting `summary`, the
      // `onSessionUpdated` tail backfilling `firstPrompt`) — never clobber a
      // value something else already set while this was in flight.
      if (!row.fullPath) row.fullPath = match.fullPath
      if (!row.summary) row.summary = match.summary
      if (!row.firstPrompt) row.firstPrompt = match.firstPrompt
      if (!row.messageCount) row.messageCount = match.messageCount
      return
    }
  }

  /**
   * The single, idempotent synth→real collapse, keyed on the REAL `sessionId`
   * (T18 Fix 1). Every path that turns a synthetic placeholder into its real
   * session routes through here, so the collapse can never diverge or duplicate.
   *
   * - **Idempotent:** no-op if `realId` was already migrated from a synthetic
   *   (`bornSyntheticIds`), so a repeat call never absorbs an *unrelated* synthetic.
   * - **Lossless folder resolution:** the folder that already holds a real row
   *   with `realId`, else the caller's `folderHint` (a folder path) — never slug
   *   decode (the lossy path that generated the duplicate in the first place).
   * - **Synthetic selection:** newest non-shell synthetic in the folder (recency;
   *   agent-bound synthetics are matched earlier by `tryBindAgentMigration`).
   * - **In-place** (no real row yet): the synthetic BECOMES `realId` (same object,
   *   slot, live PTY). **Duplicate** (the reader already surfaced a real row R for
   *   `realId`): keep R, drop the synthetic, re-key its live PTY to `realId`.
   *
   * BUG-59: when the absorbed synthetic is agent-controlled (its correlation
   * window lapsed before this recency fallback ran), this ALSO reports
   * materialization — the signal must not depend solely on the correlation
   * surviving. No-op for an ordinary user synthetic (`reportMaterialized`
   * would just find no waiter on the main side, but we skip the IPC call
   * entirely for the common case).
   *
   * Returns true when `realId` ends up as a single live row.
   */
  function collapseSyntheticInto(realId: string, folderHint?: string): boolean {
    if (bornSyntheticIds.has(realId)) return true // already collapsed — never re-grab

    let folder: Folder | null = null
    let realRow: Session | null = null
    for (const f of folders.value) {
      for (const s of f.sessions) {
        if (s.sessionId === realId && s.synthetic !== true) {
          folder = f
          realRow = s
          break
        }
      }
      if (folder) break
    }
    if (!folder && folderHint) folder = folders.value.find((f) => f.path === folderHint) ?? null
    if (!folder) return false

    let synth: Session | null = null
    for (const s of folder.sessions) {
      if (s.synthetic !== true) continue
      // A folder terminal has no JSONL — never the on-disk twin of a Claude
      // synthetic (lesson 003 guard).
      if (s.isShellTerminal) continue
      if (!synth || s.created > synth.created) synth = s
    }
    if (!synth) return realRow !== null // nothing to absorb

    if (realRow && realRow !== synth) {
      absorbSyntheticIntoRealRow(synth, realRow, folder.path)
      return true
    }
    // In-place: no separate real row yet — the synthetic becomes the real
    // session (same object, slot, live terminal re-keyed via fireMigrate).
    const synthId = synth.sessionId
    const wasAgentControlled = synth.agentControlled === true
    agentCorrelationMeta.delete(synthId)
    synth.sessionId = realId
    synth.synthetic = false
    synth.forkSourceId = undefined
    if (selectedId.value === synthId) selectedId.value = realId
    fireMigrate(synthId, realId)
    // D8: the model has not seen this id yet — keep the row across reloads
    // until the model confirms it or looks at this folder's slug and omits it.
    awaitingConfirm.set(realId, { folderPath: folder.path, since: Date.now(), seq: ++coverageSeq })
    // BUG-88: the rename above just went from a labelled synthetic to a
    // blank-metadata real row — backfill its disk identity immediately.
    void backfillMigratedSessionMeta(realId)
    if (wasAgentControlled) reportMaterialized(synthId, realId, folder.path)
    return true
  }

  /**
   * Duplicate collapse: a real row R for the synthetic's session exists (live,
   * or in a reload's merged snapshot — A7). Keep R (it carries the disk
   * summary/metadata), drop the synthetic from its live folder if it is still
   * there, and re-key its PTY + selection to R's id.
   */
  function absorbSyntheticIntoRealRow(synth: Session, realRow: Session, folderPath: string): void {
    const synthId = synth.sessionId
    const realId = realRow.sessionId
    const wasAgentControlled = synth.agentControlled === true
    agentCorrelationMeta.delete(synthId)
    // T215: carry the ownership marker onto the surviving row. The disk row
    // has no `spawnedBy` (it never appears in the JSONL), and dropping it
    // here would make the session look operator-owned on its NEXT spawn —
    // a park→wake, or just reopening its tab — silently taking an
    // agent-dispatched session out of `message_session`'s reach.
    if (realRow.spawnedBy === undefined && synth.spawnedBy !== undefined) {
      realRow.spawnedBy = synth.spawnedBy
    }
    const live = folders.value.find((f) => f.path === folderPath)
    const idx = live ? live.sessions.indexOf(synth) : -1
    if (live && idx !== -1) live.sessions.splice(idx, 1)
    if (selectedId.value === synthId) selectedId.value = realId
    fireMigrate(synthId, realId)
    if (wasAgentControlled) reportMaterialized(synthId, realId, folderPath)
  }

  /**
   * Cross-slug re-home (BUG-55): `EnterWorktree` moves a running session's
   * transcript to a new slug dir while the session keeps going. The watcher's
   * add/unlink pair for that move has no ordering guarantee (spec §3.1), so
   * this is add-authoritative — a `session:added` for an id already living
   * under some OTHER folder wins immediately, regardless of whether the old
   * slug's `unlink` has fired yet. Moves the REAL (non-synthetic) row in
   * place — same object — so selection state and the live terminal
   * attachment (keyed by sessionId alone, never by folder) ride along
   * without a restart (AC5). Returns `false` when the session isn't found
   * under any other folder, so the caller can fall through to the ordinary
   * synthetic-collapse / reload paths.
   */
  function reHomeSessionAcrossFolders(sessionId: string, target: Folder): boolean {
    for (const f of folders.value) {
      if (f === target) continue
      const idx = f.sessions.findIndex((s) => s.sessionId === sessionId && s.synthetic !== true)
      if (idx === -1) continue
      const [row] = f.sessions.splice(idx, 1)
      target.sessions.push(row)
      return true
    }
    return false
  }

  function reconcileSessionAdded(slug: string, sessionId: string): void {
    const folder = findFolderBySlugOrPath(slug)
    if (folder) {
      // A session already resolved to a DIFFERENT folder is a cross-slug
      // move, not an agent migration or a synthetic to collapse — re-home it
      // before either of those get a chance to run (BUG-55).
      if (reHomeSessionAcrossFolders(sessionId, folder)) return
      // MCP agent sessions migrate by correlation token, not recency — bind the
      // agent's OWN synthetic (leaving any coexisting user synthetic untouched)
      // before the user-path recency heuristic gets a chance to grab the wrong one.
      if (tryBindAgentMigration(folder, sessionId)) return
      // In-place collapse of the folder's pending synthetic (no reload needed).
      if (collapseSyntheticInto(sessionId, folder.path)) return
      // fall through: folder resolved but no synthetic to absorb.
    }
    // Fallback (folder slug unresolved OR no synthetic found): the real row is
    // not in main's model yet — a reload now would read a stale model (the
    // watcher event outruns the model's refresh window). Record the id instead;
    // the `fleet:changed` push that follows the model refresh reloads, and
    // `reloadModelOnce` collapses THIS realId into its synthetic before commit
    // (sidebar-liveness A6/A7, lesson synthetic-sessions/003 follow-up 2).
    if (!collapseSyntheticInto(sessionId)) {
      pendingCollapse.set(sessionId, { since: Date.now(), slug, seq: ++coverageSeq })
    }
  }

  /**
   * Window around a synthetic's creation in which a freshly-written real
   * session on disk is assumed to be that synthetic's persisted identity.
   */
  const SYNTH_RESOLVE_WINDOW_MS = 5 * 60 * 1000
  const SYNTH_RESOLVE_SKEW_MS = 60 * 1000

  /**
   * Promote the folder's pending synthetic to a real `sessionId` in place
   * without restarting its live terminal. Called from `onSessionUpdated` ONLY
   * when the triggering append is a `/rename` (its caller gates on a
   * `custom-title`). Picks the newest synthetic in the folder.
   */
  function promoteSyntheticForRealId(slug: string, realId: string): Session | null {
    // Delegate to the unified collapser (T18 Fix 1); return the resulting real
    // row so the caller can land the /rename title + backfill on it.
    const ok = collapseSyntheticInto(realId, findFolderBySlugOrPath(slug)?.path)
    return ok ? findSessionById(realId) : null
  }

  /**
   * After a reload, collapse any synthetic whose real session has since landed
   * on disk in the same folder. Matches by folder + creation-time proximity
   * (the `index:updated` event carries no sessionId).
   */
  function collapseResolvedSynthetics(): void {
    for (const folder of folders.value) {
      const synths = folder.sessions.filter((s) => s.synthetic === true)
      if (synths.length === 0) continue
      const claimed = new Set<string>()

      for (const synth of synths) {
        const synthMs = Date.parse(synth.created)
        if (!Number.isFinite(synthMs)) continue

        let twin: Session | null = null
        let bestDelta = Infinity
        for (const s of folder.sessions) {
          if (s.synthetic === true) continue
          // A folder terminal is never the on-disk twin of a synthetic Claude
          // session — it has no JSONL. Without this guard a terminal opened at
          // roughly the same time as a "+ New session" placeholder could be
          // claimed as its real session and spliced into its slot, corrupting
          // both rows (re-introduces the lesson-003 duplication class).
          if (s.isShellTerminal) continue
          if (claimed.has(s.sessionId)) continue
          const ms = Date.parse(s.created)
          if (!Number.isFinite(ms)) continue
          if (ms < synthMs - SYNTH_RESOLVE_SKEW_MS) continue
          if (ms > synthMs + SYNTH_RESOLVE_WINDOW_MS) continue
          const delta = Math.abs(ms - synthMs)
          if (delta < bestDelta) {
            twin = s
            bestDelta = delta
          }
        }
        if (!twin) continue
        claimed.add(twin.sessionId)

        const synthId = synth.sessionId
        folder.sessions.splice(folder.sessions.indexOf(twin), 1)
        const slot = folder.sessions.indexOf(synth)
        if (slot === -1) folder.sessions.push(twin)
        else folder.sessions.splice(slot, 1, twin)
        if (selectedId.value === synthId) selectedId.value = twin.sessionId
        fireMigrate(synthId, twin.sessionId)
      }
    }
  }

  /**
   * Handler for the `folders:adopted` push (T26): an MCP `create_worktree` just
   * created + adopted a worktree in main. Stash its probed git meta keyed by
   * path, then debounce-reload so `mergeFolders` re-runs WITH that meta — the new
   * placeholder folder appears grouped under its repo from the first frame,
   * before Claude has written a `sessions-index.json` under it. Only DEFINED git
   * fields are copied, so an omitted field never lands as an explicit `undefined`.
   */
  function onFolderAdopted(payload: FolderAdoptedPayload): void {
    const meta: GitMeta = {}
    if (payload.repoId !== undefined) meta.repoId = payload.repoId
    if (payload.gitBranch !== undefined) meta.gitBranch = payload.gitBranch
    if (payload.isMainWorktree !== undefined) meta.isMainWorktree = payload.isMainWorktree
    adoptedGitByPath.set(payload.path, meta)
    // T69 fix: a CLI-driven adoption (`harnu .`) carries `select` → reveal the folder
    // once the reload has merged it into the model. An MCP `adopt_folder` (no `select`)
    // only reloads, exactly as before — an agent never steals the operator's view.
    const reload = reloadModelDebounced()
    if (payload.select) void reload.then(() => revealFolder(payload.path))
    else void reload
  }

  /**
   * BUG-56 — the `folders:removed` handler. Forgets the ghost's git meta
   * (mirroring {@link onFolderAdopted}'s inverse) and, unlike the old no-op,
   * ALSO drops the folder + its sessions from the live model directly — same
   * shape as {@link onProjectRemoved}'s slug-keyed splice below, but keyed by
   * the raw path `removeGhostFolder` already normalized on the main side. A
   * debounced reload alone isn't enough here: the folder's directory is
   * already gone, so a rescan would never re-surface it to prune — the splice
   * IS the removal.
   */
  function onFolderRemoved(payload: FolderRemovedPayload): void {
    adoptedGitByPath.delete(payload.path)
    const idx = folders.value.findIndex((f) => f.path === payload.path)
    if (idx !== -1) folders.value.splice(idx, 1)
    if (selectedId.value) {
      const stillExists = allSessions.value.some((s) => s.sessionId === selectedId.value)
      if (!stillExists) selectedId.value = null
    }
    void reloadModelDebounced()
  }

  /**
   * One-shot bootstrap. Loads the initial model and wires every IPC
   * subscription. Safe to call repeatedly: previous subscriptions are torn
   * down first so HMR doesn't leak listeners.
   */
  async function init(): Promise<void> {
    // Retire the legacy "Hide inactive" toggle key on first post-migration load.
    try {
      localStorage.removeItem(LEGACY_HIDE_INACTIVE_KEY)
    } catch {
      /* private mode — ignore */
    }

    // T153: retire the sidebar's folders↔board toggle key. Any stored value
    // ('board' or the older 'team', T66) collapses to the sidebar's only
    // remaining state — folders — by simply dropping the key.
    try {
      localStorage.removeItem(LEGACY_SIDEBAR_VIEW_KEY)
    } catch {
      /* private mode — ignore */
    }

    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop()
      try {
        fn?.()
      } catch {
        /* swallow */
      }
    }
    for (const t of idleTimers.values()) clearTimeout(t)
    idleTimers.clear()
    // Drop any armed agent-migrate timers (HMR re-init must not leak them); the
    // queued pre-prompts go with them.
    for (const entry of agentCorrelations.values()) clearTimeout(entry.timer)
    agentCorrelations.clear()
    pendingAgentPrompts.clear()
    if (reloadDebounceTimer) {
      clearTimeout(reloadDebounceTimer)
      reloadDebounceTimer = null
      reloadDebounceWaiters = []
    }
    pendingCoverage.slugs.clear()
    pendingCoverage.full = 0

    foldersLoading.value = true
    try {
      await reloadModel()
    } finally {
      foldersLoading.value = false
    }

    // T289: the drill stack is restored from localStorage at construction time,
    // but only now can we tell whether its nodes still resolve.
    reconcileDrillStack()

    cleanupFns.push(
      window.api.onProjectAdded(() => {
        void reloadModelDebounced()
      })
    )

    // Sidebar liveness (§4.A A6): main pushes after its model refresh changed
    // membership — the reload that actually brings new sessions and folders.
    // Feature-detected like the MCP feeds: an older preload simply lacks it.
    if (typeof window.api.onFleetChanged === 'function') {
      cleanupFns.push(window.api.onFleetChanged((change) => reloadOnFleetChange(change)))
    }
    // T388: main's worktree tracker pushes each tracked repo's listing.
    if (typeof window.api.onWorktreesChanged === 'function') {
      cleanupFns.push(window.api.onWorktreesChanged((event) => onWorktreesChanged(event)))
    }

    cleanupFns.push(
      window.api.onProjectRemoved(({ slug }) => {
        const folder = findFolderBySlugOrPath(slug)
        if (folder) {
          const idx = folders.value.indexOf(folder)
          if (idx !== -1) folders.value.splice(idx, 1)
        }
        if (selectedId.value) {
          const stillExists = allSessions.value.some((s) => s.sessionId === selectedId.value)
          if (!stillExists) selectedId.value = null
        }
      })
    )

    cleanupFns.push(
      window.api.onSessionAdded(({ slug, sessionId }) => {
        reconcileSessionAdded(slug, sessionId)
      })
    )

    cleanupFns.push(
      window.api.onSessionRemoved(({ slug, sessionId }) => {
        // A transcript gone before its refresh (a crashed `claude` start) must
        // not stay pending or awaiting confirmation forever.
        pendingCollapse.delete(sessionId)
        awaitingConfirm.delete(sessionId)
        const folder = findFolderBySlugOrPath(slug)
        if (!folder) return
        const idx = folder.sessions.findIndex((s) => s.sessionId === sessionId)
        if (idx !== -1) {
          const [removed] = folder.sessions.splice(idx, 1)
          if (selectedId.value === sessionId) selectedId.value = null
          dropArchived(sessionId)
          const t = idleTimers.get(sessionId)
          if (t) {
            clearTimeout(t)
            idleTimers.delete(sessionId)
          }
          for (const a of removed?.agents ?? []) {
            const at = agentDoneTimers.get(a.agentId)
            if (at) {
              clearTimeout(at)
              agentDoneTimers.delete(a.agentId)
            }
          }
        }
      })
    )

    cleanupFns.push(
      window.api.onSessionUpdated(
        ({
          slug,
          sessionId,
          renameTitle,
          aiTitle,
          firstPromptCandidate,
          transcriptState,
          ctxPct,
          awaySummary,
          stagnation
        }) => {
          let s = findSessionById(sessionId)
          if (!s) {
            // Adopt the folder's pending synthetic ONLY when this append is a
            // `/rename` (lands the title on the same row, unsticks the synthetic).
            if (!renameTitle) return
            s = promoteSyntheticForRealId(slug, sessionId)
            if (!s) return
          }
          s.modified = new Date().toISOString()
          if (s.status !== 'active') s.status = 'active'
          // Same cascade as a disk row (`summary = customTitle || aiTitle`): a
          // `/rename` always wins; an `ai-title` only fills an empty summary, so it
          // never clobbers a rename the row already shows.
          if (renameTitle) s.summary = renameTitle
          else if (aiTitle && !s.summary) s.summary = aiTitle

          // Live transcript truth (T91): the watcher derived turn-state / ctx% /
          // away recap from this delta. Apply only what the delta determined — a
          // metadata-only append omits the fields and the prior values stand, so
          // the dot never flickers to `unknown` on a pause/switch re-append.
          if (transcriptState) s.transcriptState = transcriptState
          if (typeof ctxPct === 'number') s.ctxPct = ctxPct
          if (awaySummary) s.awaySummary = awaySummary
          if (stagnation) s.stagnation = stagnation

          // Backfill firstPrompt for a just-migrated synthetic (perf spec §5.1a):
          // the in-place migrate in `reconcileSessionAdded` skipped the disk
          // reload, so without this the row shows "Untitled" and never auto-names.
          // The next organic reload overwrites it with the canonical scraped value.
          if (!s.firstPrompt && firstPromptCandidate) s.firstPrompt = firstPromptCandidate

          maybeAutoname(s)
          scheduleIdle(sessionId)
        }
      )
    )

    cleanupFns.push(
      window.api.onHook(({ sessionId, taskState, ts, failureReason, resetsAt }) => {
        // T92: hook events are the freshest sign of life — anchor the stuck timer to
        // them so a just-started turn (UserPromptSubmit, transcript not grown yet)
        // isn't misread as stalled.
        bumpLastEvent(sessionId, ts)
        applyTaskState(sessionId, taskState, { failureReason, resetsAt })
      })
    )

    // T92: PID session-registry overlay (`~/.claude/sessions/`). A cheap task-state
    // for EXTERNAL sessions Harnu never injected hooks into; applied BELOW hook
    // `taskState` by the fleet classifier. `taskState: null` clears the override.
    cleanupFns.push(
      window.api.onSessionRegistry(({ sessionId, taskState, updatedAt }) => {
        setRegistryState(sessionId, taskState, updatedAt)
      })
    )

    // Screen detection (A2): main streams a screen-derived dot for folder
    // terminals running a recognized agent (codex/aider/…). Same task-state, same
    // dots — `null` reverts to the activity heuristic when the agent exits.
    cleanupFns.push(
      window.api.onScreenState(({ sessionId, taskState }) => {
        applyScreenState(sessionId, taskState)
      })
    )

    // Approval Inbox: tool calls the responder parks (active mode) stream in here;
    // a resolved/timed-out one streams a removal. Re-hydrate the live set so a
    // renderer reload doesn't drop approvals still parked in main.
    cleanupFns.push(window.api.onApprovalPending((wire) => addPendingApproval(wire)))
    cleanupFns.push(
      window.api.onApprovalResolved(({ requestId }) => removePendingApproval(requestId))
    )
    void window.api
      .approvalsList()
      .then((list) => list.forEach(addPendingApproval))
      .catch(() => {})

    // Parked MCP confirms (T44 S4c): an agent-action confirm that arrived while
    // the window was unfocused parks in the inbox instead of the focused-modal
    // overlay. `addParkedConfirm` self-filters to `mode === 'parked'` and fires
    // the chime + OS attention; a `mcp:confirm:resolved` (respond / TTL / cancel /
    // quit) prunes the row. A clicked parked-confirm OS notification opens the
    // inbox. Feature-detected (mirrors the teams-store optional feeds): the
    // MCP-confirm surface is a newer preload addition, so a stub/older preload
    // without it simply gets no parked-confirm queue rather than throwing on boot.
    if (typeof window.api.onMcpConfirmPending === 'function') {
      cleanupFns.push(window.api.onMcpConfirmPending((p) => addParkedConfirm(p)))
    }
    if (typeof window.api.onMcpConfirmResolved === 'function') {
      cleanupFns.push(window.api.onMcpConfirmResolved(({ id }) => removeParkedConfirm(id)))
    }
    // BUG-25: re-hydrate any confirm that parked BEFORE this boot was listening
    // — `onMcpConfirmPending` fires exactly once, at park time in main, so a
    // renderer reload/reconnect after that fire (dev HMR, a crash recovery, a
    // fresh window) used to drop the confirm from every UI surface until the
    // 30-minute operator-away TTL denied it unseen. Mirrors the `approvalsList()`
    // rehydration a few lines up for the sibling hook-approval queue. Every
    // rehydrated confirm is forced into the durable Inbox row (`mode: 'parked'`)
    // regardless of its original render hint — the fast focused-modal is only
    // meaningful in the instant a confirm first arrives, not on a stale reconnect.
    if (typeof window.api.mcpConfirmsList === 'function') {
      void window.api
        .mcpConfirmsList()
        .then((list) => list.forEach((p) => addParkedConfirm({ ...p, mode: 'parked' })))
        .catch(() => {})
    }

    if (typeof window.api.onNotifyActivateInbox === 'function') {
      // Clicking the OS notification used to open the Inbox modal; it now summons
      // the rail (T83 S0). Same intent — "put the queue in front of me" — minus
      // the overlay.
      cleanupFns.push(window.api.onNotifyActivateInbox(() => useLayoutStore().summonInboxRail()))
    }
    // T31: the Sentinel auto-denied a catastrophic command — a danger toast + OS
    // attention so the operator knows WHY a command didn't run (not silent magic).
    if (typeof window.api.onSentinelBlocked === 'function') {
      cleanupFns.push(
        window.api.onSentinelBlocked(({ reason }) => {
          useUiStore().pushToast({
            kind: 'danger',
            title: i18n.global.t('sentinel.blockedTitle'),
            description: reason
          })
          window.api.requestAttention?.()
        })
      )
    }

    // T37 closure axis: stamp last-viewed on EVERY selection (one hook covers
    // select/create/fork/migrate), prune stale ids once, and tick the closure
    // clock so a needs-input session ages into "forgotten" after the threshold.
    cleanupFns.push(
      watch(selectedId, (id) => {
        if (id) stampViewed(id)
      })
    )
    {
      const ids = new Set(allSessions.value.map((s) => s.sessionId))
      const kept = Object.fromEntries(Object.entries(lastViewed.value).filter(([k]) => ids.has(k)))
      if (Object.keys(kept).length !== Object.keys(lastViewed.value).length) {
        lastViewed.value = kept
      }
    }
    const closureTimer = setInterval(() => {
      closureNow.value = Date.now()
    }, 30_000)
    cleanupFns.push(() => clearInterval(closureTimer))

    // Click-to-focus: a clicked OS notification asks us to select its session.
    cleanupFns.push(window.api.onNotifyActivate(({ sessionId }) => activateSession(sessionId)))

    // Track window focus so we can suppress notifications for the session the
    // user is already looking at (os-notifications spec §4).
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onFocus = (): void => {
        windowFocused.value = true
      }
      const onBlur = (): void => {
        windowFocused.value = false
      }
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      cleanupFns.push(() => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
      })
    }

    // Usage-reset notification (usage-reset-notify spec): fire once when the
    // fleet-wide 5h rate-limit window actually rolls over. The decision +
    // dispatch logic lives in checkUsageResetNotification; this is just the
    // reactive glue.
    cleanupFns.push(
      watch(
        () => useUsageStore().rateLimits?.fiveHour?.resetsAtMs ?? null,
        (resetsAtMs) => checkUsageResetNotification(resetsAtMs)
      )
    )

    // Daily-budget threshold alert (daily-budget spec): fire once at 80% and
    // once at 100% of today's share of the weekly limit. Same shape as above —
    // the decision + dispatch live in checkDailyBudgetNotification.
    cleanupFns.push(
      watch(
        () => useDailyBudgetStore().budget,
        (b) => checkDailyBudgetNotification(b, useDailyBudgetStore().dayKey)
      )
    )

    cleanupFns.push(
      window.api.onIndexUpdated(() => {
        void reloadModelDebounced().then(collapseResolvedSynthetics)
      })
    )

    cleanupFns.push(
      window.api.onWatcherDegraded(({ code, message }) => {
        watcherStatus.value = { degraded: true, code, message }
      })
    )

    cleanupFns.push(
      window.api.onSubagentUpdated(({ slug, parentSessionId, agentId, meta }) => {
        applySubagentUpdate(slug, parentSessionId, agentId, meta)
      })
    )
    cleanupFns.push(
      window.api.onSubagentRemoved(({ slug, parentSessionId, agentId }) => {
        removeSubagent(slug, parentSessionId, agentId)
      })
    )

    // ---- MCP control surface (T25/T26) ----
    // Worktree-adopt pushes: re-group a freshly-adopted worktree under its repo.
    // Feature-detected — the channels are added to the preload by the integrator
    // (T27); without them (or in unit tests) the wiring simply no-ops.
    const mcp = getMcpApi()
    if (typeof mcp.onFolderAdopted === 'function') {
      cleanupFns.push(mcp.onFolderAdopted(onFolderAdopted))
    }
    // T45: now that `folders:adopted` is subscribed, pull the folder Harnu was
    // launched with (`harnu .`) — main adopts it → it pins into the sidebar.
    if (typeof window.api.cliOpenPending === 'function') void window.api.cliOpenPending()
    if (typeof mcp.onFolderRemoved === 'function') {
      cleanupFns.push(mcp.onFolderRemoved(onFolderRemoved))
    }

    // T113: mirror main's background manifest-drain progress app-wide (board
    // strip + confirm-needed toast), independent of the board being open.
    cleanupFns.push(useRoadmapDrainStore().wire())

    // Command-dispatch: bind the renderer command router to the real store
    // actions, subscribe to the CommandBridge, and emit the renderer-ready
    // handshake. Wired LAST so the model + watcher subscriptions are live before
    // main is told it may actuate against this window.
    cleanupFns.push(wireCommandDispatch())
  }

  return {
    folders,
    foldersLoading,
    visibleFolders,
    boardBuckets,
    triageQueue,
    dismissedFolders,
    manuallyHiddenPaths,
    agentDeniedPaths,
    interceptFolders,
    aliasFromBranchPaths,
    autoOrganizeOffPaths,
    orchestratorSessionIds,
    orchestratorDefaultPaths,
    selectedId,
    selectedFolderPath,
    activeFolderPath,
    selectedSession,
    selectedPath,
    allSessions,
    watcherStatus,
    prefsBySession,
    keyboardCursor,
    filterActive,
    filterQuery,
    sessionSort,
    folderSort,
    sidebarDensity,
    activeWindowMs,
    sessionWindowMs,
    notifyPrefs,
    windowFocused,
    init,
    reloadModel,
    rescan,
    select,
    selectFolder,
    clearSelection,
    revealFolderPath,
    revealFolder,
    clearRevealFolder,
    revealSessionId,
    clearRevealSession,
    // Jump palette (T288)
    recentJumpSearches,
    recentJumpVisits,
    jumpFlash,
    clearJumpFlash,
    recordJumpSearch,
    clearJumpSearches,
    jumpToFolder,
    jumpToSession,
    unhideAndJump,
    applyQueryAsFilter,
    onFolderAdopted,
    onFolderRemoved,
    applyTaskState,
    applyScreenState,
    setNotifyPref,
    checkUsageResetNotification,
    checkDailyBudgetNotification,
    closeSession,
    reloadSession,
    isSessionLive,
    reattachImage,
    injectPathIntoSession,
    createNewSession,
    dispatchCardSession,
    registerFolderImmediate,
    createForkedSession,
    folderExists,
    insertAgentSession,
    takeAgentPrompt,
    requeueAgentPrompt,
    hasAgentPrompt,
    // Background boot queue + dead-synthetic reaper (BUG-23).
    agentBootQueue,
    enqueueAgentBoot,
    sessionWakeQueue,
    enqueueSessionWake,
    takeSessionWakes,
    armAgentBootDeadline,
    armAgentCorrelationForBoot,
    takeAgentBoots,
    retrySyntheticBoot,
    markSyntheticBootFailed,
    // Injection watchdog escalation (docs/specs/2026-07-15-preprompt-injection-watchdog.md).
    markPromptUndelivered,
    retryPromptInjection,
    registerPromptRetryHandler,
    createFolderTerminal,
    closeFolderTerminal,
    terminalsForFolder,
    countSessions,
    findFolderByPath,
    findSessionById,
    fleetStateFor,
    folderAliasOf,
    activateSession,
    newSessionInCurrentContext,
    registerCloseHandler,
    registerMigrateHandler,
    registerReloadHandler,
    markSessionExited,
    toggleFolder,
    toggleGroup,
    drillDepth,
    drillModeEnabled,
    drillStack,
    groupInVisible,
    cycleDrillDepth,
    drillIntoGroup,
    drillIntoFolder,
    drillBack,
    reconcileDrillStack,
    groupAliases,
    setGroupAlias,
    expandAll,
    collapseAll,
    pinFolder,
    dismissFolder,
    unhideFolder,
    setFolderAgentDenied,
    setFolderInterceptActive,
    renameFolder,
    setFolderAliasFromBranch,
    setFolderAutoOrganize,
    isFolderAutoOrganizeOn,
    setFolderOrchestratorDefault,
    setFolderBornFrom,
    listBornFromCandidates,
    setSessionSort,
    setFolderSort,
    setSidebarDensity,
    setActiveWindow,
    setSessionWindow,
    setFilterQuery,
    setFilterActive,
    attentionCount,
    supervisionLoad,
    nowTick: closureNow,
    activityOf,
    forgottenSessions,
    markSessionSeen,
    sessionsForDisplay,
    teammateLeadCandidates,
    isTeammatesExpanded,
    toggleTeammatesExpanded,
    olderSessionCount,
    isOlderRevealed,
    toggleRevealOlder,
    archivedIds,
    isArchived,
    archiveSession,
    unarchiveSession,
    isArchivedRevealed,
    toggleRevealArchived,
    archivedSessionCount,
    markHibernated,
    clearHibernated,
    registryStates,
    getPrefs,
    toggleNoFlicker,
    isSessionRemoteControlOn,
    setSessionRemoteControl,
    isSessionOrchestratorOn,
    toggleOrchestrator,
    registerLiveSession,
    unregisterLiveSession,
    pendingApprovals,
    pendingApprovalList,
    pendingApprovalCount,
    addPendingApproval,
    removePendingApproval,
    resolveApproval,
    parkedConfirms,
    parkedConfirmList,
    parkedConfirmCount,
    resolveParkedConfirm,
    inboxCount,
    actionableInboxCount,
    agentsExpanded,
    isAgentsExpanded,
    toggleAgents,
    cursorDown,
    cursorUp,
    cursorRight,
    cursorLeft,
    cursorActivate,
    __pendingCollapseSizeForTests,
    __awaitingConfirmSizeForTests,
    __knownReposForTests
  }
})
