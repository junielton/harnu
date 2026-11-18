---
name: status
description: Render the state of every feature, task or mission in flight as a fixed six-line glance card — progress bar per front, what is running now, what is done, what is next, what needs the operator, what is open — built from mission_list, mission_get, the board and the PRs, never from memory; use it whenever the operator asks "status?", "where are we", "is it done", "what's left", "what do you need from me" or "how's the mission", when they return after being away, and as the header of every report-back, mission tick and delivery report.
---

# Status — the glance card

The operator runs several projects at once. Every time they come back they ask the same four things: _is it done, what is left, what is running, what do you need from me._ A 40-line narrative answers none of them at a glance. This card answers all four in six lines, always the same six, in the same order, so the eye learns where to look and stops reading.

It and the **`report-back`** final report are one visual system: same glyphs, same grid, same links block, same ban on emoji. When they disagree, `report-back`'s rendered example is the reference. **Every output stays short**: six lines per front, then links, nothing else.

## The card

One block per front (a feature, an epic, a mission, a multi-wave task). Exactly six lines, in this order, even when a line is empty:

```
  <id> <name>            <bar> <headline> · <verdict>
  now      <what is running right now · who · for how long>
  done     <what is finished, newest last, · separated>
  next     <what comes after now, in order>
⚑ you      <the ONLY line that asks the operator for something — or the
           success token, spelled out: `— nothing, you're clear`>
? open     <unanswered questions, unverified claims, named risks>
```

Then, after one blank line, the **links**. Three columns, and the shape is the whole point:

1. **A 2-wide gutter** (one glyph plus one space), blank on almost every line. Only the glyphs below ever land there. An empty gutter is what makes a full one loud.
2. **A label column, left-aligned, 9 wide**: `now`, `done`, `next`, `you`, `open`. The value always starts at column 12.
3. **The value**, prose, `·` separated.

When there is a single front and no id to name, the header label reads `wave`.

Rules that keep it a glance:

- **Six lines. No seventh.** Detail lives below the links, after a blank line, and is optional.
- **Each of the six lines prints exactly once per front.** No second `now`, no `progress` heading, no card re-printed with fresher numbers. A mission is one front: one card, whose header already carries its progress. If you read the mission twice while writing, render the second read and drop the first.
- **`you` is sacred.** It carries only what the operator must personally do: merge, close, decide, test by hand. When nothing is owed it reads **`— nothing, you're clear`**, spelled out, not a bare dash: the only token that gives the operator permission to close the terminal. It always prints.
- **`now` names the session and the age** (`ab53791f · 14 min`). Staleness is information.
- **Evidence, not narrative.** Every token comes from a source (below). A fact with no source goes to `open`, never to `done`.
- **Counts over adjectives**: `3/4`, `2 PRs open`, never "mostly done".
- **Newest front first**, then by how much of it is blocked on `you`.
- **Write the labels in the language you speak to the operator**, as `report-back` does. The column widths are fixed, not the words.

## The glyph vocabulary is frozen: narrow text, no emoji

Emoji take two cells on some fonts and one on others, and no padding fixes both. A card pasted into a file, a commit or a PR body must survive with no emoji at all. The markers are the same six `report-back` uses, each exactly one column:

| marker  | where  | means                                                  |
| ------- | ------ | ------------------------------------------------------ |
| `✓`     | header | shipped: evidence exists (merged PR, green checks)     |
| `!`     | header | needs attention: stalled, CI red, blocked              |
| `✗`     | header | finished and failed, pairs with a `stopped at` verdict |
| `-`     | header | not started                                            |
| (blank) | header | in flight, healthy                                     |
| `⚑`     | `you`  | something is actually owed by the operator             |
| `?`     | `open` | there is an open question                              |

`done` and `next` never take a glyph. A healthy card that owes nothing has an entirely blank gutter. Banned outright: every emoji (`✅ ❌ 🟡 🔵 🚩 ⚪ ⚠️ 🔗 🟢 🔴 ⏳`) and `▶` and `⏭`. **Exactly one space after the marker. Never two.**

Identifiers go in backticks (`` `#145` ``, `` `T161` ``, `` `ab53791f` ``); the front id is bold, the name is not. Nothing else is colored. **Never mark a fact you did not verify**: `✓` asserts evidence exists, and when in doubt the header stays blank and the doubt goes to `open`.

## The verdict

Everything else signals trouble (`✗`, `⚑`, `?`), so success would be only an absence, and "nothing is owed" looks the same as "nobody checked". A front that is **finished and proven** ends its header with `· all green`, written only when all three are true at once: the bar is full, the `you` line is empty, and the evidence is **named** (a merged PR, green checks, a release tag, a passing suite with its count). Miss one and the clause is omitted; an omitted verdict honestly reads "not proven finished". Its counterpart is `· stopped at <what>` for a front that is finished but failed. Never write either from the feeling that it went well.

## The bar and the headline

`▰` filled, `▱` empty, nothing else. One cell per unit with the count (`▰▰▰▱ 3/4`) when the denominator is small and real; ten cells with a percentage (`▰▰▰▰▰▰▰▱▱▱ 70%`) when there are too many to draw. **No denominator read this run, no bar**: just the front name.

**A mission's headline is Harnu's, never recounted.** `mission_list` rows carry `headline`, and `mission_get` carries `progress.headline`: "4 of 21 steps done", or "1 of 10 milestones done" when the mission has milestones, the same words the Mission dropdown shows. The header prints the bar drawn from `progress.done` and `progress.total`, then that headline as it is. Never recount steps by their state, never print a second count beside it, and never build the headline from anything else.

## The links

After the last card, one blank line, then every PR, issue, CI run, board card, tracker task, preview URL or generated file the reader might open (repo-relative paths count):

```
PR `#224` · spec merged → https://github.com/org/repo/pull/224
CI run → https://github.com/org/repo/actions/runs/9912
Delivery report → docs/reports/t215.md
```

- One line per link, `<why open it> → <url or path>`. The label says what it is and why they would open it.
- **Never align this block into columns**: a long URL under an aligned label ruins the card. One space each side of the arrow.
- Prefer the **deepest** link (the review thread, not the PR page). A URL is written in full here and only here; inside a card it is a bare `` `#224` ``.
- **Never invent a URL.** A link expected but missing says so: `PR → not opened yet (stopped at review)`.
- Drop the block when nothing is clickable.

## Where the facts come from

1. **Missions: `mission_list({ folder })`, then `mission_get({ folder, missionId, sessionId })` for each open one.** Each mission is one front, attributed to the session that leads it (`leads`): two leaders in one checkout read as two fronts. Read it once and render it:

   | card line | read it from                                                                                             |
   | --------- | -------------------------------------------------------------------------------------------------------- |
   | header    | `progress.done`, `progress.total` and `progress.headline`, as they are                                   |
   | `now`     | the steps whose state is `running`, with the session working each and its age                            |
   | `done`    | the steps whose state is `done`, in plan order                                                           |
   | `next`    | the steps after the first undone one, still `to do`                                                      |
   | `you`     | `next` from `mission_get`: its `ask`, then its `why`, then `(+N more)` for the rest of `waiting`         |
   | `open`    | blockers an agent owns, a criterion waiting for another person, a self-check no second session confirmed |

   `waiting` is what the operator owes, already ranked (`main-failing`, `unblock`, `settle`, `review`, `close`, `attach`); the `you` line is its first item and a count, never an item you derived yourself. A mission with a close request standing asks the operator to close it.

2. **The board**: `memory_read` of the front's card (`roadmap/<slug>`) for its column, criteria, evidence and open questions. There is no board-read verb, so do not look for one. A card-only front (no mission) is built from the card alone.
3. **`gh pr list --state open` and `gh pr checks <n>`**: only for PRs no mission links. A PR a mission links is already resolved inside `mission_get`; reading `gh` for it is waste and can disagree.
4. **`get_fleet`**: only for fronts with no mission. A mission's sessions are in its read.

Read every source that applies before writing a single card. A card written from memory is what this skill exists to prevent.

## Where the card is mandatory

- The first thing in every **report-back**; the card's links fold into the report's links block, never printed twice.
- The one-line `tick —` of a **mission** tick expands to the card when `waiting` or `open` changed since the previous tick.
- The top of every **delivery report**, and any answer to _status / where are we / is it done / what's left / what do you need from me_.

## Example: a mission, rendered from what Harnu gave

`mission_get` returned `progress: { done: 3, total: 5, headline: "3 of 5 steps done" }`, and `next` asked the operator to approve a plan:

```
  **T381** missions v4      ▰▰▰▱▱ 3 of 5 steps done
  now      Run the tool on the whole test set · `8f2c11ab` · 25 min
  done     A tool that scores a spec · A test set we can trust · One command to run a round
  next     Write the scoring report
⚑ you      approve the plan for the scoring tool · 2 finished steps wait for it
? open     one criterion is only self-checked

PR `#312` · scoring tool → https://github.com/org/repo/pull/312
```

Note what it does **not** print: no second count, no `Progress` row. The header is the progress.

## Example: three fronts

```
  **T215** message_session  ▰▰▰▱ 3/4 · spec merged
  now      predicate spec · `ab53791f` · 14 min
  done     gate decided · `#224` merged
  next     implementation · live probe
  you      — nothing, you're clear
? open     `--permission-mode auto` never probed

! **T216** delivery assurance  ▰▰▱▱ 2/4
  now      idle 3 h, waiting on `T215`
  done     research · S1 spec (`#225` merged)
  next     S1 implementation
⚑ you      decide whether S1 lands before `T215` or waits for it
? open     wave collision across worktrees

✓ **T217** bundled skills  ▰▰▰▰ 4/4 · shipped `0.3.27`
  now      —
  done     staging and namespacing verified live
  next     —
⚑ you      close the card
  open     —

PR `#224` · spec merged → https://github.com/org/repo/pull/224
Release `0.3.27` → https://github.com/org/repo/releases/tag/v0.3.27
```

Reading only the gutter: one shipped, one needing attention, two things owed, two open questions. `T217` carries no `· all green`: its bar is full and its evidence is named, but one thing is still owed. Shipped is not the same as clear.

## Boundaries

- The card reports; it never moves a card, merges or closes anything.
- It never invents a `done` from a self-report: a unit a session _says_ is finished whose PR does not exist is `now`, not `done`.
- When sources disagree (the board says `in-progress`, the fleet says the session is gone), the disagreement goes to `open`; the card does not pick a side.
