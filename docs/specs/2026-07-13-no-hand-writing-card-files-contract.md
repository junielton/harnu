# Card files are Capy's, not the agent's

**Date:** 2026-07-13
**Card:** `the-contract-never-forbids-hand-writing-a-card-file`
**Status:** design approved, not implemented

## Problem

Every board invariant lives in the verb layer, and only there:

- `create_card` births a card in `backlog` — `status` isn't even an argument.
- `move_card`'s enum is `backlog|ready|review`; `done` and `in-progress` cannot parse.
- `update_card` refuses `status` / `session` / `evidence` / `provenance` / `approved` /
  `approvedBodyHash`.

But a card is plain markdown on disk, and it is writable. Any session holding `Write` can
put `status: done` — or a forged `approved:` + `approvedBodyHash:` — straight into
`.capy/memory/roadmap/<slug>.md`, and the watcher re-emits it as truth. The parser does not
care who wrote the file.

The enforcement is therefore asymmetric: the _verb_ is a locked door standing next to an
_open window_, and nothing in the session's context mentions the window. `docs/capy-features.md`
— prepended to every session's system prompt — documents the verbs and their prohibitions
("you NEVER move a card to `done`"), then leaves the file sitting there with no "don't". An
agent that does not independently infer the prohibition will reach for `Write`, because
nothing told it not to.

### This is a contract gap, not a vulnerability

The orchestrator guard does not close it, **by design**. `isCapyDir()`
(`resources/orchestrator-guard/guard.mjs:48`) explicitly allows every write inside
`<folder>/.capy/`, and the file's own header states why: it is "a behavioral-drift brake,
NOT a security boundary — the real doors are server-side (T104/T80)." That is correct. An
agent with shell access can rewrite any file regardless, so a filesystem check buys nothing
against an adversary.

The threat is **drift, not malice** — and it already happened. The personal `/roadmap` skill
(`~/.claude/skills/roadmap/`) instructed agents to hand-write a card's `status:` to
`done`/`dropped` and move the file to `archive/`. A well-meaning skill routed around the
`done` gate purely because the file was there and nothing forbade touching it.

### Why the gates are worth stating

- `done` is the signal that tells the operator "this shipped — stop looking at it." A
  hand-written `done` makes the board lie **upward**, to the human.
- `approved` + `approvedBodyHash` is the stamp that lets a card auto-dispatch without the
  operator's go (`decideDispatchGate`, `roadmap-core.ts:1212`). The manifest gate is the
  strongest human door in the product, and it is one `Write` call from being bypassed by an
  agent that simply did not know better.

## Design

Docs-only. Three files gain the same prohibition, each phrased for its reader. **No `src/`
change, no test change, no filesystem enforcement.**

### 1. `docs/capy-features.md` — the agent contract

Append to the existing **"Roadmap board — what you can and cannot do"** section (line ~127),
in the doc's terse second-person voice, and bump the version marker (`<!-- capy-features vN -->`,
currently `v17`):

> The card files are Capy's, not yours. NEVER Edit/Write `.capy/memory/roadmap/*.md`
> directly — go through the verbs. The file being writable is not permission: hand-writing
> skips server-side provenance, the template seed, parent/deps validation, and — the point —
> the `done` and `approved` gates that exist to protect the operator.

The prohibition must name **the reason** (the gates), not just the rule. An agent that
understands _why_ generalizes to the next writable surface; an agent given a bare "don't"
rules-lawyers the first edge case it meets.

### 2. `docs/capy-orchestrator.md` — the promoted role

The orchestrator is the role with the most reason to reach for `Write` on a card: its guard
explicitly permits `.capy/`, and grooming the board _is_ its job. State the prohibition in
**"The tool contract — stated on tools, not intentions"** (the "Forbidden, no exceptions"
list, line ~24), next to the existing "Moving a card to `done` — the verb structurally
refuses it":

> **Write/Edit on `.capy/memory/roadmap/*.md`.** The board is yours to organize, through
> the verbs — never through the file. The verb refusing `done` and refusing to stamp
> `approved` is not a limitation to route around; it is the operator's door. Hand-writing
> the file walks around it and skips provenance, the template seed, and `parent`/`deps`
> validation on the way.

This is a restatement, not new policy — it makes explicit at the tool layer what §"The three
doors that are never yours" already asserts as principle.

### 3. `docs/user/roadmap-board.md` — the human

The operator's mental model of "an agent can organize the board but only I greenlight work"
(the existing **"What agents can and can't do here"** section) is exactly as true as the
agent's willingness to use the verbs. Say so plainly, so the human knows what they are
trusting:

> These limits are enforced by the tools an agent uses to touch the board, not by the files
> themselves — a card is a plain markdown file in `.capy/memory/roadmap/`, and Capy tells
> every session, in as many words, not to edit those files by hand. If you edit one yourself,
> Capy reads it as-is: it skips the provenance stamp and the checks the board's own actions
> apply, so prefer the board UI for anything you want recorded properly.

Deliberately _not_ alarmist — the human's own hand-authored cards are legitimate (every
`T<n>`/`BUG-<n>` card on the board today started life as a file). The point is disclosure,
not prohibition.

### 4. `/roadmap` skill — strip the now-redundant paragraph

`~/.claude/skills/roadmap/SKILL.md` carries its own "Capy board — use the verbs, never
hand-write the file" paragraph. Once the contract ships in `docs/capy-features.md` it reaches
every session of every user, and the skill's copy becomes a second source of truth that can
drift. Remove it from the skill as part of this work (out-of-repo edit; not gated by CI).

### Explicitly out of scope

Do **not** enforce this in the filesystem — no `chmod`, no guard-deny on
`.capy/memory/roadmap/`, no signature over the frontmatter. It would break the human's own
hand-authored cards, would not stop a determined agent (shell access trivially bypasses any
in-process check), and would contradict the guard's stated nature as a drift brake rather
than a security boundary. **This is a contract to state, not a wall to build.**

## Testing

No automated test — nothing executable changes. Verification is a read of the three files:

- `grep -n 'roadmap/\*\.md' docs/capy-features.md docs/capy-orchestrator.md` returns the
  prohibition in both, and each hit names a gate (`done` / `approved`) as the reason.
- `head -1 docs/capy-features.md` shows a version marker greater than `v17`.
- `grep -n 'by hand' docs/user/roadmap-board.md` returns the disclosure paragraph.
- The `/roadmap` skill no longer carries its own copy of the rule.
- `git diff --stat` touches **only** `docs/` — a `src/` hunk in this change is a scope
  violation, and a new deny-rule in `resources/orchestrator-guard/guard.mjs` doubly so.

Behavioral confirmation (manual, one session): boot a session in an agent-enabled folder,
ask it to close a card. It should reach for the operator's Close / say it cannot, rather than
writing `status: done` into the file.

## Contract obligations

- **`docs/capy-features.md` + version-marker bump — mandatory.** This _is_ the change. The
  CI awareness gate (`scripts/ci/awareness-gate.mjs`) does not fire on a docs-only diff (it
  triggers on `tool-catalog.ts` / `capy-features.ts`), so the marker bump is on the author,
  not the gate. It is agent-facing under CLAUDE.md's own litmus: a new prohibition on a verb
  surface is something the session must _act on_.
- **`docs/user/roadmap-board.md`** — touched here as disclosure, not because the user-docs
  gate demands it (that gate fires on new top-level components / `src/main/` files /
  `tool-catalog.ts`, none of which this change has).
- **`CHANGELOG.md` — debatable, lean no.** CLAUDE.md exempts pure-docs changes "unless the
  effect is user-visible". Nothing a user can see or do changes. If bundled with the
  priority-token card (below) under a shared entry, a single `### Changed` bullet is fine;
  standalone, skip it.
- **Bundling.** This card ships with the priority-token card — both edit
  `docs/capy-features.md`, and the two share **ONE** version-marker bump. This card
  contributes **no `src/` change at all**.
