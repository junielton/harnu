# Operator log — superpowers (started 2026-11-07T15:12-03:00)

## Turn 1

**Q:** If you'd rather skip the questions and have me just start, say so.

When you last hit this with the Alaska elections file, how were you loading it: `sqlite-utils insert` on the command line, or the Python library?

**Entries:** G-2
**A:** No preference — your call.

## Turn 2

**Q:** Got it, I'll decide where it lives. Can I look through the sqlite-utils code to see how `insert` and `upsert` read JSON today, including the existing flags like `--nl` and `--csv`, and where your "single key holding a list of objects" rule would fit?

**Entries:** G-2
**A:** No preference — your call.

## Turn 3

**Q:** (Repo facts: insert/upsert parse JSON in `cli.py`, memory and `rows_from_file()` in `utils.py`; both treat an object as one row; rule to be added in both places.) The object has two keys, `Version` and `List`, and only one holds a list of objects. My guess: "exactly one key holds a list of objects, whatever other keys sit next to it, and those other keys get dropped". Is that right, or only when the object has literally nothing but that one key?

**Entries:** O-6
**A:** Yes, your first guess is right. It only counts a top-level key whose value is a non-empty list where every element is an object. If exactly one key qualifies, that list becomes the rows and the other keys next to it, like `Version`, don't matter. If none qualifies it's an error. If more than one does, it's an error that lists all of those keys.

## Turn 4

**Q:** (Restated rule: qualifies = non-empty list of objects; one → rows; several → error naming them; none → error; top-level list as today. Guesses: both readers follow it; `[]` doesn't qualify.) The "none qualifies" case collides with the documented one-object-one-row behavior. Do you mean to break that, or should a plain object keep inserting as a single row?

**Entries:** O-1, O-2, O-6
**A:** No, don't break that. The rule is opt-in only. Without the new option, a top-level object still imports as one row, exactly as now, in every command and in `rows_from_file()`, so `{"id": 1, "name": "Cleo"}` stays a single row. The rule only applies when you pass `--auto-key`, or `auto_key=True` in Python's `rows_from_file()`. With `--auto-key`, an object with no qualifying key is an error. There is also an explicit `--key KEY` for naming the key yourself. An empty list doesn't qualify, which matches your guess.

## Turn 5

**Q:** (Opt-in side: `--auto-key` rule; `--key KEY` names the key. Guesses: both on insert/upsert/memory; both together an error; with `--nl/--csv/--tsv/--lines/--text` an error; a top-level list imports as today with either; Python gets `key=`.) What should `--key List` do when the key is missing, isn't a list, holds non-objects, or holds an empty list?

**Entries:** O-3, O-4, O-5, O-7, O-8, O-9, O-10, O-14, O-18
**A:** For `--key List`: missing → error naming the key (Python: `RowsFromFileBadJSON` with the key in the message); value not a list → an object is one row, a string/number/boolean/null is an error; list of non-objects → behaves exactly like a top-level list of non-objects today; empty list → zero rows, success. All errors: normal CLI errors, non-zero exit, message, no traceback. Corrections: commands are `insert`, `upsert`, `bulk` and `memory`; top-level list: `--auto-key` no-op, `--key` error (Python `RowsFromFileBadJSON`); both together an error (Python `ValueError`); non-JSON: insert/upsert/bulk error, memory applies to JSON inputs and CSV/TSV import as today; Python: `key=None` and `auto_key=False`, explicit CSV/TSV/NL format raises `ValueError`, with detection the arguments apply only when JSON is detected.

## Turn 6

**Q:** (Full restatement of the rules; `bulk` shares the insert reader, `memory` reads through `rows_from_file()`.) Calls I'd make myself: `memory` with `file:nl` imports as today; order — key first, then `--flatten/--convert/--stop-after`; `--code` with either option is an error; error wording mine; docs in `cli.rst` (Inserting JSON data, memory), `rows_from_file()` docs, cog `cli-reference.rst`. What's wrong or missing above?

**Entries:** G-1, O-11, O-15, G-2
**A:** Keep existing behavior unchanged for anyone who doesn't opt in, and follow the repo's conventions. Nothing else. Order of operations: fine — the other options work normally on the extracted rows. Docs: the `rows_from_file()` parameters belong in `docs/python-api.rst`; regenerate `cli-reference.rst` with cog; use the issue's example; no version bump, no changelog edit. `memory` with `file:nl`, and `--code`: no preference — your call. Error wording: no preference — your call.

## Turn 7

**Q:** Design written and committed: `docs/superpowers/specs/2026-11-07-json-key-extraction-design.md`; a builder-view reviewer raised one wording inconsistency, fixed. Calls made: memory `:nl/:csv/:tsv` import as today; each JSON input resolves alone; `--code` with either option is an error; error wording listed; one shared helper in `utils.py`; top-level scalar: `--auto-key` as today, `--key` error; conflicts checked before reading; help text for both. Do you approve the design as written?

**Entries:** G-4
**A:** Yes, approved. Looks right, go ahead.

## Turn 8

**Q:** Plan written and committed: `docs/superpowers/plans/2026-11-07-json-key-extraction.md` — four test-first tasks (shared helper + `rows_from_file()` args; insert/upsert/bulk; memory; docs + cog + `just test`/`just lint`), fixed error messages, a test per behavior-table row, a one-row regression per command, five risky inputs. Does the plan capture what you want, and how should it be run — subagent-driven or native? (Recommends native.)

**Entries:** G-4, G-6
**A:** Yes, the plan is approved. Don't build it now. Stop once the plan is written and approved, because someone else builds it. That means I have no preference between subagent-driven and native.
