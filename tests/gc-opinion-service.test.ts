import { describe, it, expect } from 'vitest'
import {
  OPINION_BATCH_SIZE,
  classifyOpinionIds,
  createOpinionCache,
  createOpinionService,
  opinionArgv,
  opinionKey,
  parseOpinionIds,
  type GcOpinionDone,
  type GcOpinionResult,
  type OpinionDossier,
  type OpinionLookup
} from '../src/main/gc/opinion-core'

function dossier(id: string, over: Partial<OpinionDossier> = {}): OpinionDossier {
  return {
    id,
    path: `/repo/.claude/worktrees/${id}`,
    branch: id,
    reasonCode: 'dirty',
    reasonDetail: 'Modified files.',
    fate: 'merged',
    prState: 'MERGED',
    head: 'aaa111',
    diffStat: ' a.ts | 2 +-',
    dirtyFiles: [' M a.ts'],
    lastSessionSummary: null,
    ...over
  }
}

interface Rig {
  service: ReturnType<typeof createOpinionService>
  results: GcOpinionResult[]
  done: GcOpinionDone[]
  runs: { cwd: string | null; argv: string[]; stdin: string }[]
  state: {
    lookup: Record<string, OpinionLookup>
    dossiers: Record<string, OpinionDossier>
    groups: Record<string, string>
    answer: (prompt: string) => string | null
  }
}

/** The model answers "safe" for every item it is shown unless a test says otherwise. */
const allSafe = (prompt: string): string => {
  const refs = [...prompt.matchAll(/<dossier id="(item-\d+)">/g)].map((m) => m[1])
  return JSON.stringify({
    opinions: refs.map((id) => ({ id, verdict: 'safe', reason: 'r', evidence: 'on main' }))
  })
}

function rig(ids: string[], cache = createOpinionCache()): Rig {
  const results: GcOpinionResult[] = []
  const done: GcOpinionDone[] = []
  const runs: Rig['runs'] = []
  const state: Rig['state'] = {
    lookup: Object.fromEntries(ids.map((id) => [id, 'review' as const])),
    dossiers: Object.fromEntries(ids.map((id) => [id, dossier(id)])),
    groups: {},
    answer: allSafe
  }
  let n = 0
  const service = createOpinionService({
    cache,
    classify: async () => (id) => state.lookup[id],
    dossier: async (id) => {
      const d = state.dossiers[id]
      return d ? { dossier: d, group: state.groups[id] ?? '/repo' } : null
    },
    route: async (group) => ({ model: group === '/other' ? 'sonnet' : 'opus', effort: 'high' }),
    run: async (a) => {
      runs.push(a)
      const prompt = a.stdin
      return state.answer(prompt)
    },
    emitResult: (r) => results.push(r),
    emitDone: (d) => done.push(d),
    newId: () => `job-${++n}`
  })
  return { service, results, done, runs, state }
}

const verdicts = (r: Rig): Record<string, string> =>
  Object.fromEntries(
    r.results.filter((x) => 'verdict' in x).map((x) => [x.id, (x as { verdict: string }).verdict])
  )

describe('parseOpinionIds', () => {
  it('takes an array of non-empty strings', () => {
    expect(parseOpinionIds(['a', 'b'])).toEqual(['a', 'b'])
  })
  it.each([
    ['not an array', 'a'],
    ['a non-string id', ['a', 3]],
    ['an empty id', ['a', '']],
    ['no ids', []]
  ])('rejects %s', (_n, raw) => {
    expect(() => parseOpinionIds(raw)).toThrow()
  })
  it('rejects more than 100 ids', () => {
    expect(() => parseOpinionIds(Array.from({ length: 101 }, (_, i) => `i${i}`))).toThrow()
  })
})

describe('classifyOpinionIds', () => {
  it('accepts review items and orphan volumes, refuses the rest per id', () => {
    const lookup = (id: string): OpinionLookup | undefined =>
      ({ a: 'review', 'volume:v': 'orphan-volume', r: 'other' })[id] as OpinionLookup | undefined
    expect(classifyOpinionIds(['a', 'volume:v', 'r', 'nope'], lookup)).toEqual({
      accepted: ['a', 'volume:v'],
      refused: [
        { id: 'r', code: 'not-review' },
        { id: 'nope', code: 'unknown' }
      ]
    })
  })
  it('drops a repeated id', () => {
    expect(classifyOpinionIds(['a', 'a'], () => 'review').accepted).toEqual(['a'])
  })
})

describe('opinionKey', () => {
  it('changes with the fate, the head, the dirty set or the reason, not with the order of the dirty files', () => {
    const base = dossier('x', { dirtyFiles: [' M a.ts', '?? b.ts'] })
    const key = opinionKey(base)
    expect(opinionKey({ ...base, dirtyFiles: ['?? b.ts', ' M a.ts'] })).toBe(key)
    expect(opinionKey({ ...base, head: 'bbb222' })).not.toBe(key)
    expect(opinionKey({ ...base, fate: 'open' })).not.toBe(key)
    expect(opinionKey({ ...base, prState: 'OPEN' })).not.toBe(key)
    expect(opinionKey({ ...base, reasonCode: 'unpushed' })).not.toBe(key)
    expect(opinionKey({ ...base, dirtyFiles: [' M a.ts'] })).not.toBe(key)
  })
  it('keys a volume by its project and size', () => {
    const v = (size: number | null, project: string | null): OpinionDossier =>
      dossier('volume:v', { path: null, volume: { name: 'v', project, sizeBytes: size } })
    expect(opinionKey(v(1, 'p'))).toBe(opinionKey(v(1, 'p')))
    expect(opinionKey(v(2, 'p'))).not.toBe(opinionKey(v(1, 'p')))
    expect(opinionKey(v(1, 'q'))).not.toBe(opinionKey(v(1, 'p')))
  })
})

describe('the service: ask (AC-1)', () => {
  it('returns { jobId } at once, then streams the results and a terminal done', async () => {
    const r = rig(['a', 'b'])
    const ack = r.service.start(['a', 'b'])
    expect(ack).toEqual({ jobId: 'job-1' })
    expect(r.results).toHaveLength(0) // nothing has run yet: the ack did not wait for the model
    await r.service.idle()
    expect(verdicts(r)).toEqual({ a: 'safe', b: 'safe' })
    expect(r.results.every((x) => x.jobId === 'job-1')).toBe(true)
    expect(r.done).toEqual([
      { jobId: 'job-1', answered: 2, cached: 0, refused: 0, failed: 0, stale: 0 }
    ])
  })

  it('refuses ready, in-use and unknown ids per id and never runs the model for them', async () => {
    const r = rig(['a'])
    r.state.lookup = { a: 'review', ready1: 'other', 'volume:v': 'orphan-volume' }
    r.state.dossiers['volume:v'] = dossier('volume:v', {
      path: null,
      volume: { name: 'v', project: 'p', sizeBytes: 5 }
    })
    r.service.start(['a', 'ready1', 'ghost', 'volume:v'])
    await r.service.idle()
    const refused = r.results.filter((x) => 'refused' in x)
    expect(refused.map((x) => [x.id, (x as { refused: string }).refused])).toEqual([
      ['ready1', 'not-review'],
      ['ghost', 'unknown']
    ])
    expect(Object.keys(verdicts(r)).sort()).toEqual(['a', 'volume:v'])
    expect(r.done[0]).toMatchObject({ answered: 2, refused: 2 })
    for (const run of r.runs) {
      expect(run.stdin).not.toContain('ready1')
    }
  })

  it('refuses an id whose item vanished between the snapshot and the dossier', async () => {
    const r = rig(['a', 'b'])
    delete r.state.dossiers.b
    r.service.start(['a', 'b'])
    await r.service.idle()
    expect(r.results.find((x) => x.id === 'b')).toMatchObject({ refused: 'unknown' })
  })

  it('rejects a malformed request before it creates a job', () => {
    const r = rig(['a'])
    expect(() => r.service.start('a')).toThrow()
    expect(() => r.service.start([])).toThrow()
  })

  it('never lets an item reach the model under its real id', async () => {
    const r = rig(['/repo::worktree::feat'])
    r.state.dossiers['/repo::worktree::feat'] = dossier('feat', { path: '/repo/wt' })
    r.service.start(['/repo::worktree::feat'])
    await r.service.idle()
    expect([...r.runs[0].argv, r.runs[0].stdin].join('\n')).not.toContain('::')
  })
})

describe('the service: the read-only session (AC-2)', () => {
  it('hands the spawn exactly opinionArgv for the routed model, in the repo as cwd', async () => {
    const r = rig(['a'])
    r.service.start(['a'])
    await r.service.idle()
    expect(r.runs).toHaveLength(1)
    const { cwd, argv, stdin } = r.runs[0]
    expect(cwd).toBe('/repo')
    expect(stdin).toContain('<dossier id="item-1">')
    expect(argv).toEqual(opinionArgv({ model: 'opus', effort: 'high' }))
    expect(argv.join(' ')).not.toContain('mcp__')
  })

  it('uses each repo’s own routed model and runs one process per repo', async () => {
    const r = rig(['a', 'b'])
    r.state.groups = { a: '/repo', b: '/other' }
    r.service.start(['a', 'b'])
    await r.service.idle()
    expect(r.runs.map((x) => x.cwd)).toEqual(['/repo', '/other'])
    expect(r.runs.map((x) => x.argv[x.argv.indexOf('--model') + 1])).toEqual(['opus', 'sonnet'])
  })

  it('runs a volume batch with no cwd', async () => {
    const r = rig([])
    r.state.lookup = { 'volume:v': 'orphan-volume' }
    r.state.dossiers['volume:v'] = dossier('volume:v', {
      path: null,
      volume: { name: 'v', project: 'p', sizeBytes: 5 }
    })
    r.state.groups['volume:v'] = ''
    r.service.start(['volume:v'])
    await r.service.idle()
    expect(r.runs[0].cwd).toBeNull()
  })

  it('splits a repo’s items into batches of at most the batch size', async () => {
    const many = Array.from({ length: OPINION_BATCH_SIZE * 2 + 1 }, (_, i) => `w${i}`)
    const r = rig(many)
    r.service.start(many)
    await r.service.idle()
    expect(r.runs).toHaveLength(3)
    for (const run of r.runs) {
      const refs = run.stdin.match(/<dossier id=/g) ?? []
      expect(refs.length).toBeLessThanOrEqual(OPINION_BATCH_SIZE)
    }
    expect(Object.keys(verdicts(r))).toHaveLength(many.length)
  })

  it('runs one process at a time, even across jobs', async () => {
    let live = 0
    let peak = 0
    const slow = createOpinionService({
      cache: createOpinionCache(),
      classify: async () => () => 'review',
      dossier: async (id) => ({ dossier: dossier(id), group: `/repo-${id}` }),
      route: async () => ({ model: 'opus', effort: 'high' }),
      run: async (a) => {
        live++
        peak = Math.max(peak, live)
        await new Promise((res) => setTimeout(res, 5))
        live--
        return allSafe(a.stdin)
      },
      emitResult: () => {},
      emitDone: () => {},
      newId: () => 'j'
    })
    slow.start(['a'])
    slow.start(['b'])
    await slow.idle()
    expect(peak).toBe(1)
  })
})

describe('the service: caching (AC-4)', () => {
  it('serves a second ask from the cache without running the model again', async () => {
    const r = rig(['a'])
    r.service.start(['a'])
    await r.service.idle()
    r.service.start(['a'])
    await r.service.idle()
    expect(r.runs).toHaveLength(1)
    expect(verdicts(r)).toEqual({ a: 'safe' })
    expect(r.results.filter((x) => x.id === 'a')).toHaveLength(2)
    expect(r.done[1]).toMatchObject({ answered: 0, cached: 1 })
  })

  it('asks again when the head, the dirty set or the fate changed', async () => {
    const r = rig(['a'])
    r.service.start(['a'])
    await r.service.idle()
    r.state.dossiers.a = dossier('a', { head: 'bbb222' })
    r.service.start(['a'])
    await r.service.idle()
    r.state.dossiers.a = dossier('a', { head: 'bbb222', dirtyFiles: [' M a.ts', '?? new.ts'] })
    r.service.start(['a'])
    await r.service.idle()
    r.state.dossiers.a = dossier('a', {
      head: 'bbb222',
      dirtyFiles: [' M a.ts', '?? new.ts'],
      fate: 'open'
    })
    r.service.start(['a'])
    await r.service.idle()
    expect(r.runs).toHaveLength(4)
  })

  it('only asks the model about the items that are not cached', async () => {
    const r = rig(['a', 'b'])
    r.service.start(['a'])
    await r.service.idle()
    r.service.start(['a', 'b'])
    await r.service.idle()
    expect(r.runs).toHaveLength(2)
    const prompt = r.runs[1].stdin
    expect(prompt.match(/<dossier id=/g)).toHaveLength(1)
    expect(prompt).toContain('Branch: b')
  })

  it('lives in the cache the service was given, not in any window: a new service over it still hits', async () => {
    const cache = createOpinionCache()
    const first = rig(['a'], cache)
    first.service.start(['a'])
    await first.service.idle()
    const second = rig(['a'], cache)
    second.service.start(['a'])
    await second.service.idle()
    expect(second.runs).toHaveLength(0)
    expect(verdicts(second)).toEqual({ a: 'safe' })
  })

  it('never caches a failed run, so asking again asks again', async () => {
    const r = rig(['a'])
    r.state.answer = () => null
    r.service.start(['a'])
    await r.service.idle()
    expect(verdicts(r)).toEqual({ a: 'unsure' })
    expect(r.done[0]).toMatchObject({ answered: 0, failed: 1 })
    r.state.answer = allSafe
    r.service.start(['a'])
    await r.service.idle()
    expect(r.runs).toHaveLength(2)
    expect(r.results.filter((x) => x.id === 'a').pop()).toMatchObject({ verdict: 'safe' })
  })

  it('never caches an item the model skipped or answered badly', async () => {
    const r = rig(['a', 'b'])
    r.state.answer = () =>
      JSON.stringify({
        opinions: [{ id: 'item-1', verdict: 'safe', reason: 'r', evidence: 'e' }]
      })
    r.service.start(['a', 'b'])
    await r.service.idle()
    expect(verdicts(r)).toEqual({ a: 'safe', b: 'unsure' })
    r.service.start(['a', 'b'])
    await r.service.idle()
    expect(r.runs).toHaveLength(2) // b was asked again, a came from the cache
    expect(r.runs[1].stdin.match(/<dossier id=/g)).toHaveLength(1)
  })

  it('treats a run that throws like a failed run', async () => {
    const results: GcOpinionResult[] = []
    const svc = createOpinionService({
      cache: createOpinionCache(),
      classify: async () => () => 'review',
      dossier: async (id) => ({ dossier: dossier(id), group: '/repo' }),
      route: async () => ({ model: 'opus', effort: 'high' }),
      run: async () => {
        throw new Error('spawn exploded')
      },
      emitResult: (x) => results.push(x),
      emitDone: () => {},
      newId: () => 'j'
    })
    svc.start(['a'])
    await svc.idle()
    expect(results[0]).toMatchObject({ id: 'a', verdict: 'unsure' })
  })
})

describe('the peek: gc:opinion:cached serves main’s cache and never asks', () => {
  async function asked(ids: string[]): Promise<Rig> {
    const r = rig(ids)
    r.service.start(ids)
    await r.service.idle()
    return r
  }

  it('returns the cached opinion of every item that is still as it was', async () => {
    const r = await asked(['a', 'b'])
    const hits = await r.service.cached(['a', 'b'])
    expect(Object.keys(hits).sort()).toEqual(['a', 'b'])
    expect(hits.a).toMatchObject({ id: 'a', verdict: 'safe', evidence: 'on main' })
  })

  it('never runs the model, emits nothing and starts no job', async () => {
    const r = await asked(['a'])
    const runs = r.runs.length
    const results = r.results.length
    const done = r.done.length
    await r.service.cached(['a', 'nope'])
    expect(r.runs).toHaveLength(runs)
    expect(r.results).toHaveLength(results)
    expect(r.done).toHaveLength(done)
  })

  it('returns nothing for an item nobody asked about', async () => {
    const r = rig(['a'])
    expect(await r.service.cached(['a'])).toEqual({})
  })

  it('applies the cache rules: a changed head, dirty set, fate or PR state drops the opinion', async () => {
    const r = await asked(['a'])
    const base = r.state.dossiers.a
    for (const change of [
      { head: 'bbb222' },
      { dirtyFiles: [' M a.ts', '?? new.ts'] },
      { fate: 'open' },
      { prState: 'OPEN' },
      { reasonCode: 'unpushed' }
    ]) {
      r.state.dossiers.a = { ...base, ...change }
      expect(await r.service.cached(['a'])).toEqual({})
    }
    r.state.dossiers.a = base
    expect(Object.keys(await r.service.cached(['a']))).toEqual(['a'])
  })

  it('answers only for Needs review items and orphan volumes, and skips the rest quietly', async () => {
    const r = await asked(['a'])
    r.state.lookup.a = 'other'
    expect(await r.service.cached(['a', 'ghost'])).toEqual({})
  })

  it('skips an item that vanished', async () => {
    const r = await asked(['a'])
    delete r.state.dossiers.a
    expect(await r.service.cached(['a'])).toEqual({})
  })

  it('does not return a failed or fallback answer, because none was cached', async () => {
    const r = rig(['a'])
    r.state.answer = () => null
    r.service.start(['a'])
    await r.service.idle()
    expect(await r.service.cached(['a'])).toEqual({})
  })

  it('survives a rebuilt service over the same cache: a reload gets its chips back without a new ask', async () => {
    const cache = createOpinionCache()
    const first = rig(['a'], cache)
    first.service.start(['a'])
    await first.service.idle()
    const second = rig(['a'], cache)
    expect(Object.keys(await second.service.cached(['a']))).toEqual(['a'])
    expect(second.runs).toHaveLength(0)
  })

  it('uses the cheap key facts, not the full dossier, so a long list stays quick', async () => {
    const cache = createOpinionCache()
    const first = rig(['a'], cache)
    first.service.start(['a'])
    await first.service.idle()
    let keyCalls = 0
    let dossierCalls = 0
    const peek = createOpinionService({
      cache,
      classify: async () => () => 'review',
      keyFacts: async () => {
        keyCalls++
        return first.state.dossiers.a
      },
      dossier: async () => {
        dossierCalls++
        return null
      },
      route: async () => ({ model: 'opus', effort: 'high' }),
      run: async () => null,
      emitResult: () => {},
      emitDone: () => {},
      newId: () => 'j'
    })
    expect(Object.keys(await peek.cached(['a']))).toEqual(['a'])
    expect(keyCalls).toBe(1)
    expect(dossierCalls).toBe(0)
  })

  it('rejects a malformed request and takes up to 500 ids', async () => {
    const r = rig(['a'])
    await expect(r.service.cached('a')).rejects.toThrow()
    await expect(r.service.cached([])).rejects.toThrow()
    await expect(r.service.cached(Array.from({ length: 501 }, (_, i) => `i${i}`))).rejects.toThrow()
    await expect(r.service.cached(Array.from({ length: 500 }, (_, i) => `i${i}`))).resolves.toEqual(
      {}
    )
  })
})

describe('a result is bound to the item as it was when asked (stale chips)', () => {
  const resultOf = (r: Rig, id: string): GcOpinionResult | undefined =>
    r.results.filter((x) => x.id === id).pop()

  it('flags a result stale and caches nothing when the dirty set changed while the model ran', async () => {
    const r = rig(['a'])
    r.state.answer = (prompt) => {
      r.state.dossiers.a = dossier('a', { dirtyFiles: [' M a.ts', '?? appeared-meanwhile.ts'] })
      return allSafe(prompt)
    }
    r.service.start(['a'])
    await r.service.idle()
    expect(resultOf(r, 'a')).toEqual({ jobId: 'job-1', id: 'a', stale: true })
    expect(r.done[0]).toMatchObject({ answered: 0, stale: 1 })
    expect(await r.service.cached(['a'])).toEqual({})
    // Neither state has an opinion: the next ask asks again.
    r.state.answer = allSafe
    r.service.start(['a'])
    await r.service.idle()
    expect(r.runs).toHaveLength(2)
  })

  it.each([
    ['head', { head: 'bbb222' }],
    ['fate', { fate: 'open' }],
    ['pull request state', { prState: 'OPEN' }],
    ['reason', { reasonCode: 'unpushed' }]
  ])('also when the %s changed while the model ran', async (_name, change) => {
    const r = rig(['a'])
    r.state.answer = (prompt) => {
      r.state.dossiers.a = { ...r.state.dossiers.a, ...change }
      return allSafe(prompt)
    }
    r.service.start(['a'])
    await r.service.idle()
    expect(resultOf(r, 'a')).toMatchObject({ stale: true })
  })

  it('flags only the item that changed, not its neighbours in the batch', async () => {
    const r = rig(['a', 'b'])
    r.state.answer = (prompt) => {
      r.state.dossiers.b = dossier('b', { head: 'moved' })
      return allSafe(prompt)
    }
    r.service.start(['a', 'b'])
    await r.service.idle()
    expect(resultOf(r, 'a')).toMatchObject({ verdict: 'safe', durable: true })
    expect(resultOf(r, 'b')).toMatchObject({ stale: true })
  })

  it('an item that vanished while the model ran is stale too', async () => {
    const r = rig(['a'])
    r.state.answer = (prompt) => {
      delete r.state.dossiers.a
      return allSafe(prompt)
    }
    r.service.start(['a'])
    await r.service.idle()
    expect(resultOf(r, 'a')).toMatchObject({ stale: true })
  })

  it('marks an answer durable when it is cached, and a fallback unsure not', async () => {
    const r = rig(['a', 'b'])
    r.state.answer = () =>
      JSON.stringify({ opinions: [{ id: 'item-1', verdict: 'safe', reason: 'r', evidence: 'e' }] })
    r.service.start(['a', 'b'])
    await r.service.idle()
    expect(resultOf(r, 'a')).toMatchObject({ verdict: 'safe', durable: true })
    expect(resultOf(r, 'b')).toMatchObject({ verdict: 'unsure', durable: false })
    r.service.start(['a'])
    await r.service.idle()
    expect(resultOf(r, 'a')).toMatchObject({ verdict: 'safe', durable: true }) // from the cache
  })

  it('a failed run reads unsure and not durable', async () => {
    const r = rig(['a'])
    r.state.answer = () => null
    r.service.start(['a'])
    await r.service.idle()
    expect(resultOf(r, 'a')).toMatchObject({ verdict: 'unsure', durable: false })
  })
})

describe('the prompt goes over stdin, never in argv (E2BIG)', () => {
  const MAX_ARG = 64 * 1024
  const worst = (i: number): OpinionDossier =>
    dossier(`w${i}`, {
      path: `/repo/.claude/worktrees/${'long-name-'.repeat(8)}${i}`,
      reasonDetail: 'r'.repeat(900),
      branch: 'b'.repeat(900),
      diffStat: ' file.ts | 9 +++++++++\n'.repeat(900),
      dirtyFiles: Array.from({ length: 400 }, (_, k) => ` M ${'dir/'.repeat(120)}file${k}.ts`),
      lastSessionSummary: 's'.repeat(5000)
    })

  it('hands the prompt to the run as stdin and keeps every argv element small', async () => {
    const r = rig(['a'])
    r.service.start(['a'])
    await r.service.idle()
    const { argv, stdin } = r.runs[0]
    expect(stdin).toContain('Branch: a')
    expect(stdin).toContain('<dossier id="item-1">')
    for (const el of argv) expect(el.length).toBeLessThan(1024)
    expect(argv.join('\n')).not.toContain('<dossier')
    expect(argv).not.toContain('--') // no positional prompt follows
  })

  it('a worst-case 8-item batch: argv stays tiny and the whole prompt arrives intact on stdin', async () => {
    const ids = Array.from({ length: OPINION_BATCH_SIZE }, (_, i) => `w${i}`)
    const r = rig([])
    r.state.lookup = Object.fromEntries(ids.map((id) => [id, 'review' as const]))
    r.state.dossiers = Object.fromEntries(ids.map((id, i) => [id, { ...worst(i), id }]))
    r.service.start(ids)
    await r.service.idle()
    expect(r.runs).toHaveLength(1)
    const { argv, stdin } = r.runs[0]
    for (const el of argv) expect(Buffer.byteLength(el)).toBeLessThan(MAX_ARG)
    expect(Buffer.byteLength(argv.join(' '))).toBeLessThan(MAX_ARG)
    expect(stdin).toContain(`item-${OPINION_BATCH_SIZE}`)
    expect(stdin.match(/<dossier id=/g)).toHaveLength(OPINION_BATCH_SIZE)
    // Bounded all the same: the per-field caps keep a worst case far below a context window.
    expect(Buffer.byteLength(stdin)).toBeLessThan(250_000)
  })
})
