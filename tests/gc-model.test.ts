import { describe, it, expect } from 'vitest'
import { bundle, NOW, reapItem } from './gc-fixtures'
import {
  buildGcModel,
  cleanRequestFor,
  dialogRows,
  expectedFor,
  heroState,
  isCheckable,
  prunedSelection,
  selectAllInRepo,
  selectionStats,
  toggleChecked,
  volumeBlockId,
  type GcModel
} from '../src/renderer/src/lib/gc-model'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { expectedOf, orphanExpectedOf } from '../src/main/gc/gc-confirm'
import type { Bucket, DecideReason } from '../src/main/gc/bundle-core'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

function wt(
  name: string,
  bucket: Bucket,
  bytes: number | null,
  over: Parameters<typeof bundle>[2] & { repo?: string } = {}
): ReturnType<typeof bundle> {
  const { repo, ...rest } = over
  const b = bundle(`/ws/${name}`, bucket, rest)
  b.item = reapItem(`/ws/${name}`, { diskBytes: bytes, repoPath: repo ?? '/ws/org/proj/www' })
  b.item.id = `${b.item.repoPath}::worktree::/ws/${name}`
  return b
}

function snap(over: Partial<GcSnapshot> = {}): GcSnapshot {
  return {
    scannedAt: NOW,
    bundles: [],
    orphanVolumes: [],
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs: defaultGcPrefs(),
    lastCycle: null,
    nextCycleAt: null,
    ...over
  }
}

const reason = (code: DecideReason['code'], detail = 'x'): DecideReason => ({ code, detail })

function sample(): GcSnapshot {
  return snap({
    bundles: [
      wt('c1', 'corpse', 512 * MIB),
      wt('c2', 'corpse', 488 * MIB),
      wt('d1', 'decide', 2 * GIB, { reason: reason('dirty') }),
      wt('d2', 'decide', 600 * MIB, { reason: reason('closed-unmerged') }),
      wt('d3', 'decide', 300 * MIB, { reason: reason('remote-gone'), repo: '/ws/org/portal' }),
      wt('a1', 'alive', 1 * GIB)
    ],
    orphanVolumes: [
      {
        id: 'volume:pg_data',
        name: 'pg_data',
        sizeBytes: 900 * MIB,
        project: 'old-app',
        reason: { code: 'no-known-worktree', detail: 'No known worktree.' }
      }
    ]
  })
}

describe('buildGcModel', () => {
  it('groups blocks by repo, then by bucket, and counts them', () => {
    const m = buildGcModel(sample())
    expect(m.regions.map((r) => r.label).sort()).toEqual(['portal', 'www'])
    const www = m.regions.find((r) => r.label === 'www')!
    expect(www.counts).toEqual({ corpse: 2, decide: 2, alive: 1 })
    expect(www.bytes).toBe(512 * MIB + 488 * MIB + 2 * GIB + 600 * MIB + 1 * GIB)
    expect(www.groups.map((g) => g.bucket)).toEqual(['corpse', 'decide', 'alive'])
  })

  it('sorts regions and blocks biggest first', () => {
    const m = buildGcModel(sample())
    expect(m.regions[0].label).toBe('www')
    const decide = m.regions[0].groups.find((g) => g.bucket === 'decide')!
    expect(decide.blocks.map((b) => b.bytes)).toEqual([2 * GIB, 600 * MIB])
  })

  it('totals each bucket and counts reclaimable as everything not alive plus orphan volumes', () => {
    const m = buildGcModel(sample())
    expect(m.totals.corpse).toEqual({ count: 2, bytes: 1000 * MIB })
    expect(m.totals.decide).toEqual({ count: 3, bytes: 2 * GIB + 600 * MIB + 300 * MIB })
    expect(m.totals.alive).toEqual({ count: 1, bytes: 1 * GIB })
    expect(m.totals.orphanVolumes).toEqual({ count: 1, bytes: 900 * MIB })
    expect(m.reclaimableBytes).toBe(1000 * MIB + (2 * GIB + 900 * MIB) + 900 * MIB)
  })

  it('lists the Decide items ("Needs you") biggest first, orphan volumes included', () => {
    const m = buildGcModel(sample())
    expect(m.needsYou.map((b) => b.name)).toEqual(['d1', 'pg_data', 'd2', 'd3'])
    const vol = m.needsYou.find((b) => b.kind === 'volume')!
    expect(vol.id).toBe('volume:pg_data')
    expect(vol.project).toBe('old-app')
    expect(vol.reasonCode).toBe('no-known-worktree')
  })

  it('carries reason code, branch and a stable id on worktree blocks', () => {
    const m = buildGcModel(sample())
    const d1 = m.blocks.find((b) => b.name === 'd1')!
    expect(d1.reasonCode).toBe('dirty')
    expect(d1.branch).toBe('feat/d1')
    expect(d1.id).toContain('::worktree::')
    expect(d1.kind).toBe('worktree')
  })

  it('reports hasBytes false when no worktree has a size (Windows) and keeps counts', () => {
    const m = buildGcModel(snap({ bundles: [wt('c1', 'corpse', null), wt('d1', 'decide', null)] }))
    expect(m.hasBytes).toBe(false)
    expect(m.totals.corpse.count).toBe(1)
    expect(m.totals.corpse.bytes).toBe(0)
  })

  it('is empty-safe', () => {
    const m = buildGcModel(snap())
    expect(m.regions).toEqual([])
    expect(m.needsYou).toEqual([])
    expect(m.reclaimableBytes).toBe(0)
  })
})

describe('selection rules', () => {
  let m: GcModel
  const fresh = (): GcModel => (m = buildGcModel(sample()))

  it('only Decide items are checkable — corpses and alive never are', () => {
    fresh()
    for (const b of m.blocks) expect(isCheckable(b)).toBe(b.bucket === 'decide')
    expect(isCheckable(m.needsYou.find((b) => b.kind === 'volume')!)).toBe(true)
  })

  it('toggleChecked adds, removes and refuses a non-Decide id', () => {
    fresh()
    const d1 = m.needsYou[0].id
    let sel = toggleChecked(m, new Set(), d1)
    expect([...sel]).toEqual([d1])
    sel = toggleChecked(m, sel, d1)
    expect(sel.size).toBe(0)
    const corpse = m.blocks.find((b) => b.bucket === 'corpse')!.id
    expect(toggleChecked(m, new Set(), corpse).size).toBe(0)
    expect(toggleChecked(m, new Set(), 'nope').size).toBe(0)
  })

  it("selectAllInRepo selects that repo's Decide worktrees only", () => {
    fresh()
    const ids = selectAllInRepo(m, '/ws/org/proj/www')
    expect(ids.map((i) => m.byId.get(i)!.name).sort()).toEqual(['d1', 'd2'])
    expect(selectAllInRepo(m, '/ws/org/portal')).toHaveLength(1)
    expect(selectAllInRepo(m, '/nowhere')).toEqual([])
  })

  it('selectionStats counts and sums bytes', () => {
    fresh()
    const ids = selectAllInRepo(m, '/ws/org/proj/www')
    expect(selectionStats(m, new Set(ids))).toEqual({ count: 2, bytes: 2 * GIB + 600 * MIB })
  })

  it('prunedSelection drops ids that stopped being Decide (cleaned, kept, re-bucketed)', () => {
    fresh()
    const d1 = m.needsYou[0].id
    const sel = new Set([d1, 'gone'])
    expect([...prunedSelection(m, sel)]).toEqual([d1])
    const next = buildGcModel(snap({ bundles: [wt('d1', 'corpse', 2 * GIB)] }))
    expect(prunedSelection(next, new Set([d1])).size).toBe(0)
  })
})

describe('heroState', () => {
  it('offers to clean every corpse with count and bytes', () => {
    const h = heroState(buildGcModel(sample()), null, true)
    expect(h).toEqual({ kind: 'clean', count: 2, bytes: 1000 * MIB, soft: false })
  })

  it('is disabled "nothing to clean" without corpses', () => {
    const h = heroState(buildGcModel(snap({ bundles: [wt('d1', 'decide', 1)] })), null, true)
    expect(h.kind).toBe('empty')
  })

  it('turns into the progress chip while a job runs', () => {
    const h = heroState(
      buildGcModel(sample()),
      { jobId: 'j', done: 3, total: 12, freedBytes: 1397 * MIB },
      true
    )
    expect(h).toEqual({ kind: 'running', done: 3, total: 12, freedBytes: 1397 * MIB })
  })

  it('is Soft before the first report is acknowledged (Enable autopilot owns the Primary)', () => {
    const h = heroState(buildGcModel(sample()), null, false)
    expect(h).toMatchObject({ kind: 'clean', soft: true })
  })
})

describe('dialogRows', () => {
  it('lists repo, worktree, branch, bytes and what each removal takes with it', () => {
    const b = wt('c1', 'corpse', 512 * MIB, {
      stackIds: ['stack-a'],
      ownedVolumes: ['v1'],
      depsBytes: 200 * MIB
    })
    const rows = dialogRows(buildGcModel(snap({ bundles: [b] })), [b.item.id])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      repo: 'www',
      name: 'c1',
      branch: 'feat/c1',
      bytes: 512 * MIB,
      chips: ['stack', 'deps', 'checkout', 'branch']
    })
  })

  it("never lists a worktree's volumes as removed (D1: they are kept), nor stack/deps chips that are absent", () => {
    const b = wt('c1', 'corpse', 1, { ownedVolumes: ['v1'] })
    const rows = dialogRows(buildGcModel(snap({ bundles: [b] })), [b.item.id])
    expect(rows[0].chips).toEqual(['checkout', 'branch'])
    expect(rows[0].chips).not.toContain('volume')
  })

  it('flags rows that hold work no other branch has', () => {
    const risky = wt('d1', 'decide', 1, { reason: reason('closed-unmerged') })
    const safe = wt('d2', 'decide', 1, { reason: reason('open-idle-session') })
    const m = buildGcModel(snap({ bundles: [risky, safe] }))
    const rows = dialogRows(m, [risky.item.id, safe.item.id])
    expect(rows.find((r) => r.name === 'd1')!.risk).toBe(true)
    expect(rows.find((r) => r.name === 'd2')!.risk).toBe(false)
    expect(rows.find((r) => r.name === 'd1')!.reasonCode).toBe('closed-unmerged')
  })

  it('shows an orphan volume as a volume row with its project', () => {
    const m = buildGcModel(sample())
    const rows = dialogRows(m, ['volume:pg_data'])
    expect(rows[0]).toMatchObject({ kind: 'volume', name: 'pg_data', project: 'old-app' })
    expect(rows[0].chips).toEqual(['volume'])
  })

  it('skips ids the model no longer has', () => {
    expect(dialogRows(buildGcModel(snap()), ['ghost'])).toEqual([])
  })
})

describe('cleanRequestFor — the one place that builds the gc:clean payload', () => {
  it('bulk corpses: ids + expected for every id, no confirmed', () => {
    const c = wt('c1', 'corpse', 512 * MIB, {
      stackIds: ['s1'],
      ownedVolumes: ['v1'],
      localTip: 'b'.repeat(40)
    })
    const m = buildGcModel(snap({ bundles: [c] }))
    const req = cleanRequestFor(m, [c.item.id], 'corpses')
    expect(req.ids).toEqual([c.item.id])
    expect(req.options.confirmed).toBeUndefined()
    expect(req.options.expected[c.item.id]).toEqual({
      bucket: 'corpse',
      reasonCode: null,
      headSha: 'b'.repeat(40),
      stackIds: ['s1'],
      ownedVolumes: ['v1'],
      bytes: 512 * MIB
    })
  })

  it('remove selected: every id is confirmed and has an expected entry, volumes included', () => {
    const m = buildGcModel(sample())
    const d1 = m.needsYou.find((b) => b.name === 'd1')!.id
    const req = cleanRequestFor(m, [d1, 'volume:pg_data'], 'decide')
    expect(req.options.confirmed).toEqual([d1, 'volume:pg_data'])
    expect(req.options.expected[d1].reasonCode).toBe('dirty')
    expect(req.options.expected['volume:pg_data']).toMatchObject({
      bucket: 'orphan-volume',
      project: 'old-app',
      reasonCode: 'no-known-worktree',
      headSha: null,
      ownedVolumes: ['pg_data'],
      bytes: 900 * MIB
    })
  })

  it('never sends the retired confirmDecide boolean', () => {
    const m = buildGcModel(sample())
    const req = cleanRequestFor(m, [m.needsYou[0].id], 'decide')
    expect('confirmDecide' in req.options).toBe(false)
  })

  it('is plain data that survives structured clone (IPC)', () => {
    const m = buildGcModel(sample())
    const req = cleanRequestFor(m, [m.needsYou[0].id], 'decide')
    expect(structuredClone(req)).toEqual(req)
  })

  it('drops ids the model no longer knows rather than sending a blind id', () => {
    const m = buildGcModel(sample())
    expect(cleanRequestFor(m, ['ghost'], 'corpses').ids).toEqual([])
  })
})

describe('volumeBlockId', () => {
  it('matches the engine id', () => {
    expect(volumeBlockId('pg_data')).toBe('volume:pg_data')
  })
})

describe("expectedFor mirrors main's expectedOf / orphanExpectedOf", () => {
  it('sends exactly what main compares for a worktree (sorted stacks and volumes, localTip)', () => {
    const b = wt('c1', 'corpse', 512 * MIB, {
      stackIds: ['b-stack', 'a-stack'],
      ownedVolumes: ['v2', 'v1'],
      localTip: 'c'.repeat(40)
    })
    const m = buildGcModel(snap({ bundles: [b] }))
    expect(expectedFor(m.byId.get(b.item.id)!)).toEqual(expectedOf(b))
  })

  it('a worktree with no known size sends null bytes, like main', () => {
    const b = wt('c1', 'corpse', null)
    const m = buildGcModel(snap({ bundles: [b] }))
    expect(expectedFor(m.byId.get(b.item.id)!)).toEqual(expectedOf(b))
  })

  it('sends exactly what main compares for an orphan volume, project included', () => {
    const s = sample()
    const m = buildGcModel(s)
    const v = s.orphanVolumes[0]
    expect(expectedFor(m.byId.get(v.id)!)).toEqual(orphanExpectedOf(v))
  })

  it('a volume with no project and no size sends nulls, so main sees what the operator saw', () => {
    const s = snap({
      orphanVolumes: [
        {
          id: 'volume:x',
          name: 'x',
          sizeBytes: null,
          project: null,
          reason: { code: 'no-known-worktree', detail: 'd' }
        }
      ]
    })
    const m = buildGcModel(s)
    expect(expectedFor(m.byId.get('volume:x')!)).toEqual(orphanExpectedOf(s.orphanVolumes[0]))
  })

  it('does not fall back to the checked-out commit of a detached worktree: main compares localTip only', () => {
    const b = wt('c1', 'corpse', 1, { localTip: null })
    b.item.headSha = 'd'.repeat(40)
    const m = buildGcModel(snap({ bundles: [b] }))
    expect(expectedFor(m.byId.get(b.item.id)!).headSha).toBeNull()
    expect(expectedFor(m.byId.get(b.item.id)!)).toEqual(expectedOf(b))
  })
})

describe('Docker figures in the model', () => {
  const withDocker = (docker: GcSnapshot['docker'], cache = true): GcSnapshot => ({
    ...snap({ bundles: [wt('c1', 'corpse', 100 * MIB)] }),
    docker,
    prefs: { ...defaultGcPrefs(), categories: { worktrees: true, dockerCache: cache } }
  })

  it('adds the reclaimable build cache and dangling images to what can be reclaimed', () => {
    const m = buildGcModel(
      withDocker({
        buildCacheReclaimableBytes: 3 * GIB,
        danglingImages: { count: 4, bytes: 1 * GIB }
      })
    )
    expect(m.totals.docker).toEqual({ count: 4, bytes: 4 * GIB })
    expect(m.reclaimableBytes).toBe(100 * MIB + 4 * GIB)
    expect(m.docker.buildCacheReclaimableBytes).toBe(3 * GIB)
  })

  it('counts a null figure as nothing, not as an error', () => {
    const m = buildGcModel(
      withDocker({ buildCacheReclaimableBytes: null, danglingImages: { count: 1, bytes: MIB } })
    )
    expect(m.totals.docker.bytes).toBe(MIB)
    const none = buildGcModel(
      withDocker({ buildCacheReclaimableBytes: null, danglingImages: null })
    )
    expect(none.totals.docker).toEqual({ count: 0, bytes: 0 })
  })

  it('leaves Docker out of the total when the autopilot does not clean it', () => {
    const m = buildGcModel(
      withDocker({ buildCacheReclaimableBytes: 3 * GIB, danglingImages: null }, false)
    )
    expect(m.totals.docker.bytes).toBe(0)
    expect(m.reclaimableBytes).toBe(100 * MIB)
    // The figure itself is still there for the card to show.
    expect(m.docker.buildCacheReclaimableBytes).toBe(3 * GIB)
  })
})
