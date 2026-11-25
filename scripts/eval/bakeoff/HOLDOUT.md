# The private holdout corpus

This file is the README of the private holdout repository of the bake-off harness (see
`docs/specs/2026-11-07-bakeoff-harness/spec.md`, rule 3). Copy it to the root of that repository.
The holdout confirms a skill version on problems the skill has never been tuned against, so nothing
in this repository ever reaches the public one, and no session tuning the skill is given its path.

## Layout

```text
<holdout clone>/
  README.md          this file
  .gitignore         holds one line: .rounds/
  <problem id>/      one directory per problem, same format as the dev corpus
    problem.json     split is "holdout"; provenance.sandbox is true
    pick.md
    request.md
    answer-sheet.md
    hidden/atoms.md
    hidden/<test files>
    hidden/reference.patch
  .rounds/           gitignored: authoring sandboxes and private round data
```

`.rounds/` holds `authoring/<id>/` (the sandboxes and each problem's `<id>.pick.md` and
`<id>.reference.patch`), `<round-id>/problems.json`, `<round-id>/labels.json` and `usage.json`.

## Setup

Clone this repository **outside the harness repository** (the harness refuses a clone inside it
with `HOLDOUT_INSIDE_REPO`), then point the harness at it. The variable is absolute:

```bash
git clone <private url> ~/holdout/bakeoff-holdout
export HARNU_BAKEOFF_HOLDOUT="$HOME/holdout/bakeoff-holdout"
```

Set `HARNU_BAKEOFF_HOLDOUT` only in the shell that runs a holdout round or authors a holdout problem.

## The three slots

| slot | language   | kind     |
| ---- | ---------- | -------- |
| H-a  | python     | bug      |
| H-b  | typescript | feature  |
| H-c  | go         | refactor |

Pick each one by the rule of the spec's S-7 (a merged pull request of a public repository that the
dev corpus does not use), and record the candidates in `.rounds/authoring/<id>.pick.md`.

## Authoring a problem

Write the pick to `.rounds/authoring/<id>.pick.md` and the reference patch, the diff of the non-test
files of the merged change, to `.rounds/authoring/<id>.reference.patch`. Both stay outside the
sandbox directory. Then:

```bash
npm run eval:bakeoff -- author-sandbox <id> --split holdout --repo <url> --commit <pin> \
  --pick "$HARNU_BAKEOFF_HOLDOUT/.rounds/authoring/<id>.pick.md"
```

Before the session, write `setup`, `test`, `versions`, `hidden.cmd`, `kind` and `language` into the
sandbox's `out/<id>/problem.json`, and the closed issue's title and body into `out/<id>/request.md`.
Run the command `author-sandbox` printed, from the sandbox directory. The operator runs holdout
authoring sessions. When the session has finished:

```bash
npm run eval:bakeoff -- author-import <id> --split holdout \
  --reference "$HARNU_BAKEOFF_HOLDOUT/.rounds/authoring/<id>.reference.patch"
```

`author-import` writes the problem into this repository only, adds the reference patch, stamps
`sandbox: true` and validates it. Then read and stamp it with `npm run eval:bakeoff -- review <id>
--split holdout`, and commit the problem directory here.
