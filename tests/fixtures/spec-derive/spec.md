---
status: approved
tier: complex
prd: docs/prds/acme-export.md
adr: docs/adr/0042-acme-export.md
---

# Acme export

## Problem

Exports are slow, show no progress and have no guide. The request, atomized:

- R-1 Exports stream instead of buffering.
- R-2 The export shows progress.
- R-3 The export has a user guide.

## Slices

### S-1 · Stream the export

- depends-on: —
- substrate: worktree
- files-may-touch: `src/export/stream.ts`, `tests/export-stream.test.ts`
- produces: export-stream
- consumes: existing:csv-writer
- acs: AC-1, AC-2

### S-2 · Show `progress` while exporting

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/export/progress.ts`, `src/export/**`
- produces: export-progress
- consumes: export-stream
- acs: AC-3

### S-3 · Export guide

- depends-on: —
- substrate: worktree
- files-may-touch: `docs/user/export.md`
- produces: export-guide
- consumes: existing:user-docs
- gated-by: D-1
- acs: AC-4

## Acceptance criteria

| id   | statement                                                     | proof                                         | refines/inherits | covers |
| ---- | ------------------------------------------------------------- | --------------------------------------------- | ---------------- | ------ |
| AC-1 | Exports stream rows as they are read — never the whole table. | test:tests/export-stream.test.ts::streams     | —                | R-1    |
| AC-2 | The stream keeps memory flat on a large export.               | test:tests/export-stream.test.ts::flat memory | AC-1             | R-1    |
| AC-3 | The export reports `progress` while running.                  | test:tests/export-progress.test.ts::reports   | AC-1             | R-2    |
| AC-4 | The guide explains how to start an export.                    | script:test -f docs/user/export.md            | —                | R-3    |

## Open decisions

| id  | question                                    | options         | default   | status |
| --- | ------------------------------------------- | --------------- | --------- | ------ |
| D-1 | Does the guide live in the user docs (R-3)? | user docs; wiki | user docs | open   |

## Amendments · Deviations

| date       | kind | what changed         | by           |
| ---------- | ---- | -------------------- | ------------ |
| 2026-11-03 | card | S-2 -> acme-progress | orchestrator |
