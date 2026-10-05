# 001-blind-assertion-false-green: an assertion blind to the change is a false green

**Category:** testing (TDD / Vitest)
**Discovered in:** Hook Bridge ECONNREFUSED fix, `801ba8a` (Jun 2026)
**Status:** active

## The bug

While TDD-ing the hook-identity fix, a RED test for "removes our own
sentinel-less entry on exit" **passed on first run** instead of failing. It
asserted `expect(portsPresent(out)).toEqual([])` — but `portsPresent` derives
ports via `hookPort`, the very identity function under repair, which returned
`[]` for sentinel-less handlers _whether or not the entry was actually removed_.
The assertion observed nothing, so it couldn't distinguish a working fix from a
broken one.

## Root cause

The assertion helper routed through the same broken code path the test was meant
to exercise. A test whose observation channel shares the fault is blind to the
behavior it claims to verify — it gives false confidence and will not catch a
regression. Tests written after the implementation never expose this, because
they are shaped to match the code rather than the requirement.

## The fix (and why)

Assert on a signal **independent** of the code under change — here, the raw
handler structure rather than the identity-derived port list:

```ts
// before — blind: portsPresent() can't see a sentinel-less handler at all
expect(portsPresent(out)).toEqual([])
// after — observable regardless of the identity logic being fixed
expect(allHandlers(out)).toEqual([userCmd]) // our entry gone, foreign kept
```

Then confirm the RED test fails _for the expected reason_ before implementing.

## How to detect in reviews

1. For each new/changed test, check whether the assertion's helper shares the
   function-under-test's code path. If it does, require a structure-level or
   otherwise independent assertion.
2. Be suspicious of a "failing test" that passed on its very first run — it is
   testing pre-existing behavior or observing nothing. The TDD step "watch it
   fail for the right reason" exists precisely to catch this.

## Related

- `tests/hook-reconcile.test.ts` — "self-heal survives Claude Code stripping our \_om2tab sentinel"
- `framework/002-cc-strips-settings-hook-keys` — the fix this test covers
- `reactivity/001-stale-comment-rot` — sibling cross-cutting hygiene lesson
