# Lesson candidates

One line per pattern seen once that did not clear the bar for a lesson in `docs/lessons/`.
A second occurrence promotes it to a lesson and removes its entry here.

- 2026-11-05 · code-patterns · a default value (the 0.65 helper-split ratio) hardcoded in a second place with a "mirrors the store" comment instead of one exported constant · `src/renderer/src/App.vue` (BUG-247, PR #201)
- 2026-11-05 · security · PowerShell single-quoted strings end at U+2018/U+2019/U+201A/U+201B as well as ASCII `'`, so escaping only `'` in untrusted text built into `Write-Host '...'` is injectable and a typographic apostrophe in static text breaks parsing · `src/main/pty.ts` (buildPowerShellRestoreFailedNotice)
- 2026-11-05 · reactivity · a single store ref used as the in-flight indicator of a per-item async action (`shelvedRestoringLabel`) is overwritten and cleared by whichever concurrent action finishes first; key it per item and derive the shared value · `src/renderer/src/stores/sessions.ts` (restoreShelvedWorktree)
- 2026-11-06 · testing · a new error branch (`ARCHIVE_WRITE_FAILED`) added to an MCP handler shipped with only a store-level rejection test, so the handler's own ACK contract (isError, text, no success audit row) was unguarded until review · `src/main/mcp/tool-handlers.ts` (archiveSessionHandler, BUG-254)
