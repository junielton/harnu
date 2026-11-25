# The walk contract, panel mode

One contract, two transports. A walk is a list of checks the operator does by hand, served one at a
time. With `walk_open` among your tools (any Harnu session with the control server on) the transport is
the **walk pane**: you write the whole script once and the pane serves it. Without it, serve the same
checks in chat with `step-by-step`. This file restates every rule of both copies of `step-by-step` (the
operator's personal one and the bundled one), so the rules hold whichever copy the session loaded. Write
everything the operator reads in the language they are speaking; the pane's own words are Harnu's.

## Hard gate

- **Never perform a step yourself.** Never run anything that changes the world: deploys, pushes, DNS,
  secrets, restarts, merges, a comment posted on a PR. The only commands you run are read-only checks:
  `dig`, `curl`, `gh ... list/view`, `git log`, reading files. No walk verb performs, presses, re-runs,
  exports or settles anything.
- **Never ask the operator to paste a secret** (token, password, private key) into the chat or into a
  failure line. A secret is confirmed by a trace that is not secret: its name in `gh secret list`, the
  token listed in the dashboard, its last 4 characters.
- **Never tick or settle a criterion yourself.** No verb does. With a mission source the app settles at
  the close (see Persistence); you never call a criterion done because the operator said "done" in chat.

## The contract

1. **The whole walk exists before check 1.** One `walk_open` carries every check, links and expected
   values included, and a script that breaks a rule is refused whole. A check discovered mid-walk is
   appended at the end with `walk_extend` (`append`), and you say so in one line.
2. **One check at a time. Exactly one.** The pane serves one check; you never preview the next one,
   bundle two "quick ones" or describe a later check in chat. A failure investigation is also one thing
   per message.
3. **A check is a complete how-to** that someone with zero context can follow, knowing before they answer
   whether it worked: `why`, `where`, numbered `do` items each with what they will `see`, `passes` and
   `fails`. Never "open X, find Y, compare Z".
4. **The pane has the buttons; chat carries no answer.** Done, Failed, Back, Skip and Explain more are the
   operator's clicks. Never ask for an outcome through `AskUserQuestion` or in prose: a dialog hides the
   how-to it sits over, and a typed "done" in the chat is a follow-up, not a click, and moves nothing. The
   one `AskUserQuestion` this skill uses is the offer of a walk (see `SKILL.md`).
5. **A check closes on the operator's Done plus your check.** When a check has `check.how`, a `done` turn
   waits for your `walk_report`; silence, "ok" or "it should have worked" never close one. A check with
   `nothingFromHere` closes as "confirmed, nothing to check from here", never as verified by you.
6. **Check failed after a Done: show the evidence and let the operator decide.** Report
   `result: 'fail'` with what you ran, what you expected and what you found. A check a later one depends
   on (`blocks`) stays open; otherwise the operator may follow anyway, and it is recorded as unverified.
7. **The operator never hunts for a link.** Every page, doc, PR or dashboard a check mentions is a link
   you checked, or a copy chip, or says plainly that it is not checked.

## The sources (phase 0)

Locate the list. You hold the context, so read it yourself and never ask the operator to paste what you
can read. Pick by what you were told:

- **The work you just did** (`feature`): what you built, from your own diff, your task and the criteria
  you were given.
- **A PR** (`pr`): read it with your own read-only `gh` (description, diff, linked task). A merged PR is
  checked where the merge lands, but only after you prove the deploy reached it: fetch the page and find
  the changed markup in a `precheck`. An open PR is checked on its preview or local app.
- **A branch** (`branch`): the diff against its base.
- **A card** (`card`): the card's body, its spec and its acceptance criteria.
- **A mission** (`mission`, scope `step`, `milestone` or `mission`): `mission_get`, the step's criteria,
  the spec and the verifier's evidence.
- **A list the operator pasted, or an action-brief handed back**: the "needs you" block is the list; the
  "ours" block is not (that is our work, not theirs). Read the whole source, since steps hide in prose and
  in bundled lines.

Ask **one** question only when you cannot tell which source is meant. Before writing, read the skill's
`LESSONS.md` if one exists in this skill's folder and apply it, and call `walk_get({ folder, source })`:
when the source already has a walk, say so in one line instead of writing a duplicate.

## Writing the script

- **One check is one action with one observable result.** At most 8 `do` items; split bundles ("steps
  6 and 7", "create the token and the application", ten cards) into one check each.
- **Hand-checking acceptance criteria:** one check per criterion, in the ticket's order. A criterion
  already hand-checked goes in as a row already verified (`status`, `evidence`: when and by whom). Say in
  `where` where each is checked.
- **Gate each candidate.** Already done, proven by a read-only check (`gh secret list`, `dig`, a health
  endpoint): a verified row with its evidence. Something you could do yourself, an optional item or one
  that breaks nothing a real user sees: not a check, one line in `leftOut` (owner `ours`). A decision, not
  an action: not a check either; put it in `leftOut` (owner `decision`) and say it is `one-by-one`'s job.
- **Order by dependency** with `blocks`. The source's order is a hint, not the truth.
- **Check before serving.** Fetch the page and read the expected value before you write the check, and
  state what you already proved in `precheck`: the file the image tag serves and its status, the exact
  text, the count. A precheck that fails is a finding you state yourself instead of serving the check. The
  operator's eye then covers only what markup cannot show.
- **Show the expected value per item.** When a criterion covers several things, give a `table` of at most
  12 rows: item, what it must show, its source. "Check the photos are right" is not a check.
- **Show, don't characterize.** `passes` and `fails` quote the literal value or symptom, such as
  `returns "abc123.cfargotunnel.com."`, never "resolves correctly".
- **Right in the open PR, not yet where it ships** is `openPr`: the close-out lists "re-check N after the
  PR merges" under what is still the operator's.
- **Links.** Collect every mention across all checks. Up to four, check them yourself; with more, hand the
  whole list to one `dtk:link-finder` agent. The deepest link wins: the exact settings screen, the thread,
  the doc section. Never invent a URL: one you built yourself counts only after it answers 200 on the right
  page, and an id completed from memory is an invented URL. Behind a login you cannot prove the page: say
  so on its line and give the click path too. With no link, write the click path.
- **Unverifiable instructions.** A dashboard path you cannot confirm is marked `approximate`, never
  asserted as fact; a command you can dry-run, or read the help of, you do.
- **Commands, values and URLs have a home.** A whole command line, file path or value the operator types or
  pastes goes in `do[].block` (one block per step, so the pane draws a copy button), never inside `text`. A
  short value (an id, a path, a flag) goes in a backtick chip inside the text. A URL goes in `where.links`
  (a checked link). Neither is ever written inside `text` as bare prose: `walk_open` and `walk_extend`
  refuse a `do[].text`, `passes`, `fails` or `undo` that holds an `http(s)://` address (`URL_IN_PROSE`),
  and the script is refused whole.
- **Undo.** A check that changes something records how to undo it in `undo`, so the operator can reverse it:
  Back reopens the previous check and leads with its undo. A command in `undo` is a backtick chip (a copy
  chip), never a bare span of prose; a check that changes nothing needs none.
- **Glyphs are `✓ ✗ ! - ⚑ ?` and nothing else.** No emoji anywhere in a script, a turn or a reply. They mean:
  `✓` closed and verified, or confirmed by the operator where nothing can be checked from here (the prose says
  which); `✗` failed and still open; `!` closed with a caveat (the operator confirmed, your check disagreed,
  they chose to follow anyway; or right in the open PR, not yet where it ships); `-` not reached yet, or
  skipped (the prose says which); `⚑` what the operator owes right now; `?` an open question. Put exactly one
  space after a glyph. A glyph marks an outcome; navigation (Back, Try again) is plain words.
- **Plain text only.** No `<placeholder>` in a command (real values filled in), no secret, no markup.

A check that follows those rules (a step with a `block`, a link in `where.links`, an `undo` whose command is
a chip; a real script also carries `title`, `why` and the rest):

```json
{
  "id": "c3",
  "where": {
    "text": "example-web, Notes page",
    "links": [
      {
        "label": "Notes page",
        "kind": "url",
        "target": "http://localhost:8000/notes",
        "checked": { "status": "ok", "at": "2026-11-18T10:00:00Z" }
      }
    ]
  },
  "do": [
    {
      "text": "Seed the sample notes: paste this line in a terminal, then press Enter.",
      "see": "The command ends with `Seeded 12 notes`.",
      "block": { "text": "npm run db:seed -- --notes 12", "lang": "bash" }
    },
    {
      "text": "Open the Notes page and type `standup` in the search box.",
      "see": "Only two notes stay in the list."
    }
  ],
  "passes": "The list shows exactly 2 rows.",
  "undo": "Restore the sample data with `npm run db:reset`."
}
```

## Acting on the pane's turns

You act only on `[harnu-walk]` turns. A turn names the walk, the run, the check and its `check.how`.

- `done`: run the read-only check of that check, then `walk_report` with `kind: 'check'` and the evidence.
- `failed`: carries the operator's own line and a screenshot path. Diagnose from the error text, look
  things up before guessing, and give **one** correction with `walk_report` (`kind: 'correction'`): the
  most likely cause and the exact thing to change. If you need a fact to choose between causes, ask for
  one fact in chat and wait. Never advance, never fix the product yourself, never list every possible
  cause, and put no limit on attempts.
- `explain` and `simpler`: answer with `walk_extend` (`more`, `extra`, or `simpler`), with evidence: what
  the thing is, the sentence from the doc, the link. Never answer "as I said above". The operator not
  understanding a check means the check was unclear, not that they are slow.
- `treat-as-failed`: the operator accepted your own evidence as the symptom; give one correction.
- `escalate`: you act, by the source. A mission step: send a delta to the step's builder. A PR: draft a
  comment as a draft only and never post it unseen. A feature, branch or card: make a bug card.
- `closed`: the pane already is the report. Answer in at most three lines, offering board cards for what
  is still owed and for the "ours" items left out; only offer.

## Persistence: only for a mission source

Every rule below applies **only when the source is a mission**. For any other source nothing is written to
any mission and the walk has no criterion state.

- A manual action is an operator criterion on a mission step, **added before the walk opens** with
  `mission_add_ac` (`by: 'operator'`), never as you go; the leader's verb, so with no mission, or one you
  do not lead, run the walk anyway, write no criteria and say so in the first line. Offer the `mission`
  skill only when the list should outlive the session.
- Criterion text is a fact that is true when the action is done: three words or more, at most 70
  characters, stable, with no step numbers, dates or counters, and never reworded. A reworded criterion is
  a second one, and a plan only grows.
- Add a criterion only when its wording is not already on the step: read the step with `mission_get`
  first. You can neither edit nor remove one, and a step already done gets none.
- A check cites an existing criterion with `criterion`; the walk adds none of its own. Set `criterion` on
  every check that answers one: a check with no `criterion` can never settle anything.
- **The close settles what two signals verified.** When the walk closes (every check closed, or the
  operator ends it early), Harnu settles each open `by: operator` criterion that a check cited and that
  closed on Done and your check: the operator's Done, then your read-only check with a `pass`. It never
  settles a `session` criterion (a second session's), a `person` one (someone else's approval), a `fact`
  one (Harnu reads it), a caveat, a skipped or failed check, or a check with nothing to check from here
  (only one signal). Done and every key settle nothing while the walk runs. So run the read-only check on
  every `done` turn that has one: your `pass` is the second signal.
- Report a criterion as **open** or **settled** from `mission_get`, never from the chat. When the operator
  says done in chat and the criterion is still open, the check is closed for the walk but the criterion
  stays open: say so once.
- After a compaction, `walk_get` is the read to make: it carries the cursor, each check's glyph, what
  awaits you and the outbox, so the walk survives with no memory of it.

## Red flags: stop and re-read the contract

| Thought                                               | Reality                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| "Then we go to check 2, which is on the VM"           | That is a preview. The next check appears when this one closes.                           |
| "I'll ask for these three things to diagnose it"      | Three asks are three messages. One fact per message.                                      |
| "They said done, so it's done"                        | If you can check, check. A check closes on Done plus your report.                         |
| "This check is trivial, I'll fold it into the next"   | Trivial checks are where typos live. One check, one outcome.                              |
| "Open X, find Y, compare Z is clear enough"           | It is not a how-to. Number the `do` items and quote what passes.                          |
| "I'll just run this myself to speed it up"            | If you could, it belonged in `leftOut`, not on the walk. Guide; don't execute.            |
| "The dashboard menu is probably Access, Applications" | Mark it `approximate`. Don't assert UI you can't see.                                     |
| "The URL is surely /settings/secrets"                 | A URL counts after it answers 200 on the right page, or it is labelled not checked.       |
| "I remember most of that doc id, I'll complete it"    | An id completed from memory is an invented URL. Copy it whole from a source and fetch it. |
| "I'll put the options in a dialog, it's cleaner"      | The pane has the buttons. Never ask for an outcome through a dialog or in the chat.       |
| "The PR merged, so staging has it"                    | Merged is not deployed. Find the changed markup on staging in a `precheck` first.         |
| "Paste the token here so I can confirm it"            | Never. Confirm by its name in a list or its last 4 characters.                            |
| "A ✅ in the label reads friendlier"                  | Emoji break the columns. Six glyphs, nothing else.                                        |
| "The user is stuck, let me list every possible cause" | One most-likely cause with its fix. The next cause only if that fails.                    |
| "They said done, I'll mark the criterion"             | You cannot. If your check passes, the close-out settles it; otherwise it is theirs.       |
| "I'll reword the criterion so it's clearer"           | A reworded one is a second criterion. Keep it stable.                                     |
| "I'll add the criteria as we go"                      | Before the walk opens: the list on the mission is the no-skip guarantee.                  |
