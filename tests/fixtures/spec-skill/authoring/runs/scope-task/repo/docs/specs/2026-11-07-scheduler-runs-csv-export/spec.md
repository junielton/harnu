---
status: draft
tier: large
---

# Export a Scheduler worker's run history as CSV

## Problem

The Scheduler shows a worker's runs one by one in the worker detail, and nothing gets them out:
to see what a worker costs over a week the operator reads rows by hand. The runs are already on
disk (`scheduler-runs/<workerId>.jsonl`, the `Run` type in `src/main/scheduler-core.ts`) and read
by the `scheduler:runs` IPC; only the newest 200 per worker are kept (`RUN_RETENTION` in
`src/main/scheduler-store.ts`), and the main process has no save dialog (`src/main/dialog.ts`
opens folders only).

The request, atomized (one atom per sentence of card T901 and its scope-task report):

- R-1 The worker detail has an "Export runs (CSV)" action.
- R-2 The file has one row per kept run with its start time, duration, status, turns, cost and tokens.
- R-3 The operator picks where the file is saved.
- R-4 An empty history exports a file with the header row only.
- R-5 The file opens in a spreadsheet as is.

## Goals

- G-1 From a worker's detail, the operator gets its kept run history into a spreadsheet with one action and one save dialog.

**Non-goals:**

- NG-1 No export of runs older than the 200 a worker keeps: the store drops them, and this spec does not change retention. (R-2)
- NG-2 No export of several workers at once, and no export through an MCP verb. (R-1)

**Anti-goals:**

- An export that writes anywhere but the path the operator chose in the dialog.

## Slices

### S-1 · CSV writer for a worker's runs

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/scheduler-csv.ts`, `tests/scheduler-csv.test.ts`
- produces: runs-csv
- consumes: existing:scheduler-run-type
- gated-by: D-1
- acs: AC-1, AC-2, AC-3

### S-2 · Export action, save dialog and IPC

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/main/scheduler-shell.ts`, `src/main/dialog.ts`, `src/preload/index.ts`, `src/renderer/src/components/SchedulerWorkerDetail.vue`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `tests/scheduler-export-ipc.test.ts`, `docs/user/scheduler.md`, `CHANGELOG.md`
- produces: runs-export
- consumes: runs-csv, existing:scheduler-runs-ipc
- acs: AC-4, AC-5, AC-6

## Acceptance criteria

| id   | statement                                                                                                                                                                                                                                        | proof                                                                    | refines/inherits | covers   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------- | -------- |
| AC-1 | `runsToCsv(runs)` returns a header line and one line per run in stored order, with the columns `started_at` (ISO 8601, UTC), `duration_ms`, `status`, `turns`, `cost_usd`, `tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_write`. | test:tests/scheduler-csv.test.ts::one row per run with the fixed columns | —                | R-2      |
| AC-2 | Lines end in CRLF and a field holding a comma, a double quote or a line break is quoted as RFC 4180 says, so a spreadsheet opens the file without an import step.                                                                                | test:tests/scheduler-csv.test.ts::quotes fields as rfc 4180              | AC-1             | R-5      |
| AC-3 | An empty run list yields the header line only.                                                                                                                                                                                                   | test:tests/scheduler-csv.test.ts::empty history is the header only       | AC-1             | R-4      |
| AC-4 | The worker detail shows "Export runs (CSV)"; choosing it opens a save dialog whose default name is `<worker name>-runs.csv`.                                                                                                                     | test:tests/scheduler-export-ipc.test.ts::the action opens a save dialog  | —                | R-1, R-3 |
| AC-5 | The IPC writes only to the path the save dialog returned; a cancelled dialog writes nothing and reports nothing as an error.                                                                                                                     | test:tests/scheduler-export-ipc.test.ts::writes only to the chosen path  | AC-4             | R-3      |
| AC-6 | `CHANGELOG.md` has a dated entry and `docs/user/scheduler.md` describes the export and its columns.                                                                                                                                              | record:changelog                                                         | —                | —        |

## Open decisions

| id  | question                                                | options                                                  | default                                                                  | status |
| --- | ------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ | ------ |
| D-1 | Does each row carry the run's free-text `result` (R-2)? | omit it; include it, quoted; include its first line only | omit it: the text is whatever the model wrote, and the file leaves Harnu | open   |
