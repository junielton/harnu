# PR Stack filters

Status: approved 2026-10-01 (visual contract: `spec.html` in this folder, `status: approved`).

## Problem

A repo with ~20 open PRs across ~11 chains is wider than the screen. The canvas offers pan and zoom
but no way to ask a question of it ("what can I merge?", "what is waiting on me?").

## Decisions (operator-approved)

- **Dim is the default mode.** Hide is opt-in via the segmented control.
- **Filter state is per repo, session-only.** It lives in the Pinia store, is not written to
  `localStorage`, and is gone after an app restart. The Dim/Hide mode follows the same rule.
- **No `sort:`.** Order is the graph layout.
- **Legend rows stay non-interactive.**
- **Client-side only.** Filtering runs over the snapshot already loaded. No new `gh` call, no new
  IPC channel, no new field in the `gh pr list` query.

## Query grammar

Whitespace-separated terms, ANDed. A term is either a qualifier `key:value` or free text.
A leading `-` negates any qualifier. Values are case-insensitive. Repeating the same key ORs its
values (`review:approved review:changes` matches either), which is how a multi-select facet writes
itself into the query. An unknown key or value is kept as a token, matches nothing, and is rendered
with the warning tone so a typo is visible rather than silently ignored.

| Qualifier           | Values                                           | Source on `PrEntry` / graph node                      |
| ------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `is:`               | `tip`, `merge-next`, `blocked`, `stale`, `draft` | the four computed card signals; `isDraft`             |
| `author:`           | `@me`, login                                     | `author`                                              |
| `review:`           | `approved`, `changes`, `required`, `none`        | `reviewDecision`                                      |
| `review-requested:` | `@me`, login                                     | `reviewRequests`                                      |
| `ci:`               | `passing`, `failing`, `pending`                  | `ci`                                                  |
| `threads:`          | `unresolved`, `none`                             | T275 unresolved thread count (`null` matches neither) |
| `label:`            | label name                                       | `labels`                                              |
| `base:`             | branch                                           | `base`                                                |
| `chain:`            | `#N` or `N`                                      | every PR in the same connected chain as PR N          |
| free text           |                                                  | substring of title or branch, or `#N` exact number    |

`@me` resolves to the authenticated `gh` login if the snapshot already exposes it; if it does not,
resolve it from data already available in the main process without adding a per-refresh network
call, and state in the PR how it was resolved. If no cheap source exists, drop `@me` and the
"Waiting on me" facet row from this unit and say so in the report rather than adding a request.

## Components (see `spec.html` for anatomy; the `data-dsqa` name is in parentheses)

1. **Filter bar** (`pr-stack-filterbar`, `--active`): floating, `top-3`, immediately right of the
   existing refresh/zoom control, same shell anatomy. Query field + facets Author, Review, Checks,
   Labels. `/` focuses the field when the canvas has focus; `Esc` blurs, a second `Esc` clears.
   While any filter is active: `N of M` count, Dim/Hide segmented control, clear button.
2. **Qualifier suggestions** (`pr-stack-filter-suggest`): shown while the field is focused and the
   current term is empty or a key prefix. Arrow keys + Enter complete the key.
3. **Facet menu** (`pr-stack-filter-menu`): multi-select with live counts computed over the
   unfiltered snapshot. Facets and the query are two views of ONE state: checking a box writes the
   token, deleting the token unchecks the box. Review menu also carries the Threads group.
4. **KPI presets** (`pr-stack-kpis`, `--active`): in the takeover header, "ready to merge" applies
   `is:merge-next`, "with unresolved threads" applies `threads:unresolved`, "needs retarget" applies
   `is:stale`. A KPI whose count is 0 is not clickable. Clicking the active preset clears it.
   "open" and "chains" stay plain text.
5. **Dim mode** (`pr-stack-scene--dim`): layout untouched; non-matching cards at `opacity-40`, and
   an edge is dimmed unless BOTH of its endpoints match. Dimmed cards stay interactive.
6. **Hide mode** (`pr-stack-scene--hide`): re-layout over matches only. A match whose ancestors do
   not match keeps its path to base through a dashed pill "N hidden · #a #b" per contiguous run of
   skipped ancestors; clicking the pill adds `chain:#<match>` and switches to Dim. Operator card
   position overrides are ignored while Hide is on and restored when it is turned off.
7. **No match** (`pr-stack-empty--no-match`): shown in Hide mode with zero matches, with a
   "Clear filters" button. In Dim mode with zero matches the canvas stays fully dimmed and the
   count reads `0 of M`.

State 9 of `spec.html` (`pr-stack-refresh--stale`) is NOT part of this unit. It is the visual
contract for the gh-timeout bug card.

## Acceptance criteria

- AC1 The parser + matcher are a pure module with unit tests covering every qualifier, negation,
  same-key OR, unknown key/value, free text and `chain:`.
- AC2 The filter bar renders at `top-3` beside the refresh/zoom control and matches `spec.html`
  states 1 and 2 (`/mockup-qa` at 1280).
- AC3 Facet menus show live counts, and box ↔ token stay in sync in both directions.
- AC4 KPI presets apply, show the active state, and clear on second click; zero-count KPIs are inert.
- AC5 Dim mode: non-matches and their edges at `opacity-40`, layout and overrides untouched.
- AC6 Hide mode: matches only, hidden-ancestor pills, overrides restored on exit.
- AC7 Filter and mode are per repo and session-only (nothing written to `localStorage`); a
  background refresh keeps the filter applied.
- AC8 `design.md` gains a "PR Stack filters" subsection under §PR Stack Canvas BEFORE the
  implementation lands in the same PR; no raw colors, Tailwind token utilities only.
- AC9 Every string goes through i18n, present in both `en.json` and `pt-BR.json`.
- AC10 `CHANGELOG.md` entry under Added; `docs/user/pr-stack.md` documents the bar, the grammar
  table and the two modes.

## Out of scope

Saved/named filters, `sort:`, server-side search, any change to the `gh` query or its timeout,
card anatomy changes, legend interactivity.
