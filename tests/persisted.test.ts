import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { persistedRef, persistedSet } from '../src/renderer/src/stores/persisted'

/**
 * T24 — the `localStorage`-mirrored reactive primitives that replace ~30
 * hand-rolled `try { localStorage… } catch {}` blocks across six stores. Pure
 * (node env): `localStorage` is stubbed with `vi.stubGlobal` (the harness from
 * `settings-store.test.ts`). `persistedRef` auto-persists via a Vue `watch`
 * (async — `await nextTick()` to flush); `persistedSet` persists synchronously
 * inside each mutator, so its writes are observable immediately.
 */

function makeLocalStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
}

/** A `localStorage` whose `setItem` throws (quota / private mode) — reads still work. */
function makeThrowingLocalStorage(initial: Record<string, string> = {}): Storage {
  const base = makeLocalStorage(initial)
  return {
    ...base,
    getItem: base.getItem.bind(base),
    setItem: () => {
      throw new Error('QuotaExceededError')
    }
  } as Storage
}

describe('persistedRef', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
  })

  it('falls back to the default when the key is missing', () => {
    expect(persistedRef('k.missing', 'def').value).toBe('def')
  })

  it('reads a stored string value verbatim (string default → identity codec)', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 'k.s': 'stored' }))
    expect(persistedRef('k.s', 'def').value).toBe('stored')
  })

  it('falls back to the default on corrupt JSON for a non-string default', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 'k.obj': '{not json' }))
    expect(persistedRef('k.obj', { a: 1 }).value).toEqual({ a: 1 })
  })

  it('falls back to the default when validate rejects the parsed value', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 'k.enum': 'bogus' }))
    const r = persistedRef('k.enum', 'recent', {
      validate: (v) => v === 'recent' || v === 'name'
    })
    expect(r.value).toBe('recent')
  })

  it('keeps a stored value that passes validate', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 'k.enum': 'name' }))
    const r = persistedRef('k.enum', 'recent', {
      validate: (v) => v === 'recent' || v === 'name'
    })
    expect(r.value).toBe('name')
  })

  it('auto-persists on change and round-trips through a fresh ref', async () => {
    const r = persistedRef('k.rt', 'a')
    r.value = 'b'
    await nextTick()
    expect(localStorage.getItem('k.rt')).toBe('b')
    // A fresh ref on the same key reads the persisted value.
    expect(persistedRef('k.rt', 'a').value).toBe('b')
  })

  it('does NOT write the default on init (absent key stays absent until first change)', () => {
    persistedRef('k.lazy', 'def')
    expect(localStorage.getItem('k.lazy')).toBeNull()
  })

  it('swallows a throwing setItem (private mode) — ref stays authoritative in memory', async () => {
    vi.stubGlobal('localStorage', makeThrowingLocalStorage())
    const r = persistedRef('k.throw', 'a')
    r.value = 'b'
    await expect(nextTick()).resolves.toBeUndefined()
    expect(r.value).toBe('b')
  })

  it('round-trips a number via serialize:String / deserialize:Number', async () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 'k.num': '268' }))
    const r = persistedRef('k.num', 100, {
      serialize: String,
      deserialize: Number,
      validate: (n) => Number.isFinite(n)
    })
    expect(r.value).toBe(268)
    r.value = 300
    await nextTick()
    expect(localStorage.getItem('k.num')).toBe('300')
  })

  it('handles the inverted default-ON boolean case (absent → true, "false" → false)', () => {
    const codec = { serialize: String, deserialize: (raw: string) => raw !== 'false' }
    // Absent → default true.
    expect(persistedRef('k.notify', true, codec).value).toBe(true)
    // Explicit 'false' → false.
    vi.stubGlobal('localStorage', makeLocalStorage({ 'k.notify': 'false' }))
    expect(persistedRef('k.notify', true, codec).value).toBe(false)
    // Anything else → true.
    vi.stubGlobal('localStorage', makeLocalStorage({ 'k.notify': 'true' }))
    expect(persistedRef('k.notify', true, codec).value).toBe(true)
  })
})

describe('persistedSet', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
  })

  it('is empty when the key is missing', () => {
    expect([...persistedSet('s.missing').set.value]).toEqual([])
  })

  it('loads a JSON array, keeping only strings', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 's.mix': '["a",2,null,"b",true]' }))
    expect([...persistedSet('s.mix').set.value].sort()).toEqual(['a', 'b'])
  })

  it('rewrites stored entries through `migrate` on load (upgrading a key format)', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 's.mig': '["/repos/a/.git","repo:/b/.git"]' }))
    const s = persistedSet('s.mig', {
      migrate: (x) => (x.includes(':') ? x : `repo:${x}`)
    })
    expect([...s.set.value].sort()).toEqual(['repo:/b/.git', 'repo:/repos/a/.git'])
  })

  it('applies an element-level validate on load', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 's.zones': '["active","bogus","pinned"]' }))
    const isZone = (x: string): x is 'active' | 'pinned' => x === 'active' || x === 'pinned'
    expect([...persistedSet('s.zones', { validate: isZone }).set.value].sort()).toEqual([
      'active',
      'pinned'
    ])
  })

  it('degrades to an empty set on corrupt JSON', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 's.bad': '{nope' }))
    expect([...persistedSet('s.bad').set.value]).toEqual([])
  })

  it('add/delete/toggle mutate membership and persist synchronously', () => {
    const s = persistedSet('s.rt')
    s.add('x')
    expect(s.has('x')).toBe(true)
    expect(localStorage.getItem('s.rt')).toBe('["x"]')

    s.toggle('y')
    expect(s.has('y')).toBe(true)
    s.toggle('y')
    expect(s.has('y')).toBe(false)

    s.delete('x')
    expect(s.has('x')).toBe(false)
    expect(localStorage.getItem('s.rt')).toBe('[]')

    // A fresh handle on the same key reads the persisted membership.
    persistedSet('s.rt2')
    vi.stubGlobal('localStorage', makeLocalStorage({ 's.rt2': '["kept"]' }))
    expect(persistedSet('s.rt2').has('kept')).toBe(true)
  })

  it('reassigns the Set identity on every mutation (pins reactivity/002)', () => {
    const s = persistedSet('s.identity')
    const before = s.set.value
    s.add('a')
    expect(s.set.value).not.toBe(before) // a computed/watch would fire
    const afterAdd = s.set.value
    s.delete('a')
    expect(s.set.value).not.toBe(afterAdd)
    const afterDelete = s.set.value
    s.toggle('b')
    expect(s.set.value).not.toBe(afterDelete)
  })

  it('clear empties the set and persists', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 's.clear': '["a","b"]' }))
    const s = persistedSet('s.clear')
    expect(s.set.value.size).toBe(2)
    s.clear()
    expect(s.set.value.size).toBe(0)
    expect(localStorage.getItem('s.clear')).toBe('[]')
  })

  it('swallows a throwing setItem in a mutator', () => {
    vi.stubGlobal('localStorage', makeThrowingLocalStorage())
    const s = persistedSet('s.throw')
    expect(() => s.add('x')).not.toThrow()
    expect(s.has('x')).toBe(true) // in-memory still authoritative
  })
})
