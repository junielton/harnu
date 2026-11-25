# Hidden atoms — the truth the judges score against

Written by the orchestrating session before any contestant ran, from the pinned input
(`../input/feature-request.md`) and the answer sheet (`../input/answer-sheet.md`). No contestant
and no executor saw this file. Judges get it with each spec they score.

Two families:

- **R-n, request atoms**: one per thing the request text itself asks for or implies. These come
  from the input alone, as the rubric's step 3 says.
- **O-n, operator atoms**: the answer-sheet decisions a spec has to carry for a builder to hit
  the hidden tests. A tool reaches them only by asking the operator (or by guessing right). They
  are scored separately, so a tool that never asks shows up here and not in R.

## R — from the request text

| id  | atom                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------- |
| R-1 | A JSON file whose root is an object holding the records under one key can be imported, with no `jq` step. |
| R-2 | The records are the objects of the list under that key: each object becomes one row (example: 2 rows).    |
| R-3 | The other top-level keys (the example's `Version`) do not become rows or columns.                         |
| R-4 | A rule of thumb finds that key automatically: an object with a key whose value is a list of objects.      |
| R-5 | "A single key": the rule applies when exactly one key qualifies; what happens with several is settled.    |
| R-6 | "A list of objects": the value must be a list whose elements are objects; other lists do not qualify.     |
| R-7 | It works in the sqlite-utils import path users hit (at least `sqlite-utils insert`).                      |
| R-8 | Top-level lists are not the target: a file that is already a list of records still imports the same way.  |

## O — from the answer sheet

| id   | atom                                                                                                         | sheet |
| ---- | ------------------------------------------------------------------------------------------------------------ | ----- |
| O-1  | Opt-in only: without the new option, a top-level object still imports as one row (CLI and Python).           | O-1   |
| O-2  | The interface is `--key KEY` and `--auto-key`; `rows_from_file(key=None, auto_key=False)`.                   | O-2   |
| O-3  | Available on `insert`, `upsert`, `bulk` and `memory`.                                                        | O-3   |
| O-4  | `--key` is a literal top-level name; list value → rows, object value → one row, scalar/null → error.         | O-4   |
| O-5  | Missing key → error naming it; Python raises `RowsFromFileBadJSON`.                                          | O-5   |
| O-6  | `--auto-key`: one candidate → its rows; none → error; several → error listing them; empty/scalar lists no.   | O-6   |
| O-7  | Top-level list: `--auto-key` no-op; `--key` error (`RowsFromFileBadJSON` in Python).                         | O-7   |
| O-8  | Both options together → error; Python `ValueError`.                                                          | O-8   |
| O-9  | With `--csv/--tsv/--nl/--lines/--text` → error; Python explicit CSV/TSV/NL → `ValueError`; memory skips CSV. | O-9   |
| O-10 | Empty list under `--key` → zero rows, success.                                                               | O-10  |
| O-11 | `--flatten`, `--pk`, `--alter`, `--convert`, `--stop-after` apply to the extracted rows.                     | O-11  |
| O-12 | Standard input behaves like a file.                                                                          | O-12  |
| O-13 | `memory` table names stay the file stem.                                                                     | O-13  |
| O-14 | Errors exit non-zero with a message and no traceback.                                                        | O-14  |
| O-15 | Docs: `cli.rst`, regenerated `cli-reference.rst`, `python-api.rst`; no version bump, no changelog edit.      | O-15  |
| O-16 | New tests in the repo suite; the existing suite keeps passing.                                               | O-16  |

## Test map

Every hidden test in `test_hidden_bakeoff.py` names the atoms it grades in its docstring. The
existing suite at the pin is the regression check (O-16) and is reported separately from the
hidden pass rate.
