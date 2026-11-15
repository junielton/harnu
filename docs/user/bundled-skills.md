# Bundled skills

Harnu ships a small set of **skills** — reusable instruction files a Claude session can
invoke by name — and lets you switch each one on or off from **Settings → Skills**.

They are all **off on a fresh install**. Nothing is added to your sessions until you
say so.

## What ships

| Skill                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrate-delivery` | Plan an objective as milestones and steps, dispatch one Harnu session per step, have a second session settle every criterion, then hand back a report.                                                                                                                                                                                                                                                                                                                   |
| `delivery-verifier`    | Settle a finished step's criteria one at a time, from evidence in the repo rather than from what the builder says about itself, then write the delivery report.                                                                                                                                                                                                                                                                                                          |
| `mission`              | Lead a body of work as a Mission: create it at the first sign of multi-step work, run one coordination tick over what was dispatched, and ask you to close it when it is done.                                                                                                                                                                                                                                                                                           |
| `delivery-watchdog`    | A read-only sweep over your open missions: it says once when a delivery is stalled, parked or waiting on you. Built to run as a Scheduler worker.                                                                                                                                                                                                                                                                                                                        |
| `conductor`            | Drive the Harnu fleet through the `harnu` MCP verbs — see every session and worktree, create sessions, terminals and worktrees.                                                                                                                                                                                                                                                                                                                                          |
| `status`               | Render a fixed six-line "glance card" of where every feature or mission stands, plus the links worth opening, built from the board, the mission files and open PRs.                                                                                                                                                                                                                                                                                                      |
| `read-aloud`           | Speak a short, ear-friendly summary of a result out loud — through Harnu's own voice inside the app, or a text-to-speech command on your PATH outside it.                                                                                                                                                                                                                                                                                                                |
| `report-back`          | The final-report format every multi-step run ends with: one line per step with its concrete outcome, what you owe (always printed, even when it is nothing), the links worth opening, and a summary of at most three lines.                                                                                                                                                                                                                                              |
| `draft-to-prompt`      | Turn a rough idea or a messy draft into a finished prompt for a Claude model — including a boot prompt for a new session or worktree — with the model, effort and any long-running harness it needs spelled out as run instructions.                                                                                                                                                                                                                                     |
| `one-by-one`           | Work through a pile of open decisions one question at a time, and write each answer where it lasts — the resolved row in your spec and a line in project memory. When a mission needs the decision, it is a blocker you clear in the Mission pane.                                                                                                                                                                                                                       |
| `grill-me`             | Have a spec or plan stress-tested by one question at a time, with a recommended answer each. Every question that survives is written into the spec — an open decision, an amendment, or a non-goal — and the session ends by listing what it wrote and what it could not place.                                                                                                                                                                                          |
| `step-by-step`         | Be walked through a list of manual actions only you can do — dashboard clicks, DNS, secrets, a release — one step per message. Each action also becomes a criterion on the relevant Mission step, which only you can tick.                                                                                                                                                                                                                                               |
| `spec`                 | Run it at the start of any piece of work: it names what you came in with and how big the work is, in one message. Most entries — a one-line bug, a PR comment, a red CI, a question — end right there with their first step and nothing written. Bigger work gets a spec and a mission with one step, "Approve spec", that you tick yourself after answering its one question; `/harnu:spec check` lints a spec (and, with `--cards`, the cards against it) in any repo. |
| `your-move`            | Have a session tell you, in a card you can act on, the moment a turn leaves something only you can unblock: a decision, a go or no-go, something only you hold, a manual step, a check. It also tells the session how to write that card so you never have to open the session to learn what it asks.                                                                                                                                                                    |

Each row in the panel shows the skill's name and its own one-line purpose, taken
straight from the skill file — so the panel can never describe a skill differently
from what the session actually reads.

### `delivery-watchdog` is the second heartbeat over dispatched work

> **There is no steward any more.** A mission's leader does the routine moves itself: it starts a verifier for a pull request that is ready, nudges a session that stalled and rebases a stack after a merge. `delivery-watchdog` is only the read-only sweep described here.

When Harnu orchestrates a delivery, the thing keeping it moving is a loop inside the
orchestrating session — and that session is mortal in ordinary ways. Harnu parks it
when memory gets tight, you close the app, a long conversation compacts, or you ask
it a question and the turn ends without the loop being restarted. The loop stopping
is the normal failure, and it is the one failure the loop itself cannot report.

The most expensive shape this takes is a unit that finished and then sat there. A
session Harnu dispatched writes the code, commits, pushes, and stands down — it
cannot open the pull request itself, because a dispatched session deliberately holds
none of Harnu's own verbs. Opening it is the orchestrator's job, on its next tick. If
there is no next tick, the branch is simply done and invisible until someone looks.

`delivery-watchdog` is what looks. Point a **Scheduler worker** at the repo (see
[Scheduler](scheduler.md)) with `/harnu:delivery-watchdog` as the prompt, `observe`
mode, every 30 minutes or so, with **carry last result** on. Each tick is a fresh
unattended process, so it keeps running whatever happened to the session it is
watching. It reads every open **mission** in the repo — the structured record the
orchestrating session keeps — and looks for: a mission that has stalled
(no new activity for over an hour and nothing working), work pushed with no PR and no
live session, something that has been waiting on you while the mission stalled, and a
board card whose column disagrees with its worktree.

**It tells you; it cannot fix it.** `observe` mode is read-only by an explicit
allowlist — the watchdog cannot dispatch a session, move a card, or send a message
to wake the orchestrator, and it can read a mission but never change one. What it can
do is send you one notification naming the exact next action ("4 commits pushed, tree clean, no
PR — needs the shipper dispatched"). It is a smoke alarm, not a sprinkler, and the
value is entirely in timing: a stall you meet in half an hour instead of the next
morning, at which point opening the orchestrating session is usually enough, because
it re-arms its own loop when you do.

It stays quiet when nothing is parked, and with "carry last result" on it will not
notify twice about the same finding — it only speaks again when something actually
moved. If it never says anything, that is the intended behaviour, not a broken worker.

### `spec` sizes up the work first, and writes a spec only when it needs one

Run `/harnu:spec <what you have>` at the start of any piece of work. Its first answer is
one message: the **door** you came in by (a vague idea, a ticket, a bug, a question, a PR
comment or red CI, a design, a recurring pain, "where did we leave off?"), the **tier**
with a one-line reason, and the next step. Say `small`, `medium`, `large` or `complex` to
override the tier; it takes your word without arguing.

- **Small ends there.** A one-line bug, a PR comment, a red CI or a question gets its
  first step and nothing else: no file, no mission, no sub-agent. A question that grows
  into an architectural decision gets an ADR, never a spec.
- **Medium, Large and Complex get a spec** at `docs/specs/YYYY-MM-DD-<slug>/spec.md`, in
  the shape of the repo's spec template. Before asking you anything, the session looks
  up what the repo already knows (project memory, lessons, the code); then it asks the
  decisions that remain one at a time. A decision you don't answer stays open with its
  default, never guessed. Large adds goals and open decisions; Complex adds a PRD, an ADR
  only when the spec records an architectural decision, and a mockup folder when there
  is UI.
- **A mission starts the moment the work leaves Small.** Its finish line is the delivery
  itself, not the spec, and it has one step, "Approve spec", with one criterion that only you can tick.
- **Fresh reviewers read the spec cold.** Two for Medium, three for Large, five for
  Complex, each started on a different model when one is available and handed nothing but
  file paths. Every finding gets one written answer in `critics.md` beside the spec.

**How you approve.** When the spec is clean and reviewed, the session opens it in a pane
beside the session and asks one question: `Approve this spec?`. On a yes it marks the spec
approved; you then open the **Mission pane** and tick the criterion on the "Approve spec"
step, because the skill never ticks it for you. If you are away when it asks, it raises a
blocker in your name, so Harnu chimes and reminds you. Once a slice of the spec has a
card, the spec is frozen: later changes are added as rows of its **Amendments** table.
After you approve, `orchestrate-delivery` picks up the same mission, turns each slice
into a card and holds back the slices an open decision still gates.

**The `check` verbs.** `/harnu:spec check` lints a spec: the spec gate's rules, that every
capability is built before it is used, that every request lands on an acceptance criterion,
a non-goal or a decision, and the reviewers' answers in `critics.md`. Add `--cards` to also compare the
board cards against the spec (acceptance criteria that drifted, went missing or were
invented). It prints one finding per line and changes nothing. The checker ships inside
the skill, so it works in any repo, not just Harnu's own.

### `one-by-one`, `grill-me` and `step-by-step` leave a record

These three are conversation skills — they talk to you one question or one step at a
time — but none of them lets the answer die in the transcript.

- **`one-by-one`** reads the **Open decisions** table of your spec (the `D-n` rows) and
  asks one decision per message, with a recommendation. After each answer it marks that
  row `resolved` (with your choice and the date) and appends one line to the project
  memory's decisions. It never decides for you: a decision you skip stays open. When the
  Mission waits on a decision, it is a blocker in your name; once you have answered,
  say **Done, continue** on it in the Mission pane, because only you clear it.
- **`grill-me`** is the stress test you run between a draft and an approval. It asks
  one question at a time and looks up anything the code or memory already answers. What
  you raise is written into the spec as it goes: a new open decision, a row in
  **Amendments** (the original text is never silently rewritten), or a line under
  non-goals. It finishes with two lists — what it wrote and what it could not place — and
  starts nothing.
- **`step-by-step`** guides you through actions only you can perform. Before the first
  step it adds one **criterion** per action to the Mission step it belongs to (running it
  again with the same list adds nothing). It runs only read-only checks to confirm a
  step worked, and it never ticks a criterion for you — you tick them in the Mission
  pane, and the closing report says which are still open.

All three work without a spec or a mission; they just have nowhere to write, and say so.

### The delivery skills work on Missions

`mission`, `status`, `orchestrate-delivery`, `delivery-watchdog` and
`delivery-verifier` keep a coordinated delivery as a **Mission** — a structured
record Harnu stores in your repo's `.harnu/missions/` and shows in the
[Mission pane](missions.md) — rather than a free-form notes file. What that
changes for you:

- **The session that starts the work leads it.** At the first sign of multi-step
  work it creates the mission itself, with no confirmation; a one-line question
  creates none. The plan is milestones, then steps, and every step has at least one
  criterion: a line that says how anyone can tell it is done.
- **There is no steward.** The leader dispatches the verifiers, nudges a session that
  stalled and rebases a stack after a merge on its own; `delivery-watchdog` is only
  the read-only sweep.
- **A criterion is settled by someone who did not build the step.** `delivery-verifier`
  judges each criterion on its own, from evidence, as a second session. What the
  builder says about its own work is a self-check and never closes one. With no
  browser tools in the session, anything visual lands on your "check by hand" list.
- **The ones that are yours, you tick.** A sign-off or a manual check ("the designer
  approves the section", a dashboard step) is an **operator criterion**. You tick it
  in the Mission pane; no skill can.
- **When a session is waiting on you, Harnu tells you.** It raises a blocker in your
  name, which is what makes Harnu chime and remind you (after 30 minutes, then 1, 2 and
  4 hours). You answer it in the Mission pane (**Done, continue**), and the answer is
  written in the mission's Log as a decision.
- **Changing the finish line is yours.** A session that thinks the delivery now ends
  differently proposes a new **Done when**; it waits for you in the pane.
- **Closing, and handing over, are yours.** When every step is done the session asks
  you to close, and you close the mission. Only you start a hand-off, from the pane's
  **Continue in a new session…**; the leader never switches itself, whatever its
  context says. The fresh session starts from the mission summary: there is no prompt
  for you to paste.
- **Reports use one set of numbers.** The `status` card, the `mission` tick and the
  watchdog say the same thing as the pane, worked out by Harnu, and the card prints
  each of its lines once.
- **A long delivery doesn't outgrow its session.** The orchestrator runs every
  check-in, verification and report in a fresh helper agent that hands back a short
  summary, so its own conversation stays small however long the delivery runs.
- **Sessions reporting back find the right session.** A helper session addresses the
  session that dispatched it by looking up its current address right before sending, and
  it never sprays its report to other sessions when it can't reach the right one.

Missions you already have (version 3) keep working as they did. If you had your own
personal `mission` or `status` skill, it is still there, untouched — removing it is
your call.

### `read-aloud` speaks through Harnu inside the app, and your own command outside it

**Inside Harnu** the skill uses Harnu's own voice — the same engine and the same
switches as everything else in [Voice](voice.md). So it obeys them: voice has to be
on for that folder, the engine itself has to be on and unmuted, and a folder you
muted stays muted. Nothing is left behind either way — a read-aloud is heard once
and never files a row in your Activity history.

A refusal is normal, not a bug, and the skill tells you which switch is off rather
than guessing. It will name **Settings → Voice** once when voice has simply never
been turned on — but if you muted _that folder_ on purpose, it says so and drops the
subject instead of asking you to undo it. It also never falls back to a shell
command after a refusal: that would use speakers you just closed.

**Outside Harnu** — the same skill in a plain terminal, where there are no Harnu verbs
at all — it falls back to whatever text-to-speech command is already on your `PATH`:
the one named in the `HARNU_TTS_COMMAND` environment variable when you set it (the
older `CAPY_TTS_COMMAND` still works), and otherwise the voice your OS ships: `say` on
macOS, `spd-say -w` (speech-dispatcher) on Linux. If it finds neither, it says so in one line and prints the
summary as text — it never pretends to have spoken.

Anything that takes the text as its argument works, for example
`HARNU_TTS_COMMAND="espeak-ng -s 150"` on Linux or `HARNU_TTS_COMMAND=say` on macOS.

One thing to expect either way: **a spoken line is short.** Harnu's voice cuts an
utterance at about 300 characters, so the skill leads with the headline and leaves
the detail on screen. Audio can't be skimmed.

## `doc-reader` — let a small model read large docs

The panel also lists one entry that is not a skill: **`doc-reader`**. It is off by
default, switched like any other row, and when it is on for a folder its sessions get
two things:

- a **`harnu:doc-reader` agent** that runs on Haiku and may only read files (`Read`,
  `Grep`, `Glob`);
- a **read gate**: when the main model tries to read a whole documentation file —
  `.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc` — longer than the folder's
  threshold, the read is refused with a message telling it to ask the doc-reader its
  question instead. The agent reads the file and answers; only the answer enters the
  main model's context.

What still goes through, by design:

- **Reading a section.** A `Read` with a `limit` of at most the threshold passes, which
  is what the model does before editing a doc. Starting at an `offset` with no `limit`
  reads to the end of the file, so that counts as a whole read, and so does a `limit`
  larger than the threshold.
- **Small docs, code files, and anything that is not a doc.**
- **A subagent's reads**, including the doc-reader's own.
- **A filtered shell read** such as `cat big.md | grep error` or `cat big.md > out.txt`.

**The threshold** is 350 lines unless you change it. Pick the project scope at the top
of the panel and the `doc-reader` row shows a **Threshold** field for that folder;
clear it to go back to the default. Like every switch here, it applies to sessions
started from now on.

**Why it exists.** In our evaluation (11 questions over Harnu's own specs), turning it on
cut the cost of a session by 63% and the main model's input tokens by 52%, with answers
graded just as correct. Offering the agent without the gate saved only 27%: the model
rarely chose to delegate on its own.

**It needs Harnu running.** The gate is answered by Harnu itself. A session whose Harnu
has quit — or a `claude` you run outside Harnu — reads every file as usual; nothing
breaks. It is never added to a read-only Scheduler worker,
because it cannot call an agent and a refused read would leave them stuck. It has no
"Also outside Harnu" switch.

## Turning one on

1. Open **Settings → Skills**.
2. Pick a scope at the top: **Global** (every folder) or the **current project**
   (the folder of the session you have selected — the pill is greyed out when
   nothing is selected).
3. Flip the switch on the skill you want.

Under a project scope each row gets three choices instead of a switch:
**Default** (inherit whatever Global says), **On**, and **Off**. A project's explicit
choice always wins — you can turn a skill off for one repo while it stays on
everywhere else, and vice versa.

**Changes apply to sessions started from now on.** A session that is already running
keeps whatever it was given at launch.

## How Harnu hands them to a session

When you start a session in a folder, Harnu copies **only the skills that are on for
that folder** into its own application-data directory and points the session at that
copy. A skill that is off is never copied, so it is genuinely absent from the
session's list — not hidden, not merely discouraged.

Two consequences worth knowing:

- **Nothing is written into your repository.** Not a config file, not a gitignored
  one, not a `.claude/` directory. Your project's working tree is untouched, and
  `git status` stays clean.
- **Only sessions Harnu starts get them.** A `claude` you run yourself in a terminal
  sees nothing — unless you use the Advanced switch below.

## If you already have a skill with the same name

Nothing of yours is touched. Harnu's skills arrive **namespaced**: if you have your own
`mission`, the session lists both — yours as `mission`, Harnu's as `harnu:mission`. The
panel flags the row so you know it will happen. Harnu never deletes, renames, moves or
disables a skill you wrote.

Once you have the bundled version on, your personal copy may be redundant. Removing it
is your call; Harnu does nothing about it on its own.

## Advanced — "Also outside Harnu"

Under **Advanced** (collapsed by default, Global scope only) there is a second switch
per skill. Turning it on installs that skill at `~/.claude/skills/<name>/SKILL.md`, so
your own terminal sessions pick it up too. The panel shows the exact path.

Two caveats, both stated on the switch:

- Skills installed this way land **unnamespaced**, so a personal skill of the same
  name genuinely competes with it — unlike the in-Harnu path above, where both coexist.
- Harnu **refuses to overwrite** a skill folder it did not create. If the directory is
  already there and Harnu did not write it, the switch declines and tells you so, and
  nothing is changed. Turning the switch off removes only a folder Harnu installed.

## Related

- [Agent control](agent-control.md) — the MCP verbs the `conductor` skill drives.
- [Roadmap board](roadmap-board.md) — the cards `orchestrate-delivery` creates and
  dispatches.
- [Settings](settings.md) — the rest of the Settings tabs.

Skills are not mods: a skill is an instruction file, while a mod runs code inside `claude`. To see what the mods your sessions can load are able to do, open **Settings → Mods** — see [Mods](mods.md).
