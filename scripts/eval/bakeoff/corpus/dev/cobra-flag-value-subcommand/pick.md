# Pick log — cobra-flag-value-subcommand (P5, go bug)

## Candidates considered

- spf13/cobra: #1781 — accepted (setup and suite pass on one core at the pin).
- urfave/cli: not reached (spf13/cobra was accepted first).
- gorilla/mux: not reached.

## The rule

The pick rule of S-7 in docs/specs/2026-11-07-bakeoff-harness/spec.md: walk the language's fixed candidate list in order, skipping any repository an earlier slot took; in each repository take the pull request with the latest mergedAt before 2026-10-01 (ties go to the higher number) that matches the slot's kind and changes at most 20 non-test files. A bug or feature pull request closes an issue and changes a test file, the issue decides the kind; a refactor has "refactor" in its title or a label. The pin is the first parent of the merge commit, and the pull request's files must equal git diff --name-only <pin> <merge>. The candidate is accepted when setup and the repository's own suite finish under the validation limit on one core; otherwise the walk moves to the next repository.

## Date

2026-11-09

## The one chosen

- Repository: https://github.com/spf13/cobra
- Pull request: #1781 (https://github.com/spf13/cobra/pull/1781), merged 2022-11-08T04:12:02Z, "fix: don't remove flag value that matches subcommand name"
- Closing issue: https://github.com/spf13/cobra/issues/1777
- Pin (first parent of the merge commit): cc7e235fc26cfd0b5ae36c960f399eea4badaa3e
- Non-test files changed: 1
