import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyState, type YourMoveCard, type YourMoveState } from '../../src/main/your-move/core'
import {
  MAX_SEGMENT_CHARS,
  createInspector,
  laneFor,
  type InspectRequest,
  type InspectorDeps
} from '../../src/main/your-move/inspector'
import type { EnrichOutcome, JudgeOutcome } from '../../src/main/your-move/judge'
import { openYourMoveStore, type YourMoveStore } from '../../src/main/your-move/store'
import { readFrom, type ReadResult } from '../../src/main/your-move/transcript'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-inspector-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const asst = (text: string) => ({
  type: 'assistant',
  entrypoint: 'cli',
  message: { content: [{ type: 'text', text }] }
})
const human = (text: string) => ({
  type: 'user',
  entrypoint: 'cli',
  origin: { kind: 'human' },
  message: { content: text }
})
const toolOnly = () => ({
  type: 'assistant',
  entrypoint: 'cli',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }
})
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

const verdictWith = (over: Partial<{ new: unknown[]; update: unknown[]; close: string[] }> = {}) =>
  ({
    ok: true,
    costUsd: 0.0004,
    durationMs: 5,
    verdict: { new: [], update: [], close: [], ...over }
  }) as JudgeOutcome

interface Harness {
  store: YourMoveStore
  deps: InspectorDeps
  judge: ReturnType<typeof vi.fn>
  enrich: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  rows: Record<string, unknown>[]
  onFailure: ReturnType<typeof vi.fn>
  mode: { value: 'off' | 'observe' | 'live' }
}

async function harness(
  files: Record<string, { lines?: Record<string, unknown>[]; size?: number }> = {},
  over: Partial<InspectorDeps> = {}
): Promise<Harness> {
  const store = await openYourMoveStore(path.join(dir, 'your-move.json'))
  const judge = vi.fn(async (_input: string) => verdictWith())
  // Default: enrichment is unavailable, so every filed card is a plain candidate.
  const enrich = vi.fn(async (_input: string): Promise<EnrichOutcome> => ({
    ok: false,
    reason: 'enrichment off'
  }))
  const read = vi.fn(async (p: string, off: number | { tail: number }): Promise<ReadResult> => {
    const f = files[p] ?? { lines: [], size: 0 }
    const size = f.size ?? 1000
    if (typeof off === 'number' && off > size)
      return { lines: [], nextOffset: size, size, shrunk: true }
    return { lines: f.lines ?? [], nextOffset: size, size, shrunk: false }
  })
  const rows: Record<string, unknown>[] = []
  const onFailure = vi.fn()
  const mode = { value: 'observe' as 'off' | 'observe' | 'live' }
  let n = 0
  const deps: InspectorDeps = {
    store,
    read: read as unknown as InspectorDeps['read'],
    detect: judge,
    enrich,
    now: () => 1000,
    mintId: () => `id${++n}`,
    isBlocked: () => false,
    isArchived: () => false,
    isFolderOff: () => false,
    mode: () => mode.value,
    midTurnLive: () => false,
    classify: () => 'interactive',
    onFailure,
    appendInspection: (r) => rows.push(r),
    ...over
  }
  return { store, deps, judge, enrich, read, rows, onFailure, mode }
}

const req = (over: Partial<InspectRequest> = {}): InspectRequest => ({
  sessionId: 's1',
  folder: '/org/proj/www',
  transcriptPath: '/t/s1.jsonl',
  trigger: 'stop',
  ...over
})

const seed = (store: YourMoveStore, patch: (s: YourMoveState) => YourMoveState) =>
  store.transact((s) => ({ next: patch(s), result: null }))

describe('inspector gating', () => {
  it('off mode, a blocked folder, an archived session, a per-folder off all skip without reading', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('hi')] } })
    h.mode.value = 'off'
    expect(await createInspector(h.deps).request(req())).toBe('skipped')
    h.mode.value = 'observe'
    for (const over of [
      { isBlocked: () => true },
      { isArchived: () => true },
      { isFolderOff: () => true }
    ]) {
      const i = createInspector({ ...h.deps, ...over })
      expect(await i.request(req())).toBe('skipped')
    }
    expect(h.read).not.toHaveBeenCalled()
    expect(h.judge).not.toHaveBeenCalled()
  })

  it('a programmatic transcript skips without judging and without a cursor', async () => {
    const h = await harness(
      { '/t/s1.jsonl': { lines: [asst('hi')] } },
      { classify: () => 'programmatic' }
    )
    expect(await createInspector(h.deps).request(req())).toBe('skipped')
    expect(h.judge).not.toHaveBeenCalled()
    expect(h.store.state().cursors).toEqual({})
  })
})

describe('first sight', () => {
  it('stop and manual with no cursor start at most 256 KiB back, aligned after a newline, and judge that tail', async () => {
    // Real file: ~400 KiB, so the tail cut lands mid-line and the partial line must be dropped.
    const rows = Array.from({ length: 4000 }, (_, i) => asst(`turn ${i} ${'x'.repeat(90)}`))
    const file = path.join(dir, 't.jsonl')
    await writeFile(file, jsonl(rows))
    const inputs: string[] = []
    const h = await harness(
      {},
      {
        read: readFrom,
        detect: async (input) => {
          inputs.push(input)
          return verdictWith()
        }
      }
    )
    for (const trigger of ['stop', 'manual'] as const) {
      await h.store.transact((s) => ({ next: emptyState(), result: s }))
      inputs.length = 0
      expect(await createInspector(h.deps).request(req({ transcriptPath: file, trigger }))).toBe(
        'judged'
      )
      expect(inputs).toHaveLength(2) // two independent detector runs
      expect(inputs[1]).toBe(inputs[0])
      const lines = inputs[0].split('\n').filter((l) => l.startsWith('[ASSISTANT] '))
      expect(lines.length).toBeGreaterThan(100)
      expect(lines.length).toBeLessThan(4000)
      // aligned: every judged entry is a whole turn, ending in the last one written
      for (const l of lines) expect(l).toMatch(/^\[ASSISTANT\] turn \d+ x{90}$/)
      expect(lines[lines.length - 1]).toContain('turn 3999 ')
      expect(h.store.state().cursors.s1.offset).toBeGreaterThan(0)
    }
  })

  it('asks the reader for a 256 KiB tail when there is no cursor', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('hi')] } })
    await createInspector(h.deps).request(req())
    expect(h.read).toHaveBeenCalledWith('/t/s1.jsonl', { tail: 256 * 1024 })
  })

  it('mid-turn with no cursor sets it to end of file, returns first-sight, calls no judge', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('hi')], size: 500 } })
    expect(await createInspector(h.deps).request(req({ trigger: 'mid-turn' }))).toBe('first-sight')
    expect(h.judge).not.toHaveBeenCalled()
    expect(h.store.state().cursors.s1).toMatchObject({ offset: 500, shadowOffset: 500 })
  })
})

describe('verdict and cursor', () => {
  it('a verdict and the cursor land in one transact', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('Pick A or B?')], size: 700 } })
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    h.judge.mockResolvedValue(
      verdictWith({ new: [{ kind: 'decide', ask: 'Pick A or B', options: ['A', 'B'] }] })
    )
    const spy = vi.spyOn(h.store, 'transact')
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(spy).toHaveBeenCalledTimes(1)
    const after = h.store.state()
    expect(after.cards).toHaveLength(1)
    expect(after.cards[0]).toMatchObject({
      id: 'id1',
      sessionId: 's1',
      source: 'judge',
      lane: 'observe'
    })
    expect(after.cursors.s1.offset).toBe(700)
    // and a store that cannot commit leaves neither the card nor the cursor moved
    const h2 = await harness({ '/t/s1.jsonl': { lines: [asst('Pick?')], size: 700 } })
    await seed(h2.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    h2.judge.mockResolvedValue(verdictWith({ new: [{ kind: 'decide', ask: 'Pick' }] }))
    const before = h2.store.state()
    vi.spyOn(h2.store, 'transact').mockRejectedValue(new Error('disk full'))
    expect(await createInspector(h2.deps).request(req())).toBe('failed')
    expect(h2.store.state()).toEqual(before)
    expect(h2.onFailure).toHaveBeenCalledOnce()
  })

  it('judge failure leaves the cursor where it was and calls onFailure', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('Pick?')], size: 700 } })
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    h.judge.mockResolvedValue({ ok: false, reason: 'timeout' })
    expect(await createInspector(h.deps).request(req())).toBe('failed')
    expect(h.store.state().cursors.s1).toEqual({ offset: 100, lastInspectedAt: 1 })
    expect(h.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1' }),
      'timeout'
    )
  })

  it('calls onSuccess after a committed verdict', async () => {
    const onSuccess = vi.fn()
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('done')], size: 50 } }, { onSuccess })
    await createInspector(h.deps).request(req())
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('a segment of only TOOL entries advances the cursor without a judge call', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [toolOnly()], size: 900 } })
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    expect(await createInspector(h.deps).request(req())).toBe('empty')
    expect(h.judge).not.toHaveBeenCalled()
    expect(h.store.state().cursors.s1.offset).toBe(900)
  })

  it('the detector sees only open cards of its own lane', async () => {
    const mk = (id: string, lane: YourMoveCard['lane']): YourMoveCard => ({
      id,
      sessionId: 's1',
      folder: '/f',
      kind: 'decide',
      ask: `ask ${id}`,
      source: 'judge',
      lane,
      openedAt: 1,
      updatedAt: 1
    })
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('hi')], size: 900 } })
    await seed(h.store, (s) => ({
      ...s,
      cards: [mk('a', 'observe'), mk('b', 'live'), mk('c', 'mid-turn')],
      cursors: { s1: { offset: 100, lastInspectedAt: 1 } }
    }))
    await createInspector(h.deps).request(req())
    expect(h.judge.mock.calls[0][0]).toContain('"id":"a"')
    expect(h.judge.mock.calls[0][0]).not.toContain('"id":"b"')
    expect(h.judge.mock.calls[0][0]).not.toContain('"id":"c"')
  })

  it('appends the hook text as a final ASSISTANT entry when the tail lacks it', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('older text')], size: 900 } })
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    await createInspector(h.deps).request(req({ lastAssistantMessage: 'Should I continue?' }))
    const input = h.judge.mock.calls[0][0] as string
    expect(input.trim().endsWith('[ASSISTANT] Should I continue?')).toBe(true)
    h.judge.mockClear()
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    await createInspector(h.deps).request(req({ lastAssistantMessage: 'older text' }))
    expect((h.judge.mock.calls[0][0] as string).match(/older text/g)).toHaveLength(1)
  })

  it('an [OPERATOR] entry in the segment lets the judge close a card', async () => {
    const h = await harness({
      '/t/s1.jsonl': { lines: [human('A please'), asst('ok, doing A')], size: 900 }
    })
    await seed(h.store, (s) => ({
      ...s,
      cards: [
        {
          id: 'a',
          sessionId: 's1',
          folder: '/f',
          kind: 'decide',
          ask: 'A or B',
          source: 'judge',
          lane: 'observe',
          openedAt: 1,
          updatedAt: 1
        }
      ],
      cursors: { s1: { offset: 100, lastInspectedAt: 1 } }
    }))
    h.judge.mockResolvedValue(verdictWith({ close: ['a'] }))
    await createInspector(h.deps).request(req())
    expect(h.store.state().cards[0]).toMatchObject({ closedBy: 'judge' })
  })
})

describe('splitting, coalescing, shrinking', () => {
  it('a split segment judges parts in order, each part seeing cards filed by earlier parts', async () => {
    const big = (c: string) => asst(c.repeat(MAX_SEGMENT_CHARS * 0.6))
    const h = await harness({
      '/t/s1.jsonl': { lines: [big('a'), big('b'), big('c')], size: 900 }
    })
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    h.judge.mockImplementation(async (input: string) =>
      verdictWith(
        input.includes('OPEN_CARDS: []') ? { new: [{ kind: 'provide', ask: 'Need the key' }] } : {}
      )
    )
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(h.judge.mock.calls.length).toBeGreaterThanOrEqual(4) // 2 runs per part
    expect(h.judge.mock.calls[0][0]).toContain('OPEN_CARDS: []')
    expect(h.judge.mock.calls[2][0]).toContain('"ask":"Need the key"')
    expect(h.store.state().cards).toHaveLength(1)
  })

  it('a card the operator closed during a multi-part run stays closed at commit', async () => {
    const big = (c: string) => asst(c.repeat(MAX_SEGMENT_CHARS * 0.6))
    const h = await harness({ '/t/s1.jsonl': { lines: [big('a'), big('b')], size: 900 } })
    const open: YourMoveCard = {
      id: 'a',
      sessionId: 's1',
      folder: '/f',
      kind: 'decide',
      ask: 'old',
      source: 'judge',
      lane: 'observe',
      openedAt: 1,
      updatedAt: 1
    }
    await seed(h.store, (s) => ({
      ...s,
      cards: [open],
      cursors: { s1: { offset: 100, lastInspectedAt: 1 } }
    }))
    h.judge.mockImplementation(async () => {
      // the operator clicks "Not for me" while the judge is still running
      await h.store.transact((s) => ({
        next: {
          ...s,
          cards: s.cards.map((c) => ({ ...c, closedAt: 5, closedBy: 'not-for-me' as const }))
        },
        result: null
      }))
      return verdictWith({ update: [{ id: 'a', ask: 'refreshed' }] })
    })
    await createInspector(h.deps).request(req())
    expect(h.store.state().cards[0]).toMatchObject({ closedBy: 'not-for-me', ask: 'old' })
  })

  it('two requests during a run coalesce into one rerun; never two judges for one session', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('hi')], size: 900 } })
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    let running = 0
    let max = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    h.judge.mockImplementation(async () => {
      running++
      max = Math.max(max, running)
      if (h.judge.mock.calls.length <= 2) await gate
      running--
      return verdictWith()
    })
    const inspector = createInspector(h.deps)
    const first = inspector.request(req())
    await vi.waitFor(() => expect(h.judge).toHaveBeenCalledTimes(2)) // the first inspection's two runs
    const second = inspector.request(req({ trigger: 'manual' }))
    const third = inspector.request(req({ lastAssistantMessage: 'late text' }))
    release()
    await Promise.all([first, second, third])
    await inspector.idle()
    expect(max).toBe(2) // one inspection at a time: only its own two runs overlap
    expect(h.judge).toHaveBeenCalledTimes(4) // two inspections, not three
  })

  it('different sessions run independently', async () => {
    const h = await harness({
      '/t/s1.jsonl': { lines: [asst('hi')], size: 900 },
      '/t/s2.jsonl': { lines: [asst('yo')], size: 900 }
    })
    await seed(h.store, (s) => ({
      ...s,
      cursors: {
        s1: { offset: 100, lastInspectedAt: 1 },
        s2: { offset: 100, lastInspectedAt: 1 }
      }
    }))
    const inspector = createInspector(h.deps)
    await Promise.all([
      inspector.request(req()),
      inspector.request(req({ sessionId: 's2', transcriptPath: '/t/s2.jsonl' }))
    ])
    expect(h.judge).toHaveBeenCalledTimes(4)
  })

  it('a shrunk file resets the cursor to end of file and logs the row', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [], size: 300 } })
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 5000, lastInspectedAt: 1 } } }))
    expect(await createInspector(h.deps).request(req())).toBe('first-sight')
    expect(h.store.state().cursors.s1.offset).toBe(300)
    expect(h.judge).not.toHaveBeenCalled()
    expect(h.rows.some((r) => r.outcome === 'first-sight' && r.reason === 'shrunk')).toBe(true)
  })

  it('logs one row per inspection without any transcript text', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('very secret words')], size: 900 } })
    await createInspector(h.deps).request(req())
    expect(h.rows).toHaveLength(1)
    expect(JSON.stringify(h.rows)).not.toContain('very secret words')
    expect(h.rows[0]).toMatchObject({ sessionId: 's1', trigger: 'stop', outcome: 'judged' })
  })
})

describe('lanes and the shadow cursor', () => {
  it('laneFor: observe→observe; live stop→live; mid-turn→mid-turn; mid-turn with midTurnLive→live', () => {
    expect(laneFor('observe', 'stop', false)).toBe('observe')
    expect(laneFor('observe', 'mid-turn', false)).toBe('observe')
    expect(laneFor('observe', 'mid-turn', true)).toBe('observe')
    expect(laneFor('live', 'stop', false)).toBe('live')
    expect(laneFor('live', 'manual', false)).toBe('live')
    expect(laneFor('live', 'mid-turn', false)).toBe('mid-turn')
    expect(laneFor('live', 'mid-turn', true)).toBe('live')
  })

  it('mid-turn moves shadowOffset and never offset', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('hi')], size: 900 } })
    await seed(h.store, (s) => ({ ...s, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    await createInspector(h.deps).request(req({ trigger: 'mid-turn' }))
    expect(h.store.state().cursors.s1).toMatchObject({ offset: 100, shadowOffset: 900 })
    // a later Stop still judges the same text, reading from the live cursor
    h.read.mockClear()
    await createInspector(h.deps).request(req())
    expect(h.read).toHaveBeenCalledWith('/t/s1.jsonl', 100)
  })

  it('mid-turn reads from shadowOffset once it exists', async () => {
    const h = await harness({ '/t/s1.jsonl': { lines: [asst('hi')], size: 900 } })
    await seed(h.store, (s) => ({
      ...s,
      cursors: { s1: { offset: 100, shadowOffset: 400, lastInspectedAt: 1 } }
    }))
    await createInspector(h.deps).request(req({ trigger: 'mid-turn' }))
    expect(h.read).toHaveBeenCalledWith('/t/s1.jsonl', 400)
  })
})

describe('detector runs and enrichment', () => {
  const lines = { '/t/s1.jsonl': { lines: [asst('Pick A or B?')], size: 900 } }
  const withCursor = async (h: Harness) =>
    seed(h.store, (st) => ({ ...st, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
  /** The detector answers run 1, run 2, run 3… from the list; the last entry repeats. */
  const runs = (h: Harness, answers: JudgeOutcome[]) => {
    let n = 0
    h.judge.mockImplementation(async () => answers[Math.min(n++, answers.length - 1)])
  }
  const cardOf = (ask: string, over: Record<string, unknown> = {}) => ({
    kind: 'decide' as const,
    ask,
    ...over
  })
  const asks = (h: Harness) =>
    h.store
      .state()
      .cards.map((c) => c.ask)
      .sort()

  it('new is the union of both detector runs', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [
      verdictWith({ new: [cardOf('Approve the migration')] }),
      verdictWith({ new: [cardOf('Send the API key'), cardOf('approve the MIGRATION.')] })
    ])
    h.enrich.mockImplementation(async (input: string) => {
      expect(input).toContain('CANDIDATES:')
      return {
        ok: true,
        costUsd: 0,
        durationMs: 1,
        cards: [
          cardOf('Approve the migration', { context: 'it unblocks the release', covers: [0] }),
          cardOf('Send the API key', { context: 'the deploy needs it', covers: [1] })
        ]
      }
    })
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    // the same item found by both runs (same normalized text) is one candidate
    expect(asks(h)).toEqual(['Approve the migration', 'Send the API key'])
    expect(h.store.state().cards.every((c) => c.context)).toBe(true)
    expect(h.enrich).toHaveBeenCalledTimes(1)
  })

  it('close needs both detector runs', async () => {
    const open = {
      id: 'a',
      sessionId: 's1',
      folder: '/f',
      kind: 'decide' as const,
      ask: 'A or B',
      source: 'judge' as const,
      lane: 'observe' as const,
      openedAt: 1,
      updatedAt: 1
    }
    const answered = { '/t/s1.jsonl': { lines: [human('A'), asst('doing A')], size: 900 } }
    const h = await harness(answered)
    await seed(h.store, (st) => ({
      ...st,
      cards: [open],
      cursors: { s1: { offset: 100, lastInspectedAt: 1 } }
    }))
    runs(h, [verdictWith({ close: ['a'] }), verdictWith({})])
    await createInspector(h.deps).request(req())
    expect(h.store.state().cards[0].closedAt).toBeUndefined() // one run alone cannot close it
    expect(h.enrich).not.toHaveBeenCalled()
    await seed(h.store, (st) => ({ ...st, cursors: { s1: { offset: 100, lastInspectedAt: 1 } } }))
    runs(h, [verdictWith({ close: ['a'] })])
    await createInspector(h.deps).request(req())
    expect(h.store.state().cards[0]).toMatchObject({ closedBy: 'judge' })
  })

  it('one failed detector run still produces a verdict', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [{ ok: false, reason: 'timeout' }, verdictWith({ new: [cardOf('Pick A or B')] })])
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(asks(h)).toEqual(['Pick A or B'])
    expect(h.store.state().cursors.s1.offset).toBe(900)
    expect(h.onFailure).not.toHaveBeenCalled()
    expect(h.rows.find((r) => r.outcome === 'judged')).toMatchObject({ detectorFailures: 1 })
  })

  it('both failed runs leave the cursor in place', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'bad json' }
    ])
    expect(await createInspector(h.deps).request(req())).toBe('failed')
    expect(h.store.state().cursors.s1).toEqual({ offset: 100, lastInspectedAt: 1 })
    expect(h.store.state().cards).toEqual([])
    expect(h.onFailure).toHaveBeenCalledOnce()
    expect(h.enrich).not.toHaveBeenCalled()
  })

  it('enrichment failure files the candidates', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [
      verdictWith({ new: [cardOf('Approve the migration'), cardOf('Send the API key')] }),
      verdictWith({ new: [cardOf('approve the migration')] })
    ])
    h.enrich.mockResolvedValue({ ok: false, reason: 'timeout' })
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(asks(h)).toEqual(['Approve the migration', 'Send the API key'])
    expect(h.store.state().cursors.s1.offset).toBe(900)
  })

  it('enrichment returning zero cards files the candidates', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [verdictWith({ new: [cardOf('Approve the migration'), cardOf('Send the API key')] })])
    h.enrich.mockResolvedValue({ ok: true, costUsd: 0, durationMs: 1, cards: [] })
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(asks(h)).toEqual(['Approve the migration', 'Send the API key'])
    expect(h.rows.find((r) => r.outcome === 'judged')).toMatchObject({ enrichFallbacks: 1 })
  })

  it('enrichment merging two candidates files one card', async () => {
    const h = await harness(lines)
    await withCursor(h)
    // the two detector runs word the same item differently, so normalized text keeps both
    runs(h, [
      verdictWith({ new: [cardOf('Approve the migration plan')] }),
      verdictWith({ new: [cardOf('Sign off on the DB migration')] })
    ])
    h.enrich.mockImplementation(async (input: string) => {
      expect(input).toContain('"index":0')
      expect(input).toContain('"index":1')
      return {
        ok: true,
        costUsd: 0,
        durationMs: 1,
        cards: [
          cardOf('Approve the migration plan', {
            context: 'the release waits on it',
            covers: [0, 1]
          })
        ]
      }
    })
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(h.store.state().cards).toHaveLength(1)
    expect(h.store.state().cards[0]).toMatchObject({ context: 'the release waits on it' })
    expect(h.rows.find((r) => r.outcome === 'judged')).toMatchObject({ enrichFallbacks: 0 })
  })

  it('a candidate no card covers is filed as its own card', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [verdictWith({ new: [cardOf('Approve the migration'), cardOf('Send the API key')] })])
    h.enrich.mockResolvedValue({
      ok: true,
      costUsd: 0,
      durationMs: 1,
      cards: [cardOf('Approve the migration', { context: 'it unblocks the release', covers: [0] })]
    })
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(asks(h)).toEqual(['Approve the migration', 'Send the API key'])
    const byAsk = (a: string) => h.store.state().cards.find((c) => c.ask === a)
    expect(byAsk('Approve the migration')?.context).toBe('it unblocks the release')
    expect(byAsk('Send the API key')?.context).toBeUndefined() // filed as the detector found it
  })

  it('unknown covers indexes are ignored', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [verdictWith({ new: [cardOf('Approve the migration')] })])
    h.enrich.mockResolvedValue({
      ok: true,
      costUsd: 0,
      durationMs: 1,
      cards: [cardOf('Approve the migration', { context: 'why', covers: [0, 7, -1, 1.5] })]
    })
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(asks(h)).toEqual(['Approve the migration'])
    expect(h.store.state().cards[0].context).toBe('why')
  })

  it('an enriched card carries its extra fields onto the filed card', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [verdictWith({ new: [cardOf('Approve the migration')] })])
    h.enrich.mockResolvedValue({
      ok: true,
      costUsd: 0,
      durationMs: 1,
      cards: [
        cardOf('Approve the migration', {
          context: 'it unblocks the release',
          blocks: 'the release',
          options: ['yes', 'no'],
          recommended: 'yes',
          covers: [0]
        })
      ]
    })
    await createInspector(h.deps).request(req())
    expect(h.store.state().cards[0]).toMatchObject({
      context: 'it unblocks the release',
      blocks: 'the release',
      recommended: 'yes'
    })
  })

  it('no enrichment call when both runs are empty', async () => {
    const h = await harness(lines)
    await withCursor(h)
    runs(h, [verdictWith({}), verdictWith({ update: ['x'] })])
    expect(await createInspector(h.deps).request(req())).toBe('judged')
    expect(h.enrich).not.toHaveBeenCalled()
    expect(h.store.state().cursors.s1.offset).toBe(900)
  })
})
