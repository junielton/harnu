import { describe, it, expect } from 'vitest'
import { judgeKeeps, keepFromFresh, withoutStaleKeeps } from '../src/main/gc/gc-keep'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { planCycle } from '../src/main/gc/autopilot-core'
import { buildBundles } from '../src/main/gc/bundle-core'
import { bundle } from './gc-fixtures'
import { AS_GIVEN } from '../src/main/gc/bundle-core'
import { NOW, collect, scanInput } from './gc-scan-fixtures'

const withFate = (fate: 'open' | 'merged') =>
  bundle('/ws/wt/a', 'ready', {
    fate: { fate, signal: fate === 'merged' ? 'ancestor' : null, strong: fate === 'merged' }
  })

describe('Keep is recorded from a fresh gather, never from a stale cache (delta 3, item 1)', () => {
  it('records the fate of the fresh bundle', () => {
    const fresh = withFate('merged')
    const next = keepFromFresh(defaultGcPrefs(), [fresh], fresh.item.id)
    expect(next?.keep).toEqual({ [fresh.item.id]: 'merged' })
  })

  it('refuses an id the fresh gather does not know', () => {
    expect(keepFromFresh(defaultGcPrefs(), [withFate('merged')], 'gone')).toBeNull()
  })

  it('does not touch the other marks', () => {
    const fresh = withFate('merged')
    const prefs = { ...defaultGcPrefs(), keep: { other: 'open' } }
    expect(keepFromFresh(prefs, [fresh], fresh.item.id)?.keep).toEqual({
      other: 'open',
      [fresh.item.id]: 'merged'
    })
  })
})

describe('judgeKeeps: which marks still hold', () => {
  it('keeps a mark whose fate still matches', () => {
    const b = withFate('merged')
    const { keep, stale } = judgeKeeps([b], { [b.item.id]: 'merged' })
    expect([...keep]).toEqual([b.item.id])
    expect(stale).toEqual([])
  })

  it('reports a mark whose fate changed, with the value that was recorded', () => {
    const b = withFate('merged')
    const { keep, stale } = judgeKeeps([b], { [b.item.id]: 'open' })
    expect(keep.size).toBe(0)
    expect(stale).toEqual([{ id: b.item.id, marked: 'open' }])
  })

  it('ignores marks for items that are not in the gather', () => {
    expect(judgeKeeps([withFate('merged')], { gone: 'merged' })).toEqual({
      keep: new Set(),
      stale: []
    })
  })
})

describe('withoutStaleKeeps: a fresh Keep is never cleared by an older judgment', () => {
  it('drops a mark that still equals the stale value', () => {
    const prefs = { ...defaultGcPrefs(), keep: { a: 'open', b: 'merged' } }
    expect(withoutStaleKeeps(prefs, [{ id: 'a', marked: 'open' }]).keep).toEqual({ b: 'merged' })
  })

  it('keeps a mark the operator re-set after the gather started', () => {
    // The gather judged mark "open" stale; meanwhile Keep was pressed again and recorded "merged".
    const prefs = { ...defaultGcPrefs(), keep: { a: 'merged' } }
    expect(withoutStaleKeeps(prefs, [{ id: 'a', marked: 'open' }]).keep).toEqual({ a: 'merged' })
  })

  it('does nothing for a mark that is already gone', () => {
    expect(withoutStaleKeeps(defaultGcPrefs(), [{ id: 'a', marked: 'open' }]).keep).toEqual({})
  })
})

describe('the scenario from the grade: a fate changed since the last gather', () => {
  it('keeps the item out of the autopilot after the next gather', () => {
    // The cache still said "open"; the fresh gather says merged and ready.
    const { items, fateInputs } = collect(scanInput())
    const build = (keep: Set<string>) =>
      buildBundles({
        items,
        fateInputs,
        stacks: [],
        stackPaths: new Map(),
        containers: [],
        sessions: new Map(),
        keep,
        neverClean: new Set(),
        now: NOW,
        graceDays: 2,
        volumes: new Map(),
        knownFolders: [],
        protectedProjects: new Set(),
        canonical: AS_GIVEN
      })
    const fresh = build(new Set())
    expect(fresh[0]!.bucket).toBe('ready')

    const prefs = keepFromFresh(defaultGcPrefs(), fresh, fresh[0]!.item.id)!
    const { keep, stale } = judgeKeeps(fresh, prefs.keep)
    expect(stale).toEqual([])
    const afterGather = build(keep)
    expect(afterGather[0]!.bucket).toBe('in-use')
    expect(
      planCycle(afterGather, { ...prefs, autopilot: true, firstReportAcknowledged: true }).toClean
    ).toEqual([])
  })
})
