import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Admit } from '../../src/main/companion/arbitration-core'
import {
  addTaskEventObserver,
  configureHub,
  getTaskState,
  ingest,
  noteLiveness,
  pruneTaskState,
  resetHubForTests,
  type BridgeEvent
} from '../../src/main/detect/task-state-hub'

type Disposition = 'applied' | 'record-only' | 'dropped'

interface Rig {
  sends: { channel: string; payload: Record<string, unknown> }[]
  observed: { event: string; taskState: string; source?: string }[]
  recorded: { ev: BridgeEvent; disposition: Disposition }[]
  win: () => never
  hibernated: Set<string>
  verdict: { current: (ev: BridgeEvent) => Admit }
}

function rig(): Rig {
  const sends: Rig['sends'] = []
  const observed: Rig['observed'] = []
  const recorded: Rig['recorded'] = []
  const hibernated = new Set<string>()
  const verdict = { current: (_ev: BridgeEvent): Admit => 'apply' }
  configureHub({
    isHibernated: (sid) => hibernated.has(sid),
    admit: (ev) => verdict.current(ev),
    record: (ev, disposition) => void recorded.push({ ev, disposition })
  })
  addTaskEventObserver((e) =>
    observed.push({ event: e.event, taskState: e.taskState, source: e.source })
  )
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) =>
        void sends.push({ channel, payload })
    }
  }
  return { sends, observed, recorded, hibernated, verdict, win: (() => fakeWindow) as never }
}

const ev = (over: Partial<BridgeEvent> = {}): BridgeEvent => ({
  sessionId: 's1',
  event: 'UserPromptSubmit',
  ts: 1,
  source: 'hook',
  ...over
})

beforeEach(() => resetHubForTests())
afterEach(() => resetHubForTests())

describe('task-state hub', () => {
  it('with no companion wired every hook event is applied: fold, observers, renderer', () => {
    resetHubForTests() // no configureHub: the defaults
    const observed: string[] = []
    const sends: string[] = []
    addTaskEventObserver((e) => void observed.push(e.taskState))
    ingest(ev(), (() => ({
      isDestroyed: () => false,
      webContents: { send: (c: string) => void sends.push(c) }
    })) as never)
    expect(getTaskState('s1')).toBe('working')
    expect(observed).toEqual(['working'])
    expect(sends).toEqual(['claude:hook'])
  })

  it('isHibernated guards both sources', () => {
    const r = rig()
    r.hibernated.add('s1')
    ingest(ev({ source: 'hook' }), r.win)
    ingest(ev({ source: 'companion' }), r.win)
    ingest(ev({ source: 'hook', event: 'SessionEnd', matcher: 'logout' }), r.win)
    expect(getTaskState('s1')).toBeUndefined()
    expect(r.observed).toEqual([])
    expect(r.sends).toEqual([])
    expect(r.recorded).toEqual([])
  })

  it('legacy input for an owned family is dropped', () => {
    const r = rig()
    ingest(ev({ source: 'companion', event: 'UserPromptSubmit' }), r.win) // companion applied
    expect(getTaskState('s1')).toBe('working')
    r.observed.length = 0
    r.sends.length = 0
    r.recorded.length = 0
    r.verdict.current = (e) => (e.source === 'hook' ? 'drop' : 'apply')

    ingest(ev({ source: 'hook', event: 'Stop' }), r.win)

    expect(getTaskState('s1')).toBe('working') // unchanged
    expect(r.observed).toEqual([])
    expect(r.recorded).toHaveLength(1)
    expect(r.recorded[0]).toMatchObject({ disposition: 'dropped', ev: { source: 'hook' } })
    // the dropped legacy event is still a sign of life for the stuck timer
    expect(r.sends.map((s) => s.channel)).toEqual(['claude:liveness'])
    expect(r.sends[0].payload).toMatchObject({ sessionId: 's1', ts: 1 })
  })

  it('shadow never applies', () => {
    const r = rig()
    r.verdict.current = (e) => (e.source === 'companion' ? 'record-only' : 'apply')
    ingest(ev({ source: 'companion', event: 'UserPromptSubmit' }), r.win)
    ingest(ev({ source: 'companion', event: 'Stop' }), r.win)
    expect(getTaskState('s1')).toBeUndefined()
    expect(r.observed).toEqual([])
    expect(r.sends).toEqual([]) // no claude:hook, and no liveness for a companion event
    expect(r.recorded.map((x) => x.disposition)).toEqual(['record-only', 'record-only'])
  })

  it('legacy events still apply in shadow, and are recorded as applied', () => {
    const r = rig()
    ingest(ev({ source: 'hook' }), r.win)
    expect(getTaskState('s1')).toBe('working')
    expect(r.recorded).toEqual([
      { ev: expect.objectContaining({ source: 'hook' }), disposition: 'applied' }
    ])
  })

  it('an off family drops the companion event without recording it as applied', () => {
    const r = rig()
    r.verdict.current = (e) => (e.source === 'companion' ? 'drop' : 'apply')
    ingest(ev({ source: 'companion' }), r.win)
    expect(getTaskState('s1')).toBeUndefined()
    expect(r.recorded.map((x) => x.disposition)).toEqual(['dropped'])
    expect(r.sends).toEqual([]) // only a dropped LEGACY event is a sign of life
  })

  it('terminal edge, first writer wins', () => {
    const r = rig()
    r.verdict.current = (e) => (e.source === 'hook' ? 'drop' : 'apply') // the companion owns it
    ingest(ev({ source: 'companion', event: 'UserPromptSubmit' }), r.win)
    r.observed.length = 0
    // the companion's session.end never arrives (a lost bye): the legacy hook carries the edge
    ingest(ev({ source: 'hook', event: 'SessionEnd', matcher: 'logout', ts: 5 }), r.win)
    ingest(ev({ source: 'hook', event: 'SessionEnd', matcher: 'logout', ts: 6 }), r.win)
    expect(r.observed.filter((o) => o.event === 'SessionEnd')).toHaveLength(1)
    expect(r.observed[0].source).toBe('hook')
    expect(r.recorded.at(-1)).toMatchObject({ disposition: 'dropped' })
  })

  it('the terminal edge is first-writer-wins across sources', () => {
    const r = rig()
    ingest(ev({ source: 'companion', event: 'SessionEnd', matcher: 'logout' }), r.win)
    ingest(ev({ source: 'hook', event: 'SessionEnd', matcher: 'logout' }), r.win)
    expect(r.observed.filter((o) => o.event === 'SessionEnd')).toHaveLength(1)
    expect(r.observed[0].source).toBe('companion')
  })

  it('a companion SessionEnd in shadow is recorded and never admitted as the edge', () => {
    const r = rig()
    r.verdict.current = (e) => (e.source === 'companion' ? 'record-only' : 'apply')
    ingest(ev({ source: 'companion', event: 'SessionEnd', matcher: 'logout' }), r.win)
    expect(r.observed).toEqual([])
    ingest(ev({ source: 'hook', event: 'SessionEnd', matcher: 'logout' }), r.win)
    expect(r.observed.filter((o) => o.event === 'SessionEnd')).toHaveLength(1) // legacy still ends it
  })

  it('SessionEnd matcher clear is not a terminal edge', () => {
    const r = rig()
    ingest(ev({ event: 'SessionEnd', matcher: 'clear' }), r.win)
    ingest(ev({ event: 'SessionEnd', matcher: 'clear' }), r.win)
    expect(r.observed.filter((o) => o.event === 'SessionEnd')).toHaveLength(2)
  })

  it('pruning a session forgets that it ended, so a resume ends again', () => {
    const r = rig()
    ingest(ev({ event: 'SessionEnd', matcher: 'logout' }), r.win)
    pruneTaskState('s1')
    ingest(ev({ event: 'SessionEnd', matcher: 'logout' }), r.win)
    expect(r.observed.filter((o) => o.event === 'SessionEnd')).toHaveLength(2)
  })

  it('a throwing dependency never breaks the fold: it fails to apply', () => {
    configureHub({
      admit: () => {
        throw new Error('arbiter down')
      },
      record: () => {
        throw new Error('ledger down')
      }
    })
    const sends: string[] = []
    ingest(ev(), (() => ({
      isDestroyed: () => false,
      webContents: { send: (c: string) => void sends.push(c) }
    })) as never)
    expect(getTaskState('s1')).toBe('working') // legacy keeps working
    expect(sends).toEqual(['claude:hook'])
  })

  it('noteLiveness sends one claude:liveness and tolerates no window', () => {
    const send = vi.fn()
    noteLiveness('s9', 42, (() => ({ isDestroyed: () => false, webContents: { send } })) as never)
    expect(send).toHaveBeenCalledWith('claude:liveness', { sessionId: 's9', ts: 42 })
    expect(() => noteLiveness('s9', 42, () => null)).not.toThrow()
  })
})
