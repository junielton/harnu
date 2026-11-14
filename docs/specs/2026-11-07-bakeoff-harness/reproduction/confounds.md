# How the reproduction differs from S-10

The reproduction (AC-30) re-ran the S-10 input, dev problem `sqlite-utils-json-key`, through the
harness with
`npm run eval:bakeoff -- run --problems sqlite-utils-json-key --with-tlc --skill-ref 6bab507f` and
every other flag at its default. The S-10 run is `docs/specs/2026-11-harnu-spec/bakeoff/`. This
file names what differs between the two, so a gap between their numbers can be read against it.

## Held the same

- **The input and the hidden truth.** The same pin of `simonw/sqlite-utils`
  (`9c66bafa52ae23d40499c74b0db3b635bcddb876`), the same request text, answer sheet, 24 atoms and
  53-test hidden suite, byte for byte (corpus v1, AC-23).
- **The contestants' methods.** `harnu:spec` at `6bab507f` (the skill S-10 ran), Superpowers at
  `bb92a77741419a4ab5f06e711a283343f1ada0c3` (7.0.0) and `tlc-spec-driven` at
  `8658b6658c762b9e5efd3956ed35a51c41bdf6c3`; `round.json`'s `pins` records the three.
- **The models.** Contestants and builders on `claude-opus-5-5`, the simulated operator and the
  judges on `claude-sonnet-5-5`, as in S-10's protocol. No `effort` override in either.
- **The score sheet and the build instruction.** The judges' schema is S-10's score sheet with one
  wording edit (its atom range became "every id in `atoms.md`"); the builder prompt is S-10's build
  instruction verbatim.

## Differs, by design of the harness

- **Contestants load every method from files.** Each contestant reads its method from a `tool/`
  directory and has no `Skill` tool. In S-10, Superpowers was loaded through the `Skill` tool from
  the installed plugin; `harnu:spec` and `tlc-spec-driven` were already read from a folder there.
- **Each judge sees one bundle, in a fresh session.** In S-10 each of three judges read the three
  bundles in a row, in a shuffled order, so a judge could compare them. Here each judge is a fresh,
  tool-less session per (judge, run) that sees one anonymized bundle and the atoms, from a neutral
  working directory.
- **Nobody relays.** In S-10 the orchestrator that wrote the hidden truth relayed every question
  and answer between a contestant and its operator. Here the harness passes the operator's
  `ANSWER` text back by resuming the contestant session; no model sits between them.
- **Two runs per tool, not one.** S-10 had one run per tool and so no spread. Here each tool ran
  twice, and the band of AC-30 is built on that spread.
- **The contestants' environment.** S-10's contestants were sub-agents of a session in a Harnu
  worktree, so they inherited that worktree's `CLAUDE.md`. Here every session runs with
  `--setting-sources project` and `--strict-mcp-config` in a clone of the target, outside this
  repository, so it loads the target's settings only and no MCP server.
- **The build.** S-10's executors were sub-agents in scratch clones with no network; here the
  builder is a `claude -p` session in a fresh checkout where `setup` ran
  (`.venv/bin/pip install -e . --group dev`), and the hidden suite runs twice: a test counts as
  passed only when it passes both times. S-10 recorded one run of the suite per build
  (`build/<tool>/hidden-tests-run.txt`).
- **Reference patch.** P1's `hidden/reference.patch` is a reconstructed patch, because the S-10
  file was compacted `git diff` output that `git apply` refuses (Amendments, 2026-11-09). It is
  used only by validation, never by a contestant or a builder.
- **Hidden-suite reading.** S-10's report read one `tlc-spec-driven` miss
  (`test_docs_cli_and_python_api_mention_options`) as an over-strict test and one `harnu:spec` pass
  as an accident. This harness counts JUnit results as they are and reinterprets nothing; the band
  is compared with S-10's raw counts (51, 53, 52 of 53).
