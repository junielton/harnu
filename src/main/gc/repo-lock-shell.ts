// One shelve cycle at a time per repository (autonomous cleanup U2.2, design §5: "a per-repo lock
// for every cycle — two Harnu instances can run via --user-data-dir"). The lock is a file in the
// repository's own git dir, so it is shared by every process that works on that repo, whichever
// userData it runs from, and it is never tracked or pushed.
//
// Fail closed: a lock that cannot be read is held until its file is old enough to be stale; a
// repository whose git dir cannot be found cannot be locked, so it is not worked on.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const LOCK_NAME = 'harnu-gc.lock'
/** A lock older than this is a crashed holder, not a long cycle. */
export const LOCK_STALE_MS = 30 * 60_000

export type RepoLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'locked'; holder: { pid: number; at: number } | null }
  | { ok: false; reason: 'unavailable'; message: string }

export interface RepoLockOpts {
  now?: () => number
  staleMs?: number
  pid?: number
  /** Whether a process exists. Default: signal 0 (a permission error still means it exists). */
  alive?: (pid: number) => boolean
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function lockPathOf(repoPath: string): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { windowsHide: true, timeout: 30_000 }
  )
  return path.join(stdout.trim(), LOCK_NAME)
}

async function readHolder(file: string): Promise<{ pid: number; at: number } | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: unknown; at?: unknown }
    return typeof raw.pid === 'number' && typeof raw.at === 'number'
      ? { pid: raw.pid, at: raw.at }
      : null
  } catch {
    return null
  }
}

export async function withRepoLock<T>(
  repoPath: string,
  work: () => Promise<T>,
  opts: RepoLockOpts = {}
): Promise<RepoLockResult<T>> {
  const now = opts.now ?? Date.now
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const alive = opts.alive ?? processAlive
  const pid = opts.pid ?? process.pid
  let file: string
  try {
    file = await lockPathOf(repoPath)
  } catch (err) {
    return {
      ok: false,
      reason: 'unavailable',
      message: err instanceof Error ? err.message : String(err)
    }
  }

  const take = async (): Promise<boolean> => {
    try {
      const fh = await fs.open(file, 'wx')
      try {
        await fh.writeFile(JSON.stringify({ pid, at: now() }))
      } finally {
        await fh.close()
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
  }

  let held = false
  try {
    held = await take()
  } catch (err) {
    return {
      ok: false,
      reason: 'unavailable',
      message: err instanceof Error ? err.message : String(err)
    }
  }
  if (!held) {
    const holder = await readHolder(file)
    // The age of an unreadable lock is the age of its file.
    const since =
      holder?.at ??
      (await fs.stat(file).then(
        (s) => s.mtimeMs,
        () => null
      )) ??
      now()
    const stale = now() - since >= staleMs || (holder !== null && !alive(holder.pid))
    if (!stale) return { ok: false, reason: 'locked', holder }
    // Reclaim: remove the dead holder's file and try once more; losing that race means someone
    // else just took it, which is "locked".
    await fs.rm(file, { force: true })
    try {
      held = await take()
    } catch {
      held = false
    }
    if (!held) return { ok: false, reason: 'locked', holder: await readHolder(file) }
  }

  try {
    return { ok: true, value: await work() }
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined)
  }
}
