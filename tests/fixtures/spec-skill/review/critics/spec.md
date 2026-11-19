---
status: draft
tier: large
---

# Acme badge

## Problem

The folder row has no unread badge. The request, atomized:

- R-1 A folder row shows how many sessions changed since it was last opened.
- R-2 Opening the folder clears the badge.
- R-3 The badge never counts archived sessions.

## Goals

- G-1 The operator sees which folders moved without opening them.

**Non-goals:**

- NG-1 No badge on the repo group header. (R-3)

## Slices

### S-1 · Unread badge

- depends-on: —
- substrate: worktree
- files-may-touch: `src/badge/count.ts`, `tests/badge-count.test.ts`
- produces: unread-badge
- consumes: existing:folder-row
- gated-by: D-1
- acs: AC-1, AC-2

## Acceptance criteria

| id   | statement                                          | proof                                  | refines/inherits | covers |
| ---- | -------------------------------------------------- | -------------------------------------- | ---------------- | ------ |
| AC-1 | The row shows the count of sessions changed since. | test:tests/badge-count.test.ts::counts | —                | R-1    |
| AC-2 | Opening the folder resets the count to zero.       | test:tests/badge-count.test.ts::resets | AC-1             | R-2    |

## Open decisions

| id  | question                                          | options     | default | status |
| --- | ------------------------------------------------- | ----------- | ------- | ------ |
| D-1 | Does a hibernated session count as changed (R-1)? | count; skip | count   | open   |
