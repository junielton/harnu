/**
 * The operator's two exits from a card (`yourMove:exit`): Not for me and Already handled.
 * Neither tells the session anything; both close the card and log a labelled example, and the
 * two labels are never mixed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CardView, YourMoveCard } from '../../src/main/your-move/core'

const h = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userData,
    getAppPath: (): string => h.userData
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
      h.handlers.set(channel, fn)
    }
  },
  BrowserWindow: class {}
}))
vi.mock('../../src/main/mission-ipc', () => ({ setMissionListObserver: (): void => undefined }))
vi.mock('../../src/main/pty', () => ({ setPtyExitObserver: (): void => undefined }))
vi.mock('../../src/main/detect/task-state-hub', () => ({
  getTaskStates: () => new Map(),
  addTaskEventObserver: (): (() => void) => () => undefined
}))
vi.mock('../../src/main/claude-watcher', () => ({ classifyTranscriptLines: () => null }))
vi.mock('../../src/main/claude-cli', () => ({ resolveClaudePath: async () => null }))
vi.mock('../../src/main/user-projects', () => ({
  readUserProjects: async () => ({ version: 1, projects: [] }),
  onFolderRemoved: (): (() => void) => () => undefined
}))

const card = (over: Partial<YourMoveCard>): YourMoveCard => ({
  id: 'c1',
  sessionId: 'sess-0001',
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Merge PROJ-231 now?',
  options: ['Merge', 'Wait'],
  source: 'judge',
  lane: 'live',
  openedAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  ...over
})

// The first import transforms the whole main-process graph, which can outlast a test's timeout.
beforeAll(async () => {
  await import('../../src/main/your-move/ipc')
}, 60_000)

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-exit-'))
  h.userData = dir
  h.handlers.clear()
  const cards = [card({ id: 'c1' }), card({ id: 'c2', ask: 'Run the migration on api-gateway?' })]
  await writeFile(
    path.join(dir, 'your-move.json'),
    JSON.stringify({ version: 1, cards, cursors: {} })
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function boot(): Promise<{
  call: (channel: string, ...args: unknown[]) => Promise<unknown>
  close: () => void
}> {
  const { registerYourMove, closeYourMove } = await import('../../src/main/your-move/ipc')
  registerYourMove(() => null)
  return {
    call: async (channel, ...args) => h.handlers.get(channel)?.({}, ...args),
    close: closeYourMove
  }
}

const labels = async (): Promise<{ ts: number; label: string; card: YourMoveCard }[]> =>
  (await readFile(path.join(dir, 'your-move-labels.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe('yourMove:exit', () => {
  it('exit not-for-me and already-handled close the card and log separate labels', async () => {
    const { call, close } = await boot()
    expect(await call('yourMove:exit', { cardId: 'c1', label: 'not-for-me' })).toMatchObject({
      ok: true
    })
    expect(await call('yourMove:exit', { cardId: 'c2', label: 'already-handled' })).toMatchObject({
      ok: true
    })

    const list = (await call('yourMove:list')) as CardView[]
    const byId = new Map(list.map((c) => [c.id, c]))
    expect(byId.get('c1')).toMatchObject({ closedBy: 'not-for-me' })
    expect(byId.get('c2')).toMatchObject({ closedBy: 'already-handled' })
    expect(byId.get('c1')?.closedAt).toBeTypeOf('number')

    const rows = await labels()
    expect(rows.map((r) => [r.card.id, r.label])).toEqual([
      ['c1', 'not-for-me'],
      ['c2', 'already-handled']
    ])
    // the labelled example is the card as the operator saw it, still open when logged
    expect(rows[0].card.ask).toBe('Merge PROJ-231 now?')
    expect(rows[0].card.closedAt).toBeUndefined()
    expect(rows[0].ts).toBeTypeOf('number')
    expect((await stat(path.join(dir, 'your-move-labels.jsonl'))).mode & 0o777).toBe(0o600)
    close()
  })

  it('refuses a bad label, an unknown card and a card that is already closed, and logs nothing', async () => {
    const { call, close } = await boot()
    expect(await call('yourMove:exit', { cardId: 'c1', label: 'dismiss' })).toMatchObject({
      ok: false
    })
    expect(await call('yourMove:exit', { cardId: 'nope', label: 'not-for-me' })).toMatchObject({
      ok: false
    })
    expect(await call('yourMove:exit', undefined)).toMatchObject({ ok: false })
    expect(await call('yourMove:exit', { cardId: 'c1', label: 'not-for-me' })).toMatchObject({
      ok: true
    })
    expect(await call('yourMove:exit', { cardId: 'c1', label: 'already-handled' })).toMatchObject({
      ok: false
    })
    expect((await labels()).map((r) => r.label)).toEqual(['not-for-me'])
    close()
  })
})
