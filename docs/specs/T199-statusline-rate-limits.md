# T199 — Rate limits from the statusline payload: demote the `/usage` poller to a cold-start fallback

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T199-read-rate-limits-from-the-statusline-payload-and-retire-the.md`

## 1. Goal, and what is actually left to do

The card reads "start reading `rate_limits`". **That part already shipped.** `statusline-parse.ts:114,142-145`
parses `rate_limits.five_hour` / `rate_limits.seven_day`, `foldFleetTelemetry` (`:155-188`) folds them
into a fleet aggregate with per-window provenance timestamps, and the renderer already merges the two
sources freshest-wins (`usage-format.ts:185-203`). The card's file:line refs are stale on this point —
`statusline-parse.ts:137` is `exceeds_200k_tokens`, not `resets_at`; `resets_at` is read at `:81-82`.

So T199 is **only** the second half: _can the `claude -p "/usage"` process go away?_

Why it is worth killing: `usage.ts:44-53` spawns a full `claude` child every 90 s (`:20`) while focused
(`:107-113`), with a 20 s timeout (`:21`); `--bare` is forbidden because it forces API-key auth and breaks
`/usage` under subscription OAuth (`:30-36`); cwd is forced to `homedir()` so a project's `CLAUDE.md`/hooks
don't load (`:34,48`); the parser is prose regexes over English CLI copy (`usage-parse.ts:71-73`);
`refresh()` cannot retry because `/usage` returns preamble-only for ~20–40 s after a recent call
(`usage.ts:62-69`); and each spawn leaves a transcript in `~/.claude/projects/` — exactly the pollution
the 2026-07-27 CHANGELOG entry (`CHANGELOG.md:216-231`) had to filter out.

The honest answer this spec reaches: **the poller cannot be deleted, but it can stop being a poller.**

## 2. Current behaviour, verified

### 2.1 Path A — the `/usage` poll

| Step                                                                                  | Evidence                                                                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `execFile(bin, ['-p','/usage','--model','haiku'], { cwd: homedir(), timeout: 20 s })` | `src/main/usage.ts:44-53`                                               |
| never rejects; failure → `{ ok: false }`                                              | `usage.ts:56`                                                           |
| single-flight, pushes `usage:updated`                                                 | `usage.ts:70-82`                                                        |
| 90 s interval, armed on `browser-window-focus`, cleared on blur                       | `usage.ts:20,84-95,107-113`                                             |
| `usage:get` / `usage:refresh` handlers                                                | `usage.ts:101-105`; registered `index.ts:532`, torn down `index.ts:933` |
| prose parse → `session` / `week_all` / **per-model** buckets                          | `usage-parse.ts:71-73,130-150`                                          |
| `buildSnapshot` fold: keeps last-good as `stale`, never a fake downgrade              | `usage-parse.ts:168-199`                                                |
| preload surface                                                                       | `src/preload/index.ts:1529-1532`                                        |

Data produced: `UsageSnapshot` = `{ session, weekAll, perModel[], available, subscription, fetchedAtMs, stale, status }`
(`usage-parse.ts:17-61`). **`perModel` has no statusline equivalent** — see §3.3.

### 2.2 Path B — the statusline inbox

Capy writes a `statusLine` entry into `~/.claude/settings.json` pointing at a POSIX writer script
(`statusline-install.ts:39-54`) that dumps the JSON blob Claude Code pipes on stdin into
`<userData>/statusline/inbox/<ts>-<pid>.json` (`statusline.ts:63-65`). A chokidar watcher tails that
dir (`statusline.ts:265-270`), parses each blob, keeps a per-session map, deletes the file, and
debounce-emits `telemetry:updated` (`statusline.ts:237-263`). The map is TTL'd at 24 h
(`statusline-parse.ts:66`) and persisted across restarts (`statusline.ts:208-235`).

Install is non-destructive: a **foreign** `statusLine` is preserved and Capy's is parked under
`statusLine_capy` (`statusline-install.ts:84-104`) — in that case Capy receives **nothing**. A 60 s
self-heal re-installs only when the key has vanished entirely (`statusline.ts:169-188`).

Fields parsed today (`statusline-parse.ts:126-147`): `session_id`, `cwd` / `workspace.current_dir`,
`model.{id,display_name}`, `cost.*`, `context_window.{used_percentage,context_window_size}`,
`exceeds_200k_tokens`, `effort.level`, `thinking.enabled`, `output_style.name`, `pr.*`,
`rate_limits.{five_hour,seven_day}`. Contrary to the audit §3.2 list, `context_window.used_percentage`,
`effort.level` and `thinking.enabled` are **not** dropped — they are read at `:135,138,139`.

Genuinely dropped: the **`worktree` object** (CC v2.1.69) and the GitHub **repo** half of the v2.1.145
payload (Capy takes `pr`, not the repo fields). Out of scope for T199 — they belong to the PR Stack /
worktree-lineage cards. **Shape to be confirmed against a real payload before implementation** for both.

`rate_limits` handling is already defensive: `used_percentage` absent → the whole window is `null`, never
a fake `0` (`statusline-parse.ts:76-83`), and `resets_at` is normalized epoch-s → epoch-ms (`:81-82`).

### 2.3 Consumers — every one must keep working

| Consumer                            | File:line                                                                                               | Source it reads today                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Renderer store `rateLimits`         | `stores/usage.ts:98-102`                                                                                | **merged** (`mergeRateWindows`)                |
| `mergeRateWindows` / `pickFreshest` | `components/usage-format.ts:166-203`                                                                    | both; demotes any window past its `resetsAtMs` |
| Footer 5h/7d chips                  | `StatusFooter.vue:155-167,489-518`                                                                      | store `rateLimits`                             |
| `UsagePanel` 5h/7d meters           | `UsagePanel.vue:145-150`                                                                                | store `rateLimits`                             |
| `UsagePanel` per-model rows         | `UsagePanel.vue:151-154` + `store.buckets` (`stores/usage.ts:142-150`)                                  | **`/usage` only**                              |
| Panel visibility + skeleton         | `UsagePanel.vue:175,193-199` ← `store.status` (`stores/usage.ts:134-137`)                               | falls through to `snapshot.status`             |
| 5-hour reset notification           | `sessions.ts:4527-4530` watch → `checkUsageResetNotification` (`:3467`) → `usage-reset-notify.ts:37-49` | store `rateLimits.fiveHour.resetsAtMs`         |
| Usage history capture               | `usage-history.ts:205-215`, called `statusline.ts:247`                                                  | **statusline only**                            |
| BI "now" block / Dashboard KPIs     | `usage-bi.ts:119-152` via `getTelemetryPayload()` (`statusline.ts:199-201`)                             | **statusline only**                            |
| Plan-fit calculator                 | `usage-history-core.ts` windows, fed by the capture above                                               | **statusline only**                            |

Net: history, BI, Dashboard and plan-fit are **already** poller-free. Only the store, the two live
meters, the panel's `status`, the per-model rows, and the reset notification still touch `UsageSnapshot`.

### 2.4 The degradation question — verified, and it is not zeros

With an empty/stale inbox and no poller: `foldFleetTelemetry({})` → all-null windows, `sessionCount: 0`
(`statusline-parse.ts:180-187`) → `mergeRateWindows` → `rateLimits === null` (`stores/usage.ts:100`),
`fleetSummary === null` (`:119-123`). **No zeros are rendered as truth** — footer chips are `v-if`-gated
on a non-null pct (`StatusFooter.vue:489,505`).

The real failure is worse: `status` falls through to `snapshot.value?.status ?? 'loading'`
(`stores/usage.ts:136`). Delete the poller and `snapshot` is permanently `null`, so **`status` pins at
`loading` forever** — `UsagePanel` renders three skeleton bars with `aria-busy` for the life of the app
(`UsagePanel.vue:178,193-199`). A permanent skeleton is a worse lie than a hidden panel.

Subtler: `pickFreshest` demotes windows past their reset **but still returns the freshest when every
candidate is past it** (`usage-format.ts:173-175`) — deliberately, "last known beats blank". Today a fresh
poll rescues that. Without it a 20-hour-old blob reading 90 % stays on screen, caveated only by the
`usage.updatedAgo` line (`UsagePanel.vue:159-163`), which the footer chips do not show at all.

## 3. Decision

### 3.1 Demote, do not delete — and the cold-start answer

**The poller must survive.** Three verified reasons the statusline cannot cover on its own:

1. **It needs a turn.** The writer runs only when Claude Code renders a status line, i.e. per turn of a
   live session. `/usage` works with **no session running at all**. Capy's own code already concedes this:
   `statusline.ts:290` logs _"setup failed (degrading to /usage)"_.
2. **It needs the key to be ours.** A user with their own `statusLine` gets `foreignPreserved`
   (`statusline-install.ts:98-103`) and Capy receives nothing, indefinitely.
3. **Cold start after 24 h idle.** The persisted cache is TTL-filtered on load (`statusline.ts:217`), so a
   machine idle for a day opens to an empty cockpit.

What changes: **`usage.ts` stops being a 90 s poller and becomes an on-demand cold-start/staleness fallback.**

- Delete `POLL_INTERVAL_MS`, `startPolling`/`stopPolling` and the `browser-window-focus`/`blur` arming
  (`usage.ts:20,84-95,107-113,123-130`).
- Keep `runUsageOnce`, single-flight `refresh`, `buildSnapshot`, and both IPC handlers.
- Spawn on exactly three triggers: (a) app start when the seeded telemetry map yields **no** live
  rate-limit window; (b) the merged 5h window is `null` **or** past its `resetsAtMs`, at most once per
  `SPAWN_TIMEOUT_MS + cooldown` — i.e. gated so the ~20–40 s cooldown (`usage.ts:62-69`) can never be hit;
  (c) an explicit user refresh, which `usage:refresh` already serves.

Cost drops from ~40 spawns/hour of focus to typically **one per cold start**. Every workaround comment in
§1 stays justified because the spawn stays — this spec does not pretend otherwise.

### 3.2 Fix the permanent-skeleton hole

`stores/usage.ts:134-137` must resolve to `unavailable` (panel hides) rather than `loading` when the
fallback has run and produced nothing. Concretely: `loading` only while **neither** source has reported
_and_ no fallback attempt has completed; once a fallback attempt resolves with no data and the cockpit is
empty → `unavailable`. This makes AC #3 ("no blank/zero panel presented as truth") true for the first time,
including today's already-possible case where a user has disabled telemetry and `/usage` is unsupported.

### 3.3 Per-model buckets: kept, and say so

`rate_limits` carries only `five_hour` and `seven_day`. The per-model weekly rows
("Weekly · Sonnet", `usage-parse.ts:73`, rendered `UsagePanel.vue:151-154`, i18n `usage.perModel`
`en.json:955`) exist **only** in `/usage` prose. Deleting the poller silently removes a visible row from
the panel. Keeping the poller as a fallback keeps them — refreshed on cold start rather than every 90 s,
which is honest for a _weekly_ window. `store.buckets` (`stores/usage.ts:142-150`) is unchanged.

### 3.4 No CLI version gate needed

Capy has no `claude --version` probe (confirmed: the only `--version` hits are `it2-bridge.ts:324-328`
and a denylist entry at `claude-args.ts:143`). **T199 does not need one.** An older CLI emitting no
`rate_limits` yields `fiveHour: null` (`statusline-parse.ts:76-83`) and `mergeRateWindows` falls through
to the `/usage` bucket by itself. The card's "depends on the CLI-version gate" note can be dropped;
`docs/specs/T200-cli-version-detection.md` stays useful but is not a blocker here.

### 3.5 Alternatives rejected

- **Delete `usage.ts` outright** (the card's headline) — regresses cold start, foreign-statusLine users,
  and per-model rows (§3.1, §3.3).
- **Keep the 90 s poll, just prefer statusline** — that is today's behaviour; keeps every cost the card
  exists to remove.
- **`claude -p "/usage" --json-schema`** (audit §3.6) — fixes the fragile _parse_ but keeps the process,
  the cooldown and the transcript pollution. Its own card.
- **Synthesize a cold-start reading from `usage-history` JSONL** — history stores _past_ windows;
  replaying one as "now" is the stale-percentage lie §2.4 warns about.

### 3.6 Open questions — resolve before implementing

- Does headless `claude -p` invoke the `statusLine` command at all? If it does, the fallback spawn feeds
  the inbox and the trigger logic must not self-satisfy in a loop. **Confirm against a real run.**
- `resets_at` unit: parsed as epoch **seconds** (`statusline-parse.ts:81-82`) and asserted in
  `tests/statusline-parse.test.ts:60-61` against a synthetic fixture. **Shape to be confirmed against a
  real payload** — no captured production blob exists in the repo.
- The `usage-history` capture (`statusline.ts:247`) fires per inbox blob. If fallback spawns ever land in
  the inbox, sample cadence changes. Tied to the first question.

## 4. Acceptance

- The 90 s `/usage` interval and its focus/blur arming are gone; a focused idle app spawns **zero**
  `claude` children for usage.
- 5h/7d meters in `UsagePanel` and `StatusFooter`, the per-model rows, the reset notification, usage
  history capture, plan-fit and the Dashboard "now" KPIs all still show correct data — verified per row of
  the §2.3 table.
- Cold start with an empty inbox: exactly one fallback spawn; on success the panel shows real numbers, on
  failure the panel **hides** (`unavailable`) instead of pinning a skeleton.
- A foreign `statusLine` (`foreignPreserved`) still yields working meters via the fallback.
- No window past its `resetsAtMs` is ever the sole displayed value without the freshness line visible.
- `CHANGELOG.md` entry.

## 5. Test plan

| Test                                                                                                            | File                                                                                                                                                                              | Asserts                  |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| no interval is armed; `browser-window-focus` no longer triggers a spawn                                         | `tests/usage-poller.test.ts` — rewrites `describe('focus gating')` (`:200-208`)                                                                                                   | §3.1                     |
| `usage:get` / `usage:refresh` still registered; single-flight still dedupes                                     | `tests/usage-poller.test.ts:99-107,142-151` (existing, must stay green)                                                                                                           | §3.1                     |
| cold-start trigger spawns exactly once and does not re-spawn inside the cooldown                                | `tests/usage-poller.test.ts` (new `describe('fallback triggers')`)                                                                                                                | §3.1                     |
| preamble-only + no prior data still resolves without retry                                                      | `tests/usage-poller.test.ts:172-198` (existing)                                                                                                                                   | `usage-parse.ts:180-184` |
| prose parse, per-model buckets, `buildSnapshot` stale-keep                                                      | `tests/usage-parse.test.ts` — **kept, not retired** (card AC #4 is wrong here)                                                                                                    | §3.3                     |
| `rate_limits` → `fiveHour`/`sevenDay`, absent → null, one-window-only                                           | `tests/statusline-parse.test.ts:60-61,79-93` (existing)                                                                                                                           | §2.2                     |
| fleet fold picks freshest window + provenance ms; 24 h TTL drops stale                                          | `tests/statusline-parse.test.ts:177-214` (existing)                                                                                                                               | §2.2                     |
| freshest-wins merge incl. past-reset demotion and all-past fallback                                             | `tests/usage-format.test.ts:171-275` (existing, all 9 cases)                                                                                                                      | §2.4                     |
| store `status` → `unavailable` (not sticky `loading`) once the fallback resolved empty and the cockpit is empty | `tests/usage-store.test.ts` — new case beside `:131-152`                                                                                                                          | §3.2                     |
| store still reports `available` from statusline alone with `/usage` unavailable                                 | `tests/usage-store.test.ts:212-232` (existing)                                                                                                                                    | §2.3                     |
| `buckets` still returns session/weekAll/per-model in order                                                      | `tests/usage-store.test.ts:162-180` (existing)                                                                                                                                    | §3.3                     |
| reset notification fires on supersession, not on a clock crossing                                               | `tests/usage-reset-notify.test.ts` + `tests/usage-reset-notify-store.test.ts:31-133` (existing)                                                                                   | §2.3                     |
| panel renders ≥1 bar from a real snapshot                                                                       | `tests/e2e/plan-usage.spec.ts` — **needs updating**: it asserts the first bar width equals `snap.session.usedPercent` (`:112-114`), which is false once the merged 5h window wins | §2.3                     |

Coverage note: `src/main/usage.ts` is **not** in the `vitest.config.mts` exclude list, so it counts toward
the threshold — one more reason §3.1 shrinks it rather than deleting it.

## 6. Contracts touched

- **`CHANGELOG.md` — YES.** User-visible: the app stops running a background `claude` process every 90 s.
  `### Changed`, plain-English.
- **`docs/user/usage.md` — YES.** `:7` currently reads "using whichever of Claude's own status line or a
  periodic `/usage` poll is freshest". "Periodic" becomes wrong. One-sentence edit; no new page.
- **`docs/capy-features.md` — NO.** No MCP verb changes (`tool-catalog.ts` untouched), no ACK field, no
  grant/confirm semantics, no affordance the agent should offer. Nothing here is actionable by a session.
  Use `no-awareness` if the gate trips on an unrelated file.
- **`docs/user/` gate — satisfied** by the `usage.md` edit above. No new top-level component and no new
  top-level `src/main/` file (all edits are inside existing `usage.ts` / `stores/usage.ts`).
- **`design.md` — NO.** No new token, component variant, row height or motion; §6 "Plan usage" already
  specifies the three states (`ready`/`loading`/`unavailable`) this change makes reachable correctly.
- **i18n parity — NO new keys.** `usage.session`/`weekAll`/`perModel`/`rateLimitFiveHour`/`updatedAgo`
  (`en.json:953-961`, mirrored `pt-BR.json`) all survive; nothing is added or removed.
- **English-only — YES, applies.** Note the source audit (`.capy/out/claude-code-sync-audit.md`) is in
  Portuguese; nothing from it may be quoted verbatim into code, comments, docs or the CHANGELOG.
- **`README.md` network-activity table — NO.** `:61-69` lists outbound destinations; the fallback still
  reaches Anthropic via the user's own CLI, and that row is unchanged in kind, only in frequency.

## 7. Definition of done

- [ ] `usage.ts`: interval + focus/blur polling removed; `runUsageOnce`/`refresh`/IPC kept
- [ ] Cold-start + stale-window fallback triggers implemented, cooldown-safe
- [ ] `stores/usage.ts` `status` resolves to `unavailable` instead of a permanent `loading` skeleton
- [ ] Per-model buckets and the reset-notification watch verified unchanged
- [ ] §5 tests green, including the updated `focus gating` and `plan-usage.spec.ts` cases
- [ ] Open questions in §3.6 answered against a real CLI run and a real statusline blob
- [ ] `CHANGELOG.md` entry + `docs/user/usage.md:7` sentence updated
- [ ] `npm run typecheck` and `npm run build` pass
