import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareIdentity,
  createParitySink,
  hashId,
  type ParityInput
} from '../../src/main/companion/identity-parity-core'

const DIR = join(import.meta.dirname, '..', 'fixtures', 'companion-parity', 'identity')

interface FixtureLine extends ParityInput {
  name: string
  expect: string
}

const fixtures: FixtureLine[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.ndjson'))
  .sort()
  .flatMap((f) =>
    readFileSync(join(DIR, f), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as FixtureLine & { v?: number })
      // P1W4's persisted-ledger traces share this folder; their rows carry `v` and no `expect`
      .filter((l) => l.v === undefined)
  )

describe('identity comparator (IP)', () => {
  it('identity comparator', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8)
    for (const f of fixtures) {
      const rec = compareIdentity(f, 1_790_000_000_000)
      expect(rec.verdict, f.name).toBe(f.expect)
    }
  })

  it('the four verdicts of the plan, spelled out', () => {
    const c = { key: 'S1', sid: 'R1', helloAfterSpawnMs: 700 }
    const l = (key: string) => ({ key, sid: 'R1', via: 'collapse' as const, afterSpawnMs: 2000 })
    const at = 1
    expect(compareIdentity({ shape: 'new', companion: c, legacy: l('S1') }, at).verdict).toBe(
      'match'
    )
    expect(compareIdentity({ shape: 'new', companion: c, legacy: l('S2') }, at).verdict).toBe(
      'mismatch'
    )
    expect(compareIdentity({ shape: 'new', companion: c, legacy: null }, at).verdict).toBe(
      'companion-only'
    )
    expect(compareIdentity({ shape: 'new', companion: null, legacy: l('S1') }, at).verdict).toBe(
      'legacy-only'
    )
  })

  it('records are scrubbed (QA-9)', () => {
    const rec = compareIdentity(
      {
        shape: 'new',
        companion: {
          key: 'synthetic-0b9c1f3e-aaaa-4bbb-8ccc-123456789abc',
          sid: '11111111-1111-4111-8111-111111111111',
          helloAfterSpawnMs: 640
        },
        legacy: {
          key: 'synthetic-0b9c1f3e-aaaa-4bbb-8ccc-123456789abc',
          sid: '11111111-1111-4111-8111-111111111111',
          via: 'collapse',
          afterSpawnMs: 2000
        }
      },
      5
    )
    const text = JSON.stringify(rec)
    expect(text).not.toContain('11111111')
    expect(text).not.toContain('synthetic-')
    expect(text).not.toMatch(/\//) // no path of any kind
    expect(rec.companion?.sidHash).toBe(hashId('11111111-1111-4111-8111-111111111111'))
    expect(rec.companion?.sidHash).toMatch(/^[0-9a-f]{12}$/)
    expect(rec.legacy?.keyHash).toBe(rec.companion?.keyHash) // equal ids hash equal: comparable
    // every committed fixture also compares into a scrubbed record
    for (const f of fixtures) {
      const out = JSON.stringify(compareIdentity(f, 1))
      for (const raw of [f.companion?.key, f.companion?.sid, f.legacy?.key, f.legacy?.sid]) {
        if (raw) expect(out).not.toContain(`"${raw}"`)
      }
    }
  })

  it('the sink keeps the newest 500 and counts every verdict', () => {
    const sink = createParitySink(500)
    for (let i = 0; i < 503; i++) {
      sink.add(
        compareIdentity(
          {
            shape: 'new',
            companion: { key: `k${i}`, sid: `s${i}`, helloAfterSpawnMs: 1 },
            legacy: null
          },
          i
        )
      )
    }
    expect(sink.list()).toHaveLength(500)
    expect(sink.list()[0]?.at).toBe(3)
    expect(sink.summary()).toMatchObject({ total: 503, byVerdict: { 'companion-only': 503 } })
  })
})
