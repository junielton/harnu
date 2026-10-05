# 003-lossy-slug-folder-resolution: never resolve a folder by decoding a slug

**Category:** synthetic-sessions
**Discovered in:** dogfooding, 2026-06-17 — duplicated "New session" rows
**Status:** fixed (primary cause + the "known limitation" + follow-up 1, all
2026-06-24); follow-up 2 (collapser unification) still deferred (see below)

## The bug

A synthetic **"New session"** row stayed in the sidebar _next to_ the real
session it should have become. The two rows showed the **same conversation**,
and running `/clear` in one cleared **both**. The real row carried its title;
the ghost still said "New session".

Reproduced 100% in any folder whose path contains a literal `-`
(`TASK-1234-feature-alpha`, `TASK-0084-ci-setup`).

## Root cause

The watcher emits slug-keyed events (`~/.claude/projects/<slug>/`). The renderer
mapped slug→path with `decodeSlugToPath`, which replaces **every** `-` with `/`.
That is lossy:

|                          | value                                                          |
| ------------------------ | -------------------------------------------------------------- |
| slug on disk             | `…-Workspace-example-client-worktrees-TASK-1234-feature-alpha` |
| `decodeSlugToPath` →     | `…/worktrees/`**`TASK/1234/feature/alpha`**                    |
| real `cwd` (folder.path) | `…/worktrees/`**`TASK-1234-feature-alpha`**                    |

So `findFolderBySlugOrPath(slug)` returned `null`, and `reconcileSessionAdded`
bailed to a plain `reloadModel()`:

```ts
const folder = findFolderBySlugOrPath(slug)
if (!folder) {
  await reloadModel()
  return
} // ← always hit for dash-folders
```

`reloadModel()` re-injects the in-memory synthetic **and** surfaces the real
session from disk → two rows. `fireMigrate` never runs, so the synthetic's live
`claude` process keeps writing session `R` while the real row does
`claude --resume R` — both talk to `R` on disk (synced content; `/clear` hits
both).

## The fix (and why)

`SessionEntry.fullPath` is `…/.claude/projects/<slug>/<id>.jsonl`, and every
session in a folder shares one slug (one `cwd` → one slug dir). So the slug is
recoverable **losslessly** from any real session's path — no decoding needed.

`src/renderer/src/lib/folder-slug.ts`:

- `slugFromSessionPath(fullPath)` — the parent-dir name of the JSONL.
- `resolveFolderPathBySlug(slug, folders)` — lossless-first (match a folder
  owning a session under `<slug>/`), with `decodeSlugToPath` kept only as a
  last-resort fallback (dash-free folders with no real session yet).

`findFolderBySlugOrPath` now delegates to `resolveFolderPathBySlug`, which fixed
every slug-keyed handler at once (`reconcileSessionAdded`, `onSessionRemoved`,
`onSessionUpdated`/`promoteSyntheticForRealId`, and `onProjectRemoved` — the
last one previously decoded inline, so dash-folders never got removed either).

Tests: `tests/folder-slug.test.ts` pins the lossy decode, the lossless
extraction, and the resolver (including the dash-folder regression).

## Known limitation — FIXED 2026-06-24

A **brand-new** dash-folder whose _only_ session is the synthetic placeholder
(`fullPath === ''`) used to be unresolvable by slug until a real JSONL landed.

**Fix:** a faithful **forward** encoder, `encodePathToSlug(path)`, mirrors
Claude's exact slug rule — _every non-alphanumeric character → `-`_ (confirmed
empirically against all 49 real `~/.claude/projects/` dirs: `/`, `.`, `@` and
space each map to `-`, case preserved). `resolveFolderPathBySlug` now matches a
candidate folder by encoding its own path forward (lossless) instead of trying
to reverse the lossy slug, so the synthetic migrates in place. This also clears
the secondary symptom where the stuck synthetic blocked `createNewSession`'s
"one synthetic per folder" dedupe from making a fresh one.

## Deferred follow-ups

1. **Unguarded concurrent `reloadModel()` — FIXED 2026-06-24.** For one new
   session the watcher fires `session:added` + `session:updated` +
   `index:updated` within ~150 ms; each calls the async `reloadModel()`, which
   re-injects a _snapshot_ of synthetics taken before its disk `await`. A row
   removed/collapsed during that await (an in-place migrate, a collapse, or an
   explicit `closeSession`) could be resurrected by the stale snapshot — a
   timing-dependent duplicate. **Fix:** `reloadModelOnce` now re-injects a
   snapshotted synthetic only if it is still present in the live `folders.value`
   at commit time (read _after_ the await). A migrated row keeps its object
   identity under its new real id, so it survives; a removed row stays removed.
2. **Three overlapping collapse mechanisms** with inconsistent match keys —
   `reconcileSessionAdded` (by slug→folder), `promoteSyntheticForRealId`
   (by `/rename` event), `collapseResolvedSynthetics` (by creation-time
   proximity). Candidate refactor: one idempotent collapser keyed on the real
   `sessionId`, resolving the folder post-reload via the real session's
   `projectPath` (slug-free).
