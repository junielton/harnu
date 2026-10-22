import { describe, it, expect } from 'vitest'
import { groupWorkers, defaultSelectionId } from '../src/renderer/src/components/scheduler-format'
import type { Worker } from '../src/main/scheduler-core'

function w(id: string, enabled: boolean, pinnedAt?: number): Worker {
  return {
    id,
    name: id,
    enabled,
    prompt: 'p',
    folder: '/repo',
    everyMinutes: 5,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    failureStreak: 0,
    ...(pinnedAt === undefined ? {} : { pinnedAt })
  }
}

const ids = (list: Worker[]): string[] => list.map((x) => x.id)

describe('groupWorkers (T483)', () => {
  it('with nothing pinned it is exactly the old Enabled / Off split, storage order (AC-5)', () => {
    const g = groupWorkers([w('a', false), w('b', true), w('c', true), w('d', false)])
    expect(g.pinned).toEqual([])
    expect(ids(g.enabled)).toEqual(['b', 'c'])
    expect(ids(g.off)).toEqual(['a', 'd'])
  })

  it('a pinned worker leaves Enabled/Off and appears in exactly one group (AC-1)', () => {
    const g = groupWorkers([w('a', true, 10), w('b', true), w('c', false, 20), w('d', false)])
    expect(ids(g.pinned)).toEqual(['a', 'c'])
    expect(ids(g.enabled)).toEqual(['b'])
    expect(ids(g.off)).toEqual(['d'])
    expect(g.pinned.length + g.enabled.length + g.off.length).toBe(4)
  })

  it('orders Pinned by pinnedAt ascending, not storage order (AC-4)', () => {
    const g = groupWorkers([w('a', true, 300), w('b', false, 100), w('c', true, 200)])
    expect(ids(g.pinned)).toEqual(['b', 'c', 'a'])
  })

  it('a pinned off worker keeps enabled === false (so the row keeps its off state) (AC-4)', () => {
    const g = groupWorkers([w('a', false, 1)])
    expect(g.pinned[0].enabled).toBe(false)
  })

  it('unpinning returns the worker to Enabled or Off by `enabled` (AC-3)', () => {
    const g = groupWorkers([w('a', true), w('b', false)])
    expect(ids(g.enabled)).toEqual(['a'])
    expect(ids(g.off)).toEqual(['b'])
  })
})

describe('defaultSelectionId (AC-8)', () => {
  it('is the first pinned worker when any is pinned', () => {
    expect(defaultSelectionId(groupWorkers([w('a', true), w('b', false, 5)]))).toBe('b')
  })
  it('else the first Enabled, else the first Off', () => {
    expect(defaultSelectionId(groupWorkers([w('a', false), w('b', true)]))).toBe('b')
    expect(defaultSelectionId(groupWorkers([w('a', false)]))).toBe('a')
  })
  it('is null for an empty list', () => {
    expect(defaultSelectionId(groupWorkers([]))).toBeNull()
  })
})
