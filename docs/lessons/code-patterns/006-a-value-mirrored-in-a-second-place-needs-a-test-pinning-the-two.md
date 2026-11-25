---
status: active
source: own
---

# A value copied into a second place, with a "mirrors X" comment, must be pinned by a test

**Category:** code-patterns (duplicated constants)
**Severity:** Medium
**Discovered in:** PR #201 (the helper-split ratio, BUG-247) and PR #375 (the agent-pane cap, browser-tabs S-4)

**Rule:** When a value must exist in a second place because the second place cannot import the first (renderer vs main, shared vs generated), export it once or add a test that fails if the two differ; a "mirrors X" comment alone is not a pin.

**Bad:**

```ts
// src/renderer/src/lib/browser-tabs-view.ts
/** How many agent panes a folder may hold (`MAX_AGENT_PANES_PER_FOLDER` in main's registry). */
export const MAX_AGENT_PANES = 4
```

**Good:**

```ts
// tests/browser-pane-limit.test.ts
import { MAX_AGENT_PANES_PER_FOLDER } from '../src/main/browser/registry'
import { MAX_AGENT_PANES } from '../src/renderer/src/lib/browser-tabs-view'

it('is the same number the renderer greys "Move to a new pane" at', () => {
  expect(MAX_AGENT_PANES).toBe(MAX_AGENT_PANES_PER_FOLDER)
})
```

**Why:** The comment is read by nobody when the main constant changes, so the renderer silently keeps the old number (here: the menu would offer "Move to a new pane" that main then refuses with `PANE_LIMIT`). The test turns the drift into a failing build; a shared module under `src/shared/` is better still when both sides can import it.
