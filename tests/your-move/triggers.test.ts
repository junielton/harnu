import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookTaskEvent } from '../../src/main/detect/task-state-hub'
import type { YourMoveMode } from '../../src/main/your-move/core'
import { createInspector, type InspectRequest } from '../../src/main/your-move/inspector'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'
import { readFrom } from '../../src/main/your-move/transcript'
import {
  STOP_SETTLE_MS,
  createEnsureCursor,
  createTriggers,
  type TriggerDeps
} from '../../src/main/your-move/triggers'

let dir: string
let store: YourMoveStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-triggers-'))
  store = await openYourMoveStore(path.join(dir, 'your-move.json'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const asst = (text: string, entrypoint = 'cli') => ({
  type: 'assistant',
  entrypoint,
  message: { content: [{ type: 'text', text }] }
})
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

const ev = (event: string, over: Partial<HookTaskEvent> = {}): HookTaskEvent => ({
  sessionId: 'sess-0001',
  taskState: 'idle',
  event,
  ts: 1,
  source: 'hook',
  payload: { transcriptPath: '/t/sess-0001.jsonl', cwd: '/work/acme' },
  ...over
})

function harness(over: Partial<TriggerDeps> = {}) {
  const timers: { fn: () => void; ms: number }[] = []
  const requests: InspectRequest[] = []
  const calls = { ensureCursor: [] as [string, string][], has: 0, delay: [] as number[], locate: 0 }
  const deps: TriggerDeps = {
    inspector: {
      request: async (r) => {
        requests.push(r)
        return 'judged'
      }
    },
    store,
    mode: () => 'observe' as YourMoveMode,
    eligible: async () => true,
    locate: async () => {
      calls.locate++
      return '/located/sess-0001.jsonl'
    },
    resolveFolder: async (_id, cwd) => cwd ?? '/work/located',
    now: () => 1000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    ensureCursor: async (id, p) => {
      calls.ensureCursor.push([id, p])
    },
    transcriptHas: async () => {
      calls.has++
      return true
    },
    delay: async (ms) => {
      calls.delay.push(ms)
    },
    ...over
  }
  const t = createTriggers(deps)
  const fireAll = async (): Promise<void> => {
    while (timers.length > 0) timers.shift()!.fn()
    await vi.waitFor(() => undefined)
    await new Promise((r) => setTimeout(r, 5))
  }
  return { t, timers, requests, calls, fireAll }
}

describe('Stop-driven inspection', () => {
  it('Stop requests one inspection after STOP_SETTLE_MS, after the handler returned', async () => {
    const h = harness()
    h.t.onTaskEvent(
      ev('Stop', {
        payload: {
          transcriptPath: '/t/a.jsonl',
          cwd: '/work/acme',
          lastAssistantMessage: 'Shall I go on?'
        }
      })
    )
    expect(h.requests).toHaveLength(0)
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0].ms).toBe(STOP_SETTLE_MS)
    await h.fireAll()
    expect(h.requests).toEqual([
      {
        sessionId: 'sess-0001',
        folder: '/work/acme',
        transcriptPath: '/t/a.jsonl',
        trigger: 'stop',
        lastAssistantMessage: 'Shall I go on?'
      }
    ])
  })

  it('two Stop events inside the settle window request one inspection', async () => {
    const h = harness()
    h.t.onTaskEvent(ev('Stop'))
    h.t.onTaskEvent(ev('Stop', { source: 'companion' }))
    await h.fireAll()
    expect(h.requests).toHaveLength(1)
  })

  it('a companion Stop with no transcript path is located by session id', async () => {
    const h = harness()
    h.t.onTaskEvent(ev('Stop', { source: 'companion', payload: undefined }))
    await h.fireAll()
    expect(h.calls.locate).toBe(1)
    expect(h.requests[0].transcriptPath).toBe('/located/sess-0001.jsonl')
    expect(h.requests[0].folder).toBe('/work/located')
  })

  it('a Stop whose transcript cannot be located requests nothing and does not throw', async () => {
    const h = harness({ locate: async () => null })
    h.t.onTaskEvent(ev('Stop', { payload: undefined }))
    await h.fireAll()
    expect(h.requests).toHaveLength(0)
  })

  it('when lastAssistantMessage is absent from the transcript, re-reads up to 3 times, then passes it to be appended', async () => {
    const h = harness({ transcriptHas: async () => false })
    h.t.onTaskEvent(
      ev('Stop', {
        payload: { transcriptPath: '/t/a.jsonl', cwd: '/c', lastAssistantMessage: 'late text' }
      })
    )
    await h.fireAll()
    expect(h.calls.delay).toHaveLength(3)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].lastAssistantMessage).toBe('late text')
  })

  it('stops re-reading as soon as the transcript has caught up', async () => {
    let n = 0
    const h = harness({ transcriptHas: async () => ++n >= 2 })
    h.t.onTaskEvent(
      ev('Stop', {
        payload: { transcriptPath: '/t/a.jsonl', cwd: '/c', lastAssistantMessage: 'late text' }
      })
    )
    await h.fireAll()
    expect(h.calls.delay).toHaveLength(1)
    expect(h.requests).toHaveLength(1)
  })

  it('an event from a subagent (agentId set) requests nothing', async () => {
    const h = harness()
    h.t.onTaskEvent(ev('Stop', { agentId: 'agent-9' }))
    h.t.onTaskEvent(ev('SessionStart', { agentId: 'agent-9' }))
    await h.fireAll()
    expect(h.timers).toHaveLength(0)
    expect(h.requests).toHaveLength(0)
    expect(h.calls.ensureCursor).toHaveLength(0)
  })

  it('Off reads nothing: no locate, no transcript check, no cursor, no request', async () => {
    const h = harness({ mode: () => 'off' })
    h.t.onTaskEvent(ev('Stop', { payload: { lastAssistantMessage: 'x' } }))
    h.t.onTaskEvent(ev('SessionStart'))
    h.t.onTaskEvent(ev('UserPromptSubmit'))
    await h.fireAll()
    expect(h.calls.locate).toBe(0)
    expect(h.calls.has).toBe(0)
    expect(h.calls.ensureCursor).toHaveLength(0)
    expect(h.requests).toHaveLength(0)
  })

  it('a blocked, archived or folder-off session is not read', async () => {
    const h = harness({ eligible: async () => false })
    h.t.onTaskEvent(
      ev('Stop', {
        payload: { transcriptPath: '/t/a.jsonl', cwd: '/c', lastAssistantMessage: 'x' }
      })
    )
    h.t.onTaskEvent(ev('SessionStart'))
    await h.fireAll()
    expect(h.calls.has).toBe(0)
    expect(h.calls.ensureCursor).toHaveLength(0)
    expect(h.requests).toHaveLength(0)
  })

  it('dispose cancels what is pending', async () => {
    const h = harness()
    h.t.onTaskEvent(ev('Stop'))
    h.t.dispose()
    await h.fireAll()
    expect(h.requests).toHaveLength(0)
  })

  it('a throwing dependency never escapes the observer', async () => {
    const h = harness({
      locate: async () => {
        throw new Error('boom')
      }
    })
    expect(() => h.t.onTaskEvent(ev('Stop', { payload: undefined }))).not.toThrow()
    await h.fireAll()
    expect(h.requests).toHaveLength(0)
  })
})

describe('first sight sets the cursor', () => {
  it('SessionStart and UserPromptSubmit on an unseen session set the cursor, so the first turn is judged', async () => {
    const file = path.join(dir, 'sess-0001.jsonl')
    await writeFile(file, jsonl([asst('hello'), asst('world')]))
    const size = (await stat(file)).size
    const ensure = createEnsureCursor({
      store,
      read: readFrom,
      classify: (lines) =>
        lines.some((l) => (l as { entrypoint?: string }).entrypoint === 'cli')
          ? 'interactive'
          : null,
      now: () => 5
    })
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const id = event === 'SessionStart' ? 'sess-aaaa' : 'sess-bbbb'
      const h = harness({ ensureCursor: ensure })
      h.t.onTaskEvent(ev(event, { sessionId: id, payload: { transcriptPath: file, cwd: '/c' } }))
      await h.fireAll()
      expect(store.state().cursors[id]).toMatchObject({ offset: size, shadowOffset: size })
    }
    // a second event never moves an existing cursor
    await writeFile(file, jsonl([asst('hello'), asst('world'), asst('more')]))
    await ensure('sess-aaaa', file)
    expect(store.state().cursors['sess-aaaa'].offset).toBe(size)
  })

  it('a session that already has a cursor is left alone', async () => {
    const h = harness()
    await store.transact((s) => ({
      next: { ...s, cursors: { 'sess-0001': { offset: 7, lastInspectedAt: 1 } } },
      result: null
    }))
    h.t.onTaskEvent(ev('UserPromptSubmit'))
    await h.fireAll()
    expect(h.calls.ensureCursor).toHaveLength(0)
  })
})

describe('Harnu own headless runs', () => {
  it('an event for a programmatic transcript files nothing', async () => {
    const file = path.join(dir, 'sess-0001.jsonl')
    await writeFile(file, jsonl([asst('Shall I continue?', 'sdk-cli')]))
    const classify = (lines: readonly unknown[]): 'interactive' | 'programmatic' | null => {
      for (const l of lines) {
        const ep = (l as { entrypoint?: string }).entrypoint
        if (ep) return ep === 'cli' ? 'interactive' : 'programmatic'
      }
      return null
    }
    const detect = vi.fn()
    const enrich = vi.fn()
    const inspector = createInspector({
      store,
      read: readFrom,
      detect,
      enrich,
      now: () => 10,
      mintId: () => 'id-1',
      isBlocked: () => false,
      isArchived: () => false,
      isFolderOff: () => false,
      mode: () => 'observe',
      midTurnLive: () => false,
      classify
    })
    const h = harness({
      inspector,
      ensureCursor: createEnsureCursor({ store, read: readFrom, classify, now: () => 10 })
    })
    const payload = { transcriptPath: file, cwd: '/c', lastAssistantMessage: 'Shall I continue?' }
    h.t.onTaskEvent(ev('SessionStart', { payload }))
    h.t.onTaskEvent(ev('UserPromptSubmit', { payload }))
    h.t.onTaskEvent(ev('Stop', { payload }))
    await h.fireAll()
    await inspector.idle()
    expect(detect).not.toHaveBeenCalled()
    expect(enrich).not.toHaveBeenCalled()
    expect(store.state().cards).toEqual([])
    expect(store.state().cursors).toEqual({})
  })
})
