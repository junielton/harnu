/**
 * Reload on change for a page pane (T564 U2, spec §4.4), the pure half: the per-pane dependency set (capped at
 * 500), the planner that turns a file event into an action, and the 150 ms debounce. The chokidar and
 * `webContents` shell lives in `page-service.ts`.
 */
import * as path from 'node:path'

export const MAX_WATCH_DEPENDENCIES = 500
export const RELOAD_DEBOUNCE_MS = 150

export type WatchEventKind = 'add' | 'change' | 'unlink'

export type WatchAction = 'reload' | 'removed' | 'restored' | 'ignore'

export interface DependencySet {
  /** Add a file the handler served; `false` when the set is full (the file is then simply not watched). */
  add(file: string): boolean
  has(file: string): boolean
  readonly size: number
  files(): string[]
  clear(): void
}

/** The files a pane's page pulled in, capped so a page with thousands of assets cannot exhaust watchers. */
export function createDependencySet(max = MAX_WATCH_DEPENDENCIES): DependencySet {
  const set = new Set<string>()
  return {
    add(file) {
      if (set.has(file)) return true
      if (set.size >= max) return false
      set.add(file)
      return true
    },
    has: (file) => set.has(file),
    get size() {
      return set.size
    },
    files: () => [...set],
    clear: () => set.clear()
  }
}

/**
 * What a file event means for the pane. The served HTML file itself being deleted shows the "file removed"
 * placeholder and its re-creation restores the page; any other dependency changing reloads it; a dependency
 * disappearing reloads too (the page then shows its own broken asset). Events for files the pane never loaded
 * are ignored.
 */
export function planWatchEvent(
  kind: WatchEventKind,
  file: string,
  ctx: { mainFile: string; deps: DependencySet; mainRemoved: boolean }
): WatchAction {
  const isMain = path.resolve(file) === path.resolve(ctx.mainFile)
  if (isMain) {
    if (kind === 'unlink') return 'removed'
    if (ctx.mainRemoved) return 'restored'
    return 'reload'
  }
  if (!ctx.deps.has(file)) return 'ignore'
  return 'reload'
}

export interface DebounceTimers {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** Collapses a burst of events (an editor's save writes several) into one call after `ms` of quiet. */
export function createDebouncer(
  fn: () => void,
  timers: DebounceTimers,
  ms = RELOAD_DEBOUNCE_MS
): { trigger(): void; cancel(): void } {
  let handle: unknown = null
  return {
    trigger() {
      if (handle !== null) timers.clearTimer(handle)
      handle = timers.setTimer(() => {
        handle = null
        fn()
      }, ms)
    },
    cancel() {
      if (handle !== null) timers.clearTimer(handle)
      handle = null
    }
  }
}
