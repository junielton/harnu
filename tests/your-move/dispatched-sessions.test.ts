/**
 * BUG-308 delta 1: the launch prompt of a session Harnu spawned for an agent lands in the
 * transcript as a human entry. It is not the operator: such a session is judged only once a
 * human entry appears after it. A session of unknown origin keeps its human entry (recall).
 */
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { YourMoveCard } from '../../src/main/your-move/core'
import { closeIneligibleCards, createOperatorGate } from '../../src/main/your-move/operator'
import { openYourMoveStore } from '../../src/main/your-move/store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-dispatched-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const human = (text: string): Record<string, unknown> => ({
  type: 'user',
  entrypoint: 'cli',
  promptSource: 'typed',
  origin: { kind: 'human' },
  message: { content: text }
})
const asst = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  entrypoint: 'cli',
  message: { content: [{ type: 'text', text }] }
})
const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

async function transcript(id: string, rows: unknown[]): Promise<string> {
  const file = path.join(dir, `${id}.jsonl`)
  await writeFile(file, jsonl(rows))
  return file
}

const boot = human('You are the VERIFIER for mission alpha. Check the criteria.')
const agentIs =
  (...ids: string[]) =>
  async (id: string): Promise<boolean> =>
    ids.includes(id)

describe('the boot prompt of an agent-spawned session is not the operator', () => {
  it('is not eligible on its boot prompt alone, and is once the operator types', async () => {
    const gate = createOperatorGate({ agentSpawned: agentIs('dispatched') })
    const file = await transcript('dispatched', [boot, asst('x'.repeat(2000))])
    expect(await gate.status('dispatched', file)).toBe('no')
    expect(await gate.status('dispatched', file)).toBe('no')
    await appendFile(file, jsonl([human('also check the docs')]))
    expect(await gate.status('dispatched', file)).toBe('yes')
  })

  it('finds a later message in the first scan too', async () => {
    const gate = createOperatorGate({ agentSpawned: agentIs('dispatched') })
    const file = await transcript('dispatched', [boot, asst('done'), human('wait')])
    expect(await gate.has('dispatched', file)).toBe(true)
  })

  it('a session of unknown origin keeps its one human entry', async () => {
    const gate = createOperatorGate({ agentSpawned: agentIs() })
    const file = await transcript('mine', [boot, asst('ok')])
    expect(await gate.has('mine', file)).toBe(true)
  })

  it('an origin that cannot be read counts as unknown', async () => {
    const gate = createOperatorGate({
      agentSpawned: async () => {
        throw new Error('EMFILE')
      }
    })
    const file = await transcript('mine', [boot, asst('ok')])
    expect(await gate.has('mine', file)).toBe(true)
  })

  it('an origin learned after the first look still applies', async () => {
    const known = new Set<string>()
    const gate = createOperatorGate({ agentSpawned: async (id) => known.has(id) })
    const file = await transcript('late', [boot, asst('ok')])
    expect(await gate.has('late', file)).toBe(true)
    known.add('late')
    expect(await gate.has('late', file)).toBe(false)
  })

  it('after a Harnu dispatch marker, the first thing the operator types counts', async () => {
    const gate = createOperatorGate({ agentSpawned: agentIs('carded') })
    const file = await transcript('carded', [
      human('[Harnu · Roadmap dispatch] go'),
      asst('ok'),
      human('hold on')
    ])
    expect(await gate.has('carded', file)).toBe(true)
  })

  it('the startup cleanup closes the judge cards of such a session only', async () => {
    const files: Record<string, string> = {
      dispatched: await transcript('dispatched', [boot, asst('report sent')]),
      typed: await transcript('typed', [boot, asst('ok'), human('go on')]),
      mine: await transcript('mine', [boot, asst('ok')])
    }
    const card = (sessionId: string, over: Partial<YourMoveCard> = {}): YourMoveCard => ({
      id: `c-${sessionId}-${over.source ?? 'judge'}`,
      sessionId,
      folder: '/org/proj/www',
      kind: 'do',
      ask: 'Merge it',
      source: 'judge',
      lane: 'live',
      openedAt: 1,
      updatedAt: 1,
      ...over
    })
    const storeFile = path.join(dir, 'your-move.json')
    await writeFile(
      storeFile,
      JSON.stringify({
        version: 1,
        cursors: {},
        cards: [
          card('dispatched'),
          card('dispatched', { source: 'verb' }),
          card('typed'),
          card('mine')
        ]
      })
    )
    const store = await openYourMoveStore(storeFile)
    const closed = await closeIneligibleCards({
      store,
      gate: createOperatorGate({ agentSpawned: agentIs('dispatched', 'typed') }),
      lookup: async (id) => ({ state: 'found', path: files[id] }),
      now: () => 5
    })
    expect(closed).toBe(1)
    expect(
      store
        .state()
        .cards.filter((c) => c.closedAt === undefined)
        .map((c) => c.id)
    ).toEqual(['c-dispatched-verb', 'c-typed-judge', 'c-mine-judge'])
  })
})
