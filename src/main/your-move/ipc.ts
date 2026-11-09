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
import { resolveClaudePath } from '../claude-cli'
import { isFolderDenied } from '../mcp/permission-core'
import { getSessionArchive } from '../session-archive-core'
import { readUserProjects } from '../user-projects'
import { pruneClosed, resetCursors, type CardView, type YourMoveCard } from './core'
import { createInspector, type InspectOutcome, type InspectRequest } from './inspector'
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
import { readFrom } from './transcript'

const STATE_FILE = 'your-move.json'
const PREFS_FILE = 'your-move-prefs.json'
const INSPECTIONS_FILE = 'your-move-inspections.jsonl'
const EMPTY_DIR = path.join('your-move', 'empty')
const NEWEST_CLOSED = 200
/** The inspection log is a debug aid: past this size it keeps only its newest half. */
const INSPECTIONS_MAX_BYTES = 2 * 1024 * 1024
const DENY_TTL_MS = 5_000
const SESSION_ID = /^[0-9a-zA-Z-]{8,64}$/

/** What the pane reads: the prefs with the mode resolved, so the renderer never re-derives the default. */
export type YourMovePrefsView = Omit<YourMovePrefs, 'mode'> & { mode: YourMoveMode }

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

let runner: JudgeRunner | null = null
let unsubscribe: (() => void) | null = null

export function registerYourMove(getWindow: () => BrowserWindow | null): void {
  const userData = app.getPath('userData')
  const prefsPath = path.join(userData, PREFS_FILE)
  const inspectionsPath = path.join(userData, INSPECTIONS_FILE)
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

  // A store that cannot be opened (an unreadable file, a failed copy-aside) leaves Your move
  // inactive: the failure is logged, every channel keeps answering, and app boot goes on.
  const ready: Promise<YourMoveStore | null> = (async () => {
    try {
      const store = await openYourMoveStore(path.join(userData, STATE_FILE))
      await store.transact((s) => ({ next: pruneClosed(s, Date.now()), result: null }))
      prefs = await readYourMovePrefs(prefsPath)
      await fs.mkdir(emptyDir, { recursive: true })
      await trimInspections(inspectionsPath)
      unsubscribe = store.onChange(() => {
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('yourMove:changed')
      })
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

  let inspectorPromise: Promise<ReturnType<typeof createInspector>> | null = null
  const inspector = (): Promise<ReturnType<typeof createInspector>> =>
    (inspectorPromise ??= ready.then((store) =>
      createInspector({
        store: store as YourMoveStore,
        read: readFrom,
        detect: (input) => judge.detect(input),
        enrich: (input) => judge.enrich(input),
        now: () => Date.now(),
        mintId: () => randomUUID(),
        isBlocked: (folder) => isFolderDenied(folder, denyFolders),
        isArchived: (id) => getSessionArchive()?.has(id) ?? false,
        isFolderOff: (folder) => (prefs ? isFolderDisabled(prefs, folder) : false),
        mode: () => (prefs ? effectiveMode(prefs) : 'off'),
        midTurnLive: () => prefs?.midTurnLive ?? false,
        classify: classifyTranscriptLines,
        onFailure: (_req, reason) => {
          lastFailure = reason
        },
        appendInspection: (row) => {
          void fs.appendFile(inspectionsPath, JSON.stringify(row) + '\n').catch(() => undefined)
        }
      })
    ))

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
      // Nothing answers a card before the queue ships (U4).
      answerable: false,
      optionDeliverable: (c.options ?? []).map(() => false)
    }))
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
    const outcome = await (await inspector()).request(req)
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
  setYourMoveStore(null)
}

export type { YourMoveStore }
