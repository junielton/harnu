import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookTaskEvent } from '../../src/main/detect/task-state-hub'
import type { TaskState } from '../../src/main/hook-state'
import type { CardLane, YourMoveCard, YourMoveMode } from '../../src/main/your-move/core'
import {
  createGateWatch,
  gateDraft,
  pendingHumanGate,
  watchArchive,
  watchFolderRemoval,
  type GateWatchDeps
} from '../../src/main/your-move/source-gate'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'
import { readFrom } from '../../src/main/your-move/transcript'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))
vi.mock('../../src/main/claude-reader', () => ({
  scanFolders: async (): Promise<unknown[]> => []
}))

let dir: string
let store: YourMoveStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-gate-'))
  h.userDataDir = dir
  store = await openYourMoveStore(path.join(dir, 'your-move.json'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

let uid = 0
const asstTool = (
  name: string,
  input: Record<string, unknown>,
  id: string,
  stopReason: string | null = 'tool_use'
) => ({
  type: 'assistant',
  uuid: `u-${++uid}`,
  entrypoint: 'cli',
  message: {
    stop_reason: stopReason,
    content: [{ type: 'tool_use', id, name, input }]
  }
})
const asstText = (text: string) => ({
  type: 'assistant',
  uuid: `u-${++uid}`,
  entrypoint: 'cli',
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
})
const toolResult = (id: string) => ({
  type: 'user',
  uuid: `u-${++uid}`,
  entrypoint: 'cli',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] }
})
const ask = (id: string, stopReason: string | null = 'tool_use') =>
  asstTool(
    'AskUserQuestion',
    { questions: [{ question: 'Which database should we use?', options: [] }] },
    id,
    stopReason
  )
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

describe('pendingHumanGate', () => {
  it('a last assistant entry with an AskUserQuestion tool_use and no result is pending, stop_reason null included', () => {
    for (const stopReason of ['tool_use', null]) {
      expect(pendingHumanGate([asstText('hi'), ask('toolu_1', stopReason)])).toEqual({
        toolUseId: 'toolu_1',
        tool: 'AskUserQuestion',
        question: 'Which database should we use?'
      })
    }
  })

  it('ExitPlanMode is pending too', () => {
    const plan = asstTool('ExitPlanMode', { plan: '1. do it' }, 'toolu_2')
    expect(pendingHumanGate([plan])).toMatchObject({ toolUseId: 'toolu_2', tool: 'ExitPlanMode' })
  })

  it('a tool_result after it is not pending', () => {
    expect(pendingHumanGate([ask('toolu_1'), toolResult('toolu_1')])).toBeNull()
  })

  it('no card for a generic permission prompt', () => {
    expect(pendingHumanGate([asstTool('Bash', { command: 'rm -rf x' }, 'toolu_3')])).toBeNull()
  })

  it('a subagent entry after it does not hide it, and one before it does not fake it', () => {
    const sidechain = { ...asstText('subagent chatter'), isSidechain: true }
    expect(pendingHumanGate([ask('toolu_1'), sidechain])).toMatchObject({ toolUseId: 'toolu_1' })
    expect(pendingHumanGate([{ ...ask('toolu_1'), isSidechain: true }])).toBeNull()
  })

  it('an empty window, or one with no conversation entries, is not pending', () => {
    expect(pendingHumanGate([])).toBeNull()
    expect(pendingHumanGate([{ type: 'last-prompt' }])).toBeNull()
  })

  it('a question block with no readable question still counts', () => {
    expect(pendingHumanGate([asstTool('AskUserQuestion', {}, 'toolu_4')])).toMatchObject({
      toolUseId: 'toolu_4',
      question: ''
    })
  })
})

describe('gateDraft', () => {
  it('files a decide card with no options, so only Open session is offered', () => {
    const d = gateDraft(
      { toolUseId: 'toolu_1', tool: 'AskUserQuestion', question: 'Which database should we use?' },
      'sess-1',
      '/work/acme',
      'live'
    )
    expect(d).toMatchObject({
      kind: 'decide',
      ask: 'Which database should we use?',
      source: 'human-gate',
      sourceKey: 'gate:toolu_1',
      sessionId: 'sess-1',
      folder: '/work/acme',
      lane: 'live'
    })
    expect(d.options).toBeUndefined()
  })

  it('an ExitPlanMode card reads through a fixed system key', () => {
    const d = gateDraft({ toolUseId: 't', tool: 'ExitPlanMode', question: '' }, 's', '/f', 'live')
    expect(d.askKey).toMatchObject({ key: 'yourMove.system.planReady' })
    expect(d.ask).toMatch(/plan/i)
  })

  it('an empty question falls back to a fixed sentence, never an empty ask', () => {
    const d = gateDraft(
      { toolUseId: 't', tool: 'AskUserQuestion', question: '' },
      's',
      '/f',
      'live'
    )
    expect(d.ask.length).toBeGreaterThan(10)
  })
})

describe('the gate watch', () => {
  const NOW = 5_000
  let file: string
  beforeEach(() => {
    file = path.join(dir, 'sess-0001.jsonl')
  })

  function watch(over: Partial<GateWatchDeps> = {}) {
    let n = 0
    const mode = { value: 'observe' as YourMoveMode }
    const states = new Map<string, TaskState>()
    const reads = vi.fn(readFrom)
    const deps: GateWatchDeps = {
      store,
      mode: () => mode.value,
      lane: () => 'observe' as CardLane,
      eligible: async () => true,
      locate: async () => file,
      resolveFolder: async (_id, cwd) => cwd ?? '/work/acme',
      read: reads,
      states: () => states,
      mintId: () => `card-${++n}`,
      now: () => NOW,
      ...over
    }
    return { gate: createGateWatch(deps), mode, states, reads }
  }
  const needsInput = (over: Partial<HookTaskEvent> = {}): HookTaskEvent => ({
    sessionId: 'sess-0001',
    taskState: 'needs-input',
    event: 'Notification',
    ts: 1,
    source: 'hook',
    payload: { cwd: '/work/acme', transcriptPath: file },
    ...over
  })
  const open = (): YourMoveCard[] =>
    store.state().cards.filter((c) => c.closedAt === undefined && c.source === 'human-gate')

  it('a needs-input edge on a parked AskUserQuestion files a card', async () => {
    await writeFile(file, jsonl([asstText('Let me ask.'), ask('toolu_1', null)]))
    const { gate } = watch()
    gate.onTaskEvent(needsInput())
    await gate.idle()
    expect(open()).toHaveLength(1)
    expect(open()[0]).toMatchObject({
      sessionId: 'sess-0001',
      sourceKey: 'gate:toolu_1',
      kind: 'decide'
    })
  })

  it('a sweep tick finds a gate whose edge was missed, and keeps its clock', async () => {
    await writeFile(file, jsonl([ask('toolu_1')]))
    const w = watch()
    w.states.set('sess-0001', 'needs-input')
    await w.gate.tick()
    await w.gate.tick()
    expect(open()).toHaveLength(1)
    expect(open()[0].openedAt).toBe(NOW)
  })

  it('the answered gate closes as source-resolved', async () => {
    await writeFile(file, jsonl([ask('toolu_1')]))
    const w = watch()
    w.gate.onTaskEvent(needsInput())
    await w.gate.idle()
    expect(open()).toHaveLength(1)
    // the operator answers in the session: a result follows, the state moves on
    await writeFile(file, jsonl([ask('toolu_1'), toolResult('toolu_1'), asstText('Thanks.')]))
    w.gate.onTaskEvent(needsInput({ taskState: 'working', event: 'UserPromptSubmit' }))
    await w.gate.idle()
    expect(open()).toHaveLength(0)
    expect(store.state().cards[0]).toMatchObject({ closedBy: 'source-resolved' })
  })

  it('a tick closes an answered gate even when no event arrived', async () => {
    await writeFile(file, jsonl([ask('toolu_1')]))
    const w = watch()
    w.states.set('sess-0001', 'needs-input')
    await w.gate.tick()
    await writeFile(file, jsonl([ask('toolu_1'), toolResult('toolu_1')]))
    w.states.set('sess-0001', 'working')
    await w.gate.tick()
    expect(open()).toHaveLength(0)
  })

  it('no card for a generic permission prompt', async () => {
    await writeFile(file, jsonl([asstTool('Bash', { command: 'make' }, 'toolu_9')]))
    const { gate } = watch()
    gate.onTaskEvent(needsInput())
    await gate.idle()
    expect(store.state().cards).toHaveLength(0)
  })

  it('an idle session with no open gate card is not read', async () => {
    await writeFile(file, jsonl([asstText('done')]))
    const w = watch()
    w.gate.onTaskEvent(needsInput({ taskState: 'idle', event: 'Stop' }))
    w.states.set('sess-0001', 'idle')
    await w.gate.tick()
    await w.gate.idle()
    expect(w.reads).not.toHaveBeenCalled()
  })

  it('Off reads nothing', async () => {
    await writeFile(file, jsonl([ask('toolu_1')]))
    const w = watch()
    w.mode.value = 'off'
    w.states.set('sess-0001', 'needs-input')
    w.gate.onTaskEvent(needsInput())
    await w.gate.tick()
    await w.gate.idle()
    expect(w.reads).not.toHaveBeenCalled()
    expect(store.state().cards).toHaveLength(0)
  })

  it('a blocked, archived or folder-off session is not read', async () => {
    await writeFile(file, jsonl([ask('toolu_1')]))
    const w = watch({ eligible: async () => false })
    w.states.set('sess-0001', 'needs-input')
    w.gate.onTaskEvent(needsInput())
    await w.gate.tick()
    await w.gate.idle()
    expect(w.reads).not.toHaveBeenCalled()
  })

  it('a subagent edge is ignored', async () => {
    await writeFile(file, jsonl([ask('toolu_1')]))
    const w = watch()
    w.gate.onTaskEvent(needsInput({ agentId: 'agent-1' }))
    await w.gate.idle()
    expect(w.reads).not.toHaveBeenCalled()
  })

  it('an unreadable transcript closes nothing and never throws', async () => {
    await writeFile(file, jsonl([ask('toolu_1')]))
    const w = watch()
    w.gate.onTaskEvent(needsInput())
    await w.gate.idle()
    const failing = watch({
      read: async () => {
        throw new Error('EIO')
      }
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    failing.gate.onTaskEvent(needsInput({ taskState: 'working' }))
    failing.states.set('sess-0001', 'working')
    await failing.gate.tick()
    await failing.gate.idle()
    expect(open()).toHaveLength(1)
  })
})

describe('closes on archive and folder removal', () => {
  const card = (id: string, sessionId: string, folder: string): YourMoveCard => ({
    id,
    sessionId,
    folder,
    kind: 'decide',
    ask: 'x',
    source: 'judge',
    lane: 'live',
    openedAt: 1,
    updatedAt: 1
  })
  const seed = (cards: YourMoveCard[]) =>
    store.transact((s) => ({ next: { ...s, cards }, result: null }))

  it('archiving a session closes its cards as archived', async () => {
    await seed([card('a', 'sess-1', '/f'), card('b', 'sess-1', '/f'), card('c', 'sess-2', '/f')])
    let listener: ((ids: string[]) => void) | undefined
    const archived = new Set<string>()
    const stop = watchArchive({
      store,
      archive: {
        onChange: (cb) => {
          listener = cb
          return () => undefined
        },
        has: (id) => archived.has(id)
      },
      now: () => 77
    })
    archived.add('sess-1')
    listener!(['sess-1'])
    await vi.waitFor(() =>
      expect(store.state().cards.filter((c) => c.closedBy === 'archived')).toHaveLength(2)
    )
    expect(store.state().cards.find((c) => c.id === 'c')?.closedAt).toBeUndefined()
    stop()
  })

  it('unarchiving a session closes nothing', async () => {
    await seed([card('a', 'sess-1', '/f')])
    let listener: ((ids: string[]) => void) | undefined
    watchArchive({
      store,
      archive: {
        onChange: (cb) => {
          listener = cb
          return () => undefined
        },
        has: () => false
      },
      now: () => 77
    })
    listener!(['sess-1'])
    await new Promise((r) => setTimeout(r, 20))
    expect(store.state().cards[0].closedAt).toBeUndefined()
  })

  it('removing a folder closes its cards as folder-removed; hiding it does not', async () => {
    const userProjects = await import('../../src/main/user-projects')
    const root = '/nonexistent/your-move/acme'
    await seed([
      card('a', 's1', root),
      card('b', 's2', `${root}/api`),
      card('c', 's3', '/nonexistent/your-move/other')
    ])
    const stop = watchFolderRemoval({
      store,
      subscribe: userProjects.onFolderRemoved,
      now: () => 99
    })
    await userProjects.addUserProject({
      path: root,
      alias: 'acme',
      addedAt: '2026-01-01',
      worktrees: []
    })
    await userProjects.hideUserProject(root)
    await new Promise((r) => setTimeout(r, 30))
    expect(store.state().cards.every((c) => c.closedAt === undefined)).toBe(true)

    await userProjects.removeUserProject(root)
    await vi.waitFor(() =>
      expect(store.state().cards.filter((c) => c.closedBy === 'folder-removed')).toHaveLength(2)
    )
    expect(store.state().cards.find((c) => c.id === 'c')?.closedAt).toBeUndefined()
    stop()
  })

  it('removing a ghost folder closes its cards too', async () => {
    const userProjects = await import('../../src/main/user-projects')
    const root = '/nonexistent/your-move/ghost'
    await seed([card('a', 's1', root)])
    const stop = watchFolderRemoval({
      store,
      subscribe: userProjects.onFolderRemoved,
      now: () => 99
    })
    await userProjects.hideUserProject(root)
    const result = await userProjects.removeGhostFolder(() => null, root)
    expect(result.ok).toBe(true)
    await vi.waitFor(() => expect(store.state().cards[0].closedBy).toBe('folder-removed'))
    stop()
  })

  it('a listener that is removed hears nothing', async () => {
    const userProjects = await import('../../src/main/user-projects')
    const root = '/nonexistent/your-move/quiet'
    await seed([card('a', 's1', root)])
    const stop = watchFolderRemoval({
      store,
      subscribe: userProjects.onFolderRemoved,
      now: () => 99
    })
    stop()
    await userProjects.addUserProject({
      path: root,
      alias: 'q',
      addedAt: '2026-01-01',
      worktrees: []
    })
    await userProjects.removeUserProject(root)
    await new Promise((r) => setTimeout(r, 30))
    expect(store.state().cards[0].closedAt).toBeUndefined()
  })
})
