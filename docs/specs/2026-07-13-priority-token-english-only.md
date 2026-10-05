# Priority tokens are English-only, and the Portuguese ones must still sort

**Date:** 2026-07-13
**Card:** `card-priority-enum-is-portuguese-against-the-english-only-policy`
**Status:** design approved, not implemented

## Problem

`CLAUDE.md` ("Language policy — English is the lingua franca", T115) makes English
mandatory for project-memory content (`.capy/memory/**`), with the sole exception of i18n
resources. The roadmap board violates it in its own schema.

Measured on the live board (88 cards, 2026-07-13):

- **42 cards** carry `priority: alta` (27) or `priority: media` (15).
- **9 cards** carry `priority: high` (8) or `priority: medium` (1).

The leak is upstream of the cards. `docs/specs/T96-board-verbs-api.md` §1.1 specifies the
field as

```
priority?: 'alta'|'media'|'baixa' | string,
```

and the shipped `create_card` schema (`src/main/mcp/tool-catalog.ts:511-515`) describes it as

```ts
priority: z
  .string()
  .min(1)
  .optional()
  .describe('Priority token (e.g. alta/media/baixa or high/medium/low).'),
```

So the tool description every session reads at boot literally offers the Portuguese tokens
_first_. The field is a free `z.string()` — nothing rejects either form, and both accumulate.
`update_card`'s `set` description (`tool-catalog.ts:537`) lists `priority` as a settable key
without constraining its values at all.

This predates T115. It is drift, not disagreement.

### This is a live functional bug, not a style violation

`priorityRank` (`src/main/roadmap-core.ts:461-468`):

```ts
function priorityRank(priority: string | undefined): number {
  if (!priority) return Number.POSITIVE_INFINITY
  const named: Record<string, number> = { high: 1, medium: 2, med: 2, normal: 2, low: 3 }
  const t = priority.trim().toLowerCase()
  if (t in named) return named[t]
  const n = Number.parseFloat(t)
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}
```

The table knows only `high | medium | med | normal | low`. `alta` / `media` / `baixa` are
absent and do not parse as a number, so they fall through to `POSITIVE_INFINITY` — the exact
rank of a card with **no priority at all**. `compareCards` (`roadmap-core.ts:471-475`) sorts
each column by that rank, so the 27 cards marked `priority: alta` — the operator's most urgent
work — sort **last** in their column today, below every `low` and every untagged card.

### The rank table is duplicated

`src/renderer/src/stores/roadmap.ts:31-44` carries a byte-identical copy of `priorityRank` +
`compareCards`, commented "Mirror of the core." The renderer copy is the one that orders the
kanban the operator actually looks at. **Fixing only `roadmap-core.ts` fixes nothing visible.**
Both tables must change, or the mirror must stop being a copy.

`CardDetailModal.vue:164-167` renders `card.priority` as a raw chip, so a surviving `alta`
renders literally as "alta" — cosmetic, and acceptable during the transition.

## Design

### 1. Read-side alias (the sort fix)

Extend the `named` table in **both** copies of `priorityRank` with the three Portuguese tokens,
mapped onto the existing ranks:

```ts
const named: Record<string, number> = {
  high: 1,
  medium: 2,
  med: 2,
  normal: 2,
  low: 3,
  // Legacy pt-BR tokens (pre-T115 drift). Read-side alias only — never written.
  alta: 1,
  media: 2,
  baixa: 3
}
```

Properties this buys:

- The 42 existing cards sort correctly **immediately**, with no backfill and no file writes.
- `alta` and `high` are the _same rank_, not adjacent ranks — a board mixing both forms
  interleaves correctly rather than clustering by language.
- Nothing new is written in Portuguese. The alias is strictly a **reader**; the write path
  (§2) only ever offers English.

The two copies stay in sync by hand, as they do today. Collapsing the mirror into a shared
module is **out of scope** — it touches the main/renderer boundary and is not what this card
is about. The renderer's comment already asserts the mirror contract; the unit tests (§Testing)
will pin both.

### 2. Tool-catalog description (stop the bleeding)

`tool-catalog.ts:515` — `create_card.priority`:

```ts
.describe('Priority token: high | medium | low.')
```

`tool-catalog.ts:537` — `update_card.set`: leave the key list as-is, and state the priority
vocabulary in the same sentence so a session editing a card sees the same three tokens it saw
when creating one.

The field stays a free `z.string()`. **No `z.enum` here, deliberately** — a hard enum would
start refusing `update_card` calls against the 42 legacy cards (a round-trip that re-sends the
existing `alta` would now fail), turning a cosmetic drift into a live refusal. The schema stays
permissive; the _description_ is what steers, and the description is what every session reads
at every boot. Numeric priorities (`'1'`, `'2'`) already parse and keep working.

### 3. Spec correction

`docs/specs/T96-board-verbs-api.md` §1.1 — replace

```
priority?: 'alta'|'media'|'baixa' | string,
```

with

```
priority?: 'high'|'medium'|'low' | string,   // free string; numeric also ranks
```

This is the origin document the catalog description was copied from. Leaving it correct-adjacent
is how the drift comes back.

### 4. Backfill — explicitly out of scope

`.capy/memory/roadmap/*.md` is gitignored local operator state, not repo content. The 42
existing cards are **not** rewritten by this PR. With the alias in place their ranking is
correct, so the remaining Portuguese token is purely a rendered string in a chip. Backfill is a
one-off script after merge, or never.

## Testing

`tests/roadmap-core.test.ts` (`describe('groupByColumn + compareCards')`, currently at
`tests/roadmap-core.test.ts:217-269`):

1. **Alias parity (unit).** `priorityRank` — via `compareCards` — ranks `alta` identically to
   `high`, `media` to `medium`, `baixa` to `low`. Assert _equality_ of rank, not merely
   relative order: `compareCards(card({id:'A', priority:'alta'}), card({id:'B', priority:'high'}))`
   must be `< 0` on the **id** tiebreak alone (i.e. the same value a `high`/`high` pair yields),
   which is what proves the ranks collapsed rather than merely landing nearby.
2. **Sort-order regression (the reported bug).** A column holding
   `[alta, (no priority), low, high]` groups to `high|alta` first and the untagged card last —
   asserting directly that an `alta` card no longer sorts below an untagged one. This test fails
   on today's `main`; it is the regression pin.
3. **Case/whitespace.** `ALTA` normalizes like `HIGH` (the existing `trim().toLowerCase()`
   path, extended to the new keys).
4. **Non-regression.** The existing `high|low|none` ordering test and the numeric-priority test
   (`priority: '1'` sorts before `'2'`) still pass unchanged.
5. **Renderer mirror.** The renderer copy (`stores/roadmap.ts:31-44`) is currently untested. Add
   the equivalent alias-parity assertion against the store's ordering so the mirror cannot drift
   back — the store's sort is the one the operator sees, and it is the reason a core-only fix
   would look like a no-op.

## Contract obligations

- `CHANGELOG.md` — **mandatory**. User-visible fix: high-priority cards were sorting last in
  their column.
- `docs/capy-features.md` + version marker bump (`<!-- capy-features vN -->`, currently v17) —
  **mandatory**. The CI awareness gate (`scripts/ci/awareness-gate.mjs`) fires on any
  `tool-catalog.ts` diff. It is genuinely agent-facing regardless: the vocabulary a session is
  told to write for `priority` changes from "alta/media/baixa or high/medium/low" to
  `high | medium | low`.
- `docs/user/roadmap-board.md` — the "Columns and cards" section enumerates the chips a card
  shows (kind, complexity, deps, evidence, readiness) and does **not** currently mention
  priority or its ordering effect. Adding the one sentence that priority is `high | medium | low`
  and orders a column satisfies the user-docs gate (`scripts/ci/user-docs-gate.mjs`, which fires
  on any `tool-catalog.ts` change) with something a person actually needs.
- **Bundled PR.** This card ships together with the sibling docs-only card
  `the-contract-never-forbids-hand-writing-a-card-file` — **one** `docs/capy-features.md` marker
  bump covers both, since this card must touch that file anyway.
