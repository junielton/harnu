---
status: draft
tier: medium
---

# Spec whose Problem section has no atoms

## Problem

Something is wrong, but nobody wrote it down as numbered atoms.

## Slices

### S-1 · Only slice

- depends-on: —
- substrate: worktree
- files-may-touch: `src/a.ts`
- produces: alpha
- consumes: —
- acs: AC-1

## Acceptance criteria

| id   | statement  | proof                   | refines/inherits | covers |
| ---- | ---------- | ----------------------- | ---------------- | ------ |
| AC-1 | One thing. | test:tests/a.test.ts::a | —                | —      |
