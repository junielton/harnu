import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { GitMeta } from './folder-model'

const runFile = promisify(execFile)

/**
 * Per-folder git metadata probe for the folder-first model (spec §4.2).
 *
 * Unlike `worktree.ts` (which enumerates a repo's worktrees for the Add-folder
 * dialog), this resolves the *additive* git fields of a single folder:
 *   - `gitBranch`     — the short branch name (omitted when detached).
 *   - `repoId`        — the realpath'd git common-dir; folders sharing it are
 *                       worktrees of the same repo.
 *   - `isMainWorktree`— whether this folder owns the common-dir.
 *
 * One combined `git -C <path> rev-parse --abbrev-ref HEAD --git-common-dir`
 * call per unique folder (branch + common-dir in two lines). Hardened like
 * `worktree.ts`: 60 s TTL cache, short timeout, `windowsHide`, graceful
 * degradation (no fields, or a slug-based `repoId` fallback) on any failure.
 */

// 60 s (perf spec 2026-06-22 §5.1c): a full re-scan probes ~one git per folder;
// at the old 5 s TTL, back-to-back reloads re-shelled every folder. Branch/
// common-dir change slowly, and a branch switch is also surfaced live by the
// session watcher, so a longer TTL trades negligible staleness for far fewer
// subprocess spawns during reload bursts.
const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 500
const MAX_CONCURRENCY = 8

const cache = new Map<string, { at: number; value: GitMeta }>()

/** Split the two `rev-parse` output lines into `{ branch, commonDir }`. */
export function parseRevParse(stdout: string): { branch: string; commonDir: string } {
  const lines = stdout.split(/\r?\n/)
  return { branch: (lines[0] ?? '').trim(), commonDir: (lines[1] ?? '').trim() }
}

/**
 * Derive `GitMeta` from a successful probe. `realRepoId`/`realFolderPath` are
 * expected already symlink-resolved so the `dirname === folder` main-worktree
 * test is reliable. `gitBranch` is omitted (no key) when detached (`HEAD`) or
 * empty.
 */
export function buildGitMeta(branch: string, realRepoId: string, realFolderPath: string): GitMeta {
  const meta: GitMeta = {
    repoId: realRepoId,
    isMainWorktree: path.dirname(realRepoId) === realFolderPath
  }
  if (branch && branch !== 'HEAD') meta.gitBranch = branch
  return meta
}

/**
 * Fallback `repoId` from the Claude worktree path convention
 * (`<repo>/.claude/worktrees/<name>` → `<repo>/.git`). Used when the git probe
 * fails so a transient git outage doesn't un-group worktrees. Returns
 * `undefined` for non-worktree paths.
 *
 * Matches either separator so it works on Windows native paths too, and builds
 * the result by string concatenation (NOT `path.join`, which would rewrite the
 * codebase's forward-slash convention to `\` on Windows and break repoId grouping).
 */
export function slugFallbackRepoId(folderPath: string): string | undefined {
  const match = /[/\\]\.claude[/\\]worktrees[/\\]/.exec(folderPath)
  if (!match) return undefined
  return folderPath.slice(0, match.index) + '/.git'
}

/** Best-effort `realpath`; falls back to the input on any error. */
async function realpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

/**
 * Probe one folder. Never throws. On git failure, returns a slug-based
 * `repoId` fallback when the path is a Claude worktree, otherwise `{}`.
 * Results are cached for 5 s keyed by the input folder path.
 */
export async function probeGitMeta(folderPath: string): Promise<GitMeta> {
  const cached = cache.get(folderPath)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const value = await probeUncached(folderPath)
  cache.set(folderPath, { at: Date.now(), value })
  return value
}

async function probeUncached(folderPath: string): Promise<GitMeta> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', folderPath, 'rev-parse', '--abbrev-ref', 'HEAD', '--git-common-dir'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }
    )
    const { branch, commonDir } = parseRevParse(stdout)
    if (!commonDir) return fallback(folderPath)
    const realFolderPath = await realpath(folderPath)
    const realRepoId = await realpath(path.resolve(folderPath, commonDir))
    return buildGitMeta(branch, realRepoId, realFolderPath)
  } catch {
    // ENOENT (no git), exit 128 (not a repo), or timeout — degrade gracefully.
    return fallback(folderPath)
  }
}

async function fallback(folderPath: string): Promise<GitMeta> {
  const repoId = slugFallbackRepoId(folderPath)
  if (!repoId) return {}
  return { repoId: await realpath(repoId), isMainWorktree: false }
}

/**
 * Probe many folders with bounded concurrency. Returns a `Map<path, GitMeta>`
 * for every unique input path. Order-independent; safe on hundreds of folders.
 */
export async function probeGitMetaBatch(paths: string[]): Promise<Map<string, GitMeta>> {
  const unique = [...new Set(paths)]
  const out = new Map<string, GitMeta>()
  for (let i = 0; i < unique.length; i += MAX_CONCURRENCY) {
    const chunk = unique.slice(i, i + MAX_CONCURRENCY)
    const metas = await Promise.all(chunk.map((p) => probeGitMeta(p)))
    chunk.forEach((p, j) => out.set(p, metas[j]))
  }
  return out
}

/** Forces the next probe of every path to re-shell out. */
export function clearGitProbeCache(): void {
  cache.clear()
}
