---
name: report-back
effort: low
description: "The shared final-report format for any multi-step run: a flat rail of executed steps (✓/-/!/✗ with concrete outcomes), a gutter ledger for what is owed (`you` — always printed, `— nothing, you're clear` when nothing is) and any open question, a links list of everything the reader might open, and a summary of at most 3 lines. Use it whenever a task involved a pipeline or several sequential steps and you're about to write the wrap-up message — shipping a PR, reconciling branches, a deploy, a batch of file changes, a scaffold — or whenever the operator asks 'what did you do?', 'summarize what was done', 'where is the report?', or complains a final summary was a wall of prose. Other pipeline skills reference this as their output contract. Do NOT use for simple Q&A — a question gets a direct answer, not a report."
---

# Report Back (final-report format)

The last message of a multi-step run is read by someone who walked away while it
ran. They don't want the story; they want to scan what happened, spot the one
thing that needs them, and move on.

The format has three blocks in one fenced code block, separated by blank lines:
a **rail** for the trace, a **ledger** for the state, a **list** for the links.
Each block uses the layout that fits what it carries — a rail where there is a
real sequence, a column where the eye should learn a position, no alignment at
all where URLs will wrap.

```
avatar-cache  ▰▰▰▰▰▰▰▱▱▱ 70%
│
├─ ✓ review-local — 2 safe fixes
├─ ✓ commit + push — 3 commits on PROJ-231-fix-avatar-cache
├─ ✓ PR #142 opened
├─ - reviewers — already assigned on the existing PR
├─ ✓ CI green — 12/12 checks
└─ ✗ Copilot — 1 CR needs a product decision

⚑ you      decide the retry config (3 attempts vs backoff)
? open     does the cache invalidate on logout?

PR #142 · diff + threads → https://github.com/org/repo/pull/142
Green CI run → https://github.com/org/repo/actions/runs/9912
Task PROJ-231 → https://tracker.example.com/t/PROJ-231
review-local report → docs/reports/avatar-cache.md
```

Below the block, the summary: at most 3 plain sentences.

Write the labels in the language you are speaking to the operator — the column
widths are what is fixed, not the words. One report per front the run touched;
two fronts means two reports, blank line between.

## The glyph vocabulary is frozen — narrow text, no emoji

Emoji are the wrong tool for a column. They occupy two cells on some fonts and
one on others, and which ones misbehave is not predictable from the codepoint —
`⚪` and `⚠️` look as safe as `✅` and are not. Any padding that fixes one
terminal breaks another.

So the markers are **narrow text glyphs**, the same family the `status` skill
uses. Every one of them is exactly one column on every font, so the prose after
them always starts on the same column:

| marker | means                                             |
| ------ | ------------------------------------------------- |
| `✓`    | ran and succeeded                                 |
| `✗`    | failed, or hit a red gate                         |
| `!`    | done, with a caveat worth seeing                  |
| `-`    | skipped, or never reached                         |
| `⚑`    | something is owed by the operator (ledger gutter) |
| `?`    | open question (ledger label)                      |

Banned outright, and this is measured, not taste: every emoji (`✅ ❌ 🟡 🔵 🚩
⚪ ⚠️ 🔗`), plus `▶` and `⏭`, which have emoji variants a terminal may promote
to double width. **Exactly one space after the marker. Never two** — hand-
compensating a glyph's width is only ever correct on the terminal you tested it
on.

## Block 1 — the rail (what this run did)

A flat rail, **depth 1 only**. `│` opener, `├─ ` on each step, `└─ ` on the
last. Nesting costs 3 columns per level and buys nothing here. The rail
characters are narrow and come BEFORE the glyph, so whatever the glyph does to
width, the rail stays aligned.

- One line per step that was in the invoking skill's declared plan, in execution
  order. The rows ARE that skill's steps — not a retelling.
- Markers are only the six in the table above; the reason a step is `-` or `✗`
  goes in its prose, in a few words.
- Each line carries a **concrete outcome**, not the step name restated: counts,
  branch names, PR numbers, file paths. "✓ commit" says nothing; "✓ commit +
  push — 3 commits on PROJ-231" is scannable evidence.
- Keep it short — the full URL belongs in block 3, here it is a bare `#142`.
- More than 8 steps: fold the homogeneous ones into one row with a count
  (`✓ 24/30 files migrated`) and give a row only to the exceptions.
- A run that stopped early still lists the steps it never reached, as `- … —
stopped before this`, so the reader sees what did NOT happen.

## Block 2 — the ledger (where the front stands now)

The `status` skill's grid: a **2-wide gutter, blank by default** (one glyph plus
one space), then a **9-wide word label**, then the value — which therefore always
starts at column 12. An empty gutter is what makes a full one loud.

```
⚑ you      <what only the operator can do>
? open     <unanswered question that changes the next step>
```

- Only two labels survive: **`you`** and **`open`**. `now` was cut — in a FINAL
  report the run is over, so "what is running now" is either a lie or a
  restatement of what unblocks after the operator answers. Fold it into the
  `you` line as the consequence clause: "you decide → I apply and merge".
- The gutter takes **`⚑` only when something is actually owed**, and nothing else;
  `?` marks the open line. Both are one column, so the label column never shifts.
- **`you` always prints.** When nothing is owed it reads `— nothing, you're
clear`. It is the highest-value token in the report: the only one that gives
  the operator permission to close the terminal. An absent line reads as "I
  forgot to check"; the sentence reads as "I checked, you are free".
- `open` is dropped entirely when there is no open question. Never pad it.
- This block never restates a `✓`. Done work lives in the rail and nowhere else.

## Block 3 — the links (what the reader might open)

PRs, issues, CI runs, tracker tasks, deploy or preview URLs, dashboards, design
nodes, chat threads, generated files or reports (repo-relative paths count).

- One line per link, `<why open it> → <url or path>`. The label says what it is
  and why they'd open it, not just "link".
- **Never align this block into columns.** It is the one block whose content
  wraps — a 90-char URL under an aligned label column lands its tail under the
  labels and ruins the report. One space each side of the arrow, always.
- Prefer the **deepest** link: the CR thread itself, not the PR page containing
  it. "What do I open" should land on the thing, not near it.
- A URL is written in full HERE and only here.
- Never invent a URL. If a link was expected but doesn't exist, say so on its
  line: `PR → not opened yet (stopped at review)`.
- Drop the block entirely when the run produced nothing clickable.

## The header line

`<front name>  <bar> <pct>%  · <verdict>` — the bar is ten cells, `▰` filled /
`▱` empty. Build it from evidence read this run, never from memory: for a
Mission, `mission_get` (its steps' proofs — `verified` fills a cell, `claimed`
and `self-verified` do not); otherwise the board and `gh pr`. **No denominator
read this run → no bar**, just the front name. A bar built from how far along it
feels is the worst line this format can emit.

**The verdict clause is the report's only explicit success token.** Everything
else in this format signals trouble — `✗`, `!`, `⚑`, `?` — so a clean run says
nothing at all, and the reader is left inferring success from the absence of a
failure. Those are not the same thing: "nothing went wrong" and "nobody checked"
render identically. So a run ends its header with `· all green` when **all
three** are true at once: every rail row is `✓`, the ledger owes nothing, and the
evidence is named (a merged PR, green checks, a passing suite with its count).
Miss any one and the clause is omitted — an omitted verdict honestly reads as
"not proven finished". A run that stopped takes the negative form instead:
`· stopped at <what>`. Never write either from the feeling that it went well.

## Summary rules

- **At most 3 lines**, below the block, plain sentences, no bullets.
- Line 1: what shipped / what the run produced. Then, only if needed: what still
  needs the operator, and any caveat that changes what they'd do next.
- If a `✗` stopped the run, the summary's job is to say exactly what decision or
  fix is needed to resume.
- It may reference a fact, never re-render it. If a summary line survives the
  deletion of everything above it without losing meaning, it is a duplicate —
  cut it. Three lines is a ceiling, not a target.

## Scope

This format is for **multi-step work**: pipelines, batches, scaffolds, anything
where several actions ran and the operator needs the trace. A simple question
gets a direct answer in prose — a rail there is noise, and noise is exactly what
this format exists to kill.

## For other skills

A pipeline skill that wants this as its output contract just says "end the run
with a `report-back` final report" in its finish step — don't re-specify the
format inline (it drifts). The rail's rows should mirror that skill's own
declared pipeline steps. When a `status` glance card heads the report, the card's
links fold into this report's links block; never print two.
