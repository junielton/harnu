---
status: approved
tier: complex
prd: docs/prds/T618-project-memory-upgrade.md
adr: docs/adr/0024-project-memory-architecture.md
---

# Memory U4: a wiki-link graph, link-aware `memory_query`, a graph tab, and a global layer of promoted rules and gotchas

_Chapter 5 of campaign `cmp-021a1d43` (the T618 project memory upgrade), written by card T624 (mission
`mnt-090374cf`, step `stp-6`). Product requirements: `docs/prds/T618-project-memory-upgrade.md` §3.4, §4
and §6. Architecture it must obey: `docs/adr/0024-project-memory-architecture.md` decisions (a) markdown is
the truth and every index is derived, and (d) two layers, repo and global. Evidence:
`docs/studies/2026-11-04-memory-audit.md` §3 and §5 U4. Critic pass on this spec:
`docs/specs/2026-11-04-memory-u4-graph-global/critics.md`._

## Problem

Project memory is a pile of files with no edges anyone reads. `memory_query` is a substring grep that
returns hits in file order (`grepMemory`, `src/main/mcp/memory-core.ts`), so a nine-week-old digest ranks
exactly like the decision that replaced it, and a page that answers the question but does not contain the
query word is never found. The `[[wiki-links]]` the board and the digests already write are parsed by
nobody. Nothing a session learns in one repo reaches a session in another, even when it is a lesson about
a tool both use.

Measured on this repo's memory (`.harnu/memory/` of the main checkout) on 2026-11-04 with a throwaway
parser that mirrors the resolution rules below:

| Fact                                                          | Value                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Readable pages (root + `roadmap/` + `sessions/` + `archive/`) | 2,122 (3 + 812 + 1,304 + 3)                                                                 |
| `[[…]]` occurrences, all files                                | 1,102, of which about 820 are the card catalog in the derived `index.md`                    |
| `[[…]]` occurrences outside `index.md` and fenced code        | 280                                                                                         |
| Resolution of those 280                                       | 19 exact page id, 173 unique file stem, 46 bare card id, 4 ambiguous, 38 unresolved (13.6%) |
| Cold parse + resolve of all 2,122 pages, one thread           | 126 ms                                                                                      |
| `~/.harnu/memory/` on this machine                            | already exists: it is the home folder's own folder-local memory (a non-git folder, §3.1)    |

Three consequences shape this spec. `index.md` must never be a node: it links every card, so it would be
every card's neighbour. The graph is sparse today; chapter 4's typed pages (with `[[wiki-links]]` and
evidence links) are what make it dense, so the recall gain from expansion is measured after them as well
(D-12). And the PRD's global path `~/.harnu/memory/` is already taken by the home folder's memory, so the
global layer needs its own root (D-5, Deviation row 1).

The request, atomized (one atom per sentence of the T624 objective, PRD §3.4 and the operator's notes the
card carries):

- R-1 Every `[[page]]` link in `.harnu/memory/**` becomes an edge in a derived, rebuildable link index, so the files connect the way Obsidian's graph connects them.
- R-2 The link index is rebuilt on every write and on demand, and lists the links it could not resolve.
- R-3 `memory_query` walks links: it expands its hits by their link neighbours.
- R-4 `memory_query` ranks maintained pages (`decision`, `rule`, `gotcha`) above episodic ones without hiding any.
- R-5 An expanded hit says it came through a link (`via: link`).
- R-6 The Memory pane gets a graph tab: nodes are pages by kind, edges are links, clicking a node opens the page.
- R-7 The files stay Obsidian-openable.
- R-8 Lessons (errors and successes) are reachable across projects.
- R-9 The operator is unsure full horizontal sharing is wise: a project knows other projects exist, and only cross-cutting rules and gotchas are promoted.
- R-10 A global layer under the operator's home holds only `rule` and `gotcha` pages promoted from repo memories, each carrying the repo it came from.
- R-11 Every repo's boot handoff reads the global layer.
- R-12 `memory_query` can search the repo, the global layer, or both.
- R-13 The Memory pane shows a "Global" lane.
- R-14 Global pages never carry repo paths or client identifiers.
- R-15 No repo can write another repo's memory.
- R-16 The chapter is accepted by the benchmark: it moves `recall_hit_at_5` and regresses no other metric.

### What already exists, cited

- **Page enumeration and the traversal gate.** `parseMemoryPage` in `src/main/mcp/memory-core.ts` admits
  `hot`, `decisions`, `index` and `roadmap/`, `sessions/`, `archive/`, `learning/` sub-pages, two segments
  at most. `listReadablePages` and `readAllMemoryFiles` in `src/main/mcp/memory-store.ts` walk the same
  set. Chapter 4 extends this set with typed pages (D-8); this spec reads pages only through the one
  enumeration S-1 exports, so chapter 4's kinds reach the graph without a second change.
- **The derived catalog.** `regenerateIndex` (`memory-store.ts`) rewrites `index.md` after every
  `appendMemoryEntry`. The link index is its sibling: derived, rebuildable, never a page (ADR-0024 (a)).
- **Where memory lives.** `resolveMemoryLocation` (`memory-store.ts`) and `resolveMemoryDir` /
  `resolveMemoryCheckout` (`memory-core.ts`) resolve a folder to its repo's memory dir, in-project
  (`<main checkout>/.harnu/memory/`) or central (`<root>/<repo>--<hash8>/`, `src/main/memory-location.ts`).
  A folder outside git gets a folder-local memory, which is why the home folder has `~/.harnu/memory/`.
  The card named a `memoryRootFor` function; no such function exists, `resolveMemoryDir` is the seam. The
  global layer is a third, fixed root beside these two, never a fallback of either.
- **Recall.** `recallEntries` (`src/main/mcp/memory-entries.ts`) returns decisions whose `watches` overlap
  a mission's scope. The graph does not change recall; it gives `memory_query` the same "what is this
  connected to" reach for every page.
- **The verb.** `memoryQueryHandler` (`src/main/mcp/tool-handlers.ts`) calls `queryMemory`
  (`memory-store.ts`); its schema is the `memory_query` entry in `src/main/mcp/tool-catalog.ts`. A schema
  change there is agent-facing (`docs/harnu-features.md` with a marker bump, today `v120`) and
  user-visible (`docs/user/agent-control.md`), and the CI gates `scripts/ci/awareness-gate.mjs` and
  `scripts/ci/user-docs-gate.mjs` enforce both.
- **The pane.** `MemoryPane.vue` has three tabs (`hot`, `decisions`, `timeline`) over `useMemoryStore`
  (`src/renderer/src/stores/memory.ts`) and the `memory:read` IPC (`src/main/memory-ipc.ts`,
  `src/preload/index.ts`). Its design contract is `design.md` §6 "Memory pane (project memory viewer,
  non-PTY)".
- **The canvas.** `createCanvasGraph` (`src/renderer/src/components/canvas/canvas-graph.ts`) builds an X6
  graph that is read-only unless `editable: true`; `renderCanvasDocument` draws a `CanvasDocument`
  (`src/main/canvas-core.ts`, checked by `validateCanvasDocument`); `readCanvasPalette`
  (`canvas/canvas-theme.ts`) themes it; `fitCanvas` frames it.
- **Privacy primitives.** `lintSecrets` (`memory-core.ts`) refuses credential shapes and reports the kind,
  never the text. `tests/no-client-identifiers.test.ts` defines the identifier shapes this repo refuses
  (tracker keys `[A-Z]{2,6}-[0-9]{2,6}` in either case, `Workspace/<name>`, `Workspace-<slug>`) and reads
  the maintainer's local `.harnu/private-denylist.txt`.

### Decisions this spec settles

**The graph view reuses the canvas.** The tab renders through `createCanvasGraph({ editable: false })` and
`renderCanvasDocument`, from a `CanvasDocument` that a pure function builds out of the link index. Reasons:
the X6 stack is already shipped and pinned (`package.json` `dependencyNotes`), so the tab adds no
dependency; the read-only mode, zoom, pan, fit and theme switch exist and are tested
(`tests/canvas-pane-render.test.ts`); nodes and edges get the same look as every other board in Harnu. T101's
library candidates (vue-flow, d3-force, cytoscape) would each add a dependency and a second graph look for
one tab. The cost accepted: X6 draws SVG nodes, so the tab is capped at 300 nodes (AC-24), and the layout is
a small deterministic force layout written in the pure function, since X6 2.x ships no layout.

**One enumeration, one matcher.** The lexical layer of the new ranking is the existing case-insensitive
substring match, unchanged, so the benchmark's graph-on versus graph-off run isolates the effect of
expansion. A tokenized or full-text matcher is the PRD's next step only if `recall_hit_at_5` stays under
target after this chapter (PRD §5, ADR-0024 §5).

**Promotions always wait for the operator.** A write to the global layer reaches every repo's boot, so it
never auto-applies, whatever the operator chooses for repo memory in the PRD's D-2. Recorded as D-4 with
this default.

### Formats the slices build to

These are the contract between slices; a slice does not invent them.

**The link index file** (`<memoryDir>/.index/links.json`, D-2). Written atomically (temp file and rename)
under a per-memory-dir lock (`serializeByKey`, as `appendMemoryEntry` uses). Beside it,
`<memoryDir>/.index/.gitignore` holds the single line `*`, written if absent, so the directory ignores
itself in any repo and in central mode. Shape:

```json
{
  "schema": 1,
  "builtAt": "2026-11-04T12:00:00.000Z",
  "pages": {
    "roadmap/T101-memory-graph-canvas": {
      "mtimeMs": 1762250000000,
      "size": 3612,
      "kind": "card",
      "title": "T101: Graph/canvas view …",
      "links": [{ "raw": "T79-project-memory", "line": 31, "section": 2 }]
    }
  },
  "edges": [
    {
      "from": "roadmap/T101-memory-graph-canvas",
      "to": "roadmap/T79-project-memory",
      "line": 31,
      "section": 2
    }
  ],
  "unresolved": [
    {
      "from": "sessions/2026-08-01-ab12cd34",
      "target": "T55…",
      "line": 9,
      "reason": "missing",
      "candidates": []
    }
  ]
}
```

`pages` keys, `edges` (by `from`, `line`, `to`) and `unresolved` (by `from`, `line`, `target`) are sorted,
and the file is `JSON.stringify(value, null, 2)` plus a newline. Back-links are derived at load by
inverting `edges`, never stored. A memory dir that holds no pages gets no file.

**Pages and their kind.** S-1 adds one exported lister, `listMemoryPages(memoryDir): Promise<string[]>`,
returning sorted page ids for exactly the locations `listReadablePages` covers today (root `*.md`,
`roadmap/`, `sessions/`, `archive/`, `learning/`); `listReadablePages` and `readAllMemoryFiles` are
rewritten on top of it. Chapter 4 adds its `pages/` directory to this one function (D-8: one file per
typed page at `pages/<kind>-<slug>.md`, page id `pages/<kind>-<slug>`, inside today's two-segment gate), so the
graph sees those pages without a second change. The root pages `index` and `where` (the derived catalog and the
central-mode backlink) are excluded from `pages`, `edges` and `unresolved` and are never parsed; a link to
either is dropped, not reported. `kind` comes from the directory (`roadmap/` → `card`, `sessions/` →
`session`, `archive/` → `archive`, `learning/` → `learning`, `pages/<kind>-…` → `<kind>` (the file-name prefix before the first `-`), root `hot` → `hot`, root `decisions` →
`decisions`, any other root page → `other`); a top-level frontmatter `kind:` whose value is `decision`,
`gotcha`, `rule` or `concept` overrides it. S-4 adds `global-rule` and `global-gotcha`. `title` is the
frontmatter `title`, else the first `# ` heading, else the page id. A page that cannot be stat'ed or read
(it vanished between the listing and the read) is skipped for this pass.

**Link parsing** (pure). A link is `[[target]]`, `[[target|alias]]` or `[[target#heading]]` (and the two
combined), anywhere in the file including YAML frontmatter, so chapter 4's `evidence: [[sessions/…]]` is an
edge. A `\` before the `|` (Obsidian's escape inside tables) is dropped. An empty target is dropped
silently. `line` is 1-indexed from the first line of the file, frontmatter included. Code is skipped with
CommonMark's rules: a fence opens on a line indented at most three spaces with three or more backticks or
tildes, closes on a line of the same character at least as long, and an unclosed fence runs to the end of
the file; an inline code span is a run of N backticks closed by the next run of exactly N backticks on the
same line, and spans never cross lines. `section` is the index of the heading block the line sits in: 0
before the first heading, then +1 at every line outside a fence and outside the leading `---` frontmatter
block that starts with one to six `#` and a space.

**Link resolution** (pure, in this order; the first rule with exactly one candidate wins, and a rule with
more than one candidate stops resolution as `ambiguous`):

1. Normalize `raw`: drop `|alias` and `#heading`, trim, drop a trailing `.md`.
2. An exact page id (`roadmap/T101-memory-graph-canvas`, `decisions`).
3. A unique file stem, compared case-insensitively, across every directory (Obsidian's rule:
   `[[T101-memory-graph-canvas]]` finds `roadmap/T101-memory-graph-canvas.md`).
4. A bare card id (`^(T\d+|BUG-\d+)$`, case-sensitive) naming exactly one `roadmap/` page whose stem is
   the id or starts with `<id>-`. This is a Harnu extension that Obsidian does not resolve; it is read, never
   written back.
5. Otherwise unresolved: `reason: "ambiguous"` with the sorted `candidates` when a rule found more than one,
   else `reason: "missing"` with `candidates: []`. A link that resolves to its own page is dropped.

From S-4 on, a target that starts with `global/` is resolved only against the global page list (rule 2
exactly, `global/rules/<slug>` or `global/gotchas/<slug>`) and the edge is kept in the repo index with that
`to`; before S-4 it is unresolved `missing`. Rules 3 and 4 never match a global page from a repo page.

**Refresh.** `refreshLinkIndex(memoryDir, now)` and `rebuildLinkIndex(memoryDir, now)` both return
`{ index, rebuilt: boolean, parsed: number }` (`parsed` = pages re-parsed in this call; `now` stamps
`builtAt`). `refreshLinkIndex` stats every page from `listMemoryPages`, re-parses only pages
whose `mtimeMs` or `size` changed or that are new, drops removed pages, then re-resolves every stored link
(resolution is cheap; only parsing is incremental). It runs after every successful `appendMemoryEntry` and
before every `memory_query` and `memory:graph` read, so a card written through the roadmap path, a digest
written by `memory-digest.ts` and a hand edit in Obsidian are all picked up without touching their writers.
`rebuildLinkIndex` re-parses everything; `refreshLinkIndex` calls it when the file is missing, unparsable or
carries another `schema`, and the graph tab's reload button calls it directly. A failure to write the index
is logged and swallowed: it never fails a memory write, and the reader works from the returned in-memory
index. `moveMemoryDir` (the central-storage move) needs no special handling: `.index/` moves with the
directory and a stale entry is re-parsed on the next refresh.

**Neighbours** (pure). `neighbours(index, page, { lines? })` returns the targets of the page's out-edges in
the sections that contain `lines` (`lines` omitted means every section; an empty array means no out-edges,
so a hit in one dated block of `decisions.md` does not drag in every link of the 400 KB file), plus every
page with an edge into `page` (back-edges are never section-limited), deduplicated and sorted by page id.
One hop only.

**Ranking** (pure, `rankMemoryQuery`). Inputs: the lexical hits of the unchanged matcher over every page
(all of them, not the first 50 in file order), the link index, `graph` and `limit`.

- Lexical order: pages by hit count (descending), then page id. `rank_lex(p)` is the 1-based position.
- Seeds: the first 10 pages in lexical order. For each seed, its `neighbours` restricted to the seed's hit
  lines, capped at 5 per seed in their sorted order. A neighbour's `rank_link` orders candidates by the best
  `rank_lex` of a seed that reaches it, then by how many seeds reach it (descending), then page id; 20
  neighbours at most. With `graph: false` there are no neighbours.
- `score(p) = tier(p) × (L(p) + N(p))`, where `L(p) = 1 / (60 + rank_lex(p))` when `p` has a lexical hit
  and 0 otherwise, and `N(p) = 1 / (60 + rank_link(p))` when `p` is a kept neighbour and 0 otherwise
  (reciprocal rank fusion, `k = 60`). Rounded to 4 decimals; pages are ordered by score descending, then
  page id. `tier(p)` is D-9's table.
- `via` is `hit` for a page with a lexical hit (even if it is also a neighbour) and `link` otherwise; a
  `link` page carries `from`, the seeds that reached it, at most 3, in seed order.

**`memory_query` result** (S-2; `scope` from S-4). New input fields: `graph?: boolean` (default `true`,
D-10), `limit?: integer 1..20` (default 10), `scope?: "repo" | "global" | "all"` (S-4, default `all`,
D-11). The result keeps every existing field and adds to it:

```json
{
  "ok": true,
  "query": "hibernation",
  "graph": "on",
  "pages": [
    {
      "page": "decisions",
      "title": "decisions",
      "kind": "decisions",
      "scope": "repo",
      "via": "hit",
      "hits": 3,
      "score": 0.0164
    },
    {
      "page": "roadmap/T127-system-monitor",
      "title": "T127: …",
      "kind": "card",
      "scope": "repo",
      "via": "link",
      "from": ["decisions"],
      "hits": 0,
      "score": 0.0131
    }
  ],
  "matches": [
    { "page": "decisions", "line": 412, "text": "…hibernation…", "via": "hit", "scope": "repo" },
    {
      "page": "roadmap/T127-system-monitor",
      "line": 13,
      "text": "# T127 …",
      "via": "link",
      "from": ["decisions"],
      "scope": "repo"
    }
  ],
  "truncated": false
}
```

`graph` is `on`, `off` (the caller passed `false`) or `unavailable` (the index could not be built; the
answer is the lexical ranking). `matches` lists the lexical lines of the ranked pages in page order, then by
line, then for each `link` page one line: its first `# ` heading, else line 1. `matches` stays capped at 50
(`MEMORY_QUERY_MAX_MATCHES`) and `truncated` is true when lexical lines were dropped. `supersededBy` on a
match inside a superseded decision is kept (`annotateSuperseded`). Because `matches` follows page order, the
first five distinct page ids of `matches` equal the first five of `pages`: the benchmark's
`recall_hit_at_5` reads either.

**The graph read** (S-3). IPC `memory:graph` with `{ folder, rebuild?: boolean }` returns
`{ ok: true, data: { memoryDir, nodes, edges, totalNodes, truncated, unresolved } }` or
`{ ok: false, error }`. `nodes` are `{ id, kind, title, degree, scope, file }` (`file` relative to
`memoryDir`); a page is a node when its degree is at least 1, and `hot` and `decisions` always are. Nodes
are capped at 300 by degree (descending), then id; `truncated` says nodes were dropped, `totalNodes` how
many qualified. `edges` are unique `{ from, to }` pairs between kept nodes. `unresolved` is the count.

**The graph document** (pure, `buildMemoryGraphDocument` in `src/renderer/src/lib/memory-graph.ts`).
Builds a `CanvasDocument` that `validateCanvasDocument` accepts: one `box` node per graph node (label = title
cut to 40 characters with `…`, `origin: "agent"`, `style.tone` by kind: `decisions` and chapter-4 kinds
`accent`, global kinds `amber`, `hot` `green`, `card` `default`, `session`, `archive` and `learning`
`muted`), one edge per pair. Positions come from a deterministic force layout: initial positions on a
circle ordered by node id, 200 iterations of Fruchterman–Reingold with a fixed temperature schedule, no
randomness, coordinates rounded to integers. Same input, same document, byte for byte.

**The global layer** (S-4, D-5). Root `globalRoot(home = os.homedir())` =
`<home>/.harnu/global/`. Every store function takes the root as an argument, so a test or the benchmark
points it at a fake home (the benchmark through `HOME`):

```
~/.harnu/global/
  rules/<slug>.md       accepted rule pages
  gotchas/<slug>.md     accepted gotcha pages
  pending/<id>.md       proposals waiting for the operator
  rejected/<id>.md      proposals the operator rejected (kept, never deleted)
  retired/<slug>.md     pages the operator withdrew (kept, never deleted)
  origins.json          local map repo-<hash8> → folder basename, read only by the pane
  .index/links.json     the global link index (same format, ids prefixed global/)
```

Every write under the root runs under one `serializeByKey` lock keyed by the root, and every file is claimed
with an exclusive create (`flag: 'wx'`, temp file then `link`, never a `rename` over an existing name), so
nothing is ever overwritten: a name already taken in `rules/`, `gotchas/`, `rejected/` or `retired/` gets the
first free suffix `-2`, `-3`, ….

Page ids are `global/rules/<slug>` and `global/gotchas/<slug>`. `listGlobalPages(root)` returns them sorted;
`parseGlobalPage` is their gate: exactly three segments, the first `global`, the second `rules` or `gotchas`,
the third matching the slug rule below; the joined path is re-checked to stay inside the root. A slug is the
title lowercased, every run of characters outside `[a-z0-9]` turned into one `-`, leading and trailing `-`
trimmed, cut to 60 characters (and re-trimmed), `lesson` when empty; it matches `^[a-z0-9]+(-[a-z0-9]+)*$`.
The slug recorded in a proposal is a preview; the accept fixes the final one with its suffix.

**What a global page holds.** The frontmatter is an allowlist, exactly: `kind` (`rule` or `gotcha`),
`title`, `valid_from` (copied from the source when present), `origin: repo-<hash8>` (`hash8` of the source
main checkout path, `memory-core.ts`), `promoted_at` (ISO date of the accept) and `promoted_by: human`. Every
other source key (`evidence`, `watches`, `supersedes`, unknown keys) is dropped. A proposal holds the same
keys minus the two `promoted_*`, plus `source_page` (the repo page id), `slug` (the preview),
`proposed_by: agent | worker`, `proposed_at` and an optional `note`; `source_page`, `slug`, `note` and the
`proposed_*` keys are dropped on accept. The body is the source page body with every `> provenance:` line,
every `> entry:` line and every `superseded_by` mark removed (`memory_append`'s stamps carry branch, session
id and entry ids). The global root is never the memory dir of any folder: `~/.harnu/memory/` stays the home
folder's memory.

**`memory_promote`** (S-4, a new MCP verb, D-3). Input `{ folder, page, note? }` (`note` at most 500
characters). It reads the repo page through the repo gate (after chapter 4, a typed page such as
`pages/rule-<slug>`, D-8). Refusals, each `{ ok: false, error, detail, … }`: `BAD_PAGE` and
`PAGE_NOT_FOUND` as `memory_read`; `PROMOTE_NOT_PROMOTABLE` unless the page's `kind` is `rule` or `gotcha`;
`PROMOTE_PRIVACY` with `kinds: string[]` (never the matched text); `PROMOTE_DUPLICATE` with
`existing: { where: "rules" | "gotchas" | "pending", id }` when a page or proposal there has the same
normalized title (lowercase, whitespace collapsed); `rejected/` and `retired/` do not count, so a page
re-proposed after an edit is accepted as a new proposal. Otherwise it writes `pending/<id>.md` with
`id = p-<hash8(origin + "\n" + source_page + "\n" + title)>` and records `repo-<hash8> → basename` in
`origins.json`. ACK `{ ok: true, proposalId, kind, title, slug }`. It never writes `rules/`, `gotchas/` or
any repo memory. Its catalog entry mirrors `memory_append`'s (`mutates: true`, `alwaysAllowable: true`,
`silentAllowInAgentFolder: true`, grantable as `memory_append` is), so it runs without a confirm, and the
Scheduler `observe` deny list, which is derived from the catalog, denies it to read-only ticks.

**The privacy check** (pure, `checkGlobalPrivacy(text, ctx)`), run on the title, the slug preview, the
`note` and the stripped body at propose time, and again on the pending file at accept time (it can be
hand-edited). `ctx` is `{ checkout, centralFolderName, remotes, denyTerms }`: the source main checkout path,
its `centralMemoryFolderName`, every URL `git remote -v` prints for it (an error means `[]`), and the deny
terms, which are the checkout basename and each org and repo token of every remote (terms shorter than four
characters skipped) plus every line of the main checkout's `.harnu/private-denylist.txt` when that file
exists. It refuses with the list of kinds that matched:

```text
secret         lintSecrets refuses
absolute-path  (?:^|[\s"'(`])(?:/(?:home|Users|root|mnt|media|opt|srv|var|tmp|private|Volumes)/\S+|~/\S*|[A-Za-z]:\\\S+)
tracker-key    \b[A-Z]{2,6}-[0-9]{2,6}\b unless the prefix is one of UTF ISO SHA RFC CVE HTTP TLS IPV ES ECMA;
               in the slug also \b[a-z]{2,6}-[0-9]{3,6}\b
card-id        \b(?:T|BUG-)[0-9]{2,5}\b                      (a Harnu card id is a project fact)
workspace-dir  Workspace[/-][A-Za-z0-9_.-]+
repo-path      ctx.checkout or ctx.centralFolderName as a substring
remote-url     any of ctx.remotes; git@[\w.-]+:[\w.-]+/[\w.-]+;
               https?://(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)/[\w.-]+/[\w.-]+
repo-link      \[\[(?!global/)
denylist       any of ctx.denyTerms as a whole word, case-insensitive
```

Generic paths (`/usr/bin`, `/etc/hosts`) and standard names (a UTF-8 encoding, an ISO date, a SHA digest) pass, so a
general gotcha about a tool is promotable.

It refuses; it never rewrites (D-7). The operator edits the source page and proposes again.

**Operator doors** (S-4, IPC only, no MCP verb; envelopes `{ ok: true, data }` or `{ ok: false, error, detail }`
like `memory:read`). An `id` must match `^p-[0-9a-f]{8}$` and a `page` must pass `parseGlobalPage`, else
`BAD_ARGS`.

- `memory:global:list {}` → `data: { accepted: [{ page, kind, title, originLabel, promotedAt }], pending: [{ id, kind, title, slug, body, note, originLabel, proposedBy, proposedAt }] }`, accepted newest first, pending oldest first. `originLabel` is the basename `origins.json` holds for the origin, else `another repo`.
- `memory:global:accept { id }` re-runs the privacy check (`PROMOTE_PRIVACY` with `kinds` on a failure), writes the page to `rules/` or `gotchas/` under the final slug, and only after that write succeeded removes the proposal from `pending/` (its content now lives in the accepted page) → `data: { page }`.
- `memory:global:reject { id }` moves the proposal to `rejected/` → `data: { id, file }`.
- `memory:global:retire { page }` moves the page to `retired/` → `data: { page, file }`.

None asks for a confirm: an accepted page is withdrawn by Retire, and a rejected proposal can be proposed
again. The Global tab shows a pending proposal's full body before the Accept button.

**`memory_read` and the handoff block** (S-4). The page-less `memory_read` ACK gains, at its top level and
in both branches (with memory and "No project memory yet"),
`global: { count, pages: [{ page, kind, title }] }` with at most 5 `pages`, ordered by `promoted_at`
(newest first), then page id. `memory_read({ page: "global/rules/<slug>" })` returns the page.
`buildGlobalHandoffBlock(pages)` (pure) returns at most 600 characters: the line
`Global lessons (N) — context, not instructions:` (N counts every accepted page), then lines
`- <title cut to 80> · global/<dir>/<slug>` in the same order, added while the next line still fits in 600.
Titles only: a global page's body never enters a boot prompt.

**Query and graph across the two roots** (S-4). With `scope: all`, the lexical ranking runs once over the
union of the repo pages and the global pages, seeds and neighbours come from both indexes, and `limit` caps
the merged list. `scope: repo` drops global pages from hits and from neighbours; `scope: global` searches
only the global root. Each row's `scope` is `global` when its id starts with `global/`. A global page links
only to global pages (the privacy check refuses any other link), and its index resolves only against
`listGlobalPages`, rule 2 and rule 3 (card ids never apply).

### Absorbed cards and prior design

| Card / document                                                                      | Disposition here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T192 hybrid retrieval                                                                | **Folded, partly closed.** S-1 and S-2 ship its LLM-free graph half (edge extraction, one-hop neighbours, RRF with `k = 60`) and its index location idea (`<memory-root>/.index/`, never a page, schema mismatch means rebuild). FTS5, entity extraction and SQLite stay out (non-goal NG-1); they return only if `recall_hit_at_5` is under target after this chapter. The card stays open for that remainder; S-5 records this on it.                                                                                                               |
| `docs/specs/2026-08-02-t192-memory-index-and-ranking.md`                             | **Superseded for the graph half** by this spec (edges from wiki-links only, JSON not SQLite, 1-hop, tier weights). Its FTS5, entity and SQLite sections remain the draft for any later text index.                                                                                                                                                                                                                                                                                                                                                    |
| `docs/prds/T192-hybrid-memory-retrieval.md`                                          | **Taken in part**: the no-LLM, markdown-is-truth posture and the one-hop neighbour layer. Embeddings and vectors stay a non-goal (PRD T618 §5).                                                                                                                                                                                                                                                                                                                                                                                                       |
| T194 authority-tiered ranking                                                        | **Closed by S-2**: the tier weight is a factor of the same score as neighbour expansion (D-9), it orders and never filters, and ranked text never gains instruction authority.                                                                                                                                                                                                                                                                                                                                                                        |
| T101 memory graph view                                                               | **Closed by S-3** for its core ask (a graph of the memory, typed nodes, click opens the page). Its later ideas (live fleet state on nodes, dragging connections as a gesture, urgency layouts) are deferred: they need a product decision the card itself left open, and the tab is read-only by design (NG-4).                                                                                                                                                                                                                                       |
| T264 lesson store every worktree can see                                             | **Closed for its cross-repo part by S-4** (lessons reach other repos as promoted `rule` / `gotcha` pages). Worktree visibility and the budget belong to chapter 3. Its item (3), promoting a lesson into `docs/lessons/`, is not built by any chapter: NG-6 here, and Deviation row 2 notes that PRD §7 calls T264 closed.                                                                                                                                                                                                                            |
| Chapter 4 page model (T623, `docs/specs/2026-11-04-memory-u3-consolidation/spec.md`) | **Depended on, not redefined.** S-1 needs only "pages are enumerated by one function and carry a `kind`"; S-4 needs pages of kind `rule` and `gotcha` with a `title` (and `valid_from` when present) in frontmatter, reachable through the repo gate. The approved chapter-4 spec puts one file per typed page at `.harnu/memory/pages/<kind>-<slug>.md` (page id `pages/<kind>-<slug>`), with frontmatter as that spec defines; D-8 is decided on it, and the Amendments table records how it differs from the T623 card's `pages/<kind>/<slug>.md`. |

## Goals

- G-1 Asking memory "why did we choose X?" returns the decision and the pages it links to, maintained pages first, with each expanded page saying how it was reached.
- G-2 The operator opens a graph of the repo's memory in the Memory pane and clicks through to any page.
- G-3 A rule or gotcha learned in one repo reaches every repo's next session as a title in its boot handoff, only after the operator accepted it, and carries nothing that identifies the repo it came from.
- G-4 The benchmark shows `recall_hit_at_5` up by at least 0.10 from expansion and no other metric worse than its stated budget.

**Non-goals:**

- NG-1 No embeddings, vector search, FTS5, entity extraction or SQLite; the lexical layer stays the existing substring matcher. (R-3, R-4)
- NG-2 No full shared cross-repo graph: a repo's pages, digests, decisions and cards never leave it; only accepted `rule` and `gotcha` pages are global, and global pages link only to global pages. (R-9, R-15)
- NG-3 No decay, pinning or time-based salience (T193's remainder). (R-4)
- NG-4 The graph tab is read-only: no dragging, no drawing links, no editing from the graph, no live fleet state on nodes. (R-6)
- NG-5 Frontmatter fields other than wiki-links (`deps:`, `parent:`, `spec:`) are not edges in this chapter; the edge record keeps room for a `kind` later. (R-1)
- NG-6 No promotion into `docs/lessons/` and no sync of the global layer across machines. (R-8)
- NG-7 No MCP verb accepts, rejects or retires a promotion; those are operator doors. (R-9)

**Anti-goals:**

- A graph that is a screensaver: if the tab shows a hairball of 2,000 unconnected digests, it failed even if every AC passed (hence degree ≥ 1 and the 300 cap).
- A global layer that leaks one client's paths, ticket keys or names into another client's session.
- A ranking that hides a page: a strong hit in an old digest must still be returned.
- A second source of truth: the link index is a cache, and deleting `.index/` loses nothing.

## Slices

Six slices, one PR each. S-0 is this spec. S-1 then S-2 and S-3 in parallel (they share no file but
`CHANGELOG.md`), S-4 after both and after chapter 4's page model and chapter 3's handoff, S-5 last.

### S-0 · Land the spec bundle

- depends-on: —
- substrate: worktree
- files-may-touch: `docs/specs/2026-11-04-memory-u4-graph-global/spec.md`, `docs/specs/2026-11-04-memory-u4-graph-global/critics.md`
- produces: u4-spec
- consumes: existing:spec-template, existing:spec-gate
- acs: AC-1, AC-2

### S-1 · Link index: parse, resolve, store, refresh

- depends-on: S-0
- substrate: worktree
- files-may-touch: `src/main/mcp/memory-links-core.ts` (new), `src/main/mcp/memory-store.ts`, `tests/memory-links-core.test.ts` (new), `tests/memory-links-store.test.ts` (new), `tests/fixtures/memory-graph/**` (new), `CHANGELOG.md`
- produces: link-index
- consumes: existing:memory-page-enumeration
- acs: AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12

`memory-links-core.ts` is pure (ADR-0001: no `fs`, no clock): `parseLinks`, `resolveLinks`,
`buildLinkIndex`, `neighbours`. `memory-store.ts` gains the shell: `listMemoryPages` (see "Pages and their
kind"), `refreshLinkIndex`, `rebuildLinkIndex`, and the call after a successful `appendMemoryEntry`. The
fixture's typed page sits in `archive/` with a frontmatter `kind:`, so S-1 does not depend on chapter 4's
gate change landing first; the kind override is what it exercises. Once chapter 4's S-1 is on `main`, the
fixture also holds one `pages/<kind>-<slug>.md` page. The CHANGELOG entry is `### Changed`
(the index is invisible until S-2 and S-3 read it).

### S-2 · `memory_query` ranks by tier and expands by links

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/main/mcp/memory-rank-core.ts` (new), `src/main/mcp/memory-store.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/mcp/tool-catalog.ts`, `tests/memory-rank-core.test.ts` (new), `tests/mcp-memory-core.test.ts`, `scripts/memory-bench-core.mjs` (created by T620), `scripts/memory-bench.mjs` (created by T620), `tests/memory-bench-core.test.ts` (created by T620), `docs/harnu-features.md`, `docs/user/agent-control.md`, `docs/user/project-memory.md`, `CHANGELOG.md`
- produces: ranked-query
- consumes: link-index, existing:memory-bench
- acs: AC-13, AC-14, AC-15, AC-16, AC-17, AC-18, AC-19

`queryMemory` gains `{ graph, limit }` and returns the result shape above; `grepMemory`'s matching rule is
reused unchanged as the lexical layer. The benchmark gains `--no-graph`, which passes `graph: false` to `memory_query`, so S-5 can run the
A/B on the same corpus and question set.

### S-3 · Graph tab in the Memory pane

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/main/mcp/memory-store.ts`, `src/main/memory-ipc.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/lib/memory-graph.ts` (new), `src/renderer/src/components/MemoryPane.vue`, `src/renderer/src/components/MemoryGraphView.vue` (new), `src/renderer/src/stores/memory.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `docs/user/project-memory.md`, `tests/memory-graph.test.ts` (new), `tests/memory-pane-graph.test.ts` (new), `tests/memory-links-store.test.ts`, `CHANGELOG.md`
- produces: graph-tab
- consumes: link-index
- acs: AC-20, AC-21, AC-22, AC-23, AC-24, AC-25, AC-26

`MemoryGraphView.vue` is the canvas host (lifecycle, palette watch, click handling) so `MemoryPane.vue` only
adds the tab. `design.md` §6 "Memory pane (project memory viewer, non-PTY)" is edited first, in the same PR:
the tab strip becomes `hot · decisions · timeline · graph`, and a "Graph tab" paragraph fixes the node tones,
the empty state, the truncated note and the reload behaviour. New i18n keys under `memoryPane.tab.graph` and
`memoryPane.graph.*` land in both `en.json` and `pt-BR.json`. Because it adds a top-level component, the PR
also updates `docs/user/project-memory.md` "The memory pane" (user-docs gate).

### S-4 · Global layer: promote, accept, read, query, handoff

- depends-on: S-2, S-3
- substrate: worktree
- files-may-touch: `src/main/mcp/memory-global-core.ts` (new), `src/main/mcp/memory-global-store.ts` (new), `src/main/mcp/memory-links-core.ts`, `src/main/mcp/memory-store.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/mcp/tool-catalog.ts`, `src/main/memory-ipc.ts`, `src/main/hook-bridge.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/renderer/src/components/MemoryPane.vue`, `src/renderer/src/components/MemoryGlobalLane.vue` (new), `src/renderer/src/stores/memory.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `docs/harnu-features.md`, `docs/user/agent-control.md`, `docs/user/project-memory.md`, `tests/memory-global-core.test.ts` (new), `tests/memory-global-store.test.ts` (new), `tests/memory-pane-graph.test.ts`, `tests/mcp-memory-core.test.ts`, `CHANGELOG.md`
- produces: global-layer
- consumes: ranked-query, graph-tab, existing:u3-typed-pages, existing:u2-boot-handoff, existing:u2-memory-read-tiers
- gated-by: D-1, D-3, D-4, D-5, D-8
- acs: AC-27, AC-28, AC-29, AC-30, AC-31, AC-32, AC-33, AC-34, AC-35, AC-36, AC-37, AC-38

**Preconditions.** S-4 is not dispatched before three things from other chapters exist on `main`, each
named by its spec: chapter 4's typed pages of kind `rule` and `gotcha`, reachable through the repo gate and
`listMemoryPages` (D-8); chapter 3's tiered `memory_read`; chapter 3's `SessionStart` handoff seam. Chapter
4's worker reaching `memory_promote` is a line in that worker's allowlist and belongs to chapter 4's file,
not to this slice. That worker ships switched off by default (chapter 4's spec), so until the operator turns
it on in a repo, every proposal there comes from an agent or session calling `memory_promote`.

`memory-global-core.ts` is pure: `parseGlobalPage`, `globalSlug`, `checkGlobalPrivacy`, `stripStamps`,
`buildGlobalPage`, `buildGlobalHandoffBlock`. `memory-global-store.ts` is the shell: `globalRoot`,
`listGlobalPages`, propose, accept, reject, retire, list, read, and reading `git remote -v` and the denylist
for the privacy context. `hook-bridge.ts` is touched only to hand `buildGlobalHandoffBlock`'s text to chapter 3's
`SessionStart` handoff through the seam that chapter's S-3 exposes; if chapter 3's handoff lives elsewhere
when this slice starts, the executor records an Amendment naming the file before touching it. `design.md` §6
gains the "Global" tab (`hot · decisions · timeline · graph · global`): accepted pages with their origin
label, pending proposals with Accept and Reject, Retire on an accepted page. The privacy tests need
tracker-key-shaped samples, and `tests/no-client-identifiers.test.ts` greps tracked test files for that
shape: the samples are assembled at runtime (for example `'SHA' + '-' + '256'`, `'ACME' + '-' + '1234'`),
never written literally.

### S-5 · Benchmark A/B and card bookkeeping

- depends-on: S-2, S-4
- substrate: session
- files-may-touch: `docs/reports/2026-11-memory-u4-ab.md` (new), `docs/specs/2026-11-04-memory-u4-graph-global/spec.md`
- produces: —
- consumes: ranked-query, global-layer, existing:memory-bench
- gated-by: D-12
- acs: AC-39, AC-40, AC-41

Runs the benchmark with and without `--no-graph` on the same commit, corpus and question set, before and
after the chapter, commits the report under the A/B protocol of the benchmark spec, appends the disposition
of T192, T194, T101 and T264 to those cards (`update_card` `appendBody`) and moves T194 and T101 to `review`.
Its only spec edit is an Amendments row.

## Acceptance criteria

Fixture paths are under `tests/fixtures/memory-graph/` unless named. Metric names are the benchmark's
(T620, `docs/specs/2026-11-04-memory-benchmark/spec.md`, PRD §4): `recall_hit_at_5`,
`memory_read_default_bytes`, `boot_handoff_chars`, `capture_coverage`, `decision_yield`,
`hot_freshness_hours`, `index_bytes`, `orphan_loss`.

| id    | statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | proof                                                                                                                                                                                                          | refines/inherits | covers          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------- |
| AC-1  | This spec, with its header flipped to `status: approved` in a scratch copy, passes the spec gate on the working tree.                                                                                                                                                                                                                                                                                                                                                                              | script:sed 's/^status: draft/status: approved/' -i docs/specs/2026-11-04-memory-u4-graph-global/spec.md && node scripts/ci/spec-gate.mjs; git checkout -- docs/specs/2026-11-04-memory-u4-graph-global/spec.md | —                | R-1             |
| AC-2  | `critics.md` holds a blind builder-check of S-1 and S-4 whose residual guesses are each fixed in the spec, turned into a D-n, or a non-goal.                                                                                                                                                                                                                                                                                                                                                       | record:critics                                                                                                                                                                                                 | —                | R-1, R-10       |
| AC-3  | `parseLinks` returns the plain, alias and heading forms of a wiki-link (as "Link parsing" defines them) and links in YAML frontmatter with their line and section, and skips links inside fenced code and inline code.                                                                                                                                                                                                                                                                             | test:tests/memory-links-core.test.ts::parses wiki-links in body and frontmatter and skips code                                                                                                                 | —                | R-1, R-7        |
| AC-4  | Resolution follows exact id, then unique case-insensitive stem, then unique bare card id; more than one candidate is `ambiguous` with sorted candidates, none is `missing`; a self-link is dropped; a link to `index` or `where` is dropped and never reported.                                                                                                                                                                                                                                    | test:tests/memory-links-core.test.ts::resolves exact, stem and card-id targets and reports the rest                                                                                                            | —                | R-1, R-2, R-7   |
| AC-5  | `index` and `where` are never nodes: on a fixture whose `index.md` links every card, no card has `index` as a neighbour.                                                                                                                                                                                                                                                                                                                                                                           | test:tests/memory-links-core.test.ts::the derived catalog is never a node                                                                                                                                      | AC-4             | R-1             |
| AC-6  | `neighbours` returns the out-edges of the sections holding the given lines plus every back-edge, deduplicated and sorted, and never a two-hop page.                                                                                                                                                                                                                                                                                                                                                | test:tests/memory-links-core.test.ts::neighbours are section-local out-edges plus back-edges, one hop                                                                                                          | —                | R-3             |
| AC-7  | Two full builds over the same files give byte-identical `edges` and `unresolved` arrays.                                                                                                                                                                                                                                                                                                                                                                                                           | test:tests/memory-links-core.test.ts::the build is deterministic                                                                                                                                               | —                | R-2             |
| AC-8  | The index is written to `<memoryDir>/.index/links.json` and `<memoryDir>/.index/.gitignore` holds exactly `*`, in in-project and in central mode; after a build, `memory_read`'s page list and a `memory_query` for `schema` contain nothing under `.index`.                                                                                                                                                                                                                                       | test:tests/memory-links-store.test.ts::the index lives in a self-ignoring .index dir in both storage modes                                                                                                     | —                | R-1, R-7        |
| AC-9  | After a full build, a page edited by hand, a page added and a page deleted are all reflected by the next `refreshLinkIndex`, which returns `rebuilt: false` and `parsed: 2`; a corrupt file and a file with another `schema` each return `rebuilt: true`.                                                                                                                                                                                                                                          | test:tests/memory-links-store.test.ts::refresh picks up hand edits, new and deleted pages, and rebuilds a bad file                                                                                             | —                | R-2             |
| AC-10 | With `.index` made a regular file (so the directory cannot be created), `appendMemoryEntry` still returns `ok: true` and writes its page; across a full build, every page file keeps its bytes and only `.index/` changes.                                                                                                                                                                                                                                                                         | test:tests/memory-links-store.test.ts::the index never fails a memory write and never touches a page                                                                                                           | —                | R-2, R-7        |
| AC-11 | `buildLinkIndex` over the in-memory contents of a generated corpus of 2,100 pages carrying at least 1,100 links (a deterministic generator in the test, no committed bulk fixture) returns in under 500 ms on one thread; the S-5 report also gives the measured `rebuildLinkIndex` time on this repo, reads included.                                                                                                                                                                             | test:tests/memory-links-core.test.ts::building the index for 2,100 pages stays under 500 ms                                                                                                                    | —                | R-2             |
| AC-12 | The committed fixture `tests/fixtures/memory-graph/` holds at least one link resolved by each of rules 2, 3 and 4, one alias link, one heading link, one link inside frontmatter (an `evidence:` line on a page with frontmatter `kind: decision`) and one link inside a fence that must be skipped, and builds with zero unresolved links.                                                                                                                                                        | test:tests/memory-links-core.test.ts::the committed fixture exercises every rule and has zero unresolved links                                                                                                 | AC-4             | R-2             |
| AC-13 | On a fixture where a digest and a decision each hold the query once, the decision ranks above the digest and both are returned.                                                                                                                                                                                                                                                                                                                                                                    | test:tests/memory-rank-core.test.ts::maintained pages outrank episodic ones without hiding them                                                                                                                | —                | R-4             |
| AC-14 | A page with no lexical hit, linked from a hit's section, is in `pages` with `via: link` and its seeds in `from`, and in `matches` with its title line; with `graph: false` it is absent; a page two hops away is never present.                                                                                                                                                                                                                                                                    | test:tests/memory-rank-core.test.ts::expansion adds one-hop neighbours marked via link                                                                                                                         | AC-6             | R-3, R-5        |
| AC-15 | Ranking reads every lexical hit, not the first 50 in file order: a fixture whose best page is the last file read ranks it first.                                                                                                                                                                                                                                                                                                                                                                   | test:tests/memory-rank-core.test.ts::ranking is not biased by file order                                                                                                                                       | —                | R-4             |
| AC-16 | `pages` has at most `limit` rows (default 10); seeds are at most 10, neighbours at most 5 per seed and 20 in all; `matches` at most 50 with `truncated` set when lexical lines were dropped; a `limit` outside 1..20 is refused by the schema.                                                                                                                                                                                                                                                     | test:tests/memory-rank-core.test.ts::results are bounded                                                                                                                                                       | —                | R-3             |
| AC-17 | The same inputs give the same output, scores rounded to 4 decimals and ties broken by page id; `matches` in a superseded decision still carry `supersededBy`; the first five distinct pages of `matches` equal the first five of `pages`.                                                                                                                                                                                                                                                          | test:tests/memory-rank-core.test.ts::ranking is deterministic and keeps the old match fields                                                                                                                   | —                | R-4, R-16       |
| AC-18 | `npm run memory:bench -- --json --no-graph` calls `memory_query` with `graph: false` for every question, and without the flag with `graph` left at its default.                                                                                                                                                                                                                                                                                                                                    | test:tests/memory-bench-core.test.ts::no-graph passes graph false to memory_query                                                                                                                              | —                | R-16            |
| AC-19 | `docs/harnu-features.md` documents `graph`, `limit`, `pages`, `via` and the `graph` status values and its marker is above `v120`; `docs/user/agent-control.md` describes the new `memory_query` fields; both CI gates pass on the PR.                                                                                                                                                                                                                                                              | script:node scripts/ci/awareness-gate.mjs && node scripts/ci/user-docs-gate.mjs                                                                                                                                | —                | R-3, R-5        |
| AC-20 | `memory:graph` returns nodes of degree at least 1 plus `hot` and `decisions`, at most 300 by degree then id, with `truncated`, `totalNodes` and the unresolved count; `rebuild: true` forces a full rebuild.                                                                                                                                                                                                                                                                                       | test:tests/memory-links-store.test.ts::the graph read caps nodes and reports what it dropped                                                                                                                   | —                | R-6             |
| AC-21 | `buildMemoryGraphDocument` returns a document `validateCanvasDocument` accepts, with one box node per graph node, the tone of its kind, labels cut to 40 characters, and byte-identical output for the same input.                                                                                                                                                                                                                                                                                 | test:tests/memory-graph.test.ts::builds a valid deterministic canvas document with tones by kind                                                                                                               | —                | R-6             |
| AC-22 | The Memory pane has a fourth tab `graph` that renders the document through `createCanvasGraph` with `editable` false; dragging a node changes nothing.                                                                                                                                                                                                                                                                                                                                             | test:tests/memory-pane-graph.test.ts::the graph tab renders read-only                                                                                                                                          | —                | R-6             |
| AC-23 | Clicking a node opens that page's file in a Markdown pane (`addMarkdownHelper` with the absolute path under `memoryDir`), in in-project and in central mode.                                                                                                                                                                                                                                                                                                                                       | test:tests/memory-pane-graph.test.ts::clicking a node opens the page in the markdown pane                                                                                                                      | —                | R-6, R-7        |
| AC-24 | With no links the tab shows the empty note; with more than 300 qualifying pages it shows the truncated note with both counts; the reload button sends `rebuild: true`.                                                                                                                                                                                                                                                                                                                             | capture:memory-pane@graph-truncated                                                                                                                                                                            | AC-20            | R-6             |
| AC-25 | A theme switch recolours the open graph without a reload.                                                                                                                                                                                                                                                                                                                                                                                                                                          | test:tests/memory-pane-graph.test.ts::a theme switch recolours the graph                                                                                                                                       | —                | R-6             |
| AC-26 | `design.md` §6 Memory pane describes the graph tab before the code lands; every new key exists in `en.json` and `pt-BR.json`; `docs/user/project-memory.md` explains the tab.                                                                                                                                                                                                                                                                                                                      | script:node scripts/ci/i18n-parity.mjs && node scripts/ci/user-docs-gate.mjs                                                                                                                                   | —                | R-6             |
| AC-27 | The global root is `~/.harnu/global/` with `rules/`, `gotchas/`, `pending/`, `rejected/`, `retired/`; with a fake home that holds a home-folder `.harnu/memory/`, no folder's resolved memory dir equals the global root and the home folder's memory is untouched by every global operation.                                                                                                                                                                                                      | test:tests/memory-global-store.test.ts::the global root is its own root, apart from the home folder memory                                                                                                     | —                | R-10            |
| AC-28 | `memory_promote` on a repo page of kind `rule` or `gotcha` writes one `pending/<id>.md` holding the page's own title and body, never caller text; a page of any other kind is `PROMOTE_NOT_PROMOTABLE`; a second proposal with the same normalized title is `PROMOTE_DUPLICATE` naming the first; nothing is written to `rules/`, `gotchas/` or any repo memory dir.                                                                                                                               | test:tests/memory-global-store.test.ts::promote files a proposal and only a proposal                                                                                                                           | —                | R-8, R-10, R-15 |
| AC-29 | `checkGlobalPrivacy` refuses a sample of each kind in the table (`secret`, `absolute-path`, `tracker-key`, `card-id`, `workspace-dir`, `repo-path`, `remote-url`, `repo-link`, `denylist`, including a deny term taken from the checkout basename and one from a remote) with that kind in `kinds` and none of the matched text anywhere in the refusal; it passes a general rule that mentions `/usr/bin`, a UTF-8 encoding, a SHA digest and an ISO date; accept re-runs it on the pending file. | test:tests/memory-global-core.test.ts::the privacy check refuses every identifying kind and echoes none                                                                                                        | —                | R-14            |
| AC-30 | An accepted page's frontmatter has exactly the allowlisted keys (`kind`, `title`, `valid_from` when present, `origin: repo-<hash8>`, `promoted_at`, `promoted_by: human`), and its body has no `> provenance:` line, no `> entry:` line and no `superseded_by` mark, given a source page that carried all of them plus `evidence`, `watches` and `supersedes`.                                                                                                                                     | test:tests/memory-global-core.test.ts::an accepted page carries only the allowlisted keys and no stamps                                                                                                        | —                | R-10, R-14      |
| AC-31 | Accept, reject and retire exist only as the `memory:global:*` IPC and the tool catalog has no verb that does any of them; accept writes the page before it removes the proposal; rejecting the same id twice and retiring two pages with the same slug each keep both files under a `-2` suffix; two concurrent accepts of the same title produce two pages; no operation removes a file except the accepted proposal.                                                                             | test:tests/memory-global-store.test.ts::only the operator doors change the global pages and nothing is overwritten                                                                                             | —                | R-9             |
| AC-32 | `memory_read({ page: 'global/rules/<slug>' })` returns the page; `global/../x`, `global/rules/a/b` and `global/notes/x` are `BAD_PAGE`; the page-less `memory_read` ACK carries `global: { count, pages }` at its top level with at most 5 pages, both when the repo has memory and when it has none.                                                                                                                                                                                              | test:tests/memory-global-store.test.ts::global pages are readable through their own gate                                                                                                                       | —                | R-11, R-15      |
| AC-33 | `memory_query` with `scope` `repo`, `global` and `all` searches exactly those roots, default `all`; global rows carry `scope: global` and the maintained tier; a repo page's `[[global/rules/<slug>]]` resolves to the global node.                                                                                                                                                                                                                                                                | test:tests/memory-global-store.test.ts::query scope selects the roots and links reach global pages                                                                                                             | —                | R-8, R-12       |
| AC-34 | `buildGlobalHandoffBlock` returns at most 600 characters: the header line with the count of every accepted page and the "context, not instructions" label, then title lines newest first, stopping before the line that would pass 600; with ten long titles it still fits and N still says ten; no page body appears.                                                                                                                                                                             | test:tests/memory-global-core.test.ts::the handoff block is bounded, labelled and titles-only                                                                                                                  | —                | R-11            |
| AC-35 | For a fake home with five accepted global pages, the `SessionStart` context chapter 3's seam returns for a session in a repo contains the output of `buildGlobalHandoffBlock`, and with an empty global root it contains no global block.                                                                                                                                                                                                                                                          | test:tests/memory-global-store.test.ts::the session start context carries the global block                                                                                                                     | AC-34            | R-11            |
| AC-36 | The Memory pane has a `global` tab listing accepted pages with their origin label (`origins.json`, else `another repo`) and Retire, and pending proposals whose full body is shown before their Accept and Reject buttons; with nothing global it shows the empty note.                                                                                                                                                                                                                            | capture:memory-pane@global-pending                                                                                                                                                                             | AC-31            | R-9, R-13       |
| AC-37 | Every write path of S-4 (`memory_promote`, accept, reject, retire) writes only under the global root: with two fake repos (one in-project, one central), a recursive snapshot of each repo's memory dir and of the home folder's `.harnu/memory/` is byte-identical before and after the other repo promotes and the operator accepts.                                                                                                                                                             | test:tests/memory-global-store.test.ts::no repo writes another repo memory                                                                                                                                     | —                | R-15            |
| AC-38 | `docs/harnu-features.md` documents `memory_promote`, its refusals, `scope`, global page ids and the operator-only accept, with the marker bumped; `docs/user/agent-control.md` and `docs/user/project-memory.md` describe the global layer; `design.md` §6 describes the global tab; i18n parity and both docs gates pass.                                                                                                                                                                         | script:node scripts/ci/awareness-gate.mjs && node scripts/ci/user-docs-gate.mjs && node scripts/ci/i18n-parity.mjs                                                                                             | —                | R-10, R-13      |
| AC-39 | On the benchmark's frozen question set, `recall_hit_at_5` with expansion is at least 0.10 above the same run with `--no-graph`, and at least the pre-chapter baseline.                                                                                                                                                                                                                                                                                                                             | script:npm run memory:bench -- --json                                                                                                                                                                          | —                | R-3, R-16       |
| AC-40 | Against the pre-chapter run, no other benchmark metric is worse, except `memory_read_default_bytes` by at most 1,024 and `boot_handoff_chars` by at most 600 (the global block, measured with five accepted global pages against an empty global root); the report `docs/reports/2026-11-memory-u4-ab.md` holds every run, the commands, the commit sha, the corpus date and the measured `rebuildLinkIndex` time on this repo.                                                                    | record:report                                                                                                                                                                                                  | AC-39            | R-11, R-16      |
| AC-41 | T192, T194, T101 and T264 each carry the disposition stated in "Absorbed cards and prior design", appended to the card body; T194 and T101 are in `review`.                                                                                                                                                                                                                                                                                                                                        | record:board                                                                                                                                                                                                   | —                | R-4, R-6, R-8   |

## Open decisions

Resolve one at a time. A resolved row is also recorded as ONE line in project memory (`memory_append` to
`decisions`): `D-n · <question> · chosen: <option> · <date>`. An unanswered decision is never read as
declined. A slice that names an open D-n in `gated-by` is not dispatched until the operator answers that
row (answering "the default" counts); slices that name no open D-n go ahead. D-8 is answered by chapter 4's
spec being approved, not by the operator.

The operator accepted every default below on 2026-11-04; D-8 follows the approved chapter-4 spec.

| id   | question                                                                                    | options                                                                                                                                                                                                         | default                                                                                                                                                                                                      | status                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| D-1  | Cross-repo scope (PRD D-3)                                                                  | (a) promote only `rule` and `gotcha` pages; (b) a full shared graph across repos                                                                                                                                | (a), the PRD default                                                                                                                                                                                         | decided — chosen: (a) rule and gotcha only · 2026-11-04                                                 |
| D-2  | Where the link index lives and whether it is committed                                      | (a) `<memoryDir>/.index/links.json`, self-ignored by `.index/.gitignore`; (b) the same file committed, without `mtimeMs` and `builtAt` so it is deterministic; (c) memory only, rebuilt per process             | (a): nothing to merge-conflict, works in central mode, invisible to Obsidian (dot directory); the 126 ms cold build makes (c) viable as a fallback, not a default                                            | decided — chosen: (a) self-ignored .index/links.json · 2026-11-04                                       |
| D-3  | The promotion door                                                                          | (a) a chapter-4 worker proposal kind only; (b) an agent verb only; (c) one verb, `memory_promote`, that only files a proposal and that both the worker and agents call                                          | (c): one validated path for both writers; the worker's allowlist gains the verb (D-8)                                                                                                                        | decided — chosen: (c) one proposing verb, memory_promote · 2026-11-04                                   |
| D-4  | Does a promotion wait for the operator, or follow the PRD's D-2 auto-apply for repo memory? | (a) always the operator; (b) follow D-2                                                                                                                                                                         | (a): a global page reaches every repo's boot, so its blast radius is all repos                                                                                                                               | decided — chosen: (a) always the operator · 2026-11-04                                                  |
| D-5  | The global root                                                                             | (a) `~/.harnu/memory/` as the PRD and ADR wrote it, which on this machine is already the home folder's own memory; (b) `~/.harnu/global/`; (c) under Electron's `userData`                                      | (b): its own root, visible and Obsidian-openable, and no collision; see Deviation row 1                                                                                                                      | decided — chosen: (b) ~/.harnu/global/ · 2026-11-04                                                     |
| D-6  | What the boot handoff shows from the global layer                                           | (a) count and up to 5 titles, newest first; (b) count only; (c) full bodies under a budget                                                                                                                      | (a), at most 600 characters                                                                                                                                                                                  | decided — chosen: (a) count and titles, at most 600 characters · 2026-11-04                             |
| D-7  | The privacy check on a page that fails it                                                   | (a) refuse with the kinds and let the operator edit the source page; (b) rewrite (redact) and promote                                                                                                           | (a): a redacted lesson is often a wrong lesson, and a refusal keeps the operator in charge                                                                                                                   | decided — chosen: (a) refuse with the kinds · 2026-11-04                                                |
| D-8  | Chapter 4's page model                                                                      | (a) as the T623 card proposes: `pages/<kind>/<slug>.md`, frontmatter `kind`, `title`, `evidence`, `supersedes`, `watches`, `valid_from`, enumerated by the shared lister; (b) whatever chapter 4's spec settles | (a) until chapter 4's spec is approved; S-4 then follows it and records any difference as an Amendment                                                                                                       | decided — chosen: (b) the approved chapter-4 spec: pages/<kind>-<slug>.md (see Amendments) · 2026-11-04 |
| D-9  | Tier weights                                                                                | a table of weights per kind                                                                                                                                                                                     | `decisions` and chapter-4 kinds 1.0, global kinds 1.0, `hot` 0.9, `card` 0.8, `learning` 0.7, `session` 0.6, `archive` 0.5, any other 0.6                                                                    | decided — chosen: the default table · 2026-11-04                                                        |
| D-10 | `memory_query`'s `graph` default                                                            | (a) `true`; (b) `false` until the A/B shows a gain                                                                                                                                                              | (a): agents do not pass flags they are not told about; `false` remains the opt-out the A/B uses                                                                                                              | decided — chosen: (a) true · 2026-11-04                                                                 |
| D-11 | `memory_query`'s `scope` default                                                            | (a) `all`; (b) `repo`                                                                                                                                                                                           | (a): global pages are few and maintained, and a hit there is the point of promoting                                                                                                                          | decided — chosen: (a) all · 2026-11-04                                                                  |
| D-12 | When the recall target (AC-39) is graded                                                    | (a) at S-5, on this repo's corpus at that commit; (b) only after chapter 4's first backfill has written linked pages                                                                                            | (a), and the report also gives the number at S-2's merge; on today's corpus only 280 link occurrences exist outside `index.md`, so an unmet AC-39 before chapter 4 lands is reported as unmet, never relaxed | decided — chosen: (a) graded at S-5 · 2026-11-04                                                        |

## Amendments · Deviations

Append-only after approval. Never edit the sections above once the first card is dispatched; record the
change here and send the affected executor a delta.

| date       | kind      | what changed                                                                                                                                                                                                                                                                                                                                                                                                                                                              | by       |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 2026-11-04 | deviation | PRD §3.4 and ADR-0024 (d) name the global layer `~/.harnu/memory/`. That directory is already the home folder's folder-local memory (`resolveMemoryCheckout` on a non-git folder), so this spec defaults to `~/.harnu/global/` (D-5). The PRD and ADR are not edited here.                                                                                                                                                                                                | executor |
| 2026-11-04 | deviation | PRD §7 lists T264 as closed by chapters 3 and 5. Its item (3), promoting a lesson into `docs/lessons/`, is built by neither; this spec names it NG-6 and leaves it on the card.                                                                                                                                                                                                                                                                                           | executor |
| 2026-11-04 | decision  | All of D-1 to D-12 decided on their defaults by the operator; D-8 on the approved chapter-4 spec. Header flipped to `status: approved`.                                                                                                                                                                                                                                                                                                                                   | operator |
| 2026-11-04 | amendment | D-8: the approved chapter-4 spec stores typed pages at `pages/<kind>-<slug>.md` (page id `pages/<kind>-<slug>`, two segments, inside today's gate), not at `pages/<kind>/<slug>.md` as the T623 card proposed and D-8's option (a) assumed. "Pages and their kind" now derives `kind` from the file-name prefix, `memory_promote`'s example reads `pages/rule-<slug>`, and the S-1 fixture adds a `pages/` page once chapter 4's gate change is on `main`. No AC changed. | executor |
| 2026-11-04 | amendment | Chapter 4's consolidation worker ships switched off by default, so worker promotion proposals exist only in repos where the operator turned it on; agents and sessions reach the global layer through `memory_promote` regardless. Stated under S-4's preconditions. No AC changed.                                                                                                                                                                                       | executor |
| 2026-11-04 | decision  | Deviation row 1 resolved: the operator accepted `~/.harnu/global/` (D-5) and asked for PRD §3.4 and ADR-0024 (d) to be amended to match. As of `origin/main` f2133f3f, PR #190 has merged and both still read `~/.harnu/memory/`; the amendment has not landed yet.                                                                                                                                                                                                       | operator |
| 2026-11-04 | decision  | Deviation row 2 accepted: no chapter builds T264's item (3); the operator asked for PRD §7 to call T264 partly closed. As of `origin/main` f2133f3f that PRD wording has not changed yet.                                                                                                                                                                                                                                                                                 | operator |
