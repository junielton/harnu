# T190 — Card worktree provenance: where a card was born, where it is being executed

**Status:** design approved (operator, 2026-07-31) · not implemented
**Card:** `T190` · **Sibling:** [T191](./T191-worktree-lineage-sidebar.md) (sidebar lineage — independent, no shared code)

## Problem

Project memory is repo-shared: every worktree of a repo reads and writes ONE board
(`.capy/memory/roadmap/`). That is deliberate and stays. The cost is that a card carries no
visible trace of **where it came from** or **where it is being worked**, so a board with 212
cards spanning a dozen worktrees reads as one undifferentiated pile.

Two distinct facts are wanted, and they are not the same fact:

- **Origin** — the branch/worktree of the session that _created_ the card. Immutable history:
  "who raised this?"
- **Owner** — the worktree the card is (or was) _executed_ in. Mutable over the card's life:
  "where is this PR being built?"

## Current state (measured, 2026-07-31)

| Fact   | Where it lives today                                            | Coverage                                                                   |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Origin | `provenance.branch` in the card frontmatter (`roadmap-core.ts`) | 212 cards: 161 `main`, 45 empty, 5 a real worktree branch                  |
| Owner  | `session:` frontmatter (dispatch bind, a session id)            | backlog 14/49 · ready 3/9 · in-progress 5/5 · **review 8/98** · done 46/51 |

Neither is surfaced anywhere in the UI.

Two consequences shape the design:

1. **Origin is already recorded and needs no new field**, but it is nearly all `main` — most
   cards are raised from the main checkout's session. A filter keyed on origin alone would be
   ~90% one bucket.
2. **The owner bind evaporates.** Review is the largest column (98 cards) and only 8 carry a
   `session:`. Whatever records the owner must be durable and never cleared, or the answer is
   lost exactly when it is most useful.

A third constraint: `session:` is a _session id_, resolvable to a folder only through the
renderer's live session model — and for a `synthetic-*` id whose session was parked or closed,
not resolvable at all. The owner must be recorded as the branch itself, not as a pointer to a
session.

## Approved decisions

| #   | Decision                                                                                          | Rationale                                                                              |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | Track **both** origin and owner, as distinct fields                                               | Operator: they answer different questions                                              |
| D2  | Opening the board from a worktree **auto-scopes** it to that worktree                             | Operator's choice; a `ver tudo` escape is always visible                               |
| D3  | The scope axis is the **union**: born here OR executed here                                       | Origin alone would open near-empty (see coverage table)                                |
| D4  | Backfill by **deriving from branch names at runtime**, no migration                               | Nothing rewritten on disk; a guess never becomes permanent truth                       |
| D5  | The card face shows **one** chip (owner, falling back to origin); both appear in the detail modal | The face already carries id, kind, complexity, spec, manifest and dispatch affordances |
| D6  | The worktree filter is **ephemeral per board opening**, never persisted                           | Persisting it would leave the main board silently filtered with no visible cause       |

## Design

### 1. Data model

**Origin — no change.** `provenance.branch` stays as-is. A branch can be checked out in only one
worktree at a time, so within a repo the branch name _is_ the worktree identity. No new field.

**Owner — one new durable frontmatter field.**

```yaml
executedIn: feat/t190-card-worktree-provenance
```

- Written at **dispatch time**, on the same path that already stamps `session:` and the
  `dispatched-with: model·effort` line — for both dispatch routes (per-card confirm and the
  manifest drain). The value is the spawn folder's short branch name; empty/omitted when the
  spawn folder's HEAD is detached.
- **Never cleared.** Moving a card to `review` or `done`, or the session dying, leaves it
  untouched. This is the entire fix for the 8/98 review coverage.
- **Not agent-writable.** Added to the controlled-field list in `roadmap-core.ts` alongside
  `status` / `session` / `evidence` / `provenance` / `approved` / `approvedBodyHash`, so
  `update_card`'s `set` refuses it. Capy stamps it; the agent does not.
- **Re-dispatch overwrites.** A card dispatched a second time into a different worktree takes
  the new branch. The field answers "where is this being worked", not "every place it ever was";
  a full history is out of scope.

**Derived owner (fallback, runtime only, never written).** For a card with no `executedIn`, match
its `id` against the repo's local branches and registered worktrees — the same substring rule
`create_worktree`'s `existingWork` check already uses (a branch whose name embeds the card slug).

- Zero, one, or many matches. Exactly one match → show it, marked as derived. Zero or more than
  one → show nothing rather than pick.
- A derived value is **visually distinguished** (dashed chip border, see §3) and never persisted,
  because it is a heuristic and a wrong guess must stay correctable by the next real dispatch.

### 2. Filtering

`board-filters.ts` gains the scope predicate and its state:

```ts
export interface WorktreeScope {
  /** Short branch name to scope to, or null for "everything". */
  branch: string | null
}

/** Union match (D3): the card was born on `branch` OR is/was executed on it. */
export function matchesWorktreeScope(
  card: Pick<FilterableCard, 'originBranch' | 'executedIn'>,
  scope: WorktreeScope
): boolean
```

`FilterableCard` gains `originBranch?: string` and `executedIn?: string` (both optional — a card
missing both never matches a non-null scope, and always matches a null scope). `filterCards`
applies the predicate alongside the existing search and kind filters.

**Not persisted (D6).** `RoadmapFilterState` / `serializeFilters` / `parsePersistedFilters` are
left untouched — the scope lives in `RoadmapBoard.vue` component state and resets on every open.

### 3. UI

**Filter bar** (`RoadmapFilterBar.vue`, `design.md` §6 "Roadmap board"): a `Worktree` dropdown
beside the kind chips, listing the distinct branches present across the loaded cards plus an
"all" entry. Fully controlled, like every other control in that bar — the parent owns the state.

**Auto-scope on open** (D2). `openRoadmap(folderPath, repoLabel)` already receives the folder the
board was opened from. If that folder is not the repo's main checkout and has a branch, the board
opens with the scope preset to that branch. The dropdown shows the active branch so the filtered
state is never silently applied, and clearing it is one click.

**Card face** (`FleetBoardCard.vue`): one chip — a `git-branch` glyph plus the short branch name,
truncated. Exactly one precedence order, no ambiguity:

1. `executedIn` (stamped owner) — solid chip
2. derived owner (§1 fallback) — dashed chip
3. `provenance.branch` (origin) — solid chip
4. nothing renders

New element in `design.md` §6.

**Card detail modal** (`CardDetailModal.vue`, `design.md` §6 "Card detail modal"): two explicit
rows in the metadata block — "Born in" (origin) and "Executed in" (owner, with the derived marker
when applicable) — so the full picture is one click away without crowding the face.

### 4. Error handling and edge cases

| Case                                                      | Behavior                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| Card has neither origin nor owner                         | No chip. Matches only the "all" scope.                        |
| `executedIn` present but the branch no longer exists      | Still shown — it is history, not a live pointer.              |
| Derived match is ambiguous (>1 branch)                    | Show nothing. Never guess between candidates.                 |
| Board opened from the main checkout                       | No auto-scope; opens unfiltered.                              |
| Detached HEAD at dispatch                                 | `executedIn` omitted; falls through to origin/derived.        |
| Agent tries `update_card` with `executedIn`               | Refused as a controlled field, same error shape as `session`. |
| Legacy card with an unparseable/absent `provenance` block | Unchanged fail-closed behavior; treated as no origin.         |

### 5. Testing

- `board-filters` unit: union matching (born-only, executed-only, both, neither), null scope,
  case sensitivity of branch names.
- Derivation unit: exactly-one match, zero matches, ambiguous match, card id that is a substring
  of an unrelated branch.
- `roadmap-core` unit: `executedIn` frontmatter round-trip (read, write, absent); `update_card`
  refuses it as a controlled field.
- Dispatch unit: both dispatch routes stamp `executedIn`; a `move_card` to `review`/`done` does
  not clear it.

### 6. Mandatory contracts (definition of done)

- `CHANGELOG.md` — dated entry under `### Added`.
- `design.md` — §6 gains the branch chip on the card face, the `Worktree` dropdown in the filter
  bar, and the two detail-modal rows. Written **before** implementation.
- `docs/user/` — the roadmap board page documents the chip, the filter, and the auto-scope.
- `docs/capy-features.md` + version-marker bump — `update_card` now refuses a new controlled
  field (`executedIn`), which is a change in verb semantics the agent must know.
- `en.json` **and** `pt-BR.json` in the same change for every new key.

## Out of scope

- A separate board per worktree. Memory stays repo-shared; scoping is a view, not a partition.
- Full execution history (every worktree a card ever passed through).
- A migration pass that writes derived owners into the 212 existing cards (D4 rejects it).
- Anything in the sidebar — that is [T191](./T191-worktree-lineage-sidebar.md).
