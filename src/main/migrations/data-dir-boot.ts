/**
 * Boot wiring for the per-repo data-dir copy ({@link migrateDataDir}): run it for
 * every known folder — each main checkout AND each worktree, because `out/` is
 * per-worktree — before the memory, roadmap and mission watchers bind, then
 * surface any conflict to the operator through the Activity history.
 *
 * Inert only if `DATA_DIR` is still a legacy name (it then returns before it
 * enumerates a single folder); since the flip it runs on every boot. A time ceiling
 * keeps a huge or slow data dir from holding the window: past it, boot moves on and
 * the copy finishes in the background.
 */

import * as path from 'node:path'
import { DATA_DIR, LEGACY_DATA_DIRS } from '../data-dir'
import { migrateDataDir, type DataDirOutcome } from './data-dir'

export interface BootMigrationDeps {
  /** The pinned folders' paths. */
  pinnedFolders: () => Promise<string[]>
  /** Every worktree path of the repo `folder` belongs to (the main checkout included). */
  worktreesOf: (folder: string) => Promise<string[]>
  migrate: (folder: string) => Promise<DataDirOutcome>
  /** Test seam: the target dir name the inert check compares against. Defaults to {@link DATA_DIR}. */
  dataDir?: string
  /**
   * Longest a caller waits for the whole copy. Past it the call resolves with what is
   * settled so far (`timedOut: true`) and the copy carries on in the background —
   * `settled` resolves with the final result. Unset = wait for everything.
   */
  ceilingMs?: number
}

/** How long boot waits for the per-repo copy before carrying on without it. */
export const BOOT_MIGRATION_CEILING_MS = 15_000

export interface BootMigrationResult {
  /** Folders the copy ran for. */
  folders: number
  copied: string[]
  conflicts: string[]
  errors: Array<{ folder: string; message: string }>
  /** The ceiling elapsed before every folder settled; the rest keeps copying in the background. */
  timedOut?: boolean
  /** Only with `timedOut`: resolves with the final result once the background copy is done. */
  settled?: Promise<BootMigrationResult>
}

/** Folders whose conflict notice has not been delivered yet (see {@link flushDataDirConflictNotices}). */
const pendingConflicts = new Set<string>()

/**
 * Run the copy for every known folder. Never throws; resolves once every folder is
 * settled, so awaiting it before binding the watchers guarantees they see the
 * final directory.
 */
export async function migrateKnownFolderDataDirs(
  deps: BootMigrationDeps
): Promise<BootMigrationResult> {
  const result: BootMigrationResult = { folders: 0, copied: [], conflicts: [], errors: [] }
  if (LEGACY_DATA_DIRS.includes(deps.dataDir ?? DATA_DIR)) return result

  const work = runAll(deps, result)
  if (deps.ceilingMs === undefined) {
    await work
    return result
  }
  let timer: NodeJS.Timeout | undefined
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), deps.ceilingMs)
      timer.unref?.()
    })
  ])
  clearTimeout(timer)
  if (!timedOut) return result
  // `result` keeps filling in as the background copy settles, so hand back a snapshot.
  return {
    folders: result.folders,
    copied: [...result.copied],
    conflicts: [...result.conflicts],
    errors: [...result.errors],
    timedOut: true,
    settled: work.then(() => result)
  }
}

/** Enumerate the known folders and copy each, filling `result`. Never throws. */
async function runAll(deps: BootMigrationDeps, result: BootMigrationResult): Promise<void> {
  const folders = new Set<string>()
  try {
    for (const pinned of await deps.pinnedFolders()) {
      folders.add(path.resolve(pinned))
      for (const wt of await deps.worktreesOf(pinned).catch(() => [])) folders.add(path.resolve(wt))
    }
  } catch (err) {
    result.errors.push({ folder: '*', message: err instanceof Error ? err.message : String(err) })
  }

  for (const folder of folders) {
    result.folders++
    const res = await deps.migrate(folder)
    if (res.outcome === 'copied') result.copied.push(folder)
    else if (res.outcome === 'conflict') {
      result.conflicts.push(folder)
      pendingConflicts.add(folder)
    } else if (res.outcome === 'error') result.errors.push({ folder, message: res.message })
  }
}

/** The production wiring: pinned projects from `projects.json`, worktrees from `git worktree list`. */
export async function migrateKnownFolderDataDirsForApp(opts: {
  appVersion: string
  ceilingMs?: number
}): Promise<BootMigrationResult> {
  if (LEGACY_DATA_DIRS.includes(DATA_DIR)) {
    return { folders: 0, copied: [], conflicts: [], errors: [] }
  }
  try {
    const [{ readUserProjects }, { listWorktrees }] = await Promise.all([
      import('../user-projects'),
      import('../worktree-ipc')
    ])
    return await migrateKnownFolderDataDirs({
      pinnedFolders: async () => (await readUserProjects()).projects.map((p) => p.path),
      worktreesOf: async (folder) => (await listWorktrees(folder)).map((w) => w.path),
      migrate: (folder) => migrateDataDir(folder, { appVersion: opts.appVersion }),
      ceilingMs: opts.ceilingMs ?? BOOT_MIGRATION_CEILING_MS
    })
  } catch (err) {
    // Boot must never wait on, or die from, this: report and carry on.
    return {
      folders: 0,
      copied: [],
      conflicts: [],
      errors: [{ folder: '*', message: err instanceof Error ? err.message : String(err) }]
    }
  }
}

const NOTICE_RETRY_MS = 2_000
const NOTICE_MAX_TRIES = 30

export interface NoticeDeps {
  dispatch: (command: string, payload: unknown) => Promise<unknown>
  wait?: (ms: number) => Promise<void>
}

/**
 * Raise one Activity-history notice per conflicting folder, through the same
 * `notify.push` command the Scheduler uses. The bridge refuses to dispatch until
 * the renderer has announced itself, so each notice is retried for a minute before
 * it is dropped. Resolves when every pending notice is delivered or abandoned.
 */
export async function flushDataDirConflictNotices(deps: NoticeDeps): Promise<void> {
  const wait = deps.wait ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const folders = [...pendingConflicts]
  pendingConflicts.clear()
  await Promise.all(
    folders.map(async (folder) => {
      for (let attempt = 0; attempt < NOTICE_MAX_TRIES; attempt++) {
        try {
          await deps.dispatch('notify.push', {
            folderPath: folder,
            title: `Data folder not migrated: ${path.basename(folder)}`,
            description:
              `Both ${LEGACY_DATA_DIRS[0]}/ and ${DATA_DIR}/ exist in ${folder}, and ${DATA_DIR}/ is not a copy ` +
              `Harnu made. Nothing was copied or merged. Move or delete one of them to resolve it.`,
            kind: 'warning'
          })
          return
        } catch {
          await wait(NOTICE_RETRY_MS)
        }
      }
    })
  )
}

// ---- Folders that become known after boot -------------------------------------

/** Where a late conflict notice goes once boot has wired the command bridge (see {@link setDataDirNoticeSink}). */
let noticeSink: NoticeDeps | null = null

/**
 * Register the dispatcher late notices use. Until it is set (before the bridge
 * exists) a conflict just waits in the pending set for boot's own flush.
 */
export function setDataDirNoticeSink(sink: NoticeDeps | null): void {
  noticeSink = sink
}

/**
 * Copy the data dir of a folder that became known AFTER boot (a pinned or adopted
 * folder) — the boot pass only saw the folders that existed then. Waits at most
 * `ceilingMs` (the copy keeps going in the background past it), never throws, and
 * raises the same Activity notice as boot when both dirs exist.
 */
export async function migrateFolderDataDirLazily(
  folder: string,
  opts: {
    appVersion?: string
    ceilingMs?: number
    /** Test seam. */
    migrate?: (folder: string) => Promise<DataDirOutcome>
    dataDir?: string
  } = {}
): Promise<DataDirOutcome | { outcome: 'timeout' }> {
  if (LEGACY_DATA_DIRS.includes(opts.dataDir ?? DATA_DIR)) return { outcome: 'inactive' }
  const run = (opts.migrate ?? ((f) => migrateDataDir(f, { appVersion: opts.appVersion })))(
    path.resolve(folder)
  )
    .catch((err): DataDirOutcome => ({
      outcome: 'error',
      message: err instanceof Error ? err.message : String(err)
    }))
    .then((res) => {
      if (res.outcome === 'conflict') {
        pendingConflicts.add(path.resolve(folder))
        if (noticeSink) void flushDataDirConflictNotices(noticeSink)
      } else if (res.outcome === 'error') {
        console.warn(`[data-dir] copy failed for ${folder}:`, res.message)
      }
      return res
    })
  let timer: NodeJS.Timeout | undefined
  const ceiling = opts.ceilingMs ?? BOOT_MIGRATION_CEILING_MS
  const first = await Promise.race([
    run,
    new Promise<{ outcome: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ outcome: 'timeout' }), ceiling)
      timer.unref?.()
    })
  ])
  clearTimeout(timer)
  return first
}
