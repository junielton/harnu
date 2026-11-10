# Pick log — cli-bash-completion-script (P6, go refactor)

## Candidates considered

- spf13/cobra: skipped, taken by P5.
- urfave/cli: #2308 — accepted (setup and suite pass on one core at the pin).
- gorilla/mux: not reached.

## The rule

The pick rule of S-7 in docs/specs/2026-11-07-bakeoff-harness/spec.md: walk the language's fixed candidate list in order, skipping any repository an earlier slot took; in each repository take the pull request with the latest mergedAt before 2026-10-01 (ties go to the higher number) that matches the slot's kind and changes at most 20 non-test files. A bug or feature pull request closes an issue and changes a test file, the issue decides the kind; a refactor has "refactor" in its title or a label. The pin is the first parent of the merge commit, and the pull request's files must equal git diff --name-only <pin> <merge>. The candidate is accepted when setup and the repository's own suite finish under the validation limit on one core; otherwise the walk moves to the next repository.

## Date

2026-11-09

## The one chosen

- Repository: https://github.com/urfave/cli
- Pull request: #2308 (https://github.com/urfave/cli/pull/2308), merged 2026-04-18T18:43:59Z, "refactor: bash completion script"
- Closing issue: none
- Pin (first parent of the merge commit): bc00bd4d77dae229ec7d0cb46b67760e168b28c9
- Non-test files changed: 1
