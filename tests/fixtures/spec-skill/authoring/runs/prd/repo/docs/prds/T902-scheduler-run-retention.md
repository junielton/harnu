# T902 — Scheduler run retention by age

**Status:** PRD v1 (2026-11-07) · **Card:** T902 (complexity `complex`)

_Written for this fixture; the card and the feature do not exist in Harnu today._

## 1. Who is this for

The operator who runs a few Scheduler workers on different cadences. A 5-minute worker keeps
about 17 hours of history today; a daily worker keeps more than six months. Neither number was
chosen by anyone.

## 2. The problem

Every worker keeps its newest 200 runs, whatever its cadence. The operator wants to say "keep a
week" and have that mean a week for every worker.

## Requirements

1. A worker keeps its runs either by count (the newest N, 200 by default, as today) or by age (the runs of the last N days).
2. Changing a worker's retention never deletes a run that the new rule still keeps.
3. A worker saved before this change keeps 200 runs, with no migration step the operator sees.
4. `create_worker` and `update_worker` accept the retention, and `list_workers` reports it.
5. A failed trim never costs a tick: the tick's run is still recorded and the history stays as it was.
6. The worker form does not get a retention field in this delivery; it follows once the rule has run for a while.

## Alternatives considered

- **A daily sweep over every worker's file.** Trims a disabled worker's old runs too, but adds a
  second writer to a file `appendRun` already rewrites, and a timer that runs with no tick.
- **Trim where runs are written (chosen).** `appendRun` already reads and rewrites the file when it
  trims; the age rule joins the count rule there, and a retention change trims once at save time.
  A disabled worker's old runs stay until it runs or is edited, which is acceptable.

## Not in this PRD

- A retention field in the worker form (requirement 6).
- A global retention setting across workers.
