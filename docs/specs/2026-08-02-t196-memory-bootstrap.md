# T196 — Bootstrap project memory on folder adoption (implementation spec)

**Date:** 2026-08-02
**Card:** `T196-bootstrap-project-memory-on-folder-adoption-seed-hot-decisions`
**Status:** design draft — not implemented
**Prior art:** [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) — `ai-memory bootstrap`, "git-log and docs seed for existing projects"

## Problem

Memory starts empty in every repo except this one. Adopt a folder and `.capy/memory/`
holds a scaffold — `hot.md` renders its own placeholder (`extractHotPreview` returns
the `_(memory just created…)_` line, honestly, by design) — until enough sessions
have run to accumulate digests. So the capability that most distinguishes Capy is
invisible during the exact window a new user decides whether it is worth keeping.

Capy's own memory looks impressive because it has been dogfooded for months. Nobody
else gets that.

Meanwhile the repo already contains a large amount of recoverable context: git
history, ADRs, a CHANGELOG, a README, sometimes a TODO list. ai-memory's `bootstrap`
takes exactly this position — the repo's history _is_ the first memory.

## Trigger

Two entry points, one code path:

1. **On adoption** — `adopt_folder` / the sidebar's add-folder flow, when the
   resolved memory location has no memory yet.
2. **On demand** — an action in the Memory pane, and an explicit re-run for a folder
   whose memory is already seeded (idempotent: re-running replaces the
   bootstrap-authored pages, never human- or session-authored ones).

**Offer, never silently write.** Bootstrapping writes into a repo the operator just
connected; doing it unannounced is exactly the "Capy touched my repo" failure. The
offer is a single confirm showing what will be written and where.

## What gets seeded

### `hot.md`

Deterministic, no LLM required. Sourced from `git-probe.ts` / the same git plumbing
`memory-digest.ts` already uses:

```markdown
**Now:** _(bootstrapped from repo history — no session context yet)_

**Last (<date of HEAD>):** <N> commits on `<branch>` — latest `<sha>` <subject>

**Next:** _(unset — the first session will fill this in)_

> provenance: author=bootstrap · at=<now> · branch=<branch>
```

The honesty matters: it must not invent a "Now" or a "Next". An empty-but-labeled
field is better than a fabricated one, and it tells the first session exactly what
its job is.

### `decisions.md`

Candidate entries mined from files that already exist, in priority order:

1. `docs/adr/**` — each ADR yields one entry: title, date, status, one-line decision,
   link to the file. This is the highest-signal source and the only one that is
   _actually_ a decision record.
2. `CHANGELOG.md` — the most recent N dated groups, as "what shipped when".
3. `README.md` — the stack/architecture paragraph, if identifiable.

Every seeded entry is stamped `author=bootstrap` in its provenance, which
(a) makes it visually distinct from a decision a human or session recorded, and
(b) lets [[T194]]'s tiering rank it below authored decisions.

**Never fabricate rationale.** If the source does not say _why_, the entry does not
claim a why. A seeded decision that invents a reason is worse than an empty memory —
it becomes false ground truth for every session that reads it, which is the precise
failure mode the whole memory design guards against.

### Roadmap cards (optional, off by default)

If the repo has an obvious `TODO.md` / task list, offer to create backlog cards from
it. Off by default and separately confirmed: the board is dispatch substrate, and
auto-populating it with 40 half-parsed lines is worse than an empty board.

Cards go through `createCard` (`roadmap-core.ts` / the board verbs), never a
hand-written file — the no-hand-writing contract applies to bootstrap code exactly as
it applies to an agent.

## Boundary (ADR-0001)

| Concern                                          | Where                            | Purity              |
| ------------------------------------------------ | -------------------------------- | ------------------- |
| ADR/CHANGELOG/README parsing → candidate entries | new `memory-bootstrap-core.ts`   | pure, unit-tested   |
| `hot.md` rendering from a git summary struct     | same                             | pure                |
| Which pages already exist / what to skip         | same (takes an inventory struct) | pure                |
| git probing, file reads, writes                  | `memory-bootstrap.ts` shell      | env-bound, e2e-only |

Writes go through the **existing serialized memory writer**
(`appendMemoryEntry` / the `hot` replace path in `memory-store.ts`) so provenance
stamping, the secret lint, and multi-writer safety come for free. Bootstrap gets no
private write path.

## LLM

Optional, additive. With a model configured, the seeded `decisions.md` entries get a
one-line summary and the README paragraph gets condensed. Without one, everything
above still works — parsing headings and git log is deterministic. Zero-LLM mode is
not a degraded mode here, it is the baseline.

## Test plan

- **Unit:** ADR frontmatter parsing (including this repo's two `0002-*` files — a
  duplicate number must not break the mine); CHANGELOG date-group extraction;
  `hot.md` rendering for a repo with 1 commit, with 10k commits, and with a detached
  HEAD; skip-logic when a page already exists.
- **e2e:** adopt a fixture repo with ADRs + CHANGELOG ⇒ seeded memory; re-run
  bootstrap ⇒ no duplicates and no overwrite of a session-authored page; adopt a repo
  with no git ⇒ graceful degradation (folder-local memory, no git section, no crash).
- **Contract:** every seeded page carries `author=bootstrap` provenance (assert).

## Out of scope

Summarizing the codebase; indexing (that is T192); importing issues from GitHub;
seeding memory for a repo Capy has not adopted.
