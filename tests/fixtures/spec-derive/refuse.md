---
status: approved
tier: medium
---

# Acme import

## Problem

Imports need fixing. The request, atomized:

- R-1 Imports are fixed.

## Slices

### S-1 · No scope

- depends-on: —
- substrate: worktree
- files-may-touch: —
- produces: a
- consumes: —
- acs: AC-1

### S-2 · Parser

- depends-on: —
- substrate: worktree
- files-may-touch: `src/import/**`
- produces: b
- consumes: —
- acs: AC-1

### S-3 · Reader

- depends-on: —
- substrate: worktree
- files-may-touch: `src/import/reader.ts`
- produces: c
- consumes: —
- acs: AC-1

### S-4 · Writer after the parser

- depends-on: S-2
- substrate: worktree
- files-may-touch: `src/import/writer.ts`
- produces: d
- consumes: b
- acs: AC-1

### S-5 · Missing AC

- depends-on: —
- substrate: worktree
- files-may-touch: `src/report.ts`
- produces: e
- consumes: —
- acs: AC-1, AC-9

### S-6 · Broken card

- depends-on: —
- substrate: worktree
- files-may-touch: `src/broken.ts`
- produces: f
- consumes: —
- acs: AC-1

### S-7 · Clean

- depends-on: —
- substrate: worktree
- files-may-touch: `src/clean.ts`, `src/clean.test.ts`
- produces: g
- consumes: —
- acs: AC-1

## Acceptance criteria

| id   | statement          | proof                            | refines/inherits | covers |
| ---- | ------------------ | -------------------------------- | ---------------- | ------ |
| AC-1 | Imports are fixed. | test:tests/import.test.ts::fixed | —                | R-1    |

## Amendments · Deviations

| date | kind | what changed | by  |
| ---- | ---- | ------------ | --- |
