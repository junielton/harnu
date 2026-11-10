# Pick log — click-keyboardinterrupt-prompt-race (P2, python bug)

## Candidates considered

- pallets/click: #3818 — accepted (setup and suite pass on one core at the pin).
- python-attrs/attrs: not reached (pallets/click was accepted first).
- pallets/itsdangerous: not reached.

## The rule

The pick rule of S-7 in docs/specs/2026-11-07-bakeoff-harness/spec.md: walk the language's fixed candidate list in order, skipping any repository an earlier slot took; in each repository take the pull request with the latest mergedAt before 2026-10-01 (ties go to the higher number) that matches the slot's kind and changes at most 20 non-test files. A bug or feature pull request closes an issue and changes a test file, the issue decides the kind; a refactor has "refactor" in its title or a label. The pin is the first parent of the merge commit, and the pull request's files must equal git diff --name-only <pin> <merge>. The candidate is accepted when setup and the repository's own suite finish under the validation limit on one core; otherwise the walk moves to the next repository.

## Date

2026-11-09

## The one chosen

- Repository: https://github.com/pallets/click
- Pull request: #3818 (https://github.com/pallets/click/pull/3818), merged 2026-08-31T23:42:24Z, "Fix race condition on `KeyboardInterrupt` in `Command.main()`"
- Closing issue: https://github.com/pallets/click/issues/3802
- Pin (first parent of the merge commit): b47c0529e99129d4785fecc2cb39a8ec8b4aa5f8
- Non-test files changed: 3
