# Operator log — harnu (started 2026-11-07T15:12-03:00)

## Turn 1

**Q:** Triage (Door: A task / ticket · Tier: Large), repo facts, then **Decision D-1 (1 of 3): what shape counts as "a single key that is a list of objects"?** A. exactly one key in the object; B. exactly one key whose value is a list of objects, other keys ignored, several → nothing unwrapped (one row, today's behavior); C. the first such key. Default B, recommendation B. (Full text in the contestant transcript.)

**Entries:** O-6, O-1, O-2
**A:** B is closest — other keys like `Version` are ignored and only the list of objects counts. But two differences: this detection is opt-in via an `--auto-key` flag; without it, a top-level object still imports as one row exactly as today. And with the flag, no candidate key is an error, and two or more candidates is an error that lists every candidate key — it doesn't fall back to one row. I also want a `--key KEY` option to name the key explicitly.

## Turn 2

**Q:** (D-1 recorded as resolved: B, opt-in, `--auto-key`, errors, `--key KEY`.) **Decision D-2 (2 of 3): which entry points get `--auto-key` and `--key`?** A. `insert` and `upsert` only; B. `insert`, `upsert` and `memory` (rows_from_file gains a kwarg); C. B plus documenting the `rows_from_file()` argument as public API. Default A, recommendation A.

**Entries:** O-3, O-2, O-9, O-15
**A:** None of those fits exactly, but C is closest. I want it on every command that reads JSON input: `insert`, `upsert`, `bulk` and `memory`. In `memory` the options apply to every JSON input in the call. CSV and TSV inputs in the same call import as before, with no error. `rows_from_file()` gets `key=None` and `auto_key=False` keyword arguments, and those two parameters should be documented in `docs/python-api.rst`.

## Turn 3

**Q:** (D-2 recorded as resolved with the operator's own option.) **Decision D-3 (3 of 3): seven edge cases with defaults** — 1. `--key` missing or not a list of objects → error naming the key; 2. both options → usage error; 3. top-level array with either option → imports as today; 4. insert/upsert/bulk with `--nl/--csv/--tsv/--lines/--text` → usage error; 5. `:nl` in memory → imports as before; 6. `rows_from_file()` raises `RowsFromFileBadJSON`, CLI prints `Error: …`, exit 1, no traceback (with a catch in memory); 7. `--flatten` applies to unwrapped rows. Recommendation: all seven.

**Entries:** O-4, O-5, O-7, O-8, O-9, O-10, O-11, O-14, G-2
**A:** I accept the defaults except for two items. Item 1: `--key` takes a literal top-level key name; list → each element a row, empty list → zero rows and success; object → one row; any other value (string, number, boolean, null) → error; missing key → error naming the key; in Python a missing key raises `RowsFromFileBadJSON` with the key in the message. Item 3: with `--auto-key` a top-level array imports as today; with `--key` it is an error (Python `RowsFromFileBadJSON`). Items 2, 4, 6 and 7 are fine. Every error must be a clean CLI error with a non-zero exit, a message and no traceback. Item 5: No preference — your call.

## Turn 4

**Q:** The spec is ready: `docs/specs/2026-11-07-json-top-level-key/spec.md`, review record `critics.md` beside it (staged, not committed). Checker clean; three fresh reviewers (comprehension, hostile critic, implementation readiness), two rounds each; 73 findings fixed or answered, no open Blocker; nothing outside the spec folder changed; no mission or `open_file` outside Harnu. Approve this spec?

**Entries:** G-4
**A:** Yes, approved.
