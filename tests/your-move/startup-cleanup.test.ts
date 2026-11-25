/**
 * The wiring of the BUG-300 cleanup: booting Your move closes the open judge cards of sessions
 * the operator never typed in. The cleanup itself is tested in `operator-eligibility.test.ts`;
 * this file fails when the call in `ipc.ts` is removed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CardView, YourMoveCard } from '../../src/main/your-move/core'

const h = vi.hoisted(() => ({
  userData: '',
  lookups: {} as Record<string, { state: string; path?: string }>,
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
// The disk is not asked: each session's lookup answer is the test's.
vi.mock('../../src/main/your-move/locate', () => ({
  createTranscriptLocator: () => ({
    lookup: async (id: string) => h.lookups[id] ?? { state: 'missing' },
    locate: async () => null,
    note: (): void => undefined
  })
}))

const card = (over: Partial<YourMoveCard>): YourMoveCard => ({
  id: 'c',
  sessionId: 's',
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Merge it?',
  source: 'judge',
  lane: 'live',
  openedAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  ...over
})

beforeAll(async () => {
  await import('../../src/main/your-move/ipc')
}, 60_000)

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-startup-'))
  h.userData = dir
  h.handlers.clear()
  const human = path.join(dir, 'human.jsonl')
  const agent = path.join(dir, 'agent.jsonl')
  await writeFile(
    human,
    JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'hi' } }) + '\n'
  )
  await writeFile(
    agent,
    JSON.stringify({
      type: 'user',
      origin: { kind: 'human' },
      message: { content: '[Harnu · Roadmap dispatch] go' }
    }) + '\n'
  )
  h.lookups = {
    human: { state: 'found', path: human },
    agent: { state: 'found', path: agent },
    ghost: { state: 'missing' },
    flaky: { state: 'unknown' }
  }
  await writeFile(
    path.join(dir, 'your-move.json'),
    JSON.stringify({
      version: 1,
      cursors: {},
      cards: [
        ...['human', 'agent', 'ghost', 'flaky'].map((s) =>
          card({ id: `c-${s}`, sessionId: s, folder: dir })
        ),
        // BUG-308: an expired card, and one whose folder is gone, of sessions that are fine.
        card({ id: 'c-expired', sessionId: 'flaky', folder: dir, updatedAt: 1 }),
        card({ id: 'c-nofolder', sessionId: 'flaky', folder: path.join(dir, 'removed') })
      ]
    })
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('startup cleanup wiring (BUG-300)', () => {
  it('booting closes the judge cards of agent-only and transcript-less sessions, and keeps the rest', async () => {
    const { registerYourMove, closeYourMove } = await import('../../src/main/your-move/ipc')
    registerYourMove(() => null)
    try {
      const list = async (): Promise<CardView[]> =>
        (await h.handlers.get('yourMove:list')?.({})) as CardView[]
      await vi.waitFor(
        async () => {
          const byId = new Map((await list()).map((c) => [c.id, c]))
          expect(byId.get('c-agent')?.closedAt).toBeTypeOf('number')
          expect(byId.get('c-ghost')?.closedAt).toBeTypeOf('number')
        },
        { timeout: 5_000 }
      )
      const byId = new Map((await list()).map((c) => [c.id, c]))
      expect(byId.get('c-agent')?.closedBy).toBe('source-resolved')
      expect(byId.get('c-human')?.closedAt).toBeUndefined()
      expect(byId.get('c-flaky')?.closedAt).toBeUndefined()
    } finally {
      closeYourMove()
    }
  })

  it('booting also expires old cards and closes cards whose folder is gone (BUG-308)', async () => {
    const { registerYourMove, closeYourMove } = await import('../../src/main/your-move/ipc')
    registerYourMove(() => null)
    try {
      const list = async (): Promise<CardView[]> =>
        (await h.handlers.get('yourMove:list')?.({})) as CardView[]
      await vi.waitFor(
        async () => {
          const byId = new Map((await list()).map((c) => [c.id, c]))
          expect(byId.get('c-expired')?.closedBy).toBe('expired')
          expect(byId.get('c-nofolder')?.closedBy).toBe('folder-removed')
        },
        { timeout: 5_000 }
      )
      const byId = new Map((await list()).map((c) => [c.id, c]))
      expect(byId.get('c-human')?.closedAt).toBeUndefined()
    } finally {
      closeYourMove()
    }
  })
})
