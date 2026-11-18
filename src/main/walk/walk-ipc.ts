/**
 * Guided walks: the walk pane's main-side IPC (spec S-3). The operator's outcomes, the pasted-screenshot save,
 * the link opens and what the pane reads to draw a run all cross here.
 *
 * What this module is NOT: a verb. The pane talks to the service's `operate` (the operator side of S-2) and
 * nothing here takes a command to run, settles a criterion or reaches `markCriterion` (NG-4, D-2). A criterion
 * is only READ, live, for the close-out; the operator ticks it in the Mission.
 *
 * Channels (request/response, `walk:verb`):
 *  - `walk:load`          what the pane needs to draw a run (the walk, the run, the pane's ticks, the criteria)
 *  - `walk:operate`       one operator outcome (Start, Done, Failed, Back, Skip, ...), then the fresh load
 *  - `walk:tick`          reveal a check's extra checks / tick one (saved per run, never blocks Done)
 *  - `walk:save-shot`     save a pasted screenshot inside the run's folder
 *  - `walk:scan-line`     does a failure line look like a secret (the `get_session` scrubber's patterns)
 *  - `walk:resolve-pr`    the URL of a PR number of the folder's repo, for the link chip
 *  - `walk:replay`        offer every turn waiting in an outbox again (on mount, on reconnect)
 *  - `walk:rerun-saved`   accept the roadmap's "Re-run the saved walk?" (AC-49)
 *  - `walk:discard-ready` the pane of a run that never started was closed: discard that run
 * and one main-to-renderer push, `walk:open` (with the renderer's `walk:opened` answer), plus `walk:changed`
 * when a verb (`walk_report`, `walk_extend`) wrote a walk the pane may be showing.
 *
 * The dev-only `HARNU_WALK_CHECK_WAIT_MS` shortens the 30 s wait of D-7 so a capture does not wait for it.
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { mkdirDataDir, repoRoot } from '../data-dir'
import { atomicWriteFile } from '../mcp/atomic-write'
import { readMissionRecord } from '../missions/record-store'
import { runGh } from '../gh-runner'
import { rawRm } from '../raw-fs'
import { WALK_WAIT_MS, type Run } from '../../shared/walk-machine'
import type { WalkScript } from '../../shared/walk-schema'
import { sourceIdentity } from '../../shared/walk-source'
import { redactTranscript } from '../mcp/transcript-redact'
import { walkServiceFor, type WalkService } from './walk-service'
import {
  RUN_ID_RE,
  WALK_ID_RE,
  walksDir,
  type AddedCheck,
  type Deepening,
  type SimplerCard,
  type WalkStore
} from './walk-store'
import type { OperatorOp } from './walk-turn'

// ---- What the pane reads --------------------------------------------------------------------------

export interface WalkTick {
  /** Checks whose Explain more card was opened (their extra checks reach the close-out list). */
  revealed: string[]
  /** The extra checks the operator ticked, per check. */
  ticked: Record<string, string[]>
}

export interface WalkCriterion {
  id: string
  text: string
  state: 'open' | 'settled' | 'unavailable'
}

export interface WalkLoad {
  ok: true
  folder: string
  /** The walk's own folder (`.harnu/walks/<walkId>/`): its images are files in there. */
  walkDir: string
  walkId: string
  runId: string
  rev: number
  script: WalkScript
  deepenings: Deepening[]
  simpler: SimplerCard[]
  added: AddedCheck[]
  run: Run
  closeOut: string | null
  ownerSessionId: string | null
  tick: WalkTick
  /** A turn is due and no session could take it: it has waited in the outbox past {@link HELD_AFTER_MS}. */
  held: boolean
  waitMs: number
  now: number
  saved: { walkId: string; lastRun: { verified: number; total: number } } | null
  criteria: WalkCriterion[]
  mission: { title: string; stepTitle?: string; milestoneTitle?: string } | null
}

export type WalkIpcError = { ok: false; error: { code: string; message: string } }
const refuse = (code: string, message: string): WalkIpcError => ({
  ok: false,
  error: { code, message }
})

/** A turn that has waited this long in the outbox means no session took it: the pane shows the error state. */
export const HELD_AFTER_MS = 6_000
const MAX_SHOT_BYTES = 8 * 1024 * 1024

/** The wait before Continue without the check; the dev variable shortens it (never in a packaged build). */
export function checkWaitMs(
  env: NodeJS.ProcessEnv = process.env,
  packaged = app.isPackaged
): number {
  if (packaged) return WALK_WAIT_MS
  const n = Number(env['HARNU_WALK_CHECK_WAIT_MS'])
  return Number.isFinite(n) && n >= 0 ? n : WALK_WAIT_MS
}

// ---- The pane's own saved bits ---------------------------------------------------------------------

/** `runs/<runId>/ui.json`: ticks and the "opened" marks, beside the run's file (and gone with it). */
const tickFile = (store: WalkStore, walkId: string, runId: string): string =>
  join(store.shotsDir(walkId, runId), '..', 'ui.json')

async function readTick(store: WalkStore, walkId: string, runId: string): Promise<WalkTick> {
  try {
    const raw = JSON.parse(
      await fs.readFile(tickFile(store, walkId, runId), 'utf8')
    ) as Partial<WalkTick>
    return {
      revealed: Array.isArray(raw.revealed)
        ? raw.revealed.filter((x) => typeof x === 'string')
        : [],
      ticked:
        raw.ticked && typeof raw.ticked === 'object'
          ? Object.fromEntries(
              Object.entries(raw.ticked).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
              ])
            )
          : {}
    }
  } catch {
    return { revealed: [], ticked: {} } // missing and corrupt read the same: nothing ticked
  }
}

async function writeTick(
  store: WalkStore,
  walkId: string,
  runId: string,
  tick: WalkTick
): Promise<void> {
  const file = tickFile(store, walkId, runId)
  await mkdirDataDir(join(file, '..'))
  await atomicWriteFile(file, JSON.stringify(tick, null, 2) + '\n', 0o600)
}

// ---- A mission source's criteria and names (read, never written) ----------------------------------

async function missionFacts(
  folder: string,
  script: WalkScript
): Promise<{ criteria: WalkCriterion[]; mission: WalkLoad['mission'] }> {
  const src = script.source
  if (src.kind !== 'mission') return { criteria: [], mission: null }
  const read = await readMissionRecord(repoRoot(folder), src.missionId).catch(() => null)
  const referenced = [
    ...new Set(script.checks.map((c) => c.criterion).filter((x): x is string => !!x))
  ]
  if (!read || !read.ok || read.record.status === 'closed') {
    // the mission was closed or removed: every criterion the walk answers reads "mission not available"
    return {
      criteria: referenced.map((id) => ({ id, text: id, state: 'unavailable' as const })),
      mission: read && read.ok ? { title: read.record.title } : null
    }
  }
  const record = read.record
  const inScope =
    src.scope === 'step'
      ? record.steps.filter((s) => s.id === src.id)
      : src.scope === 'milestone'
        ? record.steps.filter((s) => s.milestone === src.id)
        : record.steps
  const all = inScope.flatMap((s) => s.acs)
  const wanted =
    referenced.length > 0
      ? record.steps.flatMap((s) => s.acs).filter((a) => referenced.includes(a.id))
      : all.filter((a) => a.by === 'operator' || a.by === 'person')
  return {
    criteria: wanted.map((a) => ({
      id: a.id,
      text: a.text,
      state: a.settled ? ('settled' as const) : ('open' as const)
    })),
    mission: {
      title: record.title,
      ...(src.scope === 'step'
        ? { stepTitle: record.steps.find((s) => s.id === src.id)?.title ?? '' }
        : {}),
      ...(src.scope === 'milestone'
        ? { milestoneTitle: record.milestones.find((m) => m.id === src.id)?.title ?? '' }
        : {})
    }
  }
}

// ---- load -------------------------------------------------------------------------------------------

export async function loadWalk(
  svc: WalkService,
  a: { walkId: string; runId: string },
  env: { now?: () => number; waitMs?: number } = {}
): Promise<WalkLoad | WalkIpcError> {
  const now = (env.now ?? Date.now)()
  const { store } = svc
  const walk = await store.readWalk(a.walkId)
  if (!walk) return refuse('WALK_NOT_FOUND', 'No such walk.')
  const rec = await store.readRun(a.walkId, a.runId)
  if (!rec) return refuse('RUN_NOT_FOUND', 'No such run.')

  const id = sourceIdentity(walk.script.source)
  const saved = (await store.listWalks())
    .filter(
      (e) =>
        e.walkId !== a.walkId &&
        e.status === 'walked' &&
        e.lastRun &&
        sourceIdentity(e.source) === id
    )
    .sort((x, y) => (y.lastRun?.at ?? 0) - (x.lastRun?.at ?? 0))[0]

  const pending = rec.outbox.filter((o) => !o.delivered)
  const facts = await missionFacts(svc.folder, walk.script)
  return {
    ok: true,
    folder: svc.folder,
    walkDir: store.walkDir(a.walkId),
    walkId: a.walkId,
    runId: a.runId,
    rev: walk.rev,
    script: walk.script,
    deepenings: walk.deepenings ?? [],
    simpler: walk.simpler ?? [],
    added: walk.added ?? [],
    run: rec.run,
    closeOut: rec.closeOut,
    ownerSessionId: rec.ownerSessionId,
    tick: await readTick(store, a.walkId, a.runId),
    held: pending.some((o) => now - o.createdAt > HELD_AFTER_MS),
    waitMs: env.waitMs ?? checkWaitMs(),
    now,
    saved: saved?.lastRun
      ? {
          walkId: saved.walkId,
          lastRun: { verified: saved.lastRun.verified, total: saved.lastRun.total }
        }
      : null,
    criteria: facts.criteria,
    mission: facts.mission
  }
}

// ---- Re-run the saved walk (AC-49) ----------------------------------------------------------------

/**
 * The roadmap of a new walk offered to re-run the saved walk of the same source, and the operator said yes:
 * start run `n + 1` of the saved walk and discard the new walk, which was never started. A walk that was
 * started, that has been walked, or whose source differs is never discarded.
 */
export async function rerunSavedWalk(
  store: WalkStore,
  a: { newWalkId: string; newRunId: string; savedWalkId: string }
): Promise<{ ok: true; walkId: string; runId: string; n: number } | WalkIpcError> {
  const fresh = await store.readWalk(a.newWalkId)
  const freshRun = await store.readRun(a.newWalkId, a.newRunId)
  if (!fresh || !freshRun) return refuse('WALK_NOT_FOUND', 'No such walk.')
  const runs = await store.listRuns(a.newWalkId)
  if (freshRun.run.state !== 'ready' || fresh.live || fresh.lastRun || runs.length !== 1)
    return refuse('NOT_UNSTARTED', 'Only a walk that was never started is discarded.')
  const saved = await store.readWalk(a.savedWalkId)
  if (!saved || a.savedWalkId === a.newWalkId)
    return refuse('WALK_NOT_FOUND', 'No such saved walk.')
  if (sourceIdentity(saved.script.source) !== sourceIdentity(fresh.script.source))
    return refuse('SOURCE_MISMATCH', 'The saved walk is about something else.')

  // a run the saved walk already has ready (a re-run whose pane is still open) is reused, never piled up
  const leftover = (await store.listRuns(a.savedWalkId)).find(
    (r) => r.run.state === 'ready' && r.run.n > 1
  )
  let target: { runId: string; n: number }
  if (leftover) target = { runId: leftover.runId, n: leftover.run.n }
  else {
    const made = await store.newRun(a.savedWalkId)
    if (!made.ok) return refuse(made.error.code, made.error.message)
    target = made
  }
  await rawRm(store.walkDir(a.newWalkId), { recursive: true, force: true })
  return { ok: true, walkId: a.savedWalkId, ...target }
}

// ---- Screenshots ------------------------------------------------------------------------------------

function sniffImage(b: Uint8Array): 'png' | 'jpg' | 'webp' | 'gif' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (
    b.length > 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'webp'
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  return null
}

/** Save a pasted screenshot inside the run's own folder (`runs/<runId>/shots/`); only real images, capped. */
export async function saveShot(
  store: WalkStore,
  a: { walkId: string; runId: string; data: Uint8Array }
): Promise<{ ok: true; path: string; name: string } | WalkIpcError> {
  if (!(await store.readRun(a.walkId, a.runId))) return refuse('RUN_NOT_FOUND', 'No such run.')
  if (a.data.byteLength === 0 || a.data.byteLength > MAX_SHOT_BYTES)
    return refuse('SHOT_TOO_LARGE', 'A screenshot is an image of at most 8 MB.')
  const ext = sniffImage(a.data)
  if (!ext) return refuse('NOT_AN_IMAGE', 'Only an image can be pasted here.')
  const dir = store.shotsDir(a.walkId, a.runId)
  await mkdirDataDir(dir)
  const name = `shot-${Date.now()}-${randomBytes(2).toString('hex')}.${ext}`
  const path = join(dir, name)
  await fs.writeFile(path, a.data, { mode: 0o600, flag: 'wx' }) // never overwrites a shot
  return { ok: true, path, name }
}

// ---- A PR number to a URL ---------------------------------------------------------------------------

/** A PR number of the folder's repo to its URL, through the one place Harnu spawns `gh` (it counts the call). */
async function ghPrUrl(folder: string, n: number): Promise<string | null> {
  try {
    const { stdout } = await runGh(['pr', 'view', String(n), '--json', 'url', '-q', '.url'], {
      consumer: 'pr-stack',
      resource: 'graphql',
      cwd: folder,
      timeout: 8_000
    })
    const url = stdout.trim()
    return /^https:\/\//.test(url) ? url : null
  } catch {
    return null // gh missing, signed out, throttled or no such PR: the chip simply does not open
  }
}

// ---- Registration -----------------------------------------------------------------------------------

const OPS: ReadonlySet<string> = new Set<OperatorOp>([
  'start',
  'done',
  'fail',
  'skip',
  'back',
  'try-again',
  'follow-anyway',
  'treat-as-failed',
  'continue-without',
  'pick-skipped',
  'close-out-with-skipped',
  'end',
  'explain',
  'simpler',
  'escalate'
])

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null)

function ids(a: unknown): { folder: string; walkId: string; runId: string } | null {
  if (!isRecord(a)) return null
  const folder = str(a.folder)
  const walkId = str(a.walkId)
  const runId = str(a.runId)
  if (!folder || !walkId || !runId || !WALK_ID_RE.test(walkId) || !RUN_ID_RE.test(runId))
    return null
  return { folder, walkId, runId }
}

export interface WalkIpc {
  /** Ask the folder's helper stack to open the pane, in the background; `true` once the renderer answers. */
  openPane(a: { folder: string; walkId: string; runId: string }): Promise<boolean>
}

const OPEN_ANSWER_MS = 4_000

export function registerWalkIpc(getWindow: () => BrowserWindow | null): WalkIpc {
  const waiting = new Map<string, (paneId: string | null) => void>()
  ipcMain.on('walk:opened', (_e, a: unknown) => {
    if (!isRecord(a) || typeof a.reqId !== 'string') return
    const done = waiting.get(a.reqId)
    waiting.delete(a.reqId)
    done?.(typeof a.paneId === 'string' ? a.paneId : null)
  })

  // The walk a pane shows can be written by a verb (`walk_report`, `walk_extend`) from a session; watch its folder
  // and tell the pane, so a report appears without the operator doing anything.
  const watchers = new Map<string, { w: FSWatcher; timer: NodeJS.Timeout | null; refs: number }>()
  function watchWalk(folder: string, walkId: string): void {
    const dir = join(walksDir(folder), walkId)
    const key = resolve(dir)
    const have = watchers.get(key)
    if (have) {
      have.refs++
      return
    }
    try {
      const w = watch(dir, { recursive: true }, () => {
        const entry = watchers.get(key)
        if (!entry || entry.timer) return
        entry.timer = setTimeout(() => {
          entry.timer = null
          getWindow()?.webContents.send('walk:changed', { folder, walkId })
        }, 120)
      })
      w.on('error', () => undefined)
      watchers.set(key, { w, timer: null, refs: 1 })
    } catch {
      /* a platform that cannot watch: the pane still re-reads after every operator step */
    }
  }
  function unwatchWalk(folder: string, walkId: string): void {
    const key = resolve(join(walksDir(folder), walkId))
    const entry = watchers.get(key)
    if (!entry) return
    if (--entry.refs > 0) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.w.close()
    watchers.delete(key)
  }

  ipcMain.handle('walk:load', async (_e, a: unknown) => {
    const x = ids(a)
    if (!x) return refuse('BAD_ARGS', 'folder, walkId and runId are required.')
    return loadWalk(walkServiceFor(x.folder), x)
  })

  ipcMain.handle('walk:watch', (_e, a: unknown) => {
    if (!isRecord(a)) return false
    const folder = str(a.folder)
    const walkId = str(a.walkId)
    if (!folder || !walkId || !WALK_ID_RE.test(walkId)) return false
    if (a.on === false) unwatchWalk(folder, walkId)
    else watchWalk(folder, walkId)
    return true
  })

  ipcMain.handle('walk:operate', async (_e, a: unknown) => {
    const x = ids(a)
    if (!x || !isRecord(a)) return refuse('BAD_ARGS', 'folder, walkId and runId are required.')
    const op = str(a.op)
    if (!op || !OPS.has(op)) return refuse('BAD_ARGS', 'That is not an outcome of the pane.')
    const svc = walkServiceFor(x.folder)
    const res = await svc.operate({
      walkId: x.walkId,
      runId: x.runId,
      op: op as OperatorOp,
      ...(typeof a.line === 'string' ? { line: a.line } : {}),
      ...(typeof a.shot === 'string' ? { shot: a.shot } : {}),
      ...(typeof a.checkId === 'string' ? { checkId: a.checkId } : {}),
      ...(typeof a.waitMs === 'number' && !app.isPackaged ? { waitMs: a.waitMs } : {})
    })
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, sent: res.sent, load: await loadWalk(svc, x) }
  })

  ipcMain.handle('walk:tick', async (_e, a: unknown) => {
    const x = ids(a)
    if (!x || !isRecord(a)) return refuse('BAD_ARGS', 'folder, walkId and runId are required.')
    const checkId = str(a.checkId)
    if (!checkId) return refuse('BAD_ARGS', 'checkId is required.')
    const svc = walkServiceFor(x.folder)
    const walk = await svc.store.readWalk(x.walkId)
    if (!walk?.script.checks.some((c) => c.id === checkId))
      return refuse('CHECK_NOT_FOUND', 'No such check.')
    const tick = await readTick(svc.store, x.walkId, x.runId)
    const ticked = { ...tick.ticked }
    if (Array.isArray(a.ticked))
      ticked[checkId] = a.ticked.filter((v): v is string => typeof v === 'string')
    const next: WalkTick = {
      revealed: tick.revealed.includes(checkId) ? tick.revealed : [...tick.revealed, checkId],
      ticked
    }
    await writeTick(svc.store, x.walkId, x.runId, next)
    return { ok: true, tick: next }
  })

  ipcMain.handle('walk:save-shot', async (_e, a: unknown) => {
    const x = ids(a)
    if (!x || !isRecord(a)) return refuse('BAD_ARGS', 'folder, walkId and runId are required.')
    const data = a.data
    const bytes =
      data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
    if (!bytes) return refuse('BAD_ARGS', 'data is the image bytes.')
    return saveShot(walkServiceFor(x.folder).store, {
      walkId: x.walkId,
      runId: x.runId,
      data: bytes
    })
  })

  ipcMain.handle('walk:scan-line', (_e, a: unknown) => {
    if (!isRecord(a) || typeof a.text !== 'string') return false
    return redactTranscript(a.text.slice(0, 2_000), { home: '' }).redactionCount > 0
  })

  ipcMain.handle('walk:resolve-pr', async (_e, a: unknown) => {
    if (!isRecord(a)) return { ok: false }
    const folder = str(a.folder)
    const n = Number(a.number)
    if (!folder || !Number.isInteger(n) || n <= 0) return { ok: false }
    const url = await ghPrUrl(folder, n)
    return url ? { ok: true, url } : { ok: false }
  })

  ipcMain.handle('walk:replay', async (_e, a: unknown) => {
    if (!isRecord(a)) return { delivered: 0, pending: 0 }
    const folder = str(a.folder)
    if (!folder) return { delivered: 0, pending: 0 }
    return walkServiceFor(folder).replay()
  })

  ipcMain.handle('walk:rerun-saved', async (_e, a: unknown) => {
    if (!isRecord(a)) return refuse('BAD_ARGS', 'bad arguments')
    const folder = str(a.folder)
    const newWalkId = str(a.newWalkId)
    const newRunId = str(a.newRunId)
    const savedWalkId = str(a.savedWalkId)
    if (!folder || !newWalkId || !newRunId || !savedWalkId)
      return refuse('BAD_ARGS', 'bad arguments')
    if (!WALK_ID_RE.test(newWalkId) || !WALK_ID_RE.test(savedWalkId) || !RUN_ID_RE.test(newRunId))
      return refuse('BAD_ARGS', 'bad ids')
    return rerunSavedWalk(walkServiceFor(folder).store, { newWalkId, newRunId, savedWalkId })
  })

  ipcMain.handle('walk:discard-ready', async (_e, a: unknown) => {
    const x = ids(a)
    if (!x) return refuse('BAD_ARGS', 'folder, walkId and runId are required.')
    const res = await walkServiceFor(x.folder).store.discardReadyRun(x.walkId, x.runId)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })

  return {
    openPane(a) {
      const win = getWindow()
      if (!win || win.isDestroyed()) return Promise.resolve(false)
      const reqId = randomBytes(6).toString('hex')
      return new Promise<boolean>((done) => {
        const timer = setTimeout(() => {
          waiting.delete(reqId)
          done(false)
        }, OPEN_ANSWER_MS)
        waiting.set(reqId, (paneId) => {
          clearTimeout(timer)
          done(paneId !== null)
        })
        win.webContents.send('walk:open', { reqId, ...a })
      })
    }
  }
}
