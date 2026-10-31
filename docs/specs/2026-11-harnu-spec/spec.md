---
status: approved
tier: complex
prd: docs/prds/T601-harnu-spec.md
---

# `harnu:spec` — triage, spec authoring and spec check

_Written with the wave-A template (`docs/specs/TEMPLATE.md`) and linted by the wave-A gate
(`scripts/ci/spec-gate.mjs`): the skill's first consumer is its own spec. Evidence and the
binding decisions it rests on: `docs/specs/2026-11-harnu-spec/exploration.md` (§1 leaks, §3 critics,
§4.0 reframe, §4 Wave B, §6 decisions). Product requirements: `docs/prds/T601-harnu-spec.md`.
Critic pass on this spec: `docs/specs/2026-11-harnu-spec/critics.md`. The operator approves by
merging the PR that lands this file; until then `approved` is the proposal._

## Problem

Campaign wave 1 showed where the delivery flow leaks, and every leak below is a retyping or a
missing handoff between the idea and the verified PR:

- The card's AC ids drifted from the spec's (leak 1), and the spec contradicted itself (a ledger
  event listed in §3.2 but built two chapters later in §7) with nothing to catch it before
  verification (leak 2).
- The files a slice may touch were invented by the orchestrator (leak 4); rescoping happened silently (leak 11).
- Nobody records who approved the spec (leak 10), and nothing happens to a spec after merge (leak 9).
- Above all, how much of the funnel an entry deserves is today the operator's intuition, per
  session. Half the entries (a one-line bug, a PR comment, a red CI, a question) must never see
  a spec; if the convention makes them heavier it dies in a week.

Wave A (T600, T603) shipped the template, the gate and the verbatim-ids rule in Phase 2. Wave B
is the skill that makes the whole funnel a habit: triage first, the spec only for the tiers that
need it, the mission born the moment work leaves Small, and two checks the gate cannot make.

The request, atomized (one atom per sentence the requester said, from the T601 objective and the
decisions of exploration §4 Wave B and §6):

- R-1 Add a bundled skill `harnu:spec` with two verbs: `/harnu:spec <entry>` and `/harnu:spec check [--cards]`.
- R-2 Its first move is triage: it names the entry door and picks the tier.
- R-3 For Small work it stops at "card ACs, no spec"; a one-line bug, a PR comment, a red CI or a question never gets a spec, and a question that grows into an architectural decision leaves chat for an ADR, not a spec.
- R-4 It is called at every entry, so its name and trigger text must say that most calls end Small, and the shortcuts stay ceremony-free.
- R-5 For Medium and up it writes `docs/specs/YYYY-MM-DD-<slug>/spec.md` in the wave-A template, from a brainstorm, a scope-task report or a PRD.
- R-6 It looks facts up (`memory_query`, lessons, code) and asks decisions one at a time.
- R-7 It atomizes the objective into request atoms R-n.
- R-8 It runs one blind builder-check; Complex adds two lens critics in parallel.
- R-9 It creates the mission at triage, the moment work leaves Small, with a `human` step "Approve spec" and the spec, PRD and ADR as scope.
- R-10 It hands the file over with `open_file` and asks the one approval question; the approval is the operator's, recorded by the header flip and the operator's own mark on the mission step.
- R-11 With the operator absent it leaves an operator-owned blocker (so Harnu chimes and re-nudges) and stops; an unanswered decision stays `open` (never "declined") and blocks only the slices it gates.
- R-12 A spec is frozen at first dispatch; later changes are append-only Amendments that reach executors as deltas.
- R-13 `/harnu:spec check` runs the spec gate.
- R-14 `check` also runs the capability-order check: a slice must not precede the slice that produces a capability it consumes.
- R-15 `check` also runs the request-atom coverage check: every R-n lands on an AC, a non-goal or a D-n.
- R-16 `check --cards` lints card-versus-spec drift (AC hash divergence) and never grades; the verifier keeps grading the card.
- R-17 Dispatch stays in `orchestrate-delivery`; its Phase 2 derives the marked block (ACs, scope, links) at dispatch time and leaves the envelope to the orchestrator.
- R-18 Derive is idempotent: the slice-to-card map is kept in the spec; a re-run updates backlog cards in place, never touches an in-progress card, never duplicates.
- R-19 Open D-n rows become decision nodes on the mission, locking only the slices they gate.
- R-20 The skill is registered: bundled catalog (Settings → Skills), a `docs/harnu-features.md` paragraph with a marker bump, a `docs/user/` page, a CHANGELOG entry.
- R-21 The skill is the first consumer of its own rules: its spec is written with the wave-A template and passes the gate before any skill text is written.
- R-22 The campaign spec's skills contract (its §6) is amended, not duplicated.
- R-23 The four-verb design is dropped: no `derive` or `close` verb; status is derived, deviations are written by the verifier; wave A is not rebuilt here.
- R-24 Wave C stays out: the approval door in the UI, proof-file hashing and red-first receipts, the mutation round, the Steward fold, the Steward watching specs.
- R-25 A Complex spec carries a PRD, an ADR when it records an architectural decision, and a mockup when it has UI, all at tracked repo paths.

### The funnel this skill implements

Triage names the door the operator came in by, takes its first step, and only the Medium-and-up
tiers produce a spec. The skill's text carries this table verbatim.

| You arrive with           | First step                                       | Becomes                                |
| ------------------------- | ------------------------------------------------ | -------------------------------------- |
| A vague idea              | `brainstorming` (one question per turn)          | objective + request atoms R-n          |
| A task / ticket           | `scope-task` (ACs one by one, what exists, gaps) | report on the card                     |
| A bug                     | `systematic-debugging` until root cause          | `bug` card with the repro as an AC     |
| A question                | answer in chat; `memory_query` and lessons first | nothing, or one decisions line         |
| A PR comment / red CI     | `address-review` / `debug-gh-action`             | commit on the existing branch; no spec |
| A design / mockup         | `create-mockup` or `implement-design`            | screens approved one by one            |
| A recurring pain          | `learn-from-review` or a card                    | a lesson, or a `chore` card            |
| "Where did we leave off?" | `harnu:status` / `resume-task`                   | a read of the mission, nothing written |

Tier follows the card's `complexity` and the smallest tier that fits (the gate refuses a section
outside the tier):

| Tier    | Card complexity                           | The artifact                                     | Mission        |
| ------- | ----------------------------------------- | ------------------------------------------------ | -------------- |
| Small   | trivial, simple                           | the card's own ACs; no spec                      | none           |
| Medium  | standard                                  | spec: Problem, Slices, Acceptance criteria       | born at triage |
| Large   | standard, with D-n or non-goals to record | adds Goals and Open decisions                    | born at triage |
| Complex | complex                                   | adds the `prd`, `adr` and `mockup` header fields | born at triage |

A Small entry creates no spec, no mission, no sub-agent, no lint and calls no tool. Everything
below applies only to whoever chose a tier above Small.

### Conventions this spec adds on top of the template

Each is additive: the gate accepts them, and decision D-1 decides whether `TEMPLATE.md` adopts them.

- A slice may carry `gated-by: D-n, …` (the open decisions that lock it). It is how an open D-n
  becomes a decision node that blocks only its slices.
- Non-goals are bullets that start `NG-n` and cite the atoms they cover, e.g. `- NG-2 … (R-24)`.
- A `consumes:` token with no producer in the spec is written `existing:<name>` (a capability that
  already exists in the repo or in another spec); any other token must be produced by a slice.
- The slice-to-card map is kept as rows of the Amendments table with kind `card` and the text
  `S-n → <card slug>` (ASCII `->` is accepted); the last row per slice wins. The card also carries
  the line `spec-slice: S-n`. When the two disagree the card wins: the board is live, the spec row is a record.

### Formats the slices build to

These formats are the contract between slices; a slice does not invent them.

**Where the scripts live.** Every script of this feature is vendored inside the skill directory,
`resources/skills/skills/spec/scripts/`, beside `SKILL.md`, so the staging copies it into any session that has the skill and `check` works in any repo (D-8).
They are dependency-free ES modules that use only Node built-ins. A session finds them under the skill's base directory, which it
is told when the skill loads; `orchestrate-delivery` finds the planner as the sibling `../spec/scripts/` of its own base directory. The
gate's rules move there as `spec-gate-core.mjs`; `scripts/ci/spec-gate-core.mjs` becomes a one-line re-export of it, so CI and the
skill run one implementation and cannot drift.

**The parser** (`resources/skills/skills/spec/scripts/spec-check-core.mjs`, S-1) exports `parseSpec(content)` and `acHash(statement, proof)`.
`parseSpec` returns `{ header, atoms[], nonGoals[], slices[], acs[], decisions[], cards[] }`:

- `atoms`: `{ id, line }` from the `- R-n …` bullets of the Problem section;
- `nonGoals`: `{ id, line, cites[] }` from `- NG-n …` bullets of the Goals section, `cites` the R-n tokens in the bullet;
- `slices`: `{ id, line, dependsOn[], substrate, files[], produces[], consumes[], gatedBy[], acs[] }` from `### S-n · title` headings and their `- key: value` bullets (`—` is empty, lists are comma-separated, `files` are the backticked globs);
- `acs`: `{ id, line, statement, proof, refines, covers[] }` from the Acceptance criteria table, `—` is empty;
- `decisions`: `{ id, line, status, question }` from the Open decisions table;
- `cards`: `{ slice, card, line }` from Amendments rows of kind `card`, last row per slice kept.

**The CLI** is `node <skill directory>/scripts/spec-check.mjs <spec-path> [--cards [--cards-dir <dir>]]`. The path is required; the
skill resolves it (the spec attached to the mission scope, else the one spec directory changed on the branch, else it asks).
Findings go to stdout as `path:line [rule] message`, all findings are collected (the gate does not short-circuit the two
checks), exit 0 clean, 1 on any finding, 2 on a usage error or an unreadable file. Rule ids: the gate's own ids unchanged,
then `missing-producer`, `producer-not-before`, `no-atoms`, `uncovered-atom`, and with `--cards` `hash-diverged`,
`unknown-ac`, `missing-ac`. A capability finding sits on the consumer's `consumes:` line and names the producer slice
(or none); an atom finding sits on the atom's bullet. "Precede" is the transitive `depends-on` closure; a slice that
consumes only what it produces itself fails `producer-not-before`. Tokens match exactly, case-sensitive. Cards are read from
`--cards-dir`, default `.harnu/memory/roadmap` of the repo's main checkout (resolved with
`git rev-parse --path-format=absolute --git-common-dir`).

**The AC hash** is the Wave A definition in `orchestrate-delivery` Phase 2, not a new one: `#` plus the first four hex
characters of the sha256 of `<statement> | <proof>` (a space, a vertical bar, a space) with every run of whitespace collapsed
after the join, backticks kept (`printf '%s' "$text" | sha256sum | cut -c1-4`). Golden vector: the statement
`The example behaves as described in R-1.` with the proof `test:tests/example.test.ts::behaves` hashes to `8abc`.

**The card block.** A card body carries one block per slice, between `<!-- spec:begin S-n -->` and `<!-- spec:end S-n -->`
(each pair exactly once; an unbalanced or repeated pair is a refusal), holding: one line per AC,
`- [ ] AC-3 #a1b2 — <statement> — proof: <proof>`; the line `scope: <files-may-touch, comma-separated>`; and the line
`links: spec <path>[, prd <path>][, adr <path>]`. Outside the markers sit the line `spec-slice: S-n` and the orchestrator's
envelope (return address, exit sequence, method, honest exit clause), which derive never touches.

**The AC line grammar.** One line, fields separated by a space, an em dash and a space:
`- [ ] <id> #<hash> — <statement> — proof: <proof>`. `<id>` is the spec's AC id verbatim, `<hash>` the four hex characters of
`acHash`, `<statement>` and `<proof>` the table cells verbatim (markdown backticks kept; the table forbids a vertical bar in
either, so no escaping exists). A reader splits at the first `—` after the hash and at the last `— proof:`, so a
statement may itself contain an em dash. A ticked box (`[x]`) is preserved by an update: derive rewrites the id, hash,
statement and proof, never the box.

**The new card's title** is `<S-n> · <slice title>`, the slice heading with its `S-n · ` prefix kept, e.g.
`S-1 · Spec check: gate, capability order and atom coverage`. The plan carries it as `title`; the slug is left to `create_card`, and derive never
computes one.

**The derive planner** (`resources/skills/skills/spec/scripts/spec-derive.mjs`, S-6) is `node <skill directory>/scripts/spec-derive.mjs <spec-path> --board <file>`.
`<file>` is JSON, `[{ slug, status, title, body }]`, which the orchestrator writes from `list`-style board reads. It prints
`{ create: [{ slice, title, block }], update: [{ slug, slice, block }], skip: [{ slug?, slice, reason }], refuse: [{ slice, reason }] }`
to stdout, writes nothing, and exits 1 if `refuse` is not empty, else 0. Every slice gets a card (a slice gated by an
open D-n gets one that stays in the backlog; the decision node holds its dispatch). A card is matched to a slice by its
`spec-slice` marker, else by an Amendments `card` row. Statuses `backlog` and `ready` are updatable; every other status
is `skip` with the status as the reason; a marked card whose slice no longer exists is `skip` with reason `orphan`.
Overlap is prefix containment of the backticked globs (`**` is a subtree); two slices overlap only when neither is in
the other's `depends-on` closure. A refusal is one entry per slice (overlap names the other slice in the reason) and
blocks only that slice's create or update.

## Goals

- G-1 In any session, one command at any entry tells the operator which door and which tier the work is, in one message; Small ends right there with no artifact.
- G-2 A Medium-and-up spec is written in the template's shape, passes the gate on its first run, and shows the operator, before they approve, that every sentence they said landed somewhere.
- G-3 From the moment work leaves Small it has a heartbeat: a mission with an "Approve spec" step, and an operator-owned blocker when nobody is there to answer.
- G-4 A spec that contradicts itself is caught before dispatch (capability order, atom coverage) and a card that drifts from its spec is caught after (`--cards`).
- G-5 Dispatch derives the cards from the spec instead of retyping them, and a second dispatch pass changes nothing it should not.

**Non-goals:**

- NG-1 No `derive` verb and no `close` verb of the skill. Derive is a planner script that `orchestrate-delivery` Phase 2 calls; there is no stored `shipped` status, the spec's state derives from PR and mission state, and deviations are written by the verifier. (R-23)
- NG-2 Nothing from Wave C: no approval door in the UI, no proof-file hashing or red-first receipts, no mutation round, no fold of shipped specs into the current-state docs, no Steward duty over specs. (R-24)
- NG-3 `check --cards` lints and never grades; the verifier keeps grading the card, and no new reader of the spec's AC table is added to it. (R-16)
- NG-4 Wave A is not rebuilt: the template, the gate, the verbatim-ids rule and the Deviations rows already exist and are only extended where a slice names them (S-1 moves the gate's core module into the skill directory and leaves a re-export, D-8). (R-23)
- NG-5 A Small entry gets no spec file, no mission, no sub-agent, no lint run and no tool call. (R-3, R-4)
- NG-6 The skill does not dispatch, create cards, merge or tick anything; it ends at the approved spec and says what comes next. (R-17)

**Anti-goals:**

- A skill that makes a one-line fix or a PR comment heavier than it is today; the operator would stop calling it.
- A second source of truth: cards, the mission and the spec each own one thing, and the skill never copies a fact into a place that will rot.
- The skill deciding a product question the operator did not answer, or reading silence as consent.

## Slices

Nine slices, one PR each. S-0 is this PR (Commit 0). S-1 → S-2 → S-3 → S-4 → S-5 and S-2 → S-6 are
stacked; S-6 shares no file with S-3 to S-5 and can run beside them; S-7 joins both lines; S-8 closes.

### S-0 · Land the spec bundle (Commit 0)

- depends-on: —
- substrate: worktree
- files-may-touch: `docs/specs/2026-11-harnu-spec/spec.md`, `docs/specs/2026-11-harnu-spec/exploration.md`, `docs/specs/2026-11-harnu-spec/critics.md`, `docs/prds/T601-harnu-spec.md`, `docs/specs/2026-10-30-campaign/spec.md`
- produces: spec-bundle
- consumes: existing:spec-template, existing:spec-gate
- acs: AC-1, AC-2, AC-3

### S-1 · Spec check: gate, capability order and atom coverage

- depends-on: S-0
- substrate: worktree
- files-may-touch: `resources/skills/skills/spec/scripts/spec-check-core.mjs`, `resources/skills/skills/spec/scripts/spec-check.mjs`, `resources/skills/skills/spec/scripts/spec-gate-core.mjs`, `scripts/ci/spec-gate-core.mjs`, `tests/spec-check.test.ts`, `tests/fixtures/spec-check/**`
- produces: spec-parse, spec-check-cli, spec-gate-core
- consumes: spec-bundle, existing:spec-gate
- gated-by: D-8
- acs: AC-4, AC-5, AC-6, AC-30

### S-2 · Spec check: `--cards` drift lint

- depends-on: S-1
- substrate: worktree
- files-may-touch: `resources/skills/skills/spec/scripts/spec-check-core.mjs`, `resources/skills/skills/spec/scripts/spec-check.mjs`, `tests/spec-check-cards.test.ts`, `tests/fixtures/spec-check/cards/**`
- produces: cards-lint, ac-hash
- consumes: spec-parse, spec-check-cli
- acs: AC-7, AC-8

### S-3 · The skill shell: triage, the `check` verb, catalog row

- depends-on: S-2
- substrate: worktree
- files-may-touch: `resources/skills/skills/spec/SKILL.md`, `resources/skills/CATALOG.md`, `docs/user/bundled-skills.md`, `tests/bundled-spec-skill.test.ts`, `tests/fixtures/spec-skill/triage/**`, `tests/fixtures/spec-skill/staging/**`
- produces: spec-skill
- consumes: spec-check-cli, cards-lint
- gated-by: D-7, D-8
- acs: AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-31

### S-4 · Spec authoring

- depends-on: S-3
- substrate: worktree
- files-may-touch: `resources/skills/skills/spec/SKILL.md`, `resources/skills/CATALOG.md`, `docs/specs/TEMPLATE.md`, `tests/bundled-spec-skill.test.ts`, `tests/spec-skill-authoring.test.ts`, `tests/fixtures/spec-skill/authoring/**`
- produces: spec-authoring
- consumes: spec-skill, spec-parse, existing:one-by-one, existing:grill-me
- gated-by: D-1, D-7
- acs: AC-15, AC-16, AC-17, AC-18, AC-19

### S-5 · Mission at triage and the approval question

- depends-on: S-4
- substrate: worktree
- files-may-touch: `resources/skills/skills/spec/SKILL.md`, `resources/skills/CATALOG.md`, `tests/bundled-spec-skill.test.ts`
- produces: spec-mission
- consumes: spec-authoring, existing:mission-verbs
- gated-by: D-5
- acs: AC-20, AC-21

### S-6 · Derive planner

- depends-on: S-2
- substrate: worktree
- files-may-touch: `resources/skills/skills/spec/scripts/spec-derive-core.mjs`, `resources/skills/skills/spec/scripts/spec-derive.mjs`, `tests/spec-derive.test.ts`, `tests/fixtures/spec-derive/**`
- produces: derive-plan
- consumes: spec-parse, ac-hash
- gated-by: D-3
- acs: AC-22, AC-23, AC-24

### S-7 · `orchestrate-delivery` consumes the spec-born mission and the planner

- depends-on: S-5, S-6
- substrate: worktree
- files-may-touch: `resources/skills/skills/orchestrate-delivery/SKILL.md`, `resources/skills/CATALOG.md`, `tests/orchestrate-spec-integration.test.ts`, `tests/fixtures/spec-derive/**`
- produces: spec-dispatch
- consumes: derive-plan, spec-mission
- gated-by: D-3, D-5
- acs: AC-25, AC-26, AC-27

### S-8 · Contracts: awareness doc, user docs, changelog

- depends-on: S-7
- substrate: worktree
- files-may-touch: `docs/harnu-features.md`, `docs/user/bundled-skills.md`, `CHANGELOG.md`, `resources/skills/CATALOG.md`, `tests/bundled-spec-skill.test.ts`
- produces: spec-registered
- consumes: spec-dispatch
- acs: AC-28, AC-29

## Acceptance criteria

`proof` is one typed value: `test:<file>::<name>`, `script:<cmd>`, `capture:<route>@<state>` or
`record:<kind>`. There is no UI in this feature, so there is no `capture:` row. The skill is prose,
so a `test:` row grades the contract the skill's text states and the data it leans on: a payload
parsed against the real verb schema, a hash against a golden vector, a recorded run against the
real checker. Text tests match stable anchors (headings, verb names, fenced payload blocks, the
order of numbered steps), never a sentence, and each carries one mutated-text fixture that must
fail; the conversational behavior itself is the operator's to read in the recorded runs.
`refines/inherits` points to a provisional AC of card T601 (`T601 AC-n`) or to another AC here.

| id    | statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | proof                                                                                                                      | refines/inherits | covers        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------- |
| AC-1  | The spec gate, run on the PR's working tree, checks this spec (it is `status: approved` there) and exits 0.                                                                                                                                                                                                                                                                                                                                                                                                                                         | script:node scripts/ci/spec-gate.mjs                                                                                       | —                | R-21          |
| AC-2  | The campaign spec has an Amendments table with one row that points at this spec for the skills contract (its §6) parts it supersedes, and no second copy of that contract exists.                                                                                                                                                                                                                                                                                                                                                                   | script:awk '/^## Amendments/ {f=1} f && /2026-11-harnu-spec/ {ok=1} END {exit !ok}' docs/specs/2026-10-30-campaign/spec.md | —                | R-22          |
| AC-3  | The bundle carries no client identifier and only English prose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | script:npx vitest run tests/no-client-identifiers.test.ts                                                                  | —                | R-21          |
| AC-4  | `spec check` fails a spec in which a slice consumes a capability that no slice produces (and that is not written `existing:`) with `missing-producer`, or that only a slice outside its `depends-on` closure produces with `producer-not-before`. Fed the synthetic campaign fixture (the template shape, reproducing the ledger `compaction` consumed by chapter 1 and produced by chapter 5) it names the capability and both slices.                                                                                                             | test:tests/spec-check.test.ts::capability order rejects the campaign compaction contradiction                              | T601 AC-4        | R-14          |
| AC-5  | `spec check` fails a request atom that no AC `covers` cell, no `NG-` bullet and no Open-decisions question cell cites (`uncovered-atom`, naming the atom) and a spec with no atoms at all (`no-atoms`); a spec whose every atom is cited passes.                                                                                                                                                                                                                                                                                                    | test:tests/spec-check.test.ts::coverage rejects an uncited atom and a spec with no atoms                                   | —                | R-15, R-7     |
| AC-6  | `spec-check.mjs <spec-path>` lints a draft as if it were approved, runs the gate's rules, then the two checks above, collects every finding as `path:line [rule] message`, and exits 0 clean, 1 on any finding, 2 on a usage error or an unreadable file.                                                                                                                                                                                                                                                                                           | test:tests/spec-check.test.ts::cli lints a draft, collects all findings and sets the exit code                             | T601 AC-4        | R-13          |
| AC-7  | `spec-check.mjs <spec-path> --cards` reads the cards whose `spec:` names the spec and reports, per AC line, `hash-diverged` (the card's `#xxxx` differs from the hash recomputed from the spec row), `unknown-ac` (an id absent from the spec) and `missing-ac` (a slice AC absent from the slice's card). A card-only AC with no hash is listed as information; no output contains a verdict.                                                                                                                                                      | test:tests/spec-check-cards.test.ts::reports diverged, invented and missing ACs and never grades                           | T601 AC-4        | R-16          |
| AC-8  | `acHash` returns the Wave A hash: the golden vector in the Formats section hashes to `8abc`, and the definition it implements is the one `orchestrate-delivery` Phase 2 states.                                                                                                                                                                                                                                                                                                                                                                     | test:tests/spec-check-cards.test.ts::acHash matches the golden vector and the Phase 2 definition                           | AC-7             | R-16          |
| AC-9  | For fixture entries of each Small door (a one-line bug, a PR comment, a red CI, a question, a question that grows into an architectural decision), the skill's documented outcome is the named door and tier with no spec file, no mission, no sub-agent, no lint run and no tool call; an architectural question is sent to an ADR. Every door of the funnel table has its first step and its "becomes" cell.                                                                                                                                      | test:tests/bundled-spec-skill.test.ts::triage ends the small doors without a spec                                          | T601 AC-1        | R-2, R-3, R-4 |
| AC-10 | For fixture entries of each higher tier (a `standard` card, a `standard` card with a decision to record, a `complex` card), the documented outcome is Medium, Large and Complex, each with a one-line reason the operator can override with one word.                                                                                                                                                                                                                                                                                               | test:tests/bundled-spec-skill.test.ts::triage picks the tier and states the reason                                         | T601 AC-1        | R-2           |
| AC-11 | The triage section is the first section of `SKILL.md`, at most 40 lines, and ends the Small path before any later heading; the Medium-and-up procedure sits under later headings.                                                                                                                                                                                                                                                                                                                                                                   | test:tests/bundled-spec-skill.test.ts::the small path is first and short                                                   | T601 AC-1        | R-4           |
| AC-12 | The skill's name and `description` say it is called at every entry and that most calls end Small; the text documents exactly two verbs, `<entry>` and `check [--cards]`, and no `derive` or `close`.                                                                                                                                                                                                                                                                                                                                                | test:tests/bundled-spec-skill.test.ts::description states every-entry and two verbs only                                   | —                | R-1, R-4      |
| AC-13 | The skill parses as a bundled skill whose name matches its directory, has a row in `resources/skills/CATALOG.md` and in `docs/user/bundled-skills.md`, carries no personal path, and the catalog marker is at least `v14`.                                                                                                                                                                                                                                                                                                                          | test:tests/bundled-spec-skill.test.ts::registered in the catalog and the user doc                                          | T601 AC-C        | R-20          |
| AC-14 | The `check` verb section gives the exact command lines (`node <skill directory>/scripts/spec-check.mjs <spec-path>`, with `--cards`), says the skill directory is the base directory the session is told when the skill loads, and says how the path is resolved; it contains no by-hand variant of the checks.                                                                                                                                                                                                                                     | test:tests/bundled-spec-skill.test.ts::the check verb names the staged command                                             | T601 AC-4        | R-13          |
| AC-15 | Run on three recorded inputs (a brainstorm, a scope-task report, a PRD), the skill's procedure yields, for each, a spec at `docs/specs/YYYY-MM-DD-<slug>/spec.md` that passes `spec check` on the first run with at least as many atoms as the input lists requests. Inputs, recorded outputs and each run's session note are committed.                                                                                                                                                                                                            | test:tests/spec-skill-authoring.test.ts::recorded authoring runs pass the gate and the checks                              | T601 AC-2        | R-5, R-7      |
| AC-16 | The authoring text orders its work: facts first (`memory_query`, lessons, the code), then decisions one at a time through `harnu:one-by-one`; an unanswered D-n stays `open` with its default shown and is never written as declined or resolved.                                                                                                                                                                                                                                                                                                   | test:tests/bundled-spec-skill.test.ts::authoring looks facts up and leaves unanswered decisions open                       | —                | R-6, R-11     |
| AC-17 | The authoring text requires one blind builder-check by a sub-agent given only the spec; for Complex also two lens critics (overhead, traceability) in parallel; every finding is fixed in the spec or recorded as a D-n or a non-goal, and the summary is written to `critics.md` beside the spec.                                                                                                                                                                                                                                                  | test:tests/bundled-spec-skill.test.ts::authoring runs the builder-check and the complex lens critics                       | —                | R-8           |
| AC-18 | Once any slice has a card (a `card` row in the Amendments table, or a `spec-slice` marker on a card whose `spec:` names this spec), the text appends Amendments rows only and never edits the body above them; the amendment is sent to the affected executor as a delta.                                                                                                                                                                                                                                                                           | test:tests/bundled-spec-skill.test.ts::a dispatched spec changes only by amendment                                         | —                | R-12          |
| AC-19 | For a Complex entry the text writes the PRD at `docs/prds/<card>-<slug>.md`, an ADR at `docs/adr/NNNN-<slug>.md` only when an architectural decision is recorded, and a mockup folder reference when the work has UI; every path is tracked and never under the gitignored scratch directory, and the header passes the gate.                                                                                                                                                                                                                       | test:tests/bundled-spec-skill.test.ts::complex entries get tracked prd, adr and mockup paths                               | —                | R-25          |
| AC-20 | The documented `mission_create` payload for a spec in authoring parses against the real `mission_create` input schema, has the `human` step "Approve spec", and its `scope` lists the spec path and the PRD and ADR paths the tier will carry, written or not.                                                                                                                                                                                                                                                                                      | test:tests/bundled-spec-skill.test.ts::triage mission payload parses against mission_create                                | T601 AC-3        | R-9           |
| AC-21 | The text orders the approval: mission first, then `open_file`, then one approval question; on a yes it flips the header to `approved` and points the operator at the step's Mark verified control (it never ticks the step); with no operator it calls `mission_set_blocker` as the operator's (Harnu chimes and re-nudges) and stops, the documented payload parsing against the verb schema.                                                                                                                                                      | test:tests/bundled-spec-skill.test.ts::approval order and the operator blocker payload                                     | T601 AC-3        | R-10, R-11    |
| AC-22 | Given a spec and a board, the derive plan creates one card per slice without one; a second plan computed over the board the first produced (applied by the test) is empty; a card in progress, review or done is `skip`, never changed.                                                                                                                                                                                                                                                                                                             | test:tests/spec-derive.test.ts::second plan is empty and in-progress cards are skipped                                     | T601 AC-5        | R-18          |
| AC-23 | An `update` rewrites only the span between the `spec:begin` and `spec:end` markers, every byte outside them unchanged; the case runs once with the card found by its `spec-slice` marker and once with the card found only by an Amendments `card` row, after an AC changed on a backlog card.                                                                                                                                                                                                                                                      | test:tests/spec-derive.test.ts::update rewrites only the marked block for a marker and for a map row                       | AC-22            | R-17, R-18    |
| AC-24 | The plan refuses, with the reason, a slice with no `files-may-touch`, two slices with no `depends-on` path between them whose `files-may-touch` overlap, a slice whose cited AC is missing from the table, and a card with an unbalanced marker pair; it skips a marked card whose slice no longer exists as `orphan`.                                                                                                                                                                                                                              | test:tests/spec-derive.test.ts::plan refuses missing scope, overlap and broken markers                                     | AC-22            | R-17          |
| AC-25 | Under the D-5 default, `orchestrate-delivery` Phase 1 adopts a mission whose scope names the spec (`mission_list` then `mission_get`) instead of calling `mission_create` a second time; it adds the slice steps with `mission_add_step` and a reason.                                                                                                                                                                                                                                                                                              | test:tests/orchestrate-spec-integration.test.ts::phase 1 adopts the spec-born mission                                      | T601 AC-5        | R-9, R-17     |
| AC-26 | Phase 2 runs the derive planner (found as the sibling `../spec/scripts/spec-derive.mjs` of its own base directory; with `harnu:spec` switched off it keeps the Wave A hand derivation and says the planner was unavailable), executes its plan with `create_card` and `update_card`, writes the `spec-slice: S-n` marker with each card, leaves the envelope to the orchestrator, and hands the `card` rows to the wave's bookkeeping unit (D-3 default) because a promoted orchestrator cannot edit the spec; Phase 2 text names no `derive` verb. | test:tests/orchestrate-spec-integration.test.ts::phase 2 runs the planner and hands the card map to a unit                 | T601 AC-5        | R-17, R-18    |
| AC-27 | For each open D-n, the documented `mission_add_step` payload with a `decision` parses against the real schema and `blocks` lists exactly the steps of the slices whose `gated-by` names it; a D-n gating no slice gets no node; slices no open D-n gates are dispatched.                                                                                                                                                                                                                                                                            | test:tests/orchestrate-spec-integration.test.ts::open decisions become decision nodes that gate only their slices          | —                | R-19, R-11    |
| AC-28 | `docs/harnu-features.md` names `harnu:spec` in its bundled-skills paragraph, states triage-first and the two verbs, says `check` works in any repo because the checker is staged with the skill, and its marker is at least `v113`.                                                                                                                                                                                                                                                                                                                 | test:tests/bundled-spec-skill.test.ts::the awareness doc names the skill and the marker is bumped                          | T601 AC-C        | R-20          |
| AC-29 | `docs/user/bundled-skills.md` has a section for `harnu:spec` (what triage decides, what it writes, how to approve, the `check` verbs, and that they work in any repo) and `CHANGELOG.md` has a user-facing entry that names the skill.                                                                                                                                                                                                                                                                                                              | test:tests/bundled-spec-skill.test.ts::user guide section and changelog entry exist                                        | T601 AC-C        | R-20          |
| AC-30 | `scripts/ci/spec-gate-core.mjs` re-exports the vendored `resources/skills/skills/spec/scripts/spec-gate-core.mjs` (the same function objects, one implementation), `scripts/ci/spec-gate.mjs` is unchanged, and `tests/spec-gate.test.ts` passes unchanged.                                                                                                                                                                                                                                                                                         | test:tests/spec-check.test.ts::the ci gate core is the vendored gate core                                                  | AC-6             | R-13          |
| AC-31 | Staging an enabled `spec` skill copies `scripts/` beside `SKILL.md` into the staged session directory, and the staged `spec-check.mjs` run with Node from a directory holding no Harnu file lints a fixture spec and exits as AC-6 states.                                                                                                                                                                                                                                                                                                          | test:tests/bundled-spec-skill.test.ts::staging copies scripts beside SKILL.md and the staged checker runs anywhere         | T601 AC-4        | R-13, R-20    |

## Open decisions

Resolved through `harnu:one-by-one`. Every row was open when the spec was drafted and carries the
default a slice would have used; the operator resolved all eight on 2026-10-31 (D-1 to D-7 took the
default, D-8 changed it). A resolved row no longer gates its slices, and each is recorded as one line
in project memory (`decisions`).

| id  | question                                                                                                                                    | options                                                                                                                                                       | default                                                                                                                                                | status                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| D-1 | Does `TEMPLATE.md` adopt the four conventions above (`gated-by:`, `NG-n` bullets, `existing:` tokens, `card` rows)?                         | adopt in S-4; keep them in the skill only                                                                                                                     | adopt in S-4 (the template and the checker must not disagree)                                                                                          | resolved · adopt in S-4 · 2026-10-31                                                                              |
| D-2 | Does `spec-check` become a CI gate, or stay a skill-run check?                                                                              | skill-run only; CI gate on approved specs; CI warning only                                                                                                    | skill-run only in Wave B; the wave-A gate stays the only CI contract until one wave of evidence                                                        | resolved · skill-run only · 2026-10-31                                                                            |
| D-3 | Who appends the `card` rows to the spec, given an orchestrator promoted by Harnu cannot edit outside its scratch and `.harnu/` directories? | a docs-only bookkeeping unit per wave; the verifier with its Deviations rows; the card marker alone, no spec rows                                             | the card always carries the `spec-slice: S-n` marker (derive is idempotent from the board alone) and the wave's bookkeeping unit commits the spec rows | resolved · the card marker always, and the wave's bookkeeping unit commits the spec rows · 2026-10-31             |
| D-4 | Is the freeze enforced mechanically (`check --base <ref>` flags body edits once a slice has a card)?                                        | text rule only; mechanical check                                                                                                                              | text rule only; the mechanical check is a Wave C candidate                                                                                             | resolved · text rule only · 2026-10-31                                                                            |
| D-5 | What does the triage-time mission declare as its end?                                                                                       | the delivery's end from the objective, re-scoped with `mission_set_end` when the spec changes it; the spec approval itself, then a second mission at dispatch | the delivery's end (one mission per body of work, so Phase 1 adopts it)                                                                                | resolved · the delivery's end · 2026-10-31                                                                        |
| D-6 | Does Wave B add a live model eval of triage (a graded transcript)?                                                                          | none; a recorded transcript fixture                                                                                                                           | none; contract and fixture tests only, plus the recorded authoring runs of AC-15                                                                       | resolved · none · 2026-10-31                                                                                      |
| D-7 | How does the skill map card complexity to the Medium/Large boundary?                                                                        | `standard` is Medium and becomes Large when a D-n or non-goal must be recorded; always ask; `standard` is always Large                                        | `standard` is Medium, Large when it needs a D-n or a non-goal; the skill states the reason in one line and the operator overrides with one word        | resolved · `standard` is Medium, Large when it needs a D-n or a non-goal · 2026-10-31                             |
| D-8 | Where does the checker ship, given a bundled skill runs in any repo and the scripts live in the Harnu repo's `scripts/ci/`?                 | Harnu repo only, with the by-hand fallback in the skill text; vendored inside the skill directory (`scripts/` beside `SKILL.md`, copied by the staging)       | Harnu repo only in Wave B; vendoring needs the gate's rules copied too, which is a second implementation to keep in step                               | resolved · vendored inside the skill directory (`scripts/` beside `SKILL.md`, copied by the staging) · 2026-10-31 |

## Amendments · Deviations

Append-only after approval. Never edit the sections above once the first card is dispatched;
record the change here and send the affected executor a delta.

| date       | kind      | what changed                                                                                                                                                                                                                                                                                                                                 | by   |
| ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 2026-10-31 | amendment | D-1 to D-8 resolved by the operator; D-8 changed from "Harnu repo only" to vendoring the checker in the skill directory. S-1, S-2, S-3 and S-6 now name the vendored paths; AC-14, AC-26, AC-28 and AC-29 reworded; AC-30 and AC-31 added; the by-hand fallback is gone. Applied before the first dispatch, so the body was edited in place. | T605 |
