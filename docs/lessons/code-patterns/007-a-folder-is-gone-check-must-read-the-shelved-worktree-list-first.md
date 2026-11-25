---
status: active
source: own
---

### A folder-is-gone check must read the shelved worktree list first

**Category:** Code Patterns
**Severity:** High

**Rule:** Any code that closes, drops or refuses something because a folder is missing must first check the shelved list (`src/main/gc/shelve-store.ts`) with `readShelvedForUpdate`; a shelved folder is not gone, and an unreadable list means "unknown".

**Bad:**

```ts
// a missing directory is read as removed for good: the cards of a shelved worktree close
const world = { store, lookup, folder: folderPresence, now }
```

**Good:**

```ts
const presence = shelvedAware(folderPresence, () =>
  readShelvedForUpdate(path.join(userData, SHELVED_FILE))
)
const world = { store, lookup, folder: presence, now }
```

**Why:** Cleanup shelving deletes a worktree folder on purpose after a few idle days and brings it back when one of its sessions is resumed. A bare `stat` closed the pending Your move cards of such sessions, with no way to reopen them (BUG-308, PR #395).
