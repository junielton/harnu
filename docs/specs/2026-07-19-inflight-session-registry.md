# Spec: in-flight agent-session registry (BUG-30)

**Card:** `BUG-30-wire-inflightagentsessions-so-get-session-get-fleet-see-a-just`
**Corroborating evidence:** `BUG-47` (three dispatches, 17 `get_fleet` checks over
2.5h, never visible).

## Problem

`get_session` and `get_fleet` cannot see a session an agent just created via
`create_session`, until that session produces a real disk artifact (a JSONL
transcript from an actual PTY boot). This is **not a timing race** — a synthetic
lives in the renderer's Pinia store the instant `create_session` succeeds, but
nothing ever teaches the main-process read path about it, so waiting longer does not
help. The full create→read cycle is not observable end-to-end, which is the second
half of the operator's original bug report.

## Root cause

Both handlers hardcode the field away:

- `src/main/mcp/tool-handlers.ts:281` (`getSessionHandler`) and `:304`
  (`getFleetHandler`) pass `inflightAgentSessions: []` to `buildFleetSnapshot()`.

The merge seam is already fully built and simply has no source:

- `src/main/mcp/fleet-snapshot.ts:127` declares the field;
- `:166`'s doc comment states sessions are "the union of `sessions` and
  `inflightAgentSessions`, deduped";
- `:210` already loops over it.

Nothing in the main process tracks "agent-created synthetics that succeeded but
haven't reached disk yet", so the union is always a union with the empty set.

## Decisions

**D1 — A small in-memory registry, mirroring `grant-registry.ts`.** New module
`src/main/mcp/inflight-session-registry.ts`, following the established pattern of
`grant-registry.ts` / `inherit-once-registry.ts`: a module-level `Map`, explicit
eviction, and a pure core for the decisions. **In-memory only** — a synthetic that
did not boot before a restart is not a fact worth resurrecting, and the restart
itself is the eviction.

**D2 — Record shape.** `{ syntheticId, folderPath, correlationId, createdAt }` —
exactly the fields `createSessionHandler` already has in hand at dispatch time, and
exactly what `FleetSessionInput` needs to render a row.

**D3 — Write site.** `createSessionHandler` (`src/main/mcp/tool-handlers.ts:545`)
registers on a **successful** dispatch only. A failed dispatch must register nothing —
otherwise the registry re-creates the `ok:true`-but-no-session lie tracked by
`create-session-returns-ok-true-without-launching-a-session`, one layer further down.

**D4 — Read sites.** `getSessionHandler` (`:281`) and `getFleetHandler` (`:304`) pass
`registry.list()` (optionally folder-filtered) instead of `[]`. `fleet-snapshot.ts`
needs no change — its dedupe already prefers the disk row when both exist.

**D5 — Eviction: disk-appearance first, TTL as the backstop.** An entry is dropped
when EITHER holds:

- **Disk appearance (primary).** The snapshot build already knows the real session
  set; any entry whose `syntheticId` matches a session now present on disk is evicted
  as a side effect of the same read. This is the correct, evidence-based eviction —
  the moment the session is observable the shim's job is done.
- **TTL (backstop): 60 minutes from `createdAt`.** Justification: the observed boot
  latencies are far larger than intuition suggests. A dispatch on 2026-07-18 took
  ~24 minutes from `create_session` to its first transcript line, spent entirely in a
  cold `npx` download of two auto-connected MCP servers, and the delayed-batch shape
  seen elsewhere runs ~14 minutes. A TTL must comfortably exceed the worst _legitimate_
  boot, or it evicts healthy sessions and re-creates the very blindness this card
  fixes. 60 min is ~2.5× the worst observed case while still bounding a ghost entry to
  one hour. Bound the map at **64** entries (oldest `createdAt` evicted first), the
  same shape as `GRANT_CAP` (`grant-registry.ts:24`).

**D6 — Ghost entries are labelled, not hidden.** An entry that is still in the
registry is a session Capy _believes_ it created and has _not yet_ observed. The
snapshot row must carry that distinction (e.g. `inflight: true` on the emitted
session), so an agent reading `get_fleet` can tell "dispatched, not yet observable"
from "observed and running". Reporting a fabricated healthy session would be worse
than reporting nothing.

**D7 — Contract gates fire.** This changes the observable read semantics of
`get_fleet` / `get_session` (a new row class, a new field). Per `CLAUDE.md`, update
`docs/capy-features.md` **and bump its `<!-- capy-features vN -->` marker** — the agent
gains something it can act on: a just-created session is now readable immediately, and
`inflight: true` is a field it should interpret. Update
`docs/user/agent-control.md` with the human-prose equivalent. Do **not** reach for the
`no-awareness` / `no-user-docs` labels here; they do not apply.

**D8 — Out of scope.** Re-litigating the free-by-default posture (PR #113) or the
`FOLDER_NOT_FOUND` fix (`9f6899f`) — both shipped. Also out of scope: fixing the
underlying `create_session` dispatch failure (that is
`create-session-returns-ok-true-without-launching-a-session`); this card is purely the
read-visibility gap and must not paper over a dispatch that genuinely failed.

## Scope boundary — files

| File                                                                  | Change                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/main/mcp/inflight-session-registry.ts`                           | **new** — the Map, the pure eviction core, `register` / `list` / `evictObserved` |
| `src/main/mcp/tool-handlers.ts`                                       | register in `createSessionHandler` (`:545`); read at `:281` and `:304`           |
| `src/main/mcp/fleet-snapshot.ts`                                      | at most the `inflight` flag on the emitted row — the union/dedupe logic stays    |
| `tests/inflight-session-registry.test.ts`                             | **new** — the pure suite                                                         |
| `tests/mcp-fleet-snapshot.test.ts`                                    | extend: non-empty `inflightAgentSessions` surfaces + dedupes                     |
| `docs/capy-features.md` (+ marker bump), `docs/user/agent-control.md` | contract gates (D7)                                                              |
| `CHANGELOG.md`                                                        | one bullet under `### Fixed`                                                     |

## Acceptance criteria

- [ ] `create_session` immediately followed by `get_session` on the returned
      `syntheticId` returns the session — no wait, no disk artifact required.
- [ ] `get_fleet` lists the same session under the correct folder, flagged
      `inflight: true`.
- [ ] Once the real session appears on disk, exactly ONE row is returned (deduped,
      disk row wins) and the registry entry is gone.
- [ ] A dispatch that fails registers nothing — `get_fleet` does not invent a session.
- [ ] An entry older than the TTL is evicted even if the session never appears.
- [ ] The 64-entry cap holds under a burst.
- [ ] `docs/capy-features.md` updated + marker bumped; `docs/user/agent-control.md`
      updated; `CHANGELOG.md` entry present.

## TDD plan

Write this test FIRST, in a new `tests/inflight-session-registry.test.ts` (vitest,
pure core, injected `now` — no fake timers needed, following `grant-core`'s style):

```ts
it('evicts an entry once the real session is observed on disk', () => {
  let reg = register(emptyRegistry(), {
    syntheticId: 'synthetic-1',
    folderPath: '/repo',
    createdAt: 0
  })
  expect(list(reg, { now: 0 })).toHaveLength(1)
  reg = evictObserved(reg, ['synthetic-1'])
  expect(list(reg, { now: 0 })).toEqual([])
})
```

It fails to compile today (the module does not exist), which is the correct first red.
Then, in order: TTL expiry at 60 min (`list` at `now = TTL + 1` returns nothing),
the 64-entry cap, and finally the `tests/mcp-fleet-snapshot.test.ts` case asserting a
snapshot built with a non-empty `inflightAgentSessions` surfaces the synthetic and
dedupes it against a same-id disk session.
