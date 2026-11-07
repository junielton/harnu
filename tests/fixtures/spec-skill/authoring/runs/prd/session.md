# Session note — PRD run

Recorded on 2026-11-07 by the S-4 executor session (card T668), following the `## Medium and up`
procedure of `resources/skills/skills/spec/SKILL.md` on `input.md`. The input was written for this
fixture. Everything the run wrote is under `repo/`.

## Triage

Door: A task / ticket · Tier: Complex — card T902 is `complex`, and the PRD records an architectural choice (where runs are trimmed).

## Facts

- `memory_query`: the verb is not available in this session (no `harnu` MCP server), so
  `.harnu/memory/decisions.md` was read directly. No decision mentions run retention.
- Lessons: `docs/lessons/code-patterns/005-an-unreadable-store-must-not-be-read-as-empty-by-a-write-or-a-guard.md`.
  Applied: AC-4, a failed trim keeps every run the file held.
- Code: `src/main/scheduler-store.ts` (`RUN_RETENTION = 200`; `appendRun` appends, then rewrites the
  file with `atomicWriteFile` past 200), `src/main/scheduler-core.ts` (the `Worker` and `Run`
  types), `src/main/mcp/tool-catalog.ts` and `src/main/mcp/tool-handlers.ts` (the worker verbs).
  The next free ADR number in `docs/adr/` is 0025.

## Decisions

None asked. The PRD answers the rule's shape (requirement 1), the default for older workers
(requirement 3) and the form (requirement 6); its "Alternatives considered" stays in the PRD. The
choice between trimming at append and a daily sweep is architectural, so it is recorded as ADR
0025 rather than as a D-n.

## The Complex bundle

- PRD: the input was already a PRD, so it was moved to `docs/prds/T902-scheduler-run-retention.md`
  unchanged.
- ADR: `docs/adr/0025-scheduler-retention-at-append.md`, because the spec records an architectural
  decision.
- Mockup: none, and no `mockup:` line: the PRD keeps the worker form out of this delivery (NG-1),
  so the work has no UI.
- Every file of the bundle was added to git before the check, so the header paths are tracked.

## Atoms

Six requirements in the PRD, six atoms R-1 to R-6.

## Check

```console
$ node <skill directory>/scripts/spec-check.mjs docs/specs/2026-11-07-scheduler-run-retention/spec.md
spec-check: docs/specs/2026-11-07-scheduler-run-retention/spec.md is clean
```

Exit 0 on the first run; nothing was fixed.

## Goldfish review

`not run`: the reviewer personas (`agents/`) ship with slice S-9, after this recording.

## Hand-over

The approval question was not asked: a recorded run has no operator. The spec stays `draft`.
