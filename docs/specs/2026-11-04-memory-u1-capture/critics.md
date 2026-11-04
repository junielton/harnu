# Critic pass on the memory U1 capture spec

The card asks for one blind builder-check: a fresh sub-agent given only `spec.md`, asked to list
every guess it had to make for S-1, with the spec revised until that list is empty or every item
became a D-n or a non-goal. The check ran three times, each time on a fresh agent that read only the
spec file. The first draft's S-1 was split into S-1 (pure core) and S-2 (engine) after round 1, so
rounds 2 and 3 covered both. This file records what was raised and what changed. The raw outputs
are not committed.

Two facts were checked against live data during the pass, because a decision rests on them:

- **Commit hashes are not in the transcript.** In the 300 most recent transcripts on the
  maintainer's machine, `git commit` tool results read `ok 1 file changed, …` (the command runs
  through a token-filtering proxy and often with `-q`), so no `[branch sha]` line appears. Parsing
  the hash from tool output (D-5 option c) is therefore unreliable, and the default attributes by
  the time windows of the session's own git calls instead.
- **`AskUserQuestion` answers are structured.** The same sample holds 165 `AskUserQuestion` calls;
  each answered one carries `toolUseResult.answers` as `{ question: answer }`. That makes the
  asked-and-answered extraction (D-2 default) language-independent, unlike a keyword search.

## Round 1 (first draft, S-1 as one slice)

Verdict: buildable with guesses, 52 items.

| Raised                                                                                                                        | Outcome                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incremental scan cannot pair a `tool_use` and its result across two batches; the clock for open windows was unclear           | **Fixed.** `pending` in `TranscriptFacts`; the scan takes no clock; `gitWindows(facts, nowMs)` closes pending calls at read time.                                           |
| User-turn rule silent on whitespace, compact summaries, slash-command output, interruptions, image-only lines                 | **Fixed.** Definition lists each case; AC-2 covers each on the fixture; AC-33 pins the rule against the benchmark.                                                          |
| `firstAt`/`lastAt` on lines without a timestamp                                                                               | **Fixed.** First and last line that has one, normalised ISO.                                                                                                                |
| Asked-and-answered matching, non-string answers, order                                                                        | **Fixed.** Paired by id; array joined with `, `; drop empties; chronological, last 10.                                                                                      |
| Where the 300-character cut happens; code points or units                                                                     | **Fixed.** "Cut" definition: code points, in the scan.                                                                                                                      |
| Open-question split consumed the `?`; which 5; source text                                                                    | **Fixed.** A regex that keeps the mark, code removed first, last 5, from the uncut tail.                                                                                    |
| "Last assistant text block" vs message; sidechains                                                                            | **Fixed.** "Last assistant message" definition (by `message.id`, sidechains excluded).                                                                                      |
| 1 MiB rule: unit, layer, reader                                                                                               | **Fixed.** UTF-8 bytes, reader only, `createReadStream` with own splitting.                                                                                                 |
| Subagent transcripts in S-1?                                                                                                  | **Fixed.** Main transcript only until S-4.                                                                                                                                  |
| Git-call regex false positives, missing timestamps                                                                            | **Fixed.** False positives accepted (a window only matters if a commit falls in it); untimed calls ignored.                                                                 |
| Trigger precedence; does `PreCompact` even reach the observer                                                                 | **Fixed.** Ordered list; verified that the hub forwards every admitted event, state-preserving ones included (`task-state-hub.ts` `ingest`).                                |
| Effect of each trigger on timers and state; duplicate `completed`                                                             | **Fixed.** Per-trigger effects stated; a duplicate end plans `unchanged`.                                                                                                   |
| Two digests of one session on one day                                                                                         | **Fixed.** Same page, append mode (verified: `sessions/` pages are append-mode), write-time date.                                                                           |
| Transcript path source                                                                                                        | **Fixed.** From the session id; the hook body's `transcript_path` is not forwarded by the bridge.                                                                           |
| Planner check order; unused `transcriptPath` input                                                                            | **Fixed.** Gate, then dedup, then evidence; the path is gone from the planner input.                                                                                        |
| S-1 behaviour for non-git folders and repos without a commit                                                                  | **Fixed.** `GitEvidence` with `head: string \| null`; no-git writes deferred to S-3 by an explicit early return.                                                            |
| `last` update rule; `isRelevantWork` fate; `formatDigest` signature                                                           | **Fixed.** Set only after a write; old symbols kept by S-1 and deleted by S-2; `renderDigest` signature given.                                                              |
| Header line position and the closing underscore; branch rule; Evidence per kind; section order; fencing; truncation algorithm | **Fixed.** Full body layout, header template, per-kind Evidence, bottom-up cut, and a byte-exact rendered example (AC-3).                                                   |
| AC-3 claimed the recap came from the scan                                                                                     | **Fixed.** Recap stays today's chain; the scan feeds the other sections.                                                                                                    |
| `PreCompact` entry details; installer test seed                                                                               | **Fixed.** Exact entry, no matcher, no bridge change (event taken from the URL path; not dispatchable); AC-5 seed described.                                                |
| Fixture slugs, contents, timings; replay steps, order, git input, memory dir; scorecard API                                   | **Fixed.** Declared fixture table with per-line generation rules; replay drives the real engine; the scorecard API is copied into an Amendments row before S-2 (external).  |
| AC-2 compared turn counts to a session count                                                                                  | **Fixed.** AC-2 checks per-session counts; AC-33 compares the denominator sets.                                                                                             |
| AC-8 only replays the planner, never the engine                                                                               | **Fixed.** The replay drives `createDigestEngine`; AC-35 and AC-36 test triggers, dedup and the reader with fakes. This needed the engine moved out of Electron-bound code. |
| S-1's CHANGELOG, user doc and stale-comment work had no AC                                                                    | **Fixed.** AC-28 on each slice, AC-38 for the S-2 doc section, AC-34 for the comments.                                                                                      |
| AC-7 "nothing from an MCP verb" is not testable                                                                               | **Fixed.** A dedicated seam test asserts its own imports.                                                                                                                   |
| AC-6 "anything else"; test-name nesting                                                                                       | **Fixed.** `failed` and `stopped` named (`TaskState` verified); test names are exact `it` titles.                                                                           |
| Function-name and slice-list contradictions; catch-up order; `lastHead` vs `head`; undefined 24 h quiet period                | **Fixed.** One name each; oldest first; `last.head`; `ORPHAN_QUIET_MS` cited.                                                                                               |
| What an answered D-n means for a merged slice                                                                                 | **Fixed.** Defaults are built; a later answer is an Amendments row with a delta.                                                                                            |
| S-1 fixture expectations under today's commit selection                                                                       | **Fixed.** The fixture table has an S-2 column, stating that both sessions on one checkout list every commit until S-4.                                                     |

## Round 2 (S-1 and S-2)

Verdict: buildable with guesses, 18 items.

| Raised                                                                                                 | Outcome                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-1 deleted and reshaped symbols the live engine still calls; `memory-digest.ts` was outside its scope | **Fixed.** S-1 adds new names beside the old (`renderDigest`, `DigestGate`, `DigestReason`); S-2 switches over and deletes the old ones.                     |
| S-1's ACs needed a fixture shipped by S-2                                                              | **Fixed.** The fixture table and `transcriptLines` ship in S-1; S-2 adds `buildMemoryU1Home`.                                                                |
| Fixture content too thin: times, ids, texts, commits, subagent file, over-long text                    | **Fixed.** Per-line generation rules, start and end per session, commit times, the initial commit, the subagent path; long-text cuts tested on inline lines. |
| Subagent fixture path contradicted S-4's layout                                                        | **Fixed.** One destination: `<slug>/<id>/subagents/agent-1.jsonl`.                                                                                           |
| Which sessions each benchmark denominator holds                                                        | **Fixed.** Expected sets stated; AC-33 compares the union of git and non-git; orphans are `orphan_loss`'s; subagent files are not sessions.                  |
| AC-7 could not prove imports of a shared test file                                                     | **Fixed.** Dedicated `tests/digest-plan-seam.test.ts` that reads its own source.                                                                             |
| Where the S-2 no-git early return lives; its side effects                                              | **Fixed.** In the engine after planning; no `last`, no hot.                                                                                                  |
| Engine steps between plan and write                                                                    | **Fixed.** Ten numbered steps: in-flight, resolve, read, git (since and baseline), plan, title chain, render, write and log, `last`, hot.                    |
| Timestamp normalisation                                                                                | **Fixed.** `toISOString()`.                                                                                                                                  |
| Tool-only assistant lines; reappearing ids; interleaved lines                                          | **Fixed.** Stated in "Last assistant message".                                                                                                               |
| Git-call result without a timestamp; `pending` contents; order of `gitCalls`                           | **Fixed.** End falls back to start; `pending` holds git and ask calls only; result-line order.                                                               |
| Scope of the 1 MiB rule                                                                                | **Fixed.** Reader only, UTF-8 bytes.                                                                                                                         |
| Open-question fences, spans, dedup, 64 KiB head or tail                                                | **Fixed.** Backtick and tilde fences, unclosed runs to end, spans become a space, dedup on cut text, the last 65,536 code points.                            |
| `renderDigest` blank lines, trailing newline, cut shape, uncapped title, branch rule                   | **Fixed.** Layout rules, title capped at 200, branch ignored for no-git, byte-exact example.                                                                 |
| `GitEvidence` home module                                                                              | **Fixed.** Declared in `digest-core.ts`, imported by `digest-io.ts`.                                                                                         |
| Replay helpers undefined                                                                               | **Fixed.** `memoryDirFor` cited (`memory-core.ts:87`); helper signatures given.                                                                              |
| S-1 touching `buildHotProposal`; Prettier broke two lines into a blockquote and lost spaces            | **Fixed.** Only its comment changes; the planner text reworded and the header template moved into a code block.                                              |
| S-2's user-guide section content                                                                       | **Fixed.** Four bullets stated; AC-38.                                                                                                                       |

## Round 3 (S-1 and S-2)

Verdict: buildable with guesses, 14 items.

| Raised                                                                                                 | Outcome                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-33 needs per-session data the Amendments row did not ask the scorecard for                          | **Fixed.** AC-33 checks denominator and numerator counts (5 and 1); it compares id sets when the scorecard exposes them; the Amendments row records the count paths too.                                                                               |
| Does the engine react to every edge or only to state changes; does a `PreCompact` POST really reach it | **Fixed.** Every edge, as today (repeated `idle` re-arms, repeated `completed` plans `unchanged`); fields read named; AC-39 drives `PreCompact` through the real hub (verified: `configureHub`, `resetHubForTests` exist, no Electron runtime import). |
| AC-35's "two `SessionEnd` in a row" could pass because of the in-flight guard                          | **Fixed.** `onTaskEdge` returns the digest promise; the test awaits it; `unchanged` observed as two reads and one write.                                                                                                                               |
| AC-3's full render input                                                                               | **Fixed.** Every `DigestRenderInput` field given.                                                                                                                                                                                                      |
| Left off / Last message equality on raw or capped text                                                 | **Fixed.** Trimmed source texts before the caps.                                                                                                                                                                                                       |
| Joiner for several text blocks on one line; a message without `message.id`                             | **Fixed.** `\n\n`; a missing id always replaces and resets the id to `null`.                                                                                                                                                                           |
| Sidechain asks, unmatched results, arrays as "object", whitespace answers                              | **Fixed.** Non-sidechain only; unmatched yields nothing; plain object only; trim before the empty check and the cut.                                                                                                                                   |
| Newline-collapse pattern; regexes broken by markdown                                                   | **Fixed.** All four regexes in one fenced block (`GIT_MUTATING`, `INLINE_CODE`, `QUESTION`, `NEWLINES`).                                                                                                                                               |
| `gitWindows` order                                                                                     | **Fixed.** The whole list stably sorted by `startMs`.                                                                                                                                                                                                  |
| Noise-line content, `sessions.json` shape, subagent uuids, `tool_use` ids                              | **Fixed.** Noise lines carry `noise <id8>` so only the flag excludes them; the JSON shape is given; `<id8>-s<n>`; `toolu_<id8>_<n>`.                                                                                                                   |
| Fixture git isolation from the machine's config                                                        | **Fixed.** `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, no signing, no hooks, empty template.                                                                                                                                               |
| A name clash with an existing `GitEvidence`                                                            | **Not an issue, stated.** `memory-digest.ts:107` has a private, unexported interface of that name; S-2 deletes it.                                                                                                                                     |

## Round 4 (S-1 and S-2, higher bar)

From this round on the agent was told to report only guesses where two engineers following the
spec would get different AC outcomes or break a later slice, or direct contradictions.

Verdict: buildable with guesses, 3 items.

| Raised                                                                                                                                                     | Outcome                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An orphan whose branch still resolves could never get evidence `orphan` (the planner only gave it for `unavailable`), and S-5 cannot edit `digest-core.ts` | **Fixed.** `DigestPlanInput.orphan`; `renderDigest` renders commit lines under the `orphan` token; both built and tested in S-1 (AC-1, AC-37); S-5 passes `orphan: true`. |
| "Every noise line has the content `noise <id8>`" contradicted the `tool_result` and local-command lines                                                    | **Fixed.** Exact `message.content` for each noise line; only the flagged lines carry `noise <id8>`.                                                                       |
| The fixture temp dir could sit inside a git work tree and make the plain folder a repo                                                                     | **Fixed.** `mkdtemp(join(os.tmpdir(), 'memory-u1-'))`, and the helper throws if the plain folder is inside a work tree.                                                   |

## Round 5 (S-1 and S-2, higher bar)

Verdict: buildable with guesses, 3 items.

| Raised                                                                                                              | Outcome                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Without a trailing newline the reader never parses each file's end line, which would break S-4's attribution window | **Fixed.** Each fixture file ends with `\n`.                                                                                                           |
| "Every line has a timestamp except line 1" read per file would leave the subagent's git call untimed                | **Fixed.** Only the main file's summary line lacks one.                                                                                                |
| Other files might reference the symbols S-2 deletes                                                                 | **Not an issue, stated.** `git grep` on 2026-11-04: only `digest-core.ts`, `memory-digest.ts` and `tests/mcp-digest-core.test.ts`, all in S-2's files. |

## Round 6 (S-1 and S-2, on the final text)

Run after the owner marked AC-4 unmet because no fresh reader had checked the final text. A fresh
agent read only the final `spec.md` (the text pushed as `249762b2`, which round 5's fixes produced)
and was asked for every guess for S-1 and S-2, each marked observable (two engineers could get
different AC or later-slice results) or cosmetic (nothing observes it).

Verdict: buildable with guesses, 2 observable and 17 cosmetic items. The agent confirmed that AC-1,
AC-3, AC-4, AC-6, AC-35 and AC-36 come out the same for any reasonable build, that AC-3's expected
bytes agree with the scan, cut, question and quoting rules, and that the fixture's S-2 column
follows from today's commit selection. As the owner instructed, the remaining guesses are mapped to
D-n rows instead of another rewrite of the spec:

| #    | Kind       | Raised                                                                                                                                                                                                                                                                                                                                                                                                                                   | Mapped to                                                                                                                                                                                                                                                   |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | observable | AC-34 bans `Approval Inbox` in the whole file, while S-1 says only comments change; a runtime string would force a choice                                                                                                                                                                                                                                                                                                                | **D-11.** Checked with `git grep` on 2026-11-04: every occurrence is a comment (lines 20-21, wrapped across a line, and 389). Default: remove them all; a new runtime occurrence is a Deviation.                                                            |
| 2    | observable | `gatherGitEvidence(..., rev)` leaves `head`, `dirtyCount` and `fileStats` open for a non-`HEAD` rev; S-5 could claim the owner's dirty files                                                                                                                                                                                                                                                                                             | **D-10.** Default: `head` from `rev-parse --verify <rev>`, `dirtyCount` 0, `fileStats` over the selected commits.                                                                                                                                           |
| 3-19 | cosmetic   | `otherCommits` line shape and singular; Evidence blank lines; unused `date`; planner-impossible render inputs; "fenced" vs blockquote wording; quoting trims and line splits; fence test; cut-before-compare on Last message; fixture loader and line shapes; replay tie order and `.harnu/` dirtiness; `since` rounding; moved-symbol importers; reader edge cases; engine `close()` and timers; caps' cut unit; which symbols S-1 adds | **D-12.** Default: the executor chooses, states each choice in its PR, and keeps every AC passing. D-12 also settles two of them outright: "fenced" means the blockquote, and `git grep` finds no importer of the moved symbols outside `memory-digest.ts`. |

## Where it stands

The guess count went 52, 18, 14, 3, 3, then 2 observable and 17 cosmetic on the final text. Rounds 1
to 5 were fixed in the spec; round 6, run on the final text, maps every remaining guess to a D-n
row (D-10, D-11, D-12), and the slices those rows affect name them in `gated-by`. No round returned
"none": the spec reaches "every guess resolved or owned by a D-n", not "no guesses".

## Other findings

- **Template friction.** The card asks for an "Observability" section, but the spec gate's complex
  whitelist has no such `##` section (only Problem, Goals, Slices, Acceptance criteria, Open
  decisions, Amendments). It sits as `### Observability` under Goals, the same workaround the
  `harnu:spec` spec uses for reference material under Problem.
- **The benchmark is a hard dependency.** S-2's replay scores with the scorecard that the parallel
  benchmark unit (stp-2) ships. Its exported function, its arguments and its key paths are unknown
  while both specs are being written, so the spec blocks S-2 on an Amendments row that copies them
  from the merged benchmark spec. The user-turn rule here must also match stp-2's M1 rule; this
  spec says the benchmark wins on a conflict.
- **The card's slicing was adjusted.** The suggested S-1 became S-1 (pure core) and S-2 (engine),
  because `memory-digest.ts` imports Electron through `responder-registry.ts` and cannot be unit
  tested in place; the Cleanup UI got its own slice (S-6); acceptance measurement is S-9.
