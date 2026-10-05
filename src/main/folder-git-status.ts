import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'

const runFile = promisify(execFile)

/**
 * Hover-triggered, throttled per-folder git status probe (T52 Slice 3). The
 * hover card's CHEAP fields (branch / repoId / activity) come free off the
 * `Folder` object; the EXPENSIVE ones — working-tree dirtiness and ahead/behind
 * vs upstream — need fresh `git` calls, so they live here, OUTSIDE the folder
 * scan's hot `rev-parse` path (`git-probe.ts`), behind their own short cache.
 *
 * Hardened like `git-probe.ts`: short timeout, `windowsHide`, bounded buffer,
 * a small TTL cache (dirtiness changes fast, so shorter than the 60 s meta
 * cache), and it NEVER throws — a non-repo / detached / no-upstream folder just
 * comes back with `null` fields the card omits.
 */

// 5 s: working-tree state changes on every save, but a burst of hovers over the
// same row shouldn't re-shell git each time. Short enough to feel live.
const CACHE_TTL_MS = 5_000
const PROBE_TIMEOUT_MS = 800

/** Working-tree + upstream divergence for one folder. `null` = unknown/n-a. */
export interface FolderGitStatus {
  /** Count of changed/untracked entries (`git status --porcelain`); null when not a repo. */
  dirtyCount: number | null
  /** Commits on HEAD not on its upstream; null when there is no upstream. */
  ahead: number | null
  /** Commits on the upstream not on HEAD; null when there is no upstream. */
  behind: number | null
}

const cache = new Map<string, { at: number; value: FolderGitStatus }>()

/** Count non-empty porcelain lines (each = one changed/untracked path). */
export function countPorcelain(stdout: string): number {
  return stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length
}

/**
 * Parse `git rev-list --left-right --count <upstream>...HEAD` output — a single
 * `"<behind>\t<ahead>"` line (left = upstream-only = behind, right = HEAD-only =
 * ahead). Returns `null` when the shape is unexpected (so the caller degrades).
 */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } | null {
  const parts = stdout.trim().split(/\s+/)
  if (parts.length < 2) return null
  const behind = Number(parts[0])
  const ahead = Number(parts[1])
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null
  return { ahead, behind }
}

async function probeUncached(folderPath: string): Promise<FolderGitStatus> {
  const status: FolderGitStatus = { dirtyCount: null, ahead: null, behind: null }
  try {
    const { stdout } = await runFile('git', ['-C', folderPath, 'status', '--porcelain'], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1 << 20
    })
    status.dirtyCount = countPorcelain(stdout)
  } catch {
    // Not a git repo / timeout — leave everything null.
    return status
  }
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', folderPath, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }
    )
    const ab = parseAheadBehind(stdout)
    if (ab) {
      status.ahead = ab.ahead
      status.behind = ab.behind
    }
  } catch {
    // No upstream configured (or detached) — ahead/behind stay null.
  }
  return status
}

/** Probe one folder's git status. Never throws. Cached {@link CACHE_TTL_MS}. */
export async function probeFolderGitStatus(folderPath: string): Promise<FolderGitStatus> {
  const cached = cache.get(folderPath)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  const value = await probeUncached(folderPath)
  cache.set(folderPath, { at: Date.now(), value })
  return value
}

/** Register the folder git-status IPC (T52). Request/response only. */
export function registerFolderGitStatusHandlers(): void {
  ipcMain.handle('folders:gitStatus', (_e, { folderPath }: { folderPath: string }) =>
    probeFolderGitStatus(folderPath)
  )
}
