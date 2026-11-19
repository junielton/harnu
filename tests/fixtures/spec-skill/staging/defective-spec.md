---
status: draft
tier: medium
---

# Acme badge, with a contradiction

## Problem

- R-1 A folder row shows how many sessions changed since it was last opened.
- R-2 The badge also shows on the repo group header.

## Slices

### S-1 · Unread badge

- depends-on: —
- substrate: worktree
- files-may-touch: `src/badge/count.ts`
- produces: unread-badge
- consumes: group-header-slot
- acs: AC-1

## Acceptance criteria

| id   | statement                                          | proof                                  | refines/inherits | covers |
| ---- | -------------------------------------------------- | -------------------------------------- | ---------------- | ------ |
| AC-1 | The row shows the count of sessions changed since. | test:tests/badge-count.test.ts::counts | —                | R-1    |
