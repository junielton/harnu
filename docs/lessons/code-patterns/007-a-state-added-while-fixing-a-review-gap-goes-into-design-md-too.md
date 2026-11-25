---
status: active
source: own
---

### A state added while fixing a review gap goes into design.md too

**Category:** Code Patterns
**Severity:** Medium

**Rule:** When a review fix changes what a component shows or announces (a new state, a longer accessible name, a new variant), update the matching `design.md` section in the same change, and grep it for the sentence that describes the old behaviour.

**Bad:**

```ts
// 4b50bd2d: the folded checkout's name now also says the session count...
return count ? t('sidebar.tree.railCount', { label, count }, count) : label
// ...while design.md "Group rail" still lists only "needs you" / "failed" / "agent working"
```

**Good:**

```md
<!-- design.md "Group rail", same change -->

Folded, the name goes on to say the session count the row shows
("{branch}, agent working, 2 sessions"), because the name replaces the row's content.
```

**Why:** `design.md` is the contract the next change is built from; a fix made after the first pass is the one that skips it. Seen on PR #398 (a focus state added for a chip inside a row) and again on PR #399.
