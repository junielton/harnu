/**
 * The workspace-GC service and its IPC surface (design: workspace-gc §6, slice 3).
 *
 * Request/response channels `gc:snapshot/clean/keep/unkeep/prefs:get/prefs:set/
 * ackFirstReport/jobs/opinion`, plus the `gc:progress`, `gc:done`, `gc:cycle`,
 * `gc:opinion:result` and `gc:opinion:done` pushes. There is no
 * timer here: the cycle rides the Reaper tick through `ReaperControl.setAfterScan`, so the
 * scan and the clean share one clock. Cleaning is UI-only on purpose: no MCP verb reaches it.
 *
 * Every decision lives in a tested core (`planCycle`, `refusalFor`, the job queue, the cycle
 * and manual-clean orchestrators). This file only wires them to electron, docker and disk.
 */

import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { Notification, app, ipcMain, type BrowserWindow } from 'electron'
import { buildNotificationOptions } from '../notifications'
import { prefsFile as containersPrefsFile } from '../containers/containers-prefs'
import { prefsPath as reaperPrefsPath } from '../reaper/prefs'
import type { ReaperControl } from '../reaper/reaper-ipc'
import { bucketFeed, setInheritedBuckets } from './gc-buckets'
import { withActor } from './gc-actor'
import { pressKeep, protectedFromGather } from './gc-keep'
import {
  LEFTOVERS_FILE,
  readLeftovers,
  withLeftovers,
  writeLeftovers,
  type Leftover
} from './gc-leftovers'
import { createCycleState, runGcCycle, type GcCycleDeps, type GcGather } from './gc-cycle'
import { gatherGc, type GcGathered } from './gc-scan-shell'
import { createAgentService, createGatherer } from './gc-gatherer'
import { setGcService } from './gc-service-registry'
import { createJobQueue, type GcJobInfo } from './gc-jobs-core'
import { submitManualClean } from './gc-manual'
import { recheckItem } from './gc-recheck'
import {
  mergeIncomingPrefs,
  prefsFile,
  readGcPrefs,
  withAcknowledged,
  withoutKeep,
  writeGcPrefs,
  type GcPrefs
} from './gc-prefs'
import { parseOptions } from './gc-options'
import type { GcCleanAck, GcRecheckResult, GcSnapshot, OrphanVolumeItem } from './gc-wire'
import { createGcOps, defaultGcShellDeps, type GcShellDeps } from './gc-shell'
import { createForcedGcOps } from './gc-forced-ops'
import { runHousekeeping } from './housekeeping-shell'
import {
  createOpinionCache,
  createOpinionService,
  type GcOpinionAck,
  type Opinion as GcOpinion
} from './opinion-core'
import { createOpinionShell } from './opinion-shell'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface GcService {
  snapshot(opts?: { refresh?: boolean }): Promise<GcSnapshot>
  clean(ids: unknown, opts: unknown): GcCleanAck
  keep(id: unknown): Promise<GcPrefs>
  unkeep(id: unknown): Promise<GcPrefs>
  /** "Check again" on a demoted item: forgets its remembered refusal and reprobes it once (read-only). */
  recheck(id: unknown): Promise<GcRecheckResult>
  prefs(): GcPrefs
  setPrefs(raw: unknown): Promise<GcPrefs>
  ackFirstReport(): Promise<GcPrefs>
  jobs(): GcJobInfo[]
  /** "Ask for an opinion": on demand only, read-only, advisory. Never removes anything. */
  opinion(ids: unknown): GcOpinionAck
  /** The peek: cached opinions that still match their item. Never asks the model. */
  opinionCached(ids: unknown): Promise<Record<string, GcOpinion>>
}

/** Ids from an untrusted payload: strings only, bounded. */
function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('gc:clean expects an array of ids')
  const ids = raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
  if (ids.length !== raw.length) throw new Error('gc:clean ids must be non-empty strings')
  if (ids.length > 500) throw new Error('gc:clean takes at most 500 ids')
  return ids
}

/** Registers the handlers and arms the cycle on the Reaper tick. */
export async function registerGcHandlers(
  getWindow: () => BrowserWindow | null,
  reaper: ReaperControl,
  iconPath: string
): Promise<GcService> {
  const userData = app.getPath('userData')
  const file = prefsFile(userData)
  let prefs: GcPrefs = await readGcPrefs(file, {
    reaper: reaperPrefsPath(),
    containers: containersPrefsFile(userData)
  })
  const state = createCycleState()
  /** When each Keep was last written, and which are still waiting for a fresh gather. */
  const keepWrites = new Map<string, number>()
  const provisionalKeeps = new Set<string>()
  // What cleaned worktrees left in Docker, so their volumes can be offered for review (D1).
  const leftoversFile = path.join(userData, LEFTOVERS_FILE)
  let leftovers = readLeftovers(leftoversFile)
  const remember = (entries: Leftover[]): void => {
    if (entries.length === 0) return
    leftovers = withLeftovers(leftovers, entries)
    writeLeftovers(leftoversFile, leftovers)
  }
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const persist = async (next: GcPrefs): Promise<GcPrefs> => {
    prefs = next
    await writeGcPrefs(file, prefs)
    return prefs
  }

  /**
   * One gather at a time; it also feeds the Containers view and clears outdated marks. A
   * halted item reads Needs review here, once, for the snapshot, the feed, the jobs and the
   * cycle. The persistence rules (which marks a gather may clear, what it writes) live in
   * `gc-gatherer`, where they are tested.
   */
  const gatherer = createGatherer({
    prefs: () => prefs,
    persistPrefs: persist,
    gatherGc,
    state,
    leftovers: {
      get: () => leftovers,
      set: (next) => {
        leftovers = next
        writeLeftovers(leftoversFile, leftovers)
      }
    },
    feed: (g) => setInheritedBuckets(bucketFeed(g.bundles, g.canonical)),
    // A Keep pressed meanwhile (or still provisional) must survive a verdict on older prefs.
    protectedKeeps: (startedAt) => protectedFromGather(keepWrites, provisionalKeeps, startedAt),
    now: () => Date.now()
  })
  const gather = (): Promise<GcGathered> => gatherer.gather()

  /** A gather that STARTS after this call: waits for the one in flight, which may predate it. */
  const gatherFresh = (): Promise<GcGathered> => gatherer.fresh()

  /** Orphan volumes per a gather that starts now (see ManualCleanDeps.freshOrphans). */
  const freshOrphans = async (): Promise<OrphanVolumeItem[]> => (await gatherFresh()).orphanVolumes

  const queue = createJobQueue({
    newId: () => randomUUID(),
    // On the Reaper's op chain: after a running scan and any queued sweep or dehydrate,
    // and before the next one, so the two never remove things at the same time.
    around: (work) => reaper.runExclusive(work),
    emitProgress: (p) => send('gc:progress', p),
    emitDone: (d) => {
      send('gc:done', d)
      // The world changed: refresh what the Cleanup surface and the Containers view read.
      void gather().catch((err) => console.error('[gc] refresh after job failed', err))
    }
  })

  const shellDeps = await defaultGcShellDeps(getWindow)
  const withRun = (actor: 'operator' | 'autopilot'): GcShellDeps =>
    withActor(shellDeps, actor, () => prefs)

  const notify = (n: { title: string; body: string }): void => {
    try {
      if (!Notification.isSupported()) return
      const note = new Notification(buildNotificationOptions(n, iconPath))
      note.on('click', () => {
        const win = getWindow()
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })
      note.show()
    } catch (err) {
      console.error('[gc] notification failed', err)
    }
  }

  const cycleDeps: GcCycleDeps = {
    prefs: () => prefs,
    gather: async (): Promise<GcGather> => gather(),
    opsFor: () => createGcOps(withRun('autopilot')),
    queue,
    housekeeping: (plan) => runHousekeeping(plan),
    notify,
    emitCycle: (record) => send('gc:cycle', record),
    rememberLeftovers: remember,
    state,
    now: () => Date.now()
  }

  reaper.setAfterScan(async () => {
    await runGcCycle(cycleDeps, 'timer')
  })
  reaper.setBusy(() => queue.busy())

  /** The Reaper timer owns the interval, so its live value is the one shown. */
  const livePrefs = (): GcPrefs => ({ ...prefs, intervalMs: reaper.intervalMs() })

  const buildSnapshot = (g: GcGathered): GcSnapshot => ({
    scannedAt: g.scannedAt,
    bundles: g.bundles,
    orphanVolumes: g.orphanVolumes,
    docker: g.docker,
    prefs: livePrefs(),
    lastCycle: state.last,
    nextCycleAt: reaper.autoScan() ? reaper.nextTickAt() : null
  })

  // The advisor is reachable from the `gc:opinion` handler below and from nowhere else: the
  // cycle, the timer and the autopilot never touch it (tests/gc-opinion-wiring.test.ts).
  const opinions = createOpinionService({
    cache: createOpinionCache(),
    ...createOpinionShell({
      current: async () => gatherer.cached() ?? (await gather()),
      git: shellDeps.executor.git
    }),
    emitResult: (r) => send('gc:opinion:result', r),
    emitDone: (d) => send('gc:opinion:done', d),
    newId: () => randomUUID()
  })

  const service: GcService = {
    snapshot: async (opts) =>
      buildSnapshot(opts?.refresh || !gatherer.cached() ? await gather() : gatherer.cached()!),
    clean: (rawIds, rawOpts) =>
      submitManualClean(
        {
          prefs: () => prefs,
          gather,
          opsFor: (_actor, forced) =>
            forced ? createForcedGcOps(withRun('operator')) : createGcOps(withRun('operator')),
          // S4's runner builds the argv itself (`docker volume rm <name>`, name-checked).
          freshOrphans,
          removeOrphanVolumes: (names) =>
            runHousekeeping({
              builderPruneUntilHours: null,
              danglingImages: false,
              orphanVolumes: names
            }),
          rememberLeftovers: remember,
          queue,
          state,
          now: () => Date.now()
        },
        parseIds(rawIds),
        parseOptions(rawOpts)
      ),
    keep: async (rawId) => {
      if (typeof rawId !== 'string') throw new Error('gc:keep expects a bundle id')
      const next = await pressKeep(rawId, {
        prefs: () => prefs,
        persist,
        cachedBundles: () => gatherer.cached()?.bundles ?? [],
        gatherFresh: async () => (await gatherFresh()).bundles,
        keepWrites,
        provisionalKeeps,
        now: () => Date.now()
      })
      void gather().catch((err) => console.error('[gc] refresh after keep failed', err))
      return next
    },
    unkeep: async (rawId) => {
      if (typeof rawId !== 'string') throw new Error('gc:unkeep expects a bundle id')
      const next = await persist(withoutKeep(prefs, [rawId]))
      void gather().catch((err) => console.error('[gc] refresh after unkeep failed', err))
      return next
    },
    recheck: async (rawId) => {
      if (typeof rawId !== 'string') throw new Error('gc:recheck expects a bundle id')
      return recheckItem(
        {
          gather: () => gatherer.fresh(),
          // The ordinary ops: their reprobe only reads, and never archives or touches the item.
          reprobe: (b) => createGcOps(withRun('operator')).reprobe(b),
          state,
          now: () => Date.now()
        },
        rawId
      )
    },
    prefs: () => livePrefs(),
    setPrefs: async (raw) => {
      const next = mergeIncomingPrefs(livePrefs(), raw)
      const intervalChanged = next.intervalMs !== reaper.intervalMs()
      await persist(next)
      // The Reaper timer is the one clock, so its interval is the one that must change.
      if (intervalChanged) await reaper.setIntervalMs(next.intervalMs)
      return next
    },
    ackFirstReport: () => persist(withAcknowledged(prefs)),
    jobs: () => queue.jobs(),
    opinion: (ids) => opinions.start(ids),
    opinionCached: (ids) => opinions.cached(ids)
  }

  // The agent-facing seam (T445). Deliberately narrow: no clean, keep or prefs method, and its
  // snapshot never triggers a write (a persisting gather belongs to the timer and the operator).
  setGcService(
    createAgentService({
      gatherer,
      snapshotOf: buildSnapshot,
      prefs: () => prefs,
      persistPrefs: persist
    })
  )

  ipcMain.handle('gc:snapshot', (_e, opts?: { refresh?: boolean }) =>
    service.snapshot({ refresh: opts?.refresh === true })
  )
  ipcMain.handle('gc:clean', (_e, ids: unknown, opts: unknown) => service.clean(ids, opts))
  ipcMain.handle('gc:keep', (_e, id: unknown) => service.keep(id))
  ipcMain.handle('gc:unkeep', (_e, id: unknown) => service.unkeep(id))
  ipcMain.handle('gc:recheck', (_e, id: unknown) => service.recheck(id))
  ipcMain.handle('gc:prefs:get', () => service.prefs())
  ipcMain.handle('gc:prefs:set', (_e, raw: unknown) => service.setPrefs(raw))
  ipcMain.handle('gc:ackFirstReport', () => service.ackFirstReport())
  ipcMain.handle('gc:jobs', () => service.jobs())
  ipcMain.handle('gc:opinion', (_e, ids: unknown) => service.opinion(ids))
  ipcMain.handle('gc:opinion:cached', (_e, ids: unknown) => service.opinionCached(ids))

  // Seed the Containers feed once at start-up so the view is right before the first tick.
  void gather().catch((err) => console.error('[gc] first gather failed:', messageOf(err)))
  return service
}
