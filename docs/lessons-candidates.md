# Lesson candidates

One line per pattern seen once that did not clear the bar for a lesson in `docs/lessons/`.
A second occurrence promotes it to a lesson and removes its entry here.

- 2026-11-05 · code-patterns · a default value (the 0.65 helper-split ratio) hardcoded in a second place with a "mirrors the store" comment instead of one exported constant · `src/renderer/src/App.vue` (BUG-247, PR #201)
- 2026-11-05 · security · PowerShell single-quoted strings end at U+2018/U+2019/U+201A/U+201B as well as ASCII `'`, so escaping only `'` in untrusted text built into `Write-Host '...'` is injectable and a typographic apostrophe in static text breaks parsing · `src/main/pty.ts` (buildPowerShellRestoreFailedNotice)
- 2026-11-05 · reactivity · a single store ref used as the in-flight indicator of a per-item async action (`shelvedRestoringLabel`) is overwritten and cleared by whichever concurrent action finishes first; key it per item and derive the shared value · `src/renderer/src/stores/sessions.ts` (restoreShelvedWorktree)
- 2026-11-05 · correctness · a "is it unused?" decision built from two non-atomic docker listings (containers, then networks) misses a resource created between the reads; snapshot the resource you may delete first, then the things that could hold it · `src/main/containers/docker-facts-shell.ts` (readEmptyComposeNetworks, PR #218)
- 2026-11-05 · testing · bumping the `docs/harnu-features.md` marker without grepping every test that pins the previous version leaves one pinned test red in CI; `grep -rn "harnu-features v" tests` before the bump · `tests/gc-shelve-docs.test.ts` (PR #225)
