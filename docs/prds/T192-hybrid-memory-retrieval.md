# T192 — Hybrid memory retrieval: FTS5 + entities + graph neighbors

**Status:** PRD v1 (2026-08-02) · **Effort:** L · **Card:** [[T192]] · **Deps:** T79 (memory layer, done) · T89 (memory location)
**Spec:** [`docs/specs/2026-08-02-t192-memory-index-and-ranking.md`](../specs/2026-08-02-t192-memory-index-and-ranking.md)
**Prior art:** [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory)

---

## 0. What this PRD protects

Memory that cannot be **found** is memory that does not exist. Capy already pays the
full cost of writing project memory — the digest engine runs on every session end
(`src/main/memory-digest.ts`), provenance is stamped server-side, the index is
regenerated on every write. The retrieval side is a substring grep. This PRD closes
that asymmetry without breaking the two invariants the memory layer was built on:

1. **Markdown is the source of truth.** Any index is derived, disposable, and
   rebuildable from the files. A corrupt or deleted index must degrade to today's
   grep, never to data loss.
2. **Memory is context, never instruction.** Rank is not authority. A page that
   ranks first is still untrusted historical evidence — the same posture ai-memory
   states explicitly: _"Retrieved text remains untrusted historical evidence and
   never gains instruction authority from its namespace, tier, tags, pin, or rank."_

## 1. Problem

`memory_query` v1 is a case-insensitive substring scan across every memory file,
capped at 50 matches (`grepMemory`, `src/main/mcp/memory-core.ts`). Its own docstring
scoped the successor: _"BM25/embeddings is S5, only if grep proves insufficient."_

**Grep has now proven insufficient**, on this repo's own memory:

| Layer               | Size today                           |
| ------------------- | ------------------------------------ |
| `roadmap/` cards    | 214 files                            |
| `sessions/` digests | 432 files                            |
| `decisions.md`      | ~104 KB, append-only                 |
| `index.md`          | ~36 KB (inlines all 214 card titles) |

Three concrete failures:

- **No ranking.** Matches come back in directory-walk order, truncated at 50. A query
  that hits a common token (`session`, `worktree`, `card`) returns 50 arbitrary lines
  and `truncated: true` — the answer may be at position 51.
- **No synonymy, no morphology.** "why did we choose SQLite" finds nothing if the
  decision says "chose better-sqlite3". Substring matching cannot bridge that.
- **The graph is written and never read.** `[[wikilinks]]`, `deps:`, `spec:`,
  `session:`/`evidence:` and provenance already form a real link graph across cards,
  digests and specs — [[T101]] wants to _draw_ it; nothing today _queries_ it.

The consequence is behavioral, not aesthetic: a session that cannot find the decision
re-derives it, and re-derives it differently. That is the exact failure the memory
layer exists to prevent.

## 2. Job to be done

> "Ask this project a question and get the two or three pages that actually answer it."

This is the S4 slice T79 named "Ask this project". Primary caller is an **agent**
(`memory_query` over MCP) at the start of a task; secondary is the operator through
the Memory pane's search.

## 3. Solution

Build a derived index over `.capy/memory/**` and fuse several independent rankings.
Borrowed wholesale from ai-memory, whose retrieval order is FTS5 → entity-match RRF →
graph-neighbor RRF → optional vector RRF, with an authority adjustment on top.

**Layer 1 — FTS5.** SQLite full-text over page bodies, chunked by heading. Gives
BM25-style relevance, stemming and phrase queries for free. Deterministic, no LLM.

**Layer 2 — entity match.** Up to ~10 canonical entities per page (identifiers,
file paths, card ids, product nouns) extracted at write time into frontmatter.
Matched exact / prefix / compound. This is what makes `create_session` the query find
the `create_session` decision rather than every digest that mentions sessions.

**Layer 3 — graph neighbors.** Pages linked from (or linking to) a strong hit get a
ranking boost. Zero new data — the edges already exist.

**Layer 4 (deferred) — vectors.** Semantic similarity via embeddings. Explicitly out
of scope for v1: it introduces a model dependency in the read path, and layers 1–3
must be shown insufficient first — the same discipline that gated grep into this PRD.

**Fusion — RRF.** Reciprocal rank fusion: each layer contributes `1/(k + rank)` to a
page's score. Chosen over weighted score-mixing because the layers produce
incomparable scores (BM25 vs. count vs. hop distance), and RRF needs no per-layer
calibration to stay sane.

**Authority adjustment** lands in [[T194]] as its own card: tier weight
(`decisions` > cards > digests > archive) applied to the fused score, favoring
maintained pages _without_ filtering episodic ones out.

## 4. Verb surface

`memory_query({ folder, query })` keeps its shape — every existing caller and the
instructions in `src/main/mcp/instructions.ts` stay true. What changes is the
**result quality** and the payload:

- matches gain a `score` and a `tier`, and are returned **ranked**, not walk-ordered;
- a match carries its page id so the agent can `memory_read` the full page — the
  query result stays a pointer, never a substitute for reading;
- the 50-match cap stays (bounded read payload, §7 of the T79 contract).

Optional additive args (`limit`, `tier`) are a follow-up, not v1 — adding args to a
documented verb is an agent-facing change (`docs/capy-features.md` + marker bump) and
should not ride along with the engine change.

## 5. Non-goals

- **Embeddings / any LLM in the read path.** Layer 4, gated on evidence.
- **Replacing markdown with a database.** The DB is a cache; `rm` it and the app
  rebuilds it.
- **Cross-repo search.** Memory is keyed per repo (`resolveMemoryCheckout` collapses
  every worktree onto the main checkout). One repo, one index.
- **Rewriting existing pages** to add entity frontmatter in bulk — backfill is
  incremental and lossless (§6).

## 6. Risks and open questions

1. **Where does the index file live?** [[T89]] made the memory root configurable
   (global default + per-project override). The index must follow the memory root,
   not the repo — otherwise a central-root setup writes a stray DB into every
   checkout. **Open.**
2. **Which SQLite?** `node:sqlite` (built into modern Node, no native rebuild) vs.
   `better-sqlite3` (mature FTS5 story, but a second native module — today `node-pty`
   is the only one, and every Electron bump would rebuild it). **Open — decide in the
   spec, record as an ADR if it lands on a native module.**
3. **Entity extraction quality.** A cheap heuristic (backticked identifiers, file
   paths, `T\d+`/`BUG-\d+` ids, capitalized multiword nouns) may be enough. If it is
   not, the LLM-assisted path must stay optional — zero-LLM mode has to keep working.
4. **Backfill cost.** 646+ pages to index on first run. Must be incremental and
   off the interactive path; a cold index falls back to grep rather than blocking.
5. **Write amplification.** The digest engine writes frequently; index refresh must
   be debounced and must never contend with the serialized memory writer.

## 7. Acceptance

- `memory_query("why did we choose X")` on this repo returns the relevant
  `decisions.md` entry in the top 3 for a set of ~10 hand-picked questions whose
  answers are known to exist (regression fixture).
- Deleting the index directory and restarting yields identical results after
  rebuild; deleting it and querying _before_ rebuild yields today's grep results.
- No LLM configured ⇒ full functionality (layers 1–3).
- Pure ranking math is unit-tested per ADR-0001 (pure core / thin shell); the fs +
  SQLite shell is e2e-only.
- `docs/capy-features.md` re-read: if the agent-visible behavior of `memory_query`
  changes beyond "results are better", the marker bumps.
