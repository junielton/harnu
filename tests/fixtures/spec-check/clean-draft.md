---
status: draft
tier: large
---

# Acme export

## Problem

Exports are slow and have no progress. The request, atomized:

- R-1 Exports stream instead of buffering.
- R-2 The export shows progress.
- R-3 Legacy CSV dialects stay out of scope.
- R-4 Whether to cap export size is decided with the operator.

## Goals

- G-1 A large export no longer freezes the app.

**Non-goals:**

- NG-1 No legacy CSV dialects. (R-3)

## Slices

### S-1 · Stream the export

- depends-on: —
- substrate: worktree
- files-may-touch: `src/export/stream.ts`, `tests/export-stream.test.ts`
- produces: export-stream
- consumes: existing:csv-writer
- acs: AC-1

### S-2 · Show progress

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/export/progress.ts`
- produces: export-progress
- consumes: export-stream
- gated-by: D-1
- acs: AC-2

## Acceptance criteria

| id   | statement                                  | proof                                       | refines/inherits | covers |
| ---- | ------------------------------------------ | ------------------------------------------- | ---------------- | ------ |
| AC-1 | The export streams rows as they are read.  | test:tests/export-stream.test.ts::streams   | —                | R-1    |
| AC-2 | The export reports progress while running. | test:tests/export-progress.test.ts::reports | AC-1             | R-2    |

## Open decisions

| id  | question                         | options     | default | status |
| --- | -------------------------------- | ----------- | ------- | ------ |
| D-1 | Do we cap the export size? (R-4) | cap, no cap | no cap  | open   |

## Amendments · Deviations

| date       | kind      | what changed         | by           |
| ---------- | --------- | -------------------- | ------------ |
| 2026-11-02 | card      | S-1 → old-card       | orchestrator |
| 2026-11-03 | card      | S-1 → stream-card    | orchestrator |
| 2026-11-03 | card      | S-2 -> progress-card | orchestrator |
| 2026-11-03 | amendment | S-2 moved later      | orchestrator |
