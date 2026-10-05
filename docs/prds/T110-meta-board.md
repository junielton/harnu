# Meta-board — the operator's manager's desk across every open repo

**Status:** PRD v1 (2026-07-21) · **Card:** `T110-meta-board` · **Deps:** T80 (Roadmap board / `roadmap-core.ts`), T105 (schema v2), T107 (mockups, closed — direction locked)
**Base:** operator decision 2026-07-09 (`.capy/memory/decisions.md`) · exploration `T107-meta-board-mockups` (closed, evidence: mockups + explicit approval) · design entry: `design.md` §6 "Meta-board (takeover, T110)"

---

## 0. Premise — what this protects

The operator runs several repos in parallel, each with its own Roadmap board
(T80) answering "where is each piece of THIS repo's plan?" There is no single
place that answers "where is everything, across every project I'm running?" —
today that means opening N boards one at a time. The T107 exploration (3
live-verified HTML mockups over the real 57-card board + 2 fictional repos)
also surfaced a concrete pathology while doing this by hand: **28 of 57 real
cards were sitting in Review** — work waiting on the operator's own attention,
invisible unless someone counts. The meta-board is not a new mental model
(D2): it is the SAME 5-column board, aggregated, with a repo badge on every
card — plus a graft (D3) that makes the Review-hoarding pathology visible
instead of rendering it as one more flat list. **v1 is read-only** — this view
never mutates a card; acting on one still happens inside its own repo's board,
one click away.

## 1. Locked decisions

| #   | Decision                                                                                                                                                                                                                                                           | Status                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| D1  | **One unified 5-column board** aggregating every open repo's cards; each card wears a **repo badge**. The exact 5-column lifecycle of the per-repo Roadmap board (`Backlog·Ready·In Progress·Review·Done`), badged — not reinvented.                               | **Locked** (operator, 2026-07-09)           |
| D2  | **Review column subgrouped by evidence × no-evidence** — two fixed sub-lists, each with a count, plus an aggregate "N without evidence" badge on the column.                                                                                                       | **Locked** (operator, 2026-07-09)           |
| D3  | **Repo identity color = the existing terminal ANSI palette** (`--term-ansi-*`, §9). `--accent`/`--green`/`--warning`/`--red` stay semantically reserved — excluded from the repo-color rotation so a badge never doubles as a status signal.                       | **Locked** (operator, 2026-07-09)           |
| D4  | **Data source: a NEW purpose-built multi-root watcher** (`meta-roadmap-watcher.ts`), not an aggregation of N retargeted instances of the existing per-repo `roadmap-watcher.ts` (which is explicitly single-instance/retarget-only).                               | Recommended — pending operator confirmation |
| D5  | **Performance: v1 ships a capped/paginated per-column render** (the `InboxRail.vue` "Show all" precedent), not a new virtualization library — none exists anywhere in the renderer today.                                                                          | Recommended — pending operator confirmation |
| D6  | **Entry point: a global main-pane takeover**, 5th sibling of Roadmap/UsageDashboard/SystemMonitor/Cleanup, sharing their single-takeover mutex. Opened from a link in the **Footer fleet pill's popover** (mirrors `UsagePanel`'s existing "Open full dashboard"). | Recommended — pending operator confirmation |
| D7  | **`design.md` §6 entry mirrors the Usage Dashboard / Roadmap board skeleton** — zero new tokens (applied in this PR, see diff).                                                                                                                                    | Recommended — pending operator confirmation |
| D8  | **No age-based "stuck N days" sort** in the v1 Review sub-lists — no `reviewSince`/`updated`-at-review timestamp exists in the schema today (only `provenance.at`, which is creation time). Named as a v2 follow-up.                                               | Recommended — pending operator confirmation |

## 2. Slices — each an independent PR, in order

### S1 — Data engine: the multi-root watcher (no UI)

New `src/main/meta-roadmap-watcher.ts`: discovers every known/pinned repo that
has a `.capy/memory/roadmap/` directory (reusing the same folder source
`stores/sessions.ts` already assembles), opens one chokidar instance per repo,
and reuses `parseCard`/`scanRoadmapDir` from `roadmap-core.ts` unchanged — only
the fs/chokidar effect is new, the parse/column math stays shared and already
unit-tested. Each emitted card carries its source `repoKey` + a repo label. New
IPC channel set (`meta-roadmap:card:added|changed|removed`, mirroring the
per-repo watcher's shape) and a new `stores/meta-roadmap.ts` renderer store —
fully separate from `stores/roadmap.ts` so the per-repo board's single-instance
assumption is never touched.

**ACs:**

- The store seeds cards from every repo that has a roadmap dir on disk; a repo
  without one is silently skipped (not an error, not a toast).
- Editing a card's `.md` in any watched repo pushes a live update tagged with
  the correct `repoKey`, without requiring the per-repo board for that repo to
  be open.
- Closing/unpinning a repo folder mid-session stops its chokidar instance
  without affecting the others.
- A malformed card renders inert (same tolerance the per-repo watcher already
  has) — one bad file never drops its whole repo's feed.

### S2 — Meta-board takeover: unified read-only board

New `MetaBoard.vue`: the 5th main-pane takeover (`ui.metaBoardOpen`, same
shape/rules as `usageDashboardOpen`/`systemMonitorOpen`/`cleanupOpen` —
global, outside the four-floating-surface mutex, mutually exclusive with the
other takeovers), entry point added to the Footer fleet pill's popover
(alongside "Open full dashboard"), i18n keys in both `en.json`/`pt-BR.json`.
Renders the same compact card component the per-repo board already uses —
read-only here (no drag handle, no dispatch button, no context menu, no `+ New
card`) — plus a **repo badge**: a small pill/dot using a deterministic hash of
`repoKey` into a non-semantic slot of `--term-ansi-*` (blue/magenta/cyan/
bright-* family only — red/green/yellow excluded per D3). Clicking a card
opens that repo's own Roadmap board (`ui.openRoadmap(folderPath)`) and closes
the meta-board. Each column caps its rendered list (`InboxRail.vue`'s "Show
all" pattern, D5) rather than reaching for a virtualization library.

**ACs:**

- With 2+ repos contributing cards, every column shows the union; each card's
  repo badge is visually distinguishable and stable across reloads
  (deterministic, not random-per-mount).
- No control anywhere on this view can write a card's `status`/`evidence`/
  `session` — verified structurally (no dispatch/drag code path exists here at
  all, not merely hidden by CSS).
- Clicking a card opens its own repo's board and closes the meta-board.
- Opening the meta-board force-closes any other open takeover; opening another
  takeover closes the meta-board (existing mutex, extended to a 5th member).

### S3 — Review evidence × no-evidence subgrouping (the D3 graft)

The differentiating value prop, kept as its own slice/AC pass rather than
folded silently into S2's generic column render. `MetaBoard.vue`'s Review
column only: renders two fixed, labeled sub-lists — **"No evidence"** (top,
`bg-red-soft`/`text-warning`, the same tokens `RoadmapBoard.vue`'s
close-without-evidence warning already uses) and **"Has evidence"** (below) —
keyed on `card.evidence.length === 0` (no schema change). The column header
gets an aggregate **"{n} without evidence"** badge, summed across every repo.

**ACs:**

- The Review column shows both sub-lists with their own counts; a repo
  contributing zero Review cards contributes nothing to either sub-list (no
  empty-repo noise).
- The column header's aggregate count equals the sum of "No evidence" cards
  across every repo.
- Cards within each sub-list sort by the existing `compareCards` (priority,
  then id) — no timestamp-based sort is attempted or promised in v1.

## 3. Engine inventory

**Exists (wire-up only):** `roadmap-core.ts` (`parseCard`/`scanRoadmapDir`/
`compareCards`/column derivation — entirely reusable, already unit-tested) ·
the compact card visual `RoadmapBoard.vue` already renders (reuse, don't
duplicate) · the takeover shell shape shared by `UsageDashboard.vue`/
`SystemMonitor.vue`/`CleanupView.vue` (40px header, close `X`, single-takeover
mutex in `stores/ui.ts`) · `InboxRail.vue`'s "Show all" cap pattern ·
`--term-ansi-*` tokens (§9, already themed per light/dark) · `ui.openRoadmap
(folderPath)`, the existing click-through opener (already used by
`FolderMenu.vue` and the session context menu, T149).

**Missing (built by slice):** the multi-root watcher + its IPC channel set +
`stores/meta-roadmap.ts` (S1) · `MetaBoard.vue` + entry point + 5th mutex
member + the repo-color hash helper (S2) · the Review evidence × no-evidence
render + aggregate badge (S3).

## 4. Open questions (this PRD)

The D4–D8 rows in §1 are recommendations, not decisions — they resolve the
same way any standard-tier card's parked assumptions do: via the card's Open
Questions block/interview convention, or an explicit operator note on this
card, before the S1 slice is dispatched.

- **OQ1 (entry-point affordance):** Footer pill popover link (D6,
  recommended — mirrors existing precedent exactly) vs. a dedicated Topbar
  icon. Needs an operator pick before S2.
- **OQ2 (repo label):** show the folder's basename on the badge, or something
  more disambiguating? Recommend starting with the basename (simplest, matches
  how the per-repo board already labels itself); revisit if two open repos
  ever share a name in practice.
- **OQ3 (cap size):** a fixed per-column/per-sub-list cap (e.g. a
  `TOP_RANK_CAP`-style constant, matching `UsageDashboard.vue`'s existing
  pattern) vs. one that scales with viewport height. Recommend fixed for v1
  simplicity.
- **OQ4 (missing mockups):** this card's `assets:` frontmatter points to
  `.capy/memory/mockups/T107/d2-unified-columns.html` and
  `d3-attention-first.html` — **neither file exists on disk** (confirmed via
  exhaustive `find` + `git log --all`). Only the decision-log prose survives
  (`.capy/memory/decisions.md`, 2026-07-09 entry, quoted in §1 above). This PRD
  proceeds on that prose, which this research found specific enough to spec
  S1–S3 above. Regenerating the mockups before implementation is optional, not
  required — but would de-risk the exact card-badge/subgroup visual details
  before a full slice of code is written.

## 5. Out of scope

Any dispatch/drag/write affordance on the meta-board (v1 is strictly
read-only) · cross-repo card proposals (Q29 — a card proposed into another
repo showing up here is a related but separate follow-up) · age-based "stuck N
days" Review sorting (D8 — no `reviewSince` timestamp in the schema; named v2
follow-up) · a real virtualization library (v1 uses the cap/pagination
precedent; only revisit if measured jank at real scale demands it) ·
`Group-by` (epic/kind) inside the meta-board's columns (the per-repo board's
control is not carried over in v1) · any new theme token (design entry
confirms zero new tokens, D7).
