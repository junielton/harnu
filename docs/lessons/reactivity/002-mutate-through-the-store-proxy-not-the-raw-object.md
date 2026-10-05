# 002-mutate-through-the-store-proxy-not-the-raw-object: a reactive computed only tracks proxy mutations

**Category:** reactivity (Vue 3 / Pinia)
**Discovered in:** Fleet status board store test, `9f5d1f1` (Jun 2026)
**Status:** active

## The bug

A reactivity test for the `boardBuckets` computed failed: it built a session
object, pushed it into the store's `folders`, asserted the bucket, then mutated
`s.taskState = 'needs-input'` on the **original local reference** and asserted the
computed re-bucketed it. The computed never updated — the test failed even though
the production code was correct.

```ts
const s = session({ taskState: 'idle' })
seed(store, [{ alias: 'api', sessions: [s] }])
s.taskState = 'needs-input' // ❌ mutates the raw object — no tracking
expect(store.boardBuckets[0].state).toBe('needs-input') // fails
```

## Root cause

Vue's `reactive()` (and Pinia's state) returns a **Proxy** wrapping the object.
Dependency tracking and triggers fire only for reads/writes that go **through the
proxy**. After `store.folders.push(s)`, the array element you read back is the
proxied version; the original `s` you still hold is the raw target. Writing to the
raw object mutates the underlying data but never notifies subscribers, so any
`computed`/`watch` depending on it stays stale.

## The fix (and why)

Mutate through the store's reactive handle (or its API), not the captured raw
reference:

```ts
store.folders[0].sessions[0].taskState = 'needs-input' // ✅ goes through the proxy → triggers
// or, in prod code, the store action that owns the field:
store.applyTaskState(id, 'needs-input')
```

## How to detect in reviews

1. In tests: any pattern that captures an object reference **before** handing it
   to a store/`reactive`, then mutates the captured reference and expects a
   computed/watch to react. Re-read it from the store after seeding.
2. In app code: holding a raw reference across a `reactive()`/store boundary and
   writing to it later — the write is invisible to the reactivity graph.
3. Smell: a "reactivity is broken" report where the data is clearly changing but
   the UI/computed doesn't — check whether the mutation goes through the proxy.

## Related

- `tests/fleet-board-store.test.ts` ("recomputes reactively when a session taskState changes")
- `src/renderer/src/stores/sessions.ts` (`boardBuckets`, `applyTaskState`)
- `reactivity/001-stale-comment-rot`
