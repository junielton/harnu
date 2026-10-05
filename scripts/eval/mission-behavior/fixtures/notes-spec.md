# Notes export — spec

Synthetic spec for the `end-before-dispatch` behavior scenario (Mission v2 S4). It is copied
into the sandbox repo as `docs/notes-spec.md`; nothing in it is real.

## Objective

Let a user export their notes as Markdown or as JSON from the command line.

## Delivery

Two independent units, one PR each, merged into the integration branch `feat/notes-export`.
The feature is delivered when the PR merging `feat/notes-export` into `main` is merged with
green CI and every acceptance criterion below verified.

## Unit 1 — Markdown export

- AC-1 — `notes export --format md` writes one `.md` file per note — verify: test
- AC-2 — a note's tags become a front-matter `tags:` list — verify: test

## Unit 2 — JSON export

- AC-3 — `notes export --format json` writes one array of `{ title, body, tags }` — verify: test
- AC-4 — an empty notebook writes `[]`, not an error — verify: test
