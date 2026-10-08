import { describe, it, expect } from 'vitest'
import { reactive, ref, isReactive } from 'vue'
import { toIpc } from '../src/renderer/src/lib/to-ipc'

describe('toIpc', () => {
  it('turns a deep reactive object into plain data a structured clone accepts', () => {
    const state = ref({
      ids: ['a'],
      options: { expected: { a: { stackIds: ['s'], bytes: null } } }
    })
    expect(() => structuredClone(state.value)).toThrow() // the bug: a Proxy is not cloneable
    const plain = toIpc(state.value)
    expect(structuredClone(plain)).toEqual(plain)
    expect(plain).toEqual({
      ids: ['a'],
      options: { expected: { a: { stackIds: ['s'], bytes: null } } }
    })
  })

  it('unwraps nested reactive values under a plain spread', () => {
    const prefs = ref({ autopilot: false, categories: { dockerCache: true }, keep: ['x'] })
    const spread = { ...prefs.value, autopilot: true }
    expect(isReactive(spread.categories)).toBe(true) // a shallow spread leaves these reactive
    const plain = toIpc(spread)
    expect(isReactive(plain.categories)).toBe(false)
    expect(isReactive(plain.keep)).toBe(false)
    expect(() => structuredClone(plain)).not.toThrow()
  })

  it('passes primitives, null and arrays of them through', () => {
    expect(toIpc(null)).toBeNull()
    expect(toIpc(3)).toBe(3)
    expect(toIpc('s')).toBe('s')
    expect(toIpc(reactive(['a', 'b']))).toEqual(['a', 'b'])
  })
})
