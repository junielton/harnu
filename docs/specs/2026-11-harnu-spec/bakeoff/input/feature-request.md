# Pinned input — the feature request every contestant receives

This file is the whole input. Every contestant gets exactly the text under _The request_ below,
plus the repository at the pinned commit. Nothing else.

## Pin

| what                      | value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| repository                | `https://github.com/simonw/sqlite-utils`                                      |
| commit                    | `9c66bafa52ae23d40499c74b0db3b635bcddb876` (2026-10-10, `main`)               |
| version at that commit    | `4.2.1`                                                                       |
| size                      | about 28k lines of Python (`sqlite_utils/*.py` + `tests/*.py`), 56 test files |
| test suite at that commit | `pytest`: 1497 passed, 16 skipped, about 10 s on one core (measured here)     |
| request                   | GitHub issue #489, title and body only, still open at the pinned commit       |

The feature is absent at the pin: `rows_from_file()` and the `insert` / `upsert` / `memory` JSON
paths wrap a top-level object as a single row (`sqlite_utils/utils.py`, `sqlite_utils/cli.py`).

## Why this input (D-15)

- **Mid-size public repo with a fast test suite.** About 28k lines, a 10-second `pytest` run, no
  services: four build tests plus the hidden suite fit the CPU budget.
- **A real request with real ambiguity.** The issue proposes an automatic "rule of thumb". The
  owner's later comments (not part of the input) say that would break current behavior and need an
  opt-in switch with a good name. A spec tool has to ask about naming, opt-in, scope and edge
  cases, or guess.
- **Testable from outside.** The behavior shows through the CLI and one public Python function,
  so the hidden tests can grade any implementation without reading its code.
- **Small enough to build in one session**, large enough that the spec matters: three commands,
  one library function, error handling, docs.

Only the title and the body are the input. The comment thread holds the owner's prototype and
option names; handing it over would let the request answer its own questions.

## The request

> **Implement this feature request in the sqlite-utils repository checked out in your working
> directory.**
>
> **Ability to load JSON records held in a file with a single top level key that is a list of
> objects**
>
> It's very common for JSON to look like this:
>
> ```json
> {
>   "Version": "5.5.52.6",
>   "List": [
>     {
>       "Description": "Nonpartisan",
>       "Id": 1,
>       "ExternalId": ""
>     },
>     {
>       "Description": "Undeclared",
>       "Id": 2,
>       "ExternalId": ""
>     }
>   ]
> }
> ```
>
> This example taken from the records downloaded from https://www.elections.alaska.gov/election-results/e/
>
> Right now you can't import this into `sqlite-utils` - you need to run it through `jq .List` first.
>
> But since this is so common, it would be neat if `sqlite-utils` could have a rule of thumb that
> says "if it's an object, but it has a single key that is is a list of objects, use that instead".
