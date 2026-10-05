# Mini-spec: serialize `user-projects.ts` read-modify-write

> **Status:** Ready for implementation — independent, parallel-safe
> **Created:** 2026-07-19
> **Card:** BUG-41
> **Found during:** [`docs/plans/2026-07-15-t146-dispatch-worktree-race-debug.md`](../plans/2026-07-15-t146-dispatch-worktree-race-debug.md) (BUG-40)

---

## 1. Problem

Concurrent writes to `projects.json` silently lose entries. No exception is thrown;
a folder Capy adopted simply is not there afterwards. This was the best available
explanation for a fully-adopted T146 worktree ending up missing from
`~/.config/om2tab/projects.json` with no error anywhere in the logs.

The repo routinely runs 60+ worktrees under `.claude/worktrees/`, and worktree
creation/adoption happens concurrently in normal usage (parallel dispatch, fan-out
sessions). This race is reachable in ordinary operation, not theoretical.

## 2. Root cause (verified by grep)

`src/main/user-projects.ts` contains **no mutex, queue, or lock of any kind**.

`writeUserProjects` (`:259-271`) is atomic _per call_ — it writes a `.tmp` then
`fs.rename`s. But roughly ten mutators each perform an unsynchronized
read → merge-in-memory → write:

| Function                                                            | Line       |
| ------------------------------------------------------------------- | ---------- |
| `addUserProject`                                                    | `:284-303` |
| `setUserProjectAgentDenied`                                         | `:323`     |
| `setUserProjectAlias`                                               | `:353`     |
| `setUserProjectInheritAgentControl`                                 | `:404`     |
| `setUserProjectMemoryOverride`                                      | `:463`     |
| `setUserProjectAutoOrganize`                                        | `:547`     |
| `setUserProjectInterceptActive`                                     | `:604`     |
| (plus the hidden-path / removal mutators at `:678`, `:700`, `:722`) |            |

If two calls interleave inside the read→merge→write window, the second computes its
`next` from a stale read that predates the first writer's change, and its atomic
write **clobbers** the first. Per-call atomicity guarantees the file is never
half-written; it guarantees nothing about lost updates.

## 3. Design

A single in-process async queue keyed on the target file path. This is Electron
main — one process — so no cross-process file locking is needed or wanted.

```
const queues = new Map<string, Promise<unknown>>()

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(filePath) ?? Promise.resolve()
  const next = prev.then(fn, fn)          // a rejected predecessor must not stall the queue
  queues.set(filePath, next.catch(() => {}))
  return next
}
```

**Every** mutator in `user-projects.ts` routes its read→merge→write through
`withFileLock`, so the whole sequence is effectively atomic across concurrent
callers. Pure readers (`readUserProjects` and friends) stay unqueued — a stale read
outside a mutation is harmless and queueing them would serialize the hot path for no
benefit.

Two rules for the implementer:

- Wrap the **entire** read→merge→write, never just the write. Wrapping only the write
  reproduces the bug exactly.
- The helper is local to this module. Do not generalize it into a shared utility in
  this change — other atomic writers (`src/main/mcp/atomic-write.ts`) have their own
  semantics and are out of scope.

## 4. Scope boundary

**Touch:** `src/main/user-projects.ts` only.
**Also:** `CHANGELOG.md` (user-visible: adopted folders no longer vanish).

**Do NOT touch:** `src/main/worktree-ipc.ts` (BUG-40's spec owns the adopt stage),
`src/main/mcp/atomic-write.ts`, or any caller — the fix is entirely internal and the
public signatures are unchanged.

This file appears in no other spec in this batch, so this card is safe to run fully
in parallel with everything else. (Its `deps: [BUG-40]` frontmatter records where it
was _found_, not an ordering constraint.)

## 5. Acceptance criteria

- [ ] AC1 Two concurrent `addUserProject` calls both survive on disk.
- [ ] AC2 A mutator racing a _different_ mutator (e.g. `addUserProject` vs
      `setUserProjectAlias`) preserves both effects.
- [ ] AC3 A rejected mutator does not stall the queue for subsequent callers.
- [ ] AC4 Public signatures and return values are unchanged; no caller edits.
- [ ] AC5 Reads are not serialized behind the mutation queue.

## 6. TDD plan

**First failing test:** new `tests/user-projects-concurrency.test.ts` →
`'concurrent addUserProject calls do not lose entries'`.

Point the module at a tmpdir, then:

```js
await Promise.all([addUserProject(A), addUserProject(B)])
const file = await readUserProjects()
expect(file.projects.map((p) => p.path)).toEqual(expect.arrayContaining([A.path, B.path]))
```

This fails today — one entry is lost, with no error raised. Add a small injected
delay between read and write if the race proves timing-dependent on a fast machine;
the module's `normalizePath` await already provides a natural yield point.

Then: (2) `'a mutator racing a different mutator preserves both effects'` (AC2);
(3) `'a rejected mutator does not stall the queue'` (AC3). Existing
`tests/user-projects-alias.test.ts` and `tests/user-projects-auto-organize.test.ts`
must stay green unchanged — that is the AC4 regression check.
