/**
 * Worktree tracker core (T388 / sidebar-liveness U4a, spec §4.B B1).
 *
 * Keeps a bounded set of known repos listed with `git worktree list --porcelain`
 * and pushes each repo's worktrees through `emit` whenever they change, so a
 * worktree created or removed outside Harnu shows up in the sidebar without a
 * Rescan. Pure shell over injected deps: no git, fs or Electron import here —
 * the production deps (and the IPC wiring) are built by U4b.
 *
 * - `track` is an idempotent set replace. A new repo is listed once and its
 *   watches armed; a dropped repo has its watches closed and its listing
 *   forgotten; a `memberPaths`-only change re-matches the last listing without a
 *   re-list; a `probePath` change re-lists.
 * - Watch events → 500 ms trailing debounce per repo → single-flight listing →
 *   `emit` only when the matched entries changed. One spawn per repo per burst.
 * - Bounds: at most 64 tracked repos (the first 64 of the `track` input, in
 *   order — every repo of a set replace was tracked "now", so input order breaks
 *   the tie; the overflow is never listed nor watched, logged once) and at most
 *   4 listings in flight across all repos.
 * - D9 matching: every listed path and every member path is canonicalized
 *   (memoized per `track` call); a listed path whose canonical form equals a
 *   member's is reported AS the member path, so one directory never yields two
 *   rows across path spellings (`C:/x` vs `C:\x`, `/private/var`, symlinks).
 * - Bare and prunable entries are never emitted.
 * - Watches (D4): `<repoId>/worktrees` (entry add/remove) and `<repoId>`
 *   filtered to the `worktrees` entry (the first linked worktree creates the
 *   dir). Platform rules: a `rename` of the `worktrees` dir itself closes that
 *   watch at once (on Windows a held handle leaves the dir delete-pending and
 *   the next `git worktree add` hits `EPERM`) and the parent watch re-arms it
 *   when it reappears; a `null` filename (macOS) on either watch stats the
 *   `worktrees` dir, re-lists only when its `mtimeMs` moved, and releases the
 *   `worktrees` watch only when the dir is gone.
 * - A watch that fails with anything but `ENOENT` (`ENOSPC`/`EMFILE`/`EPERM`),
 *   at arm time or later through the watcher's `'error'` event, makes that repo
 *   re-list on window focus, at most once per 30 s. There is no interval timer
 *   anywhere.
 */
import { join } from 'node:path'
import type { WorktreeListEntry } from './worktree-core'

export interface TrackedRepo {
  /** Realpath'd git common dir, as `GitMeta.repoId`. */
  repoId: string
  /** Any existing folder of the repo, for `git -C`. */
  probePath: string
  /** The repo's folder paths the renderer knows (for D9 matching). */
  memberPaths: string[]
}

export interface TrackedWorktree {
  /** A `memberPaths` entry when it is the same directory (D9), else canonical. */
  path: string
  branch: string
  isMainWorktree: boolean
  locked: boolean
}

export interface WorktreeTrackerDeps {
  listWorktrees(probePath: string): Promise<WorktreeListEntry[]>
  /** `user-projects.ts` `normalizePath` in production. */
  canonicalize(p: string): Promise<string>
  /** `onError` receives the watcher's async `'error'` events (failures after arming). */
  watch(
    dir: string,
    onEvent: (event: string, filename: string | null) => void,
    onError?: (err: Error) => void
  ): { close(): void }
  stat(dir: string): Promise<{ mtimeMs: number } | null>
  onFocus(cb: () => void): () => void
  now(): number
}

export interface WorktreeTracker {
  track(repos: TrackedRepo[]): void
  close(): void
}

const MAX_REPOS = 64
const LIST_CONCURRENCY = 4
const DEBOUNCE_MS = 500
const FOCUS_THROTTLE_MS = 30_000

interface Watch {
  close(): void
}

interface RepoState {
  repo: TrackedRepo
  closed: boolean
  parentWatch: Watch | null
  worktreesWatch: Watch | null
  timer: ReturnType<typeof setTimeout> | null
  listing: Promise<void> | null
  rerun: boolean
  /** Last successful raw listing, kept for re-matching and on a failed re-list. */
  raw: WorktreeListEntry[] | null
  /** Last emitted entries. */
  last: TrackedWorktree[] | null
  publishing: Promise<void>
  failLogged: boolean
  watchFailed: boolean
  /** `mtimeMs` of `<repoId>/worktrees` when last listed (null = missing) — the null-filename gate. */
  lastMtime: number | null
  lastFocusListAt: number
}

export function createWorktreeTracker(
  deps: WorktreeTrackerDeps,
  emit: (repoId: string, entries: TrackedWorktree[]) => void
): WorktreeTracker {
  const repos = new Map<string, RepoState>()
  let canonMemo = new Map<string, Promise<string>>()
  let capLogged = false

  // Listing semaphore — same shape as `withScrapeSlot` in claude-reader.ts.
  let active = 0
  const queue: Array<() => void> = []
  function slot<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      active++
      try {
        return await fn()
      } finally {
        active--
        const next = queue.shift()
        if (next) next()
      }
    }
    if (active < LIST_CONCURRENCY) return run()
    return new Promise<T>((resolve, reject) => {
      queue.push(() => void run().then(resolve, reject))
    })
  }

  function canonicalize(p: string): Promise<string> {
    let hit = canonMemo.get(p)
    if (!hit) {
      hit = deps.canonicalize(p).catch(() => p)
      canonMemo.set(p, hit)
    }
    return hit
  }

  async function match(s: RepoState, raw: WorktreeListEntry[]): Promise<TrackedWorktree[]> {
    const memberByCanon = new Map<string, string>()
    for (const m of s.repo.memberPaths) {
      const c = await canonicalize(m)
      if (!memberByCanon.has(c)) memberByCanon.set(c, m)
    }
    const out: TrackedWorktree[] = []
    for (let i = 0; i < raw.length; i++) {
      const e = raw[i]
      if (e.bare || e.prunable) continue
      const canon = await canonicalize(e.path)
      out.push({
        path: memberByCanon.get(canon) ?? canon,
        branch: e.branch,
        isMainWorktree: i === 0,
        locked: e.locked === true
      })
    }
    return out
  }

  /** Re-match the last raw listing and emit on change; serialized per repo so emits stay in order. */
  function publish(s: RepoState): Promise<void> {
    s.publishing = s.publishing
      .then(async () => {
        if (!s.raw || s.closed) return
        const out = await match(s, s.raw)
        if (s.closed || JSON.stringify(out) === JSON.stringify(s.last)) return
        s.last = out
        emit(s.repo.repoId, out)
      })
      .catch((err) => console.warn('[worktree-tracker] emit failed:', String(err)))
    return s.publishing
  }

  function list(s: RepoState): Promise<void> {
    if (s.listing) {
      s.rerun = true
      return s.listing
    }
    s.listing = (async () => {
      do {
        s.rerun = false
        if (s.closed) return
        s.lastMtime = await statWorktrees(s)
        // The dir exists: make sure it is watched. Re-arms after a `rename` that
        // named a child entry `worktrees` (ambiguous with the dir itself) and
        // retries a failed re-arm on a focus re-list.
        if (s.lastMtime !== null) armWorktreesWatch(s)
        try {
          s.raw = await slot(() => deps.listWorktrees(s.repo.probePath))
          s.failLogged = false
        } catch (err) {
          // Review focus 4: keep the last good listing, log once, never throw.
          if (!s.failLogged) {
            s.failLogged = true
            console.warn(`[worktree-tracker] listing failed for ${s.repo.probePath}:`, String(err))
          }
          continue
        }
        await publish(s)
      } while (s.rerun)
    })().finally(() => {
      s.listing = null
    })
    return s.listing
  }

  function schedule(s: RepoState): void {
    if (s.closed) return
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      s.timer = null
      void list(s)
    }, DEBOUNCE_MS)
  }

  /**
   * Arm a watch; `ENOENT` is expected (dir not created yet), any other failure
   * flags the repo. A later async error closes the watch (via `onLost`, only if
   * it is still the live one) and flags the repo too.
   */
  function tryWatch(
    s: RepoState,
    dir: string,
    onEvent: (event: string, filename: string | null) => void,
    onLost: (w: Watch) => void
  ): Watch | null {
    let w: Watch | null = null
    try {
      w = deps.watch(dir, onEvent, () => {
        if (!w || s.closed) return
        onLost(w)
        s.watchFailed = true
      })
      return w
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') s.watchFailed = true
      return null
    }
  }

  const worktreesDir = (s: RepoState): string => join(s.repo.repoId, 'worktrees')

  async function statWorktrees(s: RepoState): Promise<number | null> {
    try {
      return (await deps.stat(worktreesDir(s)))?.mtimeMs ?? null
    } catch {
      return null
    }
  }

  function closeWorktreesWatch(s: RepoState): void {
    s.worktreesWatch?.close()
    s.worktreesWatch = null
  }

  function armWorktreesWatch(s: RepoState): void {
    if (s.closed || s.worktreesWatch) return
    s.worktreesWatch = tryWatch(
      s,
      worktreesDir(s),
      (event, filename) => {
        if (filename === null) {
          // macOS: "something changed here" — stat-gated, closes only if the dir is gone.
          void onNullFilename(s)
          return
        }
        if (event === 'rename' && filename === 'worktrees') {
          // The dir itself went away (or was renamed): release the handle now.
          // A child entry named `worktrees` looks the same; the re-list re-arms.
          closeWorktreesWatch(s)
        }
        schedule(s)
      },
      (w) => {
        if (s.worktreesWatch === w) closeWorktreesWatch(s)
      }
    )
    // Both watches live again (e.g. an EPERM re-arm on a delete-pending dir
    // succeeded later): leave the focus fallback.
    if (s.worktreesWatch && s.parentWatch) s.watchFailed = false
  }

  /**
   * A `null` filename on either watch: stat `<repoId>/worktrees` and re-list only
   * when its `mtimeMs` moved. A dir that is gone has its watch released at once
   * (Windows delete-pending); one that exists is (re-)armed.
   */
  async function onNullFilename(s: RepoState): Promise<void> {
    const mtime = await statWorktrees(s)
    if (s.closed) return
    if (mtime === null) closeWorktreesWatch(s)
    else armWorktreesWatch(s)
    if (mtime === s.lastMtime) return
    s.lastMtime = mtime
    schedule(s)
  }

  function armWatches(s: RepoState): void {
    s.parentWatch = tryWatch(
      s,
      s.repo.repoId,
      (_event, filename) => {
        if (filename === null) {
          void onNullFilename(s)
          return
        }
        if (filename !== 'worktrees') return
        armWorktreesWatch(s)
        schedule(s)
      },
      (w) => {
        if (s.parentWatch !== w) return
        w.close()
        s.parentWatch = null
      }
    )
    armWorktreesWatch(s)
  }

  const offFocus = deps.onFocus(() => {
    const now = deps.now()
    for (const s of repos.values()) {
      if (!s.watchFailed || now - s.lastFocusListAt < FOCUS_THROTTLE_MS) continue
      s.lastFocusListAt = now
      void list(s)
    }
  })

  function closeRepo(s: RepoState): void {
    s.closed = true
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    s.parentWatch?.close()
    s.parentWatch = null
    closeWorktreesWatch(s)
  }

  return {
    track(next) {
      canonMemo = new Map()
      const unique = new Map<string, TrackedRepo>()
      for (const r of next) if (!unique.has(r.repoId)) unique.set(r.repoId, r)
      const admitted = [...unique.values()].slice(0, MAX_REPOS)
      if (unique.size > MAX_REPOS && !capLogged) {
        capLogged = true
        console.warn(
          `[worktree-tracker] ${unique.size} repos requested, tracking the first ${MAX_REPOS}`
        )
      }
      const wanted = new Set(admitted.map((r) => r.repoId))
      for (const [id, s] of repos) {
        if (wanted.has(id)) continue
        closeRepo(s)
        repos.delete(id)
      }
      for (const r of admitted) {
        const s = repos.get(r.repoId)
        if (s) {
          const probeChanged = s.repo.probePath !== r.probePath
          const membersChanged = s.repo.memberPaths.join('\0') !== r.memberPaths.join('\0')
          s.repo = r
          if (probeChanged) void list(s)
          else if (membersChanged) void publish(s)
          continue
        }
        const fresh: RepoState = {
          repo: r,
          closed: false,
          parentWatch: null,
          worktreesWatch: null,
          timer: null,
          listing: null,
          rerun: false,
          raw: null,
          last: null,
          publishing: Promise.resolve(),
          failLogged: false,
          watchFailed: false,
          lastMtime: null,
          lastFocusListAt: Number.NEGATIVE_INFINITY
        }
        repos.set(r.repoId, fresh)
        armWatches(fresh)
        void list(fresh)
      }
    },
    close() {
      for (const s of repos.values()) closeRepo(s)
      repos.clear()
      offFocus()
    }
  }
}
