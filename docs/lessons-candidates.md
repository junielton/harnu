# Lesson candidates

One line per pattern seen once that did not clear the bar for a lesson in `docs/lessons/`.
A second occurrence promotes it to a lesson and removes its entry here.

- 2026-11-05 · code-patterns · a default value (the 0.65 helper-split ratio) hardcoded in a second place with a "mirrors the store" comment instead of one exported constant · `src/renderer/src/App.vue` (BUG-247, PR #201)
- 2026-11-05 · security · PowerShell single-quoted strings end at U+2018/U+2019/U+201A/U+201B as well as ASCII `'`, so escaping only `'` in untrusted text built into `Write-Host '...'` is injectable and a typographic apostrophe in static text breaks parsing · `src/main/pty.ts` (buildPowerShellRestoreFailedNotice)
