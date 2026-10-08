/**
 * The Containers service and its IPC wiring (T320 U1).
 *
 * Request/response channels `containers:snapshot/scan/act/journal/prefs/
 * setPrefs`, plus the `containers:update` and `containers:newZombies` pushes. A
 * prefs-driven background scan (the Reaper's `initialTimer` + `intervalTimer`
 * pair, single-flighted) keeps the snapshot fresh while the view is closed.
 *
 * The new-zombie alert (T332, PRD §6) fires ONCE per stack: every stack that
 * has ever been alerted on is remembered in `<userData>/${NOTIFIED_FILE}`, so
 * neither a later scan nor a restart repeats it. A stack is forgotten only when
 * it disappears from docker (removed), so a recreated stack is a new stack.
 * Stacks that turn zombie while the pref is off are remembered too: switching
 * the pref on later never replays them.
 *
 * {@link getContainersService} is the seam the MCP verbs (T328/T329) call: the
 * same service, the same {@link runContainersAction}, so the tiers hold for an
 * agent exactly as for the renderer (PRD §7.4).
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { runContainersAction, type ActionDeps } from './containers-actions'
import { unavailableSnapshot } from './containers-core'
import { appendTombstone, journalFile, readJournal } from './containers-journal'
import { normalizePrefs, prefsFile, readPrefs, writePrefs } from './containers-prefs'
import { dockerActions, scanContainers, type ScanRequest } from './containers-shell'
import type {
  ActResult,
  Actor,
  ContainersPrefs,
  ContainersSnapshot,
  NewZombiesAlert,
  StackRow,
  Tombstone
} from './containers-wire'

/** How long after start-up the first background scan fires. */
export const INITIAL_DELAY_MS = 60_000
const JOURNAL_LIMIT = 50
export const NOTIFIED_FILE = 'containers-zombies-notified.json'

/**
 * Pure: the zombies not alerted on before, and the set to remember next. An id
 * that is no longer in docker is forgotten; every current zombie is kept, so a
 * stack that leaves `zombie` and comes back is not new.
 */
export function diffNewZombies(
  seen: ReadonlySet<string>,
  stacks: readonly StackRow[]
): { fresh: StackRow[]; seen: Set<string> } {
  const present = new Set(stacks.map((s) => s.id))
  const next = new Set([...seen].filter((id) => present.has(id)))
  const fresh: StackRow[] = []
  for (const s of stacks) {
    if (s.verdict !== 'zombie') continue
    if (!next.has(s.id)) fresh.push(s)
    next.add(s.id)
  }
  return { fresh, seen: next }
}

export function notifiedFile(userDataDir: string): string {
  return path.join(userDataDir, NOTIFIED_FILE)
}

async function readNotified(file: string): Promise<Set<string>> {
  try {
    const ids = (JSON.parse(await fs.readFile(file, 'utf8')) as { stacks?: unknown }).stacks
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Atomic: write `<file>.tmp`, then rename over the target. */
async function writeNotified(file: string, ids: ReadonlySet<string>): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify({ version: 1, stacks: [...ids] }) + '\n', 'utf8')
  await fs.rename(tmp, file)
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id))
}

export interface ContainersServiceDeps {
  scan(req: ScanRequest): Promise<ContainersSnapshot>
  docker: Pick<ActionDeps, 'stop' | 'start' | 'removeContainers' | 'removeVolumes'>
  userDataDir: string
  push(snap: ContainersSnapshot): void
  /** The new-zombie alert; called only while `notifyOnNewZombies` is on. */
  alert?(alert: NewZombiesAlert): void
  now(): number
}

export interface ContainersService {
  /** The last snapshot, or null before the first scan. */
  snapshot(): ContainersSnapshot | null
  /** A scan started now (after any in flight); stores and pushes it. */
  scan(): Promise<ContainersSnapshot>
  /** THE action entry point, serialized: one action at a time. */
  act(raw: unknown, actor: Actor): Promise<ActResult>
  journal(limit?: number): Promise<Tombstone[]>
  prefs(): Promise<ContainersPrefs>
  setPrefs(raw: unknown): Promise<ContainersPrefs>
  /** Reads prefs and arms the background scan. */
  start(): Promise<void>
  /** Disarms the background scan. */
  stop(): void
}

export function createContainersService(deps: ContainersServiceDeps): ContainersService {
  const journalPath = journalFile(deps.userDataDir)
  const prefsPath = prefsFile(deps.userDataDir)
  let prefs: ContainersPrefs = normalizePrefs(null)
  // Bumped by every save. A read that began before a save must not replace what the save stored.
  let prefsSaves = 0
  /** Reads the file; the result becomes the service's prefs only when no save happened meanwhile. */
  const loadPrefs = async (): Promise<ContainersPrefs> => {
    const savesBefore = prefsSaves
    const read = await readPrefs(prefsPath)
    if (savesBefore !== prefsSaves) return prefs
    prefs = read
    return prefs
  }
  let last: ContainersSnapshot | null = null
  let inflight: Promise<ContainersSnapshot> | null = null
  let actChain: Promise<unknown> = Promise.resolve()
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let tickRunning = false
  const notifiedPath = notifiedFile(deps.userDataDir)
  let notified: Set<string> | null = null

  /** Every scan counts, whoever asked for it. Scans are serialized by `freshScan`. */
  const noteNewZombies = async (snap: ContainersSnapshot): Promise<void> => {
    if (!snap.dockerAvailable) return // an outage is not every stack leaving
    const known = notified ?? (await readNotified(notifiedPath))
    const { fresh, seen } = diffNewZombies(known, snap.stacks)
    notified = seen
    if (!sameIds(known, seen)) {
      await writeNotified(notifiedPath, seen).catch((err) =>
        console.error('[containers] could not persist notified zombies', err)
      )
    }
    if (fresh.length > 0 && prefs.notifyOnNewZombies) {
      deps.alert?.({ count: fresh.length, names: fresh.map((s) => s.name) })
    }
  }

  const runScan = async (): Promise<ContainersSnapshot> => {
    const now = deps.now()
    const journal = await readJournal(journalPath)
    let snap: ContainersSnapshot
    try {
      snap = await deps.scan({ zombieAfterDays: prefs.zombieAfterDays, journal, now })
    } catch (err) {
      // Never an empty machine: an unexpected failure reads as "unavailable".
      const msg = err instanceof Error ? err.message : String(err)
      snap = unavailableSnapshot(msg, now, prefs.zombieAfterDays, journal.slice(0, JOURNAL_LIMIT))
    }
    last = snap
    await noteNewZombies(snap).catch((err) =>
      console.error('[containers] new-zombie check failed', err)
    )
    return snap
  }

  /** Single-flight, but always a scan that STARTED after this call. */
  const freshScan = async (): Promise<ContainersSnapshot> => {
    while (inflight) await inflight.catch(() => undefined)
    inflight = runScan().finally(() => {
      inflight = null
    })
    return inflight
  }

  const scanAndPush = async (): Promise<ContainersSnapshot> => {
    const snap = await freshScan()
    deps.push(snap)
    return snap
  }

  const actionDeps: ActionDeps = {
    ...deps.docker,
    scan: freshScan,
    appendTombstone: (t) => appendTombstone(journalPath, t),
    now: deps.now
  }

  const clearSchedule = (): void => {
    if (initialTimer) clearTimeout(initialTimer)
    if (intervalTimer) clearInterval(intervalTimer)
    initialTimer = null
    intervalTimer = null
  }

  const tick = async (): Promise<void> => {
    if (tickRunning) return // never stack a tick on a slow scan
    tickRunning = true
    try {
      await scanAndPush()
    } finally {
      tickRunning = false
    }
  }

  const schedule = (): void => {
    clearSchedule()
    if (!prefs.autoScan) return
    initialTimer = setTimeout(() => {
      initialTimer = null
      void tick()
      intervalTimer = setInterval(() => void tick(), prefs.intervalMs)
    }, INITIAL_DELAY_MS)
  }

  return {
    snapshot: () => last,
    scan: scanAndPush,
    act: (raw, actor) => {
      const run = actChain.then(async () => {
        const result = await runContainersAction(raw, actor, actionDeps)
        if (!result.error) {
          // Refresh the view after anything that may have changed docker state.
          await scanAndPush().catch(() => undefined)
        }
        return result
      })
      actChain = run.catch(() => undefined)
      return run
    },
    journal: (limit = JOURNAL_LIMIT) => readJournal(journalPath, limit),
    prefs: loadPrefs,
    setPrefs: async (raw) => {
      const next = normalizePrefs(raw)
      const thresholdChanged = next.zombieAfterDays !== prefs.zombieAfterDays
      prefsSaves++
      prefs = next
      await writePrefs(prefsPath, next)
      schedule()
      // The verdicts depend on the threshold: recompute them now, not at the next tick.
      if (thresholdChanged && last) void scanAndPush().catch(() => undefined)
      // What this save stored, whatever another read or save did to `prefs` while the file was written.
      return next
    },
    start: async () => {
      await loadPrefs()
      schedule()
    },
    stop: clearSchedule
  }
}

let service: ContainersService | null = null

/** The registered service, for the MCP verbs; null before registration. */
export function getContainersService(): ContainersService | null {
  return service
}

/** Register the Containers IPC handlers and arm the background scan. */
export function registerContainersHandlers(
  getWindow: () => BrowserWindow | null
): ContainersService {
  const svc = createContainersService({
    scan: scanContainers,
    docker: dockerActions,
    userDataDir: app.getPath('userData'),
    push: (snap) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('containers:update', snap)
    },
    // The renderer records it in the notification center; a click opens the takeover.
    alert: (a) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('containers:newZombies', a)
    },
    now: () => Date.now()
  })
  service = svc

  ipcMain.handle('containers:snapshot', (): ContainersSnapshot | null => svc.snapshot())
  ipcMain.handle('containers:scan', (): Promise<ContainersSnapshot> => svc.scan())
  // The renderer is always the operator. Its payload is untrusted: the action
  // function validates it and enforces every tier (PRD §7.4).
  ipcMain.handle('containers:act', (_e, raw: unknown): Promise<ActResult> =>
    svc.act(raw, 'operator')
  )
  ipcMain.handle('containers:journal', (): Promise<Tombstone[]> => svc.journal())
  ipcMain.handle('containers:prefs', (): Promise<ContainersPrefs> => svc.prefs())
  ipcMain.handle('containers:setPrefs', (_e, raw: unknown): Promise<ContainersPrefs> =>
    svc.setPrefs(raw)
  )

  void svc.start()
  return svc
}
