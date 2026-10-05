import { describe, it, expect } from 'vitest'
import { defaultPrefs, normalizePrefs } from '../src/main/pr-stack-prefs'

describe('pr-stack prefs', () => {
  it('defaults to refreshing every 90s while the canvas is open', () => {
    expect(defaultPrefs()).toEqual({
      version: 1,
      autoRefresh: true,
      intervalMs: 90_000,
      showLabels: false,
      openPrLinksInCanvas: false
    })
  })

  it('keeps a valid stored value', () => {
    expect(
      normalizePrefs({
        version: 1,
        autoRefresh: false,
        intervalMs: 300_000,
        showLabels: true,
        openPrLinksInCanvas: true
      })
    ).toEqual({
      version: 1,
      autoRefresh: false,
      intervalMs: 300_000,
      showLabels: true,
      openPrLinksInCanvas: true
    })
  })

  it('clamps an interval nobody should be allowed to set', () => {
    // Faster than a gh round-trip is worth, and slower than "live" means anything.
    expect(normalizePrefs({ intervalMs: 100 }).intervalMs).toBe(15_000)
    expect(normalizePrefs({ intervalMs: 99_999_999 }).intervalMs).toBe(600_000)
  })

  it('falls back rather than throwing on junk, so a corrupt file still opens the canvas', () => {
    for (const junk of [null, undefined, 'nope', 42, [], { intervalMs: 'soon' }]) {
      expect(normalizePrefs(junk)).toEqual(defaultPrefs())
    }
  })

  it('rounds a fractional interval instead of passing it to setInterval', () => {
    expect(normalizePrefs({ intervalMs: 90_000.7 }).intervalMs).toBe(90_001)
  })

  it('accepts a partial object, filling the rest from defaults', () => {
    expect(normalizePrefs({ autoRefresh: false })).toEqual({
      version: 1,
      autoRefresh: false,
      intervalMs: 90_000,
      showLabels: false,
      openPrLinksInCanvas: false
    })
  })
})

describe('pr-stack prefs — showLabels (T278)', () => {
  it('is off by default: labels are repo-dependent noise until the operator opts in', () => {
    expect(defaultPrefs().showLabels).toBe(false)
  })

  it('keeps labels off for a prefs file written before the toggle existed', () => {
    // An upgrade must not surprise anyone with a new chip row.
    expect(normalizePrefs({ version: 1, autoRefresh: true, intervalMs: 90_000 }).showLabels).toBe(
      false
    )
  })

  it('persists the opt-in, and the opt-out, through a round-trip', () => {
    const on = normalizePrefs(JSON.parse(JSON.stringify({ ...defaultPrefs(), showLabels: true })))
    expect(on.showLabels).toBe(true)
    const off = normalizePrefs(JSON.parse(JSON.stringify({ ...on, showLabels: false })))
    expect(off.showLabels).toBe(false)
  })

  it('opts in only on a real boolean — a truthy string from a hand-edited file is ignored', () => {
    for (const junk of ['true', 1, 'yes', {}, null]) {
      expect(normalizePrefs({ showLabels: junk }).showLabels).toBe(false)
    }
  })

  it('does not let the label toggle disturb the refresh prefs beside it', () => {
    expect(normalizePrefs({ showLabels: true })).toEqual({ ...defaultPrefs(), showLabels: true })
  })
})

describe('pr-stack prefs — openPrLinksInCanvas', () => {
  it('is off by default: every click costs a gh round-trip, so it is opt-in', () => {
    expect(defaultPrefs().openPrLinksInCanvas).toBe(false)
  })

  it('stays off for a prefs file written before the toggle existed', () => {
    expect(normalizePrefs({ version: 1, autoRefresh: true, intervalMs: 90_000 })).toEqual(
      defaultPrefs()
    )
  })

  it('opts in only on a real boolean — a truthy string from a hand-edited file is ignored', () => {
    for (const junk of ['true', 1, 'yes', {}, null]) {
      expect(normalizePrefs({ openPrLinksInCanvas: junk }).openPrLinksInCanvas).toBe(false)
    }
    expect(normalizePrefs({ openPrLinksInCanvas: true }).openPrLinksInCanvas).toBe(true)
  })

  it('does not disturb the other prefs beside it', () => {
    expect(normalizePrefs({ openPrLinksInCanvas: true })).toEqual({
      ...defaultPrefs(),
      openPrLinksInCanvas: true
    })
  })
})
