# Lesson candidates

One line per pattern seen once that did not clear the bar for a lesson in `docs/lessons/`.
A second occurrence promotes it to a lesson and removes its entry here.

- 2026-11-05 · code-patterns · a default value (the 0.65 helper-split ratio) hardcoded in a second place with a "mirrors the store" comment instead of one exported constant · `src/renderer/src/App.vue` (BUG-247, PR #201)
- 2026-11-05 · security · PowerShell single-quoted strings end at U+2018/U+2019/U+201A/U+201B as well as ASCII `'`, so escaping only `'` in untrusted text built into `Write-Host '...'` is injectable and a typographic apostrophe in static text breaks parsing · `src/main/pty.ts` (buildPowerShellRestoreFailedNotice)
- 2026-11-05 · reactivity · a single store ref used as the in-flight indicator of a per-item async action (`shelvedRestoringLabel`) is overwritten and cleared by whichever concurrent action finishes first; key it per item and derive the shared value · `src/renderer/src/stores/sessions.ts` (restoreShelvedWorktree)
- 2026-11-05 · correctness · a "is it unused?" decision built from two non-atomic docker listings (containers, then networks) misses a resource created between the reads; snapshot the resource you may delete first, then the things that could hold it · `src/main/containers/docker-facts-shell.ts` (readEmptyComposeNetworks, PR #218)
- 2026-11-05 · testing · bumping the `docs/harnu-features.md` marker without grepping every test that pins the previous version leaves one pinned test red in CI; `grep -rn "harnu-features v" tests` before the bump · `tests/gc-shelve-docs.test.ts` (PR #225)
- 2026-11-06 · testing · a new error branch (`ARCHIVE_WRITE_FAILED`) added to an MCP handler shipped with only a store-level rejection test, so the handler's own ACK contract (isError, text, no success audit row) was unguarded until review · `src/main/mcp/tool-handlers.ts` (archiveSessionHandler, BUG-254)
- 2026-11-05 · code-patterns · a new phase added to a long skill document restates a rule (cards per chapter, successor verbs, where memory is read) that an older phase of the same document already constrains, so the two contradict · `resources/skills/skills/orchestrate-delivery/SKILL.md` (T652, PR #229)
- 2026-11-06 · docs · an amendment that replaces a behaviour (R-28 staged review) left the older requirement describing it (R-8 "one blind builder-check") untouched, so the spec carried two contradictory rules; grep the old behaviour's wording across the file when you supersede it (`spec.md:44`)
- 2026-11-06 · docs · a range written in prose ("D-9 to D-15") implied an id (D-13) that the table and the change-log never contained; list the ids or check the range against the table (`spec.md:397`)
- 2026-11-06 · docs · changing a hover-only behaviour in a component left `docs/user/sessions.md` still describing the old behaviour; grep `docs/user` for the feature before calling the diff done · `docs/user/sessions.md` (BUG-255, PR #235)
