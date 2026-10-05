import { basename } from 'node:path'
import { isFolderDenied } from './permission-core'
import { redactTranscript } from './transcript-redact'
import type { TaskState, FailureReason } from '../hook-state'

/**
 * Pure core for `harnu_fleet_status` (T7): project the store's folders + sessions
 * into the REDACTED snapshot an MCP agent is allowed to read. Framework-free
 * (no electron / fs / child_process — only `node:path` for `basename`, like
 * `folder-model.ts`) so it lands in the pure-core coverage surface (ADR-0001)
 * and unit-tests deterministically.
 *
 * The disclosure contract is the reason this module exists:
 *  - With `redactPaths`, absolute paths NEVER leave the process — every folder
 *    collapses to a stable `alias` (path basename) plus its `repoId`/git fields.
 *  - A PTY transcript or last rendered line is NEVER projected. The agent sees
 *    `taskState` (the hook FSM) + `status` (the store activity heuristic) — the
 *    same two truths the Fleet board reads — and nothing of the raw bytes.
 *  - `agentControllable` tells the agent where it may act. Post-reversal that is
 *    EVERYWHERE except a folder the operator explicitly blocked, so it is computed
 *    from `denyFolders` (prefix-scoped — a worktree of a blocked repo is blocked
 *    too), NOT from an allowlist. Getting this wrong is not cosmetic: an agent that
 *    reads `agentControllable: false` self-censors and the machine sits idle, which
 *    is the exact failure the reversal exists to remove.
 *  - In-flight agent-created sessions (minted by a write tool but not yet on
 *    disk) are merged in so a read-after-write within the same turn sees them.
 *
 * ONE DOCUMENTED EXCEPTION to the "no absolute paths under `redactPaths`" rule
 * (T215): a session's `peer.socket`. It is a RUNTIME address under
 * `$XDG_RUNTIME_DIR` (or the tmp fallback), not a project path — it names a pid
 * and nothing about the user's repositories — and disclosing it is the whole
 * point of the field: an agent that can see `{ pid, socket }` knows exactly
 * which process a session id maps to, which is what makes `message_session`'s
 * addressing auditable rather than a guess. It is still passed through
 * {@link redactTranscript}, so a socket that happens to live under the home dir
 * (a `CLAUDE_CODE_TMPDIR` there, or macOS's `$TMPDIR`) is aliased to `~` and
 * never leaks the OS username.
 */

/** Session activity status from the store (mirrors `SessionStatus`). */
export type SessionStatus = 'active' | 'idle' | 'archived'

/**
 * Minimal folder slice the snapshot needs — resolved by the caller from a
 * `FolderEntry`. The git fields are optional (absent for a non-repo folder).
 */
export interface FleetFolderInput {
  /** Absolute folder path (the store's cwd key). Redacted unless opted out. */
  path: string
  repoId?: string
  gitBranch?: string
  isMainWorktree?: boolean
}

/**
 * Minimal session slice. `lastLine`/`transcript` MAY exist on the caller's
 * richer object (PTY replay) but are declared here only to document that they
 * are intentionally NOT projected — the snapshot never copies them.
 */
export interface FleetSessionInput {
  sessionId: string
  /** Absolute owning-folder path (`projectPath`). Redacted to an alias. */
  folderPath: string
  status: SessionStatus
  isSidechain: boolean
  /** ISO timestamp; invalid/empty sinks to the end of its folder group. */
  modified: string
  /** Present on the caller's object; deliberately NOT projected. */
  lastLine?: string
  /** Present on the caller's object; deliberately NOT projected. */
  transcript?: string
  /** Whether this session is currently armed as an Orchestrator (T98). */
  orchestrator?: boolean
  /** Parked by the T119 hibernation policy — process killed, transcript intact on disk. */
  hibernated?: boolean
  /** T215: the resolved cross-session peer address, when one answers. */
  peer?: PeerAddress
}

/**
 * T215: a session's cross-session inbox address — the pid Harnu holds for it and
 * the Unix socket its `claude` is listening on.
 *
 * Present ONLY for a session with a live Harnu-owned PTY whose socket actually
 * ANSWERED a connect. An address that merely might work is worse than none,
 * because a caller reads it as reachability.
 *
 * This is what kills the identity ambiguity the T215 card documented: one
 * session showing up as a branch-ish slug, a short handle, and a prose sentence,
 * none of which is its title or names its worktree. A pid and a socket path are
 * unambiguous.
 */
export interface PeerAddress {
  pid: number
  socket: string
}

/** A redacted folder row in the snapshot. */
export interface FleetFolderSnapshot {
  /** Stable redacted label (path basename). The only folder identity disclosed. */
  alias: string
  repoId?: string
  gitBranch?: string
  isMainWorktree?: boolean
  /** True iff this folder's path is in the allowlist. */
  agentControllable: boolean
  /** Absolute path — present ONLY when `redactPaths` is false. */
  path?: string
}

/** A redacted session row in the snapshot. Never carries transcript/lastLine. */
export interface FleetSessionSnapshot {
  sessionId: string
  /** Redacted owning-folder label (matches the folder's `alias`). */
  folderAlias: string
  /** Hook FSM truth from `taskStates`; undefined until the first hook arrives. */
  taskState?: TaskState
  /**
   * Why `taskState` is `'failed'` — only ever present alongside it. Sourced
   * from a genuinely hook-driven `StopFailure`, OR (BUG-64) a renderer-
   * reported delivery failure (`prompt_undelivered`) that never reaches a
   * Claude Code hook at all — the same field either way, so a caller never
   * has to special-case which axis reported the failure.
   */
  failureReason?: FailureReason
  /** Store activity status. */
  status: SessionStatus
  isSidechain: boolean
  modified: string
  /** True iff the owning folder is in the allowlist. */
  agentControllable: boolean
  /** True for an agent-created session not yet reported on disk (read-after-write). */
  inflight: boolean
  /**
   * Whether this session is currently promoted to Orchestrator (T98) — a
   * legible marker alongside `taskState`/`status`, the same two truths the
   * Fleet board reads. Present only when true (a redacted `false` per row
   * would be pure noise on the common case).
   */
  orchestrator?: boolean
  /**
   * T215: the resolved peer address (`{ pid, socket }`), present only for a
   * session with a live Harnu-owned process whose cross-session socket answered.
   *
   * Absence means "not addressable RIGHT NOW", and it is not one fact but
   * several: no Harnu-owned process, a CLI predating the cross-session inbox,
   * the messaging gate off, a remote thin client, or a failed bind. Do not read
   * it as "that session is dead".
   *
   * The socket path is an absolute path, so it goes through the same redaction
   * contract as every other path this snapshot discloses.
   */
  peer?: PeerAddress
  /**
   * Parked by Harnu to reclaim memory (T119): the process was killed after the session
   * went cold. The conversation is intact on disk and selecting it resumes it. Present
   * only when true.
   *
   * A parked session is NOT dead and NOT stuck. It reports no `taskState` (nothing is
   * running, so we genuinely do not know what it would be doing) — do not read that
   * absence as a stall, and do not respawn work on top of it. That mistake is the
   * `orchestrator-idle-not-stalled` failure.
   */
  hibernated?: boolean
}

/** The full redacted fleet projection. */
export interface FleetSnapshot {
  folders: FleetFolderSnapshot[]
  sessions: FleetSessionSnapshot[]
}

/** Inputs gathered by the shell from the store + hook FSM + the in-flight registry. */
export interface BuildFleetSnapshotInput {
  folders: readonly FleetFolderInput[]
  sessions: readonly FleetSessionInput[]
  /** Hook FSM state keyed by `sessionId` (the sidebar-dot truth). */
  taskStates: Readonly<Record<string, TaskState>>
  /**
   * Why a session's `taskState` is `'failed'`, keyed by `sessionId` (BUG-64).
   * Optional — absent entirely for a caller that hasn't wired a failure-reason
   * source yet, which is exactly today's behavior (no field is projected).
   */
  failureReasons?: Readonly<Record<string, FailureReason>>
  /** Agent-created sessions not yet migrated from synthetic → on-disk. */
  inflightAgentSessions: readonly FleetSessionInput[]
}

/** Disclosure options: path redaction + the per-folder BLOCK list. */
export interface BuildFleetSnapshotOptions {
  /** When true (the default for agent disclosure), absolute paths are stripped. */
  redactPaths: boolean
  /**
   * Absolute folder paths the operator BLOCKED for agents (`Policy.denyFolders`).
   * Drives `agentControllable`, which is `true` for every folder that is not one of
   * these and not inside one. Absent/empty ⇒ everything is controllable, which is
   * the default posture.
   */
  denyFolders?: readonly string[]
  /**
   * T215: the caller's absolute home directory, used to alias `peer.socket`
   * through {@link redactTranscript}. Injected (never read from `os`) so this
   * module stays pure. Omitted ⇒ no aliasing, which is safe: the common Linux
   * socket path (`/run/user/<uid>/cc-socks/…`) contains no home segment.
   */
  home?: string
}

/** Stable redacted alias for an absolute path — its last segment. */
function redactAlias(path: string): string {
  const base = basename(path)
  return base.length > 0 ? base : path
}

/** Parse `modified` to a sortable number; invalid/empty sinks to the end. */
function recentKey(modified: string): number {
  const ms = Date.parse(modified)
  return Number.isFinite(ms) ? ms : -Infinity
}

/** Lexical string compare (locale-independent, fully deterministic). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Build the redacted fleet snapshot. Pure + deterministic + non-mutating:
 *
 *  - Folders are ordered by `path` ascending and projected to `{ alias, repoId?,
 *    gitBranch?, isMainWorktree?, agentControllable }` — plus the absolute
 *    `path` only when `redactPaths` is false.
 *  - Sessions are the union of `sessions` and `inflightAgentSessions`, deduped by
 *    `sessionId` with the on-disk entry winning (a migrated session beats its
 *    in-flight twin). Each carries `taskState` (looked up in `taskStates`),
 *    `status`, `isSidechain`, `modified`, `agentControllable`, and an `inflight`
 *    flag — never a transcript or last PTY line. Ordering is `(folderPath asc,
 *    modified desc, sessionId asc)` so a shuffled input yields identical output.
 *
 * @param input - folders, sessions, the hook-FSM map, and in-flight agent sessions.
 * @param options - `redactPaths` (strip absolute paths) + the `denyFolders` blocks.
 * @returns the `{ folders, sessions }` snapshot safe to disclose to an MCP agent.
 */
export function buildFleetSnapshot(
  input: BuildFleetSnapshotInput,
  options: BuildFleetSnapshotOptions
): FleetSnapshot {
  const denied = options.denyFolders ?? []
  // Prefix-scoped, and normalized on BOTH sides — a raw scanned path and a stored
  // block written with a trailing slash / `~` must collapse to the same identity, or
  // the flag silently lies about a folder the gate would actually allow.
  const controllable = (path: string): boolean => !isFolderDenied(path, denied)
  // T215: the ONE absolute path this snapshot may disclose (see the module
  // doc's documented exception) — scrubbed through the same best-effort
  // redactor the transcript preview uses, never appended blind.
  const redactPath = (p: string): string =>
    options.home ? redactTranscript(p, { home: options.home }).text : p

  const folders = [...input.folders]
    .sort((a, b) => cmpStr(a.path, b.path))
    .map((f) => {
      const out: FleetFolderSnapshot = {
        alias: redactAlias(f.path),
        agentControllable: controllable(f.path)
      }
      if (f.repoId !== undefined) out.repoId = f.repoId
      if (f.gitBranch !== undefined) out.gitBranch = f.gitBranch
      if (f.isMainWorktree !== undefined) out.isMainWorktree = f.isMainWorktree
      if (!options.redactPaths) out.path = f.path
      return out
    })

  // Union: on-disk sessions first, then in-flight ones whose id isn't already
  // present (the migrated entry wins, so no duplicate row appears).
  const seen = new Set<string>()
  const merged: Array<{ s: FleetSessionInput; inflight: boolean }> = []
  for (const s of input.sessions) {
    if (seen.has(s.sessionId)) continue
    seen.add(s.sessionId)
    merged.push({ s, inflight: false })
  }
  for (const s of input.inflightAgentSessions) {
    if (seen.has(s.sessionId)) continue
    seen.add(s.sessionId)
    merged.push({ s, inflight: true })
  }

  merged.sort(
    (a, b) =>
      cmpStr(a.s.folderPath, b.s.folderPath) ||
      recentKey(b.s.modified) - recentKey(a.s.modified) ||
      cmpStr(a.s.sessionId, b.s.sessionId)
  )

  const sessions = merged.map(({ s, inflight }) => {
    const out: FleetSessionSnapshot = {
      sessionId: s.sessionId,
      folderAlias: redactAlias(s.folderPath),
      status: s.status,
      isSidechain: s.isSidechain,
      modified: s.modified,
      agentControllable: controllable(s.folderPath),
      inflight
    }
    const ts = input.taskStates[s.sessionId]
    if (ts !== undefined) out.taskState = ts
    const fr = input.failureReasons?.[s.sessionId]
    if (fr !== undefined) out.failureReason = fr
    if (s.orchestrator === true) out.orchestrator = true
    if (s.hibernated === true) out.hibernated = true
    // T215: the peer address, scrubbed through the same redactor the transcript
    // preview uses — the socket path is absolute, and on a machine where
    // `CLAUDE_CODE_TMPDIR` (or macOS's `$TMPDIR`) sits under the home dir it
    // would otherwise leak the OS username into a snapshot that redacts every
    // other path.
    if (s.peer) {
      out.peer = {
        pid: s.peer.pid,
        socket: redactPath(s.peer.socket)
      }
    }
    return out
  })

  return { folders, sessions }
}

// ---- T358 S6: the per-mission scoped projection (design §7) -------------------

/** Inputs for {@link buildMissionFleetProjection}: the fleet inputs plus two live side tables. */
export interface MissionFleetInput extends BuildFleetSnapshotInput {
  /** Approval Inbox requests parked right now — only `sessionId` is read. */
  pendingApprovals?: readonly { sessionId: string }[]
  /** Epoch ms of each session's last `taskState` transition (the hook FSM edge). */
  lastTransitionAt?: Readonly<Record<string, number>>
}

/** One linked child's live state, as `mission_get` reports it per step. */
export interface MissionChildState {
  sessionId: string
  /**
   * False when no fleet row matches the id — a session never seen on disk, or
   * one Harnu does not track. The link is reported, not dropped, so an owner
   * sees a typo'd or vanished child instead of a silently shorter list.
   */
  known: boolean
  folderAlias?: string
  status?: SessionStatus
  taskState?: TaskState
  failureReason?: FailureReason
  hibernated?: boolean
  inflight?: boolean
  peer?: PeerAddress
  modified?: string
  /** Approval Inbox requests this session has parked right now. */
  pendingApprovals: number
  /** ISO time of the session's last `taskState` transition, when one was observed. */
  lastTransitionAt?: string
}

/** The scoped projection: exactly the mission's linked sessions, in link order. */
export interface MissionFleetProjection {
  missionId: string
  sessions: MissionChildState[]
}

/**
 * The fleet, scoped to ONE mission's linked sessions (T358 S6, design §7).
 *
 * `get_fleet` is unscoped by design — every folder, every session (the T360
 * smoke test measured hundreds of folder rows). A mission needs the live state
 * of the handful of sessions its steps link, so the inputs are filtered to
 * `linkedSessionIds` BEFORE the shared {@link buildFleetSnapshot} projects
 * them: the same redaction and the same `taskState`/`hibernated`/`peer` truth,
 * with no folder rows and no unrelated session ever built.
 *
 * Order follows `linkedSessionIds` (first occurrence wins); an id with no fleet
 * row comes back `known: false`. Pure, like the rest of this module.
 */
export function buildMissionFleetProjection(
  missionId: string,
  linkedSessionIds: readonly string[],
  input: MissionFleetInput,
  options: BuildFleetSnapshotOptions
): MissionFleetProjection {
  const wanted = [...new Set(linkedSessionIds)]
  if (wanted.length === 0) return { missionId, sessions: [] }
  const ids = new Set(wanted)
  const snap = buildFleetSnapshot(
    {
      folders: [],
      sessions: input.sessions.filter((s) => ids.has(s.sessionId)),
      taskStates: input.taskStates,
      failureReasons: input.failureReasons,
      inflightAgentSessions: input.inflightAgentSessions.filter((s) => ids.has(s.sessionId))
    },
    options
  )
  const rows = new Map(snap.sessions.map((s) => [s.sessionId, s]))
  const approvals = new Map<string, number>()
  for (const a of input.pendingApprovals ?? []) {
    if (ids.has(a.sessionId)) approvals.set(a.sessionId, (approvals.get(a.sessionId) ?? 0) + 1)
  }
  const sessions = wanted.map((sessionId): MissionChildState => {
    const pendingApprovals = approvals.get(sessionId) ?? 0
    const row = rows.get(sessionId)
    if (!row) return { sessionId, known: false, pendingApprovals }
    const out: MissionChildState = {
      sessionId,
      known: true,
      folderAlias: row.folderAlias,
      status: row.status,
      modified: row.modified,
      pendingApprovals
    }
    if (row.taskState !== undefined) out.taskState = row.taskState
    if (row.failureReason !== undefined) out.failureReason = row.failureReason
    if (row.hibernated) out.hibernated = true
    if (row.inflight) out.inflight = true
    if (row.peer) out.peer = row.peer
    const at = input.lastTransitionAt?.[sessionId]
    if (at !== undefined && Number.isFinite(at)) out.lastTransitionAt = new Date(at).toISOString()
    return out
  })
  return { missionId, sessions }
}

/** Default cap on `get_fleet` sessions so the default response stays bounded (BUG-4). */
export const DEFAULT_FLEET_LIMIT = 50

/** Filters for {@link filterFleetSnapshot} (T44 S3). `now` is injected (pure). */
export interface FleetFilter {
  /** Only sessions currently working or awaiting input. */
  activeOnly?: boolean
  /** Only sessions modified within the last N minutes. */
  sinceMinutes?: number
  /** Cap the number of sessions (most-recent first). Defaults to DEFAULT_FLEET_LIMIT. */
  limit?: number
  /** Wall clock (ms) — supplied by the shell so this stays pure/deterministic. */
  now: number
}

/** A filtered fleet snapshot; `truncated` is set when the cap dropped sessions. */
export interface FilteredFleetSnapshot extends FleetSnapshot {
  truncated?: { shown: number; total: number }
}

/**
 * Trim a fleet snapshot for disclosure (T44 S3 — proprioception; closes the
 * BUG-4 "67k-char firehose" face). Pure + deterministic:
 *  - `activeOnly` keeps only `working` / `needs-input` sessions;
 *  - `sinceMinutes` keeps only sessions modified within the window;
 *  - results are ordered most-recent-first and capped at `limit`
 *    (default {@link DEFAULT_FLEET_LIMIT}) — never a SILENT cap: when sessions are
 *    dropped, `truncated: { shown, total }` says so.
 * Folders are left intact (they are already compact); only sessions are trimmed.
 */
export function filterFleetSnapshot(
  snap: FleetSnapshot,
  filter: FleetFilter
): FilteredFleetSnapshot {
  let sessions = snap.sessions
  if (filter.activeOnly) {
    sessions = sessions.filter((s) => s.taskState === 'working' || s.taskState === 'needs-input')
  }
  if (filter.sinceMinutes != null) {
    const cutoff = filter.now - filter.sinceMinutes * 60_000
    sessions = sessions.filter((s) => recentKey(s.modified) >= cutoff)
  }
  sessions = [...sessions].sort((a, b) => recentKey(b.modified) - recentKey(a.modified))

  const total = sessions.length
  const cap = filter.limit ?? DEFAULT_FLEET_LIMIT
  const shown = sessions.slice(0, cap)
  const out: FilteredFleetSnapshot = { folders: snap.folders, sessions: shown }
  if (shown.length < total) out.truncated = { shown: shown.length, total }
  return out
}
