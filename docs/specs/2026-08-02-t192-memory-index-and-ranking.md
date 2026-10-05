# T192 — memory index and ranking (implementation spec)

**Date:** 2026-08-02
**Card:** `T192-hybrid-memory-retrieval-fts5-entity-graph-neighbor-ranking-for`
**PRD:** [`docs/prds/T192-hybrid-memory-retrieval.md`](../prds/T192-hybrid-memory-retrieval.md)
**Status:** design draft — not implemented

## Where the code goes (ADR-0001 boundary)

`src/main/mcp/memory-core.ts` is a **pure** module by contract: no `fs`, no
`child_process`, no `electron`, no clock. The shell (`memory-store.ts`) reads bytes
and injects `now`. T192 must not breach that — it is the reason `grepMemory` takes
`readonly MemoryFile[]` instead of a directory.

| Concern                                                      | File                                     | Purity              |
| ------------------------------------------------------------ | ---------------------------------------- | ------------------- |
| Entity extraction from a page's text                         | `memory-core.ts` (new `extractEntities`) | pure, unit-tested   |
| Link/edge extraction (`[[…]]`, `deps:`, `spec:`, `session:`) | `memory-core.ts` (new `extractEdges`)    | pure, unit-tested   |
| RRF fusion + tier weighting + final ordering                 | `memory-core.ts` (new `fuseRankings`)    | pure, unit-tested   |
| SQLite open/schema/upsert/FTS5 query                         | `memory-index.ts` (new shell)            | env-bound, e2e-only |
| Wiring `memory_query` → index, grep fallback                 | `memory-store.ts`                        | env-bound           |

The pure layer never sees SQLite. `fuseRankings` takes **ranked id lists** (one per
layer) and returns a fused ordering — which makes the whole ranking decision testable
without a database.

## Index location

Follows the resolved memory root, never the repo: `resolveMemoryLocation()`
(`memory-store.ts`) already yields the effective `.capy/memory` for a folder under
[[T89]]'s global-default / per-project-override rules. The index lives beside it:

```
<memory-root>/.index/
  memory.db        # FTS5 + entities + edges
  meta.json        # schema version, last full build
```

`.index/` is derived state — add it to the memory dir's ignore surface so it never
lands in git and never appears as a memory `page`. `parseMemoryPage` already fails
closed on anything outside the fixed layout, so it cannot be read as a page; confirm
with a test rather than by inspection.

**Schema version mismatch ⇒ drop and rebuild.** Never migrate the cache.

## Table shape (draft)

```sql
CREATE TABLE page(
  id TEXT PRIMARY KEY,      -- memory page id, e.g. 'roadmap/T192-…', 'sessions/2026-08-02-ab12cd34'
  tier TEXT NOT NULL,       -- 'decisions' | 'roadmap' | 'sessions' | 'archive' | 'hot' | 'index'
  mtime INTEGER NOT NULL,   -- incremental-refresh key
  hash TEXT NOT NULL        -- content hash; unchanged hash ⇒ skip re-index
);
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  body, page UNINDEXED, heading UNINDEXED, tokenize='porter unicode61'
);
CREATE TABLE entity(page TEXT, term TEXT, kind TEXT);        -- kind: id|path|ident|noun
CREATE TABLE edge(src TEXT, dst TEXT, kind TEXT);            -- kind: wikilink|dep|spec|session|evidence
```

Chunking by heading (not by page) matters for `decisions.md`: a 104 KB append-only
file is one page but hundreds of independent decisions, and a whole-file BM25 score
is meaningless.

## Refresh

The memory writer is already serialized in the main process. Hook index refresh to
the same completion point (`appendMemoryEntry` in `memory-store.ts`) with a debounce,
plus a startup reconciliation pass that diffs `mtime`/`hash` against the table.

- Refresh is **best-effort**: an index write failure logs and leaves the DB stale; it
  never fails the memory write.
- Cold or missing index ⇒ `memory_query` answers from `grepMemory` and reports it, so
  the caller knows it got the degraded path. Do not block on a rebuild.

## Query path

```
memory_query(folder, query)
  → resolveMemoryLocation → index present & fresh?
      no  → grepMemory (v1, unchanged)
      yes → L1 FTS5(query)            → ranked page ids
            L2 entity match(query)    → ranked page ids
            L3 graph neighbors(L1∪L2) → ranked page ids
            fuseRankings([L1,L2,L3], tierWeights) → ordered matches (cap 50)
```

**RRF:** `score(p) = Σ_layers w_layer / (k + rank_layer(p))`, `k = 60` (the standard
constant; not tuned per corpus). Tier weighting arrives with [[T194]] — until then
`tierWeights` is a uniform stub so the seam exists but the behavior does not change
twice.

**Graph neighbors** are one hop from the top-N of L1∪L2, scored by hop origin rank,
not by their own text. Two hops is a follow-up: on 646 pages, hop-2 fans out enough
to drown the direct hits.

## Entity extraction (v1 heuristic, no LLM)

In priority order, capped at 10 per page:

1. card ids — `/\b(T\d+|BUG-\d+)\b/`
2. backticked identifiers and file paths — `` `memory-core.ts` ``, `src/main/…`
3. wikilink targets (already canonical page names)
4. capitalized multiword phrases outside code fences

Extraction is pure and unit-tested against fixtures drawn from real pages in this
repo's memory. Entities are written into the index, **not** back into the markdown
frontmatter in v1 — writing to every page to add machine metadata is a large,
irreversible edit to human-sovereign files, and the index can hold it just as well.
Revisit only if a consumer outside the index needs them.

## SQLite choice

Prefer **`node:sqlite`** (Node ≥ 22, built in — no native module, no
`electron-builder install-app-deps` rebuild on every Electron bump). Verify FTS5 is
compiled into the shipped Electron's SQLite before committing; if it is not, the
fallback is `better-sqlite3` and that decision gets an ADR (a second native module
changes the build contract described in CLAUDE.md).

## Test plan

- **Unit (pure):** `extractEntities`, `extractEdges`, `fuseRankings` — including the
  degenerate cases (empty layers, single layer, ties).
- **Fixture regression:** ~10 known-answer questions against a snapshot of this
  repo's memory; assert the expected page lands in the top 3. This is the only
  honest measure of "better than grep".
- **e2e:** rebuild-from-cold, delete-index-mid-query, index-write-failure ⇒ grep
  fallback, worktree A and worktree B of the same repo share one index.

## Out of scope

Vectors, LLM reranking, cross-repo search, new `memory_query` args, UI surfacing of
scores in the Memory pane.
