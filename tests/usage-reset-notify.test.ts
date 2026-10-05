import { describe, it, expect } from 'vitest'
import {
  shouldNotifyUsageReset,
  USAGE_RESET_STALE_THRESHOLD_MS
} from '../src/renderer/src/stores/usage-reset-notify'

const NOW = 1_800_000_000_000 // arbitrary fixed epoch ms
const FIVE_HOURS_MS = 5 * 3600_000

describe('shouldNotifyUsageReset', () => {
  it('false when prevResetsAtMs is null (no baseline yet)', () => {
    expect(shouldNotifyUsageReset(NOW, null, NOW + 1000, null)).toBe(false)
  })

  it('false when prevResetsAtMs is undefined', () => {
    expect(shouldNotifyUsageReset(NOW, undefined, NOW + 1000, null)).toBe(false)
  })

  it('false when nextResetsAtMs is null (no current data)', () => {
    expect(shouldNotifyUsageReset(NOW, NOW - 1000, null, null)).toBe(false)
  })

  it('false when nextResetsAtMs is undefined', () => {
    expect(shouldNotifyUsageReset(NOW, NOW - 1000, undefined, null)).toBe(false)
  })

  it('false when the value has not changed (no supersession)', () => {
    expect(shouldNotifyUsageReset(NOW, NOW - 1000, NOW - 1000, null)).toBe(false)
  })

  it('false when the previous window had not actually expired yet', () => {
    expect(shouldNotifyUsageReset(NOW, NOW + 1000, NOW + 6000, null)).toBe(false)
  })

  it('true when a fresh future window supersedes an already-expired one', () => {
    expect(shouldNotifyUsageReset(NOW, NOW - 1000, NOW + FIVE_HOURS_MS, null)).toBe(true)
  })

  it('true even when the new value is also in the past (still a genuine change)', () => {
    expect(shouldNotifyUsageReset(NOW, NOW - 5000, NOW - 1000, null)).toBe(true)
  })

  it('false when this exact prevResetsAtMs was already notified (dedupe)', () => {
    expect(shouldNotifyUsageReset(NOW, NOW - 1000, NOW + FIVE_HOURS_MS, NOW - 1000)).toBe(false)
  })

  it('true for a different prevResetsAtMs even if an earlier one was notified', () => {
    expect(shouldNotifyUsageReset(NOW, NOW - 1000, NOW + FIVE_HOURS_MS, NOW - 5_000_000)).toBe(true)
  })

  it('false when the previous window expired exactly at the staleness threshold', () => {
    expect(
      shouldNotifyUsageReset(NOW, NOW - USAGE_RESET_STALE_THRESHOLD_MS, NOW + 1000, null)
    ).toBe(false)
  })

  it('false when the previous window expired well past the staleness threshold', () => {
    expect(
      shouldNotifyUsageReset(NOW, NOW - USAGE_RESET_STALE_THRESHOLD_MS - 60_000, NOW + 1000, null)
    ).toBe(false)
  })

  it('true just under the staleness threshold', () => {
    expect(
      shouldNotifyUsageReset(NOW, NOW - USAGE_RESET_STALE_THRESHOLD_MS + 1, NOW + 1000, null)
    ).toBe(true)
  })
})
