---
status: draft
tier: medium
---

# Campaign ledger (synthetic)

The template shape of the campaign spec's contradiction: the ledger `compaction` event is
consumed by chapter 1 and only built by chapter 5.

## Problem

- R-1 The ledger records every compaction of the owner session.
- R-2 Chapter 1 shows the compaction on the mission.

## Slices

### S-1 · Chapter 1 · Mission ledger view

- depends-on: —
- substrate: worktree
- files-may-touch: `src/ledger/view.ts`
- produces: ledger-view
- consumes: compaction
- acs: AC-1

### S-2 · Chapter 2 · Ledger rows

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/ledger/rows.ts`
- produces: ledger-rows
- consumes: ledger-view
- acs: AC-2

### S-3 · Chapter 3 · Gates

- depends-on: S-2
- substrate: worktree
- files-may-touch: `src/ledger/gates.ts`
- produces: gates
- consumes: ledger-rows
- acs: AC-3

### S-4 · Chapter 4 · Steward

- depends-on: S-3
- substrate: worktree
- files-may-touch: `src/ledger/steward.ts`
- produces: steward
- consumes: gates
- acs: AC-4

### S-5 · Chapter 5 · Compaction hook

- depends-on: S-4
- substrate: worktree
- files-may-touch: `src/ledger/compaction.ts`
- produces: compaction
- consumes: steward
- acs: AC-5

## Acceptance criteria

| id   | statement                                   | proof                                         | refines/inherits | covers |
| ---- | ------------------------------------------- | --------------------------------------------- | ---------------- | ------ |
| AC-1 | The mission view shows the compaction row.  | test:tests/ledger-view.test.ts::shows         | —                | R-2    |
| AC-2 | The ledger lists rows in order.             | test:tests/ledger-rows.test.ts::orders        | —                | R-1    |
| AC-3 | The gates read the ledger.                  | test:tests/ledger-gates.test.ts::reads        | —                | R-1    |
| AC-4 | The steward wakes on a ledger row.          | test:tests/ledger-steward.test.ts::wakes      | —                | R-1    |
| AC-5 | The compaction hook appends the ledger row. | test:tests/ledger-compaction.test.ts::appends | —                | R-1    |
