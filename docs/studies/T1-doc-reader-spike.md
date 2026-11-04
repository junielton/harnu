# T1 spike: a Haiku doc-reader behind an enforcing read gate

**Date:** 2026-11-02. **Claude Code:** 2.1.316. **Main model in every run:** Sonnet.
**Verdict: go**, for an opt-in, docs-only bundled feature, on the conditions in [Recommendation](#recommendation).

## The question

Spotify's `shunt` plugin ([article](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90),
[source](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt), Apache-2.0) claims about 90% fewer
main-model tokens. A `PreToolUse` hook refuses full reads of large files and sends them to a cheap model, which
answers a question about them. Shunt's transport (Spotify Portal, AiKA, Gemini Flash) does not exist for Harnu users,
and its 90% compares summary size with raw file size, not a measured session. This spike asks whether the same
pattern works with Haiku as a native Claude Code subagent, for documentation, and what it really saves.

## What was built

| Piece           | Where                                | What it is                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The gate rule   | `src/main/doc-reader/gate-core.ts`   | A pure decision: deny a full `Read` (or a bare `cat`/`less`/`more`/`bat`) of a doc file (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc`) over 350 lines, made by the **main thread**. The deny reason names the agent and the escape hatch (`offset`/`limit`). |
| Layer 1 tests   | `tests/doc-reader-gate-core.test.ts` | 16 routing cases, run in CI.                                                                                                                                                                                                                                        |
| The eval plugin | `evals/doc-reader/`                  | The rule bundled into a command hook, plus `agents/doc-reader.md` (`model: haiku`, tools `Read, Grep, Glob`), 11 cases over a pinned snapshot of five Harnu docs, and `run.sh` + `summarize.mjs`.                                                                   |

How the gate differs from shunt's hook:

- **It lets every subagent's call through.** Subagents cannot start subagents, so redirecting one strands it.
- **It treats `head`, `tail` and `sed -n` as targeted reads.** Shunt blocks them.
- **It only gates docs.** Code files pass in v1.

## Spike questions

**Q1. Can the hook tell the doc-reader's own reads apart? Yes.** With a probe plugin, a `PreToolUse` payload from
the main thread carries no `agent_id` or `agent_type`. One from the subagent carries `agent_id` and
`agent_type: "<plugin>:doc-reader"`. The gate allows any call that has either field.

**Q2. Does Harnu's staged plugin dir carry hooks and agents? No.** `stageSkillsForFolder`
(`src/main/bundled-skills.ts`) copies only `.claude-plugin/plugin.json` and `skills/<name>/`. `--plugin-dir` itself
loads `hooks/` and `agents/` fine, so this is a stager change, not a Claude Code limit.

**Q3. Does `claude plugin eval` fit the A/B? Yes, with one gap.**

- It runs a with-plugin arm and a no-plugin baseline arm and reports `score`, `costUsd`, `turns` and `durationSeconds` for each run.
- Fixtures go in through `context.scaffold_script`, which needs `--scaffold`. A top-level `scaffold_script` key is silently ignored.
- `regex`, `tool_used` and `llm` graders cover answer keys. A grader marked `arm: with-only` (every case's `routed-to-doc-reader`) is reported with `scored: false` and never moves the score, so a score of 1.00 means the answer was right, not that the run routed to Haiku.
- The gap: there is no split by model. `--keep-temp` keeps each run's trace, whose final `result` line has `modelUsage` by model. `summarize.mjs` reads it, and counts the main model's `Agent` calls and the reads the gate refused in each trace, so the routing columns below come from `summary.md`.

## Results

11 cases × 2 arms × 3 runs, Sonnet as the main model. Cost is the whole run, Haiku included, at API prices; grader
cost is excluded. "Main-in" is every input token the main model read, cache reads included.

### Variant A: read gate + Haiku doc-reader (`results/2026-11-02T20-01-34Z/summary.md`)

| case                   | kind               | score           | cost without → with        | main-in without → with | gate blocks / agent calls (of 3 runs) | secs    |
| ---------------------- | ------------------ | --------------- | -------------------------- | ---------------------- | ------------------------------------- | ------- |
| plan-overview          | summarize          | 1.00 → 1.00     | $0.145 → $0.046 (−68%)     | 49.9k → 41.2k          | 3 / 3                                 | 15 → 18 |
| summarize-browser-spec | summarize          | 1.00 → 1.00     | $0.229 → $0.078 (−66%)     | 171.4k → 48.6k         | 3 / 3                                 | 29 → 49 |
| list-message-errors    | full listing       | 1.00 → 1.00     | $0.234 → $0.066 (−72%)     | 161.6k → 51.2k         | 2 / 3                                 | 19 → 43 |
| cross-doc-caps         | two docs           | 1.00 → 1.00     | $0.378 → $0.107 (−72%)     | 201.8k → 72.4k         | 6 / 6                                 | 25 → 58 |
| budget-constraints     | fact               | 1.00 → 1.00     | $0.132 → $0.037 (−72%)     | 49.9k → 37.0k          | 1 / 1                                 | 4 → 7   |
| browser-partitions     | fact               | 1.00 → 1.00     | $0.121 → $0.052 (−57%)     | 56.6k → 29.1k          | 0 / 0                                 | 10 → 8  |
| path-jail              | fact               | 1.00 → 1.00     | $0.119 → $0.047 (−61%)     | 78.0k → 38.5k          | 0 / 0                                 | 8 → 6   |
| message-cap            | fact               | 1.00 → 1.00     | $0.102 → $0.046 (−54%)     | 88.3k → 39.9k          | 0 / 0                                 | 10 → 8  |
| terminal-limit         | fact               | 1.00 → 1.00     | $0.039 → $0.036 (−8%)      | 40.1k → 30.5k          | 0 / 0                                 | 7 → 5   |
| edit-threshold         | read, then edit    | 1.00 → 1.00     | $0.034 → $0.038 (+10%)     | 44.7k → 50.6k          | 0 / 0                                 | 7 → 7   |
| small-doc-control      | control (75 lines) | 1.00 → 1.00     | $0.027 → $0.028 (+3%)      | 23.6k → 23.9k          | 0 / 0                                 | 4 → 4   |
| **all cases**          |                    | **1.00 → 1.00** | **$1.559 → $0.580 (−63%)** | **966k → 463k (−52%)** | 15 / 16                               |         |

Haiku's own cost was at most $0.020 per run (cross-doc-caps), against the $0.07–0.27 of Sonnet tokens it removed.

### Variant B: Haiku doc-reader offered, no gate (`results/2026-11-02T20-08-31Z/summary.md`)

The same cases with the hook removed, to separate what the gate does from what the agent's presence does.

| case                   | cost without → with        | full reads by the main model (of 3 runs) | agent calls      |
| ---------------------- | -------------------------- | ---------------------------------------- | ---------------- |
| plan-overview          | $0.143 → $0.144 (+1%)      | 3                                        | 0                |
| summarize-browser-spec | $0.218 → $0.195 (−11%)     | 3                                        | 0                |
| list-message-errors    | $0.225 → $0.118 (−48%)     | 1                                        | 1                |
| cross-doc-caps         | $0.274 → $0.334 (+22%)     | 6                                        | 0                |
| the five fact cases    | −16% to −73%               | 0                                        | 1                |
| **all cases**          | **$1.467 → $1.073 (−27%)** |                                          | **2 in 33 runs** |

## Findings

1. **The gate is what earns the saving on whole-document work.** On summaries, full listings and cross-doc questions, the gate cut cost by 66–72%. Without the gate, Sonnet read the whole file every time and used the offered agent twice in 33 runs, which is shunt's point that advice is not enough. Overall, −63% with the gate against −27% without.
2. **After a block, the model complied every time.** All 15 blocks were followed by a doc-reader call, never by a retry or a failure.
3. **Fact lookups barely need the gate.** For "what is X in doc Y", Sonnet already greps and reads 10–30 lines (`offset`/`limit`), so the gate seldom fires. Those cases also got cheaper in both variants. The likely cause is the agent's description in the prompt ("too large to read whole") nudging Sonnet away from a first full read. That is an inference from the traces, not a proven mechanism.
4. **Editing is unaffected.** The read-then-edit case never tripped the gate: Sonnet greps, reads the section with `offset`/`limit`, and edits.
5. **It is slower.** Delegated runs took 1.2–2.3× as long (for example 29 s → 49 s, 19 s → 43 s). A delegation is a cold subagent start plus a full Haiku read.
6. **A command hook that needs `node` on PATH fails open silently.** Hooks run under `/bin/sh` with a minimal PATH. A version-manager `node` (nvm here) is not found, the hook exits 127 and every read passes. It looked like "the gate does nothing" until Claude Code's debug log showed the 127. The shipped version must not depend on the user's PATH.

## Limits of this evidence

- **Quality sits at the ceiling.** Every case scored 1.00 in both arms, so this suite shows no quality loss, and it also cannot detect a subtle one. Shunt's author reports a missed thread-safety bug. A harder suite would add questions where a summary drops the needed detail.
- **n = 3 per cell, and the noise is high.** The same baseline case ranged from 24.9k to 40.1k main-in tokens across runs. Per-case percentages are noisy; the totals and the direction are the result.
- **One threshold, one doc size.** Every gated doc had 1,112–1,549 lines. Nothing here supports 350 over, say, 800. That needs docs of 400–800 lines.
- **Single-question tasks.** In a long session a doc read whole stays in context and is re-read from cache on every later turn. The gate avoids that, which this suite does not measure, so the real saving may be larger. Follow-up questions re-send the doc to Haiku, which this suite does not measure either.
- **The gate is cooperative, not enforcing.** A `Read` with any `offset` or `limit` passes whatever the span, so `offset: 1, limit: 5000` reads the whole doc. On Bash it judges only the first command before a chain, and lets pipes and redirects through. No run tried to get around it, but nothing stops one.
- **API prices.** For subscription users the saving is plan quota and fewer compactions, not dollars.

## Recommendation

Ship it as an **opt-in bundled feature, docs only**, default threshold 350, with:

1. **Stager change.** `stageSkillsForFolder` stages `agents/doc-reader.md` and the gate hook when the feature is enabled for the folder. It must never stage them into a Scheduler `observe` tick: no `Agent` tool there, so a blocked read would strand the worker.
2. **Transport: the Hook Bridge, not a PATH `node`.** Use a `type: "http"` `PreToolUse` hook to the loopback Hook Bridge, which calls `decideDocRead` in the main process. It fails open when Harnu is not running. Keep the matcher at `Read|Bash`, and answer `{}` fast for everything that is not a doc read.
3. **A span cap on `Read`.** A `Read` of a large doc passes only when `limit` is set and is at most the threshold. `offset` alone reads to the end of the file, so it counts as a full read. Re-run the edit case, because that path is where a cap could hurt.
4. **Before calling it done:**
   - add a harder quality suite (detail-dropping questions);
   - sweep the threshold over 400–800-line docs;
   - run one long multi-turn task to measure the compounding effect.

## Rerunning

```bash
evals/doc-reader/run.sh --runs 3 -j 3                        # variant A (gate + agent)
evals/doc-reader/run.sh --runs 3 -j 3 --variant agent-only   # variant B (agent only)
evals/doc-reader/run.sh --runs 1 --case plan-overview        # one case
```

Each full variant is 66 Sonnet runs on your own credential: $6.42 (variant A) and $7.62 (variant B) here at API prices, plus a few cents of grader cost. The table totals above are sums of per-case means, i.e. one run of each case.
`HARNU_DOC_READER_DEBUG=<file>` makes the hook log every payload and decision.
