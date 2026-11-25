# Pick log — commander-hook-process-env (P3, typescript feature)

## Candidates considered

- tj/commander.js: #1763 — accepted (setup and suite pass on one core at the pin).
- yargs/yargs: not reached (tj/commander.js was accepted first).
- unjs/ofetch: not reached.

## The rule

The pick rule of S-7 in docs/specs/2026-11-07-bakeoff-harness/spec.md: walk the language's fixed candidate list in order, skipping any repository an earlier slot took; in each repository take the pull request with the latest mergedAt before 2026-10-01 (ties go to the higher number) that matches the slot's kind and changes at most 20 non-test files. A bug or feature pull request closes an issue and changes a test file, the issue decides the kind; a refactor has "refactor" in its title or a label. The pin is the first parent of the merge commit, and the pull request's files must equal git diff --name-only <pin> <merge>. The candidate is accepted when setup and the repository's own suite finish under the validation limit on one core; otherwise the walk moves to the next repository.

## Date

2026-11-09

## The one chosen

- Repository: https://github.com/tj/commander.js
- Pull request: #1763 (https://github.com/tj/commander.js/pull/1763), merged 2022-07-12T06:41:50Z, "feat: add preSubcommand hook"
- Closing issue: https://github.com/tj/commander.js/issues/1762
- Pin (first parent of the merge commit): 3ae30a291a777ad1f748d86f49903579277f9ea0
- Non-test files changed: 6
