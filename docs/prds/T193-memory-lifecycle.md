# T193 — Memory lifecycle: rollups, decay, pinning, feedback

**Status:** PRD v1 (2026-08-02) · **Effort:** L · **Card:** [[T193]] · **Deps:** T79 (done) · T192 (ranking consumes the signals)
**Spec:** [`docs/specs/2026-08-02-t193-memory-lifecycle.md`](../specs/2026-08-02-t193-memory-lifecycle.md)
**Prior art:** [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory)

---

## 0. What this PRD protects

Project memory is **append-only by design** — provenance-stamped, never rewritten by
an agent, human files sovereign. That design has no exit. Nothing ages, nothing
merges, nothing is demoted; the only lifecycle event a page has ever had is _being
born_. This PRD adds a lifecycle **without** giving anything the power to delete or
silently rewrite what a human or a session wrote.

Hard invariant, inherited from T79: **decay changes ranking, never content.** No
sweep deletes a page. Consolidation writes a _new_ page and moves the originals to
the `archive/` tier that already exists for exactly this purpose.

## 1. Problem

Three symptoms of the same missing mechanism, measured on this repo:

**(a) The digest layer has no rollup.** `sessions/` holds **432 files** —
`YYYY-MM-DD-<id8>`, one per session per day, the same session id recurring across
~15 dates. Between "432 individual digests" and "one ≤500-word `hot.md`" there is
nothing. Nobody reads the middle, because there is no middle to read.

**(b) The catalog costs context on every read.** `index.md` inlines all 214 card
titles as wikilinks — ~36 KB regenerated on every write and returned by every
`memory_read` that omits `page`. The catalog was cheap at 22 cards. At 214 it is a
tax on the resume path it was built to accelerate.

**(c) Nothing is ever wrong.** A digest that recorded a plan later abandoned ranks
exactly like one that recorded what shipped. The system has no way to learn that a
page misled a session — and no session has any way to say so.

## 2. Prior art

ai-memory carries three mechanisms Capy lacks:

- **Time-based decay sweeps** over episodic pages — salience falls with age, so old
  evidence stops crowding out maintained knowledge without anyone curating it.
- **Pinning** — a pinned page is exempt from decay. This is how durable knowledge
  survives a sweep without needing a separate store.
- **`memory_feedback`** — an MCP verb where the agent marks a retrieved page
  `helpful` / `stale` / `wrong`, adjusting its future rank. Memory is corrected **by
  use**, not by a curation ritual nobody performs.

The third is the one Capy most conspicuously lacks: the digest engine already writes
and applies `hot.md` automatically (v2, post-BUG-26) with no approval gate — a
deliberate zero-friction choice — but there is no correction channel on the other
side. Auto-write without feedback is write-only.

## 3. Solution

### 3.1 Rollups

Compact digests into period pages: `sessions/rollup-2026-W31.md` (weekly) and
eventually monthly. The originals move to `archive/` (frozen, read-only tier that
already exists, currently holding 2 legacy pages). A rollup is generated from the
digests, carries their provenance range, and links back to each source page.

Target: the digest layer readable in **one page for a week**, with the individual
digests one click (or one `memory_read`) away.

Zero-LLM path: a deterministic rollup (per-session bullet lists, commit counts,
branches touched) is genuinely useful and always available. An LLM, when configured,
writes a prose summary on top — never as a precondition.

### 3.2 Decay and pinning

A `salience` signal per page, derived — not stored as mutable state in the markdown:
`f(age, tier, feedback, pin)`. Episodic pages (`sessions/`) decay; `decisions.md`,
cards, and pinned pages do not. Salience feeds [[T192]]'s ranking and nothing else.

Pinning is an explicit human or agent act on a card/page and is visible in the UI —
an invisible exemption is a trap.

### 3.3 `memory_feedback`

New MCP verb: `memory_feedback({ folder, page, verdict, note? })`,
`verdict: helpful | stale | wrong`. Direct write, same gating class as
`memory_append` (no confirm). It records a provenance-stamped feedback entry —
appended to the page or to a sidecar ledger (spec decides) — and feeds salience.

`wrong` never deletes and never edits the page body. It marks it. A human reading the
page still sees what was written and who disputed it.

### 3.4 Slim the index

`index.md` keeps the layer legend and a **counts-plus-non-terminal-columns** view
(`ready`, `in-progress`, `review`); the full 214-title dump moves behind
`memory_query` and the board UI, which is where it was actually being read from
anyway. The board is unaffected — it reads `roadmap/*.md`, not the catalog.

## 4. Non-goals

- **Deleting anything.** Ever, automatically. Archive is not deletion.
- **A retention policy the operator cannot see or override.** Decay must be
  explainable ("this ranked low because it is 9 weeks old and marked stale").
- **LLM-required consolidation.** Deterministic rollups first.
- **Touching the `done` column or card status.** Lifecycle here is about _pages_, not
  about board state machines.

## 5. Risks and open questions

1. **What triggers a sweep?** App start, a timer, or a threshold (N digests in a
   period)? A background timer in an Electron main process is a support burden;
   threshold-on-write is more predictable. **Open.**
2. **Rollup fidelity.** A bad rollup that archives its sources loses navigability in
   practice even though the bytes remain. Mitigation: rollups link every source page,
   and archiving is reversible by moving the file back.
3. **Feedback authorship.** An agent marking a page `wrong` is an unverified claim.
   Provenance must make the author obvious, and feedback must be _weighted_, never
   decisive — one `wrong` should not bury a decision.
4. **Interaction with T192.** Salience is a ranking input; if T192 has not landed,
   T193's signals have no consumer. Sequence accordingly (T192 first, or land T193's
   writer side and wire the reader later).

## 6. Acceptance

- `sessions/` steady-state: rollups exist for every completed week; the flat digest
  count in the live tier stays bounded while the archive grows.
- `memory_read` with no `page` returns a materially smaller payload than today
  (measure before/after; the ~36 KB catalog is the baseline).
- `memory_feedback` round-trips: mark a page `stale`, query again, observe it ranked
  lower — with the reason inspectable.
- No page is ever deleted by any code path introduced here (assert in tests).
- Contracts: new MCP verb ⇒ `docs/capy-features.md` + marker bump,
  `docs/user/agent-control.md`, CHANGELOG entry.
