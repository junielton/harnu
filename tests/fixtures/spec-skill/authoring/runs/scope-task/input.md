# Scope-task report — T901 · Export a Scheduler worker's run history as CSV

_The report `scope-task` wrote on the card, as it reached `/harnu:spec`. Written for this
fixture; the card and the feature do not exist in Harnu today. Card complexity: `standard`._

## Objective

The operator wants a worker's run history in a spreadsheet, to see what a worker costs over a
week. The file must open in a spreadsheet as is.

## Acceptance criteria

- [ ] AC-1 The worker detail has an "Export runs (CSV)" action.
- [ ] AC-2 The file has one row per kept run with its start time, duration, status, turns, cost and tokens.
- [ ] AC-3 The operator picks where the file is saved.
- [ ] AC-4 An empty history exports a file with the header row only.

## What exists

- Runs are stored per worker in `scheduler-runs/<workerId>.jsonl` and read by the
  `scheduler:runs` IPC (`src/main/scheduler-shell.ts`). The `Run` type is in
  `src/main/scheduler-core.ts`.
- Only the newest 200 runs per worker are kept (`RUN_RETENTION`, `src/main/scheduler-store.ts`).
- `src/main/dialog.ts` opens folders only; no save dialog exists in the main process.

## Gaps and open questions

- Each run carries a free-text `result` the model wrote. Should it be in the file? Not answered.
- AC-2 cannot reach runs older than the 200 kept; they are gone.
