---
status: draft
tier: medium
---

# Draft with one defect per rule

## Problem

- R-1 The first thing asked.
- R-2 The second thing asked, which nothing cites.

## Slices

### S-1 · Only slice

- depends-on: —
- substrate: worktree
- files-may-touch: `src/a.ts`
- produces: alpha
- consumes: beta
- acs: AC-1, AC-9

## Acceptance criteria

| id   | statement  | proof                   | refines/inherits | covers |
| ---- | ---------- | ----------------------- | ---------------- | ------ |
| AC-1 | One thing. | test:tests/a.test.ts::a | —                | R-1    |
| AC-1 | Same id.   | test:tests/b.test.ts::b | —                | R-1    |
