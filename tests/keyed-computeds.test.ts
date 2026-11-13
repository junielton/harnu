import { describe, expect, it } from 'vitest'
import { computed, reactive, ref } from 'vue'
import { createKeyedComputeds } from '../src/renderer/src/lib/keyed-computeds'

describe('createKeyedComputeds (BUG-265)', () => {
  it('recomputes only the key whose inputs changed', () => {
    const rows = reactive<Record<string, { n: number }>>({ a: { n: 1 }, b: { n: 10 } })
    const runs: string[] = []
    const cache = createKeyedComputeds<number>((id) => {
      runs.push(id)
      return rows[id].n * 2
    })

    expect(cache.get('a')).toBe(2)
    expect(cache.get('b')).toBe(20)
    runs.length = 0

    rows.a.n = 5
    expect(cache.get('a')).toBe(10)
    expect(cache.get('b')).toBe(20)
    expect(runs).toEqual(['a'])
  })

  it('does not wake a dependent when the recomputed value is unchanged', () => {
    const rows = reactive<Record<string, { n: number }>>({ a: { n: 1 } })
    const cache = createKeyedComputeds<boolean>((id) => rows[id].n > 0)
    let aggregates = 0
    const sum = computed(() => {
      aggregates++
      return cache.get('a')
    })

    expect(sum.value).toBe(true)
    rows.a.n = 2 // the verdict is still true
    expect(sum.value).toBe(true)
    expect(aggregates).toBe(1)
  })

  it('keeps one computed per key, and prune drops the keys that left', () => {
    const calls = ref(0)
    const cache = createKeyedComputeds<number>(() => ++calls.value)

    cache.get('a')
    cache.get('b')
    expect(cache.size).toBe(2)

    cache.prune(new Set(['a']))
    expect(cache.size).toBe(1)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
  })
})
