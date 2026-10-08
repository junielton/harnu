import { describe, it, expect } from 'vitest'
import {
  defaultGcPrefs,
  mergeIncomingPrefs,
  normalizeGcPrefs,
  withAcknowledged,
  withKeep,
  withoutKeep,
  type GcPrefs
} from '../src/main/gc/gc-prefs'

const HOUR = 3_600_000

describe('defaultGcPrefs', () => {
  it('ships the operator-approved defaults', () => {
    expect(defaultGcPrefs()).toEqual({
      version: 1,
      autopilot: false,
      firstReportAcknowledged: false,
      intervalMs: HOUR,
      graceDays: 2,
      maxItemsPerCycle: 20,
      categories: { worktrees: true, dockerCache: true },
      cacheMaxAgeDays: 7,
      neverClean: [],
      keep: {}
    })
  })

  it('returns a fresh object each call', () => {
    const a = defaultGcPrefs()
    a.neverClean.push('/x')
    a.categories.volumes = false
    expect(defaultGcPrefs().neverClean).toEqual([])
    expect(defaultGcPrefs().categories.volumes).toBe(true)
  })
})

describe('normalizeGcPrefs: junk input', () => {
  it.each([null, undefined, 42, 'prefs', true, [], [1, 2]])(
    'falls back to defaults for %j',
    (raw) => {
      expect(normalizeGcPrefs(raw)).toEqual(defaultGcPrefs())
    }
  )

  it('ignores wrong-typed fields one by one', () => {
    const out = normalizeGcPrefs({
      autopilot: 'yes',
      firstReportAcknowledged: 1,
      graceDays: '5',
      maxItemsPerCycle: null,
      categories: 'all',
      cacheMaxAgeDays: {},
      neverClean: 'nope',
      keep: ['a']
    })
    expect(out).toEqual(defaultGcPrefs())
  })

  it('keeps valid fields next to broken ones', () => {
    const out = normalizeGcPrefs({ autopilot: true, graceDays: 'x', cacheMaxAgeDays: 3 })
    expect(out.autopilot).toBe(true)
    expect(out.cacheMaxAgeDays).toBe(3)
    expect(out.graceDays).toBe(2)
  })

  it('drops keys it does not know', () => {
    const out = normalizeGcPrefs({ autopilot: true, surprise: 1 }) as unknown as Record<
      string,
      unknown
    >
    expect('surprise' in out).toBe(false)
  })

  it('reads categories field by field', () => {
    const out = normalizeGcPrefs({ categories: { worktrees: false, dockerCache: 'x' } })
    expect(out.categories).toEqual({ worktrees: false, dockerCache: true })
  })

  it('keeps only non-empty string paths in neverClean, without duplicates', () => {
    const out = normalizeGcPrefs({ neverClean: ['/a', '', 3, '/a', null, '/b', '  '] })
    expect(out.neverClean).toEqual(['/a', '/b'])
  })

  it('keeps only string → string entries in keep', () => {
    const out = normalizeGcPrefs({ keep: { 'repo::worktree::/a': 'merged', bad: 3, '': 'x' } })
    expect(out.keep).toEqual({ 'repo::worktree::/a': 'merged' })
  })
})

describe('normalizeGcPrefs: clamps', () => {
  it.each([
    [-3, 0],
    [0, 0],
    [4.6, 5],
    [30, 30],
    [31, 30],
    [9999, 30]
  ])('graceDays %j → %j', (given, want) => {
    expect(normalizeGcPrefs({ graceDays: given }).graceDays).toBe(want)
  })

  it.each([
    [0, 1],
    [-5, 1],
    [1, 1],
    [20.4, 20],
    [200, 200],
    [201, 200],
    [100000, 200]
  ])('maxItemsPerCycle %j → %j', (given, want) => {
    expect(normalizeGcPrefs({ maxItemsPerCycle: given }).maxItemsPerCycle).toBe(want)
  })

  it.each([
    [0, 1],
    [-5, 1],
    [1, 1],
    [7, 7],
    [90, 90],
    [365, 365],
    [366, 365],
    [9999, 365]
  ])('cacheMaxAgeDays %j → %j', (given, want) => {
    expect(normalizeGcPrefs({ cacheMaxAgeDays: given }).cacheMaxAgeDays).toBe(want)
  })

  it.each([NaN, Infinity, -Infinity])('non-finite numbers fall back (%j)', (bad) => {
    const out = normalizeGcPrefs({
      graceDays: bad,
      maxItemsPerCycle: bad,
      cacheMaxAgeDays: bad,
      intervalMs: bad
    })
    expect(out).toEqual(defaultGcPrefs())
  })

  it.each([
    [1000, 1_800_000],
    [1_800_000, 1_800_000],
    [2 * HOUR, 2 * HOUR],
    [90_000_000, 86_400_000]
  ])('intervalMs %j → %j', (given, want) => {
    expect(normalizeGcPrefs({ intervalMs: given }).intervalMs).toBe(want)
  })
})

describe('normalizeGcPrefs: migration from the Reaper and Containers prefs', () => {
  it('takes intervalMs from the Reaper prefs when no stored value exists', () => {
    const out = normalizeGcPrefs(null, { reaper: { intervalMs: 2 * HOUR } })
    expect(out.intervalMs).toBe(2 * HOUR)
  })

  it('falls back to the Containers interval when the Reaper has none', () => {
    const out = normalizeGcPrefs(null, { containers: { intervalMs: 4 * HOUR } })
    expect(out.intervalMs).toBe(4 * HOUR)
  })

  it('prefers the Reaper interval over the Containers one', () => {
    const out = normalizeGcPrefs(null, {
      reaper: { intervalMs: 2 * HOUR },
      containers: { intervalMs: 4 * HOUR }
    })
    expect(out.intervalMs).toBe(2 * HOUR)
  })

  it('carries the Containers idle threshold over as the grace window', () => {
    const out = normalizeGcPrefs(null, { containers: { zombieAfterDays: 5 } })
    expect(out.graceDays).toBe(5)
  })

  it('clamps migrated values like stored ones', () => {
    const out = normalizeGcPrefs(null, {
      reaper: { intervalMs: 5 },
      containers: { zombieAfterDays: 400 }
    })
    expect(out.intervalMs).toBe(1_800_000)
    expect(out.graceDays).toBe(30)
  })

  it('lets a stored value win over the legacy one, field by field', () => {
    const out = normalizeGcPrefs(
      { intervalMs: 3 * HOUR },
      { reaper: { intervalMs: 2 * HOUR }, containers: { zombieAfterDays: 6 } }
    )
    expect(out.intervalMs).toBe(3 * HOUR)
    expect(out.graceDays).toBe(6)
  })

  it('never turns the autopilot on by migration', () => {
    const out = normalizeGcPrefs(null, {
      reaper: { autoScan: true, intervalMs: HOUR },
      containers: { autoScan: true, zombieAfterDays: 3 }
    })
    expect(out.autopilot).toBe(false)
    expect(out.firstReportAcknowledged).toBe(false)
  })

  it('survives junk legacy input', () => {
    expect(normalizeGcPrefs(null, { reaper: 'x', containers: [1] })).toEqual(defaultGcPrefs())
  })
})

describe('prefs reducers behind the IPC channels', () => {
  const base = (): GcPrefs => ({
    ...defaultGcPrefs(),
    autopilot: true,
    firstReportAcknowledged: true,
    keep: { a: 'merged' }
  })

  it('a whole-object write never changes keep or the acknowledgement', () => {
    const out = mergeIncomingPrefs(base(), {
      autopilot: false,
      graceDays: 9,
      keep: { b: 'open' },
      firstReportAcknowledged: false
    })
    expect(out.autopilot).toBe(false)
    expect(out.graceDays).toBe(9)
    expect(out.keep).toEqual({ a: 'merged' })
    expect(out.firstReportAcknowledged).toBe(true)
  })

  it('cannot acknowledge the first report through a write', () => {
    const fresh = { ...defaultGcPrefs(), autopilot: true }
    expect(
      mergeIncomingPrefs(fresh, { firstReportAcknowledged: true }).firstReportAcknowledged
    ).toBe(false)
  })

  it('normalizes what a write brings', () => {
    expect(mergeIncomingPrefs(base(), { cacheMaxAgeDays: 99999 }).cacheMaxAgeDays).toBe(365)
  })

  it('withKeep / withoutKeep add and drop one mark without touching the rest', () => {
    const kept = withKeep(base(), 'b', 'closed-unmerged')
    expect(kept.keep).toEqual({ a: 'merged', b: 'closed-unmerged' })
    expect(withoutKeep(kept, ['a']).keep).toEqual({ b: 'closed-unmerged' })
    expect(base().keep).toEqual({ a: 'merged' })
  })

  it('withoutKeep ignores an id that is not marked', () => {
    expect(withoutKeep(base(), ['zzz']).keep).toEqual({ a: 'merged' })
  })

  it('withAcknowledged sets the flag and nothing else', () => {
    const out = withAcknowledged({ ...defaultGcPrefs(), autopilot: true })
    expect(out.firstReportAcknowledged).toBe(true)
    expect(out.autopilot).toBe(true)
  })
})

describe('worktree cleanup never removes volumes: the old keys are gone (D1)', () => {
  it('has neither removeVolumes nor categories.volumes', () => {
    const out = normalizeGcPrefs(null) as unknown as Record<string, unknown>
    expect('removeVolumes' in out).toBe(false)
    expect('volumes' in (out.categories as object)).toBe(false)
  })

  it('drops both old keys from a stored file, whatever their values', () => {
    const stored = {
      autopilot: true,
      removeVolumes: true,
      categories: { worktrees: true, volumes: true, dockerCache: false }
    }
    const out = normalizeGcPrefs(stored) as unknown as Record<string, unknown>
    expect(out.autopilot).toBe(true)
    expect('removeVolumes' in out).toBe(false)
    expect(out.categories).toEqual({ worktrees: true, dockerCache: false })
  })

  it('does not write them back', () => {
    const merged = mergeIncomingPrefs(defaultGcPrefs(), {
      removeVolumes: true,
      categories: { volumes: true }
    })
    expect(JSON.stringify(merged)).not.toMatch(/removeVolumes|"volumes"/)
  })
})
