import { spawn, IPty } from 'node-pty'
import { randomUUID } from 'crypto'
import { ipcMain, BrowserWindow } from 'electron'
import os from 'os'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { resolveClaudePath } from './claude-cli'
import {
  applyCompanionArgv,
  applyCompanionEnv,
  companionHelloSeen,
  isSideloadBlocked,
  markSideloadBlocked,
  releaseCompanionSpawn,
  reportCompanionSideloadExit,
  trustFor,
  type CompanionSpawnPlan,
  type CompanionSpawnProvider
} from './companion/spawn-inject'
import {
  injectedPluginDirs,
  shouldRetryWithoutSideload,
  stripInjectedPluginDirs,
  RETRY_WINDOW_MS
} from './companion/sideload-retry-core'
import { defaultShell } from './shell-resolve'
import { resolveClaudeBootArgs, getResolvedConfig } from './claude-config'
import {
  buildClaudeArgs,
  forceReadOnlyPermission,
  mergeBootConfig,
  withOptionArgs,
  type ClaudeBootConfig
} from './claude-args'
import {
  sanitizeCorrective,
  withReviewCorrective,
  type ReviewCorrective
} from './review-corrective'
import { injectHookSettings } from './hook-settings-blob'
import { forceDowngradePermission } from './mcp/agent-boot'
import { orderMcpArgs } from './mcp/config-file'
import type { SpawnOwner } from './companion/session-table'
import { PtySessionIndex } from './pty-session-index'
import {
  companionHost,
  setCompanionSessionKeyResolver,
  setCompanionSpawnKindResolver
} from './companion/host'
import { pruneTaskState } from './hook-bridge'
import { RingBuffer } from './pty-ring-buffer'
import { foregroundProcessName } from './detect/foreground-process'
import { sanitizeSpawnEnv, mergeLoginPath, loginPathOnce } from './appimage-env'
import { arm, isArmed, shouldArmAtSpawn } from './orchestrator-guard'
import { HARNU_ORCHESTRATOR_DOC } from './harnu-orchestrator'
import { resolveModeContract } from './extensions/extensions-loader'
import { getUserProjectAutoOrganize, getUserProjectOrchestratorDefault } from './user-projects'
import { autoOrganizeLine } from './auto-organize-line'
import {
  clearHibernated,
  isHibernated,
  markHibernated,
  markParking,
  isParking,
  clearParking,
  recordPark,
  recordWake,
  missionOwnersWithLiveChildren,
  type WakeGesture
} from './hibernation'
import { harnuOwnsSession, type SpawnOrigin } from './messaging-socket'
import {
  evaluateFleet,
  type LiveSession,
  type Trigger,
  type FleetKind,
  type FleetTaskState
} from './fleet-policy'
import { getTaskStates } from './hook-bridge'
import { getPolicy } from './monitor/policy-store'

/**
 * Resolve a requested cwd to a directory that actually exists on disk.
 *
 * node-pty calls `chdir(2)` in the child before exec; a non-existent path
 * fails with `chdir(2) failed.: No such file or directory` and the PTY exits
 * before producing any output. We see this when a session's `projectPath`
 * (from `sessions-index.json#originalPath`) points at a worktree that has
 * since been pruned (PR merged → branch deleted → `git worktree prune` ran).
 *
 * Strategy: walk up the requested path until we find an existing ancestor;
 * fall back to `~` if nothing in the chain exists. The walk is bounded by
 * `dirname` reaching its fixed point (`/` → `/`, `C:\` → `C:\`).
 *
 * Logs a warning when the requested path was substituted so callers (renderer
 * toast, log scraper) can surface it.
 */
function resolveCwd(requested: string | undefined): string {
  const home = os.homedir()
  if (!requested) return home
  if (existsSync(requested)) return requested

  let p = requested
  let prev = ''
  while (p && p !== prev) {
    if (existsSync(p)) {
      // eslint-disable-next-line no-console
      console.warn(`[pty] cwd "${requested}" missing; falling back to nearest ancestor "${p}"`)
      return p
    }
    prev = p
    p = dirname(p)
  }
  // eslint-disable-next-line no-console
  console.warn(`[pty] cwd "${requested}" has no existing ancestor; falling back to home "${home}"`)
  return home
}

/**
 * Build the POSIX `/bin/sh` command that prints the stale-directory notice with
 * ANSI styling, given the (untrusted) original cwd.
 *
 * SECURITY: the cwd is **never** interpolated into the `-c` script. It is passed
 * as a positional parameter (`$1`) and referenced through printf `%s`
 * conversions, so a malicious cwd — `$(touch /tmp/PWNED)`, backticks, embedded
 * single quotes, `;rm -rf` — is treated as an inert literal string and can never
 * reach an interpreted position. (`%s` performs no escape/word processing, and
 * the ANSI escapes / newlines live entirely in the static format operand.)
 *
 * Exported for unit testing of the injection guard.
 */
export function buildPosixMissingDirNotice(cwd: string): { command: string; args: string[] } {
  // Static printf format operand. `\033` = ESC, `\047` = single quote (so the
  // displayed `mkdir -p '...'` carries no *literal* single quotes that could
  // break the single-quoting of the format in the `-c` body), `%s` = cwd slot.
  const format = [
    '\\033[33mThis session\\047s original directory no longer exists:\\033[0m',
    '  \\033[2m%s\\033[0m',
    '',
    'The session log is preserved at \\033[2m~/.claude/projects/\\033[0m,',
    'but `claude --resume` cannot pick it up without the original cwd.',
    '',
    'Recreate the directory (\\033[36mmkdir -p \\047%s\\047\\033[0m)',
    'or pick a different session from the sidebar.',
    ''
  ].join('\\n')
  // `$0` = "sh", `$1` = cwd. The cwd reaches printf only as the `"$1"` argument,
  // which `%s` renders verbatim — no shell or printf interpretation.
  return { command: '/bin/sh', args: ['-c', `printf '${format}' "$1" "$1"`, 'sh', cwd] }
}

/**
 * Build the (command, args) that print the "original directory is gone" notice
 * and exit, per platform. POSIX uses `/bin/sh -c printf` with ANSI styling
 * (see `buildPosixMissingDirNotice`); Windows uses PowerShell (no `/bin/sh`),
 * plain text.
 */
function buildMissingDirNotice(cwd: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const lines = [
      "This session's original directory no longer exists:",
      `  ${cwd}`,
      '',
      'The session log is preserved at ~/.claude/projects/,',
      'but `claude --resume` cannot pick it up without the original cwd.',
      '',
      'Recreate the directory or pick a different session from the sidebar.',
      ''
    ]
    const body = lines.map((l) => `Write-Host '${l.replace(/'/g, "''")}'`).join('; ')
    // Always PowerShell here: the `-NoProfile -Command` flags below are
    // PowerShell-only, so we must not fall back to `%ComSpec%` (typically
    // cmd.exe, which would mis-parse them). `defaultShell()` is for the
    // interactive split-terminal shell, not this fixed notice command.
    return { command: 'powershell.exe', args: ['-NoProfile', '-Command', body] }
  }
  return buildPosixMissingDirNotice(cwd)
}

/**
 * A v4-style session uuid (the JSONL filename `claude --resume` looks up). We
 * validate `claudeSessionId` against this before appending it to the `claude`
 * argv (defense-in-depth): the value originates from disk/renderer state, and
 * even though it goes through `spawn`'s argv (not a shell), pinning the shape
 * rejects anything that could confuse the CLI's flag parsing.
 */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What the spawned process is. Determines how `pty:create` resolves the binary
 * and what args/env we apply. `'shell'` is the legacy back-compat behavior
 * (defaults to `$SHELL`). The three `'claude-*'` kinds use the resolved `claude`
 * CLI from `./claude-cli` and either launch fresh (`claude`) or resume a
 * specific session by uuid (`claude --resume <uuid>`).
 */
export type PtyKind = 'shell' | 'claude-new' | 'claude-resume' | 'claude-fork'

/**
 * Why a `pty:exit` fired (BUG-70 §3). `'park'` means the process was killed to
 * reclaim memory (`hibernateSession`) — a resource decision, not a lifecycle
 * outcome — and consumers must not treat it as a completion. Absent on the wire
 * means `'natural'` (back-compat with a stale preload/renderer pair).
 */
export type PtyExitReason = 'natural' | 'park'

interface CreateOpts {
  cwd?: string
  cols: number
  rows: number
  /** Default `'shell'` for back-compat. */
  kind?: PtyKind
  /**
   * Required when `kind === 'claude-resume'` / `'claude-fork'`: the session uuid
   * to resume (filename of the JSONL).
   *
   * OPTIONAL for `kind === 'claude-new'`, where it means the opposite — a uuid
   * the CALLER minted, emitted as `--session-id <uuid>` so the new session's
   * transcript lands at a filename the app already knows (T245: the review
   * companion needs to be able to hand its conversation to a `--resume` when the
   * operator promotes it to a working session). Absent ⇒ a bare `claude`, and
   * Claude picks the uuid itself, as every other new session does.
   */
  claudeSessionId?: string
  /**
   * The renderer's logical session key (its `liveTerminals` map key): a real
   * session uuid for resumes, a `synthetic-<uuid>` id for new/fork sessions.
   * When present, `pty:create` dedups against it (I1) and registers the spawned
   * ptyId under it. Omitted for plain `'shell'` PTYs.
   */
  sessionKey?: string
  /** Only honored when `kind === 'shell'`. Ignored otherwise. */
  cmd?: string
  /** Only honored when `kind === 'shell'`. Ignored otherwise. */
  args?: string[]
  /**
   * When true, spawns with `CLAUDE_CODE_NO_FLICKER=1` in the env, which switches
   * Claude to the alt-screen renderer and sidesteps the SIGWINCH scrollback
   * leak documented in `findings/04-pty-xterm-production.md` §4. Trade-off:
   * scrolling becomes single-line / less smooth. The env var is read by
   * Claude only at spawn time, so toggling mid-session has no effect on the
   * already-running process — the renderer must destroy + recreate the PTY
   * for the new value to take effect.
   */
  noFlicker?: boolean
  /**
   * One-shot per-session launch overrides from the New session dialog. Merged
   * on top of global + per-folder config (session wins) by `resolveClaudeBootArgs`.
   * Only meaningful for `claude-*` kinds; not persisted anywhere.
   */
  bootOverride?: ClaudeBootConfig
  /**
   * When true, this `claude-*` session is being spawned by an MCP agent (an
   * untrusted caller). Two security downgrades apply at spawn:
   *  1. `forceDowngradePermission` strips any permission-bypass flag the user's
   *     own `claude-boot.json` may carry (defense-in-depth — see `mcp/agent-boot.ts`).
   *  2. Harnu's app-managed `--mcp-config` is WITHHELD, so the agent gets NO
   *     Harnu MCP server (prevents a recursive Conductor).
   * Inert for `'shell'` kinds. Default `false`.
   */
  agentControlled?: boolean
  /**
   * T245: spawn this `claude-*` session READ-ONLY — Harnu's review companion, a
   * fresh stranger reading a diff the operator is about to approve. Two
   * downgrades apply at spawn, both AFTER the user's own Claude Boot scopes are
   * merged so no setting of theirs can undo them:
   *  1. `forceReadOnlyPermission` forces `--permission-mode plan`, hard-denies
   *     the file-writing tools, and scrubs the permission-bypass escape hatches.
   *  2. Harnu's app-managed `--mcp-config` is WITHHELD, same as
   *     {@link agentControlled}: a reviewer holding `create_session` /
   *     `create_worktree` could put an agent's hands on the very worktree it is
   *     forbidden to edit — the "one hop removed" write path the PRD names.
   *
   * Distinct from {@link agentControlled}, which is about an UNTRUSTED CALLER;
   * this is about a trusted caller asking for a deliberately weaker session.
   * Inert for `'shell'` kinds. Default `false`.
   */
  readOnly?: boolean
  /**
   * T247: the five scalars a read-only REVIEW companion is told about the review
   * it was opened beside — base + head commit SHAs, the head's readability
   * state, whether the folder is a repo at all, and the PR number when there is
   * one. Composed into `--append-system-prompt` by `review-corrective.ts` and
   * delivered as a system-prompt fragment, never as a user turn.
   *
   * Deliberately NOT `bootOverride`: this door is five scalars wide, so nothing
   * on the spec's normative exclusion list (CI state, PR/review state, counts, a
   * file list, the diff body, anything from `evidence`) can physically cross it,
   * and no caller can widen it by passing a richer object. `sanitizeCorrective`
   * re-narrows whatever arrives, so that is a property of MAIN rather than a
   * promise about the renderer.
   *
   * Absent ⇒ no orientation is composed at all. Only meaningful together with
   * {@link readOnly}: a future read-only pane that is not a review must not
   * inherit a review's orientation.
   */
  reviewCorrective?: ReviewCorrective
  /**
   * T123/T138: the mode the renderer resolved for this session (`Modes ▸`).
   * Resolves the mode's contract (`resolveModeContract`,
   * `extensions/extensions-loader.ts`) into the `--append-system-prompt`
   * preamble, alongside `HARNU_ORCHESTRATOR_DOC`. `string`, not the closed
   * `SessionModeId` union — an id may name a builtin OR an installed
   * extension's `contributes.modes` entry; either way an unknown/undefined
   * value degrades to no contract, never throws.
   */
  mode?: string
  /**
   * How the operator (or an explicit gesture) is waking this session (BUG-70
   * §4 park ledger). Defaults to `'unknown'` when omitted — today no caller
   * threads a real value through; the ledger mechanism is what this card
   * delivers, wiring the renderer's actual gestures through is a follow-up.
   */
  wakeGesture?: WakeGesture
  /**
   * T215: WHO caused this spawn — stamped at origin by the renderer, which is
   * the only layer that knows the gesture. `'agent'` for an MCP
   * `create_session` synthetic and for a board/manifest dispatch; `'operator'`
   * for "+ New session" and for a selection-driven resume of a cold transcript.
   *
   * Read back by `message_session` (`ownershipForSession`): an operator-owned
   * recipient is refused. Omitted ⇒ treated as `'operator'` (fail closed) — a
   * spawn path that forgets to stamp it must never silently open the
   * operator's own session to agent traffic.
   */
  spawnedBy?: SpawnOrigin
}

// One coalescing window per PTY: 16 ms timer + 256 KB high-watermark burst flush.
// Buffers raw `pty.onData` strings into a single string and flushes either when
// the timer fires or when the accumulated byte count hits the watermark.
// See `findings/05-ipc-streaming-perf.md` §3 for rationale (option c).
interface FlushState {
  buf: string
  size: number
  timer: ReturnType<typeof setTimeout> | null
}

interface PtyRec {
  pty: IPty
  flush: FlushState
  /** Rolling scrollback for replay on renderer re-adoption (I4). */
  ring: RingBuffer
  /** Total bytes ever flushed to the renderer. Tagged onto each `pty:data`. */
  seq: number
  /** Logical session key (renderer's `liveTerminals` key). Absent for shells. */
  sessionKey?: string
  /** What this PTY is, so `pty:list` can hand it back for re-adoption. */
  kind: PtyKind
  /** Current grid size, kept fresh on resize so adoption spawns at parity. */
  cols: number
  rows: number
  /**
   * Epoch ms this PTY was spawned (T119). Diagnostics + the focus fallback — NEVER an
   * eviction criterion on its own: the oldest session is usually the main orchestrator,
   * i.e. the last thing you'd want to kill. Coldness predicts disposability; age does not.
   */
  startedAt: number
  /**
   * Epoch ms of the last byte flushed to the renderer (T119) — the session's pulse.
   *
   * Safe as an activity signal because an IDLE `claude` emits ZERO bytes: measured over
   * 130 s of a parked prompt, 0 reads (spec §9 spike). If that ever changes, the sweep
   * stops firing and this is the first place to look.
   */
  lastActivityAt: number
  /**
   * T215: the spawn origin the renderer stamped ({@link CreateOpts.spawnedBy}).
   * Absent ⇒ `'operator'` at every read site (fail closed).
   */
  spawnedBy?: SpawnOrigin
  /** T363: the directory the PTY runs in — locates the repo whose missions it may own. */
  cwd: string
}

/**
 * The record-side effect of a synth→real migration (BUG-65). Applied to whatever
 * `PtyRec` (or a test double shaped like one) is bound to the ptyId being rekeyed.
 *
 * The rekey event IS the proof the transcript now exists on disk — it fires from
 * `reconcileSessionAdded`, driven by the chokidar `add` on the real JSONL — so
 * promoting `claude-new`/`claude-fork` to `claude-resume` here is sound: that is
 * precisely the fact `isParkable` (fleet-policy.ts) wants and could not previously
 * observe, since `kind` was otherwise frozen at spawn for the PTY's whole life.
 *
 * Pure (mutates only the passed-in record) so it's unit-testable without touching
 * electron/node-pty — same posture as `PtySessionIndex` and `buildPosixMissingDirNotice`.
 */
export function applyRekeyToRecord(
  rec: { sessionKey?: string; kind: PtyKind },
  toKey: string
): void {
  rec.sessionKey = toKey
  if (rec.kind === 'claude-new' || rec.kind === 'claude-fork') rec.kind = 'claude-resume'
}

const COALESCE_MS = 16
const HIGH_WATERMARK = 256 * 1024

/**
 * Per-PTY scrollback retained for replay on re-adoption (spec §4.2). 256 KiB
 * matches the renderer backpressure low/high watermarks — enough to repaint a
 * screenful-plus of TUI history without unbounded memory per session.
 */
const RING_CAP_BYTES = 256 * 1024

const ptys = new Map<string, PtyRec>()

/**
 * Injected provider for the app-managed `--mcp-config` argv (Harnu's own loopback
 * MCP server). Defaults to `[]` so the feature is OFF until the integrator wires
 * it via {@link setMcpArgsProvider}; the provider itself returns `[]` whenever
 * the MCP server pref is disabled (see `mcp/config-file.ts#appManagedMcpArgs`).
 * Prepended BEFORE the user's resolved Boot args for non-agent `claude-*` spawns
 * so a user `--mcp-config` can never displace Harnu's. Agent-controlled spawns
 * NEVER receive it (no recursive Conductor).
 */
let mcpArgsProvider: () => string[] = () => []

/** Wire the app-managed MCP argv provider (called once by the integrator). */
export function setMcpArgsProvider(fn: () => string[]): void {
  mcpArgsProvider = fn
}

/**
 * Injected provider for the "Harnu self-awareness" preamble (T55): the environment
 * doc prepended to a `claude-*` session's `--append-system-prompt` when the feature
 * is enabled, or `''` when off. Defaults to `() => ''` (feature contributes nothing)
 * until the integrator wires it via {@link setHarnuPreambleProvider}. Sync so the
 * argv-build step can read it without an await. Applied to every `claude-*` kind
 * (new/resume/fork, agent AND non-agent branches); NEVER to `shell`.
 */
let harnuPreambleProvider: () => string = () => ''

/** Wire the Harnu self-awareness preamble provider (called once by the integrator). */
export function setHarnuPreambleProvider(fn: () => string): void {
  harnuPreambleProvider = fn
}

/**
 * Injected provider for the T92 per-session hook `--settings` blob JSON (points at
 * the live Hook Bridge). Returns `null` when injection is opted out or the bridge
 * isn't listening. Defaults to `() => null` (feature OFF) until wired via
 * {@link setHookSettingsProvider}. Sync so the argv-build step reads it without an
 * await. Applied to EVERY `claude-*` kind (agent and non-agent) via the pure
 * `injectHookSettings`, which composes with any user-provided `--settings`.
 * NEVER applied to `shell` kind. The blob carries the bridge token —
 * never log its value.
 */
let hookSettingsProvider: () => string | null = () => null

/** Wire the per-session hook-settings provider (called once by the integrator). */
export function setHookSettingsProvider(fn: () => string | null): void {
  hookSettingsProvider = fn
}

/**
 * Injected provider for T217's bundled-skill argv: given the argv built so far and
 * the session's cwd, stage that folder's ENABLED bundled skills and append
 * `--plugin-dir <staged path>`. Returns the argv UNCHANGED when nothing is enabled
 * for the folder (the default) or when staging failed — so a default install spawns
 * byte-identical argv to before the feature existed.
 *
 * Defaults to a pass-through (feature OFF) until wired via
 * {@link setBundledSkillsArgsProvider}. Async because staging touches the disk;
 * the argv-build step is already async at this point. Applied to every `claude-*`
 * kind, agent and non-agent alike: the staged content is Harnu's OWN product asset,
 * so there is no `agentControlled` reason to withhold it. NEVER applied to
 * `shell` kind.
 */
let bundledSkillsArgsProvider: (args: string[], cwd: string) => Promise<string[]> = async (a) => a

/** Wire the bundled-skills argv provider (called once by the integrator). */
export function setBundledSkillsArgsProvider(
  fn: (args: string[], cwd: string) => Promise<string[]>
): void {
  bundledSkillsArgsProvider = fn
}

/**
 * T389: the companion mod's spawn provider — the second, unconditional `--plugin-dir` and the
 * spawn token. `null` (the default, and the answer whenever the mode is off, the CLI version is
 * unknown or too old, the machine is sideload-blocked or staging failed) leaves the spawn
 * exactly as it was. Same shape as {@link setBundledSkillsArgsProvider}; NEVER applied to `shell`.
 */
let companionSpawnProvider: CompanionSpawnProvider = async () => null

/** Wire the companion spawn provider (called once by the integrator). */
export function setCompanionSpawnProvider(fn: CompanionSpawnProvider): void {
  companionSpawnProvider = fn
}

/**
 * session key -> live ptyId. Source of truth for "1 session = 1 process"
 * (I1/I5). Survives renderer reloads because it lives in the main process;
 * the renderer's `liveTerminals` map does not. See the 2026-06-01 spec.
 */
const sessionIndex = new PtySessionIndex()

/**
 * T215 ownership ledger: `sessionKey → who caused its most recent spawn`.
 *
 * Kept ALONGSIDE the PTY record rather than only on it, because
 * `hibernateSession` deletes the record — and a parked session is precisely the
 * one `message_session` may need to wake, so reading the origin off a record
 * that no longer exists would refuse every parked recipient and make the whole
 * wake path dead code.
 *
 * Scoped to the app run, exactly like the parked set (`hibernation.ts`), and
 * for the same reason: after a restart the process is gone too, so an empty
 * ledger is a true negative. Overwritten on the next spawn of the same key; a
 * key is never cleared, so a park→wake round trip preserves it.
 */
const sessionSpawnOrigins = new Map<string, SpawnOrigin>()

/**
 * session key -> epoch ms the operator last selected it (T119). The renderer is the only
 * thing that knows about focus, so it pushes over `pty:touchFocus`.
 *
 * Deliberately separate from `PtyRec.lastActivityAt`: hibernation requires BOTH to be cold,
 * so a session that is unattended but still emitting (an agent working while you're at
 * lunch) is immune, and so is one you just opened but haven't driven yet.
 */
const lastFocusedAt = new Map<string, number>()

/** The session the operator currently has open. Never a hibernation victim. */
let selectedSessionKey: string | null = null

const SWEEP_INTERVAL_MS = 60_000
let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Stop the hibernation sweep. Called from `before-quit`, beside `killAllPtys`. */
export function stopHibernationSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  // T389 P1W3: a PTY binding's `sessionKey` is whatever key the index holds for its ptyId right
  // now, so a `pty:rekey` below moves it without any bookkeeping of the companion's own.
  setCompanionSessionKeyResolver((owner) =>
    owner.kind === 'pty' ? (sessionIndex.getSessionKey(owner.ptyId) ?? null) : null
  )
  setCompanionSpawnKindResolver((owner) =>
    owner.kind === 'pty' ? (ptys.get(owner.ptyId)?.kind ?? null) : null
  )

  function flushNow(id: string): void {
    const rec = ptys.get(id)
    if (!rec) return
    const s = rec.flush
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    if (!s.buf) return
    const data = s.buf
    s.buf = ''
    s.size = 0
    // Record into the ring + advance the cumulative seq BEFORE sending, so the
    // `seq` on the wire is the end offset of these bytes and `pty:replay` (which
    // calls flushNow first) returns a snapshot whose seq exactly matches.
    rec.ring.push(data)
    rec.seq += Buffer.byteLength(data, 'utf8')
    // T119: the session's pulse. An idle `claude` emits nothing, so a fresh stamp here
    // genuinely means "this session is doing something".
    rec.lastActivityAt = Date.now()
    getWindow()?.webContents.send('pty:data', { id, data, seq: rec.seq })
  }

  /**
   * Project the live PTY table into the pure policy's input shape (T119).
   *
   * `isSelected` comes from the tracked `selectedSessionKey` rather than a global reach —
   * keeping `evaluateFleet` honest about everything it depends on. Sessions with no
   * `sessionKey` (plain split-terminal shells) are omitted: they have no transcript, so
   * there is nothing to resume them from.
   */
  function fleetSnapshot(): LiveSession[] {
    const states = getTaskStates()
    const out: LiveSession[] = []
    for (const rec of ptys.values()) {
      if (!rec.sessionKey) continue
      out.push({
        sessionKey: rec.sessionKey,
        kind: rec.kind,
        taskState: states.get(rec.sessionKey) ?? null,
        lastFocusedAt: lastFocusedAt.get(rec.sessionKey) ?? rec.startedAt,
        lastActivityAt: rec.lastActivityAt,
        isSelected: rec.sessionKey === selectedSessionKey,
        // The Approval Inbox lives outside pty.ts. A session blocked on a confirm is
        // `needs-input` in the hook FSM, which is NOT in the immunity list — parking it
        // is safe (the confirm is re-raised on resume). Wired as `false` deliberately,
        // not forgotten; revisit if a confirm is ever found to be lost on wake.
        hasPendingApproval: false
      })
    }
    // T363: never park an active mission's owner while one of its children is live.
    const owners = missionOwnersWithLiveChildren(
      [...ptys.values()].flatMap((r) =>
        r.sessionKey ? [{ sessionKey: r.sessionKey, cwd: r.cwd }] : []
      )
    )
    for (const s of out) if (owners.has(s.sessionKey)) s.ownsLiveMission = true
    return out
  }

  /**
   * Park a session: kill the process, flag it, drop the renderer's terminal.
   *
   * The conversation is NOT lost — it lives in the JSONL, and the next `activate()` takes
   * the existing `claude-resume` path, indistinguishable from opening a cold disk session.
   * That is why this needs no new resume machinery.
   */
  function hibernateSession(sessionKey: string): void {
    const ptyId = sessionIndex.getPtyId(sessionKey)
    if (!ptyId) return
    const rec = ptys.get(ptyId)
    if (!rec) return
    flushNow(ptyId)
    if (rec.flush.timer) clearTimeout(rec.flush.timer)
    // BUG-70 §3.1: tag BEFORE `.kill()` — `onExit` can fire on a later tick, and
    // by then `sessionIndex.getSessionKey(ptyId)` returns undefined (the index
    // entry is removed below), so the ptyId is the only surviving identifier.
    markParking(ptyId)
    try {
      rec.pty.kill()
    } catch {
      // Defensive: a failed kill can't leave a permanent tag that would
      // mislabel a later natural exit of a reused id.
      clearParking(ptyId)
    }
    ptys.delete(ptyId)
    sessionIndex.removeByPtyId(ptyId)
    pruneTaskState(sessionKey)
    lastFocusedAt.delete(sessionKey)
    markHibernated(sessionKey)
    recordPark(sessionKey, Date.now())
    getWindow()?.webContents.send('pty:hibernated', { sessionKey })
  }

  /**
   * Run the policy for one trigger and park whatever it names. Reads the persisted
   * policy (T127 S4) on every call rather than caching it, so an edit in Settings
   * takes effect on the very next cap/sweep check — no restart.
   */
  function runPolicy(trigger: Trigger): string[] {
    const victims = evaluateFleet(fleetSnapshot(), Date.now(), getPolicy(), trigger)
    for (const key of victims) hibernateSession(key)
    return victims
  }

  ipcMain.handle('pty:create', async (_e, opts: CreateOpts): Promise<string> => {
    // Dedup (I1): if this logical session already has a live PTY, reuse it
    // instead of spawning a duplicate `claude --resume`. This guard lives in
    // the main process, so it survives a renderer reload — the case that
    // produced two `claude --resume <uuid>` clones (2026-06-01 spec §1, Defect 3).
    if (opts.sessionKey) {
      const existing = sessionIndex.getPtyId(opts.sessionKey)
      if (existing && ptys.has(existing)) return existing
    }
    // T119 cap: the fleet is about to grow, so park the coldest eligible session(s) to stay
    // at/under maxLive. Runs AFTER the dedup guard (a reused PTY isn't growth). Yields —
    // parks nobody and lets the spawn through — when nothing is eligible (spec §3.5).
    if (opts.sessionKey) runPolicy('cap')

    const id = randomUUID()
    const kind: PtyKind = opts.kind ?? 'shell'

    // Resolve binary + args per kind. `claude-*` paths surface a clear error
    // when the CLI isn't on PATH so the renderer can show a useful message
    // instead of `spawn ENOENT`.
    let command: string
    let args: string[]
    // `ANTHROPIC_*` overrides from a resolved custom-endpoint provider (local
    // model fallback). Empty for the Anthropic default; merged into the spawn
    // env below. Only `claude-*` kinds carry a provider.
    let providerEnv: Record<string, string> = {}
    // T389: the companion mod's plan for THIS spawn (null → exactly as before), and the plugin
    // dirs Harnu itself put on the argv (what the sideload retry may take off again).
    let companionPlan: CompanionSpawnPlan | null = null
    let injectedDirs: string[] = []
    if (kind === 'claude-new' || kind === 'claude-resume' || kind === 'claude-fork') {
      const claudePath = await resolveClaudePath()
      if (!claudePath) {
        throw new Error(
          'Could not find the `claude` CLI on PATH or in common install locations. ' +
            'Install it via `npm install -g @anthropic-ai/claude-code` (or your preferred method) and restart the app.'
        )
      }
      command = claudePath
      // App-managed base args per kind. User "Claude Boot" options (global +
      // per-folder, resolved from `claude-boot.json` by cwd) are appended after
      // these by `resolveClaudeBootArgs`, which also strips any session-breaking
      // flags from the user's free-form escape hatch (see `claude-args.ts`).
      let base: string[]
      // T344: the effective claudeSessionId for THIS spawn — normally just
      // `opts.claudeSessionId`, but the folder-default arm-at-spawn path
      // (below) may mint one when the caller didn't supply any, so the
      // `--session-id` argv and the `isArmed` check downstream both see the
      // SAME id.
      let effectiveClaudeSessionId = opts.claudeSessionId
      if (kind === 'claude-new') {
        // A caller-minted uuid (T245) is emitted as `--session-id`; without one
        // this stays a bare `claude` and the CLI mints its own.
        if (opts.claudeSessionId && !SESSION_UUID_RE.test(opts.claudeSessionId)) {
          throw new Error(`Invalid claudeSessionId (expected a session uuid)`)
        }
        // T344 AC-2/AC-3: the per-folder "new sessions start as Orchestrator"
        // default. Mint a uuid (if the caller didn't supply one) and arm it
        // BEFORE spawn, so `isArmed` below — and the CLI's very first turn —
        // both see it as already armed. `shouldArmAtSpawn` independently
        // excludes every agent-dispatched shape (AC-3), so this can never
        // fire for MCP `create_session`, a board/manifest dispatch, or a
        // T245 read-only companion, regardless of the folder flag.
        const folderDefaultOn = await getUserProjectOrchestratorDefault(opts.cwd ?? '')
        if (
          shouldArmAtSpawn({
            kind,
            agentControlled: !!opts.agentControlled,
            readOnly: !!opts.readOnly,
            spawnedBy: opts.spawnedBy,
            folderDefaultOn
          })
        ) {
          effectiveClaudeSessionId = effectiveClaudeSessionId ?? randomUUID()
          await arm(effectiveClaudeSessionId, opts.cwd ?? '', 'default')
        }
        base = effectiveClaudeSessionId ? ['--session-id', effectiveClaudeSessionId] : []
      } else if (kind === 'claude-resume') {
        if (!opts.claudeSessionId) {
          throw new Error('claudeSessionId is required when kind === "claude-resume"')
        }
        if (!SESSION_UUID_RE.test(opts.claudeSessionId)) {
          throw new Error(`Invalid claudeSessionId (expected a session uuid)`)
        }
        base = ['--resume', opts.claudeSessionId]
      } else {
        // kind === 'claude-fork' — spawn claude --resume <orig> --fork-session.
        // Claude loads the source session's full history-to-disk, then on first
        // event line writes to a fresh UUID. The two sessions diverge from there.
        if (!opts.claudeSessionId) {
          throw new Error('claudeSessionId is required when kind === "claude-fork"')
        }
        if (!SESSION_UUID_RE.test(opts.claudeSessionId)) {
          throw new Error(`Invalid claudeSessionId (expected a session uuid)`)
        }
        base = ['--resume', opts.claudeSessionId, '--fork-session']
      }
      // Harnu self-awareness preamble (T55): prepended to the effective
      // --append-system-prompt when the feature is on (composeAppendSystemPrompt),
      // never clobbering the user's append and never touching --system-prompt.
      // Applied to every claude-* kind, agent and non-agent alike.
      const harnuPreambleBase = harnuPreambleProvider()
      // T98: this session's own contract, injected the SAME way (prepended ahead
      // of the user's append), independent of the T55 preamble toggle — arming a
      // session is an explicit per-session opt-in via "Promote to orchestrator",
      // so the contract lands even when the general self-awareness doc is off.
      const orchestratorArmed = effectiveClaudeSessionId
        ? await isArmed(effectiveClaudeSessionId)
        : false
      // T106: the per-repo auto-organize toggle-awareness line, resolved fresh at
      // every spawn (mirrors the T85 memory-language line) — coupled to the T55
      // preamble toggle since it's guidance about the same "Roadmap board"
      // capability that doc describes.
      const autoOrganizeAwareness = harnuPreambleBase
        ? autoOrganizeLine(await getUserProjectAutoOrganize(opts.cwd ?? ''))
        : ''
      // T138: resolves either the builtin registry (in-memory) or an
      // installed extension's contributes.modes doc (read fresh from disk) —
      // same "explicit opt-in, so the contract must always land" reasoning
      // as the orchestrator doc, now id-agnostic to whether the mode is
      // builtin or extension-contributed.
      const modeDoc = await resolveModeContract(opts.mode)
      const harnuPreamble = [
        harnuPreambleBase,
        orchestratorArmed ? HARNU_ORCHESTRATOR_DOC : '',
        modeDoc,
        autoOrganizeAwareness
      ]
        .filter(Boolean)
        .join('\n\n')
      const spawnCfg = await resolveClaudeBootArgs(opts.cwd, base, opts.bootOverride, harnuPreamble)
      providerEnv = spawnCfg.env
      if (opts.readOnly) {
        // T245 read-only companion. Same shape as the agentControlled branch
        // below — re-resolve the merged config, force it into read-only shape,
        // rebuild argv from THAT, and withhold the app-managed --mcp-config —
        // but for a different reason: not an untrusted caller, a deliberately
        // weaker session. Rebuilding (rather than post-filtering `spawnCfg.args`)
        // is what makes it airtight: the argv is derived from a config that no
        // longer contains a way out.
        const baseCfg = await getResolvedConfig(opts.cwd)
        const merged = opts.bootOverride ? mergeBootConfig(baseCfg, opts.bootOverride) : baseCfg
        // T247: the orientation goes on AFTER the read-only shape is fixed, so
        // the prose describes a posture that is already true rather than one it
        // is asserting. `withReviewCorrective` touches `appendSystemPrompt` and
        // nothing else — no flag, no permission, no new spawn path.
        const readOnlyCfg = forceReadOnlyPermission(merged)
        args = buildClaudeArgs(
          base,
          opts.reviewCorrective
            ? withReviewCorrective(readOnlyCfg, sanitizeCorrective(opts.reviewCorrective))
            : readOnlyCfg,
          harnuPreamble
        )
      } else if (opts.agentControlled) {
        // MCP-spawned agent: untrusted. Re-resolve the merged boot cfg
        // (global ⊕ folder ⊕ override) and strip any permission-bypass flag the
        // user's own claude-boot.json may carry (forceDowngradePermission,
        // defense-in-depth), rebuilding argv from the downgraded cfg. WITHHOLD
        // the app-managed --mcp-config so the agent gets NO Harnu MCP server.
        const baseCfg = await getResolvedConfig(opts.cwd)
        const merged = opts.bootOverride ? mergeBootConfig(baseCfg, opts.bootOverride) : baseCfg
        args = buildClaudeArgs(base, forceDowngradePermission(merged), harnuPreamble)
      } else {
        // Prepend Harnu's app-managed --mcp-config (when the MCP server is enabled)
        // BEFORE the user's resolved Boot args so a user --mcp-config can't bury it.
        args = orderMcpArgs(mcpArgsProvider(), spawnCfg.args)
      }
      // Every argv injector runs INSIDE `withOptionArgs`, which hands them only the
      // OPTION portion and re-appends the bare `--` + positional pre-prompt tail
      // afterwards. That ordering is load-bearing, not cosmetic: `resolveClaudeBootArgs`
      // ends the argv with `-- <pre-prompt>`, and anything appended after that
      // separator is a POSITIONAL argument the CLI never parses as a flag. BUG-86
      // was exactly this — a freshly spawned session got neither `--settings` nor
      // `--plugin-dir`, while resumed sessions (no pre-prompt, so no separator)
      // worked. Add the NEXT injector inside this callback, never after it.
      companionPlan = await companionSpawnProvider({
        cwd: opts.cwd ?? '',
        kind,
        owner: { kind: 'pty', ptyId: id },
        trust: trustFor({
          readOnly: opts.readOnly,
          agentControlled: opts.agentControlled,
          spawnedBy: opts.spawnedBy
        })
      })
      args = await withOptionArgs(args, async (optionArgs) => {
        const before = [...optionArgs]
        let out = optionArgs
        // T92: inject per-session hook `--settings` so this Claude session POSTs its
        // lifecycle to the Hook Bridge (event-driven fleet state) and Harnu owns
        // notifications. Composes with any user `--settings` without clobbering it.
        // Applied to agent + non-agent spawns alike; a `null` provider is a no-op.
        const hookBlob = hookSettingsProvider()
        if (hookBlob) out = injectHookSettings(out, hookBlob)
        // T217: emit `--plugin-dir <staged>` for the bundled skills this FOLDER has
        // switched on. A skill that is off is never staged, so it is absent from the
        // session's catalog by construction; an empty enabled set emits nothing.
        // T389: the companion is the FIRST `--plugin-dir`, inserted before the bundled-skills
        // one (and before a user's own), inside this callback so it stays before the `--`.
        out = applyCompanionArgv(out, companionPlan)
        // A machine that blocks sideloaded plugins gets neither Harnu flag (§7.8).
        if (!isSideloadBlocked()) out = await bundledSkillsArgsProvider(out, opts.cwd ?? '')
        injectedDirs = injectedPluginDirs(before, out)
        return out
      })
    } else {
      command = opts.cmd ?? defaultShell()
      args = opts.args ?? []
    }

    // Build the child env. `sanitizeSpawnEnv` strips AppImage-runtime pollution
    // (mount-rooted PATH/LD_LIBRARY_PATH/… entries + APPDIR/APPIMAGE/ARGV0/OWD)
    // so the spawned shell runs in the same environment a normal terminal would
    // — without it, the AppImage's bundled libs/PATH leak into every session and
    // break the user's tooling (e.g. mise: "<AppImage> is not a valid shim").
    // No-op outside an AppImage. Then merge `CLAUDE_CODE_NO_FLICKER=1` when the
    // per-session toggle is on (see `findings/04-pty-xterm-production.md` §4).
    const env: Record<string, string> = {
      ...sanitizeSpawnEnv(process.env as Record<string, string | undefined>, {
        execPath: process.execPath
      }),
      ...(opts.noFlicker ? { CLAUDE_CODE_NO_FLICKER: '1' } : {}),
      // Custom-endpoint provider overrides (ANTHROPIC_BASE_URL / _MODEL / auth).
      // Last so they win over any inherited Anthropic env from the parent.
      ...providerEnv
    }
    // Restore the user's real toolchain on PATH. A GUI/AppImage launch never
    // sourced `.zshrc`/`mise activate`, so `node` (mise) and `rtk` (~/.local/bin)
    // are missing — spawned `claude` sessions then fail their `command` hooks
    // with `… not found`. Fold the login-shell PATH (captured once) ahead of the
    // sanitized base. Best-effort: a failed capture leaves PATH untouched.
    const mergedPath = mergeLoginPath(env.PATH, await loginPathOnce())
    if (mergedPath) env.PATH = mergedPath
    // Stale-directory guard for claude kinds. The session UUID is registered
    // under the slug derived from its ORIGINAL cwd; if that directory was
    // deleted (worktree pruned, project moved), `claude --resume` looks in
    // a different slug and prints a confusing "No conversation found" error.
    // We catch this earlier and show a clear message instead of letting the
    // user think the app is broken.
    let runCommand = command
    let runArgs = args
    let runCwd = resolveCwd(opts.cwd)
    const wantedDirMissing =
      (kind === 'claude-resume' || kind === 'claude-new' || kind === 'claude-fork') &&
      !!opts.cwd &&
      !existsSync(opts.cwd)
    if (wantedDirMissing) {
      const notice = buildMissingDirNotice(opts.cwd ?? '')
      runCommand = notice.command
      runArgs = notice.args
      runCwd = os.homedir()
    }

    // T389: the spawn token. It never survives from the parent env, and is minted only when
    // `claude` really runs (the missing-directory notice replaces the command, so it gets none).
    const companionOwner: SpawnOwner = { kind: 'pty', ptyId: id }
    applyCompanionEnv(env, {
      plan: companionPlan,
      owner: companionOwner,
      dirMissing: wantedDirMissing
    })
    // The retry below only ever applies to a spawn that carried the COMPANION's plugin dir.
    const companionInjected =
      !!companionPlan && !wantedDirMissing && injectedDirs.includes(companionPlan.pluginDir)
    const spawnOpts = {
      name: 'xterm-256color',
      cwd: runCwd,
      cols: opts.cols,
      rows: opts.rows,
      env
    }

    const pty = spawn(runCommand, runArgs, spawnOpts)

    const spawnedAt = Date.now()
    const rec: PtyRec = {
      pty,
      flush: { buf: '', size: 0, timer: null },
      ring: new RingBuffer(RING_CAP_BYTES),
      seq: 0,
      sessionKey: opts.sessionKey,
      kind,
      cols: opts.cols,
      rows: opts.rows,
      startedAt: spawnedAt,
      lastActivityAt: spawnedAt,
      // T215: fail closed — an unstamped spawn is treated as the operator's.
      spawnedBy: opts.spawnedBy === 'agent' ? 'agent' : 'operator',
      cwd: runCwd
    }
    ptys.set(id, rec)
    if (opts.sessionKey) {
      // Waking clears the parked flag, so a session with a live PTY can never stay
      // flagged as hibernated (T119, spec §5.1 — self-healing by construction).
      clearHibernated(opts.sessionKey)
      // BUG-70 §4: record the wake against the ledger instead of letting the
      // clear above erase the only trace a park happened. A no-op when this
      // key has no open park entry (the common "brand-new session" case).
      recordWake(opts.sessionKey, spawnedAt, opts.wakeGesture ?? 'unknown')
      // Seed focus so a just-spawned session is never instantly the coldest victim.
      lastFocusedAt.set(opts.sessionKey, spawnedAt)
      sessionIndex.register(opts.sessionKey, id)
      sessionSpawnOrigins.set(opts.sessionKey, rec.spawnedBy ?? 'operator')
      // Announce session readiness on a single channel (payload carries the
      // sessionKey) so the renderer can blanket-subscribe (`onSessionReady`)
      // and gate agent-prompt injection without knowing keys ahead of time.
      // `ptyId` rides along for the MCP fleet view (resolve without polling).
      getWindow()?.webContents.send('pty:sessionReady', { sessionKey: opts.sessionKey, ptyId: id })
      // T215: settle any main-process waiter parked on this key. The wake path
      // (`message_session` on a parked recipient) has to know the resume
      // actually landed before it resolves a socket — a live PTY is not yet a
      // bound socket, but it is the precondition for one.
      resolveSessionReadyWaiters(opts.sessionKey)
    }

    // T389: the process behind `rec.pty` can be replaced ONCE by the sideload retry (below), so
    // the data and exit handlers are attached per process rather than once per record.
    let launchedAt = spawnedAt
    let firstTail = ''
    let blockedTimer: ReturnType<typeof setTimeout> | null = null

    const wire = (proc: IPty, isRetry: boolean): void => {
      proc.onData((data) => {
        if (!isRetry && companionInjected) firstTail = (firstTail + data).slice(-2048)
        const s = rec.flush
        s.buf += data
        s.size += Buffer.byteLength(data, 'utf8')
        if (s.size >= HIGH_WATERMARK) {
          flushNow(id)
        } else if (!s.timer) {
          s.timer = setTimeout(() => flushNow(id), COALESCE_MS)
        }
      })

      proc.onExit((evt) => {
        // Drain any buffered bytes before the exit event so the renderer sees
        // every byte the child produced.
        flushNow(id)
        if (blockedTimer) clearTimeout(blockedTimer)

        // T389 §7.8: a spawn that carried Harnu's plugin dir and died at once without the mod
        // ever saying hello is retried ONCE without Harnu's own `--plugin-dir` flags and without
        // the token; `pty:exit` is not forwarded for the first process. Never for a spawn that
        // was not injected, a park or a destroy.
        if (
          !isRetry &&
          companionInjected &&
          ptys.get(id) === rec &&
          !isParking(id) &&
          shouldRetryWithoutSideload({
            injected: true,
            exitCode: evt.exitCode,
            livedMs: Date.now() - launchedAt,
            helloSeen: companionHelloSeen(companionOwner),
            retried: false
          })
        ) {
          try {
            reportCompanionSideloadExit(companionOwner, firstTail)
            releaseCompanionSpawn(companionOwner, 'spawn-aborted')
            rec.flush.buf += '\x1b[2mHarnu: restarted without bundled plugins.\x1b[0m\r\n'
            flushNow(id)
            const retryEnv = { ...env }
            delete retryEnv.HARNU_SPAWN_TOKEN
            const second = spawn(runCommand, stripInjectedPluginDirs(runArgs, injectedDirs), {
              ...spawnOpts,
              env: retryEnv
            })
            launchedAt = Date.now()
            rec.pty = second
            wire(second, true)
            // Living past the window means the CLI ran without the flags: this machine blocks
            // sideloaded plugins. In memory for the app run; later spawns skip both flags.
            blockedTimer = setTimeout(() => {
              if (ptys.get(id) === rec && rec.pty === second) markSideloadBlocked(firstTail)
            }, RETRY_WINDOW_MS)
            return
          } catch {
            // could not respawn: forward the first process's exit as today
          }
        }

        releaseCompanionSpawn(companionOwner, 'pty-exit')
        // BUG-70 §3.2: the fact travels WITH the event rather than suppressing it —
        // other `pty:exit` consumers (pre-prompt gate, prompt submitter, helper-pane
        // watch) still need the cancel signal on a park. `reason` absent on the wire
        // means natural (a stale preload/renderer pair keeps today's behavior).
        const reason: PtyExitReason = isParking(id) ? 'park' : 'natural'
        clearParking(id)
        getWindow()?.webContents.send('pty:exit', {
          id,
          exitCode: evt.exitCode,
          signal: evt.signal,
          reason
        })
        const r = ptys.get(id)
        if (r?.flush.timer) clearTimeout(r.flush.timer)
        ptys.delete(id)
        // Prune the dead session's hook state (T13/BUG-1) before dropping the index
        // entry — resolve the key while the reverse lookup still holds it.
        const exitedKey = sessionIndex.getSessionKey(id)
        if (exitedKey) pruneTaskState(exitedKey)
        sessionIndex.removeByPtyId(id)
      })
    }
    wire(pty, false)

    return id
  })

  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    ptys.get(id)?.pty.write(data)
  })

  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    const rec = ptys.get(id)
    if (!rec) return
    const safeCols = Math.max(1, cols)
    const safeRows = Math.max(1, rows)
    rec.cols = safeCols
    rec.rows = safeRows
    try {
      rec.pty.resize(safeCols, safeRows)
    } catch {
      // ignore resize errors on dead PTYs
    }
  })

  /**
   * BUG-69: the ONE way to park a session, used by both the manual "Park now"
   * action and (indirectly, via `runPolicy`) the automatic sweep/cap. Delegates
   * to `hibernateSession`, which kills + flags + broadcasts as a single
   * transaction — no separate flag-only path can leave the flag set without the
   * renderer's terminal actually disposed. An unknown/dead sessionKey is a
   * no-op (`hibernateSession` returns early), not a throw.
   */
  ipcMain.handle('pty:park', (_e, sessionKey: string): void => {
    hibernateSession(sessionKey)
  })

  ipcMain.on('pty:destroy', (_e, id: string) => {
    const rec = ptys.get(id)
    if (!rec) return
    // Flush remaining buffer so callers don't lose data on rapid create/destroy.
    flushNow(id)
    if (rec.flush.timer) clearTimeout(rec.flush.timer)
    try {
      rec.pty.kill()
    } catch {
      // already dead
    }
    ptys.delete(id)
    const destroyedKey = sessionIndex.getSessionKey(id)
    if (destroyedKey) pruneTaskState(destroyedKey)
    sessionIndex.removeByPtyId(id)
  })

  // Renderer-driven backpressure (T-3.6 wires the watermark math).
  ipcMain.on('pty:flow:pause', (_e, id: string) => {
    const rec = ptys.get(id)
    if (!rec) return
    try {
      rec.pty.pause()
    } catch {
      // ignore
    }
  })

  ipcMain.on('pty:flow:resume', (_e, id: string) => {
    const rec = ptys.get(id)
    if (!rec) return
    try {
      rec.pty.resume()
    } catch {
      // ignore
    }
  })

  // Re-key the session index when a synthetic session migrates to its real
  // uuid (reconcileSessionAdded in the renderer). Without this, the dedup in
  // `pty:create` would miss the resume of the now-real session and clone it
  // (2026-06-01 spec §6).
  ipcMain.on('pty:rekey', (_e, fromKey: string, toKey: string) => {
    // Resolve the ptyId from the OLD key BEFORE `sessionIndex.rekey` moves the
    // binding — after that call `fromKey` no longer resolves to anything.
    const ptyId = sessionIndex.getPtyId(fromKey)
    sessionIndex.rekey(fromKey, toKey)
    // Carry the focus stamp across the synth→real migration, or the freshly-migrated
    // session would look like it had never been focused and become an instant victim.
    const focused = lastFocusedAt.get(fromKey)
    if (focused !== undefined) {
      lastFocusedAt.delete(fromKey)
      lastFocusedAt.set(toKey, focused)
    }
    if (selectedSessionKey === fromKey) selectedSessionKey = toKey
    // T215: carry the ownership marker across the migration too. The renderer
    // preserves it on the session entry, but this ledger is keyed by session
    // key — leaving it behind on the dead synthetic id would make an
    // agent-dispatched session look operator-owned the moment its JSONL lands.
    const origin = sessionSpawnOrigins.get(fromKey)
    if (origin !== undefined) {
      sessionSpawnOrigins.delete(fromKey)
      sessionSpawnOrigins.set(toKey, origin)
    }
    // BUG-65: the index moved, but every enumeration path (fleetSnapshot, pty:list,
    // livePtyDescriptors) reads `rec.sessionKey`/`rec.kind` off the PTY record itself,
    // not the index. Without this, those paths go on reporting the stale synthetic key
    // and the frozen spawn-time kind for the PTY's entire remaining life, so hibernation
    // can never see or reach it (fleetSnapshot names it by a key sessionIndex no longer
    // recognizes) — and the System Monitor keeps showing `synthetic-<uuid>` forever.
    const rec = ptyId ? ptys.get(ptyId) : undefined
    if (rec) applyRekeyToRecord(rec, toKey)
    // T389 P1W3: the binding of this PTY now reads the new key; a claim for it is satisfied.
    if (ptyId) companionHost.notifySessionKeyChange({ kind: 'pty', ptyId })
  })

  /**
   * The operator selected this session (T119). Feeds the LRU's focus axis and identifies
   * the one session the policy may never park.
   */
  ipcMain.on('pty:touchFocus', (_e, sessionKey: string) => {
    lastFocusedAt.set(sessionKey, Date.now())
    selectedSessionKey = sessionKey
  })

  // Enumerate live PTYs that carry a logical session key, so a freshly-mounted
  // renderer can re-adopt them instead of spawning duplicates (I4/I5). Shell
  // PTYs (no sessionKey) are omitted — only Claude sessions are re-adopted.
  ipcMain.handle('pty:list', async () => {
    const out: Array<{
      sessionKey: string
      ptyId: string
      kind: PtyKind
      cols: number
      rows: number
    }> = []
    for (const [id, rec] of ptys) {
      if (!rec.sessionKey) continue
      out.push({
        sessionKey: rec.sessionKey,
        ptyId: id,
        kind: rec.kind,
        cols: rec.cols,
        rows: rec.rows
      })
    }
    return out
  })

  // Resolve a logical session key to its live ptyId (or null when no PTY is
  // bound). Lets the MCP server / fleet view address a session's process
  // without enumerating `pty:list`. Source of truth is the PtySessionIndex.
  ipcMain.handle('pty:idForSession', async (_e, sessionKey: string): Promise<string | null> => {
    return sessionIndex.getPtyId(sessionKey) ?? null
  })

  // Drain any pending coalesce buffer, then return the ring-buffer snapshot and
  // the cumulative byte offset (`seq`) it ends at. The renderer writes `data`
  // to repaint scrollback and uses `seq` to drop any live chunks it queued
  // during adoption that are already inside the snapshot (exact dedup — see
  // dedupeAfterSeq / spec §4.1). Returns empty for an unknown/dead ptyId.
  ipcMain.handle('pty:replay', async (_e, ptyId: string) => {
    const rec = ptys.get(ptyId)
    if (!rec) return { data: '', seq: 0 }
    flushNow(ptyId)
    return { data: rec.ring.snapshot(), seq: rec.seq }
  })

  // Same snapshot, but keyed by sessionKey instead of ptyId — the Fleet status
  // board (fleet-status-board spec §4.2) shows a session's last PTY line without
  // knowing its ptyId. Resolve via the PtySessionIndex; fail-safe to empty for a
  // session with no live PTY (board falls back to a one-line card).
  ipcMain.handle('pty:replayForSession', async (_e, sessionKey: string) => {
    const ptyId = sessionIndex.getPtyId(sessionKey)
    if (!ptyId) return { data: '', seq: 0 }
    const rec = ptys.get(ptyId)
    if (!rec) return { data: '', seq: 0 }
    flushNow(ptyId)
    return { data: rec.ring.snapshot(), seq: rec.seq }
  })

  // T119 sweep. The cap only fires when the fleet GROWS — open five sessions, walk away for
  // three hours, and nothing spawns, so nothing is evaluated and ~2 GB sits idle. That is the
  // actual zombie. This catches the decay case.
  //
  // It MUST live in main: a renderer timer is throttled when the window is backgrounded,
  // which is exactly when sessions go cold and the sweep matters most.
  stopHibernationSweep()
  sweepTimer = setInterval(() => {
    runPolicy('sweep')
  }, SWEEP_INTERVAL_MS)
}

export function killAllPtys(): void {
  for (const [id, rec] of ptys) {
    if (rec.flush.timer) clearTimeout(rec.flush.timer)
    try {
      rec.pty.kill()
    } catch {
      // ignore
    }
    const key = sessionIndex.getSessionKey(id)
    if (key) pruneTaskState(key)
  }
  ptys.clear()
}

/**
 * The set of logical session keys with a live PTY — the liveness signal for the
 * MCP task-state filter (T13/BUG-1 backstop). A hook FSM state whose session key
 * is absent here is stale (the process is gone) and must not be disclosed.
 */
export function liveSessionKeys(): ReadonlySet<string> {
  return sessionIndex.liveKeys()
}

/**
 * Foreground process name of a live session's pty (A2 `match.process` — W6.1).
 * Resolves the session key → its ptyId → the node-pty pid → the terminal's
 * foreground `comm`. `null` for an unknown session, a dead pty, or non-Linux.
 * Injected into the screen detector so it can classify weak-identity agents.
 */
export function foregroundProcessForSession(sessionKey: string): string | null {
  const ptyId = sessionIndex.getPtyId(sessionKey)
  if (ptyId === undefined) return null
  const rec = ptys.get(ptyId)
  if (rec === undefined) return null
  return foregroundProcessName(rec.pty.pid)
}

// ---- T215: the peer-messaging seam (spec §2.2, §3.2a, §3.4) ----------------
//
// Every export below reuses the EXACT `sessionKey → ptyId → rec.pty.pid` walk
// `foregroundProcessForSession` already performs. There is no new registry, no
// `/proc` tree walk, and no child hop: `node-pty` `exec`s the resolved binary,
// so `rec.pty.pid` IS the pid the CLI names its socket after (spec §2.1 —
// verified live: Harnu's `claude` processes are direct children of Harnu and each
// socket is `<that pid>.sock`).

/**
 * The live pid behind a session key, or `null` when Harnu holds no process for
 * it. This is the ONLY addressing source `message_session` uses — which is also
 * why the recipient scope is structurally enforced by the addressing itself
 * (spec §3.2a): a `claude` Harnu did not spawn can never appear in this index.
 */
export function pidForSession(sessionKey: string): number | null {
  const ptyId = sessionIndex.getPtyId(sessionKey)
  if (ptyId === undefined) return null
  return ptys.get(ptyId)?.pty.pid ?? null
}

/**
 * The T215 recipient predicate, evaluated against live main-process state:
 * `sessionIndex.has(key) || isHibernated(key)`. See `harnuOwnsSession`'s doc in
 * `messaging-socket.ts` for why both arms are causal proof rather than
 * heuristics, and why neither the board nor the in-flight registry is consulted.
 */
export function sessionOwnedByHarnu(sessionKey: string): boolean {
  return harnuOwnsSession(sessionIndex.has(sessionKey), isHibernated(sessionKey))
}

/**
 * The spawn origin stamped on this session's live PTY record (T215 DoD).
 * `undefined` when Harnu holds no live process for the key — a parked session
 * has no record, so the caller must decide what an absent origin means (the
 * send path treats it the same as `'operator'`: fail closed).
 */
export function spawnOriginForSession(sessionKey: string): SpawnOrigin | undefined {
  const ptyId = sessionIndex.getPtyId(sessionKey)
  const live = ptyId === undefined ? undefined : ptys.get(ptyId)?.spawnedBy
  return live ?? sessionSpawnOrigins.get(sessionKey)
}

/** Main-process waiters parked on a `pty:sessionReady` for a given session key. */
const sessionReadyWaiters = new Map<string, Set<() => void>>()

/** Settle every waiter for `sessionKey` (called from the `pty:create` ready send). */
function resolveSessionReadyWaiters(sessionKey: string): void {
  const waiters = sessionReadyWaiters.get(sessionKey)
  if (!waiters) return
  sessionReadyWaiters.delete(sessionKey)
  for (const fn of waiters) fn()
}

/**
 * Resolve once this session key has a live PTY — i.e. once `pty:create` has
 * registered it and announced `pty:sessionReady` (T215 §3.4's ack).
 *
 * Resolves `true` immediately when the key is ALREADY live (the wake raced us
 * and won), `false` on timeout. A timeout must be reported as `WAKE_TIMEOUT`
 * with the message NOT sent — never a silent drop and never a retry loop that
 * could put a second process on one transcript.
 */
export function waitForSessionReady(sessionKey: string, timeoutMs: number): Promise<boolean> {
  if (sessionIndex.has(sessionKey)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sessionReadyWaiters.get(sessionKey)?.delete(onReady)
      resolve(value)
    }
    const onReady = (): void => done(true)
    const timer = setTimeout(() => done(false), timeoutMs)
    const existing = sessionReadyWaiters.get(sessionKey)
    if (existing) existing.add(onReady)
    else sessionReadyWaiters.set(sessionKey, new Set([onReady]))
  })
}

/** One live PTY, projected for the System Monitor (T127). Read-only. */
export interface LivePtyDescriptor {
  ptyId: string
  sessionKey: string
  /** The shell/`claude` pid itself — the root the monitor walks `/proc` from. */
  pid: number
  kind: FleetKind
  /** Epoch ms this PTY was spawned. */
  startedAt: number
  /** Epoch ms of the last byte flushed to the renderer — the session's pulse. */
  lastActivityAt: number
  /** Epoch ms the operator last selected this session. Falls back to `startedAt`. */
  lastFocusedAt: number
  /** Whether this is the ONE session currently open in the renderer. */
  isSelected: boolean
  /** The hook FSM's live claim, or `null` when no hook has reported yet. */
  taskState: FleetTaskState
}

/**
 * Read-only snapshot of every live Claude session's PTY (T127). Feeds the
 * System Monitor's Sessions group, joined by the caller with `hibernatedKeys()` for
 * the parked rows — per the feature's hard rule (spec §2), this reads only the
 * in-memory `ptys` map + the same in-memory state `fleetSnapshot()` already reads
 * (`lastFocusedAt`, `selectedSessionKey`, the hook-bridge task states), never disk.
 *
 * Mirrors `pty:list`'s sessionKey filter: a plain shell (split terminal) carries no
 * `sessionKey` and is omitted — the monitor is Chrome-task-manager style over the
 * FLEET, not every split terminal.
 */
export function livePtyDescriptors(): LivePtyDescriptor[] {
  const states = getTaskStates()
  const out: LivePtyDescriptor[] = []
  for (const [id, rec] of ptys) {
    if (!rec.sessionKey) continue
    out.push({
      ptyId: id,
      sessionKey: rec.sessionKey,
      pid: rec.pty.pid,
      kind: rec.kind,
      startedAt: rec.startedAt,
      lastActivityAt: rec.lastActivityAt,
      lastFocusedAt: lastFocusedAt.get(rec.sessionKey) ?? rec.startedAt,
      isSelected: rec.sessionKey === selectedSessionKey,
      taskState: states.get(rec.sessionKey) ?? null
    })
  }
  return out
}
