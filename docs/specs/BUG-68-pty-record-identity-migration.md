# BUG-68 — PTY record identity after the synth→real migration

**Date:** 2026-07-22
**Status:** spec — not implemented
**Card:** `.capy/memory/roadmap/BUG-68-synth-real-migration-freezes-kind-and-sessionkey-on-the-pty.md`
**Lives inside:** [T119 — Session hibernation](./T119-session-hibernation.md) (§3.4 immunity list, §5.2)

## 0. Diagnosis review — what survived the code read

The card's diagnosis is **correct in substance**. Three corrections and three additions:

| Card claim                                                            | Verdict                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `fleetSnapshot()` publishes frozen `kind` (`pty.ts:481`)              | ✅ confirmed. `rec.kind` is assigned once at `pty.ts:549`/`756` and never reassigned.                       |
| `isParkable()` admits only `claude-resume` at `fleet-policy.ts:64-66` | ⚠️ correct, **wrong lines** — it is `fleet-policy.ts:67-69`.                                                |
| `rec.sessionKey` is never rekeyed (`pty.ts:870-879`)                  | ✅ confirmed. `grep -n '\.sessionKey *='` over `src/main/` returns **zero** assignments after `pty.ts:755`. |
| Stacking trap → phantom park via `pty.ts:504-505`                     | ✅ confirmed, and **already happening today** on the manual-park path — see §0.2.                           |
| The synthetic exclusion is genuine and must survive                   | ✅ confirmed at `spawn-spec.ts:107` (synthetic branch precedes the resume branch at `spawn-spec.ts:116`).   |

### 0.1 The System Monitor's `synthetic-…` rows are NOT evidence that the rekey is failing

The card treats the monitor still showing `synthetic-<uuid>` rows as a symptom, and the task
framing raises "is the rekey even firing?" as an open question. **It is answered: the rows
prove nothing either way.**

`livePtyDescriptors()` publishes `sessionKey: rec.sessionKey` (`pty.ts:1033`), the frozen
copy. `SystemMonitor.vue:99` then does `sessions.findSessionById(sample.sessionKey)`, which
misses for a stale synthetic key, and falls back to rendering the raw key
(`SystemMonitor.vue:104`, `:254`). So a `synthetic-…` row is the **expected** output of
defect (2) even when `pty:rekey` fires perfectly. The observation is fully explained without
assuming any renderer failure.

**Positive evidence the rekey does fire:** `PtySessionIndex.rekey` maintains both directions
(`pty-session-index.ts:54-60`) and is covered (`tests/pty-session-index.test.ts:30,59`);
`fireMigrate` (`sessions.ts:1381`) is the single funnel and calls every migrate handler,
including `TerminalPane.vue:1010` whose last act is `window.api.ptyRekey(fromId, toId)`
(`TerminalPane.vue:1030`). Had the index kept synthetic keys, `pty:create`'s dedup
(`pty.ts:539-541`) would miss on the real uuid and clone a second `claude --resume` — a loud,
previously-observed failure (2026-06-01 spec §6) that the field report does **not** show (it
counted exactly one `--resume` process).

**The one gate that can suppress it:** `TerminalPane.vue:1012` — `const live =
liveTerminals.get(fromId); if (!live) return`. A synthetic that migrates while it has no
live terminal (never booted — boot is selection-driven, `sessions.ts:1131` — or already
disposed) never reaches `ptyRekey`. That case has no PTY either, so it is harmless.

**Falsifiable one-liner** for whoever implements this, over the second-instance CDP recipe
(`docs/dev/live-verify-second-instance.md`): call
`window.api.ptyIdForSession('<real-uuid>')`. It resolves **iff** the index was rekeyed, while
`window.api.ptyListLive()` will still report the stale `synthetic-…` key. Divergence between
those two answers **is** BUG-68, and confirms the rekey fired.

### 0.2 Three consequences the card does not list

1. **`taskState` is always `null` for a migrated session.** `fleetSnapshot()` does
   `states.get(rec.sessionKey)` (`pty.ts:482`), but the hook FSM is keyed by the **real**
   uuid (that is exactly what `fireMigrate`'s BUG-1a resync at `sessions.ts:1410` exists to
   reconcile). So the `working`-corroboration rule (`fleet-policy.ts:95`) can never engage
   for these sessions. Harmless today (they are unparkable anyway); load-bearing the moment
   they become parkable.
2. **Manual park is already a phantom park — before any fix.** `SystemMonitor.vue:73-77`
   kills by `ptyId` (correct, ptyId is stable) and then calls `monitorPark(rec.sessionKey)`
   → `markHibernated(staleKey)` (`monitor/sampler.ts:224-226`) plus
   `sessions.markHibernated(staleKey)`. The process really dies, but the parked flag lands
   on a key no store row carries, so the sidebar 💤 never appears, and the stale key leaks
   into the hibernation registry permanently — `clearHibernated` only ever fires for the key
   passed to `pty:create` (`pty.ts:766`), i.e. the real uuid. Sibling of BUG-69.
3. **Renderer re-adoption skips migrated sessions.** `pty:list` publishes `rec.sessionKey`
   (`pty.ts:905`); `doReadopt` drops any PTY whose key is absent from the store
   (`TerminalPane.vue:766`). After a renderer reload, every migrated session fails that test
   and is re-created instead of adopted — landing on `pty:create`'s dedup, which hands back
   the same ptyId, so it "works" but with no ring replay and a fresh xterm.

All three are the same root cause and are fixed by §3 for free.

## 1. Problem

Every session the operator **starts** (`+ New session`, a fork, or an agent's
`create_session`) is permanently exempt from hibernation. `isParkable` admits only
`claude-resume` (`fleet-policy.ts:67-69`), and `kind` is frozen at spawn, so a session born
`claude-new` stays `claude-new` for its whole life no matter how cold it gets or how long
ago it wrote its JSONL.

Field evidence (2026-07-22, 64 GB machine, hard reboot after memory exhaustion): 6 live
bare-`claude` processes (`--model … --effort …`, no `--resume`), 424–476 MB each, 27–82 min
old — **~2.7 GB that hibernation is structurally forbidden from touching** — alongside 10
correctly-parked sessions.

T119 shipped a working reaper that can only ever see the minority of the fleet.

## 2. Root cause

Two defects on the same object, `PtyRec` (`pty.ts:263-292`).

**(1) `kind` is provenance, used as capability.** `PtyKind` records _how this process was
spawned_. `isParkable` reads it as _whether this session can be resumed from disk_. Those
coincide at spawn and diverge the instant the session writes its transcript.

**(2) `rec.sessionKey` is a stale copy of an index that already moved.**
`PtySessionIndex` is documented as "the main-process source of truth" for key↔ptyId
(`pty-session-index.ts:6-9`), and `pty:rekey` updates it (`pty.ts:871`) along with
`lastFocusedAt` and `selectedSessionKey` — but not the record. Every projection that reads
the record therefore publishes a dead key: `fleetSnapshot` (`pty.ts:478-491`), `pty:list`
(`pty.ts:903-911`), `livePtyDescriptors` (`pty.ts:1030-1042`). Within `fleetSnapshot` alone
that poisons four fields: `sessionKey`, `taskState` (§0.2), `lastFocusedAt` (the stamp moved
to the new key at `pty.ts:874-877`, so it falls back to `rec.startedAt` and the session looks
permanently cold), and `isSelected` (`pty.ts:485`, permanently `false`).

**The stacking trap.** Fix (1) alone and the policy names a stale key as a victim;
`hibernateSession` resolves it via `sessionIndex.getPtyId(staleKey)` → `undefined` → **silent
`return`** (`pty.ts:504-505`). Nothing is killed, `markHibernated` is never reached, and any
UI that optimistically flipped to "parked" is lying about 450 MB. The two defects must land
in one change.

## 3. Decision 1 — the index is the only source of truth for a live session's key

**Chosen: (b) — delete `sessionKey` from `PtyRec` and resolve it through `sessionIndex` at
every read.** Rejected: (a) also assigning `rec.sessionKey = toKey` in the `pty:rekey`
handler.

### 3.1 Why (b)

- **It makes the acceptance invariant unfalsifiable rather than tested.** The card requires
  "no session is ever published under a key `sessionIndex.getPtyId()` cannot resolve". Under
  (b) the published key _is_ `sessionIndex.getSessionKey(ptyId)`, so the invariant holds by
  construction — the test in §8.3 becomes a canary, not the guarantee.
- **The reverse map already exists, is maintained by `rekey`, and is already tested.**
  `getSessionKey(ptyId)` (`pty-session-index.ts:25-27`), covered at
  `tests/pty-session-index.test.ts:59-64`. No new state, no new mutation point.
- **`pty.ts` already does exactly this twice.** The teardown paths deliberately resolve the
  key through the index rather than the record — `pty.ts:800-803` ("resolve the key while the
  reverse lookup still holds it") and `pty.ts:838-840`. (b) generalizes an in-file precedent
  instead of introducing a competing convention.
- **(a) leaves two copies and re-opens the same class of bug.** Any future key move that
  forgets one of them reproduces BUG-68 verbatim. (a) is a one-line band-aid on a
  duplicated-state design; it is fine as a hotfix and wrong as the resolution of a card
  titled _"pick one source of truth; do not leave two"_.
- **(a) has a worse failure mode under key collision.** `register` drops the stale reverse
  entry when a key is rebound to a new ptyId (`pty-session-index.ts:44-46`). Under (a) the
  old record would keep a key that now resolves to a _different_ live pty — and
  `hibernateSession(thatKey)` would kill the **wrong process**. Under (b) the orphaned record
  simply resolves to `undefined` and drops out of every projection: invisible, not lethal.

### 3.2 Everything that reads `rec.sessionKey` (exhaustive)

`grep -n 'rec\.sessionKey' src/main/pty.ts` — three call sites, all projections, all fixed by
the same edit:

| Site                                                  | Reads                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `fleetSnapshot()` — `pty.ts:478,480,482,483,485`      | the filter, `sessionKey`, `taskState`, `lastFocusedAt`, `isSelected` |
| `pty:list` — `pty.ts:903,905`                         | the filter + the adoption key                                        |
| `livePtyDescriptors()` — `pty.ts:1030,1033,1038,1039` | the filter, monitor row key, `lastFocusedAt`, `isSelected`           |

No renderer, preload, or MCP code reads it — it never crosses the boundary as a record field,
only inside these three payloads.

### 3.3 The shape

```ts
// pty.ts — PtyRec drops `sessionKey` entirely (the field at pty.ts:271-272 is deleted,
// as is `sessionKey: opts.sessionKey` at pty.ts:755).

// Each of the three projections opens with the same two lines:
for (const [id, rec] of ptys) {
  const sessionKey = sessionIndex.getSessionKey(id)
  if (!sessionKey) continue        // plain split-terminal shells: unchanged behavior
  …
}
```

`fleetSnapshot()` currently iterates `ptys.values()` (`pty.ts:477`) and must switch to
`ptys.entries()` to have the ptyId in hand. Ordering is safe: `ptys.set(id, rec)`
(`pty.ts:761`) and `sessionIndex.register` (`pty.ts:769`) are adjacent and synchronous, and
both teardown paths delete from `ptys` **before** `removeByPtyId` (`pty.ts:799/805`,
`838/841`), so no projection can ever observe a record without its key for a keyed session.

## 4. Decision 2 — parkability derives from the transcript, not from birth-kind

**`PtyKind` is the wrong carrier and must not be mutated.** Setting `rec.kind =
'claude-resume'` at rekey time would make `pty:list` (`pty.ts:907`) and the System Monitor
(`pty.ts:1035`) lie about how the process was actually launched — a diagnostic field, and the
one place an engineer looks to answer "did this spawn with `--resume`?". Provenance must stay
provenance.

Instead, `LiveSession` gains an explicit precondition field and `isParkable` reads it:

```ts
// fleet-policy.ts
export interface LiveSession {
  …
  /** Whether a JSONL exists on disk for this session — the precondition `--resume` needs. */
  hasTranscript: boolean
}

function isParkable(s: LiveSession): boolean {
  if (s.kind !== 'claude-new' && s.kind !== 'claude-resume' && s.kind !== 'claude-fork') {
    return false // `shell` has nothing to resume; a `teammate` is owned by its lead
  }
  return s.hasTranscript
}
```

`explainFleet` (`fleet-policy.ts:161`) and `isEligible` (`fleet-policy.ts:78`) switch from
`isParkable(s.kind)` to `isParkable(s)`. The `reason` enum is **unchanged** —
`'not-parkable'` still covers both "wrong kind" and "no transcript yet", so no renderer, no
`design.md`, and no i18n key moves (`system-monitor-format.ts:96` only distinguishes
`'lru'`/`'hard-idle'` anyway).

### 4.1 Deriving `hasTranscript` — the migration event _is_ the proof

```ts
// pty.ts, inside fleetSnapshot()
hasTranscript: !sessionKey.startsWith('synthetic-')
```

This is not a heuristic. Trace it:

1. A synthetic is minted client-side as `` `synthetic-${crypto.randomUUID()}` ``
   (`sessions.ts:2365`, `:2439`, `:2651`) — the only producer of that prefix.
2. The key changes **only** through `fireMigrate` (`sessions.ts:1381`), reached from
   `collapseSyntheticInto` (`sessions.ts:3950`, `:3958`), `tryBindAgentMigration`
   (`sessions.ts:2622`), and the post-reload collapse (`sessions.ts:4077`).
3. Every one of those is driven by `reconcileSessionAdded` (`sessions.ts:3989`), whose
   trigger is the chokidar watcher's `session:added` — **which fires because the JSONL exists
   on disk**.
4. `collapseSyntheticInto` also sets `synth.synthetic = false` and `forkSourceId = undefined`
   (`sessions.ts:3955-3956`), so the wake path through `resolveSpawnSpec` now falls past the
   synthetic branch (`spawn-spec.ts:107`) into the resume branch (`spawn-spec.ts:116`) and
   spawns `claude --resume <real-uuid>`.

So "the live key is no longer `synthetic-…`" ⇔ "the watcher saw this session's transcript
land" ⇔ "`--resume` will restore it". That is exactly T119 §5.2's precondition, and the
exclusion it protects **survives**: a synthetic that never migrated keeps its
`synthetic-` key, `hasTranscript` stays `false`, and it stays immune.

This only works on top of Decision 1 — the prefix test is meaningless against a frozen key.
One truthful key fixes both defects; that is why the fix is one change and not two.

### 4.2 Why not query the filesystem

`hasTranscript` could be a real `existsSync` on the JSONL path. Rejected: `fleetSnapshot()`
runs from the 60 s sweep **and** from every `pty:create` (`pty.ts:546`), the T127 hard rule is
that this snapshot reads only in-memory state and never disk
(`pty.ts:1015-1020`), and the main process would be doing per-session stats on the spawn hot
path to re-derive a fact the watcher already told us.

## 5. Decision 3 — a park that kills nothing must be loud

`hibernateSession` (`pty.ts:503-521`) gets two guarded exits, and keeps its current
ordering (the failure paths already return **before** `markHibernated` / the
`pty:hibernated` emit — that part is right and must stay):

```ts
function hibernateSession(sessionKey: string): void {
  const ptyId = sessionIndex.getPtyId(sessionKey)
  if (!ptyId) {
    // Unreachable by construction after §3 — the key came from the index. Reaching it
    // means a projection published a key the index cannot resolve (BUG-68's signature).
    console.warn(`[hibernate] no live pty for ${sessionKey} — nothing parked`)
    return
  }
  const rec = ptys.get(ptyId)
  if (!rec) {
    console.warn(`[hibernate] index points at dead pty ${ptyId} for ${sessionKey}`)
    sessionIndex.removeByPtyId(ptyId) // self-heal the dangling binding
    return
  }
  …unchanged…
}
```

The rule generalizes: **`markHibernated` and `pty:hibernated` are emitted only on a path that
actually called `pty.kill()`.** No caller may pre-flip a "parked" UI state before that event.
`SystemMonitor.vue:73-77` violates this today (§0.2 item 2) — it marks unconditionally after
an `await` that cannot fail. Out of scope here (that is BUG-69's ground), but it stops
mis-keying once §3 lands, and BUG-69 should adopt this rule.

## 6. Change set

| File                                  | Change                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/pty.ts`                     | Delete `PtyRec.sessionKey` (`:271-272`, `:755`). Resolve the key via `sessionIndex.getSessionKey(id)` in `fleetSnapshot` (`:477`), `pty:list` (`:902`), `livePtyDescriptors` (`:1029`). Add `hasTranscript` to the `fleetSnapshot` payload. Loud guards in `hibernateSession` (`:503`). |
| `src/main/fleet-policy.ts`            | `LiveSession.hasTranscript`; `isParkable(s: LiveSession)` (`:67`); call sites at `:79`, `:161`. Update the doc comment at `:59-66` to describe the transcript precondition instead of the kind list.                                                                                    |
| `src/main/pty-session-index.ts`       | None. It was already right.                                                                                                                                                                                                                                                             |
| `src/main/monitor/types.ts`, renderer | None — `LivePtyDescriptor.sessionKey` keeps its shape and now carries the live key.                                                                                                                                                                                                     |
| `src/renderer/**`                     | None. `pty:rekey` (`TerminalPane.vue:1030`) already sends the right thing.                                                                                                                                                                                                              |

Explicitly **not** in scope: `TerminalPane.vue:1012`'s `if (!live) return` gate (correct —
no terminal means no PTY to rekey), and the `monitor:park` flag path (BUG-69).

## 7. Test plan

The test that would have caught this does not exist today: `tests/` has **no harness that
drives `registerPtyHandlers`**. `tests/fleet-policy.test.ts` proves the decision in isolation
and passed throughout, because it constructs `LiveSession` literals by hand — it never sees
that `fleetSnapshot()` builds them from stale data. That gap is the bug's hiding place, and
closing it is the point of §7.3.

### 7.1 `tests/fleet-policy.test.ts` (extend — 247 lines today)

Its existing `candidate is 'synthetic-*' → immune` case becomes two, and the kind axis is
decoupled from the transcript axis:

| Test                                                               | Rule locked                                      |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| `claude-new` + `hasTranscript: true`, cold → **victim**            | the fix: a migrated started session is parkable  |
| `claude-fork` + `hasTranscript: true`, cold → **victim**           | forks migrate too                                |
| `claude-new` + `hasTranscript: false`, idle 3 h → **immune**       | **the regression guard** (T119 §5.2)             |
| `claude-resume` + `hasTranscript: false` → **immune**              | the precondition beats the kind, both directions |
| `shell` / `teammate` + `hasTranscript: true` → **immune**          | nothing to resume / not ours                     |
| `explainFleet` reports `'not-parkable'` for the no-transcript case | the monitor's WHY stays honest                   |

### 7.2 `tests/pty-session-index.test.ts` (extend — 102 lines today)

Already covers `getSessionKey` after `rekey` (`:59-64`). Add: after `register(k1,p)` then
`register(k2,p)` (rebind), `getSessionKey(p)` is `k2` and `getPtyId(k1)` is `undefined` — the
collision case §3.1 leans on.

### 7.3 `tests/pty-fleet-identity.test.ts` (NEW — the end-to-end park of a migrated session)

Harness pattern from `tests/monitor-sampler-wiring.test.ts:12-30`: `vi.hoisted` map capturing
`ipcMain.handle`/`ipcMain.on`, `vi.mock('electron')`, plus `vi.mock('node-pty')` returning a
fake `IPty` (`pid`, `onData`, `onExit`, `kill: vi.fn()`, `resize`, `pause`, `resume`) and
`vi.mock('./claude-cli')` so `resolveClaudePath` never touches the box's PATH. Then drive the
real handlers:

1. **Park a MIGRATED session end-to-end (the acceptance criterion).**
   `pty:create({ kind: 'claude-new', sessionKey: 'synthetic-a' })` → `pty:rekey('synthetic-a',
'real-uuid')` → advance the injected clock past `hardIdleMs` → fire the sweep →
   assert `fake.kill` was called **once**, `ptys` no longer holds it, `isHibernated('real-uuid')`
   is `true`, `isHibernated('synthetic-a')` is `false`, and the `pty:hibernated` payload
   carries `real-uuid`.
2. **Regression guard: a never-migrated synthetic is never parked.** Same, minus the
   `pty:rekey`. Assert `kill` was **not** called and the hibernation registry is empty, even at
   3× `hardIdleMs`.
3. **No phantom park.** Force the stale-key path (call the exported park path with a key the
   index cannot resolve): assert `kill` not called, `markHibernated` not called, no
   `pty:hibernated` emitted, and `console.warn` **was** called (§5).
4. **The published-key invariant** (the card's explicit ask). After a rekey, for every entry
   of `pty:list`, `livePtyDescriptors()`, and `fleetSnapshot()`:
   `sessionIndex.getPtyId(entry.sessionKey)` resolves, and no entry key starts with
   `synthetic-` once its session has migrated.
5. **`lastFocusedAt` / `isSelected` survive the migration.** After `pty:touchFocus('synthetic-a')`
   then `pty:rekey`, the snapshot reports `isSelected: true` and the original focus stamp —
   not the `rec.startedAt` fallback.

Vitest env: `node` (main-process modules only), matching `tests/monitor-sampler-wiring.test.ts`.

## 8. Migration & compatibility

**Nothing persists across the upgrade, so there is no data migration.** The two pieces of
state involved are in-memory only: the `ptys` map, and `hibernation.ts`'s `Set` (a plain
module-level set, no disk backing). Every PTY dies at `before-quit` → `killAllPtys`, so the
fleet is empty when the new build starts. The only persisted T119 state is the policy
(`monitor/policy-store.ts`), whose shape is untouched.

Two in-run transitions to expect:

- **Renderer reload mid-run.** `pty:list` starts publishing live keys, so `doReadopt`
  (`TerminalPane.vue:766`) now _matches_ migrated sessions against the store and genuinely
  re-adopts them (ring replay, same xterm) instead of falling through to the create-path
  dedup. Strictly better; no rollback path needed.
- **First sweep after the fix ships.** Previously-exempt sessions become eligible. They enter
  the run with a fresh `startedAt`/`lastFocusedAt` (`pty.ts:768`), so nothing is parked in the
  first `hardIdleMs` (60 min) purely by virtue of the upgrade — no thundering-herd park on
  launch. Worth watching once in the field: with the 6-session case above, the expected steady
  state is ~1 live + parked rest, i.e. ~2.5 GB reclaimed.
- **Stale keys already in the hibernation registry** (from the §0.2 manual-park leak) are
  discarded with the process; they cannot survive a restart.

## 9. Repo contracts

- **CHANGELOG.md** — required. `### Fixed`: "Sessions you start (New session, forks, agent
  `create_session`) can now be parked by hibernation once they've written their transcript —
  previously they stayed live forever."
- **`docs/capy-features.md`** — **not** required. No MCP verb, no ACK field, no grant/confirm
  semantics, no new affordance the agent can offer. `get_fleet`'s `hibernated` flag exists
  already and simply becomes true for more sessions. This is the card's own litmus:
  fleet-policy tuning with nothing new to call is out.
- **`docs/user/`** — **not** required. No new component, no new top-level `src/main/` file, no
  `tool-catalog.ts` change. Label the PR `no-user-docs` / `no-awareness` if a gate trips.
- **`design.md`** — not touched: no new visual state (the `reason` enum is unchanged, §4).

## 10. Out of scope / related

- **BUG-69** — a manual park emits no `pty:hibernated`. Adopt §5's rule there.
- **BUG-70** — `pty:exit` carries no park provenance, so a park is misreported as `completed`.
- **BUG-71** — kill without escalation or verification (`rec.pty.kill()` at `pty.ts:511` is
  fire-and-forget; nothing confirms the process actually died).
- **T178** — parked sessions must be silent.
- Unrelated, noted in passing: `spawn-spec.ts:38` carries a Portuguese doc comment, which
  violates the English-lingua-franca contract (`CLAUDE.md`). Not this card's diff.
