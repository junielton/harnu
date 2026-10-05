/**
 * Imperative shell (T20) wiring the pure {@link worktree-core} planners to real
 * `git` subprocesses + the user-projects store over IPC.
 *
 * Three UI channels are served:
 *  - `worktree:create` → {@link createWorktree}: validate the (possibly
 *    agent-influenced) request, resolve the project's `WORKTREE.md`
 *    ({@link resolveManifest}), `git worktree add` at the resolved `dir`, provision
 *    it (`seed` copy/link + `setup`, or a delegated `create:`), then ADOPT the new
 *    directory as a pinned folder ({@link adoptFolder}) and tell the renderer via
 *    `folders:adopted`. Any seed/setup failure rolls the worktree back.
 *  - `worktree:list` → enumerate a repo's worktrees (`git worktree list
 *    --porcelain`, parsed by {@link parseWorktreeList}).
 *  - `worktree:remove` → remove a worktree; REFUSES a dirty worktree unless the
 *    caller passes `force`. This channel is UI-ONLY: there is deliberately no
 *    `remove_worktree` MCP tool, so an agent can never reach it.
 *
 * SECURITY — every `git` invocation uses `execFile` (never a shell), with
 * `windowsHide` + a hard `timeout`, and every agent-controlled argv position
 * (`branch`, `baseRef`, the worktree `path`) is gated by
 * {@link validateWorktreeRequest} BEFORE the subprocess spawns. The ONE
 * deliberate shell is for `setup`/`create` — arbitrary commands the repo
 * author committed to `WORKTREE.md` (trusted content, not agent input; the agent
 * only supplies the pre-validated `branch`/`baseRef`, never the `dir` or commands).
 * git's `stderr` is surfaced verbatim so the operator sees the real failure.
 *
 * BUG-29/ADR-0005: those commands are POSIX-shell strings on every platform —
 * POSIX runs them via `sh -c`; Windows has no `sh`, so a real POSIX shell (Git
 * Bash) is resolved via {@link resolvePosixShell}, or the create fails loudly
 * ({@link assertPosixShellAvailable}) before anything is mutated. The seed's
 * `copy` op uses `fs.cp` (D4), with `cp --reflink=auto` kept as a Linux fast path.
 *
 * env-bound (`child_process` + electron IPC + `node:fs`) ⇒ e2e-only per ADR-0001.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, isAbsolute, resolve } from 'node:path'
import { readFile, mkdir, symlink, access, lstat, rm, stat, cp } from 'node:fs/promises'
import { platform } from 'node:os'
import { ipcMain, type BrowserWindow } from 'electron'
import { spawnEnvOnce } from './appimage-env'
import { resolvePosixShell, posixShellRequirementError } from './shell-resolve'
import {
  validateWorktreeRequest,
  deriveWorktreePath,
  buildWorktreeAddArgs,
  chooseWorktreeAddSpec,
  planWorktreeBase,
  finalizeWorktreeBase,
  remoteTrackingTarget,
  parseGitDirPair,
  validateResolvedBase,
  badExplicitBaseError,
  parseWorktreeList,
  parsePorcelainStatus,
  worktreeRemovalBlock,
  resolveWorktreeRemovalPlan,
  classifyWorktreePlan,
  parseBranchRefs,
  canonicalWorktreeParentRepo,
  decideWorktreeInheritance,
  slugFromBranch,
  findExistingWorkForSlug,
  type BranchRef,
  type RemoteTrackingTarget,
  type WorktreeAddSpec,
  type WorktreeBasePlan,
  type WorktreeBaseProbes,
  type WorktreeListEntry,
  type WorktreeStatus,
  type WorktreePlanPreview,
  type WorktreePlanResult,
  type WorktreeProgress,
  type ExistingWorkMatch
} from './worktree-core'
import {
  resolveManifest,
  resolveWorktreeDir,
  buildSeedPlan,
  expandCommandTokens,
  disclosedWorktreeCommands,
  isSafeWorktreeTarget,
  classifyManifestFailure,
  WorktreeProvisionError,
  type ManifestSources,
  type ManifestFailureClassification,
  type ResolvedManifest,
  type SeedOp,
  type WorktreeProvisionStage
} from './worktree-manifest'
import { probeGitMeta } from './git-probe'
import {
  addUserProject,
  isUserProjectAgentAllowed,
  removeGhostFolder,
  resolveBornFrom,
  type RemoveGhostFolderResult
} from './user-projects'
import { readWorktreeInheritControl } from './mcp/worktree-inherit-prefs'

const runFile = promisify(execFile)

/** Hard wall-clock ceiling for any single `git`/`cp` invocation (ms). */
const GIT_TIMEOUT_MS = 30_000

/** Shared `execFile` options for read-only `git` probes (no shell, hard bounds). */
const GIT_OPTS = { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 } as const

/**
 * Ceiling for the ONE network call a create makes — the BUG-26 base fetch. Its own
 * budget because it crosses the network (a cold fetch on a slow link routinely beats
 * the 30 s local-git ceiling), and it is best-effort anyway: blowing the timeout
 * degrades to the on-disk remote-tracking ref, it never fails the create.
 */
const FETCH_TIMEOUT_MS = 60_000

/**
 * Budgets for author-supplied `setup`/`create` commands — these run real work
 * (`npm install`, `composer install`, DB migrations) that routinely blows past
 * the 30 s git ceiling and 1 MiB output cap, so reusing {@link GIT_TIMEOUT_MS}
 * would make the seed/setup path spuriously "fail" (and, pre-rollback-fix, orphan
 * a branch). Generous ceilings; streaming via `spawn` is the future refinement.
 */
const SETUP_TIMEOUT_MS = 10 * 60_000 // 10 min
const SETUP_MAX_BUFFER = 64 << 20 // 64 MiB

/** What the renderer is told when a freshly-created worktree is adopted. */
export interface AdoptedFolderPayload {
  /** Absolute on-disk path of the adopted worktree. */
  path: string
  /** Short branch name, when the probe resolved one (omitted if detached). */
  gitBranch?: string
  /** Realpath'd git common-dir; folders sharing it are one repo. */
  repoId?: string
  /** Whether the adopted folder owns the repo common-dir. */
  isMainWorktree?: boolean
  /**
   * T45 follow-up (T69 finding): reveal + focus the folder in the sidebar after
   * adoption. Set ONLY on the CLI-driven paths (`harnu .` cold-start / second-instance)
   * — the human explicitly asked to open this folder. NEVER set on the MCP
   * `adopt_folder` verb or a worktree create, so an agent can't steal the operator's
   * selection while they're typing elsewhere (T78).
   */
  select?: boolean
  /**
   * T191: the resolved `bornFrom` mother, when the create's origin passed both
   * recording guards (see {@link resolveBornFrom}). Absent when the create was
   * motherless (the New-worktree dialog) or a guard dropped the edge.
   */
  bornFrom?: string
}

/** The result of a successful {@link createWorktree}. */
export interface CreateWorktreeResult {
  /** Absolute path the worktree was created at. */
  path: string
  /** The commit-ish the worktree was actually cut from (BUG-12/T64 — echoed in the ACK). */
  base: string
  /** The branch/worktree name created (or the `ref` when checking out an existing branch). */
  branch: string
  /** The adoption payload sent to the renderer. */
  adopted: AdoptedFolderPayload
  /** Non-fatal manifest diagnostics (malformed front matter, skipped seeds, …). */
  warnings: string[]
  /** T191: echoes {@link AdoptedFolderPayload.bornFrom} — absent when motherless. */
  bornFrom?: string
  /**
   * BUG-40 §3.5 / BUG-50 absorbed: non-blocking — a branch or worktree already
   * embedding this create's slug. Omitted (never an empty array) when nothing
   * matched.
   */
  existingWork?: ExistingWorkMatch[]
  /**
   * BUG-62: the resolved repo root {@link rollbackWorktree} needs — a caller
   * that discovers a failure AFTER this create already returned (e.g. the
   * manifest drain's spawn) can roll back with the SAME helper the seed/setup/
   * adopt catches above use, instead of growing a third copy of this logic.
   */
  repoRoot: string
  /**
   * The branch {@link rollbackWorktree} is allowed to delete — `null` for a
   * `ref` checkout or a delegated `create:` (mirrors the internal `createdBranch`
   * this function already tracks; see its doc comment above).
   */
  createdBranch: string | null
}

/** Pull a verbatim `stderr` (or message) off an `execFile` rejection. */
function gitError(err: unknown): Error {
  const e = err as { stderr?: string | Buffer; message?: string }
  const stderr = e?.stderr ? String(e.stderr).trim() : ''
  return new Error(stderr || e?.message || 'git command failed')
}

/**
 * Probe the new worktree's git metadata, persist it as a pinned user project, and
 * notify the renderer via `folders:adopted` so the sidebar picks it up without a
 * full rescan.
 *
 * Born AGENT-REACHABLE. The old `agentAllowed: false` stamp ("fail-closed on a
 * freshly created folder") is gone with the allowlist: a new worktree/folder writes
 * NEITHER agent field, and absent = allowed. This is the write half of the
 * free-by-default reversal — it is what makes an agent's own `create_worktree` →
 * `create_session` chain work in one hop instead of dead-ending on a folder the
 * agent just created and cannot act in. Blocking is the explicit opposite move
 * (`agentDenied`, from the folder menu).
 *
 * @param getWindow - resolves the main window (or `null`).
 * @param worktreePath - absolute path of the created worktree.
 * @returns the payload that was broadcast to the renderer.
 */
export async function adoptFolder(
  getWindow: () => BrowserWindow | null,
  worktreePath: string,
  opts?: { inheritAgentControl?: boolean; select?: boolean; origin?: string }
): Promise<AdoptedFolderPayload> {
  const git = await probeGitMeta(worktreePath)
  // T191: guarded lineage edge — only when an origin was passed (never on the
  // MCP `adopt_folder` verb or a New-worktree dialog create).
  const bornFrom = opts?.origin
    ? await resolveBornFrom(opts.origin, { repoId: git.repoId })
    : undefined
  await addUserProject({
    path: worktreePath,
    alias: basename(worktreePath),
    addedAt: new Date().toISOString(),
    worktrees: [],
    // T61 birth marker — vestigial provenance now (see setUserProjectInheritAgentControl).
    ...(opts?.inheritAgentControl ? { inheritAgentControl: true } : {}),
    ...(bornFrom ? { bornFrom } : {}),
    ...(git.gitBranch !== undefined ? { gitBranch: git.gitBranch } : {}),
    ...(git.repoId !== undefined ? { repoId: git.repoId } : {}),
    ...(git.isMainWorktree !== undefined ? { isMainWorktree: git.isMainWorktree } : {})
  })

  const payload: AdoptedFolderPayload = { path: worktreePath }
  if (git.gitBranch !== undefined) payload.gitBranch = git.gitBranch
  if (git.repoId !== undefined) payload.repoId = git.repoId
  if (git.isMainWorktree !== undefined) payload.isMainWorktree = git.isMainWorktree
  if (bornFrom) payload.bornFrom = bornFrom
  // CLI-only reveal intent — see AdoptedFolderPayload.select.
  if (opts?.select) payload.select = true

  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('folders:adopted', payload)
  return payload
}

/**
 * Pin an ALREADY-EXISTING folder into the sidebar (the MCP `adopt_folder` verb,
 * T34). Unlike {@link createWorktree} nothing is created on disk: it validates
 * the path is an existing directory, then reuses {@link adoptFolder} to persist
 * it as a pinned user project (agent-reachable on birth, like every folder) and
 * broadcast `folders:adopted` so the sidebar picks it up without a rescan.
 * Idempotent — `addUserProject` dedupes by normalized path.
 * Throws when the path is missing or not a directory (the MCP shell audits it).
 */
export async function adoptExistingFolder(
  folderPath: string,
  opts?: { select?: boolean }
): Promise<AdoptedFolderPayload> {
  let isDir = false
  try {
    isDir = (await stat(folderPath)).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw new Error(`not an existing directory: ${folderPath}`)
  // `select` is threaded through ONLY on the CLI path (index.ts); the MCP
  // `adopt_folder` caller passes nothing → no reveal (never steal selection).
  return adoptFolder(getWindowRef, folderPath, opts?.select ? { select: true } : undefined)
}

/**
 * BUG-56 — the `remove_folder` MCP verb's entry point: reuses the same window
 * resolver `adoptExistingFolder`/`createWorktree` already close over, so the
 * verb can emit `folders:removed` without its own resolver plumbing.
 */
export async function removeGhostFolderFromSidebar(
  folderPath: string
): Promise<RemoveGhostFolderResult> {
  return removeGhostFolder(getWindowRef, folderPath)
}

/** Whether a path exists on disk (any type). */
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Read a UTF-8 file, or `null` when it does not exist / cannot be read. */
async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * Resolve the main worktree root for `repoPath` via `git --git-common-dir` (spec:
 * the manifest is resolved at the repo root, "never the clicked linked-worktree").
 * Falls back to `repoPath` if git can't answer.
 */
async function resolveRepoRoot(repoPath: string): Promise<string> {
  try {
    const { stdout } = await runFile('git', ['-C', repoPath, 'rev-parse', '--git-common-dir'], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20
    })
    const raw = stdout.trim()
    if (!raw) return repoPath
    // `--git-common-dir` may return a path relative to repoPath (older git, no
    // `--path-format`); resolve it. `<root>/.git` → `<root>` (the main worktree,
    // shared by every linked worktree). A non-`.git` common-dir (bare repo,
    // submodule gitdir, GIT_DIR override) has no obvious working tree → repoPath.
    const commonDir = isAbsolute(raw) ? raw : resolve(repoPath, raw)
    return basename(commonDir) === '.git' ? dirname(commonDir) : repoPath
  } catch {
    return repoPath
  }
}

/**
 * Read the manifest candidate files off disk (this is the I/O the pure
 * {@link resolveManifest} deliberately avoids). Missing files come back as
 * `null`; `hasEnvFile` drives the built-in default `seed.copy`.
 *
 * Exported for the Reaper's dehydrate/rehydrate (T250), which must read the
 * SAME manifest `create_worktree` provisions from — a second reader is how the
 * `ephemeral:`/`setup` a row discloses could drift from what actually runs.
 */
export async function readManifestSources(repoRoot: string): Promise<ManifestSources> {
  const [worktreeMd, aliasMd, localMd, claudeWorktreeMd, legacyConfigJson, hasEnvFile] =
    await Promise.all([
      readFileOrNull(join(repoRoot, 'WORKTREE.md')),
      readFileOrNull(join(repoRoot, 'worktree-manifest.md')),
      readFileOrNull(join(repoRoot, 'WORKTREE.local.md')),
      readFileOrNull(join(repoRoot, '.claude', 'worktree.md')),
      readFileOrNull(join(repoRoot, 'bin', 'worktree', 'worktree.config.json')),
      fileExists(join(repoRoot, '.env'))
    ])
  return {
    worktreeMd: worktreeMd ?? aliasMd,
    localMd,
    claudeWorktreeMd,
    legacyConfigJson,
    hasEnvFile
  }
}

/** Injectable seams for {@link applySeedPlan} (BUG-29 — no real subprocess/fs.cp in tests). */
export interface SeedRunnerDeps {
  runFile: (
    file: string,
    args: string[],
    opts: { windowsHide: boolean; timeout: number; maxBuffer: number; env: Record<string, string> }
  ) => Promise<{ stdout: string; stderr: string }>
  /** Node's `fs.cp` (recursive, cross-platform, no subprocess) — D4. */
  fsCp: (from: string, to: string) => Promise<void>
  platform: () => NodeJS.Platform
}

const defaultSeedRunnerDeps: SeedRunnerDeps = {
  runFile,
  fsCp: (from, to) =>
    cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }),
  platform
}

/**
 * Apply a seed plan: `copy` = `fs.cp` (recursive, cross-platform — D4), with
 * `cp --reflink=auto` tried FIRST on Linux as a fast path (falls back to `fs.cp`
 * on any failure, e.g. a missing `cp` binary); `link` = an absolute symlink. A
 * missing source is a non-fatal skip (recorded in `warnings`) so a manifest
 * listing an optional path can't abort the create; any OTHER failure propagates
 * to trigger rollback.
 */
export async function applySeedPlan(
  ops: SeedOp[],
  warnings: string[],
  deps: SeedRunnerDeps = defaultSeedRunnerDeps
): Promise<void> {
  for (const op of ops) {
    // `lstat`, not `access`: detect the entry regardless of its symlink target (a
    // committed *dangling* symlink is still a valid `cp -a` source) and treat ONLY
    // ENOENT as "skip". A permission error must surface, not masquerade as absent.
    try {
      await lstat(op.from)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        warnings.push(`seed.${op.kind}: "${op.entry}" not found in repo; skipped`)
        continue
      }
      throw err
    }
    await mkdir(dirname(op.to), { recursive: true })
    // Replace an existing dest — if `entry` is tracked, `git worktree add` already
    // checked it out, so `symlink` would EEXIST and `cp` of a dir would nest it
    // (`<wt>/vendor/vendor`). The manifest author's seeded copy is authoritative.
    await rm(op.to, { recursive: true, force: true })
    if (op.kind === 'copy') {
      if (deps.platform() === 'linux') {
        try {
          await deps.runFile('cp', ['-a', '--reflink=auto', op.from, op.to], {
            windowsHide: true,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 1 << 20,
            // Sanitized env (BUG-27): inside an AppImage the inherited LD_LIBRARY_PATH
            // points into the squashfs mount, so a system binary can load Harnu's
            // bundled glibc instead of the host's.
            env: await spawnEnv()
          })
          continue
        } catch {
          // `cp` missing or the reflink fast path failed — fall back to fs.cp (D4).
        }
      }
      await deps.fsCp(op.from, op.to)
    } else {
      await symlink(op.from, op.to)
    }
  }
}

/**
 * A classified manifest-command failure (BUG-28) — {@link runManifestCommand}
 * throws this instead of the flattened `gitError(err)` so `createWorktree`'s
 * catch can build a {@link WorktreeProvisionError} without re-parsing `stderr`.
 * Internal to `worktree-ipc.ts`; not part of the public seam.
 */
export class ManifestCommandFailure extends Error {
  readonly cmd: string
  readonly classification: ManifestFailureClassification
  readonly rawStderr: string
  constructor(cmd: string, classification: ManifestFailureClassification, rawStderr: string) {
    super(rawStderr || `command failed: ${cmd}`)
    this.name = 'ManifestCommandFailure'
    this.cmd = cmd
    this.classification = classification
    this.rawStderr = rawStderr
  }
}

/** Injectable seams for {@link runManifestCommand} (BUG-29 — no real subprocess in tests). */
export interface ManifestCommandDeps {
  runFile: (
    file: string,
    args: string[],
    opts: {
      cwd: string
      windowsHide: boolean
      timeout: number
      maxBuffer: number
      env: Record<string, string>
    }
  ) => Promise<{ stdout: string; stderr: string }>
  resolvePosixShell: () => Promise<string | null>
  platform: () => NodeJS.Platform
}

const defaultManifestCommandDeps: ManifestCommandDeps = { runFile, resolvePosixShell, platform }

/**
 * Run a trusted manifest command string (a `setup` step or a delegated
 * `create`/`remove`) in `cwd`. Unlike the git calls, these ARE arbitrary
 * commands the repo author committed to `WORKTREE.md` (trusted content, never
 * agent-supplied). On the MCP path the create confirm discloses these verbatim
 * before the operator approves (see `previewWorktreeCommands` /
 * `buildConfirmDisclosure`, T08); on the UI path the operator initiated the
 * create directly. A shell is intentional. Surfaces stderr verbatim on failure.
 *
 * BUG-29/ADR-0005 D1: the command is a POSIX-shell string on every platform —
 * POSIX runs it via `sh -c` (unchanged); Windows has no `sh`, so it resolves a
 * real POSIX shell (Git Bash) via {@link resolvePosixShell} instead. Callers
 * that actually need one MUST have already passed {@link assertPosixShellAvailable}
 * (the D3 pre-flight, run once before any mutation) — this function still
 * throws {@link posixShellRequirementError} defensively if that invariant is
 * ever violated, rather than spawn a nonexistent `sh`.
 *
 * BUG-28: a failure is classified ({@link classifyManifestFailure}) and thrown
 * as a {@link ManifestCommandFailure} — never the flattened `gitError(err)` —
 * so the caller (`createWorktree`'s seed/setup loop) can name the missing
 * binary instead of just echoing raw `stderr`.
 */
export async function runManifestCommand(
  cmd: string,
  cwd: string,
  deps: ManifestCommandDeps = defaultManifestCommandDeps
): Promise<void> {
  let shellBin = 'sh'
  if (deps.platform() === 'win32') {
    const posixShell = await deps.resolvePosixShell()
    if (!posixShell) throw posixShellRequirementError()
    shellBin = posixShell
  }
  try {
    await deps.runFile(shellBin, ['-c', cmd], {
      cwd,
      windowsHide: true,
      timeout: SETUP_TIMEOUT_MS,
      maxBuffer: SETUP_MAX_BUFFER,
      // BUG-27: without this the command inherits Harnu's own env. A GUI-launched
      // app never sourced the user's shell config, so its PATH has no mise/nvm/
      // Homebrew node — `npm ci` died with `npm: not found` and the create rolled
      // back. Same env the PTY sessions get (which is why THEY always found node).
      env: await spawnEnv()
    })
  } catch (err) {
    const e = err as { code?: number | string | null; signal?: string | null; killed?: boolean }
    const stderr = gitError(err).message
    const classification = classifyManifestFailure(
      { code: e?.code ?? null, signal: e?.signal ?? null, killed: e?.killed === true, stderr },
      cmd
    )
    throw new ManifestCommandFailure(cmd, classification, stderr)
  }
}

/**
 * Whether a resolved manifest will run ANY shell command at all — a non-empty
 * `setup` list, or a delegated `create` (which owns the flow via
 * {@link runManifestCommand}, same as `remove`). Gates the ADR-0005 D3
 * pre-flight ({@link assertPosixShellAvailable}): a repo with no setup/create
 * command needs no shell, so Windows never gains a Git Bash requirement it
 * wouldn't otherwise have.
 */
export function manifestNeedsPosixShell(
  manifest: Pick<ResolvedManifest, 'setup' | 'create'>
): boolean {
  return manifest.setup.length > 0 || manifest.create !== undefined
}

/** Injectable seams for {@link assertPosixShellAvailable} (BUG-29). */
export interface PosixShellPreflightDeps {
  platform: () => NodeJS.Platform
  resolvePosixShell: () => Promise<string | null>
}

const defaultPosixShellPreflightDeps: PosixShellPreflightDeps = { platform, resolvePosixShell }

/**
 * ADR-0005 D3 pre-flight: when the manifest will actually run a shell command
 * on Windows, resolve a POSIX shell BEFORE any mutation — before `git worktree
 * add` or a delegated `create:` runs. No shell resolvable ⇒ fail loudly here,
 * naming Git Bash and the `CAPY_POSIX_SHELL` escape hatch, so nothing is
 * created and nothing needs rolling back (unlike letting `runManifestCommand`
 * ENOENT mid-provision, which triggers {@link rollbackWorktree}).
 */
export async function assertPosixShellAvailable(
  needsPosixShell: boolean,
  deps: PosixShellPreflightDeps = defaultPosixShellPreflightDeps
): Promise<void> {
  if (!needsPosixShell) return
  if (deps.platform() !== 'win32') return
  const shell = await deps.resolvePosixShell()
  if (!shell) throw posixShellRequirementError()
}

/**
 * The environment for a manifest command / seed subprocess: Harnu's own env,
 * sanitized of AppImage pollution, with the user's login-shell PATH folded in
 * (BUG-27). The login PATH is captured at most once per app run.
 */
async function spawnEnv(): Promise<Record<string, string>> {
  return spawnEnvOnce()
}

/** What a {@link rollbackWorktree} attempt actually undid (BUG-28 — observed, not assumed). */
export interface RollbackResult {
  /** `true` when `git worktree remove` succeeded (the checkout is gone). */
  rolledBack: boolean
  /** The branch name actually deleted, or `null` (none attempted, or the delete failed). */
  branchDeleted: string | null
}

/** Injectable seam for {@link rollbackWorktree} (BUG-28 — no real subprocess in tests). */
export interface RollbackDeps {
  runFile: (
    file: string,
    args: string[],
    opts: { windowsHide: boolean; timeout: number; maxBuffer: number }
  ) => Promise<{ stdout: string; stderr: string }>
}

const defaultRollbackDeps: RollbackDeps = { runFile }

/**
 * Best-effort rollback of a half-provisioned worktree. `git worktree remove
 * --force` deletes the checkout but NOT the branch that `add -b` created, so a
 * naive rollback leaves a zombie branch and every retry of the same create dies
 * on "a branch named X already exists". We therefore also `branch -D` it. Safe:
 * rollback is reached ONLY from the seed/setup catch, i.e. AFTER a successful
 * `-b` add — so the branch we delete is always one we just created, never a
 * pre-existing one (the add-failure path throws without rolling back).
 *
 * BUG-28: returns what it ACTUALLY undid — a caller that swallowed this return
 * value used to leave the provisioning error as the only signal, so a rollback
 * that itself failed (the checkout may still be on disk) was silently
 * indistinguishable from a clean one. `rolledBack: false` is exactly that
 * half-state, surfaced rather than hidden.
 */
export async function rollbackWorktree(
  repoRoot: string,
  target: string,
  createdBranch: string | null,
  deps: RollbackDeps = defaultRollbackDeps
): Promise<RollbackResult> {
  let rolledBack = false
  try {
    await deps.runFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', target], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20
    })
    rolledBack = true
  } catch {
    // The worktree may never have been added, or the remove itself failed;
    // either way the checkout may still be on disk — reported, not assumed.
  }
  // Only delete a branch WE created (`add -b`). A ref checkout (T44 S2:
  // existing-branch / detached) created no branch — deleting `createdBranch` there
  // could clobber a pre-existing branch, so skip it (createdBranch === null).
  if (createdBranch === null) return { rolledBack, branchDeleted: null }
  try {
    await deps.runFile('git', ['-C', repoRoot, 'branch', '-D', createdBranch], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20
    })
    return { rolledBack, branchDeleted: createdBranch }
  } catch {
    // Branch may not exist (never created / already gone). Swallow so the original
    // provisioning error is the one that surfaces.
    return { rolledBack, branchDeleted: null }
  }
}

/**
 * Recover a {@link ManifestFailureClassification} + verbatim stderr from
 * whatever a seed/setup/delegated-create step threw (BUG-28). Only a
 * {@link ManifestCommandFailure} — a REAL `sh -c` rejection — is ever
 * classified `binary-missing`/`timeout`; anything else (an `fs` error from
 * `applySeedPlan`'s copy/link, the delegated "did not produce the expected
 * worktree" check) is a different kind of failure entirely and always reports
 * `command-failed`, never a guessed binary name off an unrelated message.
 */
function classificationFromThrown(err: unknown): {
  classification: ManifestFailureClassification
  stderr?: string
} {
  if (err instanceof ManifestCommandFailure) {
    return { classification: err.classification, stderr: err.rawStderr || undefined }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { classification: { kind: 'command-failed' }, stderr: message }
}

/**
 * Assemble the structured {@link WorktreeProvisionError} for a seed/setup/
 * delegated-create failure (BUG-28), AFTER rollback has already run — so
 * `rolledBack`/`branchDeleted` are the caller's OBSERVED outcome, never
 * assumed. `path` (the resolved setup-shell PATH) is attached only for a
 * `binary-missing` classification, closing the BUG-27 disclosure loop.
 */
async function buildProvisionError(
  err: unknown,
  stageInfo: {
    stage: WorktreeProvisionStage
    step?: { index: number; total: number }
    command: string
  },
  rollback: RollbackResult
): Promise<WorktreeProvisionError> {
  const { classification, stderr } = classificationFromThrown(err)
  return new WorktreeProvisionError({
    stage: stageInfo.stage,
    ...(stageInfo.step ? { step: stageInfo.step } : {}),
    command: stageInfo.command,
    kind: classification.kind,
    ...(classification.binary ? { binary: classification.binary } : {}),
    ...(classification.kind === 'binary-missing' ? { path: (await spawnEnv()).PATH } : {}),
    ...(classification.exitCode !== undefined ? { exitCode: classification.exitCode } : {}),
    ...(stderr ? { stderr } : {}),
    rolledBack: rollback.rolledBack,
    branchDeleted: rollback.branchDeleted
  })
}

/**
 * Create a git worktree + branch for `repoPath`, provision it per the project's
 * `WORKTREE.md`, and adopt it. Flow:
 *
 * 1. Validate the agent-controlled `branch`/`baseRef` ({@link validateWorktreeRequest}
 *    — argv-injection gate) BEFORE any subprocess spawns.
 * 2. Resolve the manifest at the repo root ({@link resolveManifest}) → `dir`,
 *    `from` default, `seed`, `setup`, optional `create` delegation.
 * 3. Target path: the manifest `dir` when a source set one, else the legacy
 *    `<repoRoot>/.claude/worktrees/<slug>` (backward-compatible), guarded by
 *    {@link isSafeWorktreeTarget}.
 * 4. Either delegate to `create:` (which OWNS the flow; on failure the companion
 *    `remove:` is run best-effort), or `git worktree add` then apply `seed` +
 *    `setup` — with **transactional rollback**: any seed/setup failure removes the
 *    worktree AND deletes the branch `add -b` created, so a retry isn't poisoned.
 * 5. Adopt the finished worktree as a pinned folder.
 *
 * @param repoPath - absolute repo root the worktree belongs to.
 * @param branch - branch name to create.
 * @param baseRef - optional commit-ish to branch from (defaults to the manifest
 *   `from`, itself defaulting to `HEAD`).
 * @returns the created path, the adoption payload, and any manifest warnings.
 * @throws git's verbatim `stderr` on a failed add/seed/setup, or the validator's
 *   `reason` when the request is rejected.
 */
/** The read-only resolution shared by execute + disclose. */
interface WorktreePlan {
  repoRoot: string
  manifest: ResolvedManifest
  target: string
  base: string
  /** BUG-26: `base` is a remote-tracking ref Harnu chose implicitly → `git worktree add --no-track`. */
  noTrack: boolean
  tokens: { branch: string; from: string; repo: string }
  warnings: string[]
}

/**
 * Read-only resolution shared by `createWorktree` (execute) and
 * `previewWorktreeCommands` (disclose) so the operator confirm never diverges
 * from what actually runs (T08). Does NO git, NO fs mutation.
 *
 * NB (accepted TOCTOU): this is called once per path — once for the preview that
 * builds the confirm, then again when `createWorktree` runs seconds later. A
 * local `WORKTREE.md` edit in that window could make execution differ from the
 * disclosure. Low risk (trusted local content, brief window, operator watching);
 * threading the resolved plan preview→execute so it's read once is a follow-up.
 *
 * `fetch` (BUG-26) is the ONE asymmetry between the two callers: only the real create
 * hits the network to freshen the remote-tracking ref. The read-only preview/plan
 * paths resolve against the refs already on disk, so opening the New-worktree dialog
 * never fetches. Both still land on the same base STRING (`origin/main` is a name, not
 * a SHA), so the disclosure the operator confirms still matches what runs.
 */
async function resolveWorktreePlan(
  repoPath: string,
  branch: string,
  baseRef?: string,
  opts: { fetch?: boolean } = {}
): Promise<WorktreePlan> {
  const repoRoot = await resolveRepoRoot(repoPath)
  const sources = await readManifestSources(repoRoot)
  const manifest = resolveManifest(sources, { branch, repo: basename(repoRoot) })
  const warnings = [...manifest.warnings]

  // Target: honor an explicit manifest `dir`, else the legacy managed location
  // `<repoRoot>/.claude/worktrees/<slug>` (backward-compatible for repos without a
  // manifest; repoRoot === repoPath in the common main-worktree case). The agent
  // never supplies the path either way — it comes from the committed `dir` template
  // + the pre-validated branch.
  const target = manifest.dirExplicit
    ? resolveWorktreeDir(repoRoot, manifest.dir)
    : deriveWorktreePath(repoRoot, branch)

  // Footgun guard on the resolved target (repo root / inside .git / an ancestor).
  // Always checked, not only for manifest dirs — cheap defense in depth.
  if (!isSafeWorktreeTarget(repoRoot, target)) {
    throw new Error(`worktree target resolves to an unsafe path: ${target}`)
  }

  // BUG-26 (and BUG-12/T64 before it): decide the base a new branch is cut from.
  // `planWorktreeBase` picks the STRATEGY purely; `probeWorktreeBase` runs the git for
  // it; `finalizeWorktreeBase` turns the probes back into the base. See those doc
  // comments in `worktree-core` for why each implicit path is remote-resolved.
  const plan = planWorktreeBase(baseRef, manifest.from || 'HEAD', {
    folderIsPrimaryWorktree: await isPrimaryWorktree(repoPath)
  })
  const probes = await probeWorktreeBase(repoRoot, repoPath, plan, { fetch: opts.fetch === true })
  const resolved = finalizeWorktreeBase(plan, probes)
  if (resolved.warning) warnings.push(resolved.warning)
  const base = resolved.base

  // The manifest `from:` never passed a validator (only `baseRef` did), and the base lands
  // in the last argv slot of `git worktree add` — which reads a leading-dash positional as
  // a flag. Fail closed on whatever we resolved, whichever source it came from.
  const baseVerdict = validateResolvedBase(base)
  if (!baseVerdict.ok) throw new Error(baseVerdict.reason)

  // NB (BUG-26 follow-up): a delegated `create:` script receives this base as its `{from}`
  // token, which is now `origin/main` rather than a local name/SHA. A script that does the
  // obvious `git worktree add -b {branch} {dir} {from}` will therefore set the new branch's
  // upstream to `origin/main` — the same `push.default=simple` snag `--no-track` avoids on
  // the built-in path, which a delegated script has no way to opt out of today. Giving the
  // manifest a `{notrack}` token (or handing delegated scripts a resolved SHA) is the fix;
  // it is manifest-schema surface, so it is deliberately NOT bundled into this bug fix.
  const tokens = { branch, from: base, repo: basename(repoRoot) }
  return { repoRoot, manifest, target, base, noTrack: resolved.remoteTracked, tokens, warnings }
}

/**
 * Whether `folderPath` is the repo's PRIMARY worktree — the shared, mutable checkout
 * every other Harnu session in that folder also lives in, whose `HEAD` is therefore not
 * a base anyone can rely on (BUG-26). In the primary worktree `--git-dir` and
 * `--git-common-dir` name the same directory; in a linked worktree the former is
 * `<common>/worktrees/<name>`.
 *
 * No version-gated flags: see {@link parseGitDirPair} for why `--path-format=absolute`
 * (git ≥ 2.31) was a silent trap here. git may print either path RELATIVE to the folder,
 * so both are resolved against it before comparing.
 *
 * FAILS OPEN (unknown → `true`): if we cannot tell, the deterministic remote path is the
 * safer landing spot than falling back to the very `rev-parse HEAD` this bug is about.
 * (A repo git can't answer for is about to fail `worktree add` anyway.)
 */
async function isPrimaryWorktree(folderPath: string): Promise<boolean> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', folderPath, 'rev-parse', '--git-dir', '--git-common-dir'],
      GIT_OPTS
    )
    const pair = parseGitDirPair(stdout)
    if (!pair) return true
    return resolve(folderPath, pair.gitDir) === resolve(folderPath, pair.commonDir)
  } catch {
    return true
  }
}

/**
 * Run the git a {@link WorktreeBasePlan} needs (BUG-26). Thin: every call is read-only
 * except the `fetch`, every failure degrades to `null` so
 * {@link finalizeWorktreeBase} can fall back rather than break the create.
 *
 * The `explicit` plan touches git only to VERIFY the caller-named base (this card) —
 * unlike the implicit paths, a bad explicit base must fail the create, never degrade.
 */
async function probeWorktreeBase(
  repoRoot: string,
  folderPath: string,
  plan: WorktreeBasePlan,
  opts: { fetch: boolean }
): Promise<WorktreeBaseProbes> {
  if (plan.kind === 'explicit') {
    // Reject an argv-injection-shaped base (leading `-`, unsafe chars) BEFORE it
    // reaches a git subprocess — `resolveWorktreePlan` re-validates the resolved base
    // downstream too, but that runs AFTER this probe, and this probe (unlike the
    // other plan kinds) hands the agent-supplied string straight to git.
    const verdict = validateResolvedBase(plan.base)
    if (!verdict.ok) throw new Error(verdict.reason)
    if (!(await verifyRef(repoRoot, plan.base))) {
      throw new Error(badExplicitBaseError(plan.base))
    }
    return {
      remoteRef: null,
      folderHead: null,
      explicitBehindRemote: await explicitBaseBehindRemote(repoRoot, plan.base)
    }
  }
  if (plan.kind === 'folder-head') {
    return { remoteRef: null, folderHead: await resolveFolderHead(folderPath) }
  }

  const remotes = await listGitRemotes(repoRoot)
  // `origin` by convention, but a repo whose only remote is named otherwise (a fork set
  // up as `upstream`) must still resolve remotely rather than silently degrade.
  const primaryRemote = remotes.includes('origin') ? 'origin' : remotes[0]
  const name =
    plan.kind === 'named' ? plan.name : await remoteDefaultBranchName(repoRoot, primaryRemote)
  const target = name ? remoteTrackingTarget(name, remotes, primaryRemote) : null

  let remoteRef: string | null = null
  if (target) {
    if (opts.fetch) await fetchRemoteBranch(repoRoot, target)
    remoteRef = (await verifyRef(repoRoot, target.trackingRef)) ? target.trackingRef : null
  }

  if (plan.kind === 'named') return { remoteRef, folderHead: null }

  // `remote-default` only. Without a remote ref the folder HEAD is the degraded fallback;
  // WITH one we still read the folder's branch, purely so `finalizeWorktreeBase` can warn
  // when we're about to branch off `origin/main` from a checkout sitting on `develop`.
  return remoteRef
    ? { remoteRef, folderHead: null, folderBranch: await currentBranch(folderPath) }
    : { remoteRef, folderHead: await resolveFolderHead(folderPath) }
}

/**
 * The repo's configured remotes (`git remote`), or `[]` when it has none / git failed.
 * A remote whose NAME starts with `-` is dropped: the name reaches `git fetch`'s argv,
 * and `.git/config` is attacker-writable in a repo the user merely opened.
 */
async function listGitRemotes(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await runFile('git', ['-C', repoRoot, 'remote'], GIT_OPTS)
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('-'))
  } catch {
    return []
  }
}

/**
 * The default branch on the remote, as a bare name (`main`). Read from the
 * `<remote>/HEAD` symbolic ref git records at clone time; when that was never set, fall
 * back to the conventional names in order. That fallback is NOT theoretical — this very
 * repo has no `refs/remotes/origin/HEAD` (it is set at clone time and plenty of repos
 * never get one), so the symbolic-ref read fails and `main` is found by convention.
 * Returns `null` when the repo has no remote or nothing resolves — the caller then
 * degrades with a warning.
 */
async function remoteDefaultBranchName(
  repoRoot: string,
  remote: string | undefined
): Promise<string | null> {
  if (!remote) return null

  try {
    const { stdout } = await runFile(
      'git',
      ['-C', repoRoot, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`],
      GIT_OPTS
    )
    // `origin/main` → `main`
    const short = stdout.trim()
    const stripped = short.startsWith(`${remote}/`) ? short.slice(remote.length + 1) : ''
    if (stripped) return stripped
  } catch {
    /* never set — fall through to the conventional names */
  }

  for (const candidate of ['main', 'master']) {
    if (await verifyRef(repoRoot, `${remote}/${candidate}`)) return candidate
  }
  return null
}

/**
 * Freshen ONE remote-tracking ref (BUG-26). Best-effort: an offline machine, a
 * credential prompt, or a branch that no longer exists on the remote must not fail the
 * create — the caller falls back to whatever ref is already on disk (still far more
 * deterministic than a shared `rev-parse HEAD`) and warns.
 *
 * The refspec is written out explicitly (`+refs/heads/x:refs/remotes/origin/x`) so the
 * tracking ref updates even in a repo whose remote has no fetch refspec configured.
 * `--no-tags` keeps a routine create from dragging in the whole tag namespace. `branch`
 * is spliced mid-string into the refspec and `remote` is gated by {@link listGitRemotes},
 * so — with `execFile`, no shell — neither can be read as a flag.
 *
 * NON-INTERACTIVE, hard requirement: a private remote with no cached credential (or an
 * SSH key with a passphrase and no agent) would otherwise make git PROMPT — blocking the
 * create for the full timeout when Harnu was launched from a terminal, or popping an
 * askpass dialog the operator never asked for. A create must never stall on a network
 * nicety, so every prompt path is disabled and a failure just degrades to the on-disk ref.
 */
async function fetchRemoteBranch(repoRoot: string, target: RemoteTrackingTarget): Promise<void> {
  try {
    await runFile(
      'git',
      [
        '-C',
        repoRoot,
        'fetch',
        '--quiet',
        '--no-tags',
        target.remote,
        `+refs/heads/${target.branch}:refs/remotes/${target.remote}/${target.branch}`
      ],
      {
        windowsHide: true,
        timeout: FETCH_TIMEOUT_MS,
        maxBuffer: 1 << 20,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GIT_SSH_COMMAND: 'ssh -oBatchMode=yes'
        }
      }
    )
  } catch {
    /* offline / no such branch / no credential — degrade to the on-disk ref */
  }
}

/** Whether `ref` resolves in this repo (`rev-parse --verify --quiet <ref>^{commit}`). */
async function verifyRef(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runFile(
      'git',
      ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      GIT_OPTS
    )
    return true
  } catch {
    return false
  }
}

/**
 * How far an explicit LOCAL base trails its remote-tracking counterpart, or `null`
 * when it has none (a remote ref, a SHA, or a branch with no upstream configured) or
 * is already caught up. Read-only, never throws — this feeds a warning
 * ({@link finalizeWorktreeBase}'s `explicit` case), never a refusal.
 */
async function explicitBaseBehindRemote(
  repoRoot: string,
  base: string
): Promise<{ aheadCount: number; upstream: string } | null> {
  let upstream: string
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', repoRoot, 'rev-parse', '--abbrev-ref', `${base}@{upstream}`],
      GIT_OPTS
    )
    upstream = stdout.trim()
    if (!upstream) return null
  } catch {
    return null // no upstream configured (or base isn't a local branch) — nothing to compare
  }
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', repoRoot, 'rev-list', '--count', `${base}..${upstream}`],
      GIT_OPTS
    )
    const aheadCount = Number.parseInt(stdout.trim(), 10)
    return aheadCount > 0 ? { aheadCount, upstream } : null
  } catch {
    return null
  }
}

/**
 * The passed folder's current commit (`git -C <folder> rev-parse HEAD`), or null
 * on a commit-less repo / rev-parse failure (the caller then keeps the 'HEAD'
 * sentinel). Read-only. BUG-12/T64 — see {@link planWorktreeBase}.
 */
async function resolveFolderHead(folderPath: string): Promise<string | null> {
  try {
    const { stdout } = await runFile('git', ['-C', folderPath, 'rev-parse', 'HEAD'], GIT_OPTS)
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Resolve (read-only) the `WORKTREE.md` shell commands a `create_worktree` WOULD
 * run, for the operator confirm disclosure (T08). No git, no fs mutation. Never
 * throws — a resolution failure yields empty commands + a warning, mirroring the
 * "malformed manifest never crashes create" rule.
 */
export async function previewWorktreeCommands(
  repoPath: string,
  branch: string,
  baseRef?: string
): Promise<{
  target: string
  delegated: boolean
  commands: string[]
  removeOnFailure?: string
  warnings: string[]
}> {
  try {
    const plan = await resolveWorktreePlan(repoPath, branch, baseRef)
    const d = disclosedWorktreeCommands(plan.manifest, plan.tokens)
    return {
      target: plan.target,
      delegated: d.delegated,
      commands: d.commands,
      ...(d.removeOnFailure ? { removeOnFailure: d.removeOnFailure } : {}),
      warnings: plan.warnings
    }
  } catch (err) {
    return {
      target: '',
      delegated: false,
      commands: [],
      warnings: [`could not resolve WORKTREE.md for disclosure: ${(err as Error).message}`]
    }
  }
}

/** Whether `branch` is already checked out in another worktree of this repo (AC6). */
async function branchCheckedOutElsewhere(repoRoot: string, branch: string): Promise<string | null> {
  try {
    const hit = (await listWorktrees(repoRoot)).find((e) => e.branch === branch)
    return hit ? hit.path : null
  } catch {
    return null // a failed `worktree list` shouldn't block the plan on this check
  }
}

/** Whether the repo has at least one commit (`rev-parse --verify HEAD`). */
async function repoHasCommits(repoRoot: string): Promise<boolean> {
  try {
    await runFile('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20
    })
    return true
  } catch {
    return false
  }
}

/**
 * Read-only dry-run for the New-worktree dialog (T32/AC5): resolve the plan the
 * exact way {@link createWorktree} does ({@link resolveWorktreePlan}) + the AC6
 * pre-checks, WITHOUT mutating the filesystem. Returns a {@link WorktreePlanResult}
 * (a preview or a typed error) — never throws to the caller. The disclosed
 * `commands` are the same trusted `sh -c` payloads the create will run, so the
 * dialog can show them before the operator confirms.
 */
export async function planWorktree(
  repoPath: string,
  branch: string,
  baseRef?: string,
  ref?: string
): Promise<WorktreePlanResult> {
  const verdict = validateWorktreeRequest({ root: repoPath, branch, baseRef, ref })
  if (!verdict.ok) return { error: 'invalid-request', reason: verdict.reason }

  let resolved: WorktreePlan
  try {
    resolved = await resolveWorktreePlan(repoPath, branch, baseRef)
  } catch (err) {
    const msg = (err as Error).message
    // resolveWorktreePlan's only throw is the unsafe-target guard; anything else
    // is a repo-root / manifest read failure.
    if (/unsafe path/i.test(msg)) {
      return { error: 'unsafe-target', path: msg.split('unsafe path:').pop()?.trim() ?? '' }
    }
    return { error: 'invalid-request', reason: msg }
  }

  const disclosed = disclosedWorktreeCommands(resolved.manifest, resolved.tokens)

  // T44 S2 (UI): when `ref` is set the worktree CHECKS OUT an existing branch (the
  // PR-review flow) instead of cutting a new one. Mirror `chooseWorktreeAddSpec`:
  // a delegated `create:` still wins; otherwise a ref that's already checked out in
  // another worktree DETACHES at its commit (a branch can't be checked out twice),
  // else it DWIMs the local/remote branch. The seed/setup commands run either way.
  const trimmedRef = ref?.trim()
  let mode: WorktreePlanPreview['mode']
  if (resolved.manifest.create !== undefined) {
    mode = 'delegated-create'
  } else if (trimmedRef) {
    const refElsewhere = (await branchCheckedOutElsewhere(resolved.repoRoot, trimmedRef)) !== null
    mode = refElsewhere ? 'detached' : 'existing-branch'
  } else {
    mode = 'new-branch'
  }

  const preview: WorktreePlanPreview = {
    targetPath: resolved.target,
    branch,
    // In a ref checkout the "base" shown IS the ref being checked out.
    baseRef: trimmedRef || resolved.base,
    mode,
    source: resolved.manifest.source,
    seed: { copy: [...resolved.manifest.seed.copy], link: [...resolved.manifest.seed.link] },
    commands: disclosed.commands,
    warnings: resolved.warnings
  }

  const [targetExists, checkedOutWorktree, hasCommits] = await Promise.all([
    fileExists(resolved.target),
    // Only a NEW-branch create is blocked by `branch` being checked out elsewhere.
    // A ref checkout that's checked out elsewhere DETACHES (handled above), so it
    // must not surface as a `branch-checked-out` error.
    trimmedRef ? Promise.resolve(null) : branchCheckedOutElsewhere(resolved.repoRoot, branch),
    repoHasCommits(resolved.repoRoot)
  ])
  return classifyWorktreePlan(preview, { targetExists, checkedOutWorktree, hasCommits })
}

export async function createWorktree(
  repoPath: string,
  branch: string,
  baseRef?: string,
  ref?: string,
  onProgress?: (ev: WorktreeProgress) => void,
  opts?: {
    /**
     * T61: present ONLY for creates made through a DISCLOSED human surface (the
     * `create_worktree` confirm or the New-worktree dialog) — never the
     * mission-grant auto-actuation path (which uses `dynamicFolders` and must
     * not silently mark inheritance). When present, the new worktree is born
     * inheriting its parent repo's agent control, gated by
     * {@link decideWorktreeInheritance} (global opt-in ON + canonical parent
     * repo agent-allowed + the human did not `optedOut`).
     */
    inherit?: { optedOut: boolean }
    /**
     * T191: absolute path of the folder whose session asked for this worktree
     * to be cut — the orchestrator. Passed by the MCP `create_worktree` handler
     * (`ctx.folder`) and the manifest drain (its own `folder`); independent of
     * `inherit`, so it is threaded through regardless of whether this create
     * also offers agent-control inheritance. The New-worktree UI dialog passes
     * nothing — a human-cut worktree is deliberately motherless.
     */
    origin?: string
  }
): Promise<CreateWorktreeResult> {
  // Emit a stage boundary; a misbehaving listener must never break a create.
  const emit = (stage: WorktreeProgress['stage'], detail?: string): void => {
    try {
      onProgress?.(detail !== undefined ? { stage, detail } : { stage })
    } catch {
      /* swallow — progress is best-effort UI feedback */
    }
  }

  const verdict = validateWorktreeRequest({ root: repoPath, branch, baseRef, ref })
  if (!verdict.ok) throw new Error(verdict.reason)

  emit('resolve')
  // BUG-26: the create — and ONLY the create — fetches, so the base is resolved against
  // the remote's current state rather than a remote-tracking ref that last moved days ago.
  // Skipped when `ref` is set: that create CHECKS OUT an existing ref and discards `base`
  // entirely, so fetching for it would be a network round-trip bought for nothing.
  const { repoRoot, manifest, target, base, noTrack, tokens, warnings } = await resolveWorktreePlan(
    repoPath,
    branch,
    baseRef,
    { fetch: !ref?.trim() }
  )

  // BUG-29/ADR-0005 D3: fail loudly on Windows BEFORE any mutation, when this
  // manifest will actually run a shell command (setup steps or a delegated
  // create) and no POSIX shell is resolvable — never a bare `spawn sh ENOENT`
  // after `git worktree add` already ran.
  await assertPosixShellAvailable(manifestNeedsPosixShell(manifest))

  // BUG-40 §3.5 / BUG-50 absorbed: cheap, non-blocking pre-flight — before the
  // target exists on disk (so it can never self-match), does ANOTHER branch or
  // worktree already embed this create's slug? Warn only; never blocks the
  // create (see `findExistingWorkForSlug`'s doc comment for why).
  const slug = slugFromBranch(branch)
  const [existingBranches, existingWorktrees] = await Promise.all([
    listBranches(repoRoot),
    listWorktrees(repoRoot)
  ])
  const existingWork = findExistingWorkForSlug(slug, existingBranches, existingWorktrees, branch)

  // BUG-40 §3.3: which branch the adopt-stage catch below is allowed to delete
  // on rollback. Only a branch WE created (`new-branch`) is ever eligible — a
  // delegated `create:` script owns its own branch lifecycle (unknown to us
  // here), and a `ref` checkout created nothing to delete.
  let createdBranch: string | null = null

  if (manifest.create) {
    // Delegation escape hatch: the project's own script OWNS create + provision
    // (spec §create/remove); we run neither worktree-add nor seed/setup. On
    // failure, hand back to the companion `remove:` (best-effort) so a partially
    // provisioned fleet isn't orphaned, then verify the script actually produced
    // `target` before adopting — otherwise we'd pin a folder that doesn't exist.
    const createCmd = expandCommandTokens(manifest.create, tokens)
    try {
      emit('worktree-add', 'delegated create')
      await runManifestCommand(createCmd, repoRoot)
      if (!(await fileExists(target))) {
        throw new Error(
          `delegated "create" did not produce the expected worktree at ${target}; ` +
            'the script must honor the manifest "dir"'
        )
      }
    } catch (err) {
      // BUG-28: the companion `remove:` IS this branch's rollback — Harnu created
      // no branch here (the script owns the whole flow), so `branchDeleted` stays
      // `null` and `rolledBack` reflects only whether `remove:` actually ran.
      let rolledBack = false
      if (manifest.remove) {
        rolledBack = await runManifestCommand(
          expandCommandTokens(manifest.remove, tokens),
          repoRoot
        )
          .then(() => true)
          .catch(() => false)
      }
      throw await buildProvisionError(
        err,
        { stage: 'delegated-create', command: createCmd },
        {
          rolledBack,
          branchDeleted: null
        }
      )
    }
  } else {
    emit('worktree-add')
    // T44 S2: when `ref` is given, check out the existing ref (detached if it's
    // already checked out in another worktree) instead of branching from `base`.
    const refCheckedOutElsewhere =
      ref && ref.trim() ? (await branchCheckedOutElsewhere(repoRoot, ref.trim())) !== null : false
    const spec: WorktreeAddSpec = chooseWorktreeAddSpec({
      branch,
      path: target,
      base,
      ref,
      refCheckedOutElsewhere,
      noTrack
    })
    createdBranch = spec.kind === 'new-branch' ? branch : null
    try {
      await runFile('git', ['-C', repoRoot, ...buildWorktreeAddArgs(spec)], {
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1 << 20
      })
    } catch (err) {
      throw gitError(err)
    }

    // BUG-28: tracks which setup command (1-based) is in flight, so a failure's
    // catch can report the exact failing step. `0` means the failure happened
    // during `seed` (before any setup command ran).
    let setupStepIndex = 0
    try {
      emit('seed')
      await applySeedPlan(
        buildSeedPlan(manifest.seed, { repoRoot, worktreePath: target }),
        warnings
      )
      if (manifest.setup.length > 0) emit('setup')
      for (let i = 0; i < manifest.setup.length; i++) {
        setupStepIndex = i + 1
        emit('setup', `${i + 1}/${manifest.setup.length}`)
        await runManifestCommand(manifest.setup[i], target)
      }
    } catch (err) {
      // Only delete a branch we created (`new-branch`); a ref checkout created none.
      const rollback = await rollbackWorktree(repoRoot, target, createdBranch)
      const stageInfo =
        setupStepIndex > 0
          ? {
              stage: 'setup' as const,
              step: { index: setupStepIndex, total: manifest.setup.length },
              command: manifest.setup[setupStepIndex - 1]
            }
          : { stage: 'seed' as const, command: 'seed (copy/link dependencies into the worktree)' }
      throw await buildProvisionError(err, stageInfo, rollback)
    }
  }

  emit('adopt')
  // T61: born inheriting the parent repo's agent control ONLY for a disclosed
  // create (`inheritOpts` present) whose target is the canonical `.claude/worktrees/*`
  // layout AND whose parent repo is currently agent-allowed AND the human did not
  // opt out. Fail-closed: any missing clause → born agent-disallowed (the default).
  let inheritAgentControl = false
  if (opts?.inherit) {
    const parentRepo = canonicalWorktreeParentRepo(target)
    const baseRepoAllowed = parentRepo !== null && (await isUserProjectAgentAllowed(parentRepo))
    inheritAgentControl = decideWorktreeInheritance({
      settingEnabled: await readWorktreeInheritControl(),
      baseRepoAllowed,
      optedOut: opts.inherit.optedOut
    })
  }
  // BUG-40 §3.3: the adopt stage (`addUserProject` → `writeUserProjects`'s
  // unguarded fs calls) has no rollback today, so a failure here leaves the
  // `git worktree add` + seed/setup work as an orphan that poisons every retry
  // (deriveWorktreePath is slug-deterministic — a retry collides with it,
  // `fatal: '<branch>' is already used by worktree at '<path>'`). Roll back the
  // SAME way the seed/setup catch above does, then rethrow the real error.
  let adopted: AdoptedFolderPayload
  try {
    adopted = await adoptFolder(getWindowRef, target, {
      inheritAgentControl,
      ...(opts?.origin ? { origin: opts.origin } : {})
    })
  } catch (err) {
    await rollbackWorktree(repoRoot, target, createdBranch)
    throw err
  }
  onProgress?.({ stage: 'adopt', done: true })
  // BUG-12/T64: report what was ACTUALLY cut from — the `ref` when checking out an
  // existing branch, else the resolved `base` (the passed folder's tip). The MCP
  // ACK echoes this so the agent knows where its worktree derived from.
  const effectiveBase = ref && ref.trim() ? ref.trim() : base
  const effectiveBranch = ref && ref.trim() ? ref.trim() : branch
  return {
    path: target,
    base: effectiveBase,
    branch: effectiveBranch,
    adopted,
    warnings,
    ...(adopted.bornFrom ? { bornFrom: adopted.bornFrom } : {}),
    ...(existingWork.length > 0 ? { existingWork } : {}),
    repoRoot,
    createdBranch
  }
}

/**
 * T61: whether a create at `target` would OFFER agent-control inheritance — the
 * opt-out checkbox in the create confirm / New-worktree dialog.
 *
 * ALWAYS `false` since the free-by-default reversal. The checkbox asked the operator
 * to approve a new worktree inheriting its repo's agent GRANT; there is no grant to
 * inherit any more (a worktree is reachable like any other folder), so offering the
 * choice would be a lie — the worktree is agent-reachable whichever way the box is
 * ticked. The whole plumbing below it (the birth marker, the confirm field, the
 * server-side actuation) is left wired for a future guarded mode that re-derives
 * worktree scope; this is the single seam that turns the offer off.
 */
export async function worktreeInheritOfferForTarget(_target: string | undefined): Promise<boolean> {
  return false
}

/**
 * The offer computed from a create REQUEST (repo + branch). Delegates to
 * {@link worktreeInheritOfferForTarget}, which is now always `false` — see its doc.
 * Kept as the New-worktree dialog's (UI path) seam. Read-only; never throws.
 */
export async function worktreeInheritOffer(
  repoPath: string,
  branch: string,
  baseRef?: string
): Promise<boolean> {
  try {
    const { target } = await resolveWorktreePlan(repoPath, branch, baseRef)
    return worktreeInheritOfferForTarget(target)
  } catch {
    return false
  }
}

/** List a repo's worktrees via `git worktree list --porcelain` (also the worktree tracker's `listWorktrees` dep). */
export async function listWorktrees(repoPath: string): Promise<WorktreeListEntry[]> {
  try {
    const { stdout } = await runFile('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20
    })
    return parseWorktreeList(stdout)
  } catch (err) {
    throw gitError(err)
  }
}

/**
 * List a repo's branches (local + remote) for the New-worktree dialog's base-ref
 * select (T48). Resolves the repo root first so the list is the WHOLE repo's
 * branches, not just the clicked linked-worktree's. Two `for-each-ref` calls —
 * one per refspec — so `remote` is authoritative (not a `/`-in-name guess). Never
 * throws: a non-repo / commit-less repo yields `[]` and the select falls back to
 * the default HEAD option.
 */
export async function listBranches(repoPath: string): Promise<BranchRef[]> {
  const root = await resolveRepoRoot(repoPath)
  const fmt = '%(refname:short)%09%(objectname:short)'
  const [locals, remotes] = await Promise.all([
    runFile('git', ['-C', root, 'for-each-ref', '--format', fmt, 'refs/heads'], GIT_OPTS)
      .then(({ stdout }) => parseBranchRefs(stdout, { remote: false }))
      .catch(() => [] as BranchRef[]),
    runFile('git', ['-C', root, 'for-each-ref', '--format', fmt, 'refs/remotes'], GIT_OPTS)
      .then(({ stdout }) => parseBranchRefs(stdout, { remote: true }))
      .catch(() => [] as BranchRef[])
  ])
  return [...locals, ...remotes]
}

/**
 * Gather real `git worktree list` truth across the given (already-distinct) repo
 * roots for the MCP `list_worktrees` read (T44 S3b — the "diverged from git" face
 * of BUG-4). Dedups entries by path (repos may overlap) and best-effort probes
 * each non-bare worktree for uncommitted changes. Never throws — a non-repo /
 * failed listing simply contributes nothing.
 */
export async function collectWorktreeListing(
  repoRoots: readonly string[]
): Promise<{ entries: WorktreeListEntry[]; dirtyByPath: Record<string, boolean> }> {
  const byPath = new Map<string, WorktreeListEntry>()
  for (const root of repoRoots) {
    try {
      for (const e of await listWorktrees(root)) {
        if (!byPath.has(e.path)) byPath.set(e.path, e)
      }
    } catch {
      // non-repo / failed listing → nothing to add
    }
  }
  const entries = [...byPath.values()]
  const dirtyByPath: Record<string, boolean> = {}
  await Promise.all(
    entries
      .filter((e) => !e.bare)
      .map(async (e) => {
        try {
          dirtyByPath[e.path] = await isWorktreeDirty(e.path)
        } catch {
          dirtyByPath[e.path] = false
        }
      })
  )
  return { entries, dirtyByPath }
}

/** Whether a worktree has uncommitted changes (`git status --porcelain`). */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await runFile('git', ['-C', worktreePath, 'status', '--porcelain'], {
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1 << 20
  })
  return stdout.trim().length > 0
}

/**
 * Probe a worktree's status split into tracked modifications and untracked
 * paths (BUG-75). The Reaper's classifier and executor consume this; the manual
 * **Remove worktree** gate deliberately keeps {@link isWorktreeDirty}, whose
 * "any output at all" reading is the stricter one and must not be loosened by
 * this split.
 *
 * Uses `-z` so paths arrive raw rather than C-quoted — see
 * {@link parsePorcelainStatus}. Throws on any git failure, exactly as
 * {@link isWorktreeDirty} does, so callers keep their existing fail-closed
 * handling.
 */
export async function probeWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  const { stdout } = await runFile('git', ['-C', worktreePath, 'status', '--porcelain', '-z'], {
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1 << 20
  })
  return parsePorcelainStatus(stdout)
}

export type { WorktreeStatus }

/**
 * Whether a worktree has commits its upstream doesn't (`rev-list --count
 * @{upstream}..HEAD`). A worktree with NO upstream configured is treated as
 * having unpushed work (safe default — "nothing tracks it, so removal could lose
 * commits"). Any other probe error is likewise treated as unpushed, so removal
 * fails closed toward the guard.
 */
export async function hasUnpushedCommits(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', worktreePath, 'rev-list', '--count', '@{upstream}..HEAD'],
      { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 }
    )
    return Number(stdout.trim()) > 0
  } catch {
    return true // no upstream / detached / probe error → fail closed toward the guard
  }
}

/** The worktree's current branch (`rev-parse --abbrev-ref HEAD`), or null when detached/error. */
async function currentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 }
    )
    const b = stdout.trim()
    return b && b !== 'HEAD' ? b : null
  } catch {
    return null
  }
}

/**
 * Remove a worktree. REFUSES a worktree with uncommitted changes OR unpushed
 * commits unless `force` is set (UI-only — never reachable from an agent tool).
 * With `deleteBranch`, also deletes the worktree's branch after a successful
 * remove (best-effort, like the create rollback). Surfaces git `stderr` verbatim.
 *
 * BUG-38: when `worktreePath` has already vanished from disk (deleted by
 * Reaper, a manual `rm -rf`, or a prior partial cleanup), the pre-flight
 * dirty/unpushed probes can't run against it — see {@link resolveWorktreeRemovalPlan}
 * for the decision this delegates to.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean,
  deleteBranch: boolean
): Promise<void> {
  try {
    const dirExists = await fileExists(worktreePath)
    const plan = resolveWorktreeRemovalPlan({ dirExists, force })
    if (plan.runPreflight) {
      const [dirty, unpushed] = await Promise.all([
        isWorktreeDirty(worktreePath),
        hasUnpushedCommits(worktreePath)
      ])
      const block = worktreeRemovalBlock({ dirty, unpushed, force })
      if (block === 'uncommitted') {
        throw new Error('worktree has uncommitted changes; pass force to remove it anyway')
      }
      if (block === 'unpushed') {
        throw new Error('worktree has unpushed commits; pass force to remove it anyway')
      }
    }
    // Resolve the branch BEFORE removing — after `worktree remove` the checkout
    // (and its HEAD) is gone, so we can't ask it for its branch anymore. Skipped
    // when the directory is already gone: there's no HEAD left to read.
    const branch = deleteBranch && plan.readBranch ? await currentBranch(worktreePath) : null
    const args = [
      '-C',
      repoPath,
      'worktree',
      'remove',
      ...(plan.effectiveForce ? ['--force'] : []),
      worktreePath
    ]
    await runFile('git', args, { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 })
    if (deleteBranch && branch) {
      // Best-effort, like the create-path rollback: a failed branch delete (e.g.
      // still checked out elsewhere) must not fail an already-succeeded remove.
      await runFile('git', ['-C', repoPath, 'branch', '-D', branch], {
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1 << 20
      }).catch(() => {})
    }
  } catch (err) {
    throw gitError(err)
  }
  // BUG-56: the directory is now gone (this line is only reached once `git
  // worktree remove` succeeded) — clean up Harnu's own sidebar bookkeeping so
  // the folder + its sessions don't linger as a ghost. Best-effort: a failed
  // cleanup here must not turn an already-succeeded removal into an error.
  await removeGhostFolder(getWindowRef, worktreePath).catch((err) =>
    console.warn(`[worktree-ipc] ghost-folder cleanup failed for ${worktreePath}:`, err)
  )
}

/** Module-level window resolver so {@link createWorktree} can adopt without an arg. */
let getWindowRef: () => BrowserWindow | null = () => null

/**
 * Register the worktree IPC handlers + capture the window resolver used by
 * {@link createWorktree}'s adoption broadcast.
 *
 * @param getWindow - resolves the current main window (or `null`).
 */
export function registerWorktreeHandlers(getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow

  ipcMain.handle(
    'worktree:create',
    (
      _e,
      {
        repoPath,
        branch,
        baseRef,
        ref,
        id,
        optOutInherit
      }: {
        repoPath: string
        branch: string
        baseRef?: string
        ref?: string
        id?: string
        /** T61: the New-worktree dialog's "inherit agent control" opt-out (unchecked). */
        optOutInherit?: boolean
      }
    ) =>
      createWorktree(
        repoPath,
        branch,
        baseRef,
        ref,
        // With an `id`, stream per-stage progress to the renderer; without one
        // (the MCP create_worktree path), no events are emitted.
        id
          ? (ev): void => {
              const win = getWindowRef()
              if (win && !win.isDestroyed()) win.webContents.send(`worktree:progress:${id}`, ev)
            }
          : undefined,
        // The dialog is a disclosed human surface → always eligible for T61
        // inheritance (gated inside createWorktree on setting + parent-allowed).
        // T191: no `origin` — a worktree cut through this dialog is deliberately
        // motherless (a human cut it, not a session).
        { inherit: { optedOut: optOutInherit === true } }
      ).catch((err: unknown) => {
        // BUG-40 §3.2: this used to be an opaque forwarded rejection — the only
        // trace of a failed create was a generic renderer toast, with nothing in
        // the main-process log to diagnose it from.
        console.error(`[worktree-ipc] worktree:create failed for ${repoPath} (${branch}):`, err)
        throw err
      })
  )

  // T61: does a create in this repo/branch offer agent-control inheritance? Drives
  // the dialog's opt-out checkbox (shown only when the offer is true).
  ipcMain.handle(
    'worktree:inheritOffer',
    (_e, { repoPath, branch, baseRef }: { repoPath: string; branch: string; baseRef?: string }) =>
      worktreeInheritOffer(repoPath, branch, baseRef)
  )

  ipcMain.handle('worktree:list', (_e, { repoPath }: { repoPath: string }) =>
    listWorktrees(repoPath)
  )

  ipcMain.handle('worktree:branches', (_e, { repoPath }: { repoPath: string }) =>
    listBranches(repoPath)
  )

  ipcMain.handle(
    'worktree:plan',
    (
      _e,
      {
        repoPath,
        branch,
        baseRef,
        ref
      }: { repoPath: string; branch: string; baseRef?: string; ref?: string }
    ) => planWorktree(repoPath, branch, baseRef, ref)
  )

  ipcMain.handle(
    'worktree:remove',
    (
      _e,
      {
        repoPath,
        worktreePath,
        force,
        deleteBranch
      }: { repoPath: string; worktreePath: string; force?: boolean; deleteBranch?: boolean }
    ) => removeWorktree(repoPath, worktreePath, force === true, deleteBranch === true)
  )
}
