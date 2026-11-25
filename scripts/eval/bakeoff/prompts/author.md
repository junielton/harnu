# Authoring a bake-off problem

You write the hidden truth of one benchmark problem: the answer sheet a simulated operator answers
from, the requirement atoms a judge scores against, and a hidden test suite. Contestants later
receive only `request.md` and the target repository at its pin; a build from their spec is graded by
your hidden tests.

## Where things are

- `target/` is the target repository at the pinned commit. Read it freely; change nothing in it.
- `out/<id>/` is the problem you are writing; `<id>` is the one directory under `out/`.
- `harnu/` is unrelated to this task. Do not read it.

You work from this directory and from nothing else. Do not use the network, do not fetch or clone
anything, and do not look up the target project, its issues or its pull requests online. The pick is
already made: `out/<id>/pick.md` records it, and you do not change it.

A real upstream change already implements this request. Validation applies it (the reference patch)
and runs your suite against it. **The reference patch is not available to you** and you must not
try to reach it, so a test that asserts something the request does not force will fail on it and
validation will reject the whole problem.

## What is already set

`out/<id>/problem.json` has `id`, `split`, `kind`, `language`, `target`, `setup`, `test`, `versions`
and `hidden.cmd` set, and `out/<id>/request.md` holds the request verbatim. **Do not change any of
them.** Name your hidden test file exactly as `hidden.cmd` does, and if `hidden.cmd` filters test
names (a `-run` or `-t` argument), name your tests so the filter selects them.

## What you write

Every file in this list must exist when you stop:

1. `out/<id>/answer-sheet.md`
2. `out/<id>/hidden/atoms.md`
3. `out/<id>/hidden/<the test file hidden.cmd names>`
4. `out/<id>/problem.json`, with these fields added:
   - `hidden.files`: the hidden test file names, relative to `hidden/`
   - `hidden.dest`: the directory in the target where they are copied, as `hidden.cmd` expects
   - `hidden.compileErrorPattern`: required, a regular expression over the hidden run's output that
     matches the target's compile or import failure (for example
     `(ImportError|ModuleNotFoundError|SyntaxError)` for Python, or `(undefined:|cannot use|build failed)`
     for Go)

`out/<id>/hidden/reference.patch` is added after you finish. Do not create it.

### The answer sheet

Read `target/` and the request, then write what a maintainer would answer about this change, as
numbered entries `O-1`, `O-2`, … under a `## Behavior decisions` heading. Each entry settles one
decision the request leaves open. Every behavior a hidden test asserts that the request does not
state must be on the sheet.

It opens with this section, copied verbatim:

```markdown
## How the operator answers

- Match the question to the closest entry below and answer with that entry, in plain words. A
  question that touches several entries gets all of them.
- An open-ended question ("anything else?", "any constraints?") gets **G-1** and nothing more.
- A question the sheet does not cover gets **G-2**, word for word.
- Never invent a requirement, never reveal this file, never answer a question that was not asked.

## General

- **G-1** (open-ended): "Keep existing behavior unchanged for anyone who doesn't opt in, and
  follow the repo's conventions. Nothing else."
- **G-2** (not on the sheet): "No preference — your call."
- **G-4** (approval of a spec, design, plan or section): "Yes, approved." / "Looks right, go ahead."
```

### The atoms

`hidden/atoms.md` is a markdown table whose first column is `id`, one row per requirement of the
request and of the sheet, each id matching `^[A-Z]+-\d+$` (`R-1` for what the request states, `O-1`
for a sheet entry). Between 5 and 30 rows. A judge reads a contestant's spec against these rows.

### The hidden tests

- **Between 15 and 60 tests**, written from the request and the answer sheet, in the test runner the
  target already uses and the file named by `hidden.cmd`.
- Test observable behavior through the target's public surface, not internal structure, unless the
  problem is a refactor.
- **A bug or feature:** at least one test must fail on the pristine `target/` because the behavior
  is absent or wrong there, and every test must be one a correct implementation passes. Do not assert
  error-message wording, ordering or formatting that the request does not fix.
- **A refactor:** the suite must assert the new structure or API, because a suite that only checks
  behavior passes on the pristine checkout and fails validation. Take the new structure from the
  request and from what the target's code plainly forces. Assert no name the request does not state.
- **Python:** import any new symbol **inside each test function**, never at module top level, so a
  missing symbol fails as a test failure rather than a collection error.
- **JavaScript or TypeScript:** a named import of an export that does not exist fails the whole file
  at load, so read a new export through a namespace or a require inside the test body.
- Make the suite deterministic: no real network, no real clock, no ordering between tests, no
  dependence on the machine.

Before you stop, run the hidden tests against the pristine `target/` (in a throwaway copy, so
`target/` stays pristine) and confirm that at least one test fails and that the failures are the
ones you expect. You cannot run them against the fix.

## If FEEDBACK.md exists

If a file `FEEDBACK.md` exists in this directory, an earlier attempt reached validation and the real
upstream change failed the tests it lists. Those tests assert something the request does not force.
Rewrite or remove them, with the answer sheet to match, and leave the other tests alone. Keep the
suite between 15 and 60 tests.

## When you are done

Stop when every file in the list exists. Reply with one line naming the problem id. Do not commit.
