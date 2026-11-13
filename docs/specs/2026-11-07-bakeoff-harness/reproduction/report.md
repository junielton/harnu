# Bake-off report: 20261113-164650

- split: dev
- status: done
- dryRun: false
- models.contestant: claude-opus-5-5
- models.operator: claude-sonnet-5-5
- models.judge: claude-sonnet-5-5
- pins.harnu-spec: 6bab507f5e2b32ac19e816679a4472c8b7c0378b
- pins.superpowers: bb92a77741419a4ab5f06e711a283343f1ada0c3
- pins.tlc-spec-driven: 8658b6658c762b9e5efd3956ed35a51c41bdf6c3

## Hidden-test pass rate (%)

| problem               | contestant      | r1     | r2    | mean  | spread |
| --------------------- | --------------- | ------ | ----- | ----- | ------ |
| sqlite-utils-json-key | harnu-spec      | 100.00 | 96.23 | 98.11 | 3.77   |
| sqlite-utils-json-key | superpowers     | 98.11  | 94.34 | 96.23 | 3.77   |
| sqlite-utils-json-key | tlc-spec-driven | 100.00 | 88.68 | 94.34 | 11.32  |
| (summary)             | harnu-spec      |        |       | 98.11 | 3.77   |
| (summary)             | superpowers     |        |       | 96.23 | 3.77   |
| (summary)             | tlc-spec-driven |        |       | 94.34 | 11.32  |

## Coverage (% of atoms, judge mean)

| problem               | contestant      | r1    | r2    | mean  | spread |
| --------------------- | --------------- | ----- | ----- | ----- | ------ |
| sqlite-utils-json-key | harnu-spec      | 97.92 | 90.28 | 94.10 | 7.64   |
| sqlite-utils-json-key | superpowers     | 96.53 | 90.97 | 93.75 | 5.56   |
| sqlite-utils-json-key | tlc-spec-driven | 92.36 | 76.39 | 84.38 | 15.97  |
| (summary)             | harnu-spec      |       |       | 94.10 | 7.64   |
| (summary)             | superpowers     |       |       | 93.75 | 5.56   |
| (summary)             | tlc-spec-driven |       |       | 84.38 | 15.97  |

## Decisions left to the implementer (judge mean)

| problem               | contestant      | r1   | r2   | mean | spread |
| --------------------- | --------------- | ---- | ---- | ---- | ------ |
| sqlite-utils-json-key | harnu-spec      | 3.33 | 3.67 | 3.50 | 0.33   |
| sqlite-utils-json-key | superpowers     | 2.67 | 6.00 | 4.33 | 3.33   |
| sqlite-utils-json-key | tlc-spec-driven | 4.00 | 7.67 | 5.83 | 3.67   |
| (summary)             | harnu-spec      |      |      | 3.50 | 0.33   |
| (summary)             | superpowers     |      |      | 4.33 | 3.33   |
| (summary)             | tlc-spec-driven |      |      | 5.83 | 3.67   |

## Contradictions (judge mean)

| problem               | contestant      | r1   | r2   | mean | spread |
| --------------------- | --------------- | ---- | ---- | ---- | ------ |
| sqlite-utils-json-key | harnu-spec      | 1.67 | 0.33 | 1.00 | 1.33   |
| sqlite-utils-json-key | superpowers     | 0.00 | 1.33 | 0.67 | 1.33   |
| sqlite-utils-json-key | tlc-spec-driven | 0.67 | 1.67 | 1.17 | 1.00   |
| (summary)             | harnu-spec      |      |      | 1.00 | 1.33   |
| (summary)             | superpowers     |      |      | 0.67 | 1.33   |
| (summary)             | tlc-spec-driven |      |      | 1.17 | 1.00   |

## Executable-proof share (judge mean)

| problem               | contestant      | r1   | r2   | mean | spread |
| --------------------- | --------------- | ---- | ---- | ---- | ------ |
| sqlite-utils-json-key | harnu-spec      | 1.00 | 1.00 | 1.00 | 0.00   |
| sqlite-utils-json-key | superpowers     | 0.93 | 1.00 | 0.97 | 0.07   |
| sqlite-utils-json-key | tlc-spec-driven | 1.00 | 1.00 | 1.00 | 0.00   |
| (summary)             | harnu-spec      |      |      | 1.00 | 0.00   |
| (summary)             | superpowers     |      |      | 0.97 | 0.07   |
| (summary)             | tlc-spec-driven |      |      | 1.00 | 0.00   |

## Builder guesses (judge mean)

| problem               | contestant      | r1   | r2   | mean | spread |
| --------------------- | --------------- | ---- | ---- | ---- | ------ |
| sqlite-utils-json-key | harnu-spec      | 3.00 | 4.33 | 3.67 | 1.33   |
| sqlite-utils-json-key | superpowers     | 3.33 | 5.33 | 4.33 | 2.00   |
| sqlite-utils-json-key | tlc-spec-driven | 4.67 | 7.00 | 5.83 | 2.33   |
| (summary)             | harnu-spec      |      |      | 3.67 | 1.33   |
| (summary)             | superpowers     |      |      | 4.33 | 2.00   |
| (summary)             | tlc-spec-driven |      |      | 5.83 | 2.33   |

## Assumptions logged (builder)

| problem               | contestant      | r1    | r2    | mean  | spread |
| --------------------- | --------------- | ----- | ----- | ----- | ------ |
| sqlite-utils-json-key | harnu-spec      | 17.00 | 14.00 | 15.50 | 3.00   |
| sqlite-utils-json-key | superpowers     | 13.00 | 14.00 | 13.50 | 1.00   |
| sqlite-utils-json-key | tlc-spec-driven | 16.00 | 16.00 | 16.00 | 0.00   |
| (summary)             | harnu-spec      |       |       | 15.50 | 3.00   |
| (summary)             | superpowers     |       |       | 13.50 | 1.00   |
| (summary)             | tlc-spec-driven |       |       | 16.00 | 0.00   |

## Tokens per run, total (spec and build)

| problem               | contestant      | r1         | r2         | mean       | spread     |
| --------------------- | --------------- | ---------- | ---------- | ---------- | ---------- |
| sqlite-utils-json-key | harnu-spec      | 5198258.00 | 3921903.00 | 4560080.50 | 1276355.00 |
| sqlite-utils-json-key | superpowers     | 2126820.00 | 1611789.00 | 1869304.50 | 515031.00  |
| sqlite-utils-json-key | tlc-spec-driven | 2756954.00 | 2591465.00 | 2674209.50 | 165489.00  |
| (summary)             | harnu-spec      |            |            | 4560080.50 | 1276355.00 |
| (summary)             | superpowers     |            |            | 1869304.50 | 515031.00  |
| (summary)             | tlc-spec-driven |            |            | 2674209.50 | 165489.00  |

## Tokens per run, output (spec and build)

| problem               | contestant      | r1        | r2       | mean      | spread   |
| --------------------- | --------------- | --------- | -------- | --------- | -------- |
| sqlite-utils-json-key | harnu-spec      | 120427.00 | 93051.00 | 106739.00 | 27376.00 |
| sqlite-utils-json-key | superpowers     | 50778.00  | 43956.00 | 47367.00  | 6822.00  |
| sqlite-utils-json-key | tlc-spec-driven | 69182.00  | 53069.00 | 61125.50  | 16113.00 |
| (summary)             | harnu-spec      |           |          | 106739.00 | 27376.00 |
| (summary)             | superpowers     |           |          | 47367.00  | 6822.00  |
| (summary)             | tlc-spec-driven |           |          | 61125.50  | 16113.00 |

## Wall time (ms)

| problem               | contestant      | r1        | r2        | mean      | spread    |
| --------------------- | --------------- | --------- | --------- | --------- | --------- |
| sqlite-utils-json-key | harnu-spec      | 756453.00 | 572207.00 | 664330.00 | 184246.00 |
| sqlite-utils-json-key | superpowers     | 302952.00 | 262813.00 | 282882.50 | 40139.00  |
| sqlite-utils-json-key | tlc-spec-driven | 381234.00 | 285885.00 | 333559.50 | 95349.00  |
| (summary)             | harnu-spec      |           |           | 664330.00 | 184246.00 |
| (summary)             | superpowers     |           |           | 282882.50 | 40139.00  |
| (summary)             | tlc-spec-driven |           |           | 333559.50 | 95349.00  |

## Operator turns

| problem               | contestant      | r1   | r2   | mean | spread |
| --------------------- | --------------- | ---- | ---- | ---- | ------ |
| sqlite-utils-json-key | harnu-spec      | 7.00 | 4.00 | 5.50 | 3.00   |
| sqlite-utils-json-key | superpowers     | 3.00 | 4.00 | 3.50 | 1.00   |
| sqlite-utils-json-key | tlc-spec-driven | 4.00 | 3.00 | 3.50 | 1.00   |
| (summary)             | harnu-spec      |      |      | 5.50 | 3.00   |
| (summary)             | superpowers     |      |      | 3.50 | 1.00   |
| (summary)             | tlc-spec-driven |      |      | 3.50 | 1.00   |

## Sub-agents spawned

| problem               | contestant      | r1   | r2   | mean | spread |
| --------------------- | --------------- | ---- | ---- | ---- | ------ |
| sqlite-utils-json-key | harnu-spec      | 8.00 | 5.00 | 6.50 | 3.00   |
| sqlite-utils-json-key | superpowers     | 1.00 | 1.00 | 1.00 | 0.00   |
| sqlite-utils-json-key | tlc-spec-driven | 0.00 | 0.00 | 0.00 | 0.00   |
| (summary)             | harnu-spec      |      |      | 6.50 | 3.00   |
| (summary)             | superpowers     |      |      | 1.00 | 0.00   |
| (summary)             | tlc-spec-driven |      |      | 0.00 | 0.00   |

## Spec lines

| problem               | contestant      | r1     | r2     | mean   | spread |
| --------------------- | --------------- | ------ | ------ | ------ | ------ |
| sqlite-utils-json-key | harnu-spec      | 263.00 | 233.00 | 248.00 | 30.00  |
| sqlite-utils-json-key | superpowers     | 494.00 | 238.00 | 366.00 | 256.00 |
| sqlite-utils-json-key | tlc-spec-driven | 239.00 | 173.00 | 206.00 | 66.00  |
| (summary)             | harnu-spec      |        |        | 248.00 | 30.00  |
| (summary)             | superpowers     |        |        | 366.00 | 256.00 |
| (summary)             | tlc-spec-driven |        |        | 206.00 | 66.00  |

## Spec words

| problem               | contestant      | r1      | r2      | mean    | spread  |
| --------------------- | --------------- | ------- | ------- | ------- | ------- |
| sqlite-utils-json-key | harnu-spec      | 3815.00 | 2782.00 | 3298.50 | 1033.00 |
| sqlite-utils-json-key | superpowers     | 2512.00 | 2125.00 | 2318.50 | 387.00  |
| sqlite-utils-json-key | tlc-spec-driven | 2930.00 | 2271.00 | 2600.50 | 659.00  |
| (summary)             | harnu-spec      |         |         | 3298.50 | 1033.00 |
| (summary)             | superpowers     |         |         | 2318.50 | 387.00  |
| (summary)             | tlc-spec-driven |         |         | 2600.50 | 659.00  |

## Runs

| contestant      | done | incomplete | failed | judges invalid reply | flaky |
| --------------- | ---- | ---------- | ------ | -------------------- | ----- |
| harnu-spec      | 2.00 | 0.00       | 0.00   | 0.00                 | 0.00  |
| superpowers     | 2.00 | 0.00       | 0.00   | 0.00                 | 0.00  |
| tlc-spec-driven | 2.00 | 0.00       | 0.00   | 0.00                 | 0.00  |

## Budget

- cap: 400000000.00
- spent: 18613277.00
- remaining: 381386723.00
- status: done

| phase      | tokens      |
| ---------- | ----------- |
| contestant | 10676804.00 |
| operator   | 180601.00   |
| judge      | 376856.00   |
| build      | 7349784.00  |
| discarded  | 29232.00    |

| contestant      | tokens     |
| --------------- | ---------- |
| harnu-spec      | 9251215.00 |
| superpowers     | 3849265.00 |
| tlc-spec-driven | 5506953.00 |
| unattributed    | 5844.00    |

## Confounds

- Bundles keep their structure: contestant names are replaced and front matter is stripped, but the structural shape of an artifact (an acceptance-criteria table, a plan checklist) can still identify the method to a judge.
- Judges run from a neutral directory, but the default work root path contains the word `harnu` for every contestant alike, so it cannot say which contestant is being scored.
- Real-CLI `--resume` behaviour and "no MCP server loads under `--strict-mcp-config`" are first exercised by the dry run; rounds that use a fake `claude` prove neither.
- The operator is simulated from a written answer sheet, so a question the sheet does not cover gets its default answer rather than a human judgement.
- Judges share one model and read one contestant at a time; their scores are not calibrated against a human grader.
- Hidden tests measure one reference behaviour: a spec that legitimately decides otherwise scores lower.
- Run-to-run spread comes from few repeats, so it is a coarse noise estimate, not a statistical test.

## Details

### sqlite-utils-json-key · harnu-spec · r1

- judge note: Very thorough spec: every request and operator atom is stated with a named helper, signatures, error substrings and a named test or command per AC. The only wrinkle is the loose 'no other flag conflicts' phrasing in R-10, which is resolved in the same paragraph and in S-2/AC-14. Little is left to the builder.
- judge note: Very thorough spec with nearly every behavior pinned down and a named test or command for each AC. The only atom not fully met is O-14, because memory's existing traceback on non-object rows and invalid JSON is deliberately retained. Wording of messages is left free beyond required substrings.
- judge note: Very thorough spec: nearly every atom is pinned down with named tests and commands. Remaining gaps are small: no explicit version-bump prohibition, and stdin is covered only through test cases. The AC-23 grep proof is weak on docs content but is machine-runnable, and AC-20 uses cog --check on README.md which the spec itself says has no cog block.

### sqlite-utils-json-key · harnu-spec · r2

- failed: tests.test_hidden_bakeoff::test_key_on_top_level_list_is_an_error
- failed: tests.test_hidden_bakeoff::test_rows_from_file_key_on_top_level_list_raises
- judge note: Very thorough spec with executable proofs on every acceptance criterion and the operator rulings carried through. The main divergence from the hidden atoms is O-7: the spec lets --key pass a top-level list through unchanged, where the sheet expects an error. O-13 (memory table names) is never mentioned.
- judge note: The spec is very thorough, with a pinned contract, named tests and executable proofs for every AC. It deliberately has --key on a top-level list return it unchanged, which contradicts the O-7 atom (error). Memory table-name stability is never mentioned.
- judge note: Very thorough spec: nearly every behaviour is pinned, with a named test or command for each of the 20 ACs. The one real miss against the atoms is O-7: the spec returns a top-level list unchanged for --key too, where the answer sheet wants an error (RowsFromFileBadJSON). It also never mentions memory table naming (O-13).

### sqlite-utils-json-key · superpowers · r1

- failed: tests.test_hidden_bakeoff::test_docs_cli_and_python_api_mention_options
- judge note: The bundle is very complete: the plan and spec agree on the interface, the error cases and the option combinations, and almost every requirement has a named test or command. The only real gap is that O-13 (memory table name stays the file stem) is implied by test fixtures and never stated. No contradictions found; no explicit acceptance-criteria list, so I counted the goals and Review Focus items.
- judge note: Very complete spec: nearly every operator decision is stated and backed by named parametrized tests with exact commands. Only the memory table-name rule and the python-api.rst/version handling are left implicit. The 'zero decisions' count is low and there are no internal contradictions.
- judge note: The spec is very complete, with concrete tests for nearly every rule and exact error-content requirements. Gaps are minor: memory table naming, the explicit no-version-bump rule and the python-api.rst edit. Docs checks are the only non-test criteria.

### sqlite-utils-json-key · superpowers · r2

- failed: tests.test_hidden_bakeoff::test_key_object_value_is_one_row
- failed: tests.test_hidden_bakeoff::test_rows_from_file_auto_key_on_top_level_list_is_a_no_op
- failed: tests.test_hidden_bakeoff::test_top_level_list_unchanged_with_auto_key
- judge note: Spec is very precise and nearly every behavior has a named test. It diverges from the hidden atoms on the object-value case under --key and on --auto-key with a top-level list (it errors rather than no-op), and never mentions memory table names. Several of these are stated as explicit author choices, so they count as contradicted/partial against the answer sheet rather than ambiguous.
- judge note: Strong spec with explicit tests for most atoms. Its main divergences from the hidden atoms are that a top-level list under --auto-key is an error (O-7 expects a no-op) and that an object value under --key is an error (O-4 expects one row). O-7 should arguably be contradicted, and R-8 is only partly safe because the spec's default path is unchanged but --auto-key on a list errors.
- judge note: The spec is detailed and nearly fully testable, but it diverges from the hidden atoms on two points: a top-level list with --auto-key is an error rather than a no-op, and an object value under --key is an error rather than one row. Docs are covered, but the spec leaves the changelog to the maintainer instead of forbidding edits, and the memory table-name behaviour is not stated.

### sqlite-utils-json-key · tlc-spec-driven · r1

- judge note: Very thorough spec with a traceable 1:1 check list; nearly every observable behavior is settled. Gaps are stdin, and the non-flatten option interactions (--pk/--alter/--convert/--stop-after) which lack explicit checks. The 38 'executable' count treats grep/cog/git-diff proofs as machine-runnable alongside named tests, and the test proofs are named tests that don't yet exist but are specified exactly.
- judge note: Very thorough spec: every request atom and nearly every operator decision is stated, and every criterion maps to a named test or command. Gaps are stdin behavior, an explicit memory table-name rule, and little proof for the --convert, --stop-after, --alter and --pk interactions. Minor traceability slip: JKEY-36 is assigned to T5 though T2/T3 regenerate the reference file.
- judge note: Very thorough spec: every operator decision is recorded and each of 38 acceptance criteria has a named test or a command. The gaps are stdin handling and an explicit memory file-stem table-name rule; the extra options (--stop-after, --alter, --convert) are only covered by a general assumption row.. A [tool] placeholder in the tasks file's execution protocol is a leftover but changes no behavior.

### sqlite-utils-json-key · tlc-spec-driven · r2

- failed: tests.test_hidden_bakeoff::test_docs_cli_and_python_api_mention_options
- failed: tests.test_hidden_bakeoff::test_key_object_value_is_one_row
- failed: tests.test_hidden_bakeoff::test_rows_from_file_auto_key_on_top_level_list_is_a_no_op
- failed: tests.test_hidden_bakeoff::test_rows_from_file_explicit_non_json_format_raises[Format.CSV]
- failed: tests.test_hidden_bakeoff::test_rows_from_file_explicit_non_json_format_raises[Format.TSV]
- failed: tests.test_hidden_bakeoff::test_top_level_list_unchanged_with_auto_key
- judge note: Spec is very thorough and executable, but it chose different behaviour from the answer sheet on three points: --key with an object value, --auto-key on a top-level list, and Python non-JSON formats. It leaves stdin, memory table names, and the remaining flag interplay unstated. Every check names a test or command; the context and spec disagree on whether the defaults were confirmed.
- judge note: Very thorough and fully test-named, but its confirmed assumptions diverge from the hidden operator sheet: an object value under --key is an error, a top-level list under a key option is an error, and Python explicit CSV/TSV/NL is ignored instead of raising ValueError. Stdin, memory table names, convert/alter/stop-after and python-api.rst are not settled.
- judge note: The spec is very thorough and gives exact messages and named tests for nearly every check, but it deliberately diverges from the atoms on --key with an object value and on top-level lists with --auto-key. Stdin, memory table names and the non-flatten options are never mentioned. Docs scope omits python-api.rst; every check has a runnable proof, though some tests are named rather than asserted on output.
