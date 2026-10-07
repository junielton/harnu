/**
 * Imperative shell wiring the Reaper cleanup engine (scanner + executor + journal)
 * to IPC. Request/response channels (`reaper:snapshot/scan/clean/sweep/journal/
 * prefs/setPrefs`) plus push streams (`reaper:update`, `reaper:progress`,
 * `reaper:harvestable`).
 *
 * Deletion is UI-only by design (matches `worktree:remove`) — there is
 * deliberately no MCP verb here, so `docs/harnu-features.md` stays untouched.
 *
 * Slice 2 (plan Task 13) adds a prefs-driven hourly background scan: an
 * `initialTimer` + `intervalTimer` pair (pattern: `claude-changelog.ts`),
 * single-flighted via `tickRunning` so an in-flight tick is never doubled up
 * by a manual "Scan now". `neverDeleteRemote` is enforced HERE, not just
 * hidden in the UI — `reaper:clean`/`reaper:sweep` force `deleteRemote: false`
 * whenever the kill switch is on, regardless of what the renderer sent.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ipcMain, shell, type BrowserWindow } from 'electron'
import {
  scanAll,
  scanIdle,
  lastSnapshot,
  isFolderInUse,
  readRepoManifest,
  reaperExec,
  type ScanOptions
} from './scanner-shell'
import { newlyHarvestable, type ReaperSnapshot } from './scan-core'
import type { ReapItem } from './reaper-core'
import { cleanItem, sweep, type CleanResult, type ExecutorDeps } from './executor-core'
import { appendTombstone, readJournal, type Tombstone } from './journal'
import { archiveTip, archiveWip } from './archive-shell'
import { defaultPrefs, normalizePrefs, readPrefs, writePrefs, type ReaperPrefs } from './prefs'
import {
  dehydrateItem,
  rehydrateItem,
  toSetupOutcome,
  withDehydrated,
  withRehydrated,
  type DehydrateDeps,
  type DehydrateResult,
  type RehydrateDeps,
  type RehydrateResult
} from './dehydrate-core'
import {
  forgetMeasure,
  probeEphemeralEntries,
  removeEphemeralDir,
  trackedFingerprint
} from './dehydrate-shell'
import { updateHydrationFile } from './hydration-store'
import {
  probeWorktreeStatus,
  hasUnpushedCommits,
  runManifestCommand,
  assertPosixShellAvailable
} from '../worktree-ipc'
import { spawnEnvOnce } from '../appimage-env'
import { removeGhostFolder } from '../user-projects'

const runFile = promisify(execFile)
const GIT_OPTS = { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 } as const

/** How long after registration the first background tick fires. */
const INITIAL_DELAY_MS = 60_000

function findItem(itemId: string): ReapItem | undefined {
  const snap = lastSnapshot()
  if (!snap) return undefined
  for (const repo of snap.repos) {
    const hit = repo.items.find((i) => i.id === itemId)
    if (hit) return hit
  }
  return undefined
}

/**
 * Build the executor deps closing over `getWindow` so `detachSidebar`
 * (BUG-56) can emit `folders:removed` after the trash-folder step has
 * already deleted the directory. `removeGhostFolder` refuses (no-op, never
 * throws) if the directory somehow still exists — this step only ever runs
 * after a successful `trash-folder`, so that should never happen in practice.
 */
export function buildDeps(getWindow: () => BrowserWindow | null): ExecutorDeps {
  return {
    // BUG-75: the executor re-probes TRACKED dirtiness only. `isWorktreeDirty`
    // stays wired to `worktree:remove`, whose stricter gate this must not touch.
    probeStatus: probeWorktreeStatus,
    hasUnpushed: hasUnpushedCommits,
    trash: (p) => shell.trashItem(p),
    git: async (repo, args) => (await runFile('git', ['-C', repo, ...args], GIT_OPTS)).stdout,
    resolveSha: async (repo, rev) => {
      try {
        return (
          await runFile('git', ['-C', repo, 'rev-parse', '--verify', `${rev}^{commit}`], GIT_OPTS)
        ).stdout.trim()
      } catch {
        return null
      }
    },
    archiveTip,
    archiveWip,
    detachSidebar: async (p) => {
      await removeGhostFolder(getWindow, p)
    },
    appendTombstone,
    now: () => Date.now()
  }
}

/**
 * Deps for dehydrate / rehydrate (T250). Guard 4 is `isFolderInUse` — probed
 * fresh inside `dehydrateItem` / `rehydrateItem`, never read off the snapshot.
 */
export function buildHydrationDeps(): { dehydrate: DehydrateDeps; rehydrate: RehydrateDeps } {
  const fingerprint = (wt: string): ReturnType<typeof trackedFingerprint> =>
    trackedFingerprint(reaperExec, wt)
  return {
    dehydrate: {
      isSessionLive: isFolderInUse,
      readManifest: readRepoManifest,
      probeEntries: (wt, entries) => probeEphemeralEntries(reaperExec, wt, entries),
      trackedFingerprint: fingerprint,
      removeDir: removeEphemeralDir,
      recordDehydrated: async (wt, removed) => {
        forgetMeasure(wt)
        await updateHydrationFile((f) => withDehydrated(f, wt, removed, Date.now()))
      }
    },
    rehydrate: {
      isSessionLive: isFolderInUse,
      readManifest: readRepoManifest,
      preflightShell: (setup) => assertPosixShellAvailable(setup.length > 0),
      // The same runner `create_worktree`'s setup loop uses — same shell, same
      // login-PATH env, same 10-minute budget, same failure classification.
      runSetupStep: async (command, cwd) => {
        try {
          await runManifestCommand(command, cwd)
          return { ok: true }
        } catch (err) {
          return toSetupOutcome(err, command)
        }
      },
      setupPath: async () => (await spawnEnvOnce()).PATH,
      trackedFingerprint: fingerprint,
      recordRehydrated: async (wt, changed, ok) => {
        forgetMeasure(wt)
        await updateHydrationFile((f) => withRehydrated(f, wt, changed, ok, Date.now()))
      }
    }
  }
}

function staleDehydrateResult(itemId: string): DehydrateResult {
  return {
    itemId,
    ok: false,
    removed: [],
    skipped: [],
    failed: [],
    trackedChanged: [],
    error: 'unknown or stale reaper item id; rescan and retry'
  }
}

export interface HarvestableAlert {
  count: number
  reclaimableBytes: number
}

/**
 * The handle the workspace GC uses to ride the Reaper timer instead of owning a second one:
 * one clock, one scan, then the cycle in the same tick.
 */
export interface ReaperControl {
  /** Runs after every scheduled scan, inside the same tick (single-flighted with it). */
  setAfterScan(hook: (() => Promise<void>) | null): void
  /** While this answers true, a scheduled tick is skipped (a cleaning job is running). */
  setBusy(check: (() => boolean) | null): void
  /** Clamped and persisted like any Reaper pref; reschedules the timer. */
  setIntervalMs(intervalMs: number): Promise<void>
  /** Epoch ms of the next scheduled tick, or null while the background scan is off. */
  nextTickAt(): number | null
  /** Whether the background scan (and with it the autopilot) is switched on. */
  autoScan(): boolean
}

/** Register the Reaper IPC handlers. */
export function registerReaperHandlers(getWindow: () => BrowserWindow | null): ReaperControl {
  const deps = buildDeps(getWindow)
  const hydrationDeps = buildHydrationDeps()
  // Dehydrate/rehydrate run one at a time, and never while a scan walks the same
  // trees: each op waits for `scanIdle()`, and the scheduled tick skips while an
  // op is queued. A `du` racing a recursive removal reports a wrong number, not
  // an error — the worse failure — so the two are serialized, not raced.
  let opChain: Promise<unknown> = Promise.resolve()
  let opsPending = 0
  const runOp = <T>(fn: () => Promise<T>): Promise<T> => {
    opsPending++
    const run = opChain.then(async () => {
      await scanIdle()
      return fn()
    })
    opChain = run.catch(() => undefined)
    return run.finally(() => {
      opsPending--
    })
  }
  const opsIdle = (): Promise<unknown> => opChain
  // Cache updated on every prefs read/write; the scheduler and the
  // prefs-driven scan options both read from this instead of hitting disk
  // on every tick.
  let currentPrefs: ReaperPrefs = defaultPrefs()
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let tickRunning = false
  let afterScan: (() => Promise<void>) | null = null
  let gcBusy: (() => boolean) | null = null
  let nextAt: number | null = null

  const pushUpdate = (snap: ReaperSnapshot): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('reaper:update', snap)
  }
  const pushProgress = (result: CleanResult): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('reaper:progress', result)
  }
  const pushDehydrateProgress = (result: DehydrateResult): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('reaper:dehydrateProgress', result)
  }
  const pushHarvestable = (alert: HarvestableAlert): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('reaper:harvestable', alert)
  }
  const rescanAndPush = async (repoPaths: string[]): Promise<void> => {
    if (repoPaths.length === 0) return
    const snap = await scanAll({
      repoPaths: [...new Set(repoPaths)],
      force: false,
      protectedBranches: currentPrefs.protectedBranches
    })
    pushUpdate(snap)
  }

  const clearSchedule = (): void => {
    if (initialTimer) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
    if (intervalTimer) {
      clearInterval(intervalTimer)
      intervalTimer = null
    }
  }

  const runScheduledTick = async (): Promise<void> => {
    if (tickRunning) return // single-flight: never stack a tick on a slow scan
    if (opsPending > 0) return // a dehydrate/rehydrate is walking these trees; next tick
    if (gcBusy?.()) return // a cleaning job is removing worktrees; scan after it
    tickRunning = true
    try {
      const prev = lastSnapshot()
      const next = await scanAll({ protectedBranches: currentPrefs.protectedBranches })
      pushUpdate(next)
      const grown = newlyHarvestable(prev, next).filter(
        (item) => item.ageDays === null || item.ageDays >= currentPrefs.minAgeDays
      )
      if (grown.length > 0 && currentPrefs.notifyOnHarvestable) {
        const reclaimableBytes = grown.reduce((sum, item) => sum + (item.diskBytes ?? 0), 0)
        pushHarvestable({ count: grown.length, reclaimableBytes })
      }
      // Workspace GC: the cycle rides this tick, so there is still exactly one timer. A
      // failing cycle must never take the scan schedule down with it.
      if (afterScan) {
        try {
          await afterScan()
        } catch (err) {
          console.error('[reaper] post-scan hook failed', err)
        }
      }
    } finally {
      tickRunning = false
    }
  }

  /** (Re)arms the timer pair from `currentPrefs`. A no-op scan schedule when `autoScan` is off. */
  const scheduleTicks = (): void => {
    clearSchedule()
    nextAt = null
    if (!currentPrefs.autoScan) return
    nextAt = Date.now() + INITIAL_DELAY_MS
    initialTimer = setTimeout(() => {
      initialTimer = null
      void runScheduledTick()
      nextAt = Date.now() + currentPrefs.intervalMs
      intervalTimer = setInterval(() => {
        nextAt = Date.now() + currentPrefs.intervalMs
        void runScheduledTick()
      }, currentPrefs.intervalMs)
    }, INITIAL_DELAY_MS)
  }

  ipcMain.handle('reaper:snapshot', (): ReaperSnapshot | null => lastSnapshot())

  ipcMain.handle('reaper:scan', async (_e, force?: boolean): Promise<ReaperSnapshot> => {
    const opts: ScanOptions = {
      protectedBranches: currentPrefs.protectedBranches,
      ...(force === true ? { force: true } : {})
    }
    await opsIdle()
    const snap = await scanAll(opts)
    pushUpdate(snap)
    return snap
  })

  ipcMain.handle(
    'reaper:clean',
    async (
      _e,
      { itemId, deleteRemote }: { itemId: string; deleteRemote: boolean }
    ): Promise<CleanResult> => {
      const item = findItem(itemId)
      if (!item) throw new Error(`unknown or stale reaper item id: ${itemId}; rescan and retry`)
      const effectiveDeleteRemote = currentPrefs.neverDeleteRemote ? false : deleteRemote
      const result = await cleanItem(item, { deleteRemote: effectiveDeleteRemote }, deps)
      await rescanAndPush([item.repoPath])
      return result
    }
  )

  ipcMain.handle(
    'reaper:sweep',
    async (
      _e,
      { itemIds, deleteRemote }: { itemIds: string[]; deleteRemote: boolean }
    ): Promise<CleanResult[]> => {
      const items: ReapItem[] = []
      const missing: string[] = []
      for (const id of itemIds) {
        const item = findItem(id)
        if (item) items.push(item)
        else missing.push(id)
      }
      if (items.length === 0) {
        throw new Error(`no known reaper items among the given ids: ${missing.join(', ')}`)
      }
      const effectiveDeleteRemote = currentPrefs.neverDeleteRemote ? false : deleteRemote
      const results = await sweep(
        items,
        { deleteRemote: effectiveDeleteRemote },
        deps,
        pushProgress
      )
      await rescanAndPush(items.map((i) => i.repoPath))
      return results
    }
  )

  // T250 — dehydrate. Works on any verdict except a folder in use: the guards,
  // not the merge status, decide. Per-item results stream on
  // `reaper:dehydrateProgress` so the confirm dialog ticks row by row.
  ipcMain.handle(
    'reaper:dehydrate',
    async (_e, { itemIds }: { itemIds: string[] }): Promise<DehydrateResult[]> => {
      const known = itemIds.map((id) => ({ id, item: findItem(id) }))
      const items = known.flatMap((k) => (k.item ? [k.item] : []))
      const results = await runOp(async () => {
        const out: DehydrateResult[] = []
        for (const { id, item } of known) {
          const result = item
            ? await dehydrateItem(item, hydrationDeps.dehydrate)
            : staleDehydrateResult(id)
          out.push(result)
          pushDehydrateProgress(result)
        }
        return out
      })
      await rescanAndPush(items.map((i) => i.repoPath))
      return results
    }
  )

  ipcMain.handle(
    'reaper:rehydrate',
    async (_e, { itemId }: { itemId: string }): Promise<RehydrateResult> => {
      const item = findItem(itemId)
      if (!item) throw new Error(`unknown or stale reaper item id: ${itemId}; rescan and retry`)
      const result = await runOp(() => rehydrateItem(item, hydrationDeps.rehydrate))
      await rescanAndPush([item.repoPath])
      return result
    }
  )

  ipcMain.handle('reaper:journal', (): Promise<Tombstone[]> => readJournal())

  ipcMain.handle('reaper:prefs', async (): Promise<ReaperPrefs> => {
    currentPrefs = await readPrefs()
    return currentPrefs
  })

  ipcMain.handle('reaper:setPrefs', async (_e, raw: unknown): Promise<ReaperPrefs> => {
    currentPrefs = normalizePrefs(raw)
    await writePrefs(currentPrefs)
    scheduleTicks()
    return currentPrefs
  })

  void (async () => {
    currentPrefs = await readPrefs()
    scheduleTicks()
  })()

  return {
    setAfterScan: (hook) => {
      afterScan = hook
    },
    setBusy: (check) => {
      gcBusy = check
    },
    setIntervalMs: async (intervalMs) => {
      currentPrefs = normalizePrefs({ ...currentPrefs, intervalMs })
      await writePrefs(currentPrefs)
      scheduleTicks()
    },
    nextTickAt: () => nextAt,
    autoScan: () => currentPrefs.autoScan
  }
}
