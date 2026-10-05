import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promises as fs, createReadStream, existsSync, type Dirent, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { firstRealPrompt, rootRepoPath, stripMetaWrappers } from './claude-reader-derive'
import { buildFolderEntries, type FolderEntry } from './folder-model'
import { probeGitMetaBatch } from './git-probe'
import {
  deriveTranscriptTruth,
  isNoiseEntry,
  pickWhatsHappening,
  type TranscriptEntry,
  type TranscriptState,
  type StagnationVerdict
} from './transcript-truth'

/**
 * Session lifecycle status. Mirrors `SessionStatus` in
 * `src/renderer/src/stores/sessions.ts` — kept duplicated here (not imported)
 * because the main process must not depend on renderer modules.
 */
export type SessionStatus = 'active' | 'idle' | 'archived'

// Re-export so the preload/renderer can consume the transcript turn-over state
// (T91) / stagnation verdict (T175/T176) as the single canonical types, without
// importing from `src/main` directly.
export type { TranscriptState, StagnationVerdict } from './transcript-truth'

/**
 * Lifecycle of a nested parallel agent (issue #9). Unlike a session — which can
 * be `active`/`idle`/`archived` — an agent is a one-shot job: it's either still
 * writing (`running`) or finished (`done`). There is NO clean end marker in the
 * subagent JSONL (the last line is an `assistant`/`text` event with
 * `stop_reason: null`), so `done` is derived from file-mtime recency, not a
 * terminal signal. See `scrapeSubagentHeader` / design.md §6 "Status do agente".
 */
export type AgentStatus = 'running' | 'done'

/**
 * A subdirectory below the active window is considered finished. Used by the
 * seed scan to label pre-existing subagents `done` vs `running`. The renderer
 * re-arms an equivalent timer on every live `claude:subagent:updated` append.
 */
export const SUBAGENT_ACTIVE_WINDOW_MS = 15_000

/**
 * One nested parallel agent (Task-tool subagent) belonging to a parent session.
 *
 * The parent link is HARD: the agent transcript lives at
 * `~/.claude/projects/<slug>/<parentSessionId>/subagents/agent-<agentId>.jsonl`,
 * so the subdirectory name IS the parent session's uuid — no heuristic. SDK
 * reviews (`entrypoint: "sdk-py"`) have no such link and are out of scope for
 * v1 (see issue #9 / design.md §6).
 */
export interface SubagentEntry {
  /** Stable id; matches both the `agentId` JSONL field and the `agent-<id>.jsonl` filename. */
  agentId: string
  /** Parent session's uuid (the subagents/ parent directory name). */
  parentSessionId: string
  /** Absolute path to the subagent JSONL on disk. */
  fullPath: string
  /** JS milliseconds, from `fs.stat`. Drives the running/done heuristic. */
  fileMtime: number
  /**
   * Agent type from `attributionAgent` (e.g. `general-purpose`, `explore`).
   * Empty string when the field is absent/null — the renderer falls back to a
   * generic "subagent" label.
   */
  agentType: string
  /** Origin skill from `attributionSkill` (e.g. `superpowers:…`). Empty if absent. */
  skill: string
  /** Origin plugin from `attributionPlugin`. Empty if absent. */
  plugin: string
  /** Model id from the first assistant line (e.g. `claude-haiku-4-5-…`). Empty if unknown. */
  model: string
  /** The agent's task — its first user message, de-wrappered and truncated. */
  task: string
  /** `running` if appended within `SUBAGENT_ACTIVE_WINDOW_MS`, else `done`. */
  status: AgentStatus
  /** ISO timestamp (file birthtime). */
  created: string
  /** ISO timestamp (file mtime). */
  modified: string
}

/**
 * One row of `~/.claude/projects/<slug>/sessions-index.json#entries[]`,
 * mapped 1:1 (camelCase) into the shape the renderer's `Session` expects.
 *
 * Field semantics come from finding 01 §4. `status` is NOT on disk — we
 * default it to `'idle'` here; T-1.3's watcher flips it to `'active'`
 * when the JSONL is actively appended.
 */
export interface SessionEntry {
  sessionId: string
  fullPath: string
  fileMtime: number
  firstPrompt: string
  summary: string
  messageCount: number
  created: string
  modified: string
  gitBranch: string
  projectPath: string
  isSidechain: boolean
  status: SessionStatus
  /**
   * Nested parallel agents (Task-tool subagents) spawned by this session, hard-
   * linked via the `<sessionId>/subagents/` directory (issue #9). Always present
   * (possibly empty). Attached by `attachSubagents` after the project is built.
   */
  agents: SubagentEntry[]
  /**
   * `true` when the local JSONL holds at least one real conversation turn so
   * `claude --resume <id>` can actually replay it. `false` for metadata-only
   * stubs (Claude Code 2.1.x cloud-bridge writes a header with `custom-title`,
   * `ai-title`, `bridge-session` but **zero** `user`/`assistant` lines when the
   * conversation lives in the cloud). Resuming such a session locally fails
   * with "No conversation found …", so the UI marks it instead of spawning a
   * doomed PTY. Index-path sessions infer this from `messageCount > 0`.
   */
  resumable: boolean
  /**
   * `true` when a `bridge-session` line was seen — the session is mirrored to
   * a claude.ai cloud session (`cse_…`). Drives the "cloud" affordance in the
   * sidebar; orthogonal to `resumable` (a bridged session may still have local
   * turns). Always `false` on the index fast path (we don't scrape JSONLs there).
   */
  bridged: boolean
  /**
   * Deterministic turn-over state read from the transcript tail (T91 §1): the
   * CLI's own `end_turn`/`stop_hook_summary`/`turn_duration` markers say `idle`;
   * a trailing `tool_use` says `working`; an unresolved `AskUserQuestion`/
   * `ExitPlanMode` says `needs-input`. `'unknown'` when the tail has no marker
   * (the fleet classifier then falls back to its quiet-timer). Consumed by
   * `fleet-state.ts` so the dot / board / triage queue inherit it. Always
   * `'unknown'` on the index fast path (no JSONL scrape there).
   */
  transcriptState: TranscriptState
  /**
   * The CLI's own "what happened while you were away" recap — the latest
   * `system`/`away_summary` content (NL "Goal:… Next:…"), verbatim (T91 §4).
   * Empty when the transcript has none. Surfaced in previews / the triage queue.
   */
  awaySummary: string
  /**
   * Stagnation verdict (T175/T176): a pure fold over the transcript tail that
   * flags a session repeating the same tool targets with no mutation between
   * them — the "noisy stall" filesystem-silence-only `stuck` can't see. Feeds
   * `fleet-state.ts`'s `workingOrStuck` OR-branch and the tally shown in
   * `SessionPreview.vue`.
   */
  stagnation: StagnationVerdict
  /**
   * "What's happening now" (T91 §3): `task-summary` → `last-prompt` → first user
   * message. A live subtitle, distinct from the persistent `summary` title.
   */
  whatsHappening: string
  /**
   * Context-window used % (0–100) computed from the last assistant `usage` in the
   * JSONL over the model's context window, reset across `/compact` (T91 §5). Null
   * when the transcript has no usage yet — consumers fall back to statusline data.
   */
  ctxPct: number | null
  /**
   * `session-<8 hex>` when this session is an agent-teams TEAMMATE (T99) — see
   * {@link ScrapedHeader.teamName}. Empty for a lead or a normal session.
   */
  teamName: string
  /**
   * The teammate's short name (e.g. `spec-ui`) when `teamName` is set. Empty otherwise.
   * Set only from a line that also carries `teamName`; the CLI's `agent-name`
   * rename line is ignored (BUG-78).
   */
  agentName: string
}

/**
 * A synthetic single-worktree wrapper around a project's sessions. Real git
 * worktree splitting happens in a later task once we wire `worktree.ts` into
 * the startup pipeline; for now every project has exactly one `'main'`
 * worktree pointing at `originalPath`.
 */
export interface WorktreeEntry {
  slug: string
  path: string
  branch: string
  isMain: boolean
  isBare: boolean
  isPrunable: boolean
  isLocked: boolean
  expanded: boolean
  sessions: SessionEntry[]
}

/**
 * One `~/.claude/projects/<slug>/` directory, with its sessions grouped under
 * a synthetic main worktree. `path` is sourced from the index's `originalPath`
 * (never from the slug — see finding 01 §2 on the lossy slug derivation).
 */
export interface ProjectEntry {
  slug: string
  alias: string
  path: string
  expanded: boolean
  worktrees: WorktreeEntry[]
}

export interface ReadOptions {
  /** Override `~/.claude/projects/` for testing. */
  rootDir?: string
  /** If set, only read these slugs (used by watcher incremental updates). */
  slugsFilter?: string[]
}

/** The schema we expect inside `sessions-index.json`. */
interface SessionsIndexFile {
  version?: number
  originalPath?: string
  entries?: SessionIndexEntry[]
}

/** One entry exactly as written by Claude Code on disk. */
interface SessionIndexEntry {
  sessionId?: string
  fullPath?: string
  fileMtime?: number
  firstPrompt?: string
  summary?: string
  messageCount?: number
  created?: string
  modified?: string
  gitBranch?: string
  projectPath?: string
  isSidechain?: boolean
}

/** Try-parse JSON, returning `null` on any failure. Never throws. */
function tryParseJSON<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Map one on-disk entry into the renderer-facing `SessionEntry`. */
function toSessionEntry(e: SessionIndexEntry): SessionEntry {
  return {
    sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
    fullPath: typeof e.fullPath === 'string' ? e.fullPath : '',
    fileMtime: typeof e.fileMtime === 'number' ? e.fileMtime : 0,
    firstPrompt: typeof e.firstPrompt === 'string' ? e.firstPrompt : '',
    summary: typeof e.summary === 'string' ? e.summary : '',
    messageCount: typeof e.messageCount === 'number' ? e.messageCount : 0,
    created: typeof e.created === 'string' ? e.created : '',
    modified: typeof e.modified === 'string' ? e.modified : '',
    gitBranch: typeof e.gitBranch === 'string' ? e.gitBranch : '',
    projectPath: typeof e.projectPath === 'string' ? e.projectPath : '',
    isSidechain: e.isSidechain === true,
    // T-1.3 will flip this to 'active' from the tail-watch; here every session
    // is treated as idle.
    status: 'idle',
    // Filled by `attachSubagents` once the project tree is built.
    agents: [],
    // Index entries predate the cloud-bridge era; infer resumability from the
    // recorded message count and assume not-bridged (we don't scrape the JSONL
    // on the fast path).
    resumable: (typeof e.messageCount === 'number' ? e.messageCount : 0) > 0,
    bridged: false,
    // Transcript-truth fields (T91) require a JSONL scrape — unavailable on the
    // index fast path. Defaults keep the classifier on its quiet-timer fallback
    // and consumers on statusline data. Legacy Claude ≤ 2.0 only.
    transcriptState: 'unknown',
    awaySummary: '',
    stagnation: { stagnant: false, calls: 0, distinct: 0, topTarget: '', topCount: 0 },
    whatsHappening: typeof e.firstPrompt === 'string' ? e.firstPrompt : '',
    ctxPct: null,
    // Index entries predate agent-teams grouping (T99) and never scrape the
    // JSONL — legacy Claude ≤ 2.0 only, so a teammate never reaches this path.
    teamName: '',
    agentName: ''
  }
}

/**
 * Read and parse a single project slug's `sessions-index.json`. Returns
 * `null` if the file is missing, unparseable, or missing required top-level
 * fields. Never throws.
 */
async function readProjectIndex(rootDir: string, slug: string): Promise<ProjectEntry | null> {
  const indexPath = join(rootDir, slug, 'sessions-index.json')
  let raw: string
  try {
    raw = await fs.readFile(indexPath, 'utf8')
  } catch {
    // Missing index — new/never-saved project, or pure-subagent leftover.
    return null
  }

  const idx = tryParseJSON<SessionsIndexFile>(raw)
  if (!idx) {
    console.warn(`[claude-reader] corrupt sessions-index.json for slug ${slug}`)
    return null
  }

  if (typeof idx.originalPath !== 'string' || !Array.isArray(idx.entries)) {
    console.warn(`[claude-reader] sessions-index.json for ${slug} missing required fields`)
    return null
  }

  // Per finding 01 §4: probe version 1 explicitly, fall back gracefully.
  if (idx.version !== 1) {
    console.warn(
      `[claude-reader] unknown sessions-index version ${String(idx.version)} for ${slug}; attempting best-effort parse`
    )
  }

  // Silently skip empty projects — finding 01 §1 (e.g. ~/scripts only has
  // subagent leftovers); nothing for the sidebar to show.
  if (idx.entries.length === 0) {
    return null
  }

  // NB: SDK-session filtering (#6, `entrypoint !== 'cli'`) lives only in the
  // JSONL fallback below — `sessions-index.json` entries carry no `entrypoint`
  // field, so the fast path can't discriminate without re-opening each JSONL
  // (which would defeat the point of the index). On Claude Code 2.1, where the
  // index is written lazily/not at all for the new slugs that host `sdk-py`
  // reviewer sessions, those sessions surface through the JSONL path and are
  // filtered there. If a future Claude version indexes SDK sessions, this is
  // where a per-entry entrypoint check would go.
  const sessions = idx.entries.map(toSessionEntry)
  const branch = sessions[0]?.gitBranch ?? ''
  const projectPath = idx.originalPath

  const worktree: WorktreeEntry = {
    slug: 'main',
    path: projectPath,
    branch,
    isMain: true,
    isBare: false,
    isPrunable: false,
    isLocked: false,
    // Worktrees inside a project default to expanded so opening a project
    // immediately reveals its sessions. Only the project header itself
    // starts collapsed (Sidebar "collapsed by default" feature).
    expanded: true,
    sessions
  }

  return {
    slug,
    alias: basename(projectPath) || projectPath,
    path: projectPath,
    // Projects start collapsed by default — the user expands them on demand
    // via the chevron. This keeps the sidebar dense when many projects are
    // discovered from `~/.claude/projects/`.
    expanded: false,
    worktrees: [worktree]
  }
}

/**
 * Fields we scrape directly from the head of a `.jsonl` transcript when the
 * project has no `sessions-index.json` (Claude Code 2.1.152+ stopped writing
 * the index file in newly-created project slugs). Every Claude event line
 * carries `cwd` and `gitBranch`, so we don't need to fall back to the lossy
 * slug→path derivation from finding 01 §2 in the common case.
 */
interface ScrapedHeader {
  sessionId: string
  cwd: string
  gitBranch: string
  /** Latest `customTitle` line wins; empty if no `/rename` was ever applied. */
  customTitle: string
  /** Latest `aiTitle` (Claude's auto-generated title) wins; '' if none. */
  aiTitle: string
  /** First real (de-wrappered) user prompt; '' if none found (N1/N2). */
  firstPrompt: string
  /** Counts only top-level (non-sidechain) user messages. */
  userMessageCount: number
  /** Count of real conversation turns (non-sidechain `user`/`assistant`). */
  turnCount: number
  /** `true` if a `bridge-session` line was seen (cloud-mirrored session). */
  bridged: boolean
  /**
   * Session `entrypoint` as written by Claude Code: `'cli'` for an interactive
   * user session, `'sdk-py'` (etc.) for a programmatic SDK session spawned by
   * a slash command like `/security-review` or `/code-review`. Empty when the
   * field is absent (older transcripts). Used to filter out non-interactive
   * sessions so they don't masquerade as user-created ones (#6).
   */
  entrypoint: string
  /** Turn-over state from the transcript tail (T91 §1). `'unknown'` when absent. */
  transcriptState: TranscriptState
  /** Latest `away_summary` content (T91 §4). Empty when none. */
  awaySummary: string
  /** Stagnation verdict over the tail (T175/T176). Zero verdict when the tail is empty. */
  stagnation: StagnationVerdict
  /** Latest `task-summary` text (T91 §3). Empty when none. */
  taskSummary: string
  /** Latest `last-prompt` text (T91 §3). Empty when none. */
  lastPrompt: string
  /** Context-window used % from the last assistant usage (T91 §5). Null when absent. */
  ctxPct: number | null
  /**
   * `session-<8 hex>` — present on every line of an agent-teams TEAMMATE
   * transcript (top-level `teamName`, seen from the first `user` line). The hex
   * suffix is the first 8 chars of the team LEAD's own sessionId. Empty for a
   * lead session or a normal (non-team) session (T99).
   */
  teamName: string
  /**
   * The teammate's short name (e.g. `spec-ui`), alongside `teamName`. Empty otherwise.
   * Set only from a line that also carries `teamName`; the CLI's `agent-name`
   * rename line is ignored (BUG-78).
   */
  agentName: string
}

/**
 * Upper bound on bytes scanned per JSONL. We can't use a tiny head window: in
 * Claude Code 2.1.x cloud-bridge sessions the metadata header alone runs ~60 KB
 * before the first user turn, and a `/rename` `custom-title` can land hundreds
 * of KB into the file (observed at byte 306 960 in a 421 KB transcript). So we
 * stream the file and read up to this cap — large enough to catch the name and
 * first prompt in every shape seen on disk, bounded so a multi-MB transcript
 * doesn't stall the scan. A `/rename` past the cap is the extreme tail and is
 * still recoverable via the live `custom-title` watcher event (N3).
 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024

/**
 * CLI parity: never read more than 50 MB of any single transcript
 * (`MAX_TRANSCRIPT_READ_BYTES` in `sessionStorage.ts:229`, T91 §6). The head
 * scrape and tail window are both far under this; it is the ceiling for the full
 * digest read below.
 */
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

/**
 * Tail window (bytes) read from a transcript's EOF for the T91 truth
 * derivations (turn-state, ctx%, away_summary, re-appended titles). The last
 * turn's `end_turn`/`stop_hook_summary`/`turn_duration` markers, the last
 * assistant `usage`, the latest `away_summary`, and the CLI's re-appended
 * metadata block all land within the final stretch of the file — 512 KB is
 * comfortably above a single turn's worth of JSONL while staying cheap to read
 * for every session on a scan. For files at or under this size the whole file
 * is already in the head scrape's ring, so no extra read happens.
 */
const TAIL_WINDOW_BYTES = 512 * 1024

/**
 * How many parsed entries the head scrape keeps in a trailing ring so a file
 * that fits under {@link MAX_SCAN_BYTES} can be reused for the T91 tail
 * derivations without a second read. A turn is at most a few dozen entries, so
 * this holds many turns' worth — more than the derivations ever consult.
 */
const TAIL_RING_MAX = 800

/**
 * Global cap on concurrent JSONL scrapes across an ENTIRE scan. `scanFolders`
 * fans out over every slug, and each slug fans out over every top-level
 * `*.jsonl` — so a cold launch on a large `~/.claude/projects` (hundreds of
 * index-less transcripts) used to open hundreds of read streams at once,
 * pinning the main-process event loop, spiking RSS, and risking EMFILE. That
 * stalled `foldersLoad`, so the renderer never got its first model and the
 * window stayed blank ("app won't open", occasional whole-desktop freeze).
 * Funnelling every per-file scrape through this semaphore bounds the burst to
 * a handful of files in flight regardless of dataset size. Mirrors the
 * MAX_CONCURRENCY guard in `git-probe.ts`.
 */
const SCRAPE_CONCURRENCY = 8
let scrapeActive = 0
const scrapeQueue: Array<() => void> = []
function withScrapeSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    scrapeActive++
    try {
      return await fn()
    } finally {
      scrapeActive--
      const next = scrapeQueue.shift()
      if (next) next()
    }
  }
  if (scrapeActive < SCRAPE_CONCURRENCY) return run()
  return new Promise<T>((resolve, reject) => {
    scrapeQueue.push(() => void run().then(resolve, reject))
  })
}

/** Bytes per `read()` when folding a transcript. */
const SCRAPE_CHUNK_BYTES = 64 * 1024

const EMPTY_BUFFER = Buffer.alloc(0)

/** One tail-ring entry plus the byte offset its line starts at. */
interface RingEntry {
  off: number
  entry: TranscriptEntry
}

/**
 * Running state of one transcript's header scrape — a fold over its lines, so a
 * fresh scrape and an incremental (append-only) scrape run the very same code
 * and agree by construction (sidebar-liveness spec §4.C C2).
 *
 * - Head fields (`header` minus the tail-truth fields, `promptFound`) are folded
 *   only while `!hitCap`: every head-derived field freezes at
 *   {@link MAX_SCAN_BYTES}, exactly like the capped scrape always did.
 * - The tail ring feeds the T91 truth. Below the cap it keeps the last
 *   {@link TAIL_RING_MAX} non-noise entries (the whole file is the tail). Past
 *   the cap it keeps every non-noise entry whose line starts inside the last
 *   {@link TAIL_WINDOW_BYTES} — the same set a 512 KB EOF window read yields.
 * - Lines are split on raw `\n` bytes (never inside a UTF-8 sequence), so a line
 *   or a multibyte character cut across two reads waits in `pending` until its
 *   newline lands.
 */
interface HeaderFold {
  header: ScrapedHeader
  promptFound: boolean
  hitCap: boolean
  /** File offset consumed so far (including `pending`). */
  pos: number
  /** Bytes of the trailing line whose `\n` has not been read yet. */
  pending: Buffer
  /** Window read started mid-line: drop bytes up to the first `\n`. */
  skipToNewline: boolean
  ring: RingEntry[]
  /** Offset of the newest entry the count cap dropped from the ring; -1 if none. */
  lostOff: number
}

function emptyHeader(): ScrapedHeader {
  return {
    sessionId: '',
    cwd: '',
    gitBranch: '',
    customTitle: '',
    aiTitle: '',
    firstPrompt: '',
    userMessageCount: 0,
    turnCount: 0,
    bridged: false,
    entrypoint: '',
    transcriptState: 'unknown',
    awaySummary: '',
    stagnation: { stagnant: false, calls: 0, distinct: 0, topTarget: '', topCount: 0 },
    taskSummary: '',
    lastPrompt: '',
    ctxPct: null,
    teamName: '',
    agentName: ''
  }
}

function newFold(): HeaderFold {
  return {
    header: emptyHeader(),
    promptFound: false,
    hitCap: false,
    pos: 0,
    pending: EMPTY_BUFFER,
    skipToNewline: false,
    ring: [],
    lostOff: -1
  }
}

/**
 * Fold one parsed line into the head fields: identity (`sessionId`/`cwd`/
 * `gitBranch` — first wins), the name signals (`custom-title`/`ai-title` —
 * latest wins), the first real user prompt (N1/N2), the conversation turn count,
 * whether the session is cloud-bridged, and the `entrypoint` (#6 SDK filter).
 */
function foldHead(fold: HeaderFold, obj: Record<string, unknown>): void {
  const header = fold.header
  if (!header.sessionId && typeof obj.sessionId === 'string') header.sessionId = obj.sessionId
  if (!header.cwd && typeof obj.cwd === 'string') header.cwd = obj.cwd
  if (!header.gitBranch && typeof obj.gitBranch === 'string') header.gitBranch = obj.gitBranch
  if (!header.teamName && typeof obj.teamName === 'string') header.teamName = obj.teamName
  // BUG-78: only a teammate line (both fields top-level, T99) sets agentName.
  // The CLI's `agent-name` rename line carries agentName WITHOUT teamName and
  // would otherwise freeze the session's sidebar label at its first rename.
  if (!header.agentName && typeof obj.agentName === 'string' && typeof obj.teamName === 'string')
    header.agentName = obj.agentName
  if (!header.entrypoint && typeof obj.entrypoint === 'string') header.entrypoint = obj.entrypoint
  if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
    header.customTitle = obj.customTitle
  }
  if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
    header.aiTitle = obj.aiTitle
  }
  if (obj.type === 'bridge-session') header.bridged = true
  if ((obj.type === 'user' || obj.type === 'assistant') && obj.isSidechain !== true) {
    header.turnCount += 1
  }
  if (obj.type === 'user' && obj.isSidechain !== true) {
    header.userMessageCount += 1
    if (!fold.promptFound) {
      const text = userMessageText(obj.message)
      if (text) {
        const resolved = firstRealPrompt([text])
        if (resolved) {
          header.firstPrompt = resolved
          fold.promptFound = true
        }
      }
    }
  }
}

/**
 * Fold one complete line (without its `\n`) that starts at file offset `off`.
 * Truncated/corrupt lines are skipped via try-parse. The line that crosses the
 * cap is still folded into the head; every later line feeds only the ring.
 */
function foldLine(fold: HeaderFold, line: Buffer, off: number): void {
  const len = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length
  if (len === 0) return
  let obj: unknown = null
  try {
    obj = JSON.parse(line.toString('utf8', 0, len))
  } catch {
    // Trailing partial line, or rare corrupt line — skip.
  }
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>
    if (!fold.hitCap) foldHead(fold, rec)
    // Feed the trailing ring for the tail-truth pass — skip internal noise
    // (content-replacement / marble-origami-*) so it never crowds the window.
    if (!isNoiseEntry(rec)) {
      fold.ring.push({ off, entry: rec })
      if (!fold.hitCap && fold.ring.length > TAIL_RING_MAX) {
        const dropped = fold.ring.shift()
        if (dropped) fold.lostOff = dropped.off
      }
    }
  }
  if (!fold.hitCap && off + line.length + 1 >= MAX_SCAN_BYTES) fold.hitCap = true
}

/** Feed raw bytes read at `fold.pos`; complete lines are folded, the rest waits. */
function feedBytes(fold: HeaderFold, chunk: Buffer): void {
  const buf = fold.pending.length > 0 ? Buffer.concat([fold.pending, chunk]) : chunk
  const base = fold.pos - fold.pending.length
  let start = 0
  let nl = buf.indexOf(0x0a, start)
  while (nl !== -1) {
    if (fold.skipToNewline) fold.skipToNewline = false
    else foldLine(fold, buf.subarray(start, nl), base + start)
    start = nl + 1
    nl = buf.indexOf(0x0a, start)
  }
  // A skipped line's bytes are never needed; a real one is copied so the read
  // buffer it came from can be collected.
  fold.pending =
    fold.skipToNewline || start === buf.length ? EMPTY_BUFFER : Buffer.from(buf.subarray(start))
  fold.pos += chunk.length
}

/** Read `[fold.pos, end)` in chunks and feed it. Stops early at EOF. */
async function readInto(fh: FileHandle, fold: HeaderFold, end: number): Promise<void> {
  while (fold.pos < end) {
    const len = Math.min(SCRAPE_CHUNK_BYTES, end - fold.pos)
    const buf = Buffer.allocUnsafe(len)
    const { bytesRead } = await fh.read(buf, 0, len, fold.pos)
    jsonlBytesRead += bytesRead
    if (bytesRead === 0) return
    feedBytes(fold, buf.subarray(0, bytesRead))
  }
}

/**
 * Reset the ring to exactly the last {@link TAIL_WINDOW_BYTES} before `end` —
 * the read the capped scrape always did for its tail. Only valid once `hitCap`
 * (head fields are frozen, so skipping bytes loses nothing).
 */
async function rebuildTailWindow(fh: FileHandle, fold: HeaderFold, end: number): Promise<void> {
  const start = Math.max(0, end - TAIL_WINDOW_BYTES)
  fold.ring = []
  fold.lostOff = -1
  fold.pending = EMPTY_BUFFER
  fold.pos = start
  fold.skipToNewline = start > 0
  await readInto(fh, fold, end)
}

/**
 * Advance a fold to `end`. Past the cap only the tail window matters, so a gap
 * wider than the window is jumped with a window read instead of folded byte by
 * byte. If the count-capped ring lost an entry the window still needs (the cap
 * was crossed during this read), the window is re-read — the C2 fallback.
 */
async function advanceFold(fh: FileHandle, fold: HeaderFold, end: number): Promise<void> {
  while (fold.pos < end) {
    if (fold.hitCap && end - fold.pos > TAIL_WINDOW_BYTES) {
      await rebuildTailWindow(fh, fold, end)
      break
    }
    const before = fold.pos
    await readInto(fh, fold, Math.min(end, fold.pos + SCRAPE_CHUNK_BYTES))
    if (fold.pos === before) break // EOF before `end` (file shrank since the stat)
  }
  if (!fold.hitCap) return
  const windowStart = fold.pos - TAIL_WINDOW_BYTES
  if (fold.lostOff > windowStart) {
    await rebuildTailWindow(fh, fold, fold.pos)
    return
  }
  // Keep the ring bounded to the window (entries are in file order).
  let drop = 0
  while (drop < fold.ring.length && fold.ring[drop].off <= windowStart) drop++
  if (drop > 0) fold.ring.splice(0, drop)
}

/**
 * The fold as a fresh read of the same bytes would see it: a trailing line
 * without its `\n` is still parsed (as `readline` always did at EOF). Folded
 * into a copy, so the running fold picks the line up only once it completes.
 */
function withPendingLine(fold: HeaderFold): HeaderFold {
  if (fold.pending.length === 0 || fold.skipToNewline) return fold
  const view: HeaderFold = {
    ...fold,
    header: { ...fold.header },
    ring: fold.ring.slice(),
    pending: EMPTY_BUFFER
  }
  foldLine(view, fold.pending, fold.pos - fold.pending.length)
  return view
}

/** Tail entries for the truth pass, or null when the ring cannot cover the window. */
function tailEntriesOf(fold: HeaderFold): TranscriptEntry[] | null {
  if (!fold.hitCap) return fold.ring.map((r) => r.entry)
  const windowStart = fold.pos - TAIL_WINDOW_BYTES
  if (fold.lostOff > windowStart) return null
  const out: TranscriptEntry[] = []
  for (const r of fold.ring) if (r.off > windowStart) out.push(r.entry)
  return out
}

/**
 * Turn a fold into a header without mutating it (the next append folds onto the
 * un-finalized state): head fields from the fold, T91 truth from its tail.
 */
async function finalizeFold(fh: FileHandle, fold: HeaderFold): Promise<ScrapedHeader> {
  const view = withPendingLine(fold)
  let tail = tailEntriesOf(view)
  if (!tail) {
    // Only reachable when the trailing partial line itself crossed the cap.
    const window = newFold()
    window.hitCap = true
    await rebuildTailWindow(fh, window, fold.pos)
    tail = tailEntriesOf(withPendingLine(window)) ?? []
  }
  const header: ScrapedHeader = { ...view.header }
  applyTranscriptTruth(header, tail)
  return header
}

/**
 * Scrape one `.jsonl` from byte 0 up to `size`: head fields up to
 * {@link MAX_SCAN_BYTES}, T91 tail truth from the last
 * {@link TAIL_WINDOW_BYTES} (or the whole file below the cap). Returns the fold
 * too, so later appends can continue from it.
 *
 * Why the (capped) whole head rather than a fixed head: `custom-title` and the
 * first user turn are NOT reliably near the top in bridge sessions (see
 * `MAX_SCAN_BYTES`). Never throws — returns null on any I/O error.
 */
async function scrapeJsonlHeaderFresh(
  absPath: string,
  size: number
): Promise<{ header: ScrapedHeader; fold: HeaderFold } | null> {
  let fh: FileHandle | null = null
  try {
    fh = await fs.open(absPath, 'r')
    fileOpens += 1
    const fold = newFold()
    await advanceFold(fh, fold, size)
    return { header: await finalizeFold(fh, fold), fold }
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => undefined)
  }
}

/**
 * Continue a fold over the bytes appended since it last ran (`[fold.pos,
 * size)`). Mutates the fold. Never throws — returns null on I/O error, after
 * which the fold must be discarded.
 */
async function scrapeJsonlHeaderAppend(
  absPath: string,
  fold: HeaderFold,
  size: number
): Promise<ScrapedHeader | null> {
  let fh: FileHandle | null = null
  try {
    fh = await fs.open(absPath, 'r')
    fileOpens += 1
    await advanceFold(fh, fold, size)
    return await finalizeFold(fh, fold)
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => undefined)
  }
}

/** Fold the T91 transcript-truth derivations of `entries` into a scraped header. */
function applyTranscriptTruth(header: ScrapedHeader, entries: TranscriptEntry[]): void {
  const truth = deriveTranscriptTruth(entries)
  header.transcriptState = truth.transcriptState
  header.awaySummary = truth.awaySummary
  header.stagnation = truth.stagnation
  header.taskSummary = truth.titles.taskSummary
  header.lastPrompt = truth.titles.lastPrompt
  header.ctxPct = truth.ctx ? truth.ctx.pct : null
  // Prefer the freshest re-appended title seen in the tail; keep the head-seen
  // value as a fallback (a large file's EOF metadata may sit past the head cap).
  if (truth.titles.customTitle) header.customTitle = truth.titles.customTitle
  if (truth.titles.aiTitle) header.aiTitle = truth.titles.aiTitle
}

/** One conversation turn for the context digest (T38). */
export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Runaway guard for the digest read — most sessions are far under this. Larger
 *  than the header cap because the digest tail lives at the END of the file. Held
 *  at the CLI's own 50 MB ceiling ({@link MAX_TRANSCRIPT_READ_BYTES}, T91 §6). */
const MAX_DIGEST_SCAN_BYTES = MAX_TRANSCRIPT_READ_BYTES

/**
 * Read the last `n` real (non-sidechain) user/assistant text turns from a session
 * JSONL — the transcript tail the T38 "Copy context digest" action distills. A
 * near-clone of the {@link scrapeJsonlHeaderFresh} line scan that keeps a ring
 * buffer of the last `n` turns instead of the first prompt. Text is flattened
 * ({@link userMessageText}) and de-wrappered ({@link stripMetaWrappers});
 * empty/tool-only turns are dropped.
 * Never throws — a missing/corrupt file yields `[]`. Concurrency-guarded like the
 * header scraper.
 */
export async function readSessionTail(absPath: string, n: number): Promise<SessionTurn[]> {
  if (!Number.isFinite(n) || n <= 0) return []
  return withScrapeSlot(async () => {
    let stream: ReturnType<typeof createReadStream> | null = null
    const ring: SessionTurn[] = []
    const push = (turn: SessionTurn): void => {
      ring.push(turn)
      if (ring.length > n) ring.shift()
    }
    try {
      stream = createReadStream(absPath, { encoding: 'utf8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      let bytes = 0
      for await (const raw of rl) {
        if (!raw) continue
        bytes += Buffer.byteLength(raw, 'utf8') + 1
        let obj: Record<string, unknown> | null
        try {
          obj = JSON.parse(raw) as Record<string, unknown>
        } catch {
          if (bytes >= MAX_DIGEST_SCAN_BYTES) break
          continue
        }
        if (obj && typeof obj === 'object' && obj.isSidechain !== true) {
          if (obj.type === 'user' || obj.type === 'assistant') {
            const text = stripMetaWrappers(userMessageText(obj.message)).trim()
            if (text) push({ role: obj.type, text })
          }
        }
        if (bytes >= MAX_DIGEST_SCAN_BYTES) break
      }
      rl.close()
      return ring
    } catch {
      return []
    } finally {
      if (stream) stream.destroy()
    }
  })
}

/** Flatten a Claude `message.content` (string or text-block array) to plain text. */
function userMessageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const content = (msg as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
          ? String((b as Record<string, unknown>).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

/**
 * Module-level cache of scraped JSONL headers, keyed by ABSOLUTE path (the
 * scrape always uses absolute paths, so test temp-roots never collide). A header
 * is reused while the file's `(mtimeMs, size)` is unchanged. When a transcript
 * only grew (same inode — the common case: Claude appends lines) and its fold is
 * retained, only the appended bytes are read and folded (sidebar-liveness spec
 * §4.C C2); an inode change or a shrink (`/compact` rewrites the file) is a full
 * re-scrape. This collapses the dominant `JSON.parse` cost of a re-scan (perf
 * spec 2026-06-22 §5.2a). Survives across `folders:load` IPC calls, so HMR/init
 * re-scans are cheap too.
 *
 * Bounded by per-scan eviction: each full `scanFolders` stamps the entries it
 * touched with the current generation and prunes the rest, so deleted JSONLs
 * (and slugs that gained a `sessions-index.json`, leaving the scrape path) drop
 * out. A stale-generation evict only ever forces a future re-parse — never a
 * wrong result — so it is safe even if two scans were to interleave.
 */
interface CachedHeader {
  mtimeMs: number
  size: number
  gen: number
  header: ScrapedHeader
  ino: number
  /** Retained fold for incremental appends; null once evicted (see below). */
  fold: HeaderFold | null
}
const headerCache = new Map<string, CachedHeader>()
let scanGeneration = 0
/** Test-only counter of real (cache-miss) scrapes — asserted by the cache tests. */
let scrapeMisses = 0
/** Test-only counter of transcript bytes read by header scrapes (AC-16/AC-18). */
let jsonlBytesRead = 0
/** Test-only counter of files opened by header scrapes, both kinds (AC-18). */
let fileOpens = 0

/**
 * A fold holds parsed tail entries (up to {@link TAIL_RING_MAX}, or a 512 KB
 * window), far heavier than a header. A machine can carry ~10 000 transcripts,
 * but only the few sessions actively writing ever append, so folds are kept only
 * for the most recently modified transcripts. A transcript whose fold was
 * evicted re-scrapes in full on its next append — the pre-C2 cost, once — and
 * is then retained again, being the newest.
 */
const FOLD_RETAIN_MAX = 16
const retainedFolds = new Map<string, CachedHeader>()

function retainFold(absPath: string, entry: CachedHeader): void {
  retainedFolds.set(absPath, entry)
  if (retainedFolds.size <= FOLD_RETAIN_MAX) return
  let victimPath = ''
  let victimMtime = Infinity
  for (const [path, e] of retainedFolds) {
    if (e.mtimeMs < victimMtime) {
      victimMtime = e.mtimeMs
      victimPath = path
    }
  }
  const victim = retainedFolds.get(victimPath)
  if (victim) victim.fold = null
  retainedFolds.delete(victimPath)
}

function dropFold(absPath: string, entry: CachedHeader): void {
  entry.fold = null
  retainedFolds.delete(absPath)
}

/**
 * In-flight scrape per path. Two overlapping scans must never fold the same
 * appended bytes into one retained fold twice, so scrapes of a path run one at
 * a time.
 */
const scrapesInFlight = new Map<string, Promise<ScrapedHeader | null>>()

/** Scrape a header, reusing the cached parse while `(mtimeMs, size)` are unchanged. */
async function scrapeJsonlHeaderCached(
  absPath: string,
  stat: Stats,
  gen: number
): Promise<ScrapedHeader | null> {
  for (let p = scrapesInFlight.get(absPath); p; p = scrapesInFlight.get(absPath)) {
    await p.catch(() => null)
  }
  const run = scrapeJsonlHeaderCachedSerial(absPath, stat, gen)
  scrapesInFlight.set(absPath, run)
  try {
    return await run
  } finally {
    if (scrapesInFlight.get(absPath) === run) scrapesInFlight.delete(absPath)
  }
}

async function scrapeJsonlHeaderCachedSerial(
  absPath: string,
  stat: Stats,
  gen: number
): Promise<ScrapedHeader | null> {
  const cached = headerCache.get(absPath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cached.gen = gen
    return cached.header
  }
  // A stat taken before an earlier scrape of this path (one this call waited
  // behind) advanced the cache: same file, strictly older observation. Reuse
  // the newer header rather than regress the cache to the stale size.
  if (
    cached &&
    cached.ino === stat.ino &&
    stat.mtimeMs < cached.mtimeMs &&
    stat.size <= cached.size
  ) {
    cached.gen = gen
    return cached.header
  }
  scrapeMisses += 1
  if (cached?.fold) {
    const fold = cached.fold
    if (cached.ino === stat.ino && stat.size > fold.pos) {
      const header = await scrapeJsonlHeaderAppend(absPath, fold, stat.size)
      if (header) {
        cached.mtimeMs = stat.mtimeMs
        cached.size = stat.size
        cached.gen = gen
        cached.header = header
        retainFold(absPath, cached)
        return header
      }
    }
    // Rewritten, shrunk, touched, or the append read failed: start over.
    dropFold(absPath, cached)
  }
  const fresh = await scrapeJsonlHeaderFresh(absPath, stat.size)
  if (!fresh) return null
  const entry: CachedHeader = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    gen,
    header: fresh.header,
    ino: stat.ino,
    fold: fresh.fold
  }
  headerCache.set(absPath, entry)
  retainFold(absPath, entry)
  return fresh.header
}

/** Drop cache entries not touched by the `gen` scan (deleted/indexed-away files). */
function pruneHeaderCache(gen: number): void {
  for (const [path, entry] of headerCache) {
    if (entry.gen !== gen) {
      headerCache.delete(path)
      retainedFolds.delete(path)
    }
  }
}

/** Test hooks for the header cache (perf spec §7). Not used in production. */
export function __resetHeaderCacheForTests(): void {
  headerCache.clear()
  retainedFolds.clear()
  scrapeMisses = 0
  jsonlBytesRead = 0
  fileOpens = 0
}
export function __scrapeMissesForTests(): number {
  return scrapeMisses
}
export function __headerCacheSizeForTests(): number {
  return headerCache.size
}
/** Test hook: scrape with a caller-supplied stat (a stale one, AC-16 serialization). */
export function __scrapeHeaderWithStatForTests(
  absPath: string,
  stat: Stats
): Promise<ScrapedHeader | null> {
  return scrapeJsonlHeaderCached(absPath, stat, scanGeneration)
}
export function __jsonlBytesReadForTests(): number {
  return jsonlBytesRead
}
export function __fileOpensForTests(): number {
  return fileOpens
}

/**
 * Fallback path when `sessions-index.json` doesn't exist for a slug. Lists every
 * top-level `*.jsonl` (skips the subagent `<uuid>/subagents/` subdirs by
 * filtering `Dirent.isFile()`), scrapes each header, and synthesizes a
 * `ProjectEntry` so the sidebar can still surface the sessions. Programmatic
 * SDK sessions (`entrypoint !== 'cli'`) are skipped so they don't show up as
 * user-created ones (#6).
 *
 * Performance budget: O(jsonls) parallel scrapes, but the `(path, mtime, size)`
 * header cache means a re-scan only re-parses files whose mtime moved since the
 * last scan — typically the one or two transcripts Claude just appended to.
 *
 * Returns `null` if the slug has no readable JSONLs (pure-subagent leftover
 * or already-deleted project).
 */
async function readProjectFromJsonls(
  rootDir: string,
  slug: string,
  gen: number
): Promise<ProjectEntry | null> {
  const projectDir = join(rootDir, slug)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(projectDir, { withFileTypes: true })
  } catch {
    return null
  }

  const jsonlNames = dirents
    .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
    .map((d) => d.name)
  if (jsonlNames.length === 0) return null

  let projectBranch = ''
  const sessions: SessionEntry[] = []

  await Promise.all(
    jsonlNames.map((name) =>
      withScrapeSlot(async () => {
        const absPath = join(projectDir, name)
        // Stat first (cheap) so the cache can short-circuit the expensive scrape
        // when the file is byte-identical to the last scan (perf spec §5.2a).
        const stat = await fs.stat(absPath).catch(() => null)
        if (!stat) return
        const header = await scrapeJsonlHeaderCached(absPath, stat, gen)
        if (!header) return
        // #6: skip programmatic (SDK) sessions — e.g. the `/security-review` or
        // `/code-review` reviewers write their own `*.jsonl` with
        // `entrypoint: "sdk-py"`. Only `entrypoint: "cli"` is a real interactive
        // user session. A missing entrypoint (older transcripts) is left in.
        if (header.entrypoint && header.entrypoint !== 'cli') return
        const sessionId = header.sessionId || name.slice(0, -'.jsonl'.length)
        const session: SessionEntry = {
          sessionId,
          fullPath: absPath,
          fileMtime: stat.mtimeMs,
          // First real user prompt (cleaned of meta wrappers) so the sidebar can
          // name sessions that never got a `/rename` (N1/N2). The renderer's
          // `labelFor` cascade is `summary || firstPrompt || "Untitled"`.
          firstPrompt: header.firstPrompt,
          // Name cascade (N1): explicit `/rename` wins, else Claude's generated
          // `ai-title`, else the renderer falls through to `firstPrompt`.
          summary: header.customTitle || header.aiTitle,
          messageCount: header.userMessageCount,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          gitBranch: header.gitBranch,
          projectPath: header.cwd,
          isSidechain: false,
          status: 'idle',
          agents: [],
          // No local conversation turns ⇒ `claude --resume` would fail with
          // "No conversation found …" (the transcript lives in the cloud bridge).
          resumable: header.turnCount > 0,
          bridged: header.bridged,
          // Transcript ground truth (T91): the turn-state feeds the fleet
          // classifier; away_summary/whatsHappening/ctxPct feed previews + HUD.
          transcriptState: header.transcriptState,
          awaySummary: header.awaySummary,
          stagnation: header.stagnation,
          whatsHappening: pickWhatsHappening(
            { taskSummary: header.taskSummary, lastPrompt: header.lastPrompt },
            header.firstPrompt
          ),
          ctxPct: header.ctxPct,
          // Agent-teams teammate grouping (T99): empty for a lead/normal session.
          teamName: header.teamName,
          agentName: header.agentName
        }
        sessions.push(session)
        if (!projectBranch && header.gitBranch) projectBranch = header.gitBranch
      })
    )
  )

  if (sessions.length === 0) return null

  // G1: the project's path/alias come from the ROOT repo, never a worktree cwd.
  // Pick a deterministic session (sorted by sessionId) and strip any Claude
  // worktree suffix. All sessions in a slug share one root, so any non-empty
  // cwd yields the same root after stripping. Per-session `projectPath` keeps
  // each session's own cwd (set above) so `claude --resume` runs in the right
  // place — only the project-level alias/path use the root.
  const stable = [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  const rootCwd = stable.map((s) => s.projectPath).find((p) => p.length > 0) ?? ''
  let projectPath = rootRepoPath(rootCwd)

  // Last-resort cwd when no JSONL carried one (very rare — would only happen
  // if every transcript in the slug was completely empty). Lossy slug→path
  // per finding 01 §2, so paths with internal `-` may be wrong; the renderer's
  // merge layer corrects this if the user added the project explicitly.
  if (!projectPath) {
    projectPath = slug.startsWith('-') ? '/' + slug.slice(1).replace(/-/g, '/') : slug
  }

  // Newest-first within the worktree — matches `sessions-index.json` ordering.
  sessions.sort((a, b) => b.fileMtime - a.fileMtime)

  const worktree: WorktreeEntry = {
    slug: 'main',
    path: projectPath,
    branch: projectBranch,
    isMain: true,
    isBare: false,
    isPrunable: false,
    isLocked: false,
    // Worktrees default to expanded; only the project header starts collapsed.
    expanded: true,
    sessions
  }

  return {
    slug,
    alias: basename(projectPath) || projectPath,
    path: projectPath,
    expanded: false,
    worktrees: [worktree]
  }
}

/** Flatten a JSONL `message.content` (string or block array) to plain text. */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
          ? String((b as Record<string, unknown>).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

/** Metadata scraped from the head of a subagent transcript. */
interface ScrapedSubagent {
  agentId: string
  agentType: string
  skill: string
  plugin: string
  model: string
  task: string
}

/**
 * Read the head of one `agent-*.jsonl` and pull the attribution metadata + the
 * task (first user message). The attribution fields (`agentId`,
 * `attributionAgent`, `attributionSkill`, `attributionPlugin`) sit on the first
 * line; the `model` is on the first `assistant` line; the task is the first
 * `user` message. All live near the top, so a 64 KB head read suffices. Never
 * throws — returns `null` on I/O or empty-file errors.
 */
async function scrapeSubagentHeader(absPath: string): Promise<ScrapedSubagent | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null
  const out: ScrapedSubagent = {
    agentId: '',
    agentType: '',
    skill: '',
    plugin: '',
    model: '',
    task: ''
  }
  try {
    fh = await fs.open(absPath, 'r')
    fileOpens += 1
    const { size } = await fh.stat()
    const headBytes = Math.min(SUBAGENT_HEAD_BYTES, size)
    const buf = Buffer.alloc(headBytes)
    const { bytesRead } = await fh.read(buf, 0, headBytes, 0)
    const text = buf.toString('utf8', 0, bytesRead)
    for (const raw of text.split('\n')) {
      if (!raw) continue
      let obj: Record<string, unknown> | null
      try {
        obj = JSON.parse(raw) as Record<string, unknown>
      } catch {
        continue
      }
      if (!obj || typeof obj !== 'object') continue
      if (!out.agentId && typeof obj.agentId === 'string') out.agentId = obj.agentId
      if (!out.agentType && typeof obj.attributionAgent === 'string') {
        out.agentType = obj.attributionAgent
      }
      if (!out.skill && typeof obj.attributionSkill === 'string') out.skill = obj.attributionSkill
      if (!out.plugin && typeof obj.attributionPlugin === 'string') {
        out.plugin = obj.attributionPlugin
      }
      if (!out.model && obj.type === 'assistant') {
        const msg = obj.message
        if (
          msg &&
          typeof msg === 'object' &&
          typeof (msg as Record<string, unknown>).model === 'string'
        ) {
          out.model = (msg as Record<string, unknown>).model as string
        }
      }
      if (!out.task && obj.type === 'user') {
        const msg = obj.message
        if (msg && typeof msg === 'object') {
          out.task = extractMessageText((msg as Record<string, unknown>).content)
        }
      }
    }
    // De-wrapper meta prefixes (e.g. <system-reminder>) the same way session
    // first-prompts are cleaned, then cap the length for the sidebar/tooltip.
    out.task = firstRealPrompt(out.task ? [out.task] : []).slice(0, 200)
    return out
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => undefined)
  }
}

/** Bytes {@link scrapeSubagentHeader} reads from a subagent transcript's head. */
const SUBAGENT_HEAD_BYTES = 64 * 1024

/**
 * Module-level cache of scraped subagent headers, keyed by ABSOLUTE path
 * (sidebar-liveness spec §4.C C1). The attribution fields sit on the first
 * lines and never change once written, so a header is reused while the file
 * keeps its inode and only grows — re-read only when the path is new, the inode
 * changed, the file shrank, or the header was incomplete and the file grew
 * (e.g. the first `assistant` line carrying `model` has not landed yet). A slug
 * pass used to re-read every subagent head (400 reads on a heavy slug) on every
 * append; now it stats them. Pruned by generation on full scans, like
 * `headerCache`.
 */
interface CachedSubagent {
  ino: number
  size: number
  header: ScrapedSubagent
  /** Every field resolved, or the read already covered the whole 64 KB head. */
  complete: boolean
  gen: number
}
const subagentCache = new Map<string, CachedSubagent>()
/** Test-only counter of real subagent header reads — asserted by AC-15. */
let subagentHeaderReads = 0

function subagentHeaderComplete(h: ScrapedSubagent, bytesCovered: number): boolean {
  const all = h.agentId !== '' && h.agentType !== '' && h.model !== '' && h.task !== ''
  return all || bytesCovered >= SUBAGENT_HEAD_BYTES
}

/** Scrape a subagent header, reusing the cached one per the C1 rule above. */
async function scrapeSubagentHeaderCached(
  absPath: string,
  stat: Stats,
  gen: number
): Promise<ScrapedSubagent | null> {
  const c = subagentCache.get(absPath)
  if (c && c.ino === stat.ino && stat.size >= c.size && (c.complete || stat.size === c.size)) {
    c.gen = gen
    return c.header
  }
  subagentHeaderReads += 1
  const header = await scrapeSubagentHeader(absPath)
  // A failed read is never cached: the next pass retries it, as before.
  if (header) {
    subagentCache.set(absPath, {
      ino: stat.ino,
      size: stat.size,
      header,
      complete: subagentHeaderComplete(header, stat.size),
      gen
    })
  } else {
    subagentCache.delete(absPath)
  }
  return header
}

/** Drop subagent cache entries not touched by the `gen` scan. */
function pruneSubagentCache(gen: number): void {
  for (const [path, entry] of subagentCache) {
    if (entry.gen !== gen) subagentCache.delete(path)
  }
}

/** Test hooks for the subagent header cache (AC-15). Not used in production. */
export function __resetSubagentHeaderCacheForTests(): void {
  subagentCache.clear()
  subagentHeaderReads = 0
  fileOpens = 0
}
export function __subagentHeaderReadsForTests(): number {
  return subagentHeaderReads
}

/** Filename → agentId: `agent-<id>.jsonl` → `<id>`. */
function agentIdFromFilename(name: string): string {
  return name.replace(/^agent-/, '').replace(/\.jsonl$/, '')
}

/**
 * Scan `<slug>/<parentUuid>/subagents/agent-*.jsonl` for every parent session
 * directory under a project and attach the discovered `SubagentEntry[]` to the
 * matching `SessionEntry.agents` (hard link — the subdir name is the parent
 * uuid, issue #9). Mutates `project` in place. Never throws.
 *
 * The seed status is recency-based: a subagent appended within
 * `SUBAGENT_ACTIVE_WINDOW_MS` is `running`, otherwise `done` (there is no clean
 * end marker — see `AgentStatus`). New/live activity arrives via the watcher's
 * `claude:subagent:updated` channel, so this only needs to surface pre-existing
 * agents in the initial scan.
 */
async function attachSubagents(
  rootDir: string,
  slug: string,
  project: ProjectEntry,
  gen: number
): Promise<void> {
  const projectDir = join(rootDir, slug)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(projectDir, { withFileTypes: true })
  } catch {
    return
  }
  const parentDirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  if (parentDirs.length === 0) return

  const now = Date.now()
  const byParent = new Map<string, SubagentEntry[]>()

  await Promise.all(
    parentDirs.map(async (dir) => {
      const parentSessionId = dir.name
      const subagentsDir = join(projectDir, parentSessionId, 'subagents')
      let files: Dirent[]
      try {
        files = await fs.readdir(subagentsDir, { withFileTypes: true })
      } catch {
        return // no subagents/ subdir for this session — common case.
      }
      const agentFiles = files.filter(
        (f) => f.isFile() && f.name.startsWith('agent-') && f.name.endsWith('.jsonl')
      )
      await Promise.all(
        agentFiles.map(async (f) => {
          const absPath = join(subagentsDir, f.name)
          // Stat first (cheap) so the C1 cache can skip the head read entirely.
          const stat = await fs.stat(absPath).catch(() => null)
          if (!stat) return
          const header = await scrapeSubagentHeaderCached(absPath, stat, gen)
          const agentId = header?.agentId || agentIdFromFilename(f.name)
          // Skip a malformed `agent-.jsonl` (empty id) — it would never match a
          // live `claude:subagent:updated` event and would orphan a row.
          if (!agentId) return
          const entry: SubagentEntry = {
            agentId,
            parentSessionId,
            fullPath: absPath,
            fileMtime: stat.mtimeMs,
            agentType: header?.agentType ?? '',
            skill: header?.skill ?? '',
            plugin: header?.plugin ?? '',
            model: header?.model ?? '',
            task: header?.task ?? '',
            status: now - stat.mtimeMs < SUBAGENT_ACTIVE_WINDOW_MS ? 'running' : 'done',
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString()
          }
          const list = byParent.get(parentSessionId)
          if (list) list.push(entry)
          else byParent.set(parentSessionId, [entry])
        })
      )
    })
  )

  if (byParent.size === 0) return

  for (const wt of project.worktrees) {
    for (const s of wt.sessions) {
      const agents = byParent.get(s.sessionId)
      if (!agents) continue
      // Oldest-first so the list reads top-to-bottom in spawn order.
      agents.sort((a, b) => a.fileMtime - b.fileMtime)
      s.agents = agents
    }
  }
}

/**
 * Public entrypoint every consumer calls. The FULL-scan case (no `rootDir`, no
 * `slugsFilter`) is a **model read**, not a disk scan: it delegates to the
 * central in-memory fleet model (`fleet-model.ts`, T123 spec §5.1 W1), which
 * owns the single boot scan, the watcher-driven incremental refreshes, and the
 * full-rescan fallback. This is where BUG-31's single-flight + TTL cache used
 * to live — it has dissolved into the model: post-boot, a full-scan call never
 * touches disk at all, it just reads the model's current (memoized, shared)
 * `FolderEntry[]` reference.
 *
 * `rootDir`/`slugsFilter` overrides stay a **direct, uncached** scan — this is
 * what every existing test fixture relies on (isolated tmp roots must never be
 * mixed into the shared model), and it is also what the model itself uses
 * internally for its boot/incremental scans.
 *
 * Two consequences of the full-scan case being a model read, not a scan:
 *
 *  - The returned `FolderEntry[]` is the model's SHARED, memoized array
 *    reference — the same array object goes to every caller until the model's
 *    next refresh. Treat it as immutable: no in-place `sort`/`push`/`splice`
 *    on the array or its `FolderEntry`/`SessionEntry` elements. A caller that
 *    needs to reorder or filter must copy first (`[...folders]`), or it will
 *    corrupt what every other consumer (and the model itself) sees.
 *  - `fleet-model.ts`'s underlying state is a module-level singleton keyed to
 *    the real `~/.claude/projects` (or whatever `rootDirOverride` a test set
 *    via `__setRootDirForTests`). A test that calls no-opts `scanFolders()`
 *    twice in a row gets the SAME memoized model both times, not two fresh
 *    reads of disk — writing a fixture file to disk between those two calls
 *    will NOT be reflected in the second call's result unless the model was
 *    refreshed in between (e.g. via `notifySlugChanged` + a flush, or a reset).
 */
export async function scanFolders(opts: ReadOptions = {}): Promise<FolderEntry[]> {
  const isFullScan = !opts.rootDir && (!opts.slugsFilter || opts.slugsFilter.length === 0)
  if (!isFullScan) return scanFoldersUncached(opts)
  try {
    const { getFleetFolders } = await import('./fleet-model')
    return await getFleetFolders()
  } catch (err) {
    // scanFolders has a never-throws contract (every consumer relies on it).
    // If the model import/boot ever fails, degrade to a direct uncached scan
    // — slower, but correct — instead of surfacing an error.
    console.error('[claude-reader] fleet model read failed; direct scan fallback', err)
    return scanFoldersUncached(opts)
  }
}

/**
 * Folder-first model (spec 2026-06-11). Scans the `~/.claude/projects/` tree
 * and, instead of a `Project → Worktree → Session` shape, returns one
 * `FolderEntry` per distinct session cwd, with git metadata probed per folder.
 * The slug→worktree structure dissolves: every session is regrouped by its own
 * `projectPath`, and same-repo worktrees are linked (and later visually
 * grouped) via the probed `repoId` rather than the `--claude-worktrees-` slug
 * convention.
 *
 * Per slug it reuses the same two-tier per-project read as before:
 *
 *   1. **Fast path** — read `sessions-index.json` (legacy Claude ≤ 2.0).
 *   2. **JSONL fallback** — when the index is missing or empty, scrape the
 *      head of every top-level `*.jsonl` in the slug folder. This covers
 *      Claude Code 2.1.152+, which no longer writes `sessions-index.json`
 *      on session spawn.
 *
 * Never throws.
 *
 * Exported (in addition to `scanFolders`) so `fleet-model.ts` can drive both the
 * boot full scan and the watcher-triggered `slugsFilter` incremental scans
 * directly, without a full-scan opts round-trip through `scanFolders` itself
 * (which would recurse back into the model it's building).
 */
export async function scanFoldersUncached(opts: ReadOptions): Promise<FolderEntry[]> {
  const rootDir = opts.rootDir ?? join(homedir(), '.claude', 'projects')

  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }

  let slugs = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
  const isFullScan = !opts.slugsFilter || opts.slugsFilter.length === 0
  if (!isFullScan) {
    const allow = new Set(opts.slugsFilter)
    slugs = slugs.filter((s) => allow.has(s))
  }

  // One generation per scan: the JSONL-scrape cache stamps every entry it
  // touches, so a full scan can prune untouched (deleted/indexed-away) entries.
  const gen = ++scanGeneration

  const results = await Promise.all(
    slugs.map(async (slug) => {
      const project =
        (await readProjectIndex(rootDir, slug)) ?? (await readProjectFromJsonls(rootDir, slug, gen))
      if (project) await attachSubagents(rootDir, slug, project, gen)
      return project
    })
  )
  const raw = results.filter((p): p is ProjectEntry => p !== null)

  // Prune cache entries not seen this scan — but ONLY on a full scan; a filtered
  // scan (slugsFilter) doesn't visit every file, so its generation is partial.
  if (isFullScan) {
    pruneHeaderCache(gen)
    pruneSubagentCache(gen)
  }

  // Flatten every session across all slugs/worktrees; the folder model regroups
  // them by their own cwd (`projectPath`), so the slug→worktree wrapping dissolves.
  const sessions = raw.flatMap((p) => p.worktrees.flatMap((w) => w.sessions))
  const gitByPath = await probeGitMetaBatch(sessions.map((s) => s.projectPath))
  // BUG-56 D5: stamp each folder's disk-existence alongside its git meta — a
  // folder whose directory is confirmed gone must never resurface as 'active'
  // in the renderer's `classifyFolder`, independent of the three explicit
  // `removeGhostFolder` call sites (belt-and-suspenders after an app restart).
  const diskExistsByPath = new Map<string, boolean>()
  for (const p of new Set(sessions.map((s) => s.projectPath))) {
    diskExistsByPath.set(p, existsSync(p))
  }
  const folders = buildFolderEntries(sessions, gitByPath, diskExistsByPath)

  folders.sort((a, b) => folderActivity(b) - folderActivity(a))
  return folders
}

/** Most-recent activity (ms) of a folder, for sidebar sort. */
function folderActivity(f: FolderEntry): number {
  let max = 0
  for (const s of f.sessions) {
    const t = s.modified ? Date.parse(s.modified) : 0
    const candidate = Number.isFinite(t) && t > 0 ? t : s.fileMtime
    if (candidate > max) max = candidate
  }
  return max
}
