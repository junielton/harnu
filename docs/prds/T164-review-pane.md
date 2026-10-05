# Review pane — turning "the agent says it's done" into a decision the operator can defend

**Status:** PRD v1 (2026-08-25) · mockup `docs/specs/2026-08-25-t164-review-pane/spec.html` — **APPROVED 2026-08-25, frozen** · **Card:** `T164-review-pane-per-session-diff-review-surface-the-killer-gap` · **Deps:** T80 (board / `roadmap-core.ts`), T198 (`pr-stack-core.ts` — PR/CI evidence), T74 (`MarkdownRenderer` seam) · **Soft dep:** t125 (completion sensor — enriches, does NOT gate)
**Base:** `memories/research/2026-08-25-code-review-deep-research.md` §5 (delegation framework) + §7 (implications) · `memories/research/2026-08-25-capy-persona-deep-research.md` (8/8-persona gap) · design entry: `design.md` §6 "Review pane (takeover, T164)" — **to be written before implementation**

---

## 0. Premise — what this protects

Capy is an actuator with no verdict surface. It dispatches work into worktrees
ten times a day and then stops: the card lands in Review and the operator
alt-tabs to a terminal, a `git diff`, and GitHub to figure out whether anything
real happened. Every one of the eight buyer personas named this same hole, and
the market data says it is not a Capy quirk but the shape of the whole era —
agentic PRs wait 5.3x longer for a reviewer, median PR size grew 79% in a year,
AI co-authored code carries ~75% more logic defects, and 31% more PRs now merge
with no review at all.

The pane's job is therefore **not** to be a better diff viewer. It is to make
**Close a decision backed by evidence instead of a discovery** — to compress the
path from "an agent asserted done" to "I can defend closing this" without
letting any part of that judgment slide onto a machine.

This is also the one thing the incumbents structurally cannot build. CodeRabbit,
Greptile, Copilot review and Agent HQ all review _a PR_, _after push_, _in
someone else's cloud_. Capy uniquely holds the intent (the card), the dispatch
(the boot prompt), the worktree, the session and the evidence on one disk,
_before_ the PR exists.

---

## 1. Decisions this PRD settles

| #      | Decision                                                                                                                                                                                                                                                                                                          | Rationale                                                                                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **Placement: a 6th main-pane takeover.**                                                                                                                                                                                                                                                                          | `design.md` §6 documents a shared takeover contract — mutex in `stores/ui.ts`, shared dismissal rules ("a new takeover inherits them"). Reviewing is a job you _go somewhere_ to do, matching the five existing takeovers. The shell is free.                                                                                         |
| **D2** | **Anchor on the branch/worktree; the card is optional enrichment.**                                                                                                                                                                                                                                               | Half of Capy's fleet is sessions with no card, and the operator works in worktrees by hand. Card-anchored-only would make the pane dead weight for that half, and would exclude `internal`-substrate cards that have no branch at all. When a card IS bound, the intent panel lights up — that is the differentiator, not the anchor. |
| **D3** | **Decoupled from t125.** v1 ships without the completion sensor; the evidence header degrades to git-only.                                                                                                                                                                                                        | t125 itself calls git-only "a first-class mode, not an error". A diff + intent + evidence pane is useful the moment a card reaches Review manually. This takes the sensor off the critical path in both directions.                                                                                                                   |
| **D4** | **No agent-findings lane in v1.**                                                                                                                                                                                                                                                                                 | The #1 complaint against every incumbent reviewer is nit-noise. If the pane's first impression is a wall of low-value findings, the operator stops opening it and the whole surface dies. The mechanical layers must earn trust first. Deferred to v1.x (§8).                                                                         |
| **D5** | **Syntax highlighting SHIPS, driven by the ANSI palette.** Decided 2026-08-25 from the mockup; the no-highlight variant was rendered, compared and rejected. Every code colour must resolve to an existing `--term-ansi-*` token. The remaining ADR question is narrowed to the _mechanism_ that emits the spans. | Capy has **13** themes, and each already defines a full 16-colour ANSI palette for the terminal. Driving highlighting from those tokens covers all 13 with zero per-theme work and adds no new colour token — which removes the only strong argument against highlighting. §4.3 stays binding regardless.                             |

---

## 2. User stories

- As the operator, I want to see **what actually changed on a branch** without leaving Capy, so that closing a card is not an act of faith.
- As the operator, I want the **card's intent rendered beside the diff**, so that I can judge _"did it do what I asked, and only that?"_ — the one question no AI reviewer can answer for me.
- As the operator, I want the **receipts up front** (commits, gates, CI, session end state), so that a card with no commits on its branch is impossible to Close by accident.
- As the operator, I want **diffs touching sensitive paths to be visibly marked**, so that the UI itself enforces my never-delegate list.
- As the operator, I want to **review a branch that has no card**, so that the pane serves my hand-rolled worktree work too.
- As the operator, I want to **bounce work back** with a note in one gesture, so that "not good enough" is as cheap as Close.

---

## 3. Functional requirements

### 3.1 v1 scope (ranked — build in this order)

1. **Branch-vs-base diff.** Local `git diff <base>...<head>` in the worktree. Works with no remote, before any push. Base resolution: the worktree's fork point, falling back to the repo default branch.
2. **Evidence header.** Above the diff, the receipts:
   - commits on branch (`git rev-list --count <base>..<head>`)
   - dirty working tree count (`git status --porcelain`) — uncommitted work is evidence of _incompleteness_
   - session end state when a session is bound (done / killed / stand-down / hibernated)
   - PR + CI state **when a remote exists**, reusing `pr-stack-core.ts` (`PrLifecycle`, `CiState`, `worstCi`) and its gh cache
   - **discrepancies named in plain words** — "no commits on `feat/x`", "12 uncommitted files", "CI failing", "PR still draft"
3. **Intent panel.** The bound card's body rendered beside the diff via the `MarkdownRenderer` seam. Absent card → the panel collapses; it is never an empty box.
4. **"What changed" mechanical summary.** Files touched + adds/dels (`git diff --numstat`, parser already exists in `memory-digest.ts`), plus **contract flags** derived from the rules already encoded in `scripts/ci/*.mjs`: did the diff touch `CHANGELOG.md`, `docs/capy-features.md`, `docs/user/**`, `tool-catalog.ts`, i18n parity? Deterministic, never LLM.
5. **Blast-radius flags.** A per-repo list of sensitive path globs (same shape as the model routing table: operator-owned, agent-unreadable). Matching diffs render a visible marker and open expanded.
6. **Close / bounce.** Close calls the existing IPC (unchanged). Bounce appends a provenance-stamped note to the card and moves it back to `ready`.

### 3.2 The three hard rules (non-negotiable)

These are accountability guarantees, not preferences. Each maps to a documented failure mode.

- **R1 — Agents report, humans conclude.** No agent output is ever a verdict, a gate-keeper, or a Close-enabler. (Closed-loop critique: an AI reviewer sharing priors with the AI author validates _plausibility_, not _requirements compliance_.)
- **R2 — No green means safe.** No state in this pane may render as a completion-looking badge. "0 findings" means "the mechanical layer found nothing", which is a different sentence. (CMU rubber-stamping finding; agent PRs already merge faster with less discussion.)
- **R3 — Sensitive paths force the human read.** A blast-radius-flagged diff renders expanded, and no summarization may stand in for the diff itself.

### 3.3 Acceptance criteria

- [ ] **AC1** Given a worktree whose branch has commits ahead of base, When the operator opens the review takeover, Then the full branch-vs-base diff renders without any network call.
- [ ] **AC2** Given a branch with **zero** commits ahead of base, When the pane opens, Then the evidence header states the discrepancy in words ("no commits on `<branch>`") and the diff area shows an explicit empty state — never a blank pane.
- [ ] **AC3** Given a bound card, When the pane opens, Then the card body renders in the intent panel; Given no bound card, Then the intent panel is absent and every other feature still works.
- [ ] **AC4** Given a repo with no git remote (or `gh` absent/unauthenticated), When the pane opens, Then git-only evidence renders as a first-class state, and no error is surfaced for the missing PR data.
- [ ] **AC5** Given a diff touching a path on the repo's blast-radius list, When the pane opens, Then that file is flagged and rendered expanded.
- [ ] **AC6** Close from the pane writes `status: done` through the **existing** `roadmap-ipc.ts` handler; `grep -c` for writers of `status: done` in `src/main/` stays at exactly 1.
- [ ] **AC7** Bounce appends a provenance-stamped note to the card and returns it to `ready`; it never writes `done` and never silently discards the note.
- [ ] **AC8** Given a branch with uncommitted changes in the worktree, When the pane opens, Then the dirty-file count is surfaced as a distinct signal from the committed diff.
- [ ] **AC9** No surface in the pane renders an agent-produced claim in v1 (grep: no `/code-review`, no model call, in the v1 code path).
- [ ] **AC10** The takeover joins the `stores/ui.ts` mutex: opening it closes any other takeover, selecting a session dismisses it, and Esc closes it — verified against the shared rules in `design.md`.
- [ ] **AC11** A diff of ≥5,000 changed lines renders without freezing the renderer (§6).

---

## 4. User experience

### 4.1 Entry points

- **Primary:** a card in the board's Review column → "Review" action.
- **Secondary (D2):** the session row / folder context menu → "Review this branch", for branches with no card.
- Dismissal, mutex and `aria-pressed` toggle semantics are inherited from the shared takeover contract — nothing new is invented.

### 4.2 Layout (to be ratified by the mockup)

Three regions, and the mockup exists to prove they coexist without becoming three cramped columns:

1. **Evidence header** — full width, top. The novel component; no precedent in `design.md` §6.
2. **Intent panel** — the card, beside or above the diff, collapsible.
3. **Diff** — the dominant region.

### 4.3 Readability requirements (binding, engine-independent)

The pane must be pleasant to read by hand for twenty minutes. Most of that does
**not** come from the highlighter — it comes from these, which are required
regardless of what the ADR picks:

- **Low-saturation add/remove backgrounds**, not harsh red/green. The three Capy themes (Toffee / Ink / Dusk) each need their own values in `themes.css`; no raw colors in components.
- **Word-level intra-line highlighting** on modified lines — arguably a bigger comprehension win than syntax colors, and it is what makes a one-character change findable.
- **Sticky per-file headers** with the path and its ±counts while scrolling.
- **Collapsed unchanged context**, expandable in place.
- **Monospace with generous line-height** — a diff set at prose density is unreadable.
- **Red/green must never be the only channel** carrying add/remove (accessibility; `design.md` §2 semantic rules).

**Settled by the mockup (2026-08-25):** syntax highlighting ships, and every
code colour resolves to an existing `--term-ansi-*` token — the palette all 13
themes already define for the terminal. No new colour token, no per-theme
highlight work, and the diff is painted with the same palette as the terminal
the operator was just reading. The spec assumes a **class-based** highlighter
(~10 CSS rules mapping classes onto the ANSI vars); one emitting inline styles
would fight that. Still open for the ADR: which highlighter, and the language
coverage it must carry (TS, Vue SFC, JSON, Markdown, CSS, shell).

---

## 5. Technical approach

### 5.1 Shape

Follows the repo's established split — a pure, unit-tested core plus a thin IPC layer:

- `src/main/review-core.ts` — **pure parsers and evidence assembly.** New `parseUnifiedDiff` joins the existing family (`parseNumstat`, `parseGitLog`, `parsePrList`, `parseForEachRef`, `parseLsRemoteHeads`), all of which are pure string→struct functions with unit tests. Blast-radius glob matching lives here too.
- `src/main/review-ipc.ts` — git invocation + gh reuse, registered from `index.ts` via the `register*(getWindow)` convention.
- `src/renderer/src/components/ReviewPane.vue` + `review-format.ts` — the takeover, following the `PrStackCanvas.vue` / `pr-stack-format.ts` precedent.
- `src/renderer/src/stores/review.ts` — pane state.

### 5.2 What is already built (do not rewrite)

| Need                                          | Existing asset                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Run git safely, never throwing                | `runGit(cwd, args): Promise<string \| null>` — `memory-digest.ts:88`               |
| numstat → file stats                          | `parseNumstat` — `memory-digest.ts`                                                |
| commit list / churn / dirty count             | `parseGitLog`, `commitsAfter/Since`, `countPorcelain`                              |
| PR lifecycle + CI rollup + checks             | `pr-stack-core.ts` (`PrEntry`, `PrLifecycle`, `CiState`, `worstCi`, `parsePrList`) |
| PR review decision, merge state, gh cache TTL | `reaper/scan-core.ts` (`parseGhPrList`, `PrFacts`, `ghCacheFresh`)                 |
| Card body → safe HTML                         | `lib/markdown.ts` seam + `MarkdownRenderer.vue`                                    |
| Takeover shell, mutex, dismissal              | `stores/ui.ts` + `design.md` shared takeover rules                                 |
| Human Close                                   | `roadmap-ipc.ts:536` — **the single writer of `status: done`; untouched**          |

The genuinely new code is: the unified-diff parser, the diff renderer component, the evidence-header component, and the blast-radius config.

### 5.3 Repo contracts triggered

This change trips three CI gates; each is part of the definition of done:

- **CHANGELOG.md** — user-facing entry, mandatory.
- **`docs/user/`** — a new top-level component AND new top-level `src/main/` files fire the user-docs gate.
- **`design.md`** — a new §6 section "Review pane (takeover, T164)" must be written **before** implementation, including the new tokens for diff add/remove/word-level surfaces.
- **i18n** — every new key in **both** `en.json` and `pt-BR.json` in the same change, or `vue-tsc` breaks.
- **`docs/capy-features.md`** — **not** triggered in v1: no new MCP verb, no ACK shape change, nothing new for an agent to call. (If v1.x exposes review evidence to agents, that changes.)

---

## 6. Edge cases

| Scenario                                          | Expected behavior                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch has no commits ahead of base               | Named discrepancy + explicit empty state (AC2). Close is still possible — the operator may have decided the card needs nothing — but never by accident. |
| Branch identical to base / already merged         | "Nothing to review" state; if the PR is MERGED, say so from `pr-stack-core` facts.                                                                      |
| Very large diff (thousands of lines)              | Virtualized or progressively rendered; per-file collapse by default above a threshold. Never freeze the renderer (AC11).                                |
| Binary files                                      | Listed by path with a "binary" marker; no attempt to render.                                                                                            |
| No git remote / `gh` missing / unauthenticated    | Git-only evidence, first-class, no error toast (AC4).                                                                                                   |
| Worktree pruned or path gone                      | Clear "worktree no longer exists" state; offer to open the card, not the diff.                                                                          |
| Card substrate `internal` (no branch, no session) | Pane states that this card has no git-shaped evidence; intent panel + Close still work.                                                                 |
| Session hibernated or killed                      | Session end state renders as its own value; a killed session is neither "done" nor "evidence-missing-therefore-broken" (t125's third state).            |
| Branch behind base / conflicting                  | Surface it as a fact in the header; the pane never attempts a merge or rebase.                                                                          |
| Two sessions in the same worktree                 | Evidence is branch-derived, so it stays correct; the header names the bound session when there is exactly one.                                          |

---

## 7. Testing strategy

- **Unit** — `review-core.ts` parsers against fixture diffs: added/deleted/renamed files, binary, no-newline-at-EOF, empty diff, huge hunk, unicode paths. Blast-radius glob matching.
- **Component** — evidence header renders every discrepancy state; intent panel absent without a card; sensitive-path file renders expanded.
- **Integration** — real temp git repo: branch with commits, branch without, dirty tree, no remote.
- **Manual checklist** — open on a real Capy card in Review; verify against a terminal `git diff`; read a 1,000-line diff in each of the three themes; confirm Esc/session-select dismissal; confirm bounce lands the note on the card.

---

## 8. Out of scope (v1)

- Agent-assisted review findings (D4) — v1.x, as a collapsed, labeled "unverified" lane subordinate to the human diff.
- Fleet triage queue (ordering N cards in Review by risk) — the real differentiator, but it needs the basics first.
- Staleness nudge for cards sitting in Review — cheap and proven, but belongs with the notification centre.
- LLM intent-vs-diff summary ("the card asked A/B/C; the diff also touched D") — only after the mechanical layers earn trust.
- Provenance record on Close (folding the evidence snapshot into project memory).
- Inline comments / threads — there is one operator; there is no conversation.
- Any team, sharing, or export surface.
- Editing code from the pane.

---

## 9. Open questions

1. **The diff engine ADR** (D5) — _whether_ to highlight is decided (yes, ANSI-driven); _which highlighter_ is not. Next free number is **ADR-0011** (`docs/adr/` holds 0001–0010; note the repo already has two files numbered 0002).
2. **Word-level intra-line diff in v1 or v1.1?** It is the single biggest readability win after add/remove coloring, but it is also real work.
   2b. **Add/remove alpha asymmetry.** `--green-soft` is `.18` but `--red-soft` is `.10` — tuned for badges, where red is an alarm that should stay quiet. In a diff they are peers. Add a `--diff-del-line` at matching weight, or accept lighter removals?
   2c. **A session beside the review.** `App.vue` already lets a takeover share the row with the HelperStack (the T80 precedent); adding review to `showHelperStack` is one line. It is _pull_, not push, so D4's noise rationale does not exclude it. Requires the intent rail to collapse below ~1000px (measured: at 714px the diff truncates). Open: v1 or v1.1, and whether the default interlocutor is a fresh reader or the author session.
3. **Where the "review this branch" entry lives** for card-less branches — session row menu, folder menu, or both.
4. **Base resolution** — fork point vs repo default branch when a worktree was cut from a non-default base (stacked branches). `worktree-core.ts` may already answer this; confirm before implementing.
5. **Does Close from the pane need a confirm** when the header shows an unresolved discrepancy, or is showing the discrepancy enough? (Leaning: enough — R1 says the human concludes; a nag trains dismissal.)

---

## 10. References

- `docs/research/2026-08-25-code-review-in-the-agent-era.md` — §5 delegation framework (blast radius × verifiability), §6 unserved gaps, §7 implications and ranked v1 list. (Committed under `docs/` on purpose: `memories/` is gitignored and invisible to a fresh worktree.)
- `memories/research/2026-08-25-capy-persona-deep-research.md` — the 8/8-persona finding (operator-local; gitignored, not visible from a worktree).
- Card: `T164` on the Capy board (`.capy/` is gitignored — the board is not readable from a worktree; this PRD and the approved spec are the portable contract).
- Soft dep card: `.capy/memory/roadmap/t125-completion-sensor-capy-dispatches-work-but-never-observes-i.md` — "done is evidence, not assertion".
- `design.md` §6 shared takeover contract · §2 semantic color rules.
