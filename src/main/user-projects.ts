import { app, type BrowserWindow } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { removeHelpersForWorktree } from './helpers-store'
import type { MemoryLocationConfig } from './mcp/memory-core'
import { canonicalWorktreeParentRepo } from './worktree-core'
import { scanFolders } from './claude-reader'
import { migrateFolderDataDirLazily } from './migrations/data-dir-boot'

/**
 * One worktree entry in a persisted project record. Vestigial under the
 * folder-first model — the Add-folder dialog no longer offers a worktree
 * multi-select, so new records always persist an empty `worktrees` array and
 * runtime worktree grouping is derived per-folder by the git probe. The shape
 * is retained only so older `projects.json` files still parse.
 */
export interface UserProjectWorktree {
  path: string
  /** Branch short name. Empty string when HEAD is detached. */
  branch: string
  /** Whether the user opted to track this worktree's sessions. */
  selected: boolean
}

/**
 * One user-added project. The pair `(path, addedAt)` is enough to reconstruct
 * the sidebar entry even when `~/.claude/projects/<slug>/` does not yet exist
 * (the whole point of this layer).
 */
export interface UserProject {
  /** Absolute, normalized path (no trailing slash, `~` expanded, symlinks resolved when possible). */
  path: string
  /** User-provided display name. */
  alias: string
  /** ISO 8601 timestamp recorded when the user clicked "Add project". */
  addedAt: string
  /**
   * Vestigial under the folder-first model: new records always write `[]`.
   * Retained on the on-disk schema so older `projects.json` files still parse.
   */
  worktrees: UserProjectWorktree[]
  /**
   * The operator BLOCKED agents in this folder (and everything under it) — the
   * per-folder opt-out of the free-by-default posture, set from the folder menu
   * ("Block agent control") or Settings → Control server. Optional + absent ⇒ NOT
   * blocked: agents may act here, like everywhere else. The ONLY per-folder field
   * the MCP gate reads (`assemblePolicy` → `Policy.denyFolders`), and its deny is
   * absolute — no mission grant or confirm can promote past it.
   */
  agentDenied?: boolean
  /**
   * DEPRECATED — the per-folder agent ALLOWLIST this field encoded is gone (agents
   * are free by default; see `permission-core.ts`). It is still parsed so a legacy
   * `projects.json` round-trips without data loss, but NOTHING reads it for a
   * decision: a record left over with `agentAllowed: false` is nonetheless
   * reachable by agents. That is deliberate — it is what makes the reversal
   * retroactive for existing installs with no migration pass. Never written again;
   * use {@link agentDenied} to block a folder.
   */
  agentAllowed?: boolean
  /**
   * Whether the Approval Inbox interceptor actively gates tool calls in this
   * folder (T30 per-folder trust ramp). Optional + fail-safe: a missing value is
   * `false` (NOT intercepted) — the ramp fails narrow, mirroring `agentAllowed`.
   * Consumed by the responder registry's `interceptFolders` scope; an off-ramp
   * folder is previewed in shadow, never blocked.
   */
  interceptActive?: boolean
  /**
   * Whether this folder's sidebar label should fall back to its git branch when
   * the directory basename differs from the branch (T52 auto-alias). Optional +
   * default OFF: a missing value shows the basename (or a custom alias, which
   * always wins). Per-folder opt-in mirroring `agentAllowed`; consumed by
   * `displayAlias` (`folder-alias.ts`).
   */
  aliasFromBranch?: boolean
  /**
   * Persisted git metadata mirroring `GitMeta` (`folder-model.ts`). Optional and
   * additive: present only when the folder was probed at add time. Lets the
   * sidebar group a worktree under its repo before the live git probe runs.
   * Short branch name; omitted when HEAD is detached.
   */
  gitBranch?: string
  /** Realpath'd git common-dir; folders sharing it belong to the same repo. */
  repoId?: string
  /** Whether this folder owns the repo's common-dir (the main worktree). */
  isMainWorktree?: boolean
  /**
   * T61: this worktree was born INHERITING agent control from its parent repo — the
   * `create_worktree` confirm (or New-worktree dialog) disclosed it and the human
   * did not opt out. It is NOT a grant on its own: `assemblePolicy` only honors it
   * when the global opt-in is ON and the parent repo is currently agent-allowed, so
   * revoking the repo revokes the inherited worktrees with it. Optional + fail-safe:
   * a missing value never inherits. Recorded ONLY for the canonical
   * `<repo>/.claude/worktrees/*` layout.
   */
  inheritAgentControl?: boolean
  /**
   * T89: per-project override for WHERE this repo's project memory is stored,
   * winning over the global default (Settings → Memory). `in-project` keeps it in
   * `<repo>/.harnu/memory/` (team-visible, e.g. an OSS repo); `central` redirects
   * it to a collision-proof folder under a user-picked root (a private client repo
   * → Drive/Obsidian/external disk). Optional + additive: absent ⇒ follow the
   * global default. Keyed by the record's `path`, which is always the repo's MAIN
   * checkout (the override IPC resolves any worktree to its checkout before
   * persisting), so every worktree of a repo shares one override. Lives ONLY in
   * Harnu's config — never in the client repo — which is the whole privacy point.
   */
  memoryOverride?: MemoryLocationConfig
  /**
   * T106 (D6): per-repo opt-out for a session organizing its own conversation
   * into `backlog` draft cards without being asked. NOT a security flag — a
   * missing value defaults to `true` (auto-organize is ON by default), the
   * opposite convention from `agentAllowed`, since this only gates model
   * BEHAVIOR (the task-smell contract in `docs/harnu-orchestrator.md`), never
   * a tool grant. Keyed by the record's own `path`; a linked worktree with no
   * explicit value inherits its parent repo's (`getUserProjectAutoOrganize`
   * resolves via `canonicalWorktreeParentRepo`) rather than re-asking.
   */
  autoOrganizeCards?: boolean
  /**
   * T191: the folder whose session asked for this worktree to be cut — the
   * orchestrator. Absolute, normalized path. Optional + fail-safe: absent means
   * no mother, and the folder renders flat in the sidebar. Recorded ONLY when the
   * requester is a non-main worktree of the SAME repo (see {@link resolveBornFrom}
   * for the recording guards); a worktree cut through the New-worktree UI dialog
   * is deliberately motherless. Also settable manually via the folder menu's "Set
   * parent folder" (no guards on that path — an explicit human choice).
   */
  bornFrom?: string
  /**
   * T217: per-folder overrides for Harnu's BUNDLED skills (Settings → Skills), keyed
   * by skill name. TRI-STATE, exactly like `ClaudeBootConfig`'s per-folder scope: an
   * ABSENT key INHERITS the global `<userData>/bundled-skills.json` value, `true` /
   * `false` are explicit and beat the global one in BOTH directions.
   *
   * It lives here — in Harnu's own store — rather than in the repo's
   * `.claude/settings.local.json`, and that is the point: enabling a bundled skill
   * for a project must write NOTHING inside the user's repository (T217 AC-3), not
   * even a gitignored file. Resolution is `folder[skill] ?? global[skill] ?? false`
   * (`resolveSkillEnabled` in `bundled-skills-core.ts`).
   */
  skills?: Record<string, boolean>
  /**
   * T344: "new sessions start as Orchestrator" — every plain `claude-new`
   * session an OPERATOR starts in this folder ("+ New session", the New
   * session dialog, the keyboard shortcut) is born armed (T98's contract doc
   * injected + the structural guard) with no per-session click. Optional +
   * default OFF: a missing value means no auto-arm, the opposite convention
   * from `autoOrganizeCards` (this grants a behavior-changing structural
   * guard, not a cheap/reversible model nudge).
   *
   * EXACT-PATH ONLY — deliberately does NOT inherit like `autoOrganizeCards`
   * does for a canonical worktree (`getUserProjectOrchestratorDefault` never
   * consults `canonicalWorktreeParentRepo`): an orchestrator's own folder
   * dispatches EXECUTORS into its worktrees, and arming those by inheritance
   * would block every executor from editing code (see
   * `shouldArmAtSpawn` in `orchestrator-guard.ts`, which independently also
   * excludes every agent-dispatched spawn regardless of this flag).
   */
  orchestratorDefault?: boolean
}

/** On-disk schema for `<userData>/projects.json`. */
export interface UserProjectsFile {
  version: 1
  projects: UserProject[]
  /**
   * Normalized absolute paths the user explicitly hid from the sidebar via
   * the per-folder right-click menu. Includes BOTH user-added paths AND
   * auto-discovered ones (from `~/.claude/projects/`) — we key on path
   * because slugs can shift (a user-added path may later acquire a
   * Claude-derived slug, and we want hidden state to follow the directory,
   * not the categorization).
   *
   * Optional in the schema (the field was introduced post-v1) — readers
   * default to `[]` when missing so old files load cleanly. Writers always
   * emit the field; old code that ignores it leaves it untouched on
   * round-trip.
   */
  hiddenPaths?: string[]
}

const EMPTY_FILE: UserProjectsFile = { version: 1, projects: [], hiddenPaths: [] }
const FILE_NAME = 'projects.json'
const TMP_SUFFIX = '.tmp'

/**
 * In-process async queue, keyed on the target file path, serializing every
 * mutator's read→merge→write so concurrent callers can't clobber each
 * other's changes (BUG-41). Electron main is single-process — no
 * cross-process locking is needed or wanted. A rejected mutator does not
 * stall the queue for subsequent callers: `next` always resolves, even when
 * `fn` throws, so the entry stored in `queues` never carries a rejection.
 */
const queues = new Map<string, Promise<unknown>>()

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(filePath) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    filePath,
    next.then(
      () => {},
      () => {}
    )
  )
  return next
}

/**
 * Path on disk where the user-projects file lives. Resolved via Electron's
 * `app.getPath('userData')`, which on Linux is `~/.config/<appName>/`, on
 * macOS is `~/Library/Application Support/<appName>/`, and on Windows is
 * `%APPDATA%/<appName>/`.
 */
export function userProjectsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/**
 * Normalize a project path for stable equality checks. The contract:
 *
 *   1. Expand a leading `~` to `os.homedir()` so `~/code/foo` matches
 *      `/home/u/code/foo`.
 *   2. `path.resolve` (= absolutize) the result so relative paths from a
 *      legacy entry don't slip through.
 *   3. Pass through `path.normalize` so `foo/./bar` and `foo//bar` collapse,
 *      and separators on Windows get unified. Note: we intentionally KEEP
 *      the user's original drive-letter case on Windows (`C:\` stays `C:\`);
 *      uppercasing it would conflict with the file system's case-preserving
 *      behavior and confuse the `git worktree` cache key in `worktree.ts`.
 *   4. Strip a trailing separator unless the path is the root itself
 *      (`/`, `C:\`).
 *   5. Best-effort `fs.realpath` to resolve symlinks. On any error (missing
 *      path, permission denied, …) fall back to the resolved-but-unrealpathed
 *      string so a not-yet-existing path is still usable.
 */
export async function normalizePath(input: string): Promise<string> {
  const expanded = input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input
  const absolute = path.resolve(expanded)
  const normalized = path.normalize(absolute)
  const trimmed = stripTrailingSeparator(normalized)
  try {
    return await fs.realpath(trimmed)
  } catch {
    return trimmed
  }
}

function stripTrailingSeparator(p: string): string {
  // Don't strip the root: `/` or `C:\` must keep their separator.
  if (p.length <= 1) return p
  if (process.platform === 'win32' && /^[A-Za-z]:\\$/.test(p)) return p
  if (p.endsWith(path.sep) && p !== path.sep) return p.slice(0, -1)
  return p
}

function isUserProjectsFile(value: unknown): value is UserProjectsFile {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (obj.version !== 1 || !Array.isArray(obj.projects)) return false
  // `hiddenPaths` is optional — accept its absence, but if present it must
  // be a string array. Reject other shapes so a corrupt write doesn't make
  // every sidebar entry vanish on next load.
  if (obj.hiddenPaths !== undefined) {
    if (!Array.isArray(obj.hiddenPaths)) return false
    if (obj.hiddenPaths.some((p) => typeof p !== 'string')) return false
  }
  return true
}

/**
 * Read the file. Returns an empty `{ version: 1, projects: [] }` if the file
 * doesn't exist OR if parsing fails (corrupt JSON). Logs the error in the
 * corrupt-parse case. Never throws.
 *
 * If the file's `version` is not `1`, logs a warning and returns the empty
 * default — future versions can add a migrator here without changing the
 * external contract.
 */
export async function readUserProjects(): Promise<UserProjectsFile> {
  const filePath = userProjectsPath()
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    // ENOENT — fresh install, no file yet. Any other error (EACCES, EIO)
    // we also degrade gracefully so the sidebar still loads.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[user-projects] failed to read ${filePath}:`, err)
    }
    return { ...EMPTY_FILE, projects: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[user-projects] corrupt JSON at ${filePath}:`, err)
    return { ...EMPTY_FILE, projects: [] }
  }

  if (!isUserProjectsFile(parsed)) {
    const version = (parsed as { version?: unknown })?.version
    console.warn(
      `[user-projects] unsupported schema (version=${String(version)}) at ${filePath}; treating as empty`
    )
    return { ...EMPTY_FILE, projects: [] }
  }

  return parsed
}

/**
 * Atomically write the file. Writes to `projects.json.tmp` first, then
 * renames over `projects.json`. Creates the userData directory if missing.
 *
 * `fs.rename` is atomic on the same filesystem on POSIX and Windows
 * (since Node 10+), so a crash mid-write leaves either the old file or the
 * new file — never a half-written one.
 */
export async function writeUserProjects(file: UserProjectsFile): Promise<void> {
  const filePath = userProjectsPath()
  const dir = path.dirname(filePath)
  const tmpPath = filePath + TMP_SUFFIX

  await fs.mkdir(dir, { recursive: true })
  // Pretty-print with 2-space indent so the file is human-readable when the
  // user inspects it. Cost is negligible at the sizes we expect (<1 MB even
  // with hundreds of projects).
  const body = JSON.stringify(file, null, 2) + '\n'
  await fs.writeFile(tmpPath, body, 'utf8')
  await fs.rename(tmpPath, filePath)
}

/**
 * Append-or-replace a project by `path`. The incoming `entry.path` is
 * normalized first; if a project with the same normalized path already
 * exists, it's replaced in place (preserving order). Otherwise the new
 * entry is appended. Returns the new full file content so the caller can
 * pipe it straight to the renderer.
 *
 * The whole `entry` is persisted verbatim (only `path` is normalized), so any
 * optional `agentAllowed` / git meta (`repoId` / `gitBranch` / `isMainWorktree`)
 * the caller supplies round-trips onto disk.
 */
function appVersionOrUndefined(): string | undefined {
  try {
    return app.getVersion()
  } catch {
    return undefined
  }
}

export async function addUserProject(entry: UserProject): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(entry.path)
    const normalizedEntry: UserProject = { ...entry, path: normalizedPath }

    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    const next: UserProjectsFile = {
      version: 1,
      projects:
        idx === -1
          ? [...file.projects, normalizedEntry]
          : file.projects.map((p, i) => (i === idx ? normalizedEntry : p)),
      // Adding a project explicitly = user wants to see it. Remove from the
      // hidden list if it was there (rare but possible: hide first, then
      // re-add via the dialog).
      hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
    }
    await writeUserProjects(next)
    return next
  }).then(async (next) => {
    // A folder that becomes known after boot (pinned, adopted, a fresh worktree) was not
    // in the boot copy pass: bring its legacy data dir across before anything reads it.
    // Outside the file lock — a big copy must not hold up other project writes — and
    // never throws.
    await migrateFolderDataDirLazily(entry.path, { appVersion: appVersionOrUndefined() })
    return next
  })
}

/**
 * BLOCK (or unblock) agents in a folder — the per-folder opt-out of the
 * free-by-default posture (`agentDenied`). Replaces the old
 * `setUserProjectAgentAllowed`, which wrote the allowlist flag the gate no longer
 * reads. The path is normalized before lookup. Idempotent — a no-op (and no write,
 * to avoid churning the mtime) when the path is not a tracked project OR already
 * carries the requested value. Returns the new (or unchanged) file so the caller
 * can refresh the renderer.
 *
 * If NO record exists, the folder is NOT auto-pinned: an unpinned folder is
 * already reachable by agents, so there would be nothing to unblock later — but it
 * is also not blockable without pinning it first, which is exactly what the UI does
 * (the toggle only appears on folders in the sidebar). A block on an unknown path
 * is therefore a silent no-op, mirroring the old setter's contract.
 *
 * Blocking is PREFIX-SCOPED at decision time (`isFolderDenied`): blocking a repo
 * also blocks its worktrees and any subdirectory, in one action.
 */
export async function setUserProjectAgentDenied(
  targetPath: string,
  denied: boolean
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) return file // not a tracked project — nothing to flag
    if ((file.projects[idx].agentDenied ?? false) === denied) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) => (i === idx ? { ...p, agentDenied: denied } : p)),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * Set (or reset) the display `alias` of a folder by `path` (T52 — rename). The
 * path is normalized before lookup. If NO `UserProject` exists for the path (an
 * auto-discovered folder), a record is CREATED so the alias survives a restart —
 * the same "renaming pins it" strategy the Hide flow uses for its hidden paths.
 *
 * A blank `alias` (empty / whitespace) RESETS the label to the folder's
 * basename — the display-alias derivation (`folder-alias.ts`) treats
 * `alias === basename` as "no custom override", so the folder falls back to the
 * basename (or its branch when auto-alias is on). Idempotent: a no-op (no write)
 * when the resolved alias already matches. Returns the new (or unchanged) file.
 */
export async function setUserProjectAlias(
  targetPath: string,
  alias: string
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const resolvedAlias = alias.trim() || path.basename(normalizedPath)

    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) {
      // Auto-discovered folder: create a pinned record carrying the alias.
      const created: UserProject = {
        path: normalizedPath,
        alias: resolvedAlias,
        addedAt: new Date().toISOString(),
        worktrees: []
      }
      const next: UserProjectsFile = {
        version: 1,
        projects: [...file.projects, created],
        // Renaming = the user wants this folder visible; clear any hidden flag.
        hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
      }
      await writeUserProjects(next)
      return next
    }
    if (file.projects[idx].alias === resolvedAlias) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) => (i === idx ? { ...p, alias: resolvedAlias } : p)),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * Set (or reset) the `inheritAgentControl` birth-marker (T61/T72) on a worktree by
 * `path`.
 *
 * VESTIGIAL since the free-by-default reversal: the marker used to be the
 * load-bearing half of deriving a worktree's grant from its parent repo's, but
 * there is no allowlist to derive from any more — a worktree is reachable like any
 * other folder. It is still written (harmless provenance: "this worktree was born
 * inheriting") and the module is kept wired so a future guarded mode that re-derives
 * worktree scope gets it back for free. If NO record exists, one is CREATED so the
 * mark survives a restart, mirroring {@link setUserProjectAliasFromBranch} — and it
 * no longer stamps `agentAllowed: false` on that record, which under the old
 * fail-closed posture was the whole point and today would just leave a dead field on
 * disk. Idempotent: a no-op (no write) when the flag already matches.
 */
export async function setUserProjectInheritAgentControl(
  targetPath: string,
  enabled: boolean
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) {
      // Not yet pinned: create a record carrying only the birth-marker. No
      // `agentAllowed` — the field is deprecated and nothing reads it.
      const created: UserProject = {
        path: normalizedPath,
        alias: path.basename(normalizedPath),
        addedAt: new Date().toISOString(),
        worktrees: [],
        ...(enabled ? { inheritAgentControl: true } : {})
      }
      const next: UserProjectsFile = {
        version: 1,
        projects: [...file.projects, created],
        // Marking = the operator wants this worktree controllable; clear any hidden flag.
        hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
      }
      await writeUserProjects(next)
      return next
    }
    if ((file.projects[idx].inheritAgentControl ?? false) === enabled) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) =>
        i === idx ? { ...p, inheritAgentControl: enabled } : p
      ),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * T191: resolve the `bornFrom` edge for a freshly created worktree, applying
 * the two recording guards (D1 in the spec) — a missing edge is always
 * preferable to a wrong one:
 *
 *   (a) the requester is NOT the repo's main checkout (else every worktree
 *       would end up nesting under main);
 *   (b) the requester resolves to a KNOWN folder of the SAME repo, compared by
 *       `repoId` (the git common-dir realpath already probed for the new
 *       worktree).
 *
 * Returns the requester's normalized path when both guards pass, else
 * `undefined`. Never throws — a lookup failure just means no mother is
 * recorded, never a bad one.
 */
export async function resolveBornFrom(
  requesterPath: string,
  target: { repoId?: string }
): Promise<string | undefined> {
  if (!target.repoId) return undefined
  const normalizedRequester = await normalizePath(requesterPath)
  const file = await readUserProjects()
  const requester = file.projects.find((p) => p.path === normalizedRequester)
  if (!requester) return undefined // guard (b): not a known folder
  if (requester.isMainWorktree === true) return undefined // guard (a): main checkout
  if (requester.repoId !== target.repoId) return undefined // guard (b): different repo
  return normalizedRequester
}

/**
 * Set (or clear) the `bornFrom` lineage edge on a worktree by `path` — the
 * "Set parent folder" / "Clear parent folder" manual override (T191 D1's
 * retroactive path). Unlike {@link resolveBornFrom} (the birth-time guarded
 * path), this is an EXPLICIT human choice from the folder menu: no repo/main-
 * checkout guard applies here, only normalization. Pass `null` to clear. If NO
 * record exists (an auto-discovered folder), one is CREATED (mirrors
 * {@link setUserProjectAlias}) so the edge survives a restart. Idempotent — a
 * no-op (no write) when the value already matches. Returns the new (or
 * unchanged) file.
 */
export async function setUserProjectBornFrom(
  targetPath: string,
  bornFrom: string | null
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const normalizedBornFrom = bornFrom ? await normalizePath(bornFrom) : null
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) {
      if (!normalizedBornFrom) return file // nothing to clear on a non-tracked folder
      const created: UserProject = {
        path: normalizedPath,
        alias: path.basename(normalizedPath),
        addedAt: new Date().toISOString(),
        worktrees: [],
        bornFrom: normalizedBornFrom
      }
      const next: UserProjectsFile = {
        version: 1,
        projects: [...file.projects, created],
        hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
      }
      await writeUserProjects(next)
      return next
    }
    const current = file.projects[idx].bornFrom ?? null
    if (current === normalizedBornFrom) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) => {
        if (i !== idx) return p
        if (!normalizedBornFrom) {
          const { bornFrom: _drop, ...rest } = p
          return rest
        }
        return { ...p, bornFrom: normalizedBornFrom }
      }),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * T191: sibling worktrees of the SAME repo (`repoId`) eligible as a manual
 * `bornFrom` target — the "Set parent folder" submenu's candidate list.
 * Excludes `excludePath` itself (a folder can't be its own mother). Returns
 * `{ path, alias }` pairs sorted by alias for a stable menu order.
 */
export async function listBornFromCandidates(
  repoId: string,
  excludePath: string
): Promise<Array<{ path: string; alias: string }>> {
  const file = await readUserProjects()
  const normalizedExclude = await normalizePath(excludePath)
  return file.projects
    .filter((p) => p.repoId === repoId && p.path !== normalizedExclude)
    .map((p) => ({ path: p.path, alias: p.alias }))
    .sort((a, b) => a.alias.localeCompare(b.alias))
}

/**
 * Read the per-project memory-location override (T89) for a checkout path, or
 * `undefined` when the project has none (⇒ follow the global default). The path
 * is normalized before lookup. Callers pass the repo's MAIN checkout path (a
 * worktree is resolved to its checkout upstream), so every worktree shares the
 * one override.
 */
export async function getUserProjectMemoryOverride(
  targetPath: string
): Promise<MemoryLocationConfig | undefined> {
  const file = await readUserProjects()
  const normalizedPath = await normalizePath(targetPath)
  return file.projects.find((p) => p.path === normalizedPath)?.memoryOverride
}

/**
 * Set (or clear) the per-project memory-location override (T89). Pass `null` to
 * REMOVE the override so the project falls back to the global default. If NO
 * record exists (an auto-discovered folder), one is CREATED (like
 * {@link setUserProjectAlias}) so the override survives a restart. Idempotent —
 * a no-op (no write) when the override already matches. Returns the new (or
 * unchanged) file.
 */
export async function setUserProjectMemoryOverride(
  targetPath: string,
  override: MemoryLocationConfig | null
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) {
      if (!override) return file // nothing to clear on a non-tracked folder
      const created: UserProject = {
        path: normalizedPath,
        alias: path.basename(normalizedPath),
        addedAt: new Date().toISOString(),
        worktrees: [],
        memoryOverride: override
      }
      const next: UserProjectsFile = {
        version: 1,
        projects: [...file.projects, created],
        hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
      }
      await writeUserProjects(next)
      return next
    }
    const current = file.projects[idx].memoryOverride
    const sameOverride =
      (!override && !current) ||
      (!!override && !!current && JSON.stringify(override) === JSON.stringify(current))
    if (sameOverride) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) => {
        if (i !== idx) return p
        const { memoryOverride: _drop, ...rest } = p
        return override ? { ...rest, memoryOverride: override } : rest
      }),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * Default for `autoOrganizeCards` (T106/D6) when no record — own or inherited
 * — carries an explicit value: auto-organize is ON. The opposite convention
 * from `agentAllowed` (fail-CLOSED) because this gates model behavior, not a
 * tool grant — see the field's own doc comment on {@link UserProject}.
 */
export const AUTO_ORGANIZE_DEFAULT = true

/**
 * Resolve the effective `autoOrganizeCards` value for `folder` (T106/D6): its
 * own explicit value if the project record carries one; else, when `folder`
 * is a canonical Harnu worktree (`<repo>/.claude/worktrees/<slug>`), its parent
 * repo's explicit value; else {@link AUTO_ORGANIZE_DEFAULT}. Pure string math
 * for the worktree check (no git probe) — mirrors the agent-control
 * inheritance path (`worktree-core.ts`) but with a `true` default instead of
 * fail-closed, since a draft card is cheap and reversible, not a grant.
 */
export async function getUserProjectAutoOrganize(targetPath: string): Promise<boolean> {
  const file = await readUserProjects()
  const normalizedPath = await normalizePath(targetPath)
  const own = file.projects.find((p) => p.path === normalizedPath)
  if (own?.autoOrganizeCards !== undefined) return own.autoOrganizeCards

  const parentRepo = canonicalWorktreeParentRepo(normalizedPath)
  if (parentRepo) {
    const normalizedParent = await normalizePath(parentRepo)
    const main = file.projects.find((p) => p.path === normalizedParent)
    if (main?.autoOrganizeCards !== undefined) return main.autoOrganizeCards
  }
  return AUTO_ORGANIZE_DEFAULT
}

/**
 * Set the `autoOrganizeCards` flag (T106/D6) on a project by `path` — always
 * the folder the user right-clicked, never resolved to a parent repo (the
 * toggle is per-repo/folder; a linked worktree doesn't offer this entry at
 * all, see `FolderMenu.vue`). If NO record exists (auto-discovered folder),
 * one is CREATED (like {@link setUserProjectAliasFromBranch}) so the opt-out
 * survives a restart. Idempotent — a no-op (no write) when the OWN explicit
 * value already matches (inherited values are never compared here). Returns
 * the new (or unchanged) file.
 */
export async function setUserProjectAutoOrganize(
  targetPath: string,
  enabled: boolean
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) {
      const created: UserProject = {
        path: normalizedPath,
        alias: path.basename(normalizedPath),
        addedAt: new Date().toISOString(),
        worktrees: [],
        autoOrganizeCards: enabled
      }
      const next: UserProjectsFile = {
        version: 1,
        projects: [...file.projects, created],
        hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
      }
      await writeUserProjects(next)
      return next
    }
    if (file.projects[idx].autoOrganizeCards === enabled) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) => (i === idx ? { ...p, autoOrganizeCards: enabled } : p)),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * Resolve the `orchestratorDefault` flag (T344) for `targetPath` — its own
 * explicit value, else `false`. EXACT-PATH ONLY: unlike
 * {@link getUserProjectAutoOrganize}, this never consults
 * `canonicalWorktreeParentRepo` — a linked worktree of an armed repo is NOT
 * itself armed (AC-5; see the field's own doc comment on {@link UserProject}).
 */
export async function getUserProjectOrchestratorDefault(targetPath: string): Promise<boolean> {
  const file = await readUserProjects()
  const normalizedPath = await normalizePath(targetPath)
  const own = file.projects.find((p) => p.path === normalizedPath)
  return own?.orchestratorDefault ?? false
}

/**
 * Set the `orchestratorDefault` flag (T344) on a project by `path` — always
 * the folder the user right-clicked, never resolved to a parent repo (AC-5:
 * per exact folder, no propagation to worktrees). If NO record exists (an
 * auto-discovered folder), one is CREATED — same contract as
 * {@link setUserProjectAutoOrganize} — so the toggle survives a restart.
 * Idempotent: no write when the value already matches. Returns the new (or
 * unchanged) file.
 */
export async function setUserProjectOrchestratorDefault(
  targetPath: string,
  enabled: boolean
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) {
      const created: UserProject = {
        path: normalizedPath,
        alias: path.basename(normalizedPath),
        addedAt: new Date().toISOString(),
        worktrees: [],
        orchestratorDefault: enabled
      }
      const next: UserProjectsFile = {
        version: 1,
        projects: [...file.projects, created],
        hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
      }
      await writeUserProjects(next)
      return next
    }
    if (file.projects[idx].orchestratorDefault === enabled) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) =>
        i === idx ? { ...p, orchestratorDefault: enabled } : p
      ),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * The per-folder BUNDLED-skill overrides for `targetPath` (T217), or `{}` when the
 * folder has no record or no overrides. Tri-state by ABSENCE: a key that is not
 * here inherits the global value — this function deliberately does NOT merge the
 * global map in, so `resolveSkillEnabled` can still tell "unset" from "explicitly
 * false" (which is what lets a folder turn OFF a globally-ON skill).
 *
 * Keyed by the record's own `path`: unlike `autoOrganizeCards`, a worktree does NOT
 * inherit its parent repo's overrides. A worktree is a branch of work with its own
 * purpose, and silently importing the repo's skill set would surprise the operator
 * on exactly the surface T217 exists to make visible.
 */
export async function getUserProjectSkills(targetPath: string): Promise<Record<string, boolean>> {
  const file = await readUserProjects()
  const normalizedPath = await normalizePath(targetPath)
  const own = file.projects.find((p) => p.path === normalizedPath)
  return own?.skills ?? {}
}

/**
 * Set (or CLEAR) one per-folder bundled-skill override (T217). `enabled: undefined`
 * removes the key, which restores inheritance from the global toggle — that is the
 * "Default" pill in the pane's scope switch, not a synonym for `false`.
 *
 * If NO record exists (an auto-discovered folder), one is CREATED — same contract as
 * {@link setUserProjectAutoOrganize} — so the override survives a restart. Idempotent:
 * no write when the value already matches. Returns the new (or unchanged) file.
 */
export async function setUserProjectSkill(
  targetPath: string,
  skill: string,
  enabled: boolean | undefined
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)

    /** Apply the set/clear to a skills map, returning `undefined` when it empties. */
    const next = (
      prev: Record<string, boolean> | undefined
    ): Record<string, boolean> | undefined => {
      const out = { ...(prev ?? {}) }
      if (enabled === undefined) delete out[skill]
      else out[skill] = enabled
      return Object.keys(out).length ? out : undefined
    }

    if (idx === -1) {
      if (enabled === undefined) return file // nothing to clear on a folder we don't track
      const created: UserProject = {
        path: normalizedPath,
        alias: path.basename(normalizedPath),
        addedAt: new Date().toISOString(),
        worktrees: [],
        skills: { [skill]: enabled }
      }
      const created_file: UserProjectsFile = {
        version: 1,
        projects: [...file.projects, created],
        hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
      }
      await writeUserProjects(created_file)
      return created_file
    }

    if (file.projects[idx].skills?.[skill] === enabled) return file // unchanged
    const updated: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) => (i === idx ? { ...p, skills: next(p.skills) } : p)),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(updated)
    return updated
  })
}

/**
 * Whether agents may act in the folder at `targetPath` — i.e. it is NOT explicitly
 * blocked. Free-by-default: a non-tracked path, or one with no `agentDenied` flag,
 * returns `true`. The path is normalized before lookup.
 *
 * NOTE this checks the record's OWN flag only; it does not walk ancestors the way
 * the gate's `isFolderDenied` does (a subdirectory of a blocked repo is denied at
 * decision time even though this returns `true` for it). Callers here only ask about
 * a folder they are pinning/creating, so the exact-record answer is the right one.
 */
export async function isUserProjectAgentAllowed(targetPath: string): Promise<boolean> {
  const file = await readUserProjects()
  const normalizedPath = await normalizePath(targetPath)
  const project = file.projects.find((p) => p.path === normalizedPath)
  return project?.agentDenied !== true
}

/**
 * Set the `interceptActive` flag (T30 per-folder trust ramp) on a project by
 * `path`. Byte-for-byte the {@link setUserProjectAgentAllowed} contract:
 * normalized lookup, idempotent (no write when unchanged), pinned-projects only.
 * Returns the new (or unchanged) file so the caller can re-hydrate the responder
 * registry's `interceptFolders` scope.
 */
export async function setUserProjectInterceptActive(
  targetPath: string,
  allowed: boolean
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) return file // not a tracked project — nothing to flag
    if ((file.projects[idx].interceptActive ?? false) === allowed) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) => (i === idx ? { ...p, interceptActive: allowed } : p)),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * Set the `aliasFromBranch` flag (T52 auto-alias) on a project by `path`. If NO
 * record exists (auto-discovered folder), one is CREATED (like
 * {@link setUserProjectAlias}) so the opt-in survives a restart. Idempotent —
 * a no-op (no write) when the flag already matches. Returns the new (or
 * unchanged) file.
 */
export async function setUserProjectAliasFromBranch(
  targetPath: string,
  enabled: boolean
): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const idx = file.projects.findIndex((p) => p.path === normalizedPath)
    if (idx === -1) {
      const created: UserProject = {
        path: normalizedPath,
        alias: path.basename(normalizedPath),
        addedAt: new Date().toISOString(),
        worktrees: [],
        aliasFromBranch: enabled
      }
      const next: UserProjectsFile = {
        version: 1,
        projects: [...file.projects, created],
        hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
      }
      await writeUserProjects(next)
      return next
    }
    if ((file.projects[idx].aliasFromBranch ?? false) === enabled) return file // unchanged
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects.map((p, i) => (i === idx ? { ...p, aliasFromBranch: enabled } : p)),
      hiddenPaths: file.hiddenPaths ?? []
    }
    await writeUserProjects(next)
    return next
  })
}

/** The normalized paths of pinned folders currently on the intercept ramp (T30). */
export async function interceptActivePaths(): Promise<string[]> {
  const file = await readUserProjects()
  return file.projects.filter((p) => p.interceptActive === true).map((p) => p.path)
}

/**
 * Mark `path` as hidden from the sidebar. Idempotent — adding an
 * already-hidden path is a no-op (still returns the current file so the
 * renderer can refresh state). The path is normalized before comparison so
 * `~/foo` and `/home/u/foo` are treated as the same target.
 *
 * Hidden state is independent of `projects[]` membership: an auto-discovered
 * project (not in `projects[]`) can be hidden too, and the user can unhide
 * it later without ever explicitly adding it.
 */
export async function hideUserProject(targetPath: string): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const current = file.hiddenPaths ?? []
    if (current.includes(normalizedPath)) {
      // Already hidden — return the file unchanged. Skip the disk write so we
      // don't churn the mtime.
      return { ...file, hiddenPaths: current }
    }
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects,
      hiddenPaths: [...current, normalizedPath]
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * Remove `path` from the hidden list. Idempotent — unhiding a path that
 * isn't hidden is a no-op (still returns the current file).
 */
export async function unhideUserProject(targetPath: string): Promise<UserProjectsFile> {
  return withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)
    const current = file.hiddenPaths ?? []
    const filtered = current.filter((p) => p !== normalizedPath)
    if (filtered.length === current.length) {
      // Nothing to remove.
      return { ...file, hiddenPaths: current }
    }
    const next: UserProjectsFile = {
      version: 1,
      projects: file.projects,
      hiddenPaths: filtered
    }
    await writeUserProjects(next)
    return next
  })
}

/**
 * Remove a project by `path`. Idempotent — no-op (and no write) if the
 * normalized path is not present. Returns the new (or unchanged) file.
 */
export async function removeUserProject(targetPath: string): Promise<UserProjectsFile> {
  const { next, removedProject } = await withFileLock(userProjectsPath(), async () => {
    const file = await readUserProjects()
    const normalizedPath = await normalizePath(targetPath)

    // Capture the removed project's worktrees BEFORE filtering so we
    // can cascade-delete helpers entries for each one.
    const removedProject = file.projects.find((p) => p.path === normalizedPath)
    const filtered = file.projects.filter((p) => p.path !== normalizedPath)

    if (filtered.length === file.projects.length) {
      // Nothing changed — skip the write to avoid touching mtime needlessly.
      return { next: file, removedProject: undefined }
    }
    // Remove from hiddenPaths too — a removed project shouldn't keep
    // dangling hidden state. If Claude later re-discovers the same path it
    // will start visible, which matches "I deleted this folder, I'm done
    // with it" intent.
    const next: UserProjectsFile = {
      version: 1,
      projects: filtered,
      hiddenPaths: (file.hiddenPaths ?? []).filter((p) => p !== normalizedPath)
    }
    await writeUserProjects(next)
    return { next, removedProject }
  })

  if (!removedProject) return next

  // Cascade: helpers entries for this project's root path AND each of
  // its worktrees must also go. Best-effort — failures here are logged
  // but do not roll back the project removal (the user already saw the
  // sidebar update; we don't want a transient FS error to flicker the
  // project back in).
  const pathsToScrub = [removedProject.path]
  for (const wt of removedProject.worktrees) {
    pathsToScrub.push(wt.path)
  }
  for (const p of pathsToScrub) {
    try {
      await removeHelpersForWorktree(p)
    } catch (err) {
      console.warn(`[user-projects] cascade helpers cleanup failed for ${p}:`, err)
    }
  }

  return next
}

/** Success shape returned by {@link removeGhostFolder}. */
export interface RemoveGhostFolderSuccess {
  ok: true
  removed: { path: string; unpinned: boolean; sessionsDropped: number }
}

/** Refusal shape returned by {@link removeGhostFolder}. */
export interface RemoveGhostFolderFailure {
  ok: false
  error: 'DIRECTORY_STILL_EXISTS' | 'FOLDER_UNKNOWN'
}

export type RemoveGhostFolderResult = RemoveGhostFolderSuccess | RemoveGhostFolderFailure

/**
 * BUG-56 — the single cleanup function reused by Reaper's `sidebar-detach`
 * step, manual `removeWorktree()`, and the `remove_folder` MCP verb (PRD D1).
 *
 * ONLY proceeds when `!existsSync(targetPath)` (PRD D2, the safety
 * guardrail): this function can clean up Harnu's own bookkeeping of a
 * directory that's already gone, but it never touches disk or git state, and
 * it never hides a folder whose data is still reachable. Refuses with
 * `DIRECTORY_STILL_EXISTS` otherwise, and with `FOLDER_UNKNOWN` when the path
 * is neither pinned/hidden in `projects.json` NOR known via live session
 * transcripts (`scanFolders`) — nothing to clean up.
 *
 * On success: unpins + unhides the path (whichever applied) and emits
 * `folders:removed` on `getWindow()`'s window (PRD D4) so the renderer's
 * `onFolderRemoved` handler drops the folder + its sessions from the live
 * model without an app restart. `sessionsDropped` is a best-effort count from
 * the same `scanFolders` read used for the `FOLDER_UNKNOWN` check.
 */
export async function removeGhostFolder(
  getWindow: () => BrowserWindow | null,
  targetPath: string
): Promise<RemoveGhostFolderResult> {
  const normalizedPath = await normalizePath(targetPath)
  if (existsSync(normalizedPath)) {
    return { ok: false, error: 'DIRECTORY_STILL_EXISTS' }
  }

  const file = await readUserProjects()
  const wasPinned = file.projects.some((p) => p.path === normalizedPath)
  const wasHidden = (file.hiddenPaths ?? []).includes(normalizedPath)

  const known = await scanFolders()
  const knownEntry = known.find((f) => f.path === normalizedPath)
  const sessionsDropped = knownEntry?.sessions.length ?? 0

  if (!wasPinned && !wasHidden && !knownEntry) {
    return { ok: false, error: 'FOLDER_UNKNOWN' }
  }

  if (wasPinned) await removeUserProject(normalizedPath)
  if (wasHidden) await unhideUserProject(normalizedPath)

  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('folders:removed', { path: normalizedPath })
  }

  return {
    ok: true,
    removed: { path: normalizedPath, unpinned: wasPinned, sessionsDropped }
  }
}
