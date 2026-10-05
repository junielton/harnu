---
name: status
description: Render the state of every feature, task or mission in flight as a fixed six-line glance card — progress bar per front, what is running now, what is done, what is next, what needs the operator, what is open — followed by the links worth opening, built from mission_list/mission_get, the board and the PRs, never from memory. Use whenever the operator asks "status?", "where are we", "is it done", "what's left", "what do you need from me", "how's the mission", or opens a session after being away. Also the mandatory header of every report-back, every mission tick and every delivery report. Do NOT use to narrate what happened in a session (that is the body below the card) or to grade acceptance criteria (delivery-verifier).
---

# Status — the glance card

The operator runs several projects and several fan-outs at once. Every time they
come back they ask the same four things: _is it done, what is left, what is
running, what do you need from me._ A 40-line narrative answers none of them at a
glance. This card answers all four in six lines, always the same six, always in
the same order — so the eye learns where to look and stops reading.

This card and the **`report-back`** final report are one visual system. Same
glyphs, same grid, same links block, same ban on emoji — so a status card sitting
on top of a report-back reads as one document, not two. When they disagree,
`report-back`'s rendered example is the reference.

## The card

One block per front (a feature, an epic, a mission, a multi-wave task). Exactly
six lines, in this order, even when a line is empty:

```
  <id> <name>            <bar> <counts> · <verdict>
  now      <what is running right now · who · for how long>
  done     <what is finished, newest last, · separated>
  next     <what comes after now, in order>
⚑ you      <the ONLY line that asks the operator for something — or the
           success token, spelled out: `— nothing, you're clear`>
? open     <unanswered questions, unverified claims, named risks>
```

Then, after one blank line, the **links** — everything the reader might open.

Three columns, and the shape is the whole point:

1. **A 2-wide gutter** — one glyph plus one space — blank on almost every line.
   Only the glyphs in the table below ever land there. An empty gutter is what
   makes a full one loud.
2. **A label column, left-aligned, 9 wide.** Words, not glyphs: `now`, `done`,
   `next`, `you`, `open`. The value always starts at column 12. The eye learns
   the column and stops reading labels after the first card.
3. **The value**, prose, `·` separated.

The header line replaces the first label. When there is a single front and no id
to name, it reads `wave` and nothing is lost:

```
  wave     ▰▰▱▱▱ 3 units running · 0 PRs open
```

Rules that keep it a glance:

- **Six lines. No seventh.** Detail lives below the links, after a blank line,
  and is optional. The operator must be able to stop reading after the cards.
- **Each of the six lines prints exactly once per front.** No second `now`, no
  `done` repeated under a `progress` heading, no card re-printed for the same
  front with fresher numbers. A mission is one front: one card, whose header
  already carries its progress — there is no separate progress line. If you
  read the mission twice while writing, render the second read and drop the
  first.
- **`you` is sacred.** It carries only actions the operator must personally take
  — merge, close, decide, test by hand. Nothing an agent could do belongs there.
  When nothing is owed it reads **`— nothing, you're clear`**, spelled out, not
  a bare dash. It is the highest-value token in the card: the only one that gives
  the operator permission to close the terminal. An absent line reads as "I
  forgot to check"; a bare `—` reads as "there is nothing here"; the sentence
  reads as "I checked, you are free". It always prints.
- **`now` names the executor and the age** (`ab53791f · 14 min`). Staleness is
  information, and for a mission it is already computed: `mission_get`'s
  `derived.stale` is the stall flag — print it, do not re-judge it from ages.
- **Evidence, not narrative.** Every token comes from a source: the mission
  (`mission_list` / `mission_get` — steps, proofs, links, blockers, the `you`
  line), the board card (status, ACs, evidence), `gh pr list` / `gh pr checks`.
  If a fact has no source, it goes to `open`, never to `done`.
- **Counts over adjectives.** `3/4`, `2 PRs open`, `1 unmet` — never "mostly
  done", "almost there", "going well".
- **Newest front first**, then by how much of it is blocked on `you`.
- **Write the labels in the language you are speaking to the operator**, exactly
  as `report-back` does. The column widths are what is fixed, not the words —
  translate `now`, `done`, `next`, `you` and `open`, then pad to the same 9
  columns. A status card and the report-back under it must never disagree on
  which language they are in.

## The glyph vocabulary is frozen — narrow text, no emoji

Emoji are the wrong tool for a column. They occupy two cells on some fonts and
one on others, and which ones misbehave is not predictable from the codepoint —
`⚪` and `⚠️` look as safe as `✅` and are not. Any padding that fixes one
terminal breaks another. A card written into a file, a commit message or a PR
body must survive with no emoji at all.

So the markers are **narrow text glyphs**, the same six the `report-back` skill
uses. Every one is exactly one column on every font, so the label column never
shifts:

| marker  | where  | means                                                   |
| ------- | ------ | ------------------------------------------------------- |
| `✓`     | header | shipped — evidence exists (merged PR, green checks)     |
| `!`     | header | needs attention — stalled, CI red, blocked              |
| `✗`     | header | finished and failed — pairs with a `stopped at` verdict |
| `-`     | header | not started                                             |
| (blank) | header | in flight, healthy                                      |
| `!`     | `now`  | stale — `derived.stale` is true on the mission          |
| `⚑`     | `you`  | something is actually owed by the operator              |
| `?`     | `open` | there is an open question                               |

`done` and `next` never take a glyph. A card that is healthy and owes nothing
shows an entirely blank gutter — which is the fastest possible read.

Banned outright, and this is measured, not taste: every emoji (`✅ ❌ 🟡 🔵 🚩
⚪ ⚠️ 🔗 🟢 🔴 ⏳`), plus `▶` and `⏭`, which have emoji variants a terminal may
promote to double width. **Exactly one space after the marker. Never two.**

Two more strokes, and then stop:

- **Identifiers go in backticks** — PR numbers, card ids, session ids, branches,
  flags: `` `#145` ``, `` `T161` ``, `` `ab53791f` ``, `` `feat/t215` ``,
  `` `--permission-mode` ``. The terminal renders code spans in the accent
  color, which is the only color in the card and costs nothing to produce.
- **The front id is bold**, the name beside it is not.
- **Nothing else is colored.** No glyphs inside the prose of a line, no green
  checks sprinkled through the text. If everything is marked, nothing is.
- **Never mark a fact you did not verify.** `✓` on a header asserts evidence
  exists. When in doubt the header stays blank and the doubt goes to `open`.

## The verdict — the one place the card says "this worked"

Everything else in this format signals trouble: a `✗`, a `⚑`, a `?`. Success is
left as an absence — no marker, no flag, an empty gutter. That is not enough. A
reader cannot tell "nothing is owed" apart from "nobody checked", and the two
have opposite consequences.

So a front that is **finished and proven** ends its header line with an explicit
verdict, after the counts:

```
✓ **T217** bundled skills      ▰▰▰▰ 4/4 · shipped `0.3.27` · all green
  you      — nothing, you're clear
```

The clause may be written only when **all three** are true at the same moment:

1. the bar is full — every unit counted is done;
2. the `you` line is empty — nothing is owed to the operator;
3. the evidence is **named**, in the card or in the links — a merged PR, green
   checks, a release tag, a passing suite with its count.

Miss any one and the clause is simply omitted. An omitted verdict is not a
failure — it means "not proven finished", which is exactly the honest reading.
Never write it from the feeling that the work went well; it is the one token in
the card that asserts a conclusion, so it carries the same evidence rule as `✓`.

Its counterpart is the negative verdict, on the same line and under the same
rule: `· stopped at <what>` when a front is finished-but-failed. Between the two
sits the ordinary case — no clause at all, work still in flight.

## The bar

`▰` filled / `▱` empty, and never anything else. Two shapes, pick one per report
and do not mix them:

- **One cell per unit, with the count** — `▰▰▰▱ 3/4`. Use this whenever the
  denominator is small and real.
- **Ten cells with a percentage** — `▰▰▰▰▰▰▰▱▱▱ 70%`. Use this for a front whose
  units are too many to draw, and only when the percentage comes from a counted
  ratio.

Several phases get several bars on the same line, `·` separated:
`spec ▰▰▰▱ 3/4 · impl ▱▱▱▱ 0/4`.

**No denominator read this run → no bar**, just the front name. A bar built from
how far along it feels is the worst line this format can emit.

**A mission's `derived.progress` is the bar — render it, never recount it.**
`mission_get` returns it, computed once by Harnu, and the operator's Topbar pill
renders the very same object. One cell per step (`total`), `▰` for each of the
`done` ones, then the headline exactly as the pill says it:
`Step N of M · V verified · L left behind`, with N = `current.from` ("Steps a–b
of M" when `current.from` ≠ `current.to`), V = `verified`, L =
`leftBehind.length` — drop the `· L left behind` clause when L is 0, and write
`Step M of M ✓` only when `allDone`. Never count steps by proof yourself, never
print a count of proven steps, and never build the bar from `mission_list`'s `steps: {
total, verified, claimed }` — that field is deprecated and disagrees with the
pill. A `mission_list` row's `progress` may be one poll old (see its
`computedAt`); the card uses `mission_get`'s.

## The links — what the reader might open

After the last card, one blank line, then every PR, issue, CI run, board card,
ClickUp/Jira task, deploy or preview URL, dashboard, Slack thread, or generated
file the reader might want to open (repo-relative paths count).

```
PR `#224` · spec merged → https://github.com/org/repo/pull/224
CI run → https://github.com/org/repo/actions/runs/9912
Delivery report → docs/reports/t215.md
```

- One line per link, `<why open it> → <url or path>`. The label says what it is
  and why they'd open it, not just "link".
- **Never align this block into columns.** It is the one block whose content
  wraps — a 90-char URL under an aligned label column lands its tail under the
  labels and ruins the card. One space each side of the arrow, always.
- Prefer the **deepest** link: the CR thread itself, not the PR page containing
  it. "What do I open" should land on the thing, not near it.
- A URL is written in full HERE and only here. Inside a card it is a bare
  `` `#224` ``.
- **Never invent a URL.** If a link was expected but does not exist, say so on
  its line: `PR → not opened yet (stopped at review)`.
- Drop the block entirely when there is nothing clickable.

## Where the facts come from

1. **Missions — `mission_list({ folder })`, then `mission_get({ folder,
missionId })` for every mission that is not `closed`.** Each mission is one
   front, attributed to its `ownerSessionId` — two orchestrators in one checkout
   read as two fronts, never as one contradictory one. The projection already
   carries what used to be hand-assembled from four places:

   | card line | read it from                                                                                       |
   | --------- | -------------------------------------------------------------------------------------------------- |
   | header    | `derived.progress`, as-is (above); `status` and `blocked` for the gutter                           |
   | `now`     | steps `running` in `derived.progress.states`, with `derived.steps[].children` for who and how long |
   | `done`    | steps whose state is `done` or `verified`, in step order                                           |
   | `next`    | the steps after `current`, in order, still `todo`                                                  |
   | `you`     | `mission_get`'s `you` line, verbatim — then the rest of `youItems`, in order, if it says `+N more` |
   | `open`    | `leftBehind` and `unprovable` steps, open blockers, `openQuestions`, `pendingRescope`              |

   `youItems` is the ordered list of everything the operator owes (a re-scope,
   the close, operator blockers, due checks, human steps, child approvals); the
   `you` line is its first item plus `(+N more)`. Print it as-is and add each
   further item as a short clause in the same order — never reordered, never
   reworded into something Harnu did not say, never an item you derived
   yourself. A `delivered` mission's `you` line asks the operator to close it.
   `stale` never appears in `mission_list`'s `status` — it is `derived.stale` on
   `mission_get`, and it puts `!` on the header and on `now`.

2. **Legacy goal files — only the ones no mission covers.** A goal file whose
   frontmatter names a mission (`mission: mnt-…`) is that mission's front, so
   skip it. A goal file with no `mission:` line is an older, unmigrated front —
   read it as before (executors, done criteria, pending gates), attribute it to
   its `session:` frontmatter or its `<session8>` filename prefix, and add `not
yet a Mission` to its `open` line. A legacy `.harnu/GOAL.md` counts the same way.
3. **The board** — `get_board` when it exists; until then `memory_read
roadmap/<slug>` for each front's card: column, per-AC table, evidence, open
   questions. A card-only front (no mission) is built from this alone.
4. **`gh pr list --state open` and `gh pr checks <n>`** — CI and merge state. A
   PR a mission links is already resolved in `derived.steps[].links` (its
   `state`); `gh` adds only what the projection does not carry, like checks.
5. **`get_fleet`** — only for fronts with no mission. A mission's linked sessions
   are already in its projection; polling the whole fleet for them is waste.

Read every source that applies before writing a single card. A card written from
memory is the thing this skill exists to prevent.

## Where the card is mandatory

- The first thing in every **report-back** — the rail, ledger and summary come
  after. The card's own links block folds into the report's links block; do not
  print two.
- The one-line `tick —` of a **mission** tick expands to the card when anything
  in `you` or `open` changed since the previous tick.
- The top of every **delivery report**, above "Where we are".
- Any answer to _status / where are we / is it done / what's left / what do you
  need from me_.

## Example — one mission, no id to name

The plainest shape the card takes:

```
  wave     ▰▰▱▱▱ 3 units running · 0 PRs open
  now      `T164` (U1 render) · `BUG-71` (body attach) · `BUG-72` (Image Cards)
  done     nothing yet
  next     first PR to open → verify AC by AC; U1 unblocks U2
⚑ you      review `#156` · production is losing content right now
? open     `T165` queued · UnresolvedMediaWarnings still log-only

PR `#156` · content loss fix → https://github.com/org/repo/pull/156
```

## Example — a mission, rendered from `derived.progress`

`mission_get` returned `total: 5`, `current: { from: 4, to: 4 }`, `done: 3`,
`verified: 2`, `leftBehind: []`, one due check on step 3, and a `you` line that
asks for it. The card prints that, once:

```
  **T381** mission v3       ▰▰▰▱▱ Step 4 of 5 · 2 verified
  now      S4 skills · `8f2c11ab` · 25 min
  done     S1 core · S2 reads · S3 renderer
  next     S5 amendments
⚑ you      tick the due check on S3 (designer sign-off)
? open     S3 is done, not yet verified
```

Note what it does **not** print: no `3/5 proven`, no second line restating the
step count, no `Progress` row. The header is the progress.

## Example — three named fronts

```
  **T215** message_session   spec ▰▰▰▱ 3/4 · impl ▱▱▱▱ 0/4
  now      gate decision → spec PR · `ab53791f` · 14 min
  done     O-1 answered · gate decided · `#224` merged
  next     predicate spec · implementation · live probe
  you      — nothing, you're clear
? open     `--permission-mode auto` never probed

! **T216** delivery assurance  S1 ▰▰▱▱ 2/4 · S2–S4 ▱▱▱ 0/3
! now      idle 3 h — waiting on `T215`
  done     research · S0 skills · S1 spec (`#225` merged)
  next     S1 implementation (needs `T215` for the send-back)
⚑ you      decide whether S1 lands before `T215` or waits for it
? open     wave collision across worktrees (§11 Q4)

✓ **T217** bundled skills      ▰▰▰▰ 4/4 · shipped `0.3.27`
  now      —
  done     staging + namespacing verified live
  next     —
⚑ you      close the card · close `BUG-86`
  open     —

PR `#224` · spec merged → https://github.com/org/repo/pull/224
PR `#225` · S1 spec → https://github.com/org/repo/pull/225
Release `0.3.27` → https://github.com/org/repo/releases/tag/v0.3.27
```

Reading only the gutter: one shipped, one needing attention, one stale executor,
two things owed, two open questions. Reading nothing else at all is allowed. That
is the point.

Note what `T217` does **not** carry: its bar is full and its evidence is named,
but two things are still owed, so the `· all green` verdict is withheld. Shipped
is not the same as clear.

## Boundaries

- The card reports; it never moves a card, merges, or closes anything.
- It never invents a `done` from a self-report — a unit an executor _says_ is
  finished but whose PR does not exist is `now`, not `done`.
- When the sources disagree (board says `in-progress`, fleet says the session is
  gone), the disagreement itself goes to `open` — the card does not pick a side.
