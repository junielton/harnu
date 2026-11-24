import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { YourMoveCard } from '../../src/main/your-move/core'
import { createInspector, type InspectRequest } from '../../src/main/your-move/inspector'
import type { EnrichOutcome, JudgeOutcome } from '../../src/main/your-move/judge'
import { createMidTurnSweep } from '../../src/main/your-move/triggers'
import { closeIneligibleCards, createOperatorGate } from '../../src/main/your-move/operator'
import { openYourMoveStore } from '../../src/main/your-move/store'
import { readFrom } from '../../src/main/your-move/transcript'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-operator-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const asst = (text: string) => ({
  type: 'assistant',
  entrypoint: 'cli',
  message: { content: [{ type: 'text', text }] }
})
const user = (text: string, kind: string | null) => ({
  type: 'user',
  entrypoint: 'cli',
  ...(kind === null ? {} : { origin: { kind } }),
  message: { content: text }
})
const operator = (text: string) => user(text, 'human')
/** A dispatch prompt carries `human` too, but starts with `[Harnu ·`. */
const dispatch = (text: string) => user(`[Harnu · Roadmap dispatch] ${text}`, 'human')
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

async function transcript(id: string, rows: unknown[]): Promise<string> {
  const file = path.join(dir, `${id}.jsonl`)
  await writeFile(file, jsonl(rows))
  return file
}

describe('operator gate: edge cases', () => {
  it('skips a malformed line and still finds a later operator entry', async () => {
    const file = path.join(dir, 'bad.jsonl')
    await writeFile(file, `not json "human"\n${jsonl([operator('hello')])}`)
    expect(await createOperatorGate().has('bad', file)).toBe(true)
  })

  it('forgets a no when the file is rewritten shorter', async () => {
    const gate = createOperatorGate()
    const file = await transcript('rew', [dispatch('go'), asst('x'.repeat(2000))])
    expect(await gate.has('rew', file)).toBe(false)
    await writeFile(file, jsonl([operator('hi')]))
    expect(await gate.has('rew', file)).toBe(true)
  })

  it('reads a line split across chunks whole', async () => {
    const file = await transcript('big', [dispatch('go'), operator('y'.repeat(300_000))])
    expect(await createOperatorGate().has('big', file)).toBe(true)
  })
})

describe('operator gate', () => {
  it('is false for a transcript with no operator entry, whatever else it holds', async () => {
    const gate = createOperatorGate()
    const file = await transcript('agent', [
      dispatch('do the thing'),
      user('<task-notification>x</task-notification>', 'task-notification'),
      user('peer says hi', 'peer'),
      user('no origin at all', null),
      asst('Done. Should I merge?')
    ])
    expect(await gate.has('agent', file)).toBe(false)
  })

  it('is false for a transcript that does not exist', async () => {
    expect(await createOperatorGate().has('gone', path.join(dir, 'gone.jsonl'))).toBe(false)
  })

  it('is true once the transcript holds one operator entry', async () => {
    const file = await transcript('op', [dispatch('go'), asst('ok'), operator('what is next?')])
    expect(await createOperatorGate().has('op', file)).toBe(true)
  })

  it('becomes true from the first operator message typed into an agent session', async () => {
    const gate = createOperatorGate()
    const file = await transcript('late', [dispatch('go'), asst('done')])
    expect(await gate.has('late', file)).toBe(false)
    await appendFile(file, jsonl([operator('actually, change X')]))
    expect(await gate.has('late', file)).toBe(true)
    // and stays true
    expect(await gate.has('late', file)).toBe(true)
  })

  it('does not count a tool result or a sidechain entry as the operator', async () => {
    const file = await transcript('tools', [
      {
        type: 'user',
        origin: { kind: 'human' },
        message: { content: [{ type: 'tool_result', content: 'x' }] }
      },
      { ...operator('inside a subagent'), isSidechain: true }
    ])
    expect(await createOperatorGate().has('tools', file)).toBe(false)
  })
})

interface Fleet {
  inspector: ReturnType<typeof createInspector>
  store: Awaited<ReturnType<typeof openYourMoveStore>>
  detect: ReturnType<typeof vi.fn>
  reads: string[]
}

async function fleet(): Promise<Fleet> {
  const store = await openYourMoveStore(path.join(dir, 'your-move.json'))
  const reads: string[] = []
  const gate = createOperatorGate()
  const detect = vi.fn(async (_input: string): Promise<JudgeOutcome> => ({
    ok: true,
    costUsd: 0,
    durationMs: 1,
    verdict: { new: [{ kind: 'decide', ask: 'Pick A or B' }], update: [], close: [] }
  }))
  const enrich = vi.fn(async (_input: string): Promise<EnrichOutcome> => ({
    ok: false,
    reason: 'off'
  }))
  let n = 0
  const inspector = createInspector({
    store,
    read: (async (p: string, off: number | { tail: number }) => {
      reads.push(p)
      return readFrom(p, off)
    }) as typeof readFrom,
    detect,
    enrich,
    now: () => 1000,
    mintId: () => `id${++n}`,
    isBlocked: () => false,
    isArchived: () => false,
    isFolderOff: () => false,
    mode: () => 'live',
    midTurnLive: () => false,
    classify: () => 'interactive',
    hasOperator: (id, p) => gate.has(id, p)
  } as Parameters<typeof createInspector>[0])
  return { inspector, store, detect, reads }
}

const request = (id: string, file: string): InspectRequest => ({
  sessionId: id,
  folder: '/org/proj/www',
  transcriptPath: file,
  trigger: 'stop'
})

describe('inspector eligibility (AC-1, AC-2, AC-5)', () => {
  it('a fleet of 50 agent sessions and 5 operator sessions files cards only for the 5 and runs no judge for the 50', async () => {
    const f = await fleet()
    const agentFiles: string[] = []
    const operatorIds: string[] = []
    for (let i = 0; i < 50; i++) {
      const id = `agent-${String(i).padStart(3, '0')}`
      agentFiles.push(
        await transcript(id, [dispatch('build it'), asst(`AGENT-ONLY ${id}: merge it?`)])
      )
      await f.inspector.request(request(id, agentFiles[i]))
    }
    for (let i = 0; i < 5; i++) {
      const id = `human-${i}`
      operatorIds.push(id)
      const file = await transcript(id, [operator('help me'), asst(`HUMAN ${id}: A or B?`)])
      await f.inspector.request(request(id, file))
    }
    await f.inspector.idle()

    const cards = f.store.state().cards
    expect(new Set(cards.map((c) => c.sessionId))).toEqual(new Set(operatorIds))
    // every judge call was for an operator session: none ever saw an agent-only segment
    const inputs = f.detect.mock.calls.map((c) => c[0])
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.some((i) => i.includes('AGENT-ONLY'))).toBe(false)
    // ineligible sessions are not read past the eligibility check
    expect(f.reads.filter((p) => agentFiles.includes(p))).toEqual([])
  })

  it('judges an agent session from its first operator message on', async () => {
    const f = await fleet()
    const file = await transcript('late', [dispatch('go'), asst('AGENT-ONLY first reply')])
    expect(await f.inspector.request(request('late', file))).toBe('skipped')
    expect(f.detect).not.toHaveBeenCalled()

    await appendFile(file, jsonl([operator('wait, what about Y?'), asst('Y needs a decision')]))
    expect(await f.inspector.request(request('late', file))).toBe('judged')
    expect(f.detect).toHaveBeenCalled()
    expect(f.store.state().cards.map((c) => c.sessionId)).toEqual(['late'])
  })
})

describe('mid-turn sweep eligibility', () => {
  it('does not read or inspect a working agent session', async () => {
    const file = await transcript('agent', [dispatch('go'), asst('still working')])
    const store = await openYourMoveStore(path.join(dir, 'your-move.json'))
    const gate = createOperatorGate()
    const read = vi.fn(readFrom)
    const request = vi.fn(async () => 'judged' as const)
    const sweep = createMidTurnSweep({
      inspector: { request },
      store,
      mode: () => 'live',
      eligible: async () => true,
      locate: async () => file,
      resolveFolder: async () => '/org/proj/www',
      read,
      states: () => new Map([['agent', 'working' as const]]),
      now: () => 10 * 60_000,
      hasOperator: (id: string, p: string) => gate.has(id, p)
    } as Parameters<typeof createMidTurnSweep>[0])
    await sweep.tick()
    expect(read).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('one-time cleanup (AC-4)', () => {
  const card = (id: string, sessionId: string, over: Partial<YourMoveCard> = {}): YourMoveCard => ({
    id,
    sessionId,
    folder: '/org/proj/www',
    kind: 'decide',
    ask: 'Pick',
    source: 'judge',
    lane: 'live',
    openedAt: 1,
    updatedAt: 1,
    ...over
  })

  it('closes open judge cards of agent-only or transcript-less sessions and keeps the rest', async () => {
    const agentFile = await transcript('agent', [dispatch('go'), asst('q?')])
    const humanFile = await transcript('human', [operator('hi'), asst('q?')])
    const files: Record<string, string> = { agent: agentFile, human: humanFile }
    const store = await openYourMoveStore(path.join(dir, 'your-move.json'))
    await store.transact((s) => ({
      next: {
        ...s,
        cards: [
          card('c-agent', 'agent'),
          card('c-ghost', 'ghost'), // no transcript anywhere
          card('c-human', 'human'),
          card('c-agent-closed', 'agent', { closedAt: 5, closedBy: 'answered' }),
          card('c-death', 'agent', { source: 'death', sourceKey: 'death:agent' }),
          card('c-gate', 'ghost', { source: 'human-gate', sourceKey: 'gate:ghost' }),
          card('c-mission', 'ghost', { source: 'mission', sourceKey: 'mission:x' })
        ]
      },
      result: null
    }))

    const closed = await closeIneligibleCards({
      store,
      gate: createOperatorGate(),
      locate: async (id) => files[id] ?? null,
      now: () => 99
    })

    const byId = Object.fromEntries(store.state().cards.map((c) => [c.id, c]))
    expect(closed).toBe(2)
    expect(byId['c-agent']).toMatchObject({ closedAt: 99, closedBy: 'source-resolved' })
    expect(byId['c-ghost']).toMatchObject({ closedAt: 99, closedBy: 'source-resolved' })
    expect(byId['c-human'].closedAt).toBeUndefined()
    expect(byId['c-agent-closed']).toMatchObject({ closedAt: 5, closedBy: 'answered' })
    for (const id of ['c-death', 'c-gate', 'c-mission']) expect(byId[id].closedAt).toBeUndefined()
  })

  it('never mutates the state it is handed: it runs against a deep-frozen store', async () => {
    const agentFile = await transcript('agent', [dispatch('go'), asst('q?')])
    const real = await openYourMoveStore(path.join(dir, 'your-move.json'))
    await real.transact((s) => ({
      next: { ...s, cards: [card('c1', 'agent'), card('c2', 'ghost')] },
      result: null
    }))
    const deepFreeze = <T>(v: T): T => {
      if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
        Object.freeze(v)
        for (const k of Object.values(v)) deepFreeze(k)
      }
      return v
    }
    // the shape of the BUG-277 store: the draft a reducer sees is frozen all the way down
    const frozen: typeof real = {
      ...real,
      state: () => deepFreeze(real.state()),
      transact: (decide) => real.transact((s) => decide(deepFreeze(s)))
    }
    const closed = await closeIneligibleCards({
      store: frozen,
      gate: createOperatorGate(),
      locate: async (id) => (id === 'agent' ? agentFile : null),
      now: () => 7
    })
    expect(closed).toBe(2)
    expect(real.state().cards.every((c) => c.closedAt === 7)).toBe(true)
  })
})
