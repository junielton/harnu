# Session note — brainstorm run

Recorded on 2026-11-07 by the S-4 executor session (card T668), following the `## Medium and up`
procedure of `resources/skills/skills/spec/SKILL.md` on `input.md`. The input was written for this
fixture. Everything the run wrote is under `repo/`.

## Triage

Door: A vague idea · Tier: Medium — no card yet, and the brainstorm's objective is one feature with nothing to record beyond its ACs.

## Facts

- `memory_query`: the verb is not available in this session (no `harnu` MCP server), so
  `.harnu/memory/decisions.md` was read directly. Found `e-1671c917` (T655: archive state moved to
  a main-owned `archived-sessions.json`) and `e-8cca2974` (BUG-254: archive rows are decided inside
  the store's serialized `transact`, so a batch must go through it).
- Lessons: `docs/lessons/code-patterns/001-new-session-views-must-reuse-all-visibility-filters.md`
  (a new projection over sessions applies every existing filter). Applied: AC-1 reuses
  `planArchiveSession` instead of a second idle rule.
- Code: `src/main/mcp/archive-session-core.ts` (`planArchiveSession` refuses `SESSION_WORKING` and
  `PENDING_APPROVAL`, skips an id already archived), `src/main/session-archive-core.ts` (`transact`
  takes `archive` and `unarchive` lists), `src/renderer/src/components/FolderMenu.vue` (no
  archive action today), `src/preload/index.ts` (the archive IPC takes `sessionIds`).

## Decisions

None asked. The two questions the brainstorm raised were answered there and by the code: "idle"
is what `planArchiveSession` archives, and "the folder" is its exact path (the folder-first model
in `src/renderer/src/stores/sessions.ts`). With nothing to record, the entry stays Medium.

## Atoms

Four requests in "What was asked", four atoms R-1 to R-4, one per sentence.

## Check

```console
$ node <skill directory>/scripts/spec-check.mjs docs/specs/2026-11-07-archive-idle-sessions/spec.md
spec-check: docs/specs/2026-11-07-archive-idle-sessions/spec.md is clean
```

Exit 0 on the first run; nothing was fixed.

## Goldfish review

`not run`: the reviewer personas (`agents/`) ship with slice S-9, after this recording.

## Hand-over

The approval question was not asked: a recorded run has no operator. The spec stays `draft`.
