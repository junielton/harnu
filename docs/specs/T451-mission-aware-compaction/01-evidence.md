# T451 — Evidence: the runs and the measurements

Part of [`00-spec.md`](00-spec.md). Every number the spec uses is measured here, with its method.
All live runs used `claude -p --model haiku` on Claude Code **2.1.296** (the version every run's
`system` event and transcript rows report; the CLI updated itself from 2.1.295 during the
session), from a scratch working directory, with `--debug-file`. They cost USD 0.97 in total,
USD 0.80 of it the void RUN-0. Paths under the session scratchpad are written `<scratchpad>`.

## 1. Measurements on this machine

### MEAS-1 — How often sessions compact

Method: count `"subtype":"compact_boundary"` rows in every transcript under `~/.claude/projects/`,
read each boundary's `compactMetadata.trigger`, and split main transcripts from subagent ones
(`*/subagents/*`). Retention on this machine keeps about 30 days (10 777 of the 10 791 main
transcripts were modified after 2026-09-09).

| Fact                                                       | Count                                    |
| ---------------------------------------------------------- | ---------------------------------------- |
| main transcripts / subagent transcripts                    | 10 791 / 1 388                           |
| main transcripts with ≥ 1 000 rows / ≥ 3 000 rows          | 194 / 39                                 |
| transcripts with at least one compaction                   | 27 (all main; none in a subagent)        |
| compactions                                                | 37: 19 `auto`, 18 `manual`               |
| compactions per compacted session                          | 1 × 20 sessions, 2 × 4, 3 × 3            |
| compacted sessions whose first prompt is a dispatch packet | 7 executor packets + 1 dispatched lander |

The dispatch rule: the first non-meta user prompt opens with an executor or lander assignment
("You are the EXECUTOR for card …" or its Portuguese equivalent). Most transcripts are short
(Scheduler ticks, `-p` runs), so the useful denominator is the long sessions: 27 compacted out of
194 with ≥ 1 000 rows. Half of all compactions are `auto`, so the mechanism must work for the
engine's own threshold, not only for `/compact` (RUN-6 covers it).

### MEAS-2 — What the summary keeps of an executor's acceptance criteria

Method: for each of the 8 dispatched compacted sessions, take the AC ids
(`\b(?:AC|U|C|S)-?[A-Z0-9]*-?\d+\b`) in the dispatch packet and, where the packet names a card
file (`…/roadmap/<slug>.md`), in that card file as it stands today; count how many appear in each
compaction summary (`isCompactSummary` rows).

| Packet carries                        | Sessions | AC ids kept by the summary                                 |
| ------------------------------------- | -------- | ---------------------------------------------------------- |
| the ACs inline (4 ids)                | 3        | 4 / 4 in each                                              |
| a pointer to a card file holding them | 3        | 2 / 7, 2 / 10, 2 / 10; the card path itself lost in 1 of 3 |
| neither                               | 2        | —                                                          |

Summaries were 17 600 to 42 025 characters. The finding that matters: when the ACs live in a card
the executor read with a tool (the common shape: T451's own packet points at its card), the
summary keeps a fifth of them, and once it lost the path that would let the session read them
again. The caveat: the card files were read as they stand now, not as they stood at dispatch.

### MEAS-3 — How big an AC section is

Method: every card under `.harnu/memory/roadmap/` (578 files), the text under each heading matching
`^#{2,}\s+(?:[\w-]+\s+)?acceptance criteria\b` (case-insensitive) up to the next `## `
heading. 259 cards have one. Characters: p50 984, p90 2 504, max 10 252. List items: p50 6, p90
10, max 50. The broader heading pattern is needed: T451's own card titles its sections "Unit
acceptance criteria" and "Common acceptance criteria", which the board's readiness lint
(`ACCEPTANCE_HEADING_RE = /^##\s+Acceptance criteria\b/im`, `src/main/roadmap-core.ts:1276`)
does not match.

### MEAS-4 — How big a brief is

Method: the builder model in §4 of this file (the algorithm of 00-spec.md §7–§8, in Python), run
on every custom step of the 17 missions in `.harnu/missions/` that carries a `session` or `card`
link: 84 steps, 42 of them with a card holding acceptance criteria.

| Brief                      | p50   | p90 (round 1 / round 2) | max    |
| -------------------------- | ----- | ----------------------- | ------ |
| untrimmed (no budget)      | 1 829 | 4 626 / 5 448           | 19 062 |
| at `BRIEF_MAX_CHARS` 6 000 | —     | —                       | 5 920  |

The data is live: between the two runs of the model (round 1, then round 2 after review) the
missions gained Log notes, which moved p90 from 4 626 to 5 448 characters. Both times 5 of 84
briefs needed trimming; in all 5, shortening AC lines and dropping file names sufficed, and no AC
line was dropped. T451's own brief was 3 581 characters when RUN-5 and RUN-6 injected it (§3); with
the step's newer Log notes it would be 4 481. Round 2's model also adds the "(+k more blockers)"
line of spec §7; no step here has more than 5 open blockers.

### MEAS-7 — How cards and missions name their sessions

Method: the frontmatter of every card under `.harnu/memory/roadmap/` and every mission under
`.harnu/missions/`, round 2 (2026-10-09). 53 cards have a filled `session:` field: 44 hold
`synthetic-<uuid>` (the id a board or manifest dispatch creates, never rewritten after the session
materializes), 9 a real transcript uuid. 10 of the 17 missions carry `linkedCard`. The round-1
verifier counted 52 bound cards, 44 synthetic; one more was dispatched since.

### MEAS-5 — How long a compaction takes

From the `compact_boundary` rows of RUN-6 (`compactMetadata.durationMs`): 9 007 ms and 12 348 ms
(`auto`, 70 k tokens before, 16 k after). From the hook logs of RUN-1 and RUN-2: about 8 to 11 s
for an idle `manual` compaction of a 30 k-token conversation. T389 smoke C2 recorded 14 to 37 s
for an idle compaction (`resources/companion/hooks/contract.ts:63-64`). This is the window a
refresh issued at the start of a compaction has to land in (00-spec.md §8.3).

### MEAS-6 — Cache cost

From the `usage` of each turn's `result` event (`cache_creation_input_tokens` = cw,
`cache_read_input_tokens` = cr):

| Turn after a compaction       | With the brief (RUN-5) | Control, no brief (RUN-5c) |
| ----------------------------- | ---------------------- | -------------------------- |
| first turn after compaction 1 | cw 18 618, cr 13 464   | cw 16 968, cr 13 464       |
| first turn after compaction 2 | cw 18 965, cr 13 464   | cw 16 628, cr 13 464       |

The first request after any compaction rewrites everything past the shared system prompt (cr stays
at the ~13.5 k shared prefix in both columns), so a brief costs its own size once, written into
the cache with the rest (the differences, 1 650 and 2 337 tokens, also include the two runs'
different summaries). These figures **exclude the compaction call itself**: the summarizer's own
request reports no usage in the `/compact` turn's `result` (cw 0, cr 0 in every run), and T389
smoke D7 found compaction spend in no `turn.complete` (`P4W5-compaction-digest.md:59`). The brief
does not change that call, since it is added after it. In RUN-1 a mid-session `$.ui.invalidate("prompt.context")` changed nothing
that was sent: that turn wrote 1 393 tokens and read 30 692.

## 2. The runs

The probe (§4) stamps each of four injection paths with a generation number, the count of
compactions the process has seen, so a word the summarizer copied (generation n − 1) cannot pass
for a re-injected one (generation n):

| Path     | Mechanism                                                                                       | Sentinel               |
| -------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| compose  | `prompt.compose`: one `session` section appended to `next(e)`'s sections                        | `SYS-SENTINEL-<n>`     |
| context  | `prompt.context`: one block appended to `next(e)`'s blocks                                      | `CTX-SENTINEL-<n>.<r>` |
| messages | `session.compact`: one `{ role: 'user', text, toolUses: [] }` appended to the result's messages | `MSG-SENTINEL-<n>`     |
| append   | `session.compact`: `$.clock.after(1500, () => $.session.append(...))` after the compaction      | `APP-SENTINEL-<n>`     |

The question asked: "Without using any tool, list every string matching the regex
`[A-Z]+-SENTINEL-[0-9.]+` that you can see anywhere in your context right now … For each, say
where it is. If none, say NONE."

### RUN-1 — Four paths, two manual compactions, one process

Prompts: `OK`, `/compact`, question, `/compact`, question, `INVALIDATE-CTX` + `OK`, question.

After compaction 1 (the first time the question was asked, so nothing could be repeated):

```text
1. `SYS-SENTINEL-1`: in the system prompt, on its own line just before the WebSearch usage guidance.
2. `CTX-SENTINEL-1.0`: in the `# t451Probe` system-reminder block attached to the user turn.
3. `MSG-SENTINEL-1`: in the latest user message, on the `[t451-probe] MSG-SENTINEL-1` line.
4. `APP-SENTINEL-1`: in the latest user message, on the `[t451-probe] APP-SENTINEL-1` line.

I found no matches in the compaction summary or the earlier conversation.
```

After compaction 2 the model listed `SYS-SENTINEL-2`, `CTX-SENTINEL-2.0`, `MSG-SENTINEL-2` and
`APP-SENTINEL-2`, which did not exist before that compaction, plus the generation-1 strings,
which it placed in the summary (the summary kept its own earlier answer). The answer after the
`INVALIDATE-CTX` turn was word for word the previous one and is not evidence; the transcript is:
`CTX-SENTINEL-2.1` was never stored, although the hook ran again with `ctxRev: 1`.

The hook log (fields trimmed):

```text
{"ev": "compose", "gen": 0}
{"ev": "context", "gen": 0, "ctxRev": 0, "blocks": ["claudeMd", "userEmail", "currentDate"]}
{"ev": "compose", "gen": 0}
{"ev": "compact", "trigger": "manual", "gen": 1, "messagesIn": 2, "messagesOut": 1, "summaryChars": 2687, "tokensBefore": 30412, "tokensAfter": 8703}
{"ev": "compose", "gen": 1}
{"ev": "context", "gen": 1, "ctxRev": 0, "blocks": ["claudeMd", "userEmail", "currentDate"]}
{"ev": "compose", "gen": 1}
{"ev": "compact", "trigger": "manual", "gen": 2, "messagesIn": 7, "messagesOut": 1, "summaryChars": 3120, "tokensBefore": 31985, "tokensAfter": 8811}
{"ev": "compose", "gen": 2}
{"ev": "context", "gen": 2, "ctxRev": 0, "blocks": ["claudeMd", "userEmail", "currentDate"]}
{"ev": "compose", "gen": 2}
{"ev": "invalidate", "gen": 2, "ctxRev": 1}
{"ev": "compose", "gen": 2}
{"ev": "context", "gen": 2, "ctxRev": 1, "blocks": ["claudeMd", "userEmail", "currentDate"]}
```

`prompt.compose` runs before every request; `prompt.context` runs once per process start and once
after each compaction, and once more after the invalidation (whose answer was not sent).

### RUN-2 — Two compactions with no question in between

Prompts: `OK`, `/compact`, `OK`, `/compact`, `OK`. Neither summary (2 652 and 2 977 characters)
holds any sentinel: the summarizer copied none of the system-prompt, context or row text. This is
the transcript RUN-3 resumes.

### RUN-3 — `--resume` in a new process

`claude -p --resume <RUN-2 id> --fork-session` with the question, once without the probe and once
with it.

Without the probe:

```text
Four strings match:

1. `SYS-SENTINEL-2`: in the system prompt, in the block that begins "WebSearch takes a `mode`."
2. `CTX-SENTINEL-2.0`: in the `# t451Probe` system-reminder at the start of the conversation.
3. `MSG-SENTINEL-2`: in the user message that starts "[t451-probe]", ahead of the `/compact` command.
4. `APP-SENTINEL-2`: in the user message that starts "[t451-probe]", after the `/compact` output.
```

With the probe, the same four, generation 2, although the new process's probe started at
generation 0 and its `prompt.compose` and `prompt.context` hooks ran (its log shows both with
`gen: 0`). The transcript explains it: the engine stores what it sent as attachment rows,
`{ type: 'prompt_snapshot', systemPrompt: [...] }` and `{ type: 'context_sections', sections:
[{ name: 't451Probe', text: 'CTX-SENTINEL-2.0' }] }`, one set per compaction epoch, and a
resumed process replays them. So on 2.1.296 all four paths survive a resume, and the two prompt
paths survive it **frozen**: a resumed process cannot change them until the next compaction.

The `messages` row is stored as an ordinary user row (`type: 'user'`, no `isMeta`, no `origin`);
the `append` row is stored `isMeta: true`, `origin: { kind: 'plugin', name: 't451-probe' }`.

An earlier resume of RUN-1's transcript is void: there the question had already been asked and
the model repeated its last answer.

### RUN-4 — Do subagents see it?

One prompt, with the probe: "Use the Agent tool exactly once (subagent_type general-purpose) with
this prompt: '… list every string matching … in your own context …' Then report the subagent's
answer verbatim." Answer: `CTX-SENTINEL-0.0` … "It appears once, in the ambient `t451Probe`
context block." The subagent saw the context block and not the system-prompt section; the probe's
`prompt.context` hook ran once (the subagent reused the main conversation's blocks). A
`prompt.context` block therefore reaches every Agent-tool subagent the session starts.

### RUN-5 — The real brief, two manual compactions; and a control

With the prototype of [`02-prototype.md`](02-prototype.md) loaded. Prompts: the delivery
(`/harnu-brief-proto {"rev":1,"text":<T451's brief, §3>}`), `OK`, `/compact`, `OK`, `/compact`, then:
"Without using any tool, answer three questions from what is in your context right now. (1) Which
mission step do you build, by its id? (2) Quote the first twelve words of acceptance criterion
U-4. (3) Which file holds the full card? Answer UNKNOWN for any you cannot see."

```text
1. **Step:** stp-3 (3 of 9), in mission mnt-f92b3961.
2. **U-4, first twelve words:** "Size and staleness: a hard budget for the reinjected block, what gets"
3. **Full card:** `.harnu/memory/roadmap/T451-spec-mission-aware-compaction-the-mission-and-its-acs-survive.md`. I have only the path from the brief. I have not opened the file, so its full text is not in my context.
```

Neither summary (3 803 and 4 475 characters) contains U-4's text; both kept the mission and step
ids, which the delivery's command record had shown the model before compaction 1. The verbatim
quote after compaction 2 can only come from the re-injected row (stored twice, 3 581 characters,
once after each boundary).

RUN-5c, a trivial control (it proves nothing: with no delivery there is nothing to remember): the
same prompts without the delivery.

```text
(1) UNKNOWN. No mission step or step id appears in my context.

(2) UNKNOWN. I can't see acceptance criterion U-4 or any card text.

(3) UNKNOWN. I don't have a file path for a full card.
```

RUN-5f, the fair control (round 2): no mod; the same brief pasted inline as the first user message
("Here is your mission brief; keep it in mind for later questions. Reply with the single word OK."
followed by the brief), then `OK`, `/compact`, `OK`, `/compact` and the same question. Neither
summary held U-4's opening words; the second had shrunk to 1 062 characters. USD 0.02.

```text
(1) **UNKNOWN.** My context has no mission step id.

(2) **UNKNOWN.** My context has no acceptance criterion U-4, so I can't quote it.

(3) **UNKNOWN.** My context names no file holding a full card. The earlier transcript is at a path in the continuation note, but I haven't read it because you asked for no tool use.
```

The round-1 verifier ran the same shape (its run `vD`) and got the step id back plus a paraphrase:
"First twelve words of U-4: UNKNOWN. I only have a paraphrase of U-4 from my summary, not the
card's wording. The paraphrase begins: 'Size and staleness. Set a hard budget for the reinject…'".
Two runs of one design, two outcomes: what a summary keeps varies. **The deciding evidence for
RUN-5 and RUN-6 is the summary grep**: no summary held U-4's text, and the model quoted it word for
word, so the words came from the re-injected row.

**The `last-prompt` rows.** In RUN-5's transcript the engine wrote a `last-prompt` row after each
compaction whose `lastPrompt` is the re-injected brief:

```text
last-prompt: 'Reply with the single word OK.'
last-prompt: 'Reply with the single word OK.'
last-prompt: 'Reply with the single word OK.'
-- boundary
last-prompt: '[Harnu mission brief rev 1 · 2026-10-09T20:00Z] Written by Harnu from '
last-prompt: 'Reply with the single word OK.'
last-prompt: 'Reply with the single word OK.'
-- boundary
last-prompt: '[Harnu mission brief rev 1 · 2026-10-09T20:00Z] Written by Harnu from '
last-prompt: 'Without using any tool, answer three questions from what is in your co'
```

RUN-6 shows the same after each `auto` boundary. Harnu reads that row as the session's "what's
happening now" (spec §8.5).

### RUN-6 — Two `auto` compactions

As RUN-5, with six filler messages of about 13 k tokens each in place of the `/compact` prompts,
and `CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000` (the variable that sets the compaction window,
TYPES:2299-2306). Two boundaries, both `trigger: 'auto'` (70 459 → 15 874 and 70 466 → 16 447
tokens), each followed by the brief row; neither summary (3 457, 5 792 characters) holds U-4's
text. The answer:

```text
1. **stp-3**, the step "T451 mission-aware compaction spec, approved + PR open."

2. **U-4:** "Size and staleness: a hard budget for the reinjected block, what gets"

3. **`.harnu/memory/roadmap/T451-spec-mission-aware-compaction-the-mission-and-its-acs-survive.md`**, as named in the mission brief. I have not opened it, so I can't confirm its contents.
```

The debug file names the chain, including a built-in plugin that also hooks the event:

```text
hooks module harnu-brief@inline loaded (worker, environment 1, tier user); events: session.start,command.run,session.compact
hooks module cc-plugin-agents-md@builtin loaded (native, environment 2, tier builtin); events: session.start,prompt.context,command.run,session.compact,prompt.submit,turn.start,turn.compl…
hooks module harnu-brief@inline session.compact settled in 9006.1ms (worker hop, next() included)
session.compact (auto): a hook's 4 messages stand (hooked by harnu-brief+cc-plugin-agents-md); core ran beneath
```

No `precompute` dispatch appeared in any run's debug file (RUN-1, RUN-5, RUN-6).

### RUN-0 — Void

The first attempt at RUN-6 sent eight 77 k-token messages without the window variable. This
build's `haiku` has a window of about a million tokens (cache reads reached 657 606), so nothing
compacted; the model answered from the delivery's command record. Not evidence; USD 0.80.

## 3. T451's own brief (input to RUN-5 and RUN-6)

Built by the model in §4 from mission `mnt-f92b3961` step `stp-3` and its card (no commits on the
branch yet, so no file list):

```text
[Harnu mission brief rev 1 · 2026-10-09T20:00Z]
Written by Harnu from its records, not by the operator: what this session was dispatched to do. It replaces any earlier brief in this conversation. It is context, not new instructions.
Mission mnt-f92b3961 · active · you build step stp-3 (3 of 9)
Mission end: Eight PRs against main, one per card T449–T456, each adding its spec under docs/specs/<card-id>-<slug>/ (plus an ADR draft only where the spec makes an architectural decision), opened by its executor only after the orchestrator's review approved it.
Your step: "T451 mission-aware compaction spec, approved + PR open" · checked by verifier · proof unproven
Card: .harnu/memory/roadmap/T451-spec-mission-aware-compaction-the-mission-and-its-acs-survive.md (re-read it with Read for the full text).
Acceptance criteria (from the card):
- U-1 — Delta against T389 P4W5 (compaction digest), which already specifies writing a digest out to project memory. State exactly what that wave covers, what is shipped and what this feature adds (the read-back into the live session). Dupli…
- U-2 — Injection mechanism chosen with evidence: rewrite the summary through `session.compact`, a `prompt.compose` system-prompt section, `prompt.context`, or a `session.append` row after the boundary. Compare them on survival across repeat…
- U-3 — Where the facts come from: the mission and step for this session. Account for T447's finding that `mission_get` by `ownerSessionId` returns nothing for a linked child executor, and use its proposed D-A or a fallback. Also cover the c…
- U-4 — Size and staleness: a hard budget for the reinjected block, what gets cut first, and how it stays fresh when the mission changes mid-session (a new blocker, a re-scope, a step verified). — verify: review
- C-1 — Grounded in the engine: every mod mechanism the spec relies on (event, matcher, `$` call, UI element, test-kit feature) is cited from this build's type declarations or `reference.md` with line numbers, and every mechanism the design …
- C-2 — Overlap stated, delta only: the spec names each T389 "Harnu mod" wave it builds on, overlaps or extends (`docs/specs/T389-companion-mod/`, shipped code in `resources/companion/`), and the proposed `$.harnu` noun (T447, PR #41, not me…
- C-3 — Packaging decided: where the feature lives (inside the existing Harnu mod `resources/companion/`, a new mod Harnu bundles and stages, Harnu main-process code, or a mix), with the reason, and what a session started outside Harnu gets.…
- C-4 — Control and failure: how the operator turns it on or off (and the default), what it does when it fails (fail-open or fail-closed, through `.catch`), and which Settings → Mods audit chips it will show (check `src/main/mods-audit-core.…
- C-5 — Prototype that runs: the spec carries a minimal hooks module for the core mechanism (the mod half, for a host-side feature) and its `*.test.ts`, and pastes the real output of `claude plugin validate`, `claude plugin test` and a `tsc …
- C-6 — Implementation outline and contracts: waves or slices sized S/M/L in dependency order, and the repo contracts the implementation will owe (CHANGELOG, `docs/harnu-features.md` + marker, `docs/user/`, `design.md` + both i18n locales fo…
- C-7 — Open questions in their own section, each with who decides. — verify: review
- C-8 — Repo contracts hold: English only, no real client identifiers (neutral vocabulary in `CLAUDE.md`), `npx prettier --check` passes on every new file, and `npx vitest run tests/no-client-identifiers.test.ts` passes. — verify: test
Open blockers: none
```

## 4. Sources of the runs

The probe, `<scratchpad>/probe/t451-probe/hooks/register.ts` (its `plugin.json` and `hooks.json`
are the three-file layout of [`02-prototype.md`](02-prototype.md) §2; `claude plugin validate`
passed):

```ts
import type { EngineInterface, Register } from 'claude-code'

// T451 probe. Four ways to put a fact in front of the model, each carrying a
// sentinel stamped with the number of compactions this process has seen, so
// a word the summarizer copied (generation n-1) cannot pass for a re-injected
// one (generation n).
let gen = 0
let ctxRev = 0
const log: unknown[] = []

async function note($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  log.push({ at: await $.clock.now(), ...entry })
  const path = await $.env.get('T451_PROBE_LOG')
  if (path) await $.fs.write(path, log.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

export const register: Register = (on) => {
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) {
      await note($, { ev: 'compact.pass', trigger: e.trigger, agentId: e.agentId ?? null })
      return next(e)
    }
    gen += 1
    const g = gen
    const r = await next(e)
    if (r.skip !== undefined) return r
    await note($, {
      ev: 'compact',
      trigger: e.trigger,
      gen: g,
      messagesIn: e.messages.length,
      messagesOut: r.messages.length,
      summaryChars: r.messages[0]?.text.length ?? 0,
      tokensBefore: r.tokensBefore ?? null,
      tokensAfter: r.tokensAfter ?? null
    })
    $.clock.after(1500, () => {
      void $.session.append({
        message: {
          type: 'user',
          content: [{ type: 'text', text: `[t451-probe] APP-SENTINEL-${g}` }]
        }
      })
    })
    return {
      ...r,
      messages: [
        ...r.messages,
        { role: 'user', text: `[t451-probe] MSG-SENTINEL-${g}`, toolUses: [] }
      ]
    }
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    await note($, { ev: 'context', gen, ctxRev, blocks: r.blocks.map((b) => b.name) })
    return {
      ...r,
      blocks: [...r.blocks, { name: 't451Probe', text: `CTX-SENTINEL-${gen}.${ctxRev}` }]
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    await note($, { ev: 'compose', gen, traits: e.traits, ids: r.sections.map((s) => s.id) })
    return {
      sections: [
        ...r.sections,
        { id: 't451-probe:brief', text: `SYS-SENTINEL-${gen}`, scope: 'session' as const }
      ]
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.text.includes('INVALIDATE-CTX')) {
      ctxRev += 1
      $.ui.invalidate('prompt.context')
      await note($, { ev: 'invalidate', gen, ctxRev })
    }
    return next(e)
  })
}
```

The driver: one `claude` process over `stream-json`, one prompt at a time, each sent after the
previous `result`, with a 3 s pause for the deferred append:

```python
"""Drive one claude process over stream-json: send each prompt, wait for its result."""
import json, subprocess, sys, os, time
plugin, out_dir, label = sys.argv[1], sys.argv[2], sys.argv[3]
prompts = json.loads(open(sys.argv[4]).read())
env = dict(os.environ, T451_PROBE_LOG=os.path.join(out_dir, f'{label}.hooklog.ndjson'))
args = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--model', 'haiku', '--max-budget-usd', os.environ.get('T451_BUDGET', '1.00'), '--debug-file', os.path.join(out_dir, f'{label}.debug.log')]
if plugin != '-':
    args += ['--plugin-dir', plugin]
cwd = os.path.join(out_dir, 'cwd'); os.makedirs(cwd, exist_ok=True)
proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env, cwd=cwd)
events = open(os.path.join(out_dir, f'{label}.events.ndjson'), 'w')
for i, text in enumerate(prompts):
    proc.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}}) + '\n'); proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line: break
        events.write(line); events.flush()
        o = json.loads(line)
        if o.get('type') == 'result':
            u = o.get('usage', {})
            print(f"#{i} {text[:40]!r} -> {str(o.get('result'))[:300]!r} | in={u.get('input_tokens')} cw={u.get('cache_creation_input_tokens')} cr={u.get('cache_read_input_tokens')}", flush=True)
            break
    time.sleep(3)  # let a deferred append (1.5 s) land before the next prompt
proc.stdin.close(); proc.wait(timeout=120)
```

The brief builder model (MEAS-4, §3), in Python for the measurement only; the implementation is
TypeScript in Harnu main (00-spec.md §14):

```python
"""Model of the T451 brief builder (spec §6.2): mission + step + card ACs + blockers + step log + files.
Reads real records; prints the framed text (or size stats with --stats)."""
import glob, json, os, re, subprocess, sys
import yaml  # PyYAML

ROOT = '<main checkout>'
BRIEF_MAX = 6000
AC_LINE_MAX = 240
FILES_MAX = 10
LOG_MAX = 3
LOG_LINE_MAX = 300
BLOCKERS_MAX = 5
AC_HEADING = re.compile(r'^#{2,}\s+(?:[\w-]+\s+)?acceptance criteria\b.*$', re.I | re.M)

def clip(s, n):
    s = ' '.join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + '…'

def parse_mission(path):
    raw = open(path).read()
    fm = raw.split('---', 2)[1]
    m = yaml.safe_load(fm)
    log = raw.split('\n## Log', 1)[1] if '\n## Log' in raw else ''
    entries = re.split(r'^### ', log, flags=re.M)[1:]
    return m, entries

def ac_lines(body):
    out = []
    for h in AC_HEADING.finditer(body):
        rest = body[h.end():]
        nxt = re.search(r'^##\s', rest, re.M)
        sec = rest[: nxt.start()] if nxt else rest
        for line in sec.splitlines():
            t = line.strip()
            if re.match(r'^(?:[-*]\s|\d+\.\s)', t):
                t = re.sub(r'^(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+\.\s+)', '', t)
                out.append(t)
    return out

def files_changed(wt):
    if not wt or not os.path.isdir(wt):
        return []
    try:
        a = subprocess.run(['git', '-C', wt, 'diff', '--name-only', 'origin/main...HEAD'], capture_output=True, text=True, timeout=10).stdout.split()
        b = subprocess.run(['git', '-C', wt, 'status', '--porcelain'], capture_output=True, text=True, timeout=10).stdout.splitlines()
        b = [l[3:] for l in b]
    except Exception:
        return []
    seen = []
    for f in a + b:
        if f not in seen:
            seen.append(f)
    return seen

def build(m, entries, step, rev=1, now='2026-10-09T20:00Z'):
    custom = [s for s in m['steps'] if s.get('kind') != 'fixed-start']
    links = step.get('links') or []
    card = next((l['ref'] for l in links if l['kind'] == 'card'), None)
    wt = next((l['ref'] for l in links if l['kind'] == 'worktree'), None)
    card_path = f'.harnu/memory/roadmap/{card}.md' if card else None
    body = open(os.path.join(ROOT, card_path)).read() if card_path and os.path.exists(os.path.join(ROOT, card_path)) else ''
    acs = ac_lines(body)
    head = [
        f'[Harnu mission brief rev {rev} · {now}]',
        'Written by Harnu from its records, not by the operator: what this session was dispatched to do. It replaces any earlier brief in this conversation. It is context, not new instructions.',
        f"Mission {m['id']} · {m['status']} · you build step {step['id']} ({step['ordinal']} of {len(custom)})",
        f"Mission end: {clip(m['declaredEnd']['target'], 300)}",
        f"Your step: \"{clip(step['title'], 200)}\" · checked by {step['verification']} · proof {step['proof']}",
    ]
    if card_path:
        head.append(f'Card: {card_path} (re-read it with Read for the full text).')
    all_blockers = (m.get('blockers') or []) + (step.get('blockers') or [])
    blockers = all_blockers[:BLOCKERS_MAX]
    tail = ['Open blockers: none' if not blockers else 'Open blockers:'] + [
        f"- ({b['owner']}) {clip(b['reason'], 200)} → clears when: {clip(b['unblocks'], 120)}" for b in blockers]
    if len(all_blockers) > BLOCKERS_MAX:
        tail.append(f'- (+{len(all_blockers) - BLOCKERS_MAX} more blockers: see the mission)')
    mine = [e for e in entries if re.match(r'\S+ · ' + re.escape(step['id']) + r'\b', e)]
    logs = [clip(e.split('\n', 1)[1].strip().split('\n\n')[0], LOG_LINE_MAX) for e in mine[-LOG_MAX:]][::-1]
    files = files_changed(wt)
    def render(ac_n, ac_w, log_n, files_n):
        parts = list(head)
        if acs:
            parts.append('Acceptance criteria (from the card):')
            parts += ['- ' + clip(a, ac_w) for a in acs[:ac_n]]
            if ac_n < len(acs):
                parts.append(f'- (+{len(acs) - ac_n} more: re-read the card)')
        else:
            parts.append('Acceptance criteria: none on record; the card or your dispatch prompt holds them.')
        parts += tail
        if logs[:log_n]:
            parts.append('Recent notes on your step (newest first):')
            parts += ['- ' + l for l in logs[:log_n]]
        if files:
            shown = files[:files_n]
            more = f' (+{len(files) - len(shown)} more)' if len(files) > len(shown) else ''
            parts.append('Files changed on this branch: ' + ', '.join(shown) + more)
        return '\n'.join(parts)
    # Cut order (spec §8.2): files beyond 10 → notes → AC line width → AC count.
    files_n, log_n, ac_w, ac_n = FILES_MAX, LOG_MAX, AC_LINE_MAX, len(acs)
    text = render(ac_n, ac_w, log_n, files_n)
    while len(text) > BRIEF_MAX and files_n > 0:
        files_n -= 1; text = render(ac_n, ac_w, log_n, files_n)
    while len(text) > BRIEF_MAX and log_n > 0:
        log_n -= 1; text = render(ac_n, ac_w, log_n, files_n)
    while len(text) > BRIEF_MAX and ac_w > 120:
        ac_w -= 20; text = render(ac_n, ac_w, log_n, files_n)
    while len(text) > BRIEF_MAX and ac_n > 0:
        ac_n -= 1; text = render(ac_n, ac_w, log_n, files_n)
    untrimmed = render(len(acs), 10**6, LOG_MAX, 10**6)
    return text, dict(acs=len(acs), shown=ac_n, width=ac_w, untrimmed=len(untrimmed), final=len(text))

if __name__ == '__main__':
    if sys.argv[1] == '--stats':
        rows = []
        for p in sorted(glob.glob(ROOT + '/.harnu/missions/*.md')):
            m, entries = parse_mission(p)
            for s in m['steps']:
                if s.get('kind') == 'custom' and any(l['kind'] in ('session', 'card') for l in s.get('links') or []):
                    _, st = build(m, entries, s)
                    rows.append(st)
        fin = sorted(r['final'] for r in rows); un = sorted(r['untrimmed'] for r in rows)
        withac = [r for r in rows if r['acs']]
        q = lambda xs, p: xs[int(p * (len(xs) - 1))]
        print(json.dumps(dict(steps=len(rows), with_card_acs=len(withac),
            untrimmed_p50=q(un, .5), untrimmed_p90=q(un, .9), untrimmed_max=un[-1],
            final_max=fin[-1], trimmed=sum(1 for r in rows if r['untrimmed'] > BRIEF_MAX),
            ac_lines_dropped=sum(r['acs'] - r['shown'] for r in rows))))
    else:
        m, entries = parse_mission(glob.glob(ROOT + f'/.harnu/missions/{sys.argv[1]}-*.md')[0])
        step = next(s for s in m['steps'] if s['id'] == sys.argv[2])
        text, st = build(m, entries, step, rev=int(sys.argv[3]) if len(sys.argv) > 3 else 1)
        print(text); print(json.dumps(st), file=sys.stderr)
```
