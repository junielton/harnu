---
status: draft
tier: complex
prd: docs/prds/T902-scheduler-run-retention.md
adr: docs/adr/0025-scheduler-retention-at-append.md
---

# Scheduler run retention by age

## Problem

Every Scheduler worker keeps its newest 200 runs (`RUN_RETENTION` in `src/main/scheduler-store.ts`),
trimmed by `appendRun` when it appends. On a 5-minute worker that is about 17 hours; on a daily
worker more than six months. Who it is for, the alternatives and what is left out are in the PRD;
where trimming happens is the ADR.

The request, atomized (one atom per requirement of PRD T902):

- R-1 A worker keeps its runs either by count (the newest N, 200 by default, as today) or by age (the runs of the last N days).
- R-2 Changing a worker's retention never deletes a run that the new rule still keeps.
- R-3 A worker saved before this change keeps 200 runs, with no migration step the operator sees.
- R-4 `create_worker` and `update_worker` accept the retention, and `list_workers` reports it.
- R-5 A failed trim never costs a tick: the tick's run is still recorded and the history stays as it was.
- R-6 The worker form does not get a retention field in this delivery.

## Goals

- G-1 The operator can tell a worker "keep a week" through the worker verbs, and the history means a week whatever the cadence.

**Non-goals:**

- NG-1 No retention field in the worker form, and no global retention setting. (R-6)

**Anti-goals:**

- A retention change that deletes a run the operator still meant to keep.

## Slices

### S-1 · Retention rule in the store

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/scheduler-core.ts`, `src/main/scheduler-store.ts`, `tests/scheduler-retention.test.ts`
- produces: run-retention
- consumes: existing:scheduler-runs-store
- acs: AC-1, AC-2, AC-3, AC-4

### S-2 · The worker verbs carry the retention

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/main/mcp/tool-catalog.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/mcp/validate.ts`, `tests/scheduler-retention-verbs.test.ts`, `docs/harnu-features.md`, `docs/user/agent-control.md`, `docs/user/scheduler.md`, `CHANGELOG.md`
- produces: retention-verbs
- consumes: run-retention
- acs: AC-5, AC-6

## Acceptance criteria

| id   | statement                                                                                                                                                                | proof                                                                          | refines/inherits | covers |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------- | ------ |
| AC-1 | A worker's `retention` is `{ by: 'count', n }` or `{ by: 'age', days }`; `appendRun` keeps the newest `n` runs, or the runs that started within the last `days` days.    | test:tests/scheduler-retention.test.ts::keeps by count and by age              | —                | R-1    |
| AC-2 | Saving a new retention trims once, and keeps every run the new rule keeps: a run kept by the new rule is never dropped, whatever the old rule was.                       | test:tests/scheduler-retention.test.ts::a retention change keeps what it keeps | AC-1             | R-2    |
| AC-3 | A worker with no `retention` key reads as `{ by: 'count', n: 200 }`, and loading it writes nothing back.                                                                 | test:tests/scheduler-retention.test.ts::an older worker keeps 200 runs         | AC-1             | R-3    |
| AC-4 | When the trimming rewrite fails, the appended run is still on disk and the file holds every run it held before; the tick reports its run as usual.                       | test:tests/scheduler-retention.test.ts::a failed trim keeps the run            | AC-1             | R-5    |
| AC-5 | `create_worker` and `update_worker` accept `retention` (refusing anything but the two shapes with `BAD_ARGS`), and `list_workers` returns it on every row.               | test:tests/scheduler-retention-verbs.test.ts::the verbs carry the retention    | AC-1             | R-4    |
| AC-6 | `docs/harnu-features.md` documents the field with a marker bump, `docs/user/agent-control.md` and `docs/user/scheduler.md` describe it, and `CHANGELOG.md` has an entry. | record:changelog                                                               | —                | R-4    |

## Open decisions

None open: the PRD settles the rule's shape, and the ADR records where it runs.

| id  | question | options | default | status |
| --- | -------- | ------- | ------- | ------ |
