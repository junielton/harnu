# Daily budget — a pacing row in the Plan usage popover

**Status:** design approved 2026-08-22 · not yet implemented
**Mockup:** `docs/superpowers/specs/2026-08-22-daily-budget-mockup.html` (+ `.png`)

## Problem

The Plan usage popover shows `7d limit 32% · resets in 4d`. Both numbers needed to
pace a week are on screen — what is left (68%) and how long it has to last (4 days)
— but the division is left to the user, who does it badly or not at all. Spending
freely on Monday quietly costs Thursday.

Capy should answer one question at a glance: **how much can I still spend today?**

Scope is deliberately narrow: a derived row in an existing popover, a setting, and
an alert. Not a new pane, not a hard cap, not enforcement — the number informs, it
never blocks a session.

## The model

A daily budget splits what is left of the weekly allowance across the working days
that remain.

```
baseline = 7d% at the start of today
spent    = 7d% now − baseline
budget   = (100 − baseline) ÷ working days left (today included)
bar      = spent ÷ budget
```

**The budget freezes at the start of the day.** This is the load-bearing decision.
If the denominator recalculated on every spend, the budget would grow as the day
went on, the bar could never reach 100%, and "over budget" would not exist as a
state. Freezing makes the day a fixed allowance you can actually overrun.

The consequence of an overrun is not a penalty Capy invents — it is arithmetic.
Tomorrow's budget recomputes from a smaller numerator over fewer days, so it shrinks
on its own. The over-budget state simply _reports_ that: `next 3 days drop to 12%/day`.

### Deriving the inputs

- **`7d% now` and `resetsAtMs`** — `useUsageStore().rateLimits.sevenDay`, already
  reactive and already merged by freshness across the statusLine cockpit and the
  `/usage` poll.
- **`baseline`** — yesterday's `DailyRollup.sevenDayPeak`. A 7d window is monotonic
  within its own period, so yesterday's peak _is_ the value at the moment today
  began. If today has a `weeklyReset` (the rollup already records one), the baseline
  is `0`: the new window started empty, and everything before the reset was charged
  to the previous week.
- **`working days left`** — days `d` where `d >= today` and `d < resetsAtMs`, counted
  only when `d`'s weekday is in the configured set. Today is included when today is a
  working day.

Nothing new is collected. `usage-history` already persists per-day rollups with
`sevenDayPeak` and `weeklyReset`; this feature only reads them.

## Components

Four pieces, each independently testable.

### 1. `src/main/daily-budget-core.ts` — pure

```ts
export interface DailyBudget {
  state: 'on-track' | 'near-limit' | 'over' | 'day-off' | 'unavailable'
  spentPct: number // points of the 7d allowance spent today
  budgetPct: number // today's frozen allowance; 0 when day-off/unavailable
  workingDaysLeft: number
  /** Per-day allowance the remaining days inherit — only set when `over`. */
  rebalancedPct: number | null
  remainingDays: number // working days after today, for the damage line
}

export function computeDailyBudget(input: {
  sevenDayPct: number | null
  resetsAtMs: number | null
  baselinePct: number | null
  workingDays: readonly number[] // 0 = Sunday … 6 = Saturday
  nowMs: number
}): DailyBudget
```

No electron, no i18n, no store access — the same pure/shell split as
`usage-history-core.ts` and `usage-reset-notify.ts`.

Thresholds are measured against the _budget_, not the window, and deliberately
differ from `barClass` in `usage-format.ts` (80/95): `< 80%` on-track, `80–99%`
near-limit, `>= 100%` over. There is no 95 step here — 100% of a daily budget is a
real event with a consequence, so it gets the red, and an intermediate warning
between 95 and 100 would be noise.

### 2. `usageHistory:dailyBudget` — narrow IPC

`buildSummary()` reads every sample file; the footer panel must not pay that at
boot. Main exposes a narrow handler returning `{ baselinePct, dayKey }`, memoized
per local day and invalidated on day rollover or on a newly-detected weekly reset.
The first call costs one rollup build; every later call is a map lookup.

The renderer combines that baseline with the live `sevenDay` window it already has,
so the row updates on every telemetry push with no further IPC.

### 3. `UsageMeter` gains a budget variant

The row reuses `UsageMeter` — same 3px track, same 11px type, same tabular numerals
— with three additions:

- **Value slot** renders `spent% / budget%` instead of a single percentage, and
  turns `--red` + weight 600 in the `over` state.
- **Sub-line** carries state text rather than a reset countdown, and changes what it
  reports per state: `on track` → `{budget − spent}% left today` (near-limit, when
  what remains is the actionable number) → `over · next {remainingDays} days drop to
{rebalanced}%/day`.
- **A hairline (`border-t --border`) separates it from the 5h/7d meters**, because
  it is derived. The reported limits and Capy's arithmetic must not read as peers.

`day-off` renders label and spent value with no track at all, sub-line
`day off · not counted against a budget`. `unavailable` renders nothing.

### 4. Threshold alert

A pure `shouldNotifyDailyBudget(...)` returning `80 | 100 | null`, wired the way
`checkUsageResetNotification` already wires `shouldNotifyUsageReset` in
`stores/sessions.ts`: a `watch()` on the computed budget calls it, and it dispatches
through the existing `dispatchNotification` (`channel: windowFocused ? 'toast' : 'os'`,
`sound: notifyPrefs.sound`).

Fires at most twice per day. The last-notified threshold is persisted per `dayKey`
(via `stores/persisted.ts`) so an app restart mid-day does not refire.

## Settings

`UsageHistoryPrefs` gains `workingDays: number[]`, default `[1,2,3,4,5,6]` (Mon–Sat).
It already has `getPrefs`/`setPrefs` IPC and disk persistence, so no new storage.

The control is a seven-toggle weekday row in the Usage settings pane, with a live
readout: `6 working days → today's budget 17%`.

`NotifyPrefs` gains `dailyBudget: boolean`, **default `true`** — unlike `usageReset`
(opt-in because it recurs every 5h), this fires at most twice a day and is the point
of the feature. It sits beside the other notification toggles.

## Edge cases

Every one of these resolves to a defined state, never a guessed number:

| Condition                                     | Result                                              |
| --------------------------------------------- | --------------------------------------------------- |
| No `sevenDay` window at all                   | `unavailable` — row hidden                          |
| No history yet (no yesterday rollup)          | `unavailable` — row hidden                          |
| Today is not a working day                    | `day-off` — spent shown, no bar, no alert           |
| Zero working days left before reset           | `unavailable` — row hidden                          |
| Every weekday unchecked                       | `unavailable` — feature effectively off             |
| 7d reset happened earlier today               | baseline `0`, budget recomputed over the new window |
| `baseline >= 100` (allowance exhausted)       | `over`, `budgetPct` 0, damage line omitted          |
| `7d% now < baseline` (clock skew, stale poll) | `spent` clamped to 0                                |

## Testing

- `daily-budget-core.test.ts` — the table above, plus the freeze property (budget
  constant across a day while spend rises) and the rebalance arithmetic.
- `daily-budget-notify.test.ts` — each threshold fires once, restart does not
  refire, day rollover re-arms.
- Component test for the three visual states and the `day-off` no-track render.

## Repo contracts

Per `CLAUDE.md`, this change is **not** complete without:

- **`CHANGELOG.md`** — dated entry under `### Added`.
- **`design.md` §6** — the Plan usage section documents rows, thresholds and
  anatomy; the derived row, its hairline, its value format and its four states go
  there **before** the Vue is written.
- **`docs/user/`** — user-visible: a new setting and a new notification.
- **i18n** — every key in **both** `en.json` and `pt-BR.json` in the same change, or
  `vue-tsc` breaks on the schema.

Not agent-facing: no MCP verb, no ACK shape, no grant semantics — `docs/capy-features.md`
is deliberately left alone.

## Explicitly out of scope

- Any footer-strip surface. The always-visible strip stays unchanged (decided).
- Enforcement. Capy never throttles, blocks, or pauses a session over this number.
- Inferring working days from the heatmap. The denominator must only change when
  the user changes it.
- Per-project or per-session budgets. The plan quota is account-wide; splitting it
  further would be fiction.
