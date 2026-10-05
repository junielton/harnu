import { describe, it, expect } from 'vitest'
import {
  displayPath,
  durationParts,
  formatDisk,
  formatRam,
  hasQuickStop,
  keptVolumesOf,
  meterLegend,
  meterSegments,
  recentVerbKey,
  resolveSelection,
  isSweepable,
  stopProgress,
  stoppedByHarnu,
  sweepPlan,
  sweepProgress,
  sweepTargets,
  tiersFor,
  tombstoneKey,
  zombieInDays
} from '../src/renderer/src/components/containers-format'
import {
  BULK_TOMB,
  DAY,
  REMOVE_TOMB,
  STOP_TOMB,
  snapshotOf,
  specStacks,
  stack
} from './helpers/containers-fixtures'
import type { ContainersTombstone, ContainersVerdict } from '../src/preload'

/**
 * T331 — the Containers takeover's presentation rules, pinned without a mount.
 * `tiersFor` IS PRD §3.4 as the UI offers it (design.md "Tiers" table).
 */

const VOL = [{ name: 'v', sizeBytes: 1, shared: false }]

function tiers(verdict: ContainersVerdict, running: boolean, volumes = VOL): string[] {
  return tiersFor({ verdict, running, volumes }).map(
    (t) =>
      `${t.action}:${t.variant}${t.disabled ? ':disabled' : ''}:${t.caption}${t.force ? ':force' : ''}`
  )
}

describe('AC-3/AC-4: what each verdict offers (PRD §3.4)', () => {
  it('running zombie: primary Stop + Remove disabled with "Stop it first"', () => {
    expect(tiers('zombie', true)).toEqual([
      'stop:primary:reversible',
      'remove:danger:disabled:stopFirst'
    ])
  })

  it('stopped zombie: Start + an enabled Remove that asks first', () => {
    expect(tiers('zombie', false)).toEqual(['start:default:backAsItWas', 'remove:danger:asksFirst'])
  })

  it('stopped orphan: only Remove — Start is refused on an orphan (WORKTREE_GONE)', () => {
    expect(tiers('orphan', false)).toEqual(['remove:danger:asksFirst'])
  })

  it('running orphan: Stop, and Remove disabled until it is stopped', () => {
    expect(tiers('orphan', true)).toEqual([
      'stop:primary:reversible',
      'remove:danger:disabled:stopFirst'
    ])
  })

  it('active: a neutral Stop with the warning caption, sent with force', () => {
    expect(tiers('active', true)).toEqual(['stop:default:appGoesDown:force'])
    expect(tiersFor({ verdict: 'active', running: true, volumes: [] })[0]?.captionTone).toBe('warn')
  })

  it('protected: a neutral Stop sent with force, never Remove', () => {
    expect(tiers('protected', true)).toEqual(['stop:default:reversible:force'])
  })

  it('pending (provisional AC-12): manual Stop without force, no Remove', () => {
    expect(tiers('pending', true)).toEqual(['stop:default:reversible'])
    expect(tiers('pending', false)).toEqual(['start:default:backAsItWas'])
  })

  it('unknown: no actions at all', () => {
    expect(tiers('unknown', true)).toEqual([])
    expect(tiers('unknown', false)).toEqual([])
  })

  it('Remove never appears enabled on a running stack, whatever the verdict', () => {
    const verdicts: ContainersVerdict[] = [
      'zombie',
      'orphan',
      'active',
      'protected',
      'pending',
      'unknown'
    ]
    for (const v of verdicts) {
      const remove = tiersFor({ verdict: v, running: true, volumes: VOL }).find(
        (t) => t.action === 'remove'
      )
      if (remove) expect(remove.disabled, v).toBe(true)
    }
  })

  it('a stack with no removable volume drops the volume half of the caption', () => {
    expect(tiers('zombie', false, [{ name: 'shared', sizeBytes: 1, shared: true }])).toEqual([
      'start:default:backAsItWas',
      'remove:danger:asksFirstNoVolume'
    ])
  })

  it('the hover quick-stop is for running "Needs you" rows only', () => {
    expect(hasQuickStop({ verdict: 'zombie', running: true })).toBe(true)
    expect(hasQuickStop({ verdict: 'orphan', running: true })).toBe(true)
    expect(hasQuickStop({ verdict: 'zombie', running: false })).toBe(false)
    for (const v of ['active', 'protected', 'pending', 'unknown'] as const) {
      expect(hasQuickStop({ verdict: v, running: true }), v).toBe(false)
    }
  })
})

describe('sizes, durations and paths', () => {
  it('formats RAM and disk the way the spec prints them', () => {
    expect(formatRam(831_000_000)).toBe('831 MB')
    expect(formatRam(1_700_000_000)).toBe('1.7 GB')
    expect(formatRam(0)).toBe('0 B')
    expect(formatDisk(249_200_000)).toBe('249.2 MB')
    expect(formatDisk(36_000_000)).toBe('36.0 MB')
    expect(formatDisk(1_400_000_000)).toBe('1.4 GB')
  })

  it('rounds durations down to one whole unit', () => {
    expect(durationParts(2 * DAY + 5)).toEqual({ unit: 'days', n: 2 })
    expect(durationParts(5 * 3_600_000)).toEqual({ unit: 'hours', n: 5 })
    expect(durationParts(4 * 60_000)).toEqual({ unit: 'minutes', n: 4 })
    expect(durationParts(1000)).toEqual({ unit: 'minutes', n: 1 })
  })

  it('pending chips never read "zombie in 0d"', () => {
    expect(zombieInDays(DAY + 1)).toBe(2)
    expect(zombieInDays(10)).toBe(1)
    expect(zombieInDays(null)).toBe(1)
  })

  it('shortens a home directory to ~', () => {
    expect(displayPath('/home/dev/Workspace/org/proj/www')).toBe('~/Workspace/org/proj/www')
    expect(displayPath('/Users/dev/code')).toBe('~/code')
    expect(displayPath('/srv/app')).toBe('/srv/app')
  })
})

describe('the meter', () => {
  it('draws one segment per running stack with RAM, colored by verdict', () => {
    const segs = meterSegments(specStacks())
    expect(segs.map((s) => [s.id, s.tone])).toEqual([
      ['proj-82', 'zombie'],
      ['proj-71', 'active'],
      ['proj-20', 'muted'],
      ['proj-44', 'muted'],
      ['postgres-scratch', 'unknown']
    ])
    const total = segs.reduce((s, x) => s + x.pct, 0)
    expect(total).toBeGreaterThan(99)
    expect(total).toBeLessThan(101)
  })

  it('lists only non-empty legend buckets; zombie covers zombie + orphan', () => {
    const legend = meterLegend({
      zombie: 100,
      orphan: 50,
      active: 0,
      protected: 7,
      pending: 0,
      unknown: 3
    })
    expect(legend).toEqual([
      { key: 'zombie', tone: 'zombie', bytes: 150 },
      { key: 'protected', tone: 'muted', bytes: 7 },
      { key: 'unknown', tone: 'unknown', bytes: 3 }
    ])
  })
})

describe('progress, Recent and selection', () => {
  it('"Stopping… N of M" counts baseline containers the latest scan reports down', () => {
    expect(
      stopProgress(
        ['a', 'b', 'c', 'd'],
        [
          { id: 'a', running: false },
          { id: 'b', running: true },
          { id: 'c', running: true },
          { id: 'd', running: false }
        ]
      )
    ).toEqual({ done: 2, total: 4 })
  })

  it('a stack Harnu stopped reads "stopped"; one that exited on its own does not', () => {
    const recent = [STOP_TOMB]
    expect(stoppedByHarnu({ id: 'proj-54', running: false }, recent)).toBe(true)
    expect(stoppedByHarnu({ id: 'proj-11', running: false }, recent)).toBe(false)
    expect(stoppedByHarnu({ id: 'proj-54', running: true }, recent)).toBe(false)
  })

  it('an older stop tombstone does not outrank a later start for the same stack', () => {
    // recent is newest first: Harnu stopped proj-54 a day ago (STOP_TOMB), then
    // started it again more recently. A later external `docker stop` (no
    // tombstone) must read "—", not "stopped" — the stack's last Harnu action
    // was a start, not a stop.
    const startAfterStop: ContainersTombstone = {
      at: STOP_TOMB.at + 1000,
      actor: 'operator',
      verb: 'start',
      stacks: [
        {
          stack: 'proj-54',
          name: 'proj-54',
          path: STOP_TOMB.stacks[0]!.path,
          containerIds: STOP_TOMB.stacks[0]!.containerIds,
          freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 }
        }
      ],
      restoreHint: null
    }
    const recent = [startAfterStop, STOP_TOMB]
    expect(stoppedByHarnu({ id: 'proj-54', running: false }, recent)).toBe(false)
  })

  it("names the Recent verb, including a removal's volume fate when it is known", () => {
    expect(recentVerbKey(STOP_TOMB)).toBe('stopped')
    expect(recentVerbKey(REMOVE_TOMB)).toBe('removedVolumeKept')
    const legacy = {
      ...REMOVE_TOMB,
      stacks: [
        {
          ...REMOVE_TOMB.stacks[0]!,
          keptVolumes: undefined,
          keptVolumeBytes: undefined
        }
      ]
    }
    expect(recentVerbKey(legacy), 'a journal line from before keptVolumes existed').toBe('removed')
    const removedVol = {
      ...REMOVE_TOMB,
      stacks: [
        {
          ...REMOVE_TOMB.stacks[0]!,
          freed: { ramBytes: 0, ports: [], volumes: ['v'], volumeBytes: 1 }
        }
      ]
    }
    expect(recentVerbKey(removedVol)).toBe('removedVolumeRemoved')
  })

  it('reads kept volumes from the tombstone, with a size only when a stack kept one', () => {
    expect(keptVolumesOf(REMOVE_TOMB)).toEqual([{ name: 'proj-19_mysql', sizeBytes: 233_500_000 }])
    const two = {
      ...REMOVE_TOMB,
      stacks: [{ ...REMOVE_TOMB.stacks[0]!, keptVolumes: ['a', 'b'], keptVolumeBytes: 30 }]
    }
    expect(keptVolumesOf(two)).toEqual([
      { name: 'a', sizeBytes: null },
      { name: 'b', sizeBytes: null }
    ])
    expect(keptVolumesOf(STOP_TOMB)).toEqual([])
  })

  it('keeps a selection across rescans, and falls back to the first "Needs you" row', () => {
    const snap = snapshotOf(specStacks(), [STOP_TOMB, BULK_TOMB])
    expect(resolveSelection(null, snap)).toEqual({ kind: 'stack', id: 'proj-82' })
    expect(resolveSelection({ kind: 'stack', id: 'proj-20' }, snap)).toEqual({
      kind: 'stack',
      id: 'proj-20'
    })
    const key = tombstoneKey(BULK_TOMB)
    expect(resolveSelection({ kind: 'recent', key }, snap)).toEqual({ kind: 'recent', key })
    expect(resolveSelection({ kind: 'stack', id: 'gone' }, snap)).toEqual({
      kind: 'stack',
      id: 'proj-82'
    })
  })

  it('selects nothing while docker is unavailable', () => {
    expect(
      resolveSelection(null, {
        scannedAt: 1,
        dockerAvailable: false,
        dockerError: 'docker CLI not found on PATH',
        zombieAfterDays: 2,
        recent: []
      })
    ).toBeNull()
  })

  it('with no "Needs you" stack, selects the first row of all', () => {
    const snap = snapshotOf([stack({ id: 'proj-20', verdict: 'protected' })])
    expect(resolveSelection(null, snap)).toEqual({ kind: 'stack', id: 'proj-20' })
  })
})

describe('T341: the sweep', () => {
  const VERDICTS: ContainersVerdict[] = [
    'zombie',
    'orphan',
    'active',
    'protected',
    'pending',
    'unknown'
  ]

  it('is eligible for exactly the "Needs you" verdicts, running or exited', () => {
    const eligible = VERDICTS.filter((verdict) => isSweepable({ verdict }))
    expect(eligible).toEqual(['zombie', 'orphan'])
    // Running never changes the answer: a sweep stops a stack before removing it.
    expect(isSweepable({ verdict: 'zombie' })).toBe(true)
  })

  it('targets every zombie and orphan in snapshot order', () => {
    expect(sweepTargets(specStacks()).map((s) => s.id)).toEqual(['proj-82', 'proj-11', 'proj-27'])
  })

  it('totals the containers and the volumes across the whole sweep', () => {
    const plan = sweepPlan(specStacks())
    expect(plan.stacks).toEqual([
      { id: 'proj-82', name: 'proj-82', containers: 2 },
      { id: 'proj-11', name: 'proj-11', containers: 1 },
      { id: 'proj-27', name: 'proj-27', containers: 1 }
    ])
    expect(plan.containers).toBe(4)
    expect(plan.volumes).toEqual(['proj-82_mysql', 'proj-11_mysql', 'proj-27_mysql'])
    expect(plan.volumeBytes).toBe(249_200_000 + 212_100_000 + 657_900_000)
    expect(plan.keptVolumes).toEqual([])
  })

  it('counts a volume once however many swept stacks mount it', () => {
    const both = { name: 'both', sizeBytes: 50_000_000, shared: true }
    const plan = sweepPlan([
      stack({ id: 'z-1', verdict: 'zombie', volumes: [both] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [both] })
    ])
    expect(plan.volumes).toEqual(['both'])
    expect(plan.volumeBytes).toBe(50_000_000)
  })

  it('keeps a shared volume whose only owner is swept — it belongs to another project', () => {
    const other = { name: 'other-project', sizeBytes: 9, shared: true }
    const plan = sweepPlan([stack({ id: 'z-1', verdict: 'zombie', volumes: [other] })])
    expect(plan.volumes).toEqual([])
    expect(plan.keptVolumes).toEqual(['other-project'])
    expect(plan.volumeBytes).toBe(0)
  })

  it('keeps a shared volume a stack outside the sweep still mounts', () => {
    const shared = { name: 'shared', sizeBytes: 9, shared: true }
    const plan = sweepPlan([
      stack({ id: 'z-1', verdict: 'zombie', volumes: [shared] }),
      stack({ id: 'a-1', verdict: 'active', volumes: [shared] })
    ])
    expect(plan.volumes).toEqual([])
    expect(plan.keptVolumes).toEqual(['shared'])
    expect(plan.volumeBytes).toBe(0)
  })

  it('reports an unknown total when any swept volume has no size', () => {
    const plan = sweepPlan([
      stack({
        id: 'z-1',
        verdict: 'zombie',
        volumes: [
          { name: 'a', sizeBytes: 10, shared: false },
          { name: 'b', sizeBytes: null, shared: false }
        ]
      })
    ])
    expect(plan.volumes).toEqual(['a', 'b'])
    expect(plan.volumeBytes).toBeNull()
  })

  it('counts progress by the targets the latest scan no longer reports', () => {
    const targets = ['proj-82', 'proj-11', 'proj-27']
    expect(
      sweepProgress(targets, [{ id: 'proj-82' }, { id: 'proj-11' }, { id: 'proj-27' }])
    ).toEqual({ done: 0, total: 3 })
    expect(sweepProgress(targets, [{ id: 'proj-27' }])).toEqual({ done: 2, total: 3 })
    expect(sweepProgress(targets, [])).toEqual({ done: 3, total: 3 })
  })

  it('reads a sweep tombstone as a removal, so Recent needs no new wording', () => {
    const tomb: ContainersTombstone = {
      ...BULK_TOMB,
      verb: 'sweep',
      stacks: BULK_TOMB.stacks.map((s) => ({ ...s, keptVolumes: ['v'], keptVolumeBytes: 10 }))
    }
    expect(recentVerbKey(tomb)).toBe('removedVolumeKept')
    expect(recentVerbKey({ ...tomb, stacks: BULK_TOMB.stacks })).toBe('removed')
  })
})
