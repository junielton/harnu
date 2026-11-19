---
status: approved
tier: large
---

# Acme import

## Problem

Imports are manual, unvalidated and undocumented. The request, atomized:

- R-1 Imports read a CSV upload.
- R-2 Imports validate every row.
- R-3 The import has a user guide.

## Slices

### S-1 · Read the upload

- depends-on: —
- substrate: worktree
- files-may-touch: `src/import/read.ts`, `tests/import-read.test.ts`
- produces: import-read
- consumes: existing:csv-reader
- gated-by: D-3
- acs: AC-1

### S-2 · Validate rows

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/import/validate.ts`, `tests/import-validate.test.ts`
- produces: import-validate
- consumes: import-read
- gated-by: D-1
- acs: AC-2

### S-3 · Import guide

- depends-on: —
- substrate: worktree
- files-may-touch: `docs/user/import.md`
- produces: import-guide
- consumes: existing:user-docs
- gated-by: D-1, D-3
- acs: AC-3

## Acceptance criteria

| id   | statement                                        | proof                                      | refines/inherits | covers |
| ---- | ------------------------------------------------ | ------------------------------------------ | ---------------- | ------ |
| AC-1 | An uploaded CSV is read row by row.              | test:tests/import-read.test.ts::reads      | —                | R-1    |
| AC-2 | A row that fails validation is reported by line. | test:tests/import-validate.test.ts::report | AC-1             | R-2    |
| AC-3 | The guide explains how to start an import.       | script:test -f docs/user/import.md         | —                | R-3    |

## Open decisions

| id  | question                                   | options                | default     | status                           |
| --- | ------------------------------------------ | ---------------------- | ----------- | -------------------------------- |
| D-1 | Does validation stop at the first bad row? | stop; collect all rows | collect all | open                             |
| D-2 | Is the upload size capped (R-1)?           | 10 MB; no cap          | 10 MB       | open                             |
| D-3 | Is the CSV dialect fixed (R-1)?            | RFC 4180; sniffed      | RFC 4180    | resolved · RFC 4180 · 2026-11-01 |

## Amendments · Deviations

| date | kind | what changed | by  |
| ---- | ---- | ------------ | --- |
