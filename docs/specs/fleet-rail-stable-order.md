# Fleet rail: stable order by creation + invert button (T459)

Status: spec · Date: 2026-10-09 · Card: T459 · Related: T151 (Fleet rail), T159 (rail state filter)

## Problem

The Fleet rail "jumps". Every time a session writes to its transcript, its card moves to
a different place in the column — and so does the minicard in the minimized strip. With
several `working` sessions the rail reshuffles constantly, so the operator can never rely
on "the third card is the one I was watching".

## Root cause (verified in code)

`sessions.boardBuckets` (`stores/sessions.ts`) delegates to the pure `buildBoard`
(`components/fleet-board.ts`), which sorts each state bucket by `modified` (last activity,
newest first). For the three attention tiers (`needs-input` / `errored` / `stuck`) the
store then re-sorts each bucket oldest-`modified`-first (`ASCENDING_TIME_TIERS` /
`oldestFirst`). `modified` is bumped by every transcript write, so any activity reorders
the cards.

## Decision

Fixed state tiers, creation order inside each tier (operator decision in chat: "fixed
states + creation order inside").

### Sort contract

- **Tier order is unchanged**: `BOARD_STATES` — `needs-input → errored → stuck → working →
idle (never rendered in the rail) → done`. A session whose state changes moves to its
  new tier; tiers never interleave.
- **Inside a tier, cards are ordered by session creation time** (`Session.created`), which
  never changes with activity. Default **newest first**.
- A single, inverted-aware comparator applies to **all** tiers, attention tiers included.
  The "oldest-waiting first" rule for attention tiers is retired: `ASCENDING_TIME_TIERS`
  and `oldestFirst` are deleted, and nothing in the board path sorts by `modified` any more.
- **Missing or unparseable `created` sorts after every valid one, in BOTH directions**
  (inverting must not promote bad data to the top). Ties — including two invalid values —
  break on `sessionId` (ascending, plain string compare), so the order is a deterministic
  total order regardless of input order.

### Where the sort lives (other consumers)

`buildBoard` gains an optional second parameter, `order: 'newest-first' | 'oldest-first'`
(default `'newest-first'`), and sorts by a new `created` field on `BoardSession`.
The only consumers of `boardBuckets`/`buildBoard` are the Fleet rail (expanded cards and
minimized minicards both flatten `boardBuckets`, so they cannot disagree) and tests; the
old sidebar board that once relied on most-recent-first no longer exists. So we **change the
shared path** rather than add a rail-only sort option: no consumer depends on the
`modified` ordering any more. The existing `buildBoard` tests that asserted `modified`
ordering are rewritten to assert `created` ordering (behaviour change, not a weakened test).

`BoardSession.created` is optional in the type (a slice with no `created` is the
"missing" case above); the store always fills it.

### Toggle UX

- A 22×22 icon button in the rail header, immediately left of the state-filter button
  (same anatomy: `rounded`, `text-text-3`, hover `bg-surface`). It is **not** shown in the
  minimized strip — the strip has no header; it simply follows the persisted direction.
- Icon (Lucide, design.md §5): `ArrowDownWideNarrow` while the order is newest-first,
  `ArrowUpNarrowWide` while oldest-first. The icon shows the current order.
- `title` and `aria-label` state the current order and what a click does, e.g.
  "Newest first — click for oldest first" / "Oldest first — click for newest first".
  `aria-pressed` is not used (it is a two-way sort, not an on/off switch).
- The button inverts the order **within every state group**; the groups themselves stay in
  tier order.
- No accent dot: oldest-first is a legitimate preference, not a hidden-content warning like
  the state filter.

### Persistence

`layout.inboxRailOrder`, a `persistedRef` under `om2tab.inboxRailOrder` (same prefix as
`om2tab.inboxRailWidth` / `om2tab.inboxRailHiddenStates`), values `'newest-first'` (default)
or `'oldest-first'`. An unknown or corrupt stored value falls back to `'newest-first'`.
Fleet-global, not per-worktree, like its neighbours. `layout.toggleInboxRailOrder()` flips
it. `sessions.boardBuckets` reads it, so every consumer sees one direction.

### Safety affordance and filter (unchanged)

The state filter, `fleetCards` (unfiltered source), `fleetStateCounts`, and
`hiddenAttentionCount` / the "N hidden by the filter" strip are untouched: they depend on
bucket **membership**, not order. `InboxRail.vue`'s local `ATTENTION_TIER_STATES` copy stays
(it is about which states are urgent, not about sorting); only its stale comment pointing at
`ASCENDING_TIME_TIERS` is updated.

### Edge cases

- **Synthetic → real migration (must not make a card jump).** A "+ New session"
  placeholder carries `created = now` (spawn time); the real row's `created` is the JSONL's
  `birthtime`, which differs by seconds or more.
  - _In-place migration_ (`migrateSyntheticInPlace`, the in-place branch of
    `collapseSyntheticInto`): the same row object is renamed, but the next
    `index:updated` makes `reconcileSessions` overwrite its `created` with the JSONL's
    (later) value — `created` is not a renderer-only key. So these paths record the
    anchor too, **before** the rename. (The first version of this spec assumed the row
    "keeps its `created`"; an independent verifier showed it does not.)
  - _Absorb / resolved-window_ (`absorbSyntheticIntoRealRow`, `collapseResolvedSynthetics`):
    the synthetic row is dropped and a different row object survives. All four paths use
    one helper, `anchorCreation(synth, realId)`: the store records
    `creationAnchors: realId → synthetic.created` **before** removing/renaming, and
    `boardBuckets` uses `creationAnchors.get(id) ?? session.created` as the sort key. The
    anchor is the creation moment as the operator experienced it. `Session.created` itself
    is not modified (other code matches synthetics to real rows by it).
- **Fork / `/clear` / `/resume`** produce genuinely new sessions and sort as new — correct.
- **Equal `created`**: tiebreak by `sessionId`, so refreshes never shuffle equal cards.
- **A session changing state** moves to its new tier at its creation-order position.

## Test plan

Red first (commit 2), then green.

| AC    | Test                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | `buildBoard`: bucket sorted by `created` desc; bumping `modified` on any session leaves the order identical. Store: same through `boardBuckets` after mutating `modified`.                                                    |
| AC-2  | `buildBoard`: tier order == `BOARD_STATES`; a session whose `taskState` flips moves buckets. Store: same.                                                                                                                     |
| AC-3  | `buildBoard(…, 'oldest-first')` reverses within every bucket, buckets stay in tier order. Store: `layout.toggleInboxRailOrder()` flips `boardBuckets`.                                                                        |
| AC-4  | Layout store: default `newest-first`; toggle persists to `om2tab.inboxRailOrder`; a fresh store reads it back; garbage value → default.                                                                                       |
| AC-5  | Attention tiers use the same rule and toggle (no oldest-`modified`-first); `hiddenAttentionCount`/filter behaviour untouched (existing tests stay green).                                                                     |
| AC-6  | Minimized strip and expanded body both flatten the same `boardBuckets` (structural — one projection); asserted visually.                                                                                                      |
| AC-7  | `buildBoard`: missing/invalid `created` last in both directions; tie → `sessionId`. Store: twin-collapse, in-place collapse and claim-bound in-place migration each keep the card's position across the next reload (anchor). |
| AC-8  | Review: `en.json` + `pt-BR.json` parity (`vue-tsc` schema), `design.md` Fleet rail section documents the control.                                                                                                             |
| AC-10 | Visual: isolated second instance, several `working` sessions with live activity do not move; toggle flips them.                                                                                                               |

## Out of scope

Classifier / state heuristics, rail visuals beyond the toggle, new dependencies, the
drive-by refactors. `docs/harnu-features.md` and `docs/user/` need no update:
no new top-level component, no MCP verb, nothing the agent can call or offer.
