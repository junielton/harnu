---
status: active
source: own
---

### An unreadable store must not be read as empty by a write or a guard

**Category:** Code Patterns
**Severity:** High

**Rule:** A read that maps every failure to "empty" must never feed a write or a safety guard; treat only a missing file as empty (first run), throw on anything else, and make the guard refuse.

**Bad:**

```ts
// readShelved returns an empty store on ANY error, a corrupt or newer-version file included
const shelved = new Map((await readShelved(file)).entries.map((e) => [e.namespace, e]))
await deleteConfirmedArchives(req, neverClean, undefined, shelved) // corrupt store -> nothing is "shelved" -> archives deleted
```

**Good:**

```ts
const store = await readShelvedForUpdate(file).catch((err) => {
  throw new Error(
    `Archives were left alone: the list of shelved worktrees cannot be read (${err.message}).`
  )
})
```

**Why:** "I could not read the list" is not "the list is empty": as a write base it drops the other records, and as a guard it decides nothing is protected and deletes the only copy of the work. Seen twice in the shelved store (the executor's write in T641, the archive-delete guard in T642).
