import { describe, it, expect, vi, afterEach } from 'vitest'
import { __testables } from '../src/main/claude-watcher'
const { createEventCoalescer } = __testables

type Sent = Array<[string, Record<string, unknown>]>
const recorder = (): { sent: Sent; send: (ch: string, p: unknown) => void } => {
  const sent: Sent = []
  return { sent, send: (ch, p) => sent.push([ch, p as Record<string, unknown>]) }
}

describe('watcher event coalescing (AC-21)', () => {
  afterEach(() => vi.useRealTimers())

  it('20 appends in 100 ms → 1–2 events; latest truth wins, first firstPromptCandidate wins', async () => {
    vi.useFakeTimers()
    const { sent, send } = recorder()
    const c = createEventCoalescer(send)
    for (let i = 0; i < 20; i++) {
      c.session({
        slug: 's',
        sessionId: 'a',
        ctxPct: i,
        firstPromptCandidate: i === 3 ? 'first' : i === 9 ? 'later' : undefined
      })
      await vi.advanceTimersByTimeAsync(5)
    }
    await vi.advanceTimersByTimeAsync(600)
    const ev = sent.filter(([ch]) => ch === 'claude:session:updated')
    expect(ev.length).toBeGreaterThanOrEqual(1)
    expect(ev.length).toBeLessThanOrEqual(2)
    expect(ev.at(-1)![1].ctxPct).toBe(19)
    expect(ev.map(([, p]) => p.firstPromptCandidate).filter(Boolean)[0]).toBe('first')
  })

  it('latest defined title/truth wins and an omitted field never erases an earlier one', async () => {
    vi.useFakeTimers()
    const { sent, send } = recorder()
    const c = createEventCoalescer(send)
    c.session({ slug: 's', sessionId: 'a', renameTitle: 'One', transcriptState: 'working' })
    c.session({ slug: 's', sessionId: 'a', aiTitle: 'AI', awaySummary: 'recap' })
    c.session({ slug: 's', sessionId: 'a', renameTitle: 'Two' })
    await vi.advanceTimersByTimeAsync(600)
    expect(sent).toHaveLength(1)
    expect(sent[0][1]).toEqual({
      slug: 's',
      sessionId: 'a',
      renameTitle: 'Two',
      aiTitle: 'AI',
      awaySummary: 'recap',
      transcriptState: 'working'
    })
  })

  it('a continuous stream still flushes within the 500 ms max-wait', async () => {
    vi.useFakeTimers()
    const { sent, send } = recorder()
    const c = createEventCoalescer(send)
    for (let i = 0; i < 60; i++) {
      c.session({ slug: 's', sessionId: 'a', ctxPct: i })
      await vi.advanceTimersByTimeAsync(10)
    }
    // 600 ms of appends every 10 ms: the 150 ms trailing edge never settles, so
    // only max-wait can have flushed.
    expect(sent.length).toBeGreaterThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(sent.at(-1)![1].ctxPct).toBe(59)
  })

  it('keys by session: two sessions never merge', async () => {
    vi.useFakeTimers()
    const { sent, send } = recorder()
    const c = createEventCoalescer(send)
    c.session({ slug: 's', sessionId: 'a', ctxPct: 1 })
    c.session({ slug: 's', sessionId: 'b', ctxPct: 2 })
    await vi.advanceTimersByTimeAsync(600)
    expect(sent.map(([, p]) => [p.sessionId, p.ctxPct])).toEqual([
      ['a', 1],
      ['b', 2]
    ])
  })

  it('subagent meta: first defined value per field wins', async () => {
    vi.useFakeTimers()
    const { sent, send } = recorder()
    const c = createEventCoalescer(send)
    c.subagent({ slug: 's', parentSessionId: 'p', agentId: 'x', meta: { agentType: 'a' } })
    c.subagent({
      slug: 's',
      parentSessionId: 'p',
      agentId: 'x',
      meta: { agentType: 'b', model: 'm' }
    })
    await vi.advanceTimersByTimeAsync(600)
    expect(sent).toHaveLength(1)
    expect(sent.at(-1)![0]).toBe('claude:subagent:updated')
    expect(sent.at(-1)![1].meta).toEqual({ agentType: 'a', model: 'm' })
  })

  it('session:added is sent immediately and before any pending update for the same id', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const c = createEventCoalescer((ch) => sent.push(ch))
    c.session({ slug: 's', sessionId: 'n', ctxPct: 1 })
    c.added('s', 'n')
    expect(sent[0]).toBe('claude:session:added')
    await vi.advanceTimersByTimeAsync(600)
    expect(sent).toEqual(['claude:session:added', 'claude:session:updated'])
  })

  it('dropping a removed id cancels its pending update so it cannot follow the removal', async () => {
    vi.useFakeTimers()
    const { sent, send } = recorder()
    const c = createEventCoalescer(send)
    c.subagent({ slug: 's', parentSessionId: 'p', agentId: 'x', meta: { model: 'm' } })
    c.session({ slug: 's', sessionId: 'a', ctxPct: 1 })
    c.session({ slug: 's', sessionId: 'b', ctxPct: 2 })
    c.dropSubagent('p', 'x')
    c.dropSession('a')
    await vi.advanceTimersByTimeAsync(600)
    expect(sent.map(([, p]) => p.sessionId)).toEqual(['b'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close() drops pending events and clears timers', async () => {
    vi.useFakeTimers()
    const { sent, send } = recorder()
    const c = createEventCoalescer(send)
    c.session({ slug: 's', sessionId: 'a', ctxPct: 1 })
    c.close()
    await vi.advanceTimersByTimeAsync(600)
    expect(sent).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushAll() sends every pending event now', () => {
    vi.useFakeTimers()
    const { sent, send } = recorder()
    const c = createEventCoalescer(send)
    c.session({ slug: 's', sessionId: 'a', ctxPct: 1 })
    c.subagent({ slug: 's', parentSessionId: 'p', agentId: 'x' })
    c.flushAll()
    expect(sent.map(([ch]) => ch)).toEqual(['claude:session:updated', 'claude:subagent:updated'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
