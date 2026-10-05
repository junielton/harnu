import { ref, watch, type Ref, type WatchOptions } from 'vue'

/**
 * `localStorage`-mirrored reactive primitives (T24).
 *
 * Six renderer stores hand-rolled the same `try { localStorage… } catch {}`
 * dance around ~30 preferences (a `Set` ↔ JSON array here, a validated enum
 * there, an inverted-default boolean elsewhere). This module collapses all of
 * it into two helpers so every persisted preference reads/writes through ONE
 * audited implementation: init-read falls back to a default on any throw or a
 * failed `validate`, and every write is swallowed on quota/private-mode failure
 * (an in-memory-only degrade, matching the old hand-rolled `catch {}`).
 *
 * Renderer-side only — may import `vue` and touch `localStorage`; NO IPC. The
 * key names and serialized formats are the stores' persisted contract, so
 * callers must keep both byte-identical when migrating onto these helpers (a
 * changed key or shape silently strips a user's saved preference).
 */

/** Write `value` under `key`, swallowing quota / private-mode failures (in-memory-only degrade). */
function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* quota exceeded / private mode — the ref stays authoritative in memory */
  }
}

/** Options for {@link persistedRef}. All optional; the defaults cover string/JSON scalars. */
export interface PersistedRefOpts<T> {
  /** Serialize for storage. Default: identity for a string default, else `JSON.stringify`. */
  serialize?: (v: T) => string
  /** Parse from storage; MAY throw — a throw (or `validate` returning false) falls back to `def`. */
  deserialize?: (raw: string) => T
  /** Reject a parsed value (out of range / not in an allowlist) → fall back to `def`. */
  validate?: (v: T) => boolean
  /** `watch()` options for the auto-persist watcher (e.g. `{ deep: true }`). */
  watch?: WatchOptions
}

/**
 * A reactive scalar/object mirrored to `localStorage`: read once on init (with a
 * `def` fallback on missing/corrupt/invalid), then auto-persisted whenever the
 * ref changes. Does NOT write on init — an absent key stays absent until the
 * first real change, so the default is never eagerly materialized.
 *
 * The default (de)serializer branches on `typeof def`: a string default stores
 * verbatim, anything else uses `JSON.stringify`/`JSON.parse`. Numbers should
 * pass `{ serialize: String, deserialize: Number }` explicitly to avoid
 * `JSON.parse` quirks (e.g. `NaN`), plus a `validate` for range/preset checks.
 */
export function persistedRef<T>(key: string, def: T, opts: PersistedRefOpts<T> = {}): Ref<T> {
  const isStringDefault = typeof def === 'string'
  const serialize =
    opts.serialize ?? ((v: T) => (isStringDefault ? (v as unknown as string) : JSON.stringify(v)))
  const deserialize =
    opts.deserialize ??
    ((raw: string) => (isStringDefault ? (raw as unknown as T) : (JSON.parse(raw) as T)))

  function read(): T {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return def
      const v = deserialize(raw)
      if (opts.validate && !opts.validate(v)) return def
      return v
    } catch {
      return def
    }
  }

  const r = ref(read()) as Ref<T>
  watch(r, (v) => safeWrite(key, serialize(v)), opts.watch)
  return r
}

/** A reactive `Set<T>` mirrored to `localStorage` as a JSON array. See {@link persistedSet}. */
export interface PersistedSet<T extends string> {
  /** The reactive handle — read `.value.has(x)` / iterate it in templates & computeds (read-only). */
  readonly set: Ref<Set<T>>
  /** Membership test (reactive when read inside a computed/template). */
  has(x: T): boolean
  /** Add `x`, reassigning the Set identity, then persist. */
  add(x: T): void
  /** Remove `x`, reassigning the Set identity, then persist. */
  delete(x: T): void
  /** Flip `x`'s membership, reassigning the Set identity, then persist. */
  toggle(x: T): void
  /** Empty the Set, reassigning the identity, then persist. */
  clear(): void
}

/**
 * A reactive `Set<string | enum>` mirrored to `localStorage` as a JSON array.
 *
 * Load parses the array, keeps only strings passing `validate` (default: any
 * string), and builds a `Set` — all in a `try/catch` that degrades to an empty
 * Set. **Every mutator reassigns `set.value = new Set(prev)` before mutating,
 * then persists.** The reassign is mandatory for two reasons at once: Vue tracks
 * proxy reassignment, not in-place `.add()`
 * (`docs/lessons/reactivity/002-mutate-through-the-store-proxy-not-the-raw-object.md`),
 * and persistence lives in the mutator (not a fragile deep watch that would miss
 * an in-place mutation). The raw Set is exposed read-only for `.has`/iteration;
 * callers must go through the mutators, never `.set.value.add()` directly.
 */
export function persistedSet<T extends string>(
  key: string,
  opts: {
    validate?: (x: string) => x is T
    /**
     * Rewrite each stored entry on load — the upgrade path when a key's FORMAT
     * changes (e.g. bare ids gaining a namespace prefix) and dropping the old
     * entries would silently strip a saved preference. Applied before
     * `validate`. Omit it and entries load verbatim, as they always have.
     */
    migrate?: (x: string) => string
  } = {}
): PersistedSet<T> {
  const keep = opts.validate
  const migrate = opts.migrate

  function read(): Set<T> {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return new Set<T>()
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return new Set<T>()
      const kept = parsed
        .filter((x): x is string => typeof x === 'string')
        .map((x) => (migrate ? migrate(x) : x))
        .filter((x): x is T => (keep ? keep(x) : true))
      return new Set<T>(kept)
    } catch {
      return new Set<T>()
    }
  }

  const set = ref(read()) as Ref<Set<T>>

  function persist(): void {
    safeWrite(key, JSON.stringify([...set.value]))
  }

  /** Reassign a fresh Set (mutated by `apply`) so Vue tracks the change, then persist. */
  function reassign(apply: (next: Set<T>) => void): void {
    const next = new Set(set.value)
    apply(next)
    set.value = next
    persist()
  }

  return {
    set,
    has: (x) => set.value.has(x),
    add: (x) => reassign((next) => next.add(x)),
    delete: (x) => reassign((next) => next.delete(x)),
    toggle: (x) => reassign((next) => (next.has(x) ? next.delete(x) : next.add(x))),
    clear: () => reassign((next) => next.clear())
  }
}
