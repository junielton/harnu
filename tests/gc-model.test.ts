import { describe, it, expect } from 'vitest'
import { bundle, NOW, reapItem } from './gc-fixtures'
import { removability } from '../src/renderer/src/lib/gc-removability'
import {
  buildGcModel,
  cleanRequestFor,
  refusedRows,
  dialogRows,
  captureConfirm,
  dialogBreakdown,
  repoDisplayLabel,
  confirmChanged,
  expectedFor,
  heroState,
  isCheckable,
  isRemovable,
  unremovableIds,
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
import { CLEANABLE_KINDS, refusalFor } from '../src/main/gc/autopilot-core'
import type { ReapItemKind } from '../src/main/reaper/reaper-core'
import type { Bucket, ReviewReason } from '../src/main/gc/bundle-core'

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

const reason = (code: ReviewReason['code'], detail = 'x'): ReviewReason => ({ code, detail })

function sample(): GcSnapshot {
  return snap({
    bundles: [
      wt('c1', 'ready', 512 * MIB),
      wt('c2', 'ready', 488 * MIB),
      wt('d1', 'review', 2 * GIB, { reason: reason('dirty') }),
      wt('d2', 'review', 600 * MIB, { reason: reason('closed-unmerged') }),
      wt('d3', 'review', 300 * MIB, { reason: reason('remote-gone'), repo: '/ws/org/portal' }),
      wt('a1', 'in-use', 1 * GIB)
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
    expect(www.counts).toEqual({ ready: 2, review: 2, 'in-use': 1 })
    expect(www.bytes).toBe(512 * MIB + 488 * MIB + 2 * GIB + 600 * MIB + 1 * GIB)
    expect(www.groups.map((g) => g.bucket)).toEqual(['ready', 'review', 'in-use'])
  })

  it('sorts regions and blocks biggest first', () => {
    const m = buildGcModel(sample())
    expect(m.regions[0].label).toBe('www')
    const review = m.regions[0].groups.find((g) => g.bucket === 'review')!
    expect(review.blocks.map((b) => b.bytes)).toEqual([2 * GIB, 600 * MIB])
  })

  it('totals each bucket and counts reclaimable as everything not in use plus orphan volumes', () => {
    const m = buildGcModel(sample())
    expect(m.totals.ready).toEqual({ count: 2, bytes: 1000 * MIB })
    expect(m.totals.review).toEqual({ count: 3, bytes: 2 * GIB + 600 * MIB + 300 * MIB })
    expect(m.totals['in-use']).toEqual({ count: 1, bytes: 1 * GIB })
    expect(m.totals.orphanVolumes).toEqual({ count: 1, bytes: 900 * MIB })
    expect(m.reclaimableBytes).toBe(1000 * MIB + (2 * GIB + 900 * MIB) + 900 * MIB)
  })

  it('lists the Needs review items ("Needs you") biggest first, orphan volumes included', () => {
    const m = buildGcModel(sample())
    expect(m.review.map((b) => b.name)).toEqual(['d1', 'pg_data', 'd2', 'd3'])
    const vol = m.review.find((b) => b.kind === 'volume')!
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
    const m = buildGcModel(snap({ bundles: [wt('c1', 'ready', null), wt('d1', 'review', null)] }))
    expect(m.hasBytes).toBe(false)
    expect(m.totals.ready.count).toBe(1)
    expect(m.totals.ready.bytes).toBe(0)
  })

  it('is empty-safe', () => {
    const m = buildGcModel(snap())
    expect(m.regions).toEqual([])
    expect(m.review).toEqual([])
    expect(m.reclaimableBytes).toBe(0)
  })
})

describe('selection rules', () => {
  let m: GcModel
  const fresh = (): GcModel => (m = buildGcModel(sample()))

  it('only Needs review items are checkable — ready and in-use items never are', () => {
    fresh()
    for (const b of m.blocks) expect(isCheckable(b)).toBe(b.bucket === 'review')
    expect(isCheckable(m.review.find((b) => b.kind === 'volume')!)).toBe(true)
  })

  it('toggleChecked adds, removes and refuses a non-Needs review id', () => {
    fresh()
    const d1 = m.review[0].id
    let sel = toggleChecked(m, new Set(), d1)
    expect([...sel]).toEqual([d1])
    sel = toggleChecked(m, sel, d1)
    expect(sel.size).toBe(0)
    const ready = m.blocks.find((b) => b.bucket === 'ready')!.id
    expect(toggleChecked(m, new Set(), ready).size).toBe(0)
    expect(toggleChecked(m, new Set(), 'nope').size).toBe(0)
  })

  it("selectAllInRepo selects that repo's Needs review worktrees only", () => {
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

  it('prunedSelection drops ids that stopped being Needs review (cleaned, kept, re-bucketed)', () => {
    fresh()
    const d1 = m.review[0].id
    const sel = new Set([d1, 'gone'])
    expect([...prunedSelection(m, sel)]).toEqual([d1])
    const next = buildGcModel(snap({ bundles: [wt('d1', 'ready', 2 * GIB)] }))
    expect(prunedSelection(next, new Set([d1])).size).toBe(0)
  })
})

describe('heroState', () => {
  it('offers to clean every ready item with count and bytes', () => {
    const h = heroState(buildGcModel(sample()), null, true)
    expect(h).toEqual({ kind: 'clean', count: 2, bytes: 1000 * MIB, soft: false })
  })

  it('is disabled "nothing to clean" without ready items', () => {
    const h = heroState(buildGcModel(snap({ bundles: [wt('d1', 'review', 1)] })), null, true)
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
    const b = wt('c1', 'ready', 512 * MIB, {
      stackIds: ['stack-a'],
      ownedVolumes: ['v1'],
      depsBytes: 200 * MIB
    })
    const rows = dialogRows(buildGcModel(snap({ bundles: [b] })), [b.item.id])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      repo: 'proj/www',
      name: 'c1',
      branch: 'feat/c1',
      bytes: 512 * MIB,
      chips: ['stack', 'deps', 'checkout', 'branch']
    })
  })

  it("never lists a worktree's volumes as removed (D1: they are kept), nor stack/deps chips that are absent", () => {
    const b = wt('c1', 'ready', 1, { ownedVolumes: ['v1'] })
    const rows = dialogRows(buildGcModel(snap({ bundles: [b] })), [b.item.id])
    expect(rows[0].chips).toEqual(['checkout', 'branch'])
    expect(rows[0].chips).not.toContain('volume')
  })

  it('flags every review worktree as one that may hold work no other branch has', () => {
    const a = wt('d1', 'review', 1, { reason: reason('closed-unmerged') })
    const b = wt('d2', 'review', 1, { reason: reason('dirty') })
    const ready = wt('c1', 'ready', 1)
    const m = buildGcModel(snap({ bundles: [a, b, ready] }))
    const rows = dialogRows(m, [a.item.id, b.item.id, ready.item.id])
    expect(rows.find((r) => r.name === 'd1')!.risk).toBe(true)
    expect(rows.find((r) => r.name === 'd2')!.risk).toBe(true)
    expect(rows.find((r) => r.name === 'c1')!.risk).toBe(false)
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
  it('bulk ready: ids + expected for every id, no confirmed', () => {
    const c = wt('c1', 'ready', 512 * MIB, {
      stackIds: ['s1'],
      ownedVolumes: ['v1'],
      localTip: 'b'.repeat(40)
    })
    const m = buildGcModel(snap({ bundles: [c] }))
    const req = cleanRequestFor(m, [c.item.id], 'ready')
    expect(req.ids).toEqual([c.item.id])
    expect(req.options.confirmed).toBeUndefined()
    expect(req.options.expected[c.item.id]).toEqual({
      bucket: 'ready',
      reasonCode: null,
      headSha: 'b'.repeat(40),
      stackIds: ['s1'],
      ownedVolumes: ['v1'],
      bytes: 512 * MIB,
      path: c.item.path
    })
  })

  it('remove selected: every id is confirmed and has an expected entry, volumes included', () => {
    const m = buildGcModel(sample())
    const d1 = m.review.find((b) => b.name === 'd1')!.id
    const req = cleanRequestFor(m, [d1, 'volume:pg_data'], 'review')
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
    const req = cleanRequestFor(m, [m.review[0].id], 'review')
    expect('confirmDecide' in req.options).toBe(false)
  })

  it('is plain data that survives structured clone (IPC)', () => {
    const m = buildGcModel(sample())
    const req = cleanRequestFor(m, [m.review[0].id], 'review')
    expect(structuredClone(req)).toEqual(req)
  })

  it('drops ids the model no longer knows rather than sending a blind id', () => {
    const m = buildGcModel(sample())
    expect(cleanRequestFor(m, ['ghost'], 'ready').ids).toEqual([])
  })
})

describe('volumeBlockId', () => {
  it('matches the engine id', () => {
    expect(volumeBlockId('pg_data')).toBe('volume:pg_data')
  })
})

describe("expectedFor mirrors main's expectedOf / orphanExpectedOf", () => {
  it('sends exactly what main compares for a worktree (sorted stacks and volumes, localTip)', () => {
    const b = wt('c1', 'ready', 512 * MIB, {
      stackIds: ['b-stack', 'a-stack'],
      ownedVolumes: ['v2', 'v1'],
      localTip: 'c'.repeat(40)
    })
    const m = buildGcModel(snap({ bundles: [b] }))
    expect(expectedFor(m.byId.get(b.item.id)!)).toEqual(expectedOf(b))
  })

  it('a worktree with no known size sends null bytes, like main', () => {
    const b = wt('c1', 'ready', null)
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
    const b = wt('c1', 'ready', 1, { localTip: null })
    b.item.headSha = 'd'.repeat(40)
    const m = buildGcModel(snap({ bundles: [b] }))
    expect(expectedFor(m.byId.get(b.item.id)!).headSha).toBeNull()
    expect(expectedFor(m.byId.get(b.item.id)!)).toEqual(expectedOf(b))
  })
})

describe('Docker figures in the model', () => {
  const withDocker = (docker: GcSnapshot['docker'], cache = true): GcSnapshot => ({
    ...snap({ bundles: [wt('c1', 'ready', 100 * MIB)] }),
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

describe('captureConfirm / confirmChanged — the dialog binds to what it showed', () => {
  it('captures the rows and the request when the dialog opens', () => {
    const m = buildGcModel(sample())
    const ids = m.ready.map((b) => b.id)
    const c = captureConfirm(m, ids, 'ready')!
    expect(c.mode).toBe('ready')
    expect(c.ids).toEqual(ids)
    expect(c.rows.map((r) => r.id)).toEqual(ids)
    expect(c.request).toEqual(cleanRequestFor(m, ids, 'ready'))
  })

  it('nothing valid to capture means no dialog', () => {
    const m = buildGcModel(sample())
    expect(captureConfirm(m, ['ghost'], 'ready')).toBeNull()
    expect(
      captureConfirm(
        m,
        m.ready.map((b) => b.id),
        'review'
      )
    ).toBeNull()
  })

  it('a fresh model with the same facts is not a change', () => {
    const c = captureConfirm(
      buildGcModel(sample()),
      buildGcModel(sample()).ready.map((b) => b.id),
      'ready'
    )!
    expect(confirmChanged(buildGcModel(sample()), c)).toBe(false)
  })

  it('a worktree that moved bucket under the dialog is a change', () => {
    const before = buildGcModel(sample())
    const id = before.ready[0].id
    const c = captureConfirm(before, [id], 'ready')!
    const s = sample()
    const b = s.bundles.find((x) => x.item.id === id)!
    b.bucket = 'review'
    b.reason = reason('dirty')
    expect(confirmChanged(buildGcModel(s), c)).toBe(true)
  })

  it('a new stack, a new head or a gone item is a change', () => {
    const before = buildGcModel(sample())
    const id = before.ready[0].id
    const c = captureConfirm(before, [id], 'ready')!
    const withStack = sample()
    withStack.bundles.find((x) => x.item.id === id)!.stackIds = ['new-stack']
    expect(confirmChanged(buildGcModel(withStack), c)).toBe(true)
    const moved = sample()
    moved.bundles.find((x) => x.item.id === id)!.localTip = 'f'.repeat(40)
    expect(confirmChanged(buildGcModel(moved), c)).toBe(true)
    const gone = sample()
    gone.bundles = gone.bundles.filter((x) => x.item.id !== id)
    expect(confirmChanged(buildGcModel(gone), c)).toBe(true)
  })

  it('disk-use drift of a worktree alone is not a change (main does not compare it either)', () => {
    const before = buildGcModel(sample())
    const id = before.ready[0].id
    const c = captureConfirm(before, [id], 'ready')!
    const s = sample()
    s.bundles.find((x) => x.item.id === id)!.item.diskBytes = 1
    expect(confirmChanged(buildGcModel(s), c)).toBe(false)
  })

  it('an orphan volume that grew is a change', () => {
    const before = buildGcModel(sample())
    const c = captureConfirm(before, ['volume:pg_data'], 'review')!
    const s = sample()
    s.orphanVolumes[0].sizeBytes = 1
    expect(confirmChanged(buildGcModel(s), c)).toBe(true)
  })
})

describe('repoDisplayLabel — org/proj style labels for the map regions', () => {
  it('keeps the last two path segments so a repo with a parent reads like the mockup', () => {
    expect(repoDisplayLabel('/ws/org/proj/www')).toBe('proj/www')
    expect(repoDisplayLabel('/ws/org/portal')).toBe('org/portal')
    expect(repoDisplayLabel('/home/dev/Workspace/org/api-gateway/')).toBe('org/api-gateway')
  })
  it('a repo directly under the root is just its name; Windows separators work', () => {
    expect(repoDisplayLabel('/www')).toBe('www')
    expect(repoDisplayLabel('C:\\Work\\org\\proj')).toBe('org/proj')
  })
  it('worktree blocks use the same label, so two repos both named www stay distinct in the dialog and the panel', () => {
    const a = wt('c1', 'ready', 1, { repo: '/ws/org-a/www' })
    const b = wt('c2', 'ready', 1, { repo: '/ws/org-b/www' })
    const m = buildGcModel(snap({ bundles: [a, b] }))
    expect(m.byId.get(a.item.id)!.repoLabel).toBe('org-a/www')
    expect(m.byId.get(b.item.id)!.repoLabel).toBe('org-b/www')
    const rows = dialogRows(m, [a.item.id, b.item.id])
    expect(rows.map((r) => r.repo)).toEqual(['org-a/www', 'org-b/www'])
  })

  it('regions carry both the short name (for aria and drill) and the display label', () => {
    const m = buildGcModel(sample())
    const www = m.regions.find((r) => r.label === 'www')!
    expect(www.displayLabel).toBe('proj/www')
    expect(www.repoPath).toBe('/ws/org/proj/www')
  })
})

describe('dialogBreakdown — what the whole clean does, in numbers', () => {
  it('counts stacks stopped, dependency folders removed and worktrees trashed', () => {
    const a = wt('c1', 'ready', 1, { stackIds: ['s1', 's2'], depsBytes: 5 })
    const b = wt('c2', 'ready', 1, { stackIds: ['s3'], depsBytes: null })
    const c = wt('c3', 'ready', 1, { depsBytes: 9 })
    const m = buildGcModel(snap({ bundles: [a, b, c] }))
    const rows = dialogRows(
      m,
      m.ready.map((x) => x.id)
    )
    expect(dialogBreakdown(rows)).toEqual({ stacks: 3, deps: 2, worktrees: 3, volumes: 0 })
  })

  it("counts a volume only when an orphan volume row is in the list — a worktree's volumes are kept", () => {
    const a = wt('c1', 'ready', 1, { ownedVolumes: ['v1', 'v2'] })
    const m = buildGcModel(snap({ bundles: [a], orphanVolumes: sample().orphanVolumes }))
    expect(dialogBreakdown(dialogRows(m, [a.item.id])).volumes).toBe(0)
    expect(dialogBreakdown(dialogRows(m, [a.item.id, 'volume:pg_data'])).volumes).toBe(1)
  })

  it('rows carry the stack count the breakdown sums', () => {
    const a = wt('c1', 'ready', 1, { stackIds: ['s1', 's2'] })
    const m = buildGcModel(snap({ bundles: [a] }))
    expect(dialogRows(m, [a.item.id])[0].stackCount).toBe(2)
  })
})

describe('expectedFor — the worktree path (S3 delta 3: GcExpected.path)', () => {
  it('sends bundle.item.path as-is for a worktree and null for an orphan volume', () => {
    const s = sample()
    const m = buildGcModel(s)
    const b = s.bundles[0]
    expect(expectedFor(m.byId.get(b.item.id)!).path).toBe(b.item.path)
    expect(expectedFor(m.byId.get(s.orphanVolumes[0].id)!).path).toBeNull()
  })

  it('a worktree moved on disk (same id, head and reason) counts as changed since the dialog opened', () => {
    const b = wt('c1', 'ready', 1)
    const first = buildGcModel(snap({ bundles: [b] }))
    const captured = captureConfirm(first, [b.item.id], 'ready')
    const moved = { ...b, item: { ...b.item, path: '/ws/org/proj/www-moved' } }
    expect(confirmChanged(buildGcModel(snap({ bundles: [moved] })), captured)).toBe(true)
  })

  it('a spelling difference of the same folder (slashes, dot segments) is not a change', () => {
    const b = wt('c1', 'ready', 1)
    const first = buildGcModel(snap({ bundles: [b] }))
    const captured = captureConfirm(first, [b.item.id], 'ready')
    const same = {
      ...b,
      item: { ...b.item, path: b.item.path.replace(/\/([^/]+)$/, '/./x/../$1') }
    }
    expect(confirmChanged(buildGcModel(snap({ bundles: [same] })), captured)).toBe(false)
  })
})

describe('detached worktrees — what gc:clean cannot remove is never sent', () => {
  function detached(name: string): ReturnType<typeof wt> {
    const b = wt(name, 'review', GIB, { reason: reason('detached') })
    b.item.kind = 'detached-worktree'
    b.item.branch = null
    b.item.id = `${b.item.repoPath}::detached-worktree::/ws/${name}`
    return b
  }

  it("isRemovable agrees with main's CLEANABLE_KINDS for every worktree kind", () => {
    const kinds: ReapItemKind[] = [
      'worktree',
      'detached-worktree',
      'hidden-folder',
      'local-branch',
      'remote-branch'
    ]
    for (const kind of kinds) {
      const b = wt('k', 'review', GIB)
      b.item.kind = kind
      const block = buildGcModel(snap({ bundles: [b] })).byId.get(b.item.id)!
      expect(isRemovable(block), kind).toBe(CLEANABLE_KINDS.includes(kind))
    }
  })

  it('a review request leaves out a detached worktree, which main refuses as unsupported-kind', () => {
    const h = detached('h1')
    const d = wt('d1', 'review', GIB, { reason: reason('dirty') })
    const s = snap({ bundles: [h, d] })
    const m = buildGcModel(s)
    expect(refusalFor(h, s.prefs, { confirmed: true })).toBe('unsupported-kind')
    const req = cleanRequestFor(m, [h.item.id, d.item.id], 'review')
    expect(req.ids).toEqual([d.item.id])
    expect(req.options.confirmed).toEqual([d.item.id])
    expect(Object.keys(req.options.expected)).toEqual([d.item.id])
    expect(unremovableIds(m, [h.item.id, d.item.id, 'ghost'])).toEqual([h.item.id])
  })

  it('a selection of detached worktrees only captures no dialog at all', () => {
    const m = buildGcModel(snap({ bundles: [detached('h1'), detached('h2')] }))
    expect(
      captureConfirm(
        m,
        m.review.map((b) => b.id),
        'review'
      )
    ).toBeNull()
  })

  it('orphan volumes stay removable', () => {
    const m = buildGcModel(sample())
    expect(isRemovable(m.byId.get('volume:pg_data')!)).toBe(true)
  })
})

describe('honest Remove: what main refuses is never offered, whatever the surface', () => {
  const lockedB = (name: string): ReturnType<typeof wt> =>
    wt(name, 'review', GIB, { reason: reason('locked'), locked: true })

  function mixedSnap(): {
    s: GcSnapshot
    ok: string
    locked: string
    shared: string
    open: string
  } {
    const ok = wt('ok', 'review', 2 * GIB, { reason: reason('dirty') })
    const locked = wt('locked', 'review', GIB, { reason: reason('locked'), locked: true })
    const shared = wt('shared', 'review', GIB, {
      reason: reason('shared-stack'),
      sharedStackIds: ['other']
    })
    const open = wt('open', 'review', GIB, {
      reason: reason('open-idle-session'),
      session: 'open-idle'
    })
    return {
      s: snap({ bundles: [ok, locked, shared, open] }),
      ok: ok.item.id,
      locked: locked.item.id,
      shared: shared.item.id,
      open: open.item.id
    }
  }

  it('a review request carries only what main takes, and confirms only those', () => {
    const { s, ok, locked, shared, open } = mixedSnap()
    const req = cleanRequestFor(buildGcModel(s), [ok, locked, shared, open], 'review')
    expect(req.ids).toEqual([ok])
    expect(req.options.confirmed).toEqual([ok])
    expect(Object.keys(req.options.expected)).toEqual([ok])
  })

  it('the captured confirm lists the refused ones apart, with the reason and the command to fix it', () => {
    const { s, ok, locked, shared, open } = mixedSnap()
    const c = captureConfirm(buildGcModel(s), [ok, locked, shared, open], 'review')!
    expect(c.ids).toEqual([ok])
    expect(c.rows.map((r) => r.id)).toEqual([ok])
    expect(c.refused.map((r) => [r.id, r.refusal])).toEqual([
      [locked, 'locked'],
      [shared, 'shared-stack'],
      [open, 'session-open']
    ])
    expect(c.refused[0].hint).toBe('git worktree unlock /ws/locked')
    // The refused group is not in the count the dialog shows, nor in the request.
    expect(dialogBreakdown(c.rows).worktrees).toBe(1)
    expect(c.request.ids).toEqual([ok])
  })

  it('no dialog opens when nothing is removable, but the reasons are still there to explain it', () => {
    const { s, locked, shared, open } = mixedSnap()
    const m = buildGcModel(s)
    expect(captureConfirm(m, [locked, shared, open], 'review')).toBeNull()
    expect(refusedRows(m, [locked, shared, open, 'ghost'], 'review').map((r) => r.refusal)).toEqual(
      ['locked', 'shared-stack', 'session-open']
    )
  })

  it('"Select all" in a repo ticks only what can be removed', () => {
    const { s, ok } = mixedSnap()
    const m = buildGcModel(s)
    expect(selectAllInRepo(m, '/ws/org/proj/www')).toEqual([ok])
  })

  it('an item that is refused can still be ticked one by one (to Keep or Dehydrate it)', () => {
    const { s, locked } = mixedSnap()
    const m = buildGcModel(s)
    expect(toggleChecked(m, new Set(), locked).has(locked)).toBe(true)
  })

  it('the hero counts only what a click can clean: not a refused item, not one main refused lately', () => {
    const fine = wt('c1', 'ready', 500 * MIB)
    const stuck = wt('c2', 'ready', 400 * MIB)
    stuck.reprobeRefusal = { code: 'cannot-unregister', count: 1 }
    const m = buildGcModel(snap({ bundles: [fine, stuck] }))
    expect(m.cleanable.map((b) => b.id)).toEqual([fine.item.id])
    expect(m.ready).toHaveLength(2) // the map and the list still show it as ready
    expect(heroState(m, null, true)).toMatchObject({ kind: 'clean', count: 1, bytes: 500 * MIB })
  })

  it('the hero is empty when every ready item was refused', () => {
    const stuck = wt('c2', 'ready', 400 * MIB)
    stuck.reprobeRefusal = { code: 'tip-unknown', count: 1 }
    expect(heroState(buildGcModel(snap({ bundles: [stuck] })), null, true)).toEqual({
      kind: 'empty'
    })
  })

  it('a ready request still carries the item the operator retries on purpose', () => {
    const stuck = wt('c2', 'ready', 400 * MIB)
    stuck.reprobeRefusal = { code: 'cannot-unregister', count: 1 }
    const m = buildGcModel(snap({ bundles: [stuck] }))
    expect(cleanRequestFor(m, [stuck.item.id], 'ready').ids).toEqual([stuck.item.id])
  })

  it('a locked item keeps removability reason "locked" while its failure says cannot-unregister', () => {
    const b = lockedB('l')
    const m = buildGcModel(snap({ bundles: [b] }))
    expect(removability(m.byId.get(b.item.id)!)).toMatchObject({ ok: false, reason: 'locked' })
  })
})

describe('a scan that could not see Docker: the hero says so instead of offering a clean main would refuse', () => {
  const blind = (name: string): ReturnType<typeof wt> => {
    const b = wt(name, 'ready', 400 * MIB)
    b.dockerBlind = true
    return b
  }

  it('leaves the blind ones out of what a click cleans', () => {
    const m = buildGcModel(snap({ bundles: [blind('a'), blind('b')] }))
    expect(m.cleanable).toEqual([])
    expect(m.ready).toHaveLength(2)
  })

  it('the hero is blocked, naming how many wait for Docker', () => {
    const m = buildGcModel(snap({ bundles: [blind('a'), blind('b')] }))
    expect(heroState(m, null, true)).toEqual({ kind: 'blind', count: 2, bytes: 800 * MIB })
  })

  it('a blocked hero never turns into a running one: a clean in flight still shows its chip', () => {
    const m = buildGcModel(snap({ bundles: [blind('a')] }))
    expect(heroState(m, { done: 1, total: 2, freedBytes: 5 }, true).kind).toBe('running')
  })

  it('stays empty when there is nothing ready at all', () => {
    expect(heroState(buildGcModel(snap()), null, true)).toEqual({ kind: 'empty' })
  })
})

describe('Keep and never-clean are read from the current prefs, not the scan-time flags', () => {
  const prefsWith = (over: Partial<ReturnType<typeof defaultGcPrefs>>): GcSnapshot['prefs'] => ({
    ...defaultGcPrefs(),
    ...over
  })

  it('a Keep mark added since the scan hides Remove at once', () => {
    const d = wt('d1', 'review', GIB, { reason: reason('dirty') })
    const m = buildGcModel(
      snap({ bundles: [d], prefs: prefsWith({ keep: { [d.item.id]: 'merged' as never } }) })
    )
    expect(removability(m.byId.get(d.item.id)!)).toEqual({ ok: false, reason: 'kept' })
    expect(cleanRequestFor(m, [d.item.id], 'review').ids).toEqual([])
    expect(selectAllInRepo(m, d.item.repoPath)).toEqual([])
  })

  it('a worktree path added to neverClean since the scan hides Remove at once', () => {
    const d = wt('d1', 'review', GIB, { reason: reason('dirty') })
    const m = buildGcModel(snap({ bundles: [d], prefs: prefsWith({ neverClean: ['/ws/d1/'] }) }))
    expect(removability(m.byId.get(d.item.id)!)).toEqual({ ok: false, reason: 'never-clean' })
  })

  it('so does the repo path, which covers every worktree of that repo', () => {
    const a = wt('a', 'ready', GIB)
    const m = buildGcModel(
      snap({ bundles: [a], prefs: prefsWith({ neverClean: [a.item.repoPath] }) })
    )
    expect(removability(m.byId.get(a.item.id)!)).toEqual({ ok: false, reason: 'never-clean' })
    expect(m.cleanable).toEqual([])
  })

  it('leaves everything else removable', () => {
    const d = wt('d1', 'review', GIB, { reason: reason('dirty') })
    const m = buildGcModel(
      snap({ bundles: [d], prefs: prefsWith({ neverClean: ['/elsewhere'], keep: {} }) })
    )
    expect(removability(m.byId.get(d.item.id)!)).toEqual({ ok: true })
  })
})
