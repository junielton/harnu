# Pick log — ofetch-native-json-parse (P4, typescript refactor)

## Candidates considered

- tj/commander.js: skipped, taken by P3.
- yargs/yargs: #2217 — not accepted: `setup` does not run at the pin (no lockfile; its compile step crashes in typescript's module resolver).
- unjs/ofetch: #520 — accepted. `setup` is pnpm@10.19.0 (the repository's own package manager and lockfile) and the suite passes on one core at the pin. One existing test ("204 no content") asserts the behavior this refactor changes, so `test` deselects it; the merged change updated that test and the reference patch carries non-test files only.

## The rule

The pick rule of S-7 in docs/specs/2026-11-07-bakeoff-harness/spec.md: walk the language's fixed candidate list in order, skipping any repository an earlier slot took; in each repository take the pull request with the latest mergedAt before 2026-10-01 (ties go to the higher number) that matches the slot's kind and changes at most 20 non-test files. A bug or feature pull request closes an issue and changes a test file, the issue decides the kind; a refactor has "refactor" in its title or a label. The pin is the first parent of the merge commit, and the pull request's files must equal git diff --name-only <pin> <merge>. The candidate is accepted when setup and the repository's own suite finish under the validation limit on one core; otherwise the walk moves to the next repository.

## Date

2026-11-09

## The one chosen

- Repository: https://github.com/unjs/ofetch
- Pull request: #520 (https://github.com/unjs/ofetch/pull/520), merged 2025-10-28T11:24:38Z, "refactor!: use native `JSON.parse`"
- Closing issue: none
- Pin (first parent of the merge commit): 6a879d46bdf9f9d4e65b975b91ba3e005e132771
- Non-test files changed: 4
