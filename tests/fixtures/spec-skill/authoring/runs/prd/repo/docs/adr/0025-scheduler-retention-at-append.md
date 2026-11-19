# 0025 — Scheduler run retention is applied where runs are written

**Status:** proposed (2026-11-07) · **Spec:** `docs/specs/2026-11-07-scheduler-run-retention/spec.md`
· **PRD:** `docs/prds/T902-scheduler-run-retention.md`

## Context

`appendRun` (`src/main/scheduler-store.ts`) appends a run and, past `RUN_RETENTION` runs, rewrites
the worker's `scheduler-runs/<workerId>.jsonl` atomically with the newest 200. Retention by age
(T902) needs a place where old runs are dropped.

## Decision

Retention, by count or by age, is applied only where runs are written: in `appendRun`, and once
when a worker's retention is saved. There is no background sweep.

## Consequences

- One writer per runs file, the existing atomic rewrite; no timer runs without a tick.
- A disabled worker keeps its old runs until it runs again or its retention is edited.
- A failed rewrite leaves the file as it was (`atomicWriteFile`), so a trim can fail without
  losing the run just appended.
