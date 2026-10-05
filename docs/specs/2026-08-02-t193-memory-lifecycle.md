# T193 — memory lifecycle (implementation spec)

**Date:** 2026-08-02
**Card:** `T193-memory-lifecycle-decay-sweeps-digest-rollups-pinning-and-a`
**PRD:** [`docs/prds/T193-memory-lifecycle.md`](../prds/T193-memory-lifecycle.md)
**Status:** design draft — not implemented

## Boundary (ADR-0001)

Same split as T192. Every _decision_ is pure and lives in
`src/main/mcp/memory-core.ts` (or a new `memory-lifecycle-core.ts` if that file
outgrows itself); every _effect_ — reading the digest dir, writing the rollup,
moving files to `archive/` — is shell, in `memory-store.ts` / a new
`memory-sweep.ts`, and is e2e-only.

Pure functions to add:

| Function                               | Input → output                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `planRollup(digests, now, period)`     | page metadata list → which pages roll into which rollup id, and which are archived |
| `renderRollup(digests, period)`        | digest bodies → the deterministic rollup markdown                                  |
| `computeSalience(page, feedback, now)` | age + tier + pin + feedback → a number in `[0,1]`                                  |
| `applyFeedback(ledger, entry)`         | existing ledger + new verdict → new ledger (idempotent per author+page)            |

`now` is injected, never read from the clock inside the core — the existing memory
core already holds this line and the tests depend on it.

## 1. Rollups

**Grouping key:** ISO week (`YYYY-Www`) derived from the digest filename date, which
is already canonical (`sessions/YYYY-MM-DD-<id8>.md`, `formatMemoryDate`). Never
parse the body for a date.

**Output:** `sessions/rollup-<YYYY-Www>.md`

```markdown
# Week 2026-W31 — 14 sessions, 6 branches, 23 commits

## main (8 sessions)

- **2026-08-01 · 0e5792ac** — AI Forum design spec landed · 3 commits · [[sessions/2026-08-01-0e5792ac]]
  …

> provenance: author=rollup · at=<now> · sources=14
```

Deterministic content only: session id, date, the digest's own one-line recap,
commit count, branch, and a wikilink back to the source page. An LLM pass may add a
`## What actually happened` prose section when one is configured; its absence must be
invisible to correctness.

**Eligibility:** a week rolls up only when it is **closed** (its last day is more
than `ROLLUP_GRACE_DAYS` in the past, default 7) — never the current week, never a
week a live session is still writing into.

**Archiving:** sources move to `archive/sessions/<original-name>.md`. `archive/` is
the frozen read-only tier that already exists. The move is a rename, so it is
reversible; the rollup links the archived path.

## 2. Trigger

**Threshold-on-write, not a timer.** After a digest write completes
(`memory-digest.ts` → `appendMemoryEntry`), check whether any closed week exceeds the
rollup threshold; if so, enqueue one sweep through the same serialized writer. A
background interval in main is avoided deliberately — it fires on machines nobody is
looking at and it is the classic source of "Capy touched my repo while I was away".

A manual entry point (Memory pane action, or a CLI/dev command) must exist for the
operator to run a sweep on demand.

## 3. Salience and pinning

Salience is **computed at query time**, not stored. Inputs:

- `age` — days since the page's provenance date;
- `tier` — `decisions`/`roadmap` are non-decaying, `sessions` decays, `archive`
  decays hardest;
- `pin` — boolean, from frontmatter `pinned: true`; exempt from decay entirely;
- `feedback` — the aggregate verdict for the page (§4).

Shape: exponential decay with a tier-specific half-life
(`sessions` ≈ 30 days, `archive` ≈ 7). Constants live in the pure core as named
exports so tests pin them and the Memory pane can explain them.

Salience is a **multiplier on the fused score** from [[T192]], applied after tier
weighting ([[T194]]). If T192 has not landed, `computeSalience` still ships and is
tested — it simply has no consumer yet, which is fine and must be stated in the
CHANGELOG entry rather than hidden.

## 4. `memory_feedback`

```
memory_feedback({ folder, page, verdict, note? })
  verdict: 'helpful' | 'stale' | 'wrong'
```

- **Gating:** direct write, no confirm — same class as `memory_append`
  (`tool-catalog.ts`, and the auto-allow list it feeds).
- **Validation:** `page` goes through `parseMemoryPage` (the existing traversal
  gate). `note` is capped and passes `lintSecrets` like any other written text.
- **Storage:** a sidecar ledger, `<memory-root>/feedback.jsonl`, one
  provenance-stamped line per verdict. Rationale: feedback is machine metadata with a
  high write rate; appending it into human-sovereign pages would churn files the
  operator reads and would put an agent's opinion inside someone else's document.
  The ledger is derived-ish but **not** disposable (unlike T192's index) — it is
  authored data, so it is durable and human-readable.
- **Aggregation:** last verdict per `(page, author)` wins; `wrong` from N distinct
  authors weighs more than N from one. Weighted, never decisive — a single `wrong`
  must not be able to bury a `decisions` entry (assert this in a test).

**No mutation of the page.** `wrong` marks; it does not edit or delete. The Memory
pane surfaces the mark next to the page.

## 5. Index slimming

`buildMemoryIndex` (pure, `memory-core.ts`) changes its "Cards by status" section:

- `ready`, `in-progress`, `review` — keep the inline wikilink runs (these are the
  columns a session acts on);
- `backlog`, `done` — counts only, plus a pointer ("query the board or
  `memory_query`").

This is a pure-function change with an existing unit test file
(`tests/mcp-memory-core.test.ts`) — update the fixture, measure the payload
difference, and put the before/after number in the CHANGELOG entry.

## 6. Test plan

- **Unit:** `planRollup` (open week excluded, grace boundary, empty week, one
  session), `renderRollup` (stable output for stable input — no clock, no ordering
  nondeterminism), `computeSalience` (pin exemption, tier half-lives, monotonicity in
  age), `applyFeedback` (idempotence, multi-author weighting).
- **Invariant test:** run a full sweep over a fixture memory and assert the set of
  _content hashes_ before and after is a superset — nothing lost, only moved.
- **e2e:** sweep with a live session writing into the current week (must not roll it
  up); `memory_feedback` on a nonexistent page (must fail closed); ledger survives
  app restart.

## 7. Out of scope

Any deletion path; UI for browsing rollups beyond what the Memory pane already
renders; LLM-authored rollup prose (additive follow-up); board/card status changes.
