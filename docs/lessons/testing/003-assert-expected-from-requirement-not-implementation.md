# 003-assert-expected-from-requirement-not-implementation: derive the expected value from the spec, not from what the code does

**Category:** testing (oracle / expected-value derivation)
**Discovered in:** Fleet board "live sessions show idle" investigation (Jun 2026)
**Status:** active

## The bug

`classifyBoardState` mis-classified a live session (`taskState: 'idle'`,
`status: 'active'`) as `idle` when the requirement — "mirror the sidebar dot",
which shows it as **working** — said it should be `working`. The unit test had a
case asserting exactly:

```ts
expect(classifyBoardState({ taskState: 'idle', status: 'active' })).toBe('idle') // ✅ green, but WRONG
```

The test passed and gave false confidence, because the expected value `'idle'`
was copied from what the (buggy) implementation returned, not from the
requirement (`dotFor` returns `'working'` for that input). A green suite shipped
a user-visible bug.

## Root cause

The test's **oracle** (its notion of the correct answer) was derived from the
implementation under test instead of from the source of truth. Tests written by
reading the code's output and "locking it in" can only catch _regressions away
from current behavior_ — they can never catch the current behavior being wrong.
This is distinct from `testing/001` (where the assertion _channel_ was blind);
here the channel works fine, but the expected value itself encodes the bug.

## The fix (and why)

Anchor each expected value to an independent authority — the spec, the
requirement, or (for a "mirror X" function) **X's actual output** — not to a
hand-typed guess of what the code probably returns:

```ts
// the requirement is "agree with dotFor"; assert against dotFor's answer
for (const c of cases)
  expect(boardWorkingOrIdle(classifyBoardState(c))).toBe(
    dotIsWorking(dotFor(c.taskState, c.status)) ? 'working' : 'idle'
  )
```

## How to detect in reviews

1. A test whose expected literal matches the implementation but contradicts the
   stated requirement / a sibling function it's meant to mirror. Re-derive the
   expected value from the spec and see if the assertion flips.
2. "Mirror / parity" functions deserve a **cross-check test** that asserts
   against the source function's output over shared inputs, not independent
   hand-written expectations for each.
3. Suspicion trigger: a brand-new test that passes on the very first run while
   TDD-ing a behavior change — verify it actually fails against the old code.

## Related

- `tests/fleet-board.test.ts` (the `taskState:'idle', status:'active'` case)
- `code-patterns/003-derived-classifier-must-mirror-its-canonical-source` — the bug this codified
- `testing/001-blind-assertion-false-green` — sibling false-green class (blind channel vs wrong oracle)
