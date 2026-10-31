---
status: draft
tier: complex
prd: docs/prds/example.md
adr: docs/adr/0000-example.md
mockup: docs/design/example/
---

<!--
HOW TO USE THIS TEMPLATE

Copy it to docs/specs/YYYY-MM-DD-<slug>/spec.md, fill it in, and delete this comment.

HEADER (the block between the two `---` lines)
  status  draft | approved. The spec gate (scripts/ci/spec-gate.mjs) only checks
          `approved` specs; a draft is skipped. The operator's yes in chat is the approval;
          flip the line in the same PR that lands the spec.
  tier    medium | large | complex. Pick the smallest tier that fits; the gate refuses any
          `##` section outside the tier's whitelist:
            medium   Problem · Slices · Acceptance criteria
            large    + Goals · Open decisions
            complex  + the prd, adr and mockup header fields
          "Amendments · Deviations" is allowed on every tier.
  prd / adr / mockup   complex only. Repo-relative paths to TRACKED files (a mockup may be a
          tracked directory). Delete the lines you do not need; never point at a gitignored
          path — a fresh worktree cannot see it.

Small work (one area, no new interface, reviewable at a glance) gets no spec at all: the card's
own acceptance criteria are the spec.

Write the committed path of every artifact. Do not cite the gitignored scratch directory
anywhere in the file, not even in prose; the gate fails on it.
-->

# Title of the feature

## Problem

What is wrong or missing, measured where possible. Then atomize the request into numbered
atoms, one per sentence the requester said, so every AC can say which atom it covers:

- R-1 First thing that was asked.
- R-2 Second thing that was asked.

## Goals

- G-1 What the operator sees or can do once this ships.

**Non-goals:** what this spec deliberately does not do.

**Anti-goals:** outcomes that would make the work a failure even if every AC passed.

## Slices

One `###` block per slice. A slice is one unit of work: one branch, one session, one PR. The
`acs:` line is a comma-separated list of ids from the table below, nothing else. The
orchestrator pastes `files-may-touch` into the card as the scope boundary and copies each AC
with its id from the table; it never invents either.

### S-1 · Name of the first slice

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/example.ts`, `tests/example.test.ts`
- produces: example-capability
- consumes: —
- acs: AC-1, AC-2

### S-2 · Name of the second slice

- depends-on: S-1
- substrate: session
- files-may-touch: `docs/user/example.md`
- produces: —
- consumes: example-capability
- acs: AC-3

## Acceptance criteria

`proof` is one typed value, so the verifier knows what to look at:

- `test:<file>::<name>` — a named test in a test file
- `script:<cmd>` — a command that exits 0 when the criterion holds
- `capture:<route>@<state>` — a screenshot of a route in a named state
- `record:<kind>` — a durable record to inspect, such as `record:adr` or `record:changelog`

`refines/inherits` links an AC to a feature-level AC it narrows, or to another spec's AC it must
keep true. `covers` lists the request atoms it closes.

| id   | statement                                | proof                                     | refines/inherits | covers |
| ---- | ---------------------------------------- | ----------------------------------------- | ---------------- | ------ |
| AC-1 | The example behaves as described in R-1. | test:tests/example.test.ts::behaves       | —                | R-1    |
| AC-2 | The example page shows the empty state.  | capture:/example@empty                    | AC-1             | R-1    |
| AC-3 | The user guide explains the example.     | script:node scripts/ci/user-docs-gate.mjs | —                | R-2    |

## Open decisions

Resolve one at a time. A resolved row is also recorded as ONE line in project memory
(`memory_append` to `decisions`): `D-n · <question> · chosen: <option> · <date>`.

| id  | question                            | options  | default | status |
| --- | ----------------------------------- | -------- | ------- | ------ |
| D-1 | Which storage does the example use? | file, db | file    | open   |

## Amendments · Deviations

Append-only after approval. Never edit the sections above once the first card is dispatched;
record the change here and send the affected executor a delta.

| date       | kind      | what changed                                  | by           |
| ---------- | --------- | --------------------------------------------- | ------------ |
| 2026-11-01 | amendment | S-2 moved to a later wave                     | orchestrator |
| 2026-11-02 | deviation | AC-2 met by a capture at a different viewport | verifier     |
