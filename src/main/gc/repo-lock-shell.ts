// One shelve cycle at a time per repository (autonomous cleanup U2.2, design §5: "a per-repo lock
// for every cycle — two Harnu instances can run via --user-data-dir"). The lock is a file in the
// repository's own git dir, so it is shared by every process that works on that repo, whichever
// userData it runs from, and it is never tracked or pushed.
//
// Taking it is one atomic exclusive create. Reclaiming a STALE one (a crashed holder) is the
// delicate part: "remove it, then create" lets two processes that both judged it stale each remove
// and each create, the slower one deleting the faster one's fresh lock. So a reclaim is serialised
// by a short-lived guard file, and staleness is judged again while holding the guard: whoever
// arrives second finds a fresh lock (or the guard) and is refused. A lock carries a random token,
// so a holder that was reclaimed from under it (it ran longer than the stale age) never removes
// the lock of the process that reclaimed it.
//
// Fail closed: a lock that cannot be read is held until its file is old enough to be stale; a
// repository whose git dir cannot be found cannot be locked, so it is not worked on.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const LOCK_NAME = 'harnu-gc.lock'
/** A lock older than this is a crashed holder, not a long cycle. */
export const LOCK_STALE_MS = 30 * 60_000
/** A reclaim takes milliseconds; a guard this old belongs to a reclaimer that died. */
export const GUARD_STALE_MS = 60_000

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
  /** Test seam: awaited after a lock is judged stale and before anything is done about it. */
  beforeReclaim?: () => Promise<void>
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

interface Holder {
  pid: number
  at: number
  token?: string
}

async function readHolder(file: string): Promise<Holder | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as {
      pid?: unknown
      at?: unknown
      token?: unknown
    }
    return typeof raw.pid === 'number' && typeof raw.at === 'number'
      ? { pid: raw.pid, at: raw.at, ...(typeof raw.token === 'string' ? { token: raw.token } : {}) }
      : null
  } catch {
    return null
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function withRepoLock<T>(
  repoPath: string,
  work: () => Promise<T>,
  opts: RepoLockOpts = {}
): Promise<RepoLockResult<T>> {
  let file: string
  try {
    file = await lockPathOf(repoPath)
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: messageOf(err) }
  }
  return withLockFile(file, work, opts)
}

/**
 * Where the Docker slot's lock lives (autonomous cleanup U3.1). Docker is one daemon per machine,
 * not per repository, so the lock is a file in the temp dir shared by every Harnu instance
 * (`--user-data-dir`) of the same user; the user id keeps two users from sharing one file.
 */
export function dockerLockPath(
  tmpDir: string = os.tmpdir(),
  uid: number | null = process.getuid?.() ?? null
): string {
  return path.join(tmpDir, `harnu-docker-autonomy-${uid ?? 'u'}.lock`)
}

/** The lock itself, on any file: `withRepoLock` is this with the repository's own lock path. */
export async function withLockFile<T>(
  file: string,
  work: () => Promise<T>,
  opts: RepoLockOpts = {}
): Promise<RepoLockResult<T>> {
  const now = opts.now ?? Date.now
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const alive = opts.alive ?? processAlive
  const pid = opts.pid ?? process.pid
  const token = randomUUID()
  const guardFile = `${file}.reclaim`

  /** One atomic exclusive create. False when the lock exists. */
  const take = async (): Promise<boolean> => {
    try {
      const fh = await fs.open(file, 'wx')
      try {
        await fh.writeFile(JSON.stringify({ pid, at: now(), token }))
      } finally {
        await fh.close()
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
  }

  /** What the lock on disk is right now: absent, fresh, or stale (a crashed or dead holder). */
  const judge = async (): Promise<
    { state: 'absent' } | { state: 'fresh' | 'stale'; holder: Holder | null }
  > => {
    const holder = await readHolder(file)
    // The age of an unreadable lock is the age of its file.
    const mtime = await fs.stat(file).then(
      (s) => s.mtimeMs,
      (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? 'absent' : null)
    )
    if (mtime === 'absent') return { state: 'absent' }
    const since = holder?.at ?? mtime ?? now()
    const stale = now() - since >= staleMs || (holder !== null && !alive(holder.pid))
    return { state: stale ? 'stale' : 'fresh', holder }
  }

  let held = false
  try {
    held = await take()
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: messageOf(err) }
  }

  if (!held) {
    const first = await judge()
    if (first.state === 'fresh') return { ok: false, reason: 'locked', holder: first.holder }
    if (first.state === 'stale') await opts.beforeReclaim?.()

    // Reclaiming (or the lock vanished meanwhile): one process at a time.
    let guard: import('node:fs/promises').FileHandle
    try {
      guard = await fs.open(guardFile, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, reason: 'unavailable', message: messageOf(err) }
      }
      // Someone is reclaiming right now: refuse. A guard that outlived any reclaim belongs to a
      // reclaimer that died; clear it so the next attempt can go ahead.
      const age = await fs.stat(guardFile).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0
      )
      if (age >= GUARD_STALE_MS) await fs.rm(guardFile, { force: true }).catch(() => undefined)
      return { ok: false, reason: 'locked', holder: await readHolder(file) }
    }
    try {
      // Judged again under the guard: the lock may have been reclaimed and taken since.
      const again = await judge()
      if (again.state === 'fresh') return { ok: false, reason: 'locked', holder: again.holder }
      if (again.state === 'stale') await fs.rm(file, { force: true })
      try {
        held = await take()
      } catch (err) {
        return { ok: false, reason: 'unavailable', message: messageOf(err) }
      }
      if (!held) return { ok: false, reason: 'locked', holder: await readHolder(file) }
    } finally {
      await guard.close().catch(() => undefined)
      await fs.rm(guardFile, { force: true }).catch(() => undefined)
    }
  }

  try {
    return { ok: true, value: await work() }
  } finally {
    // Only a lock that is still ours: a holder reclaimed from under it must not remove the
    // lock of the process that reclaimed it.
    const now = await readHolder(file)
    if (now?.token === token) await fs.rm(file, { force: true }).catch(() => undefined)
  }
}
