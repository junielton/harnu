/**
 * Thin IPC shell for the `WORKTREE.md` creator (T87). The pure heuristics live in
 * {@link './worktree-md-generate'.generateWorktreeMd} (unit-tested); this module is
 * the env-bound shell (ADR-0001): it probes the repo on disk, resolves the repo
 * root via git, calls the pure generator, and atomically writes the PROPOSAL.
 *
 * Trust boundary (T87): the output is a proposal the human reviews and commits —
 * Harnu writes the file but NEVER executes it. The generated `setup` only runs when
 * a worktree is later created, gated by the existing create-worktree confirm
 * (`worktree-ipc.ts`). `create` is **idempotent**: if a manifest already exists at
 * the repo root it is opened, never overwritten.
 *
 * The manifest is always resolved at the **repo root** (the main worktree, via
 * `git --git-common-dir`), mirroring the READER (`worktree-ipc.ts:resolveRepoRoot`)
 * so a right-click on a linked worktree still targets the repo's one true manifest.
 * The write target is a fixed basename (`WORKTREE.md`) at that git-verified root —
 * no user-supplied path segment is ever joined, so there is no traversal surface.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { access, rename, stat, writeFile } from 'node:fs/promises'
import { ipcMain } from 'electron'
import { generateWorktreeMd, type JsPackageManager, type RepoProbe } from './worktree-md-generate'

const runFile = promisify(execFile)

/** Hard wall-clock ceiling for any single read-only `git` probe (ms). */
const GIT_TIMEOUT_MS = 30_000
const GIT_OPTS = { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 } as const

/** The manifest candidate files the reader recognises, in resolution order. */
const MANIFEST_CANDIDATES = ['WORKTREE.md', 'worktree-manifest.md', join('.claude', 'worktree.md')]

/** Where a fresh manifest is written (the primary candidate at the repo root). */
const MANIFEST_TARGET = 'WORKTREE.md'

/** Probe result the renderer uses to pick the Create-vs-Open label + behaviour. */
export interface WorktreeMdProbeResult {
  /** The repo root the manifest belongs to (main worktree; git-resolved). */
  repoRoot: string
  /** Whether a manifest already exists at the repo root (any recognised name). */
  exists: boolean
  /** The manifest's absolute path — the existing file, or where create will write. */
  manifestPath: string
  /** The deterministic findings that drive the generated template. */
  probe: RepoProbe
}

/** Result of a create request — idempotent: an existing manifest is opened, not clobbered. */
export interface WorktreeMdCreateResult {
  ok: boolean
  /** Absolute path to open in the markdown pane (the written or pre-existing file). */
  path: string
  /** Whether a new file was written (false = a manifest already existed). */
  created: boolean
  /** Short reason on failure (renderer shows a toast). */
  error?: string
}

/** True when `p` exists (any type). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** True when `p` exists and is a directory. */
async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the repo root (main worktree) for `folderPath` via `git --git-common-dir`,
 * mirroring `worktree-ipc.ts:resolveRepoRoot`. Falls back to `folderPath` when git
 * can't answer (not a repo / detached gitdir).
 */
async function resolveRepoRoot(folderPath: string): Promise<string> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', folderPath, 'rev-parse', '--git-common-dir'],
      GIT_OPTS
    )
    const raw = stdout.trim()
    if (!raw) return folderPath
    const commonDir = isAbsolute(raw) ? raw : resolve(folderPath, raw)
    return basename(commonDir) === '.git' ? dirname(commonDir) : folderPath
  } catch {
    return folderPath
  }
}

/** Detect the repo's default branch (main/master) — drives the manifest `from`. */
async function detectDefaultBranch(repoRoot: string): Promise<string | null> {
  // Prefer the remote's advertised default (origin/HEAD → e.g. `origin/main`).
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', repoRoot, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'],
      GIT_OPTS
    )
    const ref = stdout.trim()
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length)
    if (ref) return ref
  } catch {
    /* no origin/HEAD — fall through to local-branch probing */
  }
  // No remote default → fall back to a local `main`, then `master`.
  for (const branch of ['main', 'master']) {
    try {
      await runFile(
        'git',
        ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        GIT_OPTS
      )
      return branch
    } catch {
      /* not this one */
    }
  }
  return null
}

/** Pick the JS package manager from the lockfile flavour (deterministic precedence). */
async function detectPackageManager(repoRoot: string): Promise<JsPackageManager | null> {
  if (await pathExists(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await pathExists(join(repoRoot, 'yarn.lock'))) return 'yarn'
  if (
    (await pathExists(join(repoRoot, 'bun.lockb'))) ||
    (await pathExists(join(repoRoot, 'bun.lock')))
  )
    return 'bun'
  if (await pathExists(join(repoRoot, 'package-lock.json'))) return 'npm'
  return null
}

/** Find an env template (`.env.example` preferred, then `.env.sample`). */
async function detectEnvExample(repoRoot: string): Promise<string | null> {
  for (const name of ['.env.example', '.env.sample']) {
    if (await pathExists(join(repoRoot, name))) return name
  }
  return null
}

/** Run every deterministic probe against the repo root. No LLM, no network. */
async function probeRepo(repoRoot: string): Promise<RepoProbe> {
  const [
    packageManager,
    hasPackageJson,
    hasComposer,
    hasEnv,
    envExampleName,
    hasNodeModules,
    hasVendor,
    usesClaudeWorktrees,
    defaultBranch
  ] = await Promise.all([
    detectPackageManager(repoRoot),
    pathExists(join(repoRoot, 'package.json')),
    pathExists(join(repoRoot, 'composer.json')),
    pathExists(join(repoRoot, '.env')),
    detectEnvExample(repoRoot),
    dirExists(join(repoRoot, 'node_modules')),
    dirExists(join(repoRoot, 'vendor')),
    dirExists(join(repoRoot, '.claude', 'worktrees')),
    detectDefaultBranch(repoRoot)
  ])
  return {
    repoName: basename(repoRoot),
    packageManager,
    hasPackageJson,
    hasComposer,
    hasEnv,
    hasEnvExample: envExampleName !== null,
    envExampleName,
    hasNodeModules,
    hasVendor,
    defaultBranch,
    usesClaudeWorktrees
  }
}

/** Locate an existing manifest at the repo root (any recognised name). */
async function findExistingManifest(repoRoot: string): Promise<string | null> {
  for (const rel of MANIFEST_CANDIDATES) {
    const p = join(repoRoot, rel)
    if (await pathExists(p)) return p
  }
  return null
}

/** Probe: resolve repo root, detect an existing manifest, and run the heuristics. */
export async function probeWorktreeMd(folderPath: string): Promise<WorktreeMdProbeResult> {
  const repoRoot = await resolveRepoRoot(folderPath)
  const [existing, probe] = await Promise.all([findExistingManifest(repoRoot), probeRepo(repoRoot)])
  return {
    repoRoot,
    exists: existing !== null,
    manifestPath: existing ?? join(repoRoot, MANIFEST_TARGET),
    probe
  }
}

/**
 * Create the manifest PROPOSAL. Idempotent: if a manifest already exists it is
 * returned unchanged (`created:false`) so a stale "Create" label can never
 * clobber. Otherwise the generated template is written atomically (tmp + rename)
 * to `<repoRoot>/WORKTREE.md`.
 */
export async function createWorktreeMd(folderPath: string): Promise<WorktreeMdCreateResult> {
  try {
    const repoRoot = await resolveRepoRoot(folderPath)
    const existing = await findExistingManifest(repoRoot)
    if (existing) return { ok: true, path: existing, created: false }

    const probe = await probeRepo(repoRoot)
    const content = generateWorktreeMd(probe)
    const target = join(repoRoot, MANIFEST_TARGET)
    const tmp = `${target}.tmp-${process.pid}`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, target)
    return { ok: true, path: target, created: true }
  } catch (err) {
    return {
      ok: false,
      path: '',
      created: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Register the T87 IPC handlers (called from `src/main/index.ts`). */
export function registerWorktreeMdHandlers(): void {
  ipcMain.handle('worktreeMd:probe', (_e, args: { folderPath: string }) =>
    probeWorktreeMd(args.folderPath)
  )
  ipcMain.handle('worktreeMd:create', (_e, args: { folderPath: string }) =>
    createWorktreeMd(args.folderPath)
  )
}
