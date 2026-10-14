/**
 * T483 — pinned Scheduler workers: the pure + persistence half.
 *
 * `pinnedAt` is an operator curation field on the worker definition. Three
 * things must hold and each is a place the pin could silently vanish:
 * the pure pin/unpin transition (AC-3), the `normalizeWorker` whitelist that
 * would strip an unknown field on the first load after a restart (AC-2), and a
 * legacy file with no `pinnedAt` loading exactly as before (AC-9).
 */
import { describe, it, expect, vi } from 'vitest'
import { pinWorker, unpinWorker, type Worker } from '../src/main/scheduler-core'

vi.mock('electron', () => ({ app: { getPath: (): string => '/tmp/harnu-pin-test' } }))

const W: Worker = {
  id: 'w1',
  name: 'w',
  enabled: true,
  prompt: 'p',
  folder: '/repo',
  everyMinutes: 5,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 300,
  carryLastResult: false,
  failureStreak: 0
}

describe('pinWorker / unpinWorker (AC-3)', () => {
  it('pinning stamps pinnedAt and touches nothing else', () => {
    const pinned = pinWorker(W, 1000)
    expect(pinned.pinnedAt).toBe(1000)
    expect({ ...pinned, pinnedAt: undefined }).toEqual({ ...W, pinnedAt: undefined })
  })

  it('pinning an already-pinned worker keeps its original pin time (order never jumps)', () => {
    expect(pinWorker(pinWorker(W, 1000), 5000).pinnedAt).toBe(1000)
  })

  it('unpinning removes the key entirely and keeps enabled as it was', () => {
    const off = unpinWorker(pinWorker({ ...W, enabled: false }, 1000))
    expect('pinnedAt' in off).toBe(false)
    expect(off.enabled).toBe(false)
    expect(unpinWorker(W)).toEqual(W)
  })
})

describe('pinnedAt through the store (AC-2, AC-9)', () => {
  it('survives serialize → parse (the normalizeWorker whitelist must not strip it)', async () => {
    const { serializeWorkers, parseWorkers } = await import('../src/main/scheduler-store')
    const text = serializeWorkers([pinWorker(W, 1234), { ...W, id: 'w2' }])
    const back = parseWorkers(text)
    expect(back.find((w) => w.id === 'w1')?.pinnedAt).toBe(1234)
    expect('pinnedAt' in back.find((w) => w.id === 'w2')!).toBe(false)
  })

  it('a file written before T483 loads with every worker unpinned and nothing else changed', async () => {
    const { parseWorkers } = await import('../src/main/scheduler-store')
    const legacy = JSON.stringify({ version: 1, workers: [W] })
    const [loaded] = parseWorkers(legacy)
    expect('pinnedAt' in loaded).toBe(false)
    expect(loaded.id).toBe('w1')
    expect(loaded.everyMinutes).toBe(5)
  })

  it('drops a hand-edited non-numeric pinnedAt instead of carrying it', async () => {
    const { parseWorkers } = await import('../src/main/scheduler-store')
    const text = JSON.stringify({ version: 1, workers: [{ ...W, pinnedAt: 'yes' }] })
    expect('pinnedAt' in parseWorkers(text)[0]).toBe(false)
  })
})
