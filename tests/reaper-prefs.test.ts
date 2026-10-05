import { describe, it, expect } from 'vitest'
import { defaultPrefs, normalizePrefs } from '../src/main/reaper/prefs'

describe('defaultPrefs', () => {
  it('ships the documented defaults', () => {
    expect(defaultPrefs()).toEqual({
      version: 1,
      autoScan: true,
      intervalMs: 3_600_000,
      neverDeleteRemote: false,
      protectedBranches: ['main', 'master', 'develop'],
      minAgeDays: 0,
      notifyOnHarvestable: true,
      dehydrateIdleDays: 7
    })
  })
})

describe('normalizePrefs — dehydrate defaults (T250)', () => {
  it('clamps dehydrateIdleDays to [0, 365] and rounds it', () => {
    expect(normalizePrefs({ dehydrateIdleDays: -3 }).dehydrateIdleDays).toBe(0)
    expect(normalizePrefs({ dehydrateIdleDays: 9999 }).dehydrateIdleDays).toBe(365)
    expect(normalizePrefs({ dehydrateIdleDays: 13.6 }).dehydrateIdleDays).toBe(14)
    expect(normalizePrefs({ dehydrateIdleDays: 0 }).dehydrateIdleDays).toBe(0)
  })

  it('falls back to the default on a wrong type — a pref file written before T250 keeps working', () => {
    expect(normalizePrefs({ dehydrateIdleDays: 'soon' }).dehydrateIdleDays).toBe(7)
    expect(normalizePrefs({ dehydrateIdleDays: Number.NaN }).dehydrateIdleDays).toBe(7)
    expect(normalizePrefs({ autoScan: false }).dehydrateIdleDays).toBe(7)
  })
})

describe('normalizePrefs', () => {
  it('returns defaults for junk input', () => {
    expect(normalizePrefs(null)).toEqual(defaultPrefs())
    expect(normalizePrefs(undefined)).toEqual(defaultPrefs())
    expect(normalizePrefs('not an object')).toEqual(defaultPrefs())
    expect(normalizePrefs(42)).toEqual(defaultPrefs())
    expect(normalizePrefs([])).toEqual(defaultPrefs())
  })

  it('fills in missing keys with defaults', () => {
    expect(normalizePrefs({})).toEqual(defaultPrefs())
    expect(normalizePrefs({ autoScan: false })).toEqual({ ...defaultPrefs(), autoScan: false })
  })

  it('clamps intervalMs to [30m, 24h]', () => {
    expect(normalizePrefs({ intervalMs: 1 }).intervalMs).toBe(1_800_000)
    expect(normalizePrefs({ intervalMs: 0 }).intervalMs).toBe(1_800_000)
    expect(normalizePrefs({ intervalMs: -5000 }).intervalMs).toBe(1_800_000)
    expect(normalizePrefs({ intervalMs: 999_999_999 }).intervalMs).toBe(86_400_000)
    expect(normalizePrefs({ intervalMs: 7_200_000 }).intervalMs).toBe(7_200_000)
  })

  it('falls back to the default interval on a non-finite/non-number value', () => {
    expect(normalizePrefs({ intervalMs: Number.NaN }).intervalMs).toBe(3_600_000)
    expect(normalizePrefs({ intervalMs: 'soon' }).intervalMs).toBe(3_600_000)
    expect(normalizePrefs({ intervalMs: null }).intervalMs).toBe(3_600_000)
  })

  it('coerces booleans, ignoring wrong types', () => {
    expect(normalizePrefs({ autoScan: 'yes' }).autoScan).toBe(true)
    expect(normalizePrefs({ neverDeleteRemote: 1 }).neverDeleteRemote).toBe(false)
    expect(normalizePrefs({ notifyOnHarvestable: 0 }).notifyOnHarvestable).toBe(true)
  })

  it('filters protectedBranches to non-empty strings, defaulting on a non-array', () => {
    expect(
      normalizePrefs({ protectedBranches: ['main', '', 42, '  ', 'release'] }).protectedBranches
    ).toEqual(['main', 'release'])
    expect(normalizePrefs({ protectedBranches: 'main' }).protectedBranches).toEqual([
      'main',
      'master',
      'develop'
    ])
    expect(normalizePrefs({ protectedBranches: [] }).protectedBranches).toEqual([])
  })

  it('clamps minAgeDays to a non-negative integer', () => {
    expect(normalizePrefs({ minAgeDays: -3 }).minAgeDays).toBe(0)
    expect(normalizePrefs({ minAgeDays: 2.7 }).minAgeDays).toBe(3)
    expect(normalizePrefs({ minAgeDays: 'never' }).minAgeDays).toBe(0)
  })

  it('always stamps version 1 regardless of input', () => {
    expect(normalizePrefs({ version: 99 }).version).toBe(1)
  })
})
