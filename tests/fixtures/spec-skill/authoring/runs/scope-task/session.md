# Session note — scope-task run

Recorded on 2026-11-07 by the S-4 executor session (card T668), following the `## Medium and up`
procedure of `resources/skills/skills/spec/SKILL.md` on `input.md`. The input was written for this
fixture. Everything the run wrote is under `repo/`.

## Triage

Door: A task / ticket · Tier: Large — card T901 is `standard`, and the report leaves a decision (the `result` column) and a non-goal (runs past the 200 kept) to record.

## Facts

- `memory_query`: the verb is not available in this session (no `harnu` MCP server), so
  `.harnu/memory/decisions.md` was read directly. No decision mentions a Scheduler export, CSV or
  run retention.
- Lessons: `docs/lessons/security/003-confine-renderer-write-and-open-targets.md` (a write IPC pins
  its destination). Applied: AC-5, the IPC writes only to the path the save dialog returned.
- Code: `src/main/scheduler-core.ts` (the `Run` fields: `startedAt`, `durationMs`, `status`,
  `numTurns`, `costUsd`, `tokens`, `result`), `src/main/scheduler-store.ts` (`RUN_RETENTION = 200`,
  trimmed on append), `src/main/scheduler-shell.ts` (the `scheduler:runs` IPC), `src/main/dialog.ts`
  (folder picker only, so S-2 adds the save dialog).

## Decisions

- D-1 (the `result` column) is the one question the facts do not answer. The run had no operator
  to ask it through `harnu:one-by-one`, so the row stays `open` with its default shown (omit it),
  and it gates S-1 only. S-2 does not wait on it.
- The report's second gap is a fact, not a question: runs past the 200 kept no longer exist. It is
  NG-1.

## Atoms

Four acceptance criteria on the card plus the objective's "opens in a spreadsheet as is": five
atoms, R-1 to R-5.

## Check

```console
$ node <skill directory>/scripts/spec-check.mjs docs/specs/2026-11-07-scheduler-runs-csv-export/spec.md
spec-check: docs/specs/2026-11-07-scheduler-runs-csv-export/spec.md is clean
```

Exit 0 on the first run; nothing was fixed.

## Goldfish review

`not run`: the reviewer personas (`agents/`) ship with slice S-9, after this recording.

## Hand-over

The approval question was not asked: a recorded run has no operator. The spec stays `draft`,
and D-1 stays `open`.
