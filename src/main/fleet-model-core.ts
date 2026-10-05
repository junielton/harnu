import { relative, sep } from 'node:path'
import type { SessionEntry } from './claude-reader'
import { buildFolderEntries, type FolderEntry, type GitMeta } from './folder-model'

/**
 * Pure reducer core for the central in-memory fleet model (T123 spec §5.1 W1).
 * No `fs`/`electron`/`chokidar`/`node-pty` imports — every function here takes
 * plain data in and returns NEW plain data out, so it is covered by fast unit
 * tests with zero disk I/O (ADR-0001 pure-core/thin-shell split). The impure
 * shell that actually calls `scanFoldersUncached` and owns the module-level
 * singleton lives in `fleet-model.ts`.
 *
 * The model's canonical shape is a FLAT session list + a per-folder-path git
 * metadata map — the same two ingredients `buildFolderEntries` (folder-model.ts)
 * already turns into the `FolderEntry[]` the rest of the app consumes. Keeping
 * the canonical state flat (rather than pre-grouped into folders) is what makes
 * the incremental slug-refresh reducer ({@link mergeSlugSessions}) simple: a
 * slug's sessions can be identified and dropped by path prefix without having
 * to know which folder(s) they used to be grouped under.
 */

/** Central fleet state: every known session + git metadata, versioned. */
export interface FleetState {
  /** Every known session across all folders, flattened. Order is not significant. */
  sessions: SessionEntry[]
  /** Git metadata (branch/repoId/isMainWorktree) keyed by folder path. */
  gitByPath: Map<string, GitMeta>
  /** Monotonic counter bumped whenever a reducer call changed something (a
   *  field-equal slug pass returns the same state, AC-28) — lets a shell cheaply
   *  detect "did the model change under me" without a deep-equal. */
  version: number
}

/** The model before the first scan has completed. */
export const EMPTY_FLEET_STATE: FleetState = Object.freeze({
  sessions: [],
  gitByPath: new Map(),
  version: 0
}) as FleetState

/**
 * Flatten a `scanFoldersUncached` result back into the model's canonical shape:
 * every session across every folder, plus a `path -> GitMeta` map built from
 * the (only-when-defined) git fields `buildFolderEntry` attaches. Pure — the
 * input `folders` is read-only, nothing is mutated.
 */
export function flattenFolders(folders: FolderEntry[]): {
  sessions: SessionEntry[]
  gitByPath: Map<string, GitMeta>
} {
  const sessions: SessionEntry[] = []
  const gitByPath = new Map<string, GitMeta>()
  for (const f of folders) {
    sessions.push(...f.sessions)
    const git: GitMeta = {}
    if (f.gitBranch !== undefined) git.gitBranch = f.gitBranch
    if (f.repoId !== undefined) git.repoId = f.repoId
    if (f.isMainWorktree !== undefined) git.isMainWorktree = f.isMainWorktree
    if (Object.keys(git).length > 0) gitByPath.set(f.path, git)
  }
  return { sessions, gitByPath }
}

/**
 * Replace the ENTIRE model with the result of a full scan. Used for the boot
 * scan and for the full-rescan fallback (watcher degraded — spec §5.1 "full-
 * rescan fallback if the watcher degrades").
 */
export function replaceAllSessions(
  state: FleetState,
  sessions: SessionEntry[],
  gitByPath: Map<string, GitMeta>
): FleetState {
  return { sessions, gitByPath, version: state.version + 1 }
}

/**
 * `~/.claude/projects/<slug>/...` -> `<slug>`. Returns `''` for a path outside
 * `rootDir` (defensive — should not happen for a real scanned session, but a
 * reducer must never throw on unexpected input).
 */
export function slugOfPath(rootDir: string, fullPath: string): string {
  const rel = relative(rootDir, fullPath)
  if (!rel || rel.startsWith('..')) return ''
  const [slug] = rel.split(sep)
  return slug ?? ''
}

/**
 * Incremental update for ONE OR MORE changed slugs (T123 §5.1: "use
 * `slugsFilter` scans per changed slug to update incrementally"). `freshSessions`
 * / `freshGitByPath` are the result of re-scanning ONLY `slugs` — i.e. a
 * complete, current listing of every session those slugs hold RIGHT NOW. So:
 *
 *   1. Every existing session whose `fullPath` falls under one of `slugs` is
 *      dropped from the model (this is what makes a JSONL removal or an
 *      entire-slug removal converge — the fresh re-list simply won't include
 *      it any more).
 *   2. `freshSessions` is appended — the changed slugs' current truth.
 *   3. `gitByPath` entries for folder paths seen in `freshGitByPath` are
 *      overwritten; paths untouched by this refresh keep their prior git meta.
 *
 * A session belonging to an UNCHANGED slug is never touched (reference-equal
 * to what was in `state.sessions` before), which is what lets the shell layer
 * skip re-probing/re-scanning slugs nothing happened to.
 *
 * Duplicate guard: a session whose `fullPath` is empty (legacy
 * `sessions-index.json` entries may omit it) or outside `rootDir` resolves to
 * slug `''`, which is never in the changed set — so the slug filter alone
 * would KEEP the old row while the fresh re-scan re-appends the same session,
 * duplicating it on every refresh (unbounded growth). Any existing session
 * whose `sessionId` reappears in `freshSessions` is therefore dropped too:
 * the fresh row is the current truth regardless of how its path resolves.
 *
 * That id-based dedupe MUST skip a falsy `sessionId` (`''`), both when
 * building the fresh-id set and when testing membership against it: a
 * `sessionId` of `''` is not an identity, it's an absence of one (same class
 * of legacy hole as the empty `fullPath` above). Two unrelated sessions can
 * both legitimately carry `sessionId === ''`, and letting `''` participate in
 * the `Set` would make an unrelated `''`-id session in an UNCHANGED slug look
 * like a duplicate of an incoming `''`-id fresh session and get dropped —
 * for that row, the slug filter alone must govern whether it survives.
 */
export function mergeSlugSessions(
  state: FleetState,
  rootDir: string,
  slugs: string[],
  freshSessions: SessionEntry[],
  freshGitByPath: Map<string, GitMeta>
): FleetState {
  const changed = new Set(slugs)
  const freshIds = new Set(freshSessions.map((s) => s.sessionId).filter((id) => id !== ''))
  const kept = state.sessions.filter(
    (s) =>
      !changed.has(slugOfPath(rootDir, s.fullPath)) &&
      !(s.sessionId !== '' && freshIds.has(s.sessionId))
  )

  // No-op pass (AC-28): the fresh listing is field-equal to what the model
  // already holds for these slugs and the git meta it touches is unchanged —
  // return the SAME state so `version` (and every memo keyed on it) holds.
  if (
    slugSessionsUnchanged(state.sessions, kept, freshSessions) &&
    [...freshGitByPath].every(([path, meta]) => gitMetaEqual(state.gitByPath.get(path), meta))
  ) {
    return state
  }
  const sessions = [...kept, ...freshSessions]

  const gitByPath = new Map(state.gitByPath)
  for (const [path, meta] of freshGitByPath) gitByPath.set(path, meta)

  return { sessions, gitByPath, version: state.version + 1 }
}

/**
 * True when `freshSessions` replaces exactly the rows `mergeSlugSessions` would
 * drop (every row of `all` not in `kept`), each field-equal to its fresh
 * counterpart by id.
 */
function slugSessionsUnchanged(
  all: SessionEntry[],
  kept: SessionEntry[],
  freshSessions: SessionEntry[]
): boolean {
  if (all.length - kept.length !== freshSessions.length) return false
  const keptSet = new Set(kept)
  const droppedById = new Map<string, SessionEntry>()
  for (const s of all) {
    if (keptSet.has(s)) continue
    // An id-less or repeated id can't be matched one-to-one; treat as changed.
    if (s.sessionId === '' || droppedById.has(s.sessionId)) return false
    droppedById.set(s.sessionId, s)
  }
  return freshSessions.every((f) => {
    const old = droppedById.get(f.sessionId)
    return old !== undefined && sessionEntriesEqual(old, f)
  })
}

/** `SessionEntry` fields compared with `===` by {@link sessionEntriesEqual}. */
const SCALAR_SESSION_KEYS = [
  'sessionId',
  'fullPath',
  'fileMtime',
  'firstPrompt',
  'summary',
  'messageCount',
  'created',
  'modified',
  'gitBranch',
  'projectPath',
  'isSidechain',
  'status',
  'resumable',
  'bridged',
  'transcriptState',
  'awaySummary',
  'whatsHappening',
  'ctxPct',
  'teamName',
  'agentName'
] as const satisfies readonly (keyof SessionEntry)[]

// Compile-time exhaustiveness: a new `SessionEntry` field must be added to the
// scalar list above or compared explicitly below, or this line stops compiling.
type UncomparedSessionKey = Exclude<
  keyof SessionEntry,
  (typeof SCALAR_SESSION_KEYS)[number] | 'agents' | 'stagnation'
>
const SESSION_KEYS_EXHAUSTIVE: [UncomparedSessionKey] extends [never] ? true : false = true
void SESSION_KEYS_EXHAUSTIVE

/**
 * Field-by-field equality of two `SessionEntry` rows (spec §4.A A1): scalars by
 * `===`, `agents` by length and per-index `agentId`/`fileMtime`/`status`/
 * `task`/`model`, `stagnation` by JSON.
 */
export function sessionEntriesEqual(a: SessionEntry, b: SessionEntry): boolean {
  if (a === b) return true
  for (const k of SCALAR_SESSION_KEYS) if (a[k] !== b[k]) return false
  if (JSON.stringify(a.stagnation ?? null) !== JSON.stringify(b.stagnation ?? null)) return false
  const aa = a.agents ?? []
  const ba = b.agents ?? []
  if (aa.length !== ba.length) return false
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i]
    const y = ba[i]
    if (
      x.agentId !== y.agentId ||
      x.fileMtime !== y.fileMtime ||
      x.status !== y.status ||
      x.task !== y.task ||
      x.model !== y.model
    ) {
      return false
    }
  }
  return true
}

function gitMetaEqual(a: GitMeta | undefined, b: GitMeta | undefined): boolean {
  return (
    (a?.gitBranch ?? '') === (b?.gitBranch ?? '') &&
    (a?.repoId ?? '') === (b?.repoId ?? '') &&
    (a?.isMainWorktree ?? null) === (b?.isMainWorktree ?? null)
  )
}

/**
 * Stable string over the model's MEMBERSHIP (spec §3 D1): the sorted
 * `(projectPath, sessionId)` pairs plus each folder's git identity. Append-only
 * fields (`fileMtime`, `ctxPct`, …) are deliberately absent, so a pass that only
 * grew a transcript leaves it unchanged. Computed from the state directly —
 * never via `deriveFolders`.
 */
export function membershipSignature(state: FleetState): string {
  const pairs = state.sessions.map((s) => `${s.projectPath}\0${s.sessionId}`).sort()
  const git = [...state.gitByPath.entries()]
    .sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))
    .map(([p, m]) => `${p}\0${m.gitBranch ?? ''}\0${m.repoId ?? ''}\0${m.isMainWorktree ?? ''}`)
  return `${pairs.join('\n')}\n--\n${git.join('\n')}`
}

/** Most-recent activity (ms) of a folder — mirrors `claude-reader.ts`'s sidebar sort. */
function folderActivity(f: FolderEntry): number {
  let max = 0
  for (const s of f.sessions) {
    const t = s.modified ? Date.parse(s.modified) : 0
    const candidate = Number.isFinite(t) && t > 0 ? t : s.fileMtime
    if (candidate > max) max = candidate
  }
  return max
}

/**
 * Derive the public `FolderEntry[]` view from the flat model state — the same
 * shape `scanFolders()` has always returned, in the same most-recent-first
 * order. Pure; the shell memoizes this by `state.version` so repeated reads
 * between refreshes don't re-derive (and, per the spec's "same array reference"
 * requirement, every caller sharing one `state.version` gets the identical
 * memoized array).
 */
export function deriveFolders(state: FleetState): FolderEntry[] {
  const folders = buildFolderEntries(state.sessions, state.gitByPath)
  folders.sort((a, b) => folderActivity(b) - folderActivity(a))
  return folders
}
