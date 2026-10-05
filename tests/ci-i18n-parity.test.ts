import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { flattenKeys, parityVerdict } from '../scripts/ci/i18n-parity-core.mjs'

/**
 * The i18n parity gate (T65 AC2). en.json and pt-BR.json must carry the exact
 * same set of deep-flattened leaf paths (`a.b.c`) — the same invariant the
 * vue-tsc `MessageSchema = typeof en` build enforces, but reported by name and
 * by file in seconds instead of as a cryptic type error.
 *
 * RED CASE — the verify job runs `node scripts/ci/i18n-parity.mjs`; with a key
 * dropped from pt-BR.json it prints, exit code 1:
 *
 *   ✗ i18n parity failed — locale key sets differ
 *     Missing in src/renderer/src/i18n/pt-BR.json — present in en.json: 1
 *       - app.name
 *   Every key must exist in BOTH files (the MessageSchema = typeof en parity the vue-tsc build enforces).
 */
describe('flattenKeys', () => {
  it('flattens nested objects to full dotted leaf paths', () => {
    const keys = flattenKeys({ a: { b: { c: 'x' }, d: 'y' }, e: 'z' })
    expect(keys.sort()).toEqual(['a.b.c', 'a.d', 'e'])
  })

  it('descends arrays by numeric index', () => {
    expect(flattenKeys({ list: ['one', 'two'] }).sort()).toEqual(['list.0', 'list.1'])
  })

  it('keeps a plural string (vue-i18n `a | b`) as a single leaf path', () => {
    expect(flattenKeys({ items: 'no items | one item | {n} items' })).toEqual(['items'])
  })
})

describe('parityVerdict', () => {
  it('is ok when both locales carry the exact same keys', () => {
    const en = { app: { name: 'Harnu', tagline: 'x' } }
    const pt = { app: { name: 'Harnu', tagline: 'y' } }
    expect(parityVerdict(en, pt).ok).toBe(true)
  })

  it('reports a key present in en.json but missing from pt-BR.json', () => {
    const en = { app: { name: 'Harnu', tagline: 'x' } }
    const pt = { app: { name: 'Harnu' } }
    const v = parityVerdict(en, pt)
    expect(v.ok).toBe(false)
    expect(v.missingInPt).toEqual(['app.tagline'])
    expect(v.missingInEn).toEqual([])
  })

  it('reports a key present in pt-BR.json but missing from en.json', () => {
    const en = { app: { name: 'Harnu' } }
    const pt = { app: { name: 'Harnu', extra: 'sobra' } }
    const v = parityVerdict(en, pt)
    expect(v.ok).toBe(false)
    expect(v.missingInEn).toEqual(['app.extra'])
    expect(v.missingInPt).toEqual([])
  })

  it('sorts the missing-key lists for stable output', () => {
    const en = { z: '1', a: '2', m: '3' }
    const pt = {}
    expect(parityVerdict(en, pt).missingInPt).toEqual(['a', 'm', 'z'])
  })
})

describe('the shipped locale files', () => {
  // A living guard: the real en.json / pt-BR.json must already be at parity, so
  // this doubles as proof the gate is green today (and catches any future drift
  // in the unit run, not just in CI).
  it('en.json and pt-BR.json are at full key parity', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const i18n = join(here, '..', 'src/renderer/src/i18n')
    const en = JSON.parse(readFileSync(join(i18n, 'en.json'), 'utf8'))
    const pt = JSON.parse(readFileSync(join(i18n, 'pt-BR.json'), 'utf8'))
    const v = parityVerdict(en, pt)
    expect({ missingInPt: v.missingInPt, missingInEn: v.missingInEn }).toEqual({
      missingInPt: [],
      missingInEn: []
    })
  })
})
