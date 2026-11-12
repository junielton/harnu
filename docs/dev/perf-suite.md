# The scale-fixture perf suite and the stall monitor (T697)

A keystroke and its echo cross two JavaScript threads. Anything that holds either one for more than
50 ms freezes typing in every session, and the bugs that did it (BUG-117, BUG-240, BUG-261) were all
correct, tested features whose cost only showed at real scale. Two guards exist so the next one is
named by the app and stopped by CI.

## The in-app stall monitor

- **Main thread** (`src/main/monitor/stall-*.ts`, `loop-probe.ts`): a 50 ms heartbeat turns each slice into
  a busy time (the larger of the thread's own CPU time, `process.threadCpuUsage()`, and the tick's lateness),
  and a busy run of 50 ms or more is a stall (one long task, or a flood of short ones that never lets the loop
  idle). `performance.eventLoopUtilization()` is NOT usable: inside Electron's main process it reads 0 forever
  (verified live). A computing task is measured exactly; a task that only blocks (a sync wait on a child
  process) to within one period. Owners come from `withOwner` (every IPC handler and `setInterval` callback is
  wrapped at startup; the innermost owner wins), and a watchdog worker samples the stack of a stall nobody owns
  (inspector `Debugger.pause` from a worker thread, resumed at once, kept only if the same task is still
  running).
- **Renderer** (`src/renderer/src/lib/stall-observer.ts`): a `longtask` observer (exact) plus a 25 ms
  heartbeat. The heartbeat is needed because the Long Tasks API does not report tasks Electron starts from an
  IPC message (verified live: a 300 ms block inside an `ipcRenderer` callback never shows up), and those are
  the fleet updates pushed by main. A late tick that no observer entry covers is reported after 400 ms.
  Owners are Pinia actions (`store:<id>.<action>`, synchronous part), component render functions
  (`component:<Name>`, where a computed that reads the fleet is evaluated) and the preload's timed IPC event
  callbacks (`event:<channel>`, asked through `monitorOwnerHint`).
- One aggregate and one log (`stalls.jsonl`, 1 MiB + one previous generation, 24 h) live in main. The
  System Monitor's Responsiveness section reads the aggregate from `monitor:sample`.
- Pure decisions are in `src/shared/stall-core.ts` (shared by both threads and unit tested).
- `HARNU_STALL_MONITOR=off` disables everything. `HARNU_STALL_INJECT=1` lets `window.api.monitorInjectStall('main' | 'renderer', ms)` block a thread on purpose (used for the demo and for live verification).
- Overhead is measured in `tests/perf/monitor-overhead.perf.ts` (idle main thread, IPC wrapper per call,
  Pinia action wrapper per call) and live in Electron (see the T697 report: about +0.6% of the main thread and
  +0.6% of the renderer thread, idle). A wake-up of the loop is the cost, not the callback, which is why the
  heartbeats are slow.

## The suite

```bash
npm run test:perf                 # ~30 s, one fork, nothing else running in it
PERF_STRICT=1 npm run test:perf   # ignores KNOWN_OFFENDERS: the red run
```

`tests/perf/cases.ts` lists every periodic main-process job and fleet-wide renderer computed that is
measured. Each case runs the real function against a generated fleet (`support/scale-fixture.ts`: 1,000
slugs, 10,000 transcripts, 2,000 known sessions, 60 worktrees, 50 open missions, 15 live sessions, built in
a temp dir) at 0.25x and 1x, and fails on:

- a busy run over 50 ms (the probe above, the same definition as the app's);
- more than 250 ms of CPU in one run;
- a run that does not finish within the deadline;
- cost, or filesystem calls (counted exactly, `support/fs-counter.ts`), growing more than 1.5x faster than
  the fixture between the two sizes (the loop-inside-a-loop shape, P4).

`tests/perf/timer-coverage.perf.ts` keeps the list honest: every `setInterval` in `src/main` is either
covered by a case or listed with the reason it is not yet. A new timer fails it until you decide.

### Adding a job

1. Add a `PerfCase` to `cases.ts` that runs the real function with fakes only for what is not its own
   cost. Take `ctx.expired()` into account in any injected function that does real I/O, so a regressed
   job is cut off instead of making CI slow.
2. If the job is a timer in `src/main`, move its file from `UNCOVERED` to `COVERED` in `timer-coverage.perf.ts`.

### Known offenders

`tests/perf/support/known-offenders.ts` names the cases that violate the contract today and the bug that
fixes each. A listed case reports instead of failing, and fails the moment it stops violating: the fix PR
deletes its line. Run with `PERF_STRICT=1` to see them fail.
