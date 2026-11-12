// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import {
  createStallReporter,
  installComponentSpans,
  installStoreSpans,
  rendererSpans,
  withRendererOwner
} from '../src/renderer/src/lib/stall-observer'
import { createSpanRing, type StallRecord } from '../src/shared/stall-core'

function hold(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    /* a task that does not yield */
  }
}

describe('renderer stall reporter', () => {
  const setup = () => {
    const sent: StallRecord[][] = []
    const timers: Array<() => void> = []
    const spans = createSpanRing()
    let t = 10_000
    const hints: Array<{ owner: string; kind: 'event' } | null> = []
    const reporter = createStallReporter({
      send: (b) => sent.push(b),
      timeOrigin: 1_000_000,
      spans,
      now: () => t,
      hint: () => hints.shift() ?? null,
      setTimer: (fn) => timers.push(fn)
    })
    return {
      sent,
      timers,
      spans,
      reporter,
      hints,
      advance: (ms: number) => {
        t += ms
      },
      run: () => timers.splice(0).forEach((f) => f())
    }
  }

  it('names a long task by the owner that overlapped it and batches the report', () => {
    const { sent, timers, spans, reporter, run } = setup()
    spans.record('store:sessions.load', 'action', 1000, 1230)
    reporter.onLongTask(1000, 240)
    reporter.onLongTask(5000, 90) // nobody owned this one
    expect(sent).toEqual([]) // batched, not sent per task
    expect(timers).toHaveLength(1)
    run()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual([
      {
        atMs: 1_001_240,
        thread: 'renderer',
        durationMs: 240,
        owner: 'store:sessions.load',
        ownerKind: 'action'
      },
      {
        atMs: 1_005_090,
        thread: 'renderer',
        durationMs: 90,
        owner: 'unattributed',
        ownerKind: 'unattributed'
      }
    ])
  })

  it('ignores tasks under 50 ms', () => {
    const { sent, timers, reporter } = setup()
    reporter.onLongTask(0, 49)
    reporter.onLateTick(0, 49)
    expect(timers).toHaveLength(0)
    reporter.flush()
    expect(sent).toEqual([])
  })

  it('a late heartbeat tick no observer entry covers is reported after a short wait, named by the IPC event hint', () => {
    const { sent, reporter, hints, advance, run } = setup()
    hints.push({ owner: 'event:fleet:updated', kind: 'event' })
    reporter.onLateTick(2000, 2210)
    run() // too early: the observer entry may still arrive
    expect(sent).toEqual([])
    advance(500)
    run()
    expect(sent[0]).toEqual([
      {
        atMs: 1_002_210,
        thread: 'renderer',
        durationMs: 210,
        owner: 'event:fleet:updated',
        ownerKind: 'event'
      }
    ])
  })

  it('an observer entry that arrives in time replaces the heartbeat estimate of the same stall', () => {
    const { sent, reporter, advance, run } = setup()
    reporter.onLateTick(2000, 2210)
    reporter.onLongTask(2005, 200)
    advance(500)
    run()
    expect(sent.flat()).toHaveLength(1)
    expect(sent.flat()[0].durationMs).toBe(200) // the exact one
  })

  it('a heartbeat estimate is dropped when an exact entry already covers it', () => {
    const { sent, reporter, advance, run } = setup()
    reporter.onLongTask(2005, 200)
    reporter.onLateTick(2000, 2210)
    advance(500)
    run()
    expect(sent.flat()).toHaveLength(1)
  })
})

describe('renderer instruments', () => {
  it('withRendererOwner records the synchronous span', () => {
    const t0 = performance.now()
    withRendererOwner('job:test', 'job', () => hold(15))
    expect(rendererSpans.best(t0, performance.now())).toEqual({ owner: 'job:test', kind: 'job' })
  })

  it('a Pinia action holds the thread as store:<id>.<action>', () => {
    const pinia = createPinia()
    installStoreSpans(pinia)
    createApp({}).use(pinia) // plugins reach the stores of an installed pinia
    setActivePinia(pinia)
    const useFleet = defineStore('fleetProbe', () => {
      const n = 1
      function recompute(ms: number): number {
        hold(ms)
        return n
      }
      return { n, recompute }
    })
    const store = useFleet()
    const t0 = performance.now()
    expect(store.recompute(30)).toBe(1) // the wrapper returns the action's own result
    expect(rendererSpans.best(t0, performance.now())).toEqual({
      owner: 'store:fleetProbe.recompute',
      kind: 'action'
    })
  })

  it('a component render is owned by component:<Name>', () => {
    const Slow = defineComponent({
      name: 'SlowFleetList',
      render() {
        hold(30)
        return h('div', 'ok')
      }
    })
    const app = createApp(Slow)
    installComponentSpans(app)
    const host = document.createElement('div')
    const t0 = performance.now()
    app.mount(host)
    expect(host.textContent).toBe('ok')
    expect(rendererSpans.best(t0, performance.now())).toEqual({
      owner: 'component:SlowFleetList',
      kind: 'component'
    })
    app.unmount()
  })
})
