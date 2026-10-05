import { describe, it, expect } from 'vitest'

/**
 * Drift safety valve for the Claude config catalog (issue #16, spec §11): a
 * catalog control must never *hide* on-disk keys it doesn't cover. The danger is
 * NESTED catalog paths — `permissions.defaultMode` covers one field of the
 * `permissions` object, but siblings like `permissions.allow`/`deny`/`ask` have
 * no control. If the whole `permissions` key were treated as "known," those
 * siblings would vanish from the UI ("lost setting"). They must keep surfacing
 * read-only in the Advanced/raw block. These pin that contract.
 */

import {
  SETTINGS_CATALOG,
  knownTopLevelKeys,
  catalogPaths,
  getAtPath,
  type SettingDef
} from '../src/renderer/src/components/claude-config-catalog'

describe('knownTopLevelKeys', () => {
  it('excludes top-level catalog entries (whole-object coverage)', () => {
    const known = knownTopLevelKeys()
    // `model`, `tui`, `cleanupPeriodDays`, `includeCoAuthoredBy` are top-level.
    expect(known.has('model')).toBe(true)
    expect(known.has('tui')).toBe(true)
  })

  it('does NOT exclude a top-level key that only a nested entry covers', () => {
    // `permissions.defaultMode` is the only `permissions.*` entry — siblings like
    // `permissions.allow` must stay visible, so `permissions` is NOT "known".
    expect(SETTINGS_CATALOG.some((d) => d.path.startsWith('permissions.'))).toBe(true)
    expect(knownTopLevelKeys().has('permissions')).toBe(false)
  })

  it('always excludes the Harnu-managed subtrees', () => {
    const known = knownTopLevelKeys()
    for (const k of [
      'hooks',
      'statusLine',
      'statusLine_harnu',
      'statusLine_capy',
      'statusLine_om2tab'
    ]) {
      expect(known.has(k)).toBe(true)
    }
  })
})

describe('catalogPaths', () => {
  it('returns the full dot-paths the catalog controls', () => {
    const paths = catalogPaths()
    expect(paths.has('permissions.defaultMode')).toBe(true)
    expect(paths.has('model')).toBe(true)
    // not a real catalog path
    expect(paths.has('permissions.allow')).toBe(false)
  })
})

describe('option values track the current Claude Code schema (BUG-16)', () => {
  /** Values the CC validator rejects today — the catalog must never offer them
   *  (issue BUG-16: the `tui` select wrote `"inline"`, which `/doctor` flagged). */
  const found = (path: string): SettingDef => {
    const def = SETTINGS_CATALOG.find((d) => d.path === path)
    if (!def) throw new Error(`no catalog entry for ${path}`)
    return def
  }
  const values = (path: string): string[] => (found(path).options ?? []).map((o) => o.value)

  it('tui offers exactly default|fullscreen (no legacy "inline")', () => {
    expect(values('tui')).toEqual(['default', 'fullscreen'])
    expect(found('tui').default).toBe('default')
  })

  it('permissions.defaultMode is default|acceptEdits|plan|dontAsk (no legacy "bypassPermissions")', () => {
    expect(new Set(values('permissions.defaultMode'))).toEqual(
      new Set(['default', 'acceptEdits', 'plan', 'dontAsk'])
    )
  })

  it('cleanupPeriodDays lower bound is a positive integer (0 is rejected by CC)', () => {
    expect(found('cleanupPeriodDays').min).toBe(1)
  })
})

describe('getAtPath', () => {
  it('reads nested dot-paths', () => {
    expect(getAtPath({ permissions: { defaultMode: 'plan' } }, 'permissions.defaultMode')).toBe(
      'plan'
    )
  })
  it('returns undefined for absent / non-object intermediates', () => {
    expect(getAtPath({ a: 1 }, 'a.b')).toBeUndefined()
    expect(getAtPath({}, 'missing')).toBeUndefined()
    expect(getAtPath({ arr: [1, 2] }, 'arr.0')).toBeUndefined()
  })
})
