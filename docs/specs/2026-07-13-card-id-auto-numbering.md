# `create_card` mints a citable card id (`T<n>` / `BUG-<n>`)

**Date:** 2026-07-13
**Card:** `create-card-cannot-assign-a-card-id-the-slug-is-a-truncated-titl`
**Status:** design approved, not implemented

## Problem

`create_card` takes no `id` argument, by design (T96 §1.1 — ids are server-owned so an
agent cannot forge one). But the id it mints is just the title, slugified and cut:

```ts
// roadmap-core.ts:871
export function slugifyTitle(title: string): string {
  const base = title
    .normalize('NFKD')
    …
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 64)        // ← hard cut, no word boundary
    .replace(/-+$/g, '')
  return base || 'card'
}
```

and the handler uses it verbatim as both the filename and the frontmatter `id`:

```ts
// tool-handlers.ts:595
const slug = resolveUniqueSlug(slugifyTitle(title), existingSlugs)
…
const created = await createCardFile(folder, slug, content)   // tool-handlers.ts:617
```

`buildNewCardContent` then writes `id: ${input.slug}` (roadmap-core.ts:913).

Two consequences:

1. **Mid-word truncation.** The `.slice(0, 64)` is a raw character cut. On the live board
   (88 cards, 2026-07-13) **20 cards** carry an id sheared mid-word —
   `t125-completion-sensor-capy-dispatches-work-but-never-observes-i`,
   `bug-30-sanitizespawnenv-strips-nothing-under-appimagelauncher-ap`.
2. **The board has two id species.** A human writing the file by hand produces `BUG-22.md`
   or `T108-capy-orchestrator-contract.md` — short, citable, speakable. An agent using the
   verb cannot produce that, so half the board is unciteable in conversation.

## Design

Server-side **auto-numbering**. `create_card` still takes no `id` argument; the server now
mints a _number_ instead of a truncated sentence.

### 1. The scheme

- `kind: 'bug'` → `BUG-<n>`; every other kind (and a card with no `kind`) → `T<n>`.
- `<n>` is `max + 1` over the existing ids of that series, scanned per board.
- The two series are independent counters (`T126` and `BUG-31` coexist).
- The on-disk filename is `<ID>-<short-slug>.md`; frontmatter `id:` is the bare `<ID>`.

```
create_card({ title: "Completion sensor", kind: "feature" })
  →  id: T126,   file: T126-completion-sensor.md

create_card({ title: "Worktree setup is opaque", kind: "bug" })
  →  id: BUG-31, file: BUG-31-worktree-setup-is-opaque.md
```

This keeps T96's invariant (the agent never chooses an id) while adopting the convention
the operator already uses by hand, so the board stops speaking two dialects.

### 2. The scan

Derive `<n>` from the **filenames** already returned by `listCardSlugs(folder)`
(roadmap-ipc.ts:282) — no card body is parsed, so the mint costs one `readdir`:

```
/^(BUG-|T)(\d+)(?:-|$)/i     // matches T126-…, T108-capy-orchestrator-contract, BUG-22
```

A slug that does not match the shape contributes nothing to the max. **The 20 long-slug
cards simply fall out of the scan** — they are not numbered, not renamed, and keep
resolving exactly as they do today. That is the migration story: a non-event.

The regex is case-insensitive on read (hand-written files are uppercase, agent-written
legacy ones lowercase — `bug-30-…`) but the mint always emits uppercase `T` / `BUG-`.

`resolveCardFile`'s path jail already accepts uppercase (`SAFE_SLUG = /^[A-Za-z0-9._-]+$/`,
roadmap-ipc.ts:76), so `T126-completion-sensor` needs no jail change.

### 3. The short slug

The slug after the ID no longer carries uniqueness — the ID does. It only has to be
readable. So `slugifyTitle` gains a **word-boundary cut**: slugify unbounded, then trim
back to the last `-` at or before the cap (target ~40 chars), never mid-word. `resolveUniqueSlug`
(roadmap-core.ts:884) stays as the filename backstop for the pathological case (two cards
minted with the same ID prefix must never both write — see §4), but in the normal path it
is a no-op because the ID is already unique.

`slugifyTitle`'s existing callers are exactly one (tool-handlers.ts:595) plus its unit
tests (tests/roadmap-core.test.ts:842) — changing the cut is a contained edit.

### 4. Concurrency — do not mint two `T126`s

The main process is single-threaded, but `create_card` `await`s between the scan
(`listCardSlugs`) and the write (`createCardFile`), so two in-flight handlers **can**
interleave and compute the same `max + 1`. `createCardFile` writes with `flag: 'wx'`
(roadmap-ipc.ts:308) so it refuses to clobber an existing _file_ — but two cards with
different titles produce different filenames (`T126-alpha.md`, `T126-beta.md`) and both
would land, carrying the same frontmatter `id`.

**Serialize the mint per board.** The board already keys per-repo state by `repoKey` —
`takeBoardRateSlot(repoKey, …)` over a `Map<string, BoardRateCounter>` (tool-handlers.ts:320).
Add a sibling `Map<string, Promise<void>>` mutex on the same key and run
**scan → build → write** inside it. A lock at that grain is cheap: it serializes only card
_creation_ on one board, never reads, never other verbs.

Belt-and-braces on top: if `createCardFile` returns `write-failed` on an `EEXIST`, re-scan
and re-mint once (bounded retry) rather than surfacing a spurious `WRITE_FAILED` to the
agent.

### 5. Filename vs. frontmatter id — the split

Nothing about the addressing model changes:

- **The filename slug stays the canonical addressing key.** `resolveCardFile(roadmapDir, slug)`
  (roadmap-ipc.ts:203) is the single path-jail every read and write goes through; `update_card`
  / `move_card` / `readCard` all take that slug.
- **Frontmatter `id:` is display/reference** — the handle the operator types and cites.

The `create_card` ACK must therefore return **both**, so the agent knows which string to pass
back to the other verbs:

```
{ ok, id: 'T126', slug: 'T126-completion-sensor', path, column: 'backlog', seededTemplate }
```

Today the ACK carries only `slug` (tool-handlers.ts:619-626), and `slug === id`. After this
change they diverge, so `id` is a **new ACK field the agent must read** — which is what makes
this change agent-facing (see Contract obligations).

**Known sharp edge (documented, not fixed here):** `parent` and `deps` are described in T96
§1.1 as "slug/id of an existing card". With the split, `parent: 'T126'` no longer resolves —
`readCard(folder, 'T126')` (tool-handlers.ts:589) looks for `T126.md`. The card's decision
stands: addressing does not change in this PR. The mitigation is editorial — the `create_card`
ACK returns the `slug` explicitly, and `tool-catalog.ts` must say that `parent`/`deps` take the
**slug**, not the display id. A narrow `id → slug` alias lookup in the shell is a plausible
follow-up card, deliberately out of scope here.

### 6. Migration

No file is renamed. No card is renumbered. The 20 long-slug cards keep their ids, keep
resolving through `resolveCardFile`, and keep appearing on the board — they are invisible to
the scan (§2) and unaffected by the write path. The only observable change is that cards
created **after** the change get short ids.

## Testing

Pure-core tests in `tests/roadmap-core.test.ts` (the mint is a pure function over the existing
slug list); handler-level tests for the mutex.

- **Numbering:** given `['T125-foo', 'BUG-30-bar', 'some-legacy-truncated-slug']`, a
  `kind: 'feature'` mint yields `T126`; a `kind: 'bug'` mint yields `BUG-31`; a card with no
  `kind` yields `T126`.
- **Empty board:** first card is `T1` (and first bug is `BUG-1`).
- **Legacy slugs are ignored, not counted:** the 20 long-slug shapes never contribute a max and
  never trip the scan (a slug like `bug-30-sanitizespawnenv-…` DOES match the shape and legally
  contributes 30 — assert that; a slug like `t125-completion-sensor-capy-dispatches-…` likewise
  contributes 125; a slug with no leading number, e.g. `create-card-cannot-assign-…`, contributes
  nothing).
- **No mid-word truncation:** a 200-char title yields a slug cut at a `-` boundary, never inside a
  word, and the ID prefix is always intact.
- **Concurrency (the one that matters):** two `create_card` calls issued back-to-back without
  awaiting the first must never mint the same number — assert `T126` and `T127`, two distinct
  files, two distinct frontmatter `id`s. Run it as a loop of N=10 to make an accidental
  serialization-by-luck fail.
- **Existing cards keep resolving:** `update_card` / `move_card` against a pre-existing long-slug
  card (`t125-completion-sensor-capy-dispatches-work-but-never-observes-i`) still succeed after the
  change — the acceptance criterion that guards the migration non-event.

## Contract obligations

- `CHANGELOG.md` — **mandatory** (the id a user sees on a new card changes shape).
- `docs/specs/T96-board-verbs-api.md` §1.1 — **mandatory**. It currently specifies the old behavior
  verbatim ("id/slug generated server-side: slugify(title) → collision resolved with a `-2`, `-3`…
  suffix. The id does NOT follow the human `T<n>` numbering (that's the operator's convention);
  agent cards use the plain slug."). That paragraph is now false and must be replaced with this
  scheme, including the ACK's new `id` field.
- `docs/capy-features.md` + version marker bump — **required**, because the `create_card` ACK gains
  an `id` field the agent must read, and the agent must be told that `parent`/`deps` take the
  **slug**. That is an ACK-shape change, squarely inside the agent-facing definition. The CI
  awareness gate (`scripts/ci/awareness-gate.mjs`) fires the moment `tool-catalog.ts` is touched.
- `docs/user/agent-control.md` — required if `tool-catalog.ts` changes (the user-docs gate keys on
  the same file); the human-prose statement is simply that agent-created cards now get a short
  `T<n>` / `BUG-<n>` handle.
- **Stacking:** this branches off the priority-token PR
  (`card-priority-enum-is-portuguese-against-the-english-only-policy`), which already bumps the
  `docs/capy-features.md` marker — this change bumps it again from there.
