/**
 * T460 batch 0 — the expected-deltas schema and the §3.3 catalog beside the route table.
 *
 * `dialog-baseline.mjs diff --expected <file>` trusts these documents, and nothing else reads the
 * catalog, so a typo in it (an unknown key, a missing reason) would only surface in the middle of
 * the first migration batch. This validates the catalog against the schema file with a small
 * JSON-Schema subset walker (no ajv dependency in the repo), cross-checks the driver's own
 * validator against the same schema, and pins that the wildcard placeholders are marked as such.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALLOWED_KEYS,
  PLACEHOLDER_PROPERTIES,
  validateDeltas
} from '../scripts/dev/dialog-routes/deltas.mjs'

const DIR = join(__dirname, '..', 'scripts', 'dev', 'dialog-routes')
interface Delta {
  dialog: string
  property: string
  reason: string
}
interface JsonSchema {
  type?: string
  const?: unknown
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean
  items?: JsonSchema
  description?: string
}
const load = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T

const schema = load<JsonSchema>('expected-deltas.schema.json')
const catalog = load<{ batch: string; deltas: Delta[] }>('expected-deltas.catalog.json')

/** The subset of JSON Schema the schema file uses: type, const, required, properties, additionalProperties:false, items. */
function check(value: unknown, s: JsonSchema, at: string): string[] {
  const errs: string[] = []
  if ('const' in s && value !== s.const) errs.push(`${at}: must be ${JSON.stringify(s.const)}`)
  const t = s.type
  const isObj = typeof value === 'object' && value !== null && !Array.isArray(value)
  if (t === 'object' && !isObj) return [`${at}: must be an object`]
  if (t === 'array' && !Array.isArray(value)) return [`${at}: must be an array`]
  if (t === 'string' && typeof value !== 'string') return [`${at}: must be a string`]
  if (t === 'integer' && !Number.isInteger(value)) return [`${at}: must be an integer`]
  if (isObj && t === 'object') {
    const o = value as Record<string, unknown>
    for (const k of s.required ?? []) if (!(k in o)) errs.push(`${at}: missing "${k}"`)
    for (const [k, v] of Object.entries(o)) {
      if (s.properties?.[k]) errs.push(...check(v, s.properties[k], `${at}.${k}`))
      else if (s.additionalProperties === false) errs.push(`${at}: unknown key "${k}"`)
    }
  }
  if (Array.isArray(value) && s.items) {
    value.forEach((v, i) => errs.push(...check(v, s.items, `${at}[${i}]`)))
  }
  return errs
}

describe('expected-deltas schema + catalog', () => {
  it('the catalog validates against the schema file', () => {
    expect(check(catalog, schema, '$')).toEqual([])
  })

  it('the driver validator accepts the catalog and agrees with the schema on the allowed keys', () => {
    expect(() => validateDeltas(catalog)).not.toThrow()
    expect([...ALLOWED_KEYS].sort()).toEqual(
      Object.keys(schema.properties!.deltas.items!.properties!).sort()
    )
  })

  it('the catalog is non-trivial: every entry names a dialog, a property and a spec reason', () => {
    expect(catalog.deltas.length).toBeGreaterThan(10)
    for (const d of catalog.deltas) expect(d.reason, JSON.stringify(d)).toMatch(/§3\.3|PLACEHOLDER/)
  })

  it('EVERY entry with `dialog: "*"` is marked PLACEHOLDER, and no narrowed entry is', () => {
    for (const d of catalog.deltas) {
      if (d.dialog === '*') expect(d.reason, `${d.property} ${d.reason}`).toMatch(/^PLACEHOLDER/)
      else expect(d.reason, `${d.dialog} ${d.property}`).not.toMatch(/^PLACEHOLDER/)
    }
  })

  it('the five wildcard properties are all present and all wildcard-dialog entries', () => {
    const wild = catalog.deltas.filter((d) => PLACEHOLDER_PROPERTIES.includes(d.property))
    expect(wild.map((d) => d.property).sort()).toEqual([...PLACEHOLDER_PROPERTIES].sort())
    for (const d of wild) expect(d.dialog, d.property).toBe('*')
  })

  it('concrete width / radius values on `*` are placeholders too (copied wholesale they allow any dialog)', () => {
    const concrete = catalog.deltas.filter(
      (d) => d.dialog === '*' && /^card\.style\.(width|border-top-left-radius)$/.test(d.property)
    )
    expect(concrete.length).toBeGreaterThanOrEqual(5)
    for (const d of concrete) expect(d.reason).toMatch(/^PLACEHOLDER/)
  })

  it('the schema and the catalog header both say placeholders must be narrowed', () => {
    expect(schema.description).toMatch(/MUST narrow/)
    expect(catalog.batch).toMatch(/Narrow `dialog`/)
    expect(catalog.batch).toMatch(/EVERY entry/)
  })

  describe('the validator can fail', () => {
    const ok = { dialog: 'X', property: 'card.style.width', reason: 'r' }
    it('rejects a missing reason', () => {
      expect(() =>
        validateDeltas({ version: 1, deltas: [{ dialog: 'X', property: 'p' }] })
      ).toThrow(/required/)
      expect(
        check({ version: 1, deltas: [{ dialog: 'X', property: 'p' }] }, schema, '$')
      ).not.toEqual([])
    })
    it('rejects an unknown key', () => {
      const bad = { version: 1, deltas: [{ ...ok, extra: 1 }] }
      expect(() => validateDeltas(bad)).toThrow(/unknown key/)
      expect(check(bad, schema, '$')).not.toEqual([])
    })
    it('rejects a wrong version and a non-integer height', () => {
      expect(() => validateDeltas({ version: 2, deltas: [] })).toThrow()
      expect(() => validateDeltas({ version: 1, deltas: [{ ...ok, height: '560' }] })).toThrow()
      expect(check({ version: 1, deltas: [{ ...ok, height: '560' }] }, schema, '$')).not.toEqual([])
    })
    it('accepts a minimal document', () => {
      expect(() => validateDeltas({ version: 1, deltas: [ok] })).not.toThrow()
      expect(check({ version: 1, deltas: [ok] }, schema, '$')).toEqual([])
    })
  })
})
