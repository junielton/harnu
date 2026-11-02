# T611 — GitHub API budget: footer pill, self-throttle, attribution

Status: approved for delivery 2026-11-02. Visual contract: this folder's approved mockup
(`b--own-pill`, `d--settings-pane`; `mockup.json` status `approved`).

## Problem

Every `gh` call Harnu makes spends the operator's personal GitHub budget, shared with every
session, script and monitor on the same token: 5,000 REST requests/h and 5,000 GraphQL
points/h. On 2026-11-02 it ran dry; Harnu showed nothing and kept polling.

Scout findings (main checkout, 2026-11-02):

- **No choke point.** Six modules spawn `gh` themselves via `execFile` + `spawnEnvOnce()`
  (`src/main/appimage-env.ts:247`): `pr-stack.ts` (`runFile` :55), `reaper/scanner-shell.ts`
  (`runFile` :83), `review-ipc.ts` (`runGhStdin` :160, :208), `review-viewed-store.ts`
  (`gh()` :157), `gc/gc-remote-shell.ts` (`realRemoteRunners.gh` :27), `merge-batch-ipc.ts`
  (`realGh` :64).
- **Most spend is GraphQL.** `gh pr list/view`, `repo view` and `gh api graphql` are GraphQL;
  the two `gh api repos/...` calls in gc-remote-facts and `gh run list` are REST.
- **Delivered missions keep polling.** `deriveMissionSignals` (`mcp/tool-handlers.ts:4681`) runs
  for every non-`closed` mission (filter at `tool-handlers.ts:5121`), driven by two 20 s polls
  (renderer `stores/missions.ts:59`, companion `mission-state.ts:218`). Softened by
  `PR_CACHE_TTL_MS = 60_000` (`pr-stack.ts:151`) and `mainCiCache` (60 s, 2 calls per miss).
- **PR Stack** refreshes every `intervalMs` (default 90 s) while open, uncached.
- **Nothing** reads `X-RateLimit-*`, calls `gh api rate_limit` or backs off;
  `classifyGhFailure` (`pr-stack-core.ts:971`) buckets "rate limit" as `network`.

## Decisions

- D-1 Read the budget with `gh api rate_limit` every 60 s. That endpoint does not count
  against the REST limit. Default host only (github.com); GHE and multiple accounts are out
  of scope.
- D-2 The pill, the throttle and the attribution follow the **tighter bucket** — whichever of
  REST (`core`) or GraphQL has the lower remaining fraction. Both meters always show.
- D-3 Harnu counts its own calls per consumer and per resource (REST or GraphQL; each GraphQL
  call is counted as 1 point) inside the current window. "Outside Harnu" = GitHub's `used` −
  Harnu's count, clamped at 0. This is an estimate and the UI says so (mockup D's fine print).
- D-4 Throttle states: `normal` → `low` when the tighter bucket's remaining ≤ threshold (10, 15
  or 25 %, default 15) → `exhausted` at remaining 0. It returns to `normal` at that bucket's reset.
- D-5 Delivered missions are **never** checked on GitHub by default, at any budget. They keep
  their last known gates. The `Check delivered missions` switch (default off) restores it.
- D-6 Writes are never throttled (`gh pr review`, `pr merge`, viewed-state mutations): they are
  operator gestures.
- D-7 An MCP read verb `github_budget` exposes the same snapshot so agents can back off.

## Units

1 unit = 1 PR. U2 and U3 stack on U1 and are retargeted to `main` once U1 lands.

### U1 — core (main process)

- [ ] AC-1 — One shared `gh` runner in `src/main/` (e.g. `gh-runner.ts`); all six spawn sites
      above call it with a consumer tag (`missions`, `pr-stack`, `review`, `cleanup`, `steward`,
      `merge-batch`) and a resource (`rest` | `graphql`); no other `execFile('gh'…)` remains in
      `src/main` — verify: test (a grep-style test fails on a new direct spawn) — source: D-3,
      scout §1
- [ ] AC-2 — A budget poller runs `gh api rate_limit` every 60 s and parses `core` and
      `graphql` (limit, remaining, used, reset). When `gh` is missing or not authenticated the state
      is `unavailable` and polling backs off to 10 min, with no retry storm — verify: test — source:
      D-1
- [ ] AC-3 — Attribution: per consumer and per resource counts for the current window that
      reset at the window boundary; `outside = max(0, used − harnu)`; a 60-minute history in
      5-minute buckets (Harnu, Harnu while throttled, outside) and a 10-minute pace (calls/min,
      projected time to empty) — verify: test — source: D-3, mockup D tiles and chart
- [ ] AC-4 — Throttle state machine per D-4 on the tighter bucket, recording `since` on every
      transition — verify: test — source: D-2, D-4
- [ ] AC-5 — While `low`: the mission gate caches (`PR_CACHE_TTL_MS`, `mainCiCache`) stretch
      from 60 s to 5 min, and PR Stack's background interval refresh is skipped (a load on open still
      runs). Review and Cleanup are unchanged — verify: test — source: mockup B/D "Checks every"
      column
- [ ] AC-6 — While `exhausted`: every throttled read skips `gh` and serves the last known
      value; writes are never throttled (D-6); normal polling resumes on its own after the reset —
      verify: test — source: D-4, D-6
- [ ] AC-7 — `delivered` missions are skipped like `closed` in the GitHub derive, keeping their
      last known gates. With `checkDelivered: true` they are derived again — verify: test — source:
      D-5
- [ ] AC-8 — Prefs `{ threshold: 10|15|25, checkDelivered, pausePrStackWhenLow, notify }`
      persisted in `userData/github-budget-prefs.json` with normalize/clamp (copy
      `pr-stack-prefs.ts`); IPC `github-budget:snapshot`, `github-budget:prefs`,
      `github-budget:setPrefs` plus a pushed change event; typed preload API — verify: test +
      review — source: mockup D controls
- [ ] AC-9 — Rate-limit failures stop being classified as `network`: a `gh` stderr matching
      "rate limit" marks the budget `exhausted` immediately instead of waiting for the next
      poll — verify: test — source: scout §4
- [ ] AC-10 — The spec bundle (this folder, mockup and `spec.md`) is committed at
      `docs/specs/2026-11-02-github-rate-limit/`; `CHANGELOG.md` and a `docs/user/` note record that
      delivered missions are no longer polled and that Harnu slows down near the limit — verify:
      review — source: CLAUDE.md contracts

### U2 — UI (renderer), stacked on U1

- [ ] AC-1 — The footer GitHub pill matches `b--own-pill` in all four states (closed/healthy,
      low, exhausted), placed left of the Cleanup pill, and is hidden while the budget is
      `unavailable` — verify: visual — source: mockup B
- [ ] AC-2 — The popover matches `b--own-pill` (healthy/low/exhausted): REST and GraphQL
      meters with the Plan usage anatomy and 80/95 ramp, "Who spent it · this hour" with the
      Harnu/outside split and per-consumer rows for the tighter bucket, the low/exhausted note, and
      Details opening Settings → GitHub API — verify: visual — source: mockup B, flow `b-details`
- [ ] AC-3 — The Settings → GitHub API tab matches `d--settings-pane` (default/throttled):
      tiles, pace, the last-hour chart, the consumers table with cadence, the Missions switch and the
      throttle controls, all wired to U1's prefs — verify: visual + test — source: mockup D
- [ ] AC-4 — When `notify` is on: one toast on entering `low` (once per window) and an OS
      notification on reaching `exhausted` — verify: manual — source: mockup D "Tell me when it
      happens"
- [ ] AC-5 — `design.md` gains the "GitHub budget pill" and "GitHub API pane" sections with no
      new tokens; i18n keys in `en.json` and `pt-BR.json`; `CHANGELOG.md`; `docs/user/` page —
      verify: review — source: CLAUDE.md contracts
- [ ] AC-6 — `/dtk:mockup-qa` passes on both screens in every state — verify: visual —
      source: mockup contract

### U3 — MCP verb, stacked on U1 (parallel to U2)

- [ ] AC-1 — `github_budget({})` read verb (`mutates: false`) returns `{ ok, login, rest,
graphql, tighter, throttle: { state, since, threshold }, harnu: { byConsumer }, outside,
sampledAt }`; `state: 'unavailable'` (still `ok: true`) when `gh` is missing — verify: test —
      source: D-7
- [ ] AC-2 — The verb is on the Scheduler `observe` allowlist (`OBSERVE_ALLOW_VERBS`,
      `scheduler-core.ts:373`) — verify: test — source: D-7
- [ ] AC-3 — `docs/harnu-features.md` documents it (marker bumped), with a one-line rule for
      agents: check `github_budget` before a polling loop on `gh` and back off when `low`;
      `docs/user/agent-control.md` and `CHANGELOG.md` updated — verify: review — source:
      CLAUDE.md self-awareness contract

## Out of scope

GHE hosts, GitHub App or installation tokens, rate limits of other providers, changing any
consumer's cadence outside the throttle states.
