# T389 P1W6 — Telemetry, plan usage, per-turn cost

## 1. Status

Specified (not implemented) · 2026-10-02 · Epic T389 · Wave P1W6 · Families `telemetry`,
`planUsage`.
Rulebook: [`00-master.md`](00-master.md) · Wire: [`01-contract.md`](01-contract.md) ·
Decisions: [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) (D11, C5).
Related: `docs/specs/T199-statusline-rate-limits.md` (specified, not implemented),
`docs/lessons/framework/005-exit-cleanup-must-be-instance-exact.md`.
Verified against Claude Code CLI 2.1.287 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository). "types L<n>" is a line
of that release's `claude-code.d.ts`.

## 2. Depends on / Unblocks

- **Depends on:** P1W3 (binding, `session.rebound`), P1W4 (arbiter, ledger, feature policy).
  Slice S3 also needs `turn.started` / `turn.completed` from **P1W5** (ruling 3).
- **Unblocks:** P5W1 (statusLine install becomes opt-in); P4W4 and P4W5 (`recordAuxSpend`,
  `lastContextTokens`).
- **Slices, stackable:** S1 telemetry store + adapter for the `cost`, `context` and
  `rateLimits` groups (base branch P1W4; needs nothing from P1W5) · S2 plan-usage gate (base
  S1) · S3 turn ledger, the `model` group and cost calibration (base S2 **and** P1W5).
- **Interfaces consumed** (the owner's signatures, master §12): P1W3 mod runtime
  (`ensureHello($)`, `emit($, event)`, `enabled(feature)`, `reportModError`); P1W1
  `onBindingChange`, `markProven`; P1W4 `owns` / `ownerFor`, `onOwnershipChange`, `recordFact`,
  `registerParityRule` (the `sense.usage` rule is already registered through
  `registerFeaturePolicy` by P1W4); P1W5 emits `turn.started` and `turn.completed` with the
  envelope `turnId` and `TurnUsage`.
- **Interfaces offered** (master §12.1): `lastContextTokens` (§7.3, served by the telemetry
  store, slice S1); `recordAuxSpend` (§7.5, slice S3).

## 3. Summary

`session.measure` pushes context, rate limits and cost; the mod forwards them as
`usage.measured`. The host writes those fields, and only those, into the `SessionTelemetry`
record the footer, the hover preview and usage history already read. The statusLine keeps the
fields with no mod source. Plan limits come from any leased session; the `claude -p "/usage"`
poll runs only when none reported in 90 s. Each turn's tokens are ledgered from
`turn.completed`, its dollars from cost deltas, and the Usage Dashboard's JSONL scan is
calibrated by the measured totals for sessions the ledger fully covers.

## 4. Evidence

| Id           | Verdict             | What this wave takes from it                                                                                                                                                       |
| ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| smoke A3     | CONFIRMED           | `session.measure` fires (29 events), also in `-p`; figures equal the statusLine blob of the same session                                                                           |
| smoke A3     | REFUTED             | "The mod covers every `SessionTelemetry` field": lines ±, thinking, output style, PR have no source                                                                                |
| smoke A3     | PARTIAL             | A rate-limit-only trigger was never isolated (C5, CQ14); `effortLevel` partial; model name untested (Q13)                                                                          |
| smoke A3     | observed            | First measure 300–500 ms after `session.start` with no `tokens` and cost 0; then after the first model step and after each `turn.complete`                                         |
| smoke A2     | observed            | `--resume`: cost cumulative, `rateLimits: []` at the handshake, a measure with windows about 250 ms later; `/clear` resets cost and `startedAt`                                    |
| smoke D7     | CONFIRMED / PARTIAL | Summed `turn.complete.usage` equals the CLI total exactly; no USD per turn; subagent dollars land in the parent's delta; fork, complete and compaction are in no `turn.complete`   |
| smoke A4     | observed            | `session.measure` follows `turn.complete` by about 13 ms; `durationMs` seemed to exclude dialog time (one run, Q14)                                                                |
| types L10379 | read                | `SessionMeasureInput { context, rateLimits, cost?, changed }`                                                                                                                      |
| types L10566 | read                | `SessionRateLimit { kind: string, percentUsed, resetsAt?: ISO string }`; "the windows the last response reported"                                                                  |
| types L2566  | read                | `$.session.model()`: "the main loop's model, as `/model` shows it"                                                                                                                 |
| code         | read                | `captureFleet` is called only from statusLine ingest (`statusline.ts:243-247`); `foldFleetTelemetry` stamps a window with the blob's `updatedAtMs` (`statusline-parse.ts:169-176`) |

## 5. Deviations from the study

| Study said                                    | This spec                                                                                                       | Why                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| `session.measure` **replaces** the statusLine | Demoted: it keeps `linesAdded`, `linesRemoved`, `thinkingEnabled`, `outputStyle`, `pr`, `modelName`             | D11, smoke A3       |
| (not in the study)                            | `durationMs` and `effortLevel` also stay on the statusLine                                                      | smoke A3: "partial" |
| The `/usage` poll is replaced                 | It becomes the fallback after 90 s without a leased reading, and stays the only source of per-model weekly rows | D11, T199 §3.3      |
| Per-turn cost is exact from `turn.complete`   | Tokens are exact; USD is a measured delta per main turn, never attributed to a subagent turn                    | smoke D7            |
| The JSONL cost scan is retired                | It stays for history and for structure; measured totals calibrate it                                            | ARB-8               |

## 6. Scope / Non-goals

**In scope:** feature `sense.usage`; the neutral telemetry store; the field partition; the
plan-usage gate in `usage.ts`; the turn ledger; cost calibration in `usage-cost`; two parity
rules; `recordAuxSpend` and `lastContextTokens`; Q13, Q14, CQ14; the lesson `framework/005`
regression.

**Non-goals:** uninstalling or disabling the statusLine (P5W1); any new UI or string; relabelling
dashboard numbers as "exact"; `spend_limit` in the UI; per-request usage (`turn.step` is not
hooked). Fork, complete and compaction usage by name reach the ledger through `recordAuxSpend`,
called by P4W4 and P4W5.

## 7. Design

### 7.1 Mod — `sense.usage`

`resources/companion/hooks/lib/usage-sensor.ts` (pure: normalizes and decides what to send).
Hooks and calls in `register.ts`:

| Trigger                                           | Action                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.measure` (types L4123)                   | `next(e)` returned unchanged; `usage.measured { source: 'measure', … }` from `e`                                                                          |
| after a successful hello, on `resync`, on `flush` | un-awaited `$.session.usage()` (types L2625) and `$.session.model()` → `usage.measured { source: 'read', startedAt, model, changed: every unit present }` |

`rateLimits` entries are passed through as `{ kind, percentUsed, resetsAt? }`. `usage.measured`
is coalescable (contract §6): the ring keeps the newest, which is safe because every figure is
cumulative. `api-surface.json` gains the event `session.measure` and the calls
`$.session.usage`, `$.session.model`. Neither call is awaited on a turn's path (MOD-6); a
rejected call is a `mod.error`, not a retry loop.

### 7.2 Contract additions

None — merged into `01-contract.md` §8: `usage.measured` carries `source`, `startedAt?`,
`model?` and `rateLimits[].kind: string`, with the rules "a `read` is a state re-send, not a
moved unit" and "the host maps `five_hour` and `seven_day`, records `spend_limit`, ignores the
rest". What the two optional fields are for:

- `model` is **evidence for Q13 only**. It feeds no store field: `modelName` stays on the
  statusLine and `modelId` comes from `turn.completed.usage.model` (§7.3).
- `startedAt` is copied onto the ledger's `open` record for later analysis. It takes no part in
  the "fresh session" test, which is `costAtOpen === 0` (§7.5).

Host-only constant (not on the wire): `COST_SETTLE_MS = 2 000`.

### 7.3 Telemetry store and field partition

**Extraction.** The per-session map, `payload()`, the cache and the emit debounce move from
`statusline.ts` (`:53`, `:190-262`) into `src/main/telemetry-store.ts`, with the pure
composition in `src/main/telemetry-compose-core.ts`. `statusline.ts` keeps install, self-heal,
exit cleanup and the inbox watcher, and becomes one of two writers.
`getTelemetryPayload` is re-exported from `statusline.ts` so `usage-bi.ts:21` does not change.

```ts
// telemetry-store.ts
export function ingestStatusline(t: SessionTelemetry): void
export function ingestCompanion(sid: string, part: CompanionPart, owned: boolean): void
export function dropCompanion(sid: string): void // lease loss, session end
export function getTelemetryPayload(): TelemetryPayload

interface CompanionPart {
  cwd: string | null
  cost?: { usd: number; atMs: number }
  context?: { percent: number | null; window: number; tokens?: number; atMs: number }
  rateLimits?: { fiveHour: RateWindow | null; sevenDay: RateWindow | null; atMs: number }
  model?: { id: string; atMs: number } // slice S3: P1W5's main-loop turn.completed.usage.model
}

/** The last context.tokens a session reported, or null. Read by P4W4 and P4W5. */
export function lastContextTokens(sid: Sid): number | null
```

Every accepted write runs one **commit**: compose → `telemetry.set` → `scheduleCacheWrite()` →
`void captureFleet(foldFleetTelemetry(map, now), now)` → `scheduleEmit()`. `captureFleet` is in
the commit, not in a writer, so usage history is fed whichever source wrote (R14).

**Partition (ARB-2c, contract §11.2).** `compose(statusline, companion, owned)`:

| `SessionTelemetry` field (`statusline-parse.ts:11-38`) | Group        | Writer when the companion owns `telemetry`                                                                                                           |
| ------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`                                            | —            | the key (the CLI sid for both)                                                                                                                       |
| `cwd`                                                  | —            | statusLine if present, else the binding's `hello.cwd`                                                                                                |
| `costUsd`                                              | `cost`       | companion: `costUsd`                                                                                                                                 |
| `contextPercent`                                       | `context`    | companion: `context.percent`                                                                                                                         |
| `contextWindowSize`                                    | `context`    | companion: `context.window`                                                                                                                          |
| `exceeds200k`                                          | `context`    | companion: `context.tokens > 200 000`                                                                                                                |
| `rateLimits.fiveHour`, `.sevenDay`                     | `rateLimits` | companion: `percentUsed` → `usedPercent`; `Date.parse(resetsAt)` → `resetsAtMs` (the statusLine converts epoch seconds, `statusline-parse.ts:80-81`) |
| `modelId`                                              | `model`      | statusLine in S1–S2; from slice S3 the companion: the last main-loop `turn.completed.usage.model`                                                    |
| `modelName`                                            | —            | **statusLine** (Q13)                                                                                                                                 |
| `linesAdded`, `linesRemoved`                           | —            | **statusLine**                                                                                                                                       |
| `durationMs`                                           | —            | **statusLine** (`startedAt` is the first launch of a resumed session, not its duration)                                                              |
| `effortLevel`, `thinkingEnabled`, `outputStyle`, `pr`  | —            | **statusLine**                                                                                                                                       |
| `updatedAtMs`                                          | —            | the newest stamp among the contributing writers                                                                                                      |
| `rateLimitsAtMs` (**new**, optional)                   | `rateLimits` | the stamp of the reading that produced the windows                                                                                                   |

Rules:

1. **Not owned** (mode `off` or `shadow`, no lease, unproven): the statusLine record passes
   through untouched. In `shadow` the companion part is recorded in the ledger only.
2. **Group-level proof** (ARB-2c; contract §11.2, the `sense.usage` proof row). The companion
   writes a group from its first non-null reading of that group in the session; until then the
   statusLine writes it. A group has one writer at any
   moment; values are never blended (ARB-2a). Before the first response `context` is
   `{ window }` only (smoke A3), so `contextPercent` stays the statusLine's until a percent
   arrives.
3. **Absent is "no new figure".** A reading that omits a unit, and does not list it in
   `changed`, keeps the companion's last value for that group. `rateLimits: []` never clears
   the windows (the resume handshake is empty, smoke A2).
4. **No statusLine record** (opted out, foreign statusLine, blob not written yet): statusLine
   fields take their parse defaults (`''`, `null`, `false`).
5. **Lease loss** → `dropCompanion(sid)`: every group returns to the statusLine at once (ARB-4b).
6. `foldFleetTelemetry` reads `t.rateLimitsAtMs ?? t.updatedAtMs` when it picks the freshest
   window (`statusline-parse.ts:169-176`). Without this, a statusLine blob that only moved
   `linesAdded` would re-stamp a stale companion window as fresh: the "preferred source with no
   freshness bound" smell of lesson `framework/005`.

Adapter: `src/main/companion/ingest/telemetry-adapter.ts` + `usage-map-core.ts` (pure
wire → `CompanionPart`, clamps `percentUsed` to `[0, 1000]`, rejects non-finite numbers).

### 7.4 Plan usage

Today the renderer already merges the fleet's windows with the `/usage` snapshot, freshest
wins (`usage-format.ts:185-203`). Once `usage.measured` feeds the store, limits reach the
renderer through that path. The `planUsage` family therefore arbitrates one thing: **whether
the poll spawns**.

`src/main/companion/ingest/plan-usage-gate-core.ts` (pure):

```ts
export interface PlanUsageGateState {
  lastLeasedReadingAt: number | null
}
export function noteReading(
  s,
  r: { owned: boolean; windows: number; hostNow: number }
): PlanUsageGateState
export function shouldPoll(s, hostNow: number): boolean // true when null or older than PLAN_USAGE_STALE_MS
```

- `noteReading` advances only for a reading with at least one known window, from a binding that
  owns `planUsage`. Host receive time is used, never the mod's clock.
- `usage.ts`: the interval tick (`:87`) and the refresh on focus (`:86`) call `shouldPoll`
  first and return when it is false. The timer, `runUsageOnce`, single-flight and
  `buildSnapshot` are unchanged (ARB-8). `usage:refresh` always spawns. `usage:get` still
  spawns once when no snapshot exists (`:101-104`), so a cold start always has one.
- **Per-model weekly rows** exist only in `/usage` prose (T199 §3.3). They refresh whenever the
  fallback runs: on cold start, on a manual refresh, and whenever no session reported for 90 s.
- A session that is idle sends no measure, so an idle fleet falls back to the poll by itself.
  Nothing here depends on a rate-limit-only measure (C5, CQ14).
- If T199 lands first, `shouldPoll` gates its trigger (b) the same way.

### 7.5 Per-turn accounting (slice S3)

`src/main/companion/ingest/turn-ledger-core.ts` (pure) + `turn-ledger.ts` (shell). Files
`<userData>/companion/turns/<YYYY-MM>.ndjson`, mode `0600`: Harnu's own data, one ledger per
instance, never a file shared between instances (lesson `framework/005`). `usage-history.ts`
persists under `~/.claude/om2tab/usage-history/` (`:86`); that directory is shared by every
Harnu instance and is deliberately **not** used here. The ledger honours usage history's opt-out
and retention setting. Written in `shadow` and `active`.

```ts
type TurnLedgerRecord =
  | {
      v: 1
      k: 'open'
      t: number
      sessionId: string
      projectPath: string
      costAtOpen: number | null
      fresh: boolean
    }
  | {
      v: 1
      k: 'turn'
      t: number
      sessionId: string
      turnId: string
      agentId?: string
      model: string | null
      tokens: { input: number; output: number; cacheRead: number; cacheCreation: number } | null
      durationMs: number
      wallMs: number | null
      reason: string
      costUsd: number | null
      costBasis: 'measured' | 'parent' | 'none'
    }
  | { v: 1; k: 'other'; t: number; sessionId: string; costUsd: number } // spend outside a main turn
  | {
      v: 1
      k: 'aux' // named non-turn usage, from recordAuxSpend
      t: number
      sessionId: string
      kind: 'fork' | 'complete' | 'compaction'
      tokens: { input: number; output: number; cacheRead: number; cacheCreation: number }
    }
  | {
      v: 1
      k: 'gap'
      t: number
      sessionId: string
      why: 'lease-lost' | 'dropped' | 'host-restart' | 'cost-reset'
    }
  | { v: 1; k: 'close'; t: number; sessionId: string; costAtClose: number | null }
```

Per-session state: `{ lastCost, open: { turnId, startedTs, accrued } | null, settling | null }`.

| Input                                    | Step                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| first `usage.measured` with `costUsd`    | `lastCost = c`; write `open { costAtOpen: c, fresh: c === 0 }`. No delta: a resumed session's history is never attributed (smoke A2) |
| `usage.measured`, `δ = c − lastCost < 0` | write `gap { cost-reset }`; `lastCost = c`                                                                                           |
| `usage.measured`, `δ ≥ 0`                | `settling` → add `δ`, write its `turn` (`measured`), clear · else `open` → `accrued += δ` · else `δ > 0` → write `other { δ }`       |
| `turn.started` (main)                    | flush `settling` if any; `open = { turnId, ts, accrued: 0 }`                                                                         |
| `turn.completed` (main)                  | move `open` to `settling` with its usage; deadline `COST_SETTLE_MS` (the measure follows by about 13 ms, smoke A4)                   |
| clock tick past the deadline             | write the `turn` with `costUsd = accrued`, or `null` / `none` when the session has no cost ledger                                    |
| `turn.completed` with `agentId`          | write `turn` at once with `costUsd: null`, `costBasis: 'parent'` (smoke D7)                                                          |
| `usage` absent (interrupt, API error)    | `tokens: null`; the record is still written (types L12479: "absent when nothing counted")                                            |
| lease loss, `dropped > 0`, host restart  | write `gap`; drop the in-memory state                                                                                                |
| `session.rebound`                        | `close` the old sid; the new sid opens on its first reading                                                                          |

`wallMs` is host time between the turn's two edges; it sits beside the CLI's `durationMs` so
Q14 can be answered from data. `other` records are the "separate" spend of D11: fork, complete,
compaction, and a background subagent that finished outside a main turn.

```ts
export function recordAuxSpend(rec: {
  kind: 'fork' | 'complete' | 'compaction'
  sid: Sid
  usage: AuxUsage
  ts: number
}): void
```

P4W4 and P4W5 call it with the usage their own result carries; it writes an `aux` record. An
`aux` record names the tokens; the dollars of the same request still arrive as a cost delta and
are written once, as `other` (or inside the open turn). Calibration sums USD from `turn` and
`other` only, so nothing is counted twice.

**Feeding the Usage Dashboard.** The JSONL scan (`usage-cost.ts`, `usage-cost-core.ts`) keeps
producing the `(day, model, session)` buckets (`usage-cost-core.ts:507-519`): it stays the
structure and the only source for history (ARB-8). For a **covered** session the measured total
calibrates the scan's price:

- Covered = the ledger has an `open { fresh: true }` (that is, `costAtOpen === 0`), no `gap`,
  and `telemetry` is `active`. Only sessions this instance spawned can be covered.
- `calibrateBuckets(buckets, factors)` (new, pure, in `usage-cost-core.ts`), applied after the
  per-file cache merge in `buildUsageCostSummary` and `buildUsageBiRawData`
  (`usage-cost.ts:377`, `:457`): for each covered `(sessionId, day)`,
  `factor = measuredUsd(day) / scanUsd(day)`, and each of that pair's buckets gets
  `costUsd × factor`. Tokens, `requestCount`, `tierLabel` and `estimated` are untouched.
- Measured USD per day = the sum of that day's `turn` and `other` records. The split across
  models stays the scan's (list-price weights); the session-day total becomes the CLI's own.
- A factor outside `[0.5, 2]`, or a zero scan cost, is not applied; it is recorded as a parity
  fact and the scan value stands.

Nothing in the renderer changes. `usage-history.ts` keeps receiving the fleet reading through
the store's commit.

## 8. Arbitration & fallback

| Situation                               | telemetry                                                                                               | planUsage                                     | turn ledger / calibration                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| Mode `shadow`                           | statusLine writes everything; companion part → parity ledger                                            | poll runs as today                            | ledger written, never applied                  |
| Mod absent, CLI too old, policy         | statusLine                                                                                              | poll                                          | no records; scan                               |
| Kill switch turned off mid-session      | `conn` revoked, re-hello answered `enable: []`; `dropCompanion` for every session at once (no TTL wait) | gate state cleared → poll                     | `gap`; sessions uncovered; scan stands         |
| statusLine opted out or foreign         | companion groups only; other fields at defaults; history still fed                                      | as owned                                      | as owned                                       |
| Lease lost mid-session                  | `dropCompanion`; statusLine resumes on its next blob; sticky                                            | that session stops counting; poll within 90 s | `gap`; session uncovered; scan stands          |
| Host restart                            | cache restores composed values; groups re-prove after re-hello                                          | gate state is empty → poll                    | `gap { host-restart }`; new baseline, no delta |
| Hot reload                              | a `read` re-sends cumulative figures; nothing double-counts                                             | unchanged                                     | unchanged (the baseline is host-side)          |
| `/clear`                                | new sid, new entry; the old entry ages out by `TELEMETRY_TTL_MS`                                        | unchanged                                     | `close` + `open { fresh }`                     |
| `--resume`                              | first reading has `rateLimits: []` → windows keep the statusLine's                                      | not a reading                                 | `open { fresh: false }` → never covered        |
| Headless `-p`                           | owned through the heartbeat lease                                                                       | counts as a leased reading                    | written                                        |
| API-key user (`rateLimits` always `[]`) | cost and context owned; windows stay null                                                               | never fresh → poll → `unavailable`, as today  | written                                        |
| Companion silent with a live lease      | values are the last known; windows keep their own `rateLimitsAtMs`                                      | poll resumes after 90 s; freshest wins        | unchanged                                      |
| Usage probes (`usage.ts`, `haiku.ts`)   | never injected (D1); no binding                                                                         | —                                             | —                                              |

## 9. Security requirements

Inherits SEC-1…SEC-9. Wave-specific:

- The sensor passes `next(e)` through; it reads figures and sends numbers. No prompt text, no
  answer text, no `context.breakdown` (it is never requested).
- Every number is validated host-side (finite, in range) before it reaches the store or the
  ledger (SEC-3c). A forged reading can misreport a percentage; it cannot grant anything.
- The companion path writes nothing to `~/.claude/settings.json` and removes nothing from it
  (SEC-9f and lesson `framework/005`).
- The turn ledger stores ids, counts and dollars only.

## 10. UX & copy

No new surface and no new string. Behaviour once the families are `active`: the footer, hover
preview and usage panel update without Harnu owning the statusLine slot for those figures; a
user with their own statusLine gets cost, context and limits for the first time; the `/usage`
process stops spawning while sessions are working. Eight fields still need Harnu's statusLine:
`linesAdded`, `linesRemoved`, `thinkingEnabled`, `outputStyle`, `pr`, `modelName`, `durationMs`
and `effortLevel`. `docs/user/usage.md` says so plainly, and calls the mod "Harnu mod".

## 11. Acceptance criteria

```
AC-P1W6-1 [mod-test] Given a session.measure event with the smoke A3 payload, When the hook
  runs, Then one usage.measured {source: measure} is emitted with the same figures and next(e)
  is returned unchanged.
  Evidence: resources/companion/tests/usage-sensor.test.ts › "measure is forwarded"
AC-P1W6-2 [mod-test] Given a resync response, When the mod handles it, Then it emits one
  usage.measured {source: read} carrying startedAt.
  Evidence: resources/companion/tests/usage-sensor.test.ts › "read on resync"
AC-P1W6-3 [unit] Given the smoke A3 payload and the statusLine blob of the same session, When
  both are mapped, Then costUsd, contextPercent, contextWindowSize and both windows are equal
  and resetsAtMs equals Date.parse of the ISO string.
  Evidence: tests/companion/usage-map-core.test.ts › "equals the statusLine figures"
AC-P1W6-4 [unit] Given an owned session with both parts, When compose runs, Then linesAdded,
  linesRemoved, thinkingEnabled, outputStyle, pr, modelName, durationMs and effortLevel equal
  the statusLine's and every other field equals the companion's.
  Evidence: tests/telemetry-compose-core.test.ts › "field partition"
AC-P1W6-5 [unit] Given mode shadow, When a companion part is ingested, Then the payload equals
  the statusLine-only payload.
  Evidence: tests/telemetry-compose-core.test.ts › "shadow never writes"
AC-P1W6-6 [unit] Given an owned session whose reading has rateLimits [], When it is ingested,
  Then the previous windows are unchanged.
  Evidence: tests/telemetry-compose-core.test.ts › "empty rate limits are not a reading"
AC-P1W6-7 [unit] Given the statusLine writer disabled and a companion-owned session, When a
  reading is ingested, Then captureFleet is called once with that reading's windows.
  Evidence: tests/telemetry-store.test.ts › "history is fed from the companion path"
  Guards: master R14
AC-P1W6-8 [unit] Given a companion window stamped at T and a later statusLine blob that changes
  only linesAdded, When the fleet is folded, Then fiveHourAtMs is T.
  Evidence: tests/statusline-parse.test.ts › "window freshness follows the reading"
  Guards: lesson framework/005
AC-P1W6-9 [unit] Given an owned session, When its lease is lost, Then the next payload equals
  the statusLine-only payload for that session.
  Evidence: tests/telemetry-store.test.ts › "lease loss returns every group"
AC-P1W6-10 [unit] Given the companion adapter and store, When any ingest or drop runs, Then
  updateClaudeSettings and stripStatusLine are never called.
  Evidence: tests/telemetry-store.test.ts › "the companion path never touches settings.json"
  Guards: lesson framework/005
AC-P1W6-11 [unit] Given the main-process sources, When the dependency test runs, Then
  statusline.ts and statusline-install.ts import nothing under src/main/companion, so install,
  self-heal and exit cleanup cannot be conditioned on companion state.
  Evidence: tests/companion/statusline-independence.test.ts › "no companion import"; the
  existing tests/statusline-install.test.ts › "strict mode (exactCommand — the exit-cleanup
  identity)" stays unchanged
  Guards: lesson framework/005
AC-P1W6-12 [unit] Given an owned reading 30 s old, When the poll timer ticks, Then no process is
  spawned.
  Evidence: tests/usage-poller.test.ts › "a fresh leased reading suppresses the poll"
AC-P1W6-13 [unit] Given a reading from a session in shadow, When shouldPoll runs, Then it
  returns true.
  Evidence: tests/companion/plan-usage-gate-core.test.ts › "only owned readings suppress"
AC-P1W6-14 [unit] Given the gate closed, When usage:refresh is invoked, Then a spawn happens.
  Evidence: tests/usage-poller.test.ts › "manual refresh bypasses the gate"
AC-P1W6-15 [unit] Given the three turns of smoke D7 and its three cost readings, When the ledger
  core replays them, Then token sums are 38 / 425 / 81576 / 32680, the subagent turn has
  costBasis parent, and the main turns' costs sum to 0.06216485.
  Evidence: tests/companion/turn-ledger-core.test.ts › "smoke D7 replay"
AC-P1W6-16 [unit] Given a first reading with cost 0.19, When later deltas arrive, Then the open
  record has fresh false and the session is not covered.
  Evidence: tests/companion/turn-ledger-core.test.ts › "a resumed session is never calibrated"
AC-P1W6-17 [unit] Given a turn.completed without usage, When it is ledgered, Then the record has
  tokens null and is still written.
  Evidence: tests/companion/turn-ledger-core.test.ts › "error turn without usage" (Q13b)
AC-P1W6-18 [unit] Given a cost increase with no turn open or settling, When it is ledgered,
  Then one other record carries the delta.
  Evidence: tests/companion/turn-ledger-core.test.ts › "spend outside a turn is separate"
AC-P1W6-19 [unit] Given a covered session-day with scan cost 1.00 and measured 1.10, When
  calibrateBuckets runs, Then its buckets sum to 1.10 with tokens unchanged.
  Evidence: tests/usage-cost-core.test.ts › "calibration"
AC-P1W6-20 [integration] Given a real claude -p with the mod under a temp HOME, When one turn
  completes, Then the fake host received usage.measured whose cost equals the CLI's
  result.total_cost_usd.
  Evidence: tests/cli/usage.cli.test.ts › "measure equals the CLI total"
AC-P1W6-21 [integration] Given the same run, When the read reading arrives, Then the evidence
  file records the value of model, and the test asserts it is a non-empty string.
  Evidence: tests/cli/usage.cli.test.ts › "session.model value" (Q13a)
AC-P1W6-22 [live-verify] Given two instances with separate userData and a companion-owned
  session in the first, When the second instance quits, Then the first keeps receiving cost and
  context for that session.
  Evidence: LV-P1W6-b
  Guards: lesson framework/005
AC-P1W6-23 [live-verify] Given an idle leased session and a second session spending tokens,
  When the five-hour window moves a point, Then the evidence file records whether the idle
  session emitted usage.measured with changed ["rateLimits"].
  Evidence: LV-P1W6-c (CQ14)
AC-P1W6-24 [live-verify] Given a turn that waits 30 s on a permission dialog, When it completes,
  Then the ledger record shows durationMs and wallMs, and the evidence file states their gap.
  Evidence: LV-P1W6-d (Q14)
AC-P1W6-25 [live-verify] Given both families active and a working session, When five minutes
  pass, Then no claude -p "/usage" process was spawned and the footer windows moved.
  Evidence: LV-P1W6-a
AC-P1W6-26 [unit] Given an owned session, When the kill switch turns off, Then the next payload
  equals the statusLine-only payload for every session and shouldPoll returns true.
  Evidence: tests/telemetry-store.test.ts › "kill switch mid-session"
AC-P1W6-27 [unit] Given recordAuxSpend {kind: fork} and a later cost delta with no turn open,
  When the ledger is read, Then it holds one aux record with the tokens and one other record
  with the delta, and calibration counts the delta once.
  Evidence: tests/companion/turn-ledger-core.test.ts › "aux spend is named, counted once"
AC-P1W6-28 [unit] Given a reading with context.tokens 49284 and a later one without tokens, When
  lastContextTokens is called, Then it returns 49284; for an unknown sid it returns null.
  Evidence: tests/telemetry-store.test.ts › "last context tokens"
AC-P1W6-29 [unit] Given slice S1 alone (no turn.completed ever ingested), When compose runs for
  an owned session, Then modelId equals the statusLine's.
  Evidence: tests/telemetry-compose-core.test.ts › "model group waits for the turn sensor"
AC-P1W6-30 [unit] Given the turn ledger's path resolver, When it runs, Then the path is under
  userData and not under the home .claude directory.
  Evidence: tests/companion/turn-ledger.test.ts › "ledger is per instance"
  Guards: lesson framework/005

AC-P1W6-31 [unit] Given an owned reading 91 s old, When the poll timer ticks, Then one process is spawned.
  Evidence: tests/usage-poller.test.ts › "a stale leased reading lets the poll run"

AC-P1W6-32 [unit] Given a covered session-day with scan cost 1.00 and measured 3.00, When
  calibrateBuckets runs, Then the buckets are unchanged.
  Evidence: tests/usage-cost-core.test.ts › "calibration guard"
```

L4 cost cap: haiku, two model calls, 0.03 USD, behind `HARNU_CLI_LIVE=1` (QA-8).

**Live-verify recipes**

- **LV-P1W6-a.** (1) Second isolated instance; set `telemetry` and `planUsage` to `active`, add
  the folder to the ramp. (2) Start a session, run three turns. (3) Over CDP read
  `telemetryGet()` and compare with `/cost` and `/context` in the terminal. (4) Watch the
  process list for five minutes for a `/usage` spawn. (5) Stop sending prompts for two
  minutes; confirm one spawn. (6) Export both parity ledgers.
- **LV-P1W6-b.** (1) Production-like instance A with an owned session. (2) Start instance B
  with another `--user-data-dir`, then quit it. (3) Run a turn in A's session; the footer
  updates. (4) Read `~/.claude/settings.json`: A's statusLine entry is intact.
- **LV-P1W6-c.** (1) Session A idle with a live lease. (2) Session B, no mod, runs prompts until
  the five-hour percent rises by one. (3) Read A's events at the fake-host log or the ledger.
- **LV-P1W6-d.** (1) Trigger a Write that asks; wait 30 s; approve. (2) Read the turn record.

## 12. Docs deliverables

| Doc                      | Change                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`           | With the flip: `Changed` — cost, context and plan limits come from the session itself; the `/usage` check runs only when no session reported recently. Nothing while `shadow`. |
| `docs/harnu-features.md` | none.                                                                                                                                                                          |
| `docs/user/usage.md`     | Where each figure comes from; what still needs the statusLine; per-model weekly rows refresh less often; dashboard cost for new sessions follows the CLI's own total.          |
| `docs/user/settings.md`  | The statusLine switch hint: what turning it off now loses (the eight fields of §7.3).                                                                                          |
| `design.md`, i18n        | none (no new string; existing hints keep their keys).                                                                                                                          |
| `01-contract.md`         | none: already merged (§7.2). `contract.ts` and the fixtures land with the code (DOC-7).                                                                                        |

`src/main/telemetry-store.ts` is a new top-level main file, so the user-docs gate requires the
`docs/user/usage.md` change in the same PR.

## 13. Rollout & parity gate

**`telemetry`** (requires `sense.usage` proven). Shadow comparison: each statusLine blob and
each `usage.measured` records `ctx { pct, window }`, `cost { usd }`, `rl { h5, d7, r5, r7 }`.
Rule: pair each statusLine sample with the nearest companion sample of the session within 5 s;
equal when `|Δpct| ≤ 1`, `|Δusd| ≤ 0.01`, `|Δ rate| ≤ 1`, resets within 60 s.

| Class | Explained                                                                                    |
| ----- | -------------------------------------------------------------------------------------------- |
| T1    | No pair in the window (the statusLine renders more often; measures fold bursts, types L4118) |
| T2    | Companion context missing right after an aborted turn                                        |
| T3    | First reading of a resumed session (`rateLimits: []`)                                        |

Gate: 500 paired samples over at least 50 sessions, zero unexplained.

**`planUsage`.** At every poll result, compare the freshest owned-eligible reading with the
snapshot's `session` and `weekAll`: `|Δ| ≤ 1` point, reset within 5 min. Explained: P1 reading
older than 90 s; P2 the pair straddles a window reset. Gate: 200 comparisons over at least
7 days, including one five-hour reset, zero unexplained.

**Cost calibration** rides on `telemetry: active`. Extra criterion before that flip: over 100
covered sessions, ledger tokens are within 1% of the scan's (a scan surplus is explained as
non-turn requests; a ledger surplus is unexplained) and every factor lies in `[0.5, 2]`.

Traces are committed under `tests/fixtures/companion-parity/{telemetry,planUsage}/` (QA-9).

**Demotes** (never deletes): statusLine ingest for the `cost`, `context`, `rateLimits` and
`model` groups; the `/usage` poll to "no leased reading in 90 s"; the JSONL scan's price to
"history and uncovered sessions". The statusLine install, its self-heal and its exit cleanup
are untouched.

## 14. Open questions

| #    | Question                                                                                | Fallback designed                                                                                                                        | Owner |
| ---- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Q13a | Is `$.session.model()` an id or a display name? Which `effortLevel` values exist?       | `modelName` and `effortLevel` stay on the statusLine; AC-P1W6-21 records the value                                                       | P1W6  |
| Q13b | API-error turns without usage (C5)                                                      | `tokens: null`; AC-P1W6-17 (unit only: no cheap way to force one live)                                                                   | P1W6  |
| Q14  | Does `durationMs` exclude dialog time?                                                  | Both `durationMs` and `wallMs` are stored; AC-P1W6-24                                                                                    | P1W6  |
| CQ14 | Does `session.measure` fire on a rate-limit move alone?                                 | Never relied on; the types say windows are "what the last response reported" (L10389), so an idle session likely cannot know; AC-P1W6-23 | P1W6  |
| OQ-a | Does the JSONL scan count requests that no `turn.complete` covers (compaction, titles)? | Calibration guard and the 1% rule; scan stands on a miss                                                                                 | P1W6  |
| OQ-b | `spend_limit` has no slot in `SessionTelemetry`                                         | Recorded in the parity ledger only                                                                                                       | later |
| Q29  | `resetsAt` of a rate-limited turn (finding F1)                                          | Cross-reference only: owned by P1W5 (AC-P1W5-27). The five-hour window held here is a candidate source, not wired                        | P1W5  |

## 15. Risks

| Risk                                                                             | Mitigation                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| R14: usage history goes dark when statusLine ingest is demoted                   | `captureFleet` is in the store's commit; AC-P1W6-7                                   |
| A stale companion window shadows a fresh poll (the 13-hour freeze of lesson 005) | `rateLimitsAtMs`; the 90 s gate; the renderer's freshest-wins merge; AC-P1W6-8, -12  |
| The extraction of the store changes footer behaviour                             | Compose is pure and table-tested; the statusLine-only path is byte-equal (AC-P1W6-5) |
| Calibration shows a wrong dashboard number                                       | Covered sessions only; factor guard; `shadow` first; scan untouched on a miss        |
| Double counting after a reload, a resume or a host restart                       | Cumulative figures; baseline-only first reading; `gap` uncovers the session          |
| The mod's clock is wrong                                                         | Host receive time for freshness and the 90 s gate                                    |
| S3 lands before P1W5                                                             | The slice is stacked on P1W5; S1–S2 do not need it                                   |
