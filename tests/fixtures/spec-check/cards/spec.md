---
status: draft
tier: medium
---

# Acme export

## Problem

Exports are slow and have no progress. The request, atomized:

- R-1 Exports stream instead of buffering.
- R-2 The export shows progress.

## Slices

### S-1 · Stream the export

- depends-on: —
- substrate: worktree
- files-may-touch: `src/export/stream.ts`, `tests/export-stream.test.ts`
- produces: export-stream
- consumes: existing:csv-writer
- acs: AC-1, AC-2

### S-2 · Show progress

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/export/progress.ts`
- produces: export-progress
- consumes: export-stream
- acs: AC-3

## Acceptance criteria

| id   | statement                                       | proof                                         | refines/inherits | covers |
| ---- | ----------------------------------------------- | --------------------------------------------- | ---------------- | ------ |
| AC-1 | Exports stream rows as they are read.           | test:tests/export-stream.test.ts::streams     | —                | R-1    |
| AC-2 | The stream keeps memory flat on a large export. | test:tests/export-stream.test.ts::flat memory | AC-1             | R-1    |
| AC-3 | The export reports progress while running.      | test:tests/export-progress.test.ts::reports   | AC-1             | R-2    |

## Amendments · Deviations

| date       | kind | what changed         | by           |
| ---------- | ---- | -------------------- | ------------ |
| 2026-11-03 | card | S-2 -> progress-card | orchestrator |
