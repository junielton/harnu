/**
 * Electron shell for Your move: the only electron-bound file in this folder.
 *
 * Opens the store and the prefs, builds the inspector over the real `claude` binary, and
 * serves the Settings pane: `yourMove:list`, `yourMove:prefs:get`, `yourMove:prefs:set`,
 * `yourMove:inspectNow`, plus the `yourMove:changed` event. Every decision (gating, cursors,
 * verdicts) lives in the pure modules beside this file.
 */

import { app, ipcMain, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { sanitizeSpawnEnv } from '../appimage-env'
import { classifyTranscriptLines } from '../claude-watcher'
import { addTaskEventObserver, getTaskStates } from '../detect/task-state-hub'
import { resolveClaudePath } from '../claude-cli'
import { isFolderDenied } from '../mcp/permission-core'
import { setMissionListObserver } from '../mission-ipc'
import { setPtyExitObserver } from '../pty'
import { getSessionArchive } from '../session-archive-core'
import { onFolderRemoved, readUserProjects } from '../user-projects'
import { closeCard, pruneClosed, resetCursors, type CardView, type YourMoveCard } from './core'
import { createInspector, laneFor, type InspectOutcome, type InspectRequest } from './inspector'
import { createJudgeRunner, type JudgeRunner } from './judge'
import {
  effectiveMode,
  isFolderDisabled,
  needsCursorReset,
  readYourMovePrefs,
  writeYourMovePrefs,
  type YourMoveMode,
  type YourMovePrefs
} from './prefs'
import { openYourMoveStore, setYourMoveStore, type YourMoveStore } from './store'
import { buildSegment } from './segment'
import { createGateWatch, watchArchive, watchFolderRemoval } from './source-gate'
import { reconcileMissions } from './source-mission'
import { readFrom } from './transcript'
import {
  SWEEP_MS,
  createEnsureCursor,
  createMidTurnSweep,
  createSystemCards,
  createTriggers
} from './triggers'

const STATE_FILE = 'your-move.json'
const PREFS_FILE = 'your-move-prefs.json'
const INSPECTIONS_FILE = 'your-move-inspections.jsonl'
const LABELS_FILE = 'your-move-labels.jsonl'
const EMPTY_DIR = path.join('your-move', 'empty')
const NEWEST_CLOSED = 200
/** The inspection log is a debug aid: past this size it keeps only its newest half. */
const INSPECTIONS_MAX_BYTES = 2 * 1024 * 1024
const DENY_TTL_MS = 5_000
const SESSION_ID = /^[0-9a-zA-Z-]{8,64}$/

/** What the pane reads: the prefs with the mode resolved, so the renderer never re-derives the default. */
export type YourMovePrefsView = Omit<YourMovePrefs, 'mode'> & { mode: YourMoveMode }

/** What `yourMove:exit` answers: it never throws, `ok:false` says there was nothing to close. */
export type YourMoveExitResult = { ok: true } | { ok: false; reason: string }

const EXIT_LABELS = ['not-for-me', 'already-handled'] as const
type ExitLabel = (typeof EXIT_LABELS)[number]

export interface InspectNowResult {
  outcome: InspectOutcome
  reason?: string
}

function promptPath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'your-move', name)
    : path.join(app.getAppPath(), 'resources', 'your-move', name)
}

/** `~/.claude/projects/<slug>/<id>.jsonl`, found by id: the renderer never names a path. */
async function locateTranscript(sessionId: string): Promise<string | null> {
  const root = path.join(os.homedir(), '.claude', 'projects')
  let slugs: string[]
  try {
    slugs = await fs.readdir(root)
  } catch {
    return null
  }
  for (const slug of slugs) {
    const candidate = path.join(root, slug, `${sessionId}.jsonl`)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* not in this slug */
    }
  }
  return null
}

/** The first `cwd` the transcript names: where a session with no hook payload runs. */
async function cwdFromTranscript(file: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    fh = await fs.open(file, 'r')
    const buf = Buffer.alloc(16 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      try {
        const o = JSON.parse(line) as { cwd?: unknown }
        if (typeof o.cwd === 'string' && o.cwd !== '') return o.cwd
      } catch {
        /* a partial or malformed line */
      }
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

/** Does the newest part of the transcript already hold this reply? */
async function transcriptHasReply(file: string, text: string): Promise<boolean> {
  const wanted = text.trim()
  if (wanted === '') return true
  const res = await readFrom(file, { tail: 128 * 1024 })
  return buildSegment(res.lines).some((e) => e.tag === 'ASSISTANT' && e.text.includes(wanted))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let runner: JudgeRunner | null = null
let unsubscribe: (() => void) | null = null
let stopTriggers: (() => void) | null = null

export function registerYourMove(getWindow: () => BrowserWindow | null): void {
  const userData = app.getPath('userData')
  const prefsPath = path.join(userData, PREFS_FILE)
  const inspectionsPath = path.join(userData, INSPECTIONS_FILE)
  const labelsPath = path.join(userData, LABELS_FILE)
  const emptyDir = path.join(userData, EMPTY_DIR)

  let prefs: YourMovePrefs | null = null
  let denyFolders: string[] = []
  let denyAt = 0
  let lastFailure = ''

  const refreshDeny = async (): Promise<void> => {
    if (Date.now() - denyAt < DENY_TTL_MS) return
    denyAt = Date.now()
    try {
      denyFolders = (await readUserProjects()).projects
        .filter((p) => p.agentDenied === true)
        .map((p) => p.path)
    } catch {
      /* keep the last known list */
    }
  }

  const notifyChanged = (): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('yourMove:changed')
  }

  // A store that cannot be opened (an unreadable file, a failed copy-aside) leaves Your move
  // inactive: the failure is logged, every channel keeps answering, and app boot goes on.
  const ready: Promise<YourMoveStore | null> = (async () => {
    try {
      const store = await openYourMoveStore(path.join(userData, STATE_FILE))
      await store.transact((s) => ({ next: pruneClosed(s, Date.now()), result: null }))
      prefs = await readYourMovePrefs(prefsPath)
      await fs.mkdir(emptyDir, { recursive: true })
      await trimInspections(inspectionsPath)
      unsubscribe = store.onChange(notifyChanged)
      setYourMoveStore(store)
      return store
    } catch (e) {
      console.error(`[your-move] inactive: the store could not be opened: ${(e as Error).message}`)
      return null
    }
  })()

  runner = createJudgeRunner({
    binary: async () => {
      const bin = await resolveClaudePath()
      if (!bin) throw new Error('claude CLI not found')
      return bin
    },
    detectPath: promptPath('gate-v1.md'),
    enrichPath: promptPath('enrich-v1.md'),
    emptyDir,
    env: sanitizeSpawnEnv(process.env),
    cores: os.availableParallelism()
  })
  const judge = runner

  const mode = (): YourMoveMode => (prefs ? effectiveMode(prefs) : 'off')
  const eligible = async (sessionId: string, folder: string): Promise<boolean> => {
    await refreshDeny()
    return (
      !isFolderDenied(folder, denyFolders) &&
      !(getSessionArchive()?.has(sessionId) ?? false) &&
      !(prefs ? isFolderDisabled(prefs, folder) : false)
    )
  }
  const resolveFolder = async (
    _id: string,
    cwd: string | undefined,
    file: string
  ): Promise<string | null> => cwd ?? (await cwdFromTranscript(file))

  // Cards that come from no judge: a death, and a session that could not be checked.
  const systems = ready.then((store) =>
    store === null
      ? null
      : createSystemCards({
          store,
          mode,
          lane: () => laneFor(mode(), 'stop', prefs?.midTurnLive ?? false),
          eligible,
          locate: locateTranscript,
          resolveFolder,
          mintId: () => randomUUID(),
          now: () => Date.now()
        })
  )

  let inspectorPromise: Promise<ReturnType<typeof createInspector> | null> | null = null
  /** Null while the store is unavailable: nothing reaches the judge then. */
  const inspector = (): Promise<ReturnType<typeof createInspector> | null> =>
    (inspectorPromise ??= ready.then(async (store) => {
      if (store === null) return null
      const system = await systems
      return createInspector({
        store,
        read: readFrom,
        detect: (input) => judge.detect(input),
        enrich: (input) => judge.enrich(input),
        now: () => Date.now(),
        mintId: () => randomUUID(),
        isBlocked: (folder) => isFolderDenied(folder, denyFolders),
        isArchived: (id) => getSessionArchive()?.has(id) ?? false,
        isFolderOff: (folder) => (prefs ? isFolderDisabled(prefs, folder) : false),
        mode,
        midTurnLive: () => prefs?.midTurnLive ?? false,
        classify: classifyTranscriptLines,
        onFailure: (req, reason) => {
          lastFailure = reason
          system?.onInspectFailure(req, reason)
        },
        onSuccess: (req) => system?.onInspectSuccess(req),
        appendInspection: (row) => {
          void fs.appendFile(inspectionsPath, JSON.stringify(row) + '\n').catch(() => undefined)
        }
      })
    }))

  // Sources: wired only once the store is open. With no store nothing is observed, read or
  // judged, and nothing here throws.
  void ready
    .then(async (store) => {
      const insp = store ? await inspector() : null
      const system = store ? await systems : null
      if (!store || !insp || !system || runner === null) return
      const triggers = createTriggers({
        inspector: insp,
        store,
        mode,
        eligible,
        locate: locateTranscript,
        resolveFolder,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
        ensureCursor: createEnsureCursor({
          store,
          read: readFrom,
          classify: classifyTranscriptLines,
          now: () => Date.now()
        }),
        transcriptHas: transcriptHasReply,
        delay: sleep
      })
      const sweep = createMidTurnSweep({
        inspector: insp,
        store,
        mode,
        eligible,
        locate: locateTranscript,
        resolveFolder,
        read: readFrom,
        states: getTaskStates,
        now: () => Date.now()
      })
      const gate = createGateWatch({
        store,
        mode,
        lane: () => laneFor(mode(), 'stop', prefs?.midTurnLive ?? false),
        eligible,
        locate: locateTranscript,
        resolveFolder,
        read: readFrom,
        states: getTaskStates,
        mintId: () => randomUUID(),
        now: () => Date.now()
      })
      const sweepTimer = setInterval(() => {
        void sweep.tick()
        void gate.tick()
      }, SWEEP_MS)
      sweepTimer.unref()
      const unobserve = addTaskEventObserver((ev) => {
        triggers.onTaskEvent(ev)
        system.onTaskEvent(ev)
        gate.onTaskEvent(ev)
      })
      const stopFolderWatch = watchFolderRemoval({
        store,
        subscribe: onFolderRemoved,
        now: () => Date.now()
      })
      // The archive store opens on its own schedule: attach as soon as it is there.
      let stopArchive: (() => void) | null = null
      let archiveRetry: ReturnType<typeof setTimeout> | null = null
      const attachArchive = (tries: number): void => {
        const archive = getSessionArchive()
        if (archive) {
          stopArchive = watchArchive({ store, archive, now: () => Date.now() })
        } else if (tries < 60) {
          archiveRetry = setTimeout(() => attachArchive(tries + 1), 1_000)
          archiveRetry.unref()
        }
      }
      attachArchive(0)
      setPtyExitObserver(system.onPtyExit)
      setMissionListObserver((result, roots) => {
        if (mode() === 'off') return
        // The owner's archive and a folder switched off keep a mission's items out of the queue:
        // a card closed by archiving must not come back with the next poll.
        const views = result.views.filter(
          (v) =>
            !(getSessionArchive()?.has(v.mission.owner.sessionId) ?? false) &&
            !(prefs ? isFolderDisabled(prefs, v.root) : false)
        )
        const lane = laneFor(mode(), 'stop', prefs?.midTurnLive ?? false)
        store
          .transact((s) => ({
            next: reconcileMissions(
              s,
              { views, unreadable: result.unreadable },
              roots,
              lane,
              () => randomUUID(),
              Date.now()
            ),
            result: undefined
          }))
          .catch((e) => console.error(`[your-move] mission source failed: ${(e as Error).message}`))
      })
      stopTriggers = () => {
        unobserve()
        setPtyExitObserver(null)
        setMissionListObserver(null)
        clearInterval(sweepTimer)
        if (archiveRetry) clearTimeout(archiveRetry)
        stopArchive?.()
        stopFolderWatch()
        gate.dispose()
        sweep.dispose()
        triggers.dispose()
      }
    })
    .catch((e) => console.error(`[your-move] sources not started: ${(e as Error).message}`))

  const view = (p: YourMovePrefs): YourMovePrefsView => ({ ...p, mode: effectiveMode(p) })
  /** What the pane sees while the store is unavailable: Off, and nothing is persisted. */
  const inactiveView = (): YourMovePrefsView => ({
    version: 1,
    mode: 'off',
    disabledFolders: [],
    firstRunNoticeSeen: false,
    midTurnLive: false
  })

  ipcMain.handle('yourMove:prefs:get', async (): Promise<YourMovePrefsView> => {
    if (!(await ready)) return inactiveView()
    return view(prefs as YourMovePrefs)
  })

  ipcMain.handle('yourMove:prefs:set', async (_e, patch: unknown): Promise<YourMovePrefsView> => {
    const store = await ready
    if (!store) return inactiveView()
    const prev = effectiveMode(prefs as YourMovePrefs)
    const next = await writeYourMovePrefs(prefsPath, (patch ?? {}) as Partial<YourMovePrefs>)
    prefs = next
    // Review Focus 3: days spent Off must never be judged afterwards.
    if (needsCursorReset(prev, effectiveMode(next))) {
      await store.transact((s) => ({ next: resetCursors(s), result: null }))
    }
    // The queue reads the mode too: tell it, or Live shows nothing until a card changes.
    notifyChanged()
    return view(next)
  })

  ipcMain.handle('yourMove:list', async (): Promise<CardView[]> => {
    const store = await ready
    if (!store) return []
    const cards = store.state().cards
    const open = cards.filter((c) => c.closedAt === undefined)
    const closed = cards
      .filter((c) => c.closedAt !== undefined)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, NEWEST_CLOSED)
    return [...open, ...closed].map((c: YourMoveCard): CardView => ({
      ...c,
      // The judge's and the verb's cards carry answer buttons. Nothing is typed into a session
      // yet: until the answering unit, those buttons open the session.
      answerable: c.source === 'judge' || c.source === 'verb',
      optionDeliverable: (c.options ?? []).map(() => true)
    }))
  })

  // Not for me / Already handled. Neither tells the session anything. The card closes with that
  // reason, then the card as the operator saw it is appended to the labelled examples.
  ipcMain.handle('yourMove:exit', async (_e, args: unknown): Promise<YourMoveExitResult> => {
    const a = (args ?? {}) as { cardId?: unknown; label?: unknown }
    if (
      typeof a.cardId !== 'string' ||
      a.cardId === '' ||
      !EXIT_LABELS.includes(a.label as ExitLabel)
    ) {
      return { ok: false, reason: 'bad request' }
    }
    const store = await ready
    if (!store) return { ok: false, reason: 'unavailable' }
    const cardId = a.cardId
    const label = a.label as ExitLabel
    const now = Date.now()
    const seen = await store.transact((s) => {
      const open = s.cards.find((c) => c.id === cardId && c.closedAt === undefined) ?? null
      return { next: open ? closeCard(s, cardId, label, now) : s, result: open }
    })
    if (!seen) return { ok: false, reason: 'not found' }
    try {
      await fs.appendFile(labelsPath, JSON.stringify({ ts: now, label, card: seen }) + '\n', {
        mode: 0o600
      })
    } catch (e) {
      // The card is closed either way: a log that cannot be written must not undo that.
      console.error(`[your-move] label not logged: ${(e as Error).message}`)
    }
    return { ok: true }
  })

  ipcMain.handle('yourMove:inspectNow', async (_e, args: unknown): Promise<InspectNowResult> => {
    const a = (args ?? {}) as { sessionId?: unknown; folder?: unknown }
    if (
      typeof a.sessionId !== 'string' ||
      !SESSION_ID.test(a.sessionId) ||
      typeof a.folder !== 'string' ||
      a.folder === ''
    ) {
      return { outcome: 'skipped', reason: 'bad request' }
    }
    if (!(await ready)) return { outcome: 'skipped', reason: 'unavailable' }
    const transcriptPath = await locateTranscript(a.sessionId)
    if (!transcriptPath) return { outcome: 'skipped', reason: 'transcript not found' }
    await refreshDeny()
    lastFailure = ''
    const req: InspectRequest = {
      sessionId: a.sessionId,
      folder: a.folder,
      transcriptPath,
      trigger: 'manual'
    }
    const insp = await inspector()
    if (!insp) return { outcome: 'skipped', reason: 'unavailable' }
    const outcome = await insp.request(req)
    return outcome === 'failed' ? { outcome, reason: lastFailure } : { outcome }
  })
}

/** Keep the inspection log from growing forever: past the cap, only the newest half stays. */
async function trimInspections(file: string): Promise<void> {
  try {
    const { size } = await fs.stat(file)
    if (size <= INSPECTIONS_MAX_BYTES) return
    const body = await fs.readFile(file, 'utf8')
    const tail = body.slice(Math.floor(body.length / 2))
    await fs.writeFile(file, tail.slice(tail.indexOf('\n') + 1))
  } catch {
    /* no log yet */
  }
}

export function closeYourMove(): void {
  runner?.closeAll()
  runner = null
  unsubscribe?.()
  unsubscribe = null
  stopTriggers?.()
  stopTriggers = null
  setYourMoveStore(null)
}

export type { YourMoveStore }
