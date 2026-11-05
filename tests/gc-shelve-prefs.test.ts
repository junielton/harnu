import { describe, expect, it } from 'vitest'
import {
  defaultGcPrefs,
  mergeIncomingPrefs,
  normalizeGcPrefs,
  withAcknowledged,
  withShelveAcknowledged,
  withShelveDisabled,
  type GcPrefs
} from '../src/main/gc/gc-prefs'

const on = (over: Partial<GcPrefs['shelve']> = {}): GcPrefs => {
  const p = defaultGcPrefs()
  return { ...p, shelve: { ...p.shelve, enabled: true, ...over } }
}

describe('shelve prefs (AC-1)', () => {
  it('ships ON (design C1), unacknowledged, with the spec defaults', () => {
    expect(defaultGcPrefs().shelve).toEqual({
      enabled: true,
      firstReportAcknowledged: false,
      thresholdDays: 3,
      maxPerCycle: 3,
      failureLimit: 3
    })
  })

  it('reads an old prefs file with no shelve key as the defaults', () => {
    const old = { version: 1, autopilot: true, firstReportAcknowledged: true }
    expect(normalizeGcPrefs(old).shelve).toEqual(defaultGcPrefs().shelve)
  })

  it('a prefs file that never set the switch reads ON, and still cannot shelve before the acknowledgement', () => {
    const old = {
      version: 1,
      autopilot: true,
      firstReportAcknowledged: true,
      shelve: { thresholdDays: 5 }
    }
    const read = normalizeGcPrefs(old).shelve
    expect(read.enabled).toBe(true)
    expect(read.firstReportAcknowledged).toBe(false)
    expect(read.thresholdDays).toBe(5)
  })

  it('a prefs file that explicitly turned it off keeps it off', () => {
    expect(normalizeGcPrefs({ shelve: { enabled: false } }).shelve.enabled).toBe(false)
    const written = JSON.parse(JSON.stringify(withShelveDisabled(defaultGcPrefs())))
    expect(normalizeGcPrefs(written).shelve.enabled).toBe(false)
  })

  it('a missing or corrupt file reads the defaults: ON, report-only', () => {
    for (const junk of [null, undefined, 'junk', 42, []]) {
      const p = normalizeGcPrefs(junk)
      expect(p.shelve.enabled).toBe(true)
      expect(p.shelve.firstReportAcknowledged).toBe(false)
    }
  })

  it('clamps junk and out-of-range values', () => {
    const p = normalizeGcPrefs({
      shelve: { enabled: 'yes', thresholdDays: 0, maxPerCycle: 999, failureLimit: -4 }
    })
    expect(p.shelve).toEqual({
      enabled: true, // 'yes' is not a boolean: the default (ON) stands
      firstReportAcknowledged: false,
      thresholdDays: 1,
      maxPerCycle: 20,
      failureLimit: 1
    })
    expect(normalizeGcPrefs({ shelve: { thresholdDays: 9999 } }).shelve.thresholdDays).toBe(365)
    expect(normalizeGcPrefs({ shelve: 'junk' }).shelve).toEqual(defaultGcPrefs().shelve)
  })

  it('is independent of the autopilot switch and its acknowledgement', () => {
    const base = defaultGcPrefs()
    const acked = withAcknowledged({ ...base, autopilot: true })
    expect(acked.shelve).toEqual(base.shelve)
    const shelved = withShelveAcknowledged(on())
    expect(shelved.shelve.firstReportAcknowledged).toBe(true)
    expect(shelved.firstReportAcknowledged).toBe(false)
    expect(shelved.autopilot).toBe(false)
  })

  it('turning shelving on starts a new promise: the acknowledgement is taken away', () => {
    const current = withShelveAcknowledged(on())
    const off = mergeIncomingPrefs(
      { ...current, shelve: { ...current.shelve, enabled: false } },
      {}
    )
    const next = mergeIncomingPrefs(off, { shelve: { enabled: true } })
    expect(next.shelve.enabled).toBe(true)
    expect(next.shelve.firstReportAcknowledged).toBe(false)
  })

  it('a settings write can never acknowledge the shelve report', () => {
    const current = on()
    const next = mergeIncomingPrefs(current, { shelve: { firstReportAcknowledged: true } })
    expect(next.shelve.firstReportAcknowledged).toBe(false)
  })

  it('keeps an acknowledgement that a write did not touch', () => {
    const current = withShelveAcknowledged(on())
    const next = mergeIncomingPrefs(current, { shelve: { thresholdDays: 5 } })
    expect(next.shelve).toEqual({ ...current.shelve, thresholdDays: 5 })
  })

  it('a partial write changes only what it names, even when it also names autopilot', () => {
    const current = on({ thresholdDays: 7, maxPerCycle: 2 })
    const next = mergeIncomingPrefs(current, { autopilot: true, shelve: { failureLimit: 5 } })
    expect(next.shelve).toEqual({ ...current.shelve, failureLimit: 5 })
    expect(next.autopilot).toBe(true)
  })

  it('an invalid incoming shelve value falls back to the current one, not the default', () => {
    const current = on({ thresholdDays: 7 })
    const next = mergeIncomingPrefs(current, { shelve: { thresholdDays: 'soon' } })
    expect(next.shelve.thresholdDays).toBe(7)
  })

  it('the kill switch turns shelving off and keeps everything else', () => {
    const current = withShelveAcknowledged(on({ thresholdDays: 4 }))
    const off = withShelveDisabled(current)
    expect(off.shelve).toEqual({ ...current.shelve, enabled: false })
  })
})
