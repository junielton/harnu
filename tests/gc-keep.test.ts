import { describe, it, expect } from 'vitest'
import {
  judgeKeeps,
  keepFromFresh,
  pressKeep,
  type KeepPressDeps,
  protectedFromGather,
  withProvisionalKeep,
  withoutStaleKeeps
} from '../src/main/gc/gc-keep'
import { withActor } from '../src/main/gc/gc-actor'
import { createGcOps } from '../src/main/gc/gc-shell'
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
        canonical: AS_GIVEN,
        foreignCheckouts: new Map(items.map((i) => [i.id, []]))
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

describe('a Keep pressed during an in-flight gather protects at once (delta 4, N1)', () => {
  const ready = () => bundle('/ws/wt/a', 'ready')

  it('writes a provisional mark immediately, from the cached fate', () => {
    const cached = bundle('/ws/wt/a', 'ready', {
      fate: { fate: 'open', signal: null, strong: false }
    })
    const next = withProvisionalKeep(defaultGcPrefs(), [cached], cached.item.id)
    expect(next.keep).toEqual({ [cached.item.id]: 'open' })
  })

  it('writes one even when nothing is cached: any mark protects', () => {
    const next = withProvisionalKeep(defaultGcPrefs(), [], 'unseen-id')
    expect(next.keep['unseen-id']).toBeDefined()
  })

  it('keeps an existing mark for the item untouched while it waits for the fresh gather', () => {
    const b = ready()
    const prefs = { ...defaultGcPrefs(), keep: { [b.item.id]: 'closed-unmerged' } }
    expect(withProvisionalKeep(prefs, [b], b.item.id).keep[b.item.id]).toBe('closed-unmerged')
  })

  it('a gather never drops a mark that is provisional', () => {
    const b = ready()
    const prefs = { ...defaultGcPrefs(), keep: { [b.item.id]: 'open' } }
    const out = withoutStaleKeeps(prefs, [{ id: b.item.id, marked: 'open' }], new Set([b.item.id]))
    expect(out.keep).toEqual({ [b.item.id]: 'open' })
  })

  it('a gather never drops a mark written after it started', () => {
    const protect = protectedFromGather(new Map([['a', 1_000]]), new Set(), 900)
    expect([...protect]).toEqual(['a'])
    const old = protectedFromGather(new Map([['a', 800]]), new Set(), 900)
    expect(old.size).toBe(0)
  })

  it('protects a mark written at the very instant the gather started', () => {
    expect(protectedFromGather(new Map([['a', 900]]), new Set(), 900).has('a')).toBe(true)
  })

  it('combines both ways to be protected', () => {
    const protect = protectedFromGather(new Map([['a', 1_000]]), new Set(['b']), 900)
    expect([...protect].sort()).toEqual(['a', 'b'])
  })

  it('the timeline: Keep during the gather, the gather returns a verdict, the mark survives', () => {
    const b = ready()
    // t=0 gather starts with the old prefs. t=1 the operator presses Keep (provisional).
    let prefs = withProvisionalKeep(defaultGcPrefs(), [b], b.item.id)
    // t=2 the gather finishes and judged an older mark of the same id stale.
    const stale = [{ id: b.item.id, marked: b.fate.fate }]
    const protect = protectedFromGather(new Map([[b.item.id, 1]]), new Set([b.item.id]), 0)
    prefs = withoutStaleKeeps(prefs, stale, protect)
    expect(prefs.keep[b.item.id]).toBeDefined()
  })
})

describe('the reprobe refuses an item whose Keep arrived after the gather (delta 4, N1)', () => {
  it('protected-now, read from the live prefs when the job reaches the item', async () => {
    const b = bundle('/ws/wt/a', 'ready')
    let prefs = defaultGcPrefs()
    const ops = createGcOps(
      withActor(
        { executor: {}, isProtectedNow: () => false, realpath: async (p: string) => p } as never,
        'autopilot',
        () => prefs
      )
    )
    // The cycle's gather judged it ready; then the operator presses Keep.
    prefs = withProvisionalKeep(prefs, [b], b.item.id)
    expect(await ops.reprobe(b)).toEqual({ ok: false, reason: 'protected-now' })
  })
})

describe('pressing Keep (delta 4 N1, delta 5 item 2)', () => {
  const a = () => bundle('/ws/wt/a', 'ready')

  /** In-memory stand-in for the service: prefs, a log of what was persisted, no electron. */
  function rig(opts: {
    prefs?: ReturnType<typeof defaultGcPrefs>
    cached?: ReturnType<typeof a>[]
    fresh: () => Promise<ReturnType<typeof a>[]>
  }) {
    let prefs = opts.prefs ?? defaultGcPrefs()
    const log: string[] = []
    const keepWrites = new Map<string, number>()
    const provisionalKeeps = new Set<string>()
    const deps: KeepPressDeps = {
      prefs: () => prefs,
      persist: async (next) => {
        prefs = next
        log.push(`persist ${JSON.stringify(next.keep)}`)
        return prefs
      },
      cachedBundles: () => opts.cached ?? [],
      gatherFresh: async () => {
        log.push('gather')
        return opts.fresh()
      },
      keepWrites,
      provisionalKeeps,
      now: () => 1000
    }
    return { deps, log, keepWrites, provisionalKeeps, prefs: () => prefs }
  }

  it('persists a provisional mark BEFORE it waits for the fresh gather', async () => {
    const b = a()
    const r = rig({ cached: [b], fresh: async () => [b] })
    await pressKeep(b.item.id, r.deps)
    expect(r.log[0]).toMatch(/^persist/)
    expect(r.log.indexOf('gather')).toBeGreaterThan(0)
    expect(r.prefs().keep).toEqual({ [b.item.id]: 'merged' })
  })

  it('marks the item provisional while the gather runs, and not afterwards', async () => {
    const b = a()
    let during: boolean | undefined
    const r = rig({ fresh: async () => [b] })
    const fresh = r.deps.gatherFresh
    r.deps.gatherFresh = async () => {
      during = r.provisionalKeeps.has(b.item.id)
      return fresh()
    }
    await pressKeep(b.item.id, r.deps)
    expect(during).toBe(true)
    expect(r.provisionalKeeps.has(b.item.id)).toBe(false)
  })

  it('an unknown item takes back the mark THIS press created, and throws', async () => {
    const r = rig({ fresh: async () => [] })
    await expect(pressKeep('ghost', r.deps)).rejects.toThrow(/unknown cleanup item/)
    expect(r.prefs().keep).toEqual({})
    expect(r.keepWrites.has('ghost')).toBe(false)
    expect(r.provisionalKeeps.has('ghost')).toBe(false)
  })

  it('a repeated Keep never drops the existing mark when the fresh gather omits the item', async () => {
    const b = a()
    const prefs = { ...defaultGcPrefs(), keep: { [b.item.id]: 'open' as const } }
    const r = rig({ prefs, fresh: async () => [] })
    const out = await pressKeep(b.item.id, r.deps)
    expect(out.keep).toEqual({ [b.item.id]: 'open' })
    expect(r.prefs().keep).toEqual({ [b.item.id]: 'open' })
    expect(r.provisionalKeeps.has(b.item.id)).toBe(false)
  })

  it('a repeated Keep still refreshes the fate when the item is in the gather', async () => {
    const b = a()
    const prefs = { ...defaultGcPrefs(), keep: { [b.item.id]: 'open' as const } }
    const r = rig({ prefs, fresh: async () => [b] })
    expect((await pressKeep(b.item.id, r.deps)).keep).toEqual({ [b.item.id]: 'merged' })
  })

  it('a gather that fails leaves the mark in place: protecting is the safe side', async () => {
    const b = a()
    const r = rig({
      cached: [b],
      fresh: async () => {
        throw new Error('docker is down')
      }
    })
    await expect(pressKeep(b.item.id, r.deps)).rejects.toThrow(/docker is down/)
    expect(r.prefs().keep[b.item.id]).toBeDefined()
    expect(r.provisionalKeeps.has(b.item.id)).toBe(false)
  })
})
