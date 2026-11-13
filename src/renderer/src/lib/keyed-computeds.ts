import { computed, type ComputedRef } from 'vue'

/**
 * One cached `computed` per key (BUG-265).
 *
 * A computed that loops over the whole fleet and classifies every session re-reads every session each time
 * any ONE of them changes: with a deep reactive fleet that is the cost of a hook event, paid in full.
 * Splitting the per-session part into its own computed makes Vue do the bookkeeping: an event dirties the
 * computeds of the sessions it touched, and the aggregate that folds them only re-reads those.
 *
 * Because a computed re-notifies its dependents only when its value CHANGED, return a primitive (a state
 * string, a boolean) wherever the aggregate does not need more: an event that leaves a session's verdict as
 * it was then wakes nothing.
 *
 * `compute` runs lazily, inside the computed, so every read it makes is tracked for that key alone. The
 * cache is plain (not reactive): `get` is a lookup plus `.value`, safe to call from inside another
 * computed. Call `prune` when keys leave, or the cache keeps a computed per key forever.
 */
export interface KeyedComputeds<V> {
  /** The key's current value (creates its computed on first use). Reactive when read inside an effect. */
  get(key: string): V
  has(key: string): boolean
  /** Drops every key that is not in `keep`. */
  prune(keep: { has(key: string): boolean }): void
  readonly size: number
}

export function createKeyedComputeds<V>(compute: (key: string) => V): KeyedComputeds<V> {
  const cache = new Map<string, ComputedRef<V>>()
  return {
    get(key) {
      let c = cache.get(key)
      if (!c) {
        c = computed(() => compute(key))
        cache.set(key, c)
      }
      return c.value
    },
    has: (key) => cache.has(key),
    prune(keep) {
      for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key)
    },
    get size() {
      return cache.size
    }
  }
}
