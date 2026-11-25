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
  leaderCheck: undefined as undefined | ((id: string) => Promise<boolean>),
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

vi.mock('../../src/main/your-move/source-mission', async (orig) => {
  const real = await orig<typeof import('../../src/main/your-move/source-mission')>()
  return {
    ...real,
    setMissionLeaderCheck: (fn: typeof h.leaderCheck): void => {
      h.leaderCheck = fn
      real.setMissionLeaderCheck(fn)
    }
  }
})

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
    flaky: { state: 'unknown' },
    sleeper: { state: 'unknown' }
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
        card({ id: 'c-expired', sessionId: 'sleeper', folder: dir, updatedAt: 1 }),
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

  it('the list poll is told which leader sessions are gone, and only on a sure answer (BUG-308)', async () => {
    const { registerYourMove, closeYourMove } = await import('../../src/main/your-move/ipc')
    registerYourMove(() => null)
    try {
      await vi.waitFor(() => expect(h.leaderCheck).toBeTypeOf('function'), { timeout: 5_000 })
      expect(await h.leaderCheck!('ghost')).toBe(true)
      expect(await h.leaderCheck!('flaky')).toBe(false)
      expect(await h.leaderCheck!('human')).toBe(false)
    } finally {
      closeYourMove()
    }
    expect(h.leaderCheck).toBeUndefined()
  })

  it('the running app sweeps idle cards again every hour (BUG-308)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const start = Date.now()
    // Not idle at boot; idle half an hour later.
    const nearly = start - 7 * 86_400_000 + 30 * 60_000
    await writeFile(
      path.join(dir, 'your-move.json'),
      JSON.stringify({
        version: 1,
        cursors: {},
        cards: [
          card({ id: 'c-soon', sessionId: 'flaky', folder: dir, updatedAt: nearly }),
          card({ id: 'c-ghost', sessionId: 'ghost', folder: dir })
        ]
      })
    )
    const { registerYourMove, closeYourMove } = await import('../../src/main/your-move/ipc')
    registerYourMove(() => null)
    try {
      const byId = async (): Promise<Map<string, CardView>> =>
        new Map(((await h.handlers.get('yourMove:list')?.({})) as CardView[]).map((c) => [c.id, c]))
      // the startup pass has run (it closed the gone one) and kept the other
      await vi.waitFor(async () => expect((await byId()).get('c-ghost')?.closedAt).toBeDefined(), {
        timeout: 4_000
      })
      expect((await byId()).get('c-soon')?.closedAt).toBeUndefined()
      await vi.advanceTimersByTimeAsync(61 * 60_000)
      await vi.waitFor(async () => expect((await byId()).get('c-soon')?.closedBy).toBe('expired'), {
        timeout: 4_000
      })
    } finally {
      closeYourMove()
      vi.useRealTimers()
    }
  })
})
