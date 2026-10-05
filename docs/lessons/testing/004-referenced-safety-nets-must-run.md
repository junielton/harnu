# 004-referenced-safety-nets-must-run: a control you cite but never execute is false assurance

**Category:** testing
**Discovered in:** OSS-readiness audit, `feat/capy-mcp-server` (Jun 2026)
**Status:** active

## The bug class

A "safety net" is referenced as the reason to skip coverage elsewhere, but the net
is never actually wired to run:

1. **Coverage/mutation gate (ADR-0001).** The ADR documents a coverage + mutation
   gate as the justification for excluding hard-to-unit-test glue (pty, watcher,
   `.vue`). But `vitest.config.mts` sets **no `coverage.thresholds`** and Stryker
   isn't installed or scripted — so nothing fails when coverage drops. The gate is
   documented, not enforced.
2. **E2E suite that doesn't run.** `tests/e2e/*.spec.ts` exists, but only
   `playwright-core` is installed (no `@playwright/test`), there is no `e2e`
   script, and the vitest `include` is `*.test.ts` (which **excludes** `.spec.ts`).
   The specs are dead weight; the "end-to-end safety net" the ADR leans on is hollow.

## Root cause

Writing the _intent_ (an ADR, spec files) without wiring the _executor_
(thresholds, a runner, a CI step). A green local `vitest run` says nothing about a
path that is excluded or a suite that never loads. This is the structural sibling
of `testing/001` (an assertion that can't observe the bug) and `testing/003`
(asserting the implementation, not the requirement): the test/gate exists but
proves nothing.

## The fix (and why)

- **Enforce or downgrade.** Either set `coverage.thresholds` and add the mutation
  step to CI, or relabel the ADR as aspirational and stop citing it as coverage.
- **Run the e2e or delete it.** Add `@playwright/test` + a config + an `e2e` npm
  script and run a smoke test in CI; otherwise delete the `.spec.ts` files and
  update the ADR. Never reference a control that does not execute.
- A gate only counts when a **CI job fails** without it. Until then it is a comment.

## How to detect in reviews

1. Any ADR/spec/comment that claims a gate as the reason to skip tests — confirm a
   CI job actually runs and fails on it.
2. `*.spec.ts` or an `e2e/` dir — confirm a runner, an npm script, and a CI step
   exist, and that the test `include`/`exclude` globs actually pick the files up.
3. Any `coverage` config without `thresholds` → coverage is reported, not gated.

## Related

- `docs/adr/0001-coverage-as-reliable-regression-gate-for-agent-written-code.md`
- `vitest.config.mts`, `tests/e2e/`
- `testing/001-blind-assertion-false-green`, `testing/003-assert-expected-from-requirement-not-implementation`
