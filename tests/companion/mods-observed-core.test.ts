/**
 * T389 P4W1 part B: the pure half of the live observation (spec §7.6). A host-side validation of
 * `mod.admitted` (the mod's payload is untrusted input) and the in-memory store that keeps the
 * last observation per (binding, root) and the order of arrival.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_MODS_PER_BINDING,
  createObservationStore,
  parseAdmission
} from '../../src/main/companion/mods-observed-core'

const ADMITTED = {
  name: 'token-chart',
  tier: 'user',
  root: '/work/mods/token-chart',
  version: '0.3.1',
  provenance: 'token-chart@inline',
  uses: {
    events: ['prompt.submit'],
    calls: ['http.fetch'],
    env: { reads: ['HOME'], writes: [] },
    state: { reads: [{ plugin: 'token-chart', key: 'seen' }], writes: [] }
  }
}

describe('parseAdmission', () => {
  it('keeps the fields of contract §8 and nothing else', () => {
    const d = parseAdmission({ ...ADMITTED, extra: 'x', uses: { ...ADMITTED.uses, more: 1 } })
    expect(d).toEqual(ADMITTED)
  })

  it('refuses a payload that is not an admission', () => {
    expect(parseAdmission(null)).toBeNull()
    expect(parseAdmission('x')).toBeNull()
    expect(parseAdmission({ ...ADMITTED, name: '' })).toBeNull()
    expect(parseAdmission({ ...ADMITTED, tier: 'core' })).toBeNull()
    expect(parseAdmission({ ...ADMITTED, uses: null })).toBeNull()
    expect(parseAdmission({ ...ADMITTED, uses: { ...ADMITTED.uses, events: 'nope' } })).toBeNull()
  })

  it('bounds every list and string, never throwing', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `e.${i}`)
    const d = parseAdmission({
      ...ADMITTED,
      name: 'n'.repeat(5000),
      uses: { ...ADMITTED.uses, events: many }
    })
    expect(d).toBeNull() // an over-long name is not a name
    const ok = parseAdmission({ ...ADMITTED, uses: { ...ADMITTED.uses, events: many } })
    expect(ok?.uses.events.length).toBe(100)
  })
})

describe('observation store', () => {
  it('keeps the last observation per (binding, root) and numbers arrivals', () => {
    const s = createObservationStore()
    s.record(1, ADMITTED, 10)
    s.record(1, { ...ADMITTED, name: 'second', root: '/work/mods/second' }, 20)
    s.record(1, { ...ADMITTED, version: '0.4.0' }, 30) // the same root again: replaced, newest
    const mods = s.mods(1)
    expect(mods.map((m) => m.name)).toEqual(['second', 'token-chart'])
    expect(mods[1]).toMatchObject({ version: '0.4.0', at: 30 })
    expect(mods.map((m) => m.order)).toEqual([1, 2])
  })

  it('drops one binding without touching another', () => {
    const s = createObservationStore()
    s.record(1, ADMITTED, 1)
    s.record(2, ADMITTED, 1)
    s.drop(1)
    expect(s.mods(1)).toEqual([])
    expect(s.mods(2).length).toBe(1)
    s.dropAll()
    expect(s.bindings()).toEqual([])
  })

  it('stops growing at MAX_MODS_PER_BINDING', () => {
    const s = createObservationStore()
    for (let i = 0; i < MAX_MODS_PER_BINDING + 20; i++) {
      s.record(1, { ...ADMITTED, name: `m${i}`, root: `/r/${i}` }, i)
    }
    expect(s.mods(1).length).toBe(MAX_MODS_PER_BINDING)
  })

  it('ignores a payload that is not an admission', () => {
    const s = createObservationStore()
    expect(s.record(1, { nope: true }, 1)).toBe(false)
    expect(s.bindings()).toEqual([])
  })
})
