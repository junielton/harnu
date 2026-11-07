# Operator log — tlc (started 2026-11-07T15:12-03:00)

## Turn 1

**Q:** Five decisions before the acceptance criteria (recommendation first): Q1 meaning of "single key" (a: one qualifying key, siblings allowed; b: exactly one key in total); Q2 several qualifying keys (a: don't unwrap, one row; b: error naming them; c: first); Q3 always on vs flag (a: always on; b: on + off-flag; c: off, new flag); Q4 where (a: insert, upsert, bulk, memory, `rows_from_file()`; b: insert/upsert only); Q5 list of objects (a: non-empty, all objects; b: also empty). Defaults to correct: siblings dropped silently; `--flatten/--convert/--pk` apply per record; out of scope: `--nl`, deeper nesting, a flag for naming the key. (Full text in the contestant transcript.)

**Entries:** O-1, O-2, O-3, O-6, O-11, O-17, G-2
**A:** Q1 a: one key holds a non-empty list of objects and other keys can sit beside it. Q2 b: it should fail with an error that lists every candidate key. Q3 none of these fit. It must not be automatic, because a top-level object has to keep importing as one row, exactly as now, in every command and in `rows_from_file()`. I want two opt-in options: `--key KEY` reads the records from that top-level key, and `--auto-key` is a flag that applies your rule of thumb to find the key. In Python, `rows_from_file()` gets `key=None` and `auto_key=False`. Q4 a: all of them, meaning `insert`, `upsert`, `bulk`, `memory` and `rows_from_file()`. Q5 a: a candidate is a non-empty list where every element is an object. An empty list or a list of scalars is never a candidate. `--flatten`, `--pk`, `--convert` and the other options apply to the extracted rows normally, as you said. A flag for naming the key is not out of scope, because `--key` is exactly that. The other out-of-scope items are fine, along with deeper nesting. I have no preference on dropping sibling keys silently, so that's your call.

## Turn 2

**Q:** Three new questions from the opt-in switch: OQ-A `--auto-key` with no candidate (a: error; b: fall back to one row); OQ-B top-level array (a: `--auto-key` imports as is, `--key` fails; b: both fail; c: both ignore); OQ-C non-JSON input (a: usage error in insert/upsert/bulk, memory and `rows_from_file()` apply to JSON only; b: ignore everywhere; c: error everywhere). Defaults to correct: both together an error (Python `ValueError`); `--key` fails naming the key when missing, not a list, or holding a non-object; `[]` → zero rows; Python shape errors raise `RowsFromFileBadJSON`.

**Entries:** O-6, O-7, O-9, O-8, O-5, O-4, O-18, O-10
**A:** OQ-A: a — fail; an empty list is never a candidate, so `{"Version": "x", "List": []}` fails too. OQ-B: a — `--auto-key` imports as today; `--key` is an error, Python `RowsFromFileBadJSON`. OQ-C: a, with one correction for `rows_from_file()`: an explicit CSV/TSV/NL `format=` with either argument raises `ValueError`; with detection the arguments apply only when JSON is detected, detected CSV/TSV comes back unchanged. insert/upsert/bulk with `--csv/--tsv/--nl/--lines/--text` is an error; in memory the options apply to every JSON input, CSV/TSV import as today. Defaults: both together an error, Python `ValueError` — right; missing key error naming it, Python `RowsFromFileBadJSON` with the key — right. Disagree on two points for `--key`: an object value is one row (only string/number/boolean/null is an error); a non-object element inside the list is not a new error — it behaves exactly as in a top-level list today. Empty list → zero rows, clean exit — right.

## Turn 3

**Q:** Spec at `.specs/features/json-list-key/spec.md` passes the validator (0 errors, 0 warnings): 7 requirements (JSONKEY-01 to JSONKEY-07), 40 acceptance criteria, each with a check naming its test; no Design phase, no tasks file, three build steps. Two defaults to correct (neither blocks): `:nl` in memory imports as today; the exact error texts (listed). Do you approve the spec as written?

**Entries:** G-4, G-2
**A:** Yes, approved. Looks right, go ahead. On the `:nl` suffix in `memory`, I have no preference, so your call. The same goes for the exact error texts, as long as the messages name the key or keys where I said they should.
