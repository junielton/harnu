# Bundled skills

Harnu ships a small set of **skills** — reusable instruction files a Claude session can
invoke by name — and lets you switch each one on or off from **Settings → Skills**.

They are all **off on a fresh install**. Nothing is added to your sessions until you
say so.

## What ships

| Skill                  | What it does                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrate-delivery` | Decompose an objective into board cards, dispatch one Harnu session per unit, monitor until each opens a PR, then hand back a report.                                                                                                |
| `delivery-verifier`    | Grade a finished unit's acceptance criteria one at a time, from evidence in the repo rather than from what the session says about itself.                                                                                            |
| `mission`              | Run one coordination tick over dispatched work and report a single line.                                                                                                                                                             |
| `delivery-watchdog`    | Sweep a repo for delivery work that is finished but parked — pushed with no PR, a card the board is lying about — and raise one notification naming the fix.                                                                         |
| `conductor`            | Drive the Harnu fleet through the `harnu` MCP verbs — see every session and worktree, create sessions, terminals and worktrees.                                                                                                      |
| `status`               | Render a fixed six-line "glance card" of where every feature or mission stands, plus the links worth opening, built from the board, the mission files and open PRs.                                                                  |
| `read-aloud`           | Speak a short, ear-friendly summary of a result out loud — through Harnu's own voice inside the app, or a text-to-speech command on your PATH outside it.                                                                            |
| `report-back`          | The final-report format every multi-step run ends with: one line per step with its concrete outcome, what you owe (always printed, even when it is nothing), the links worth opening, and a summary of at most three lines.          |
| `draft-to-prompt`      | Turn a rough idea or a messy draft into a finished prompt for a Claude model — including a boot prompt for a new session or worktree — with the model, effort and any long-running harness it needs spelled out as run instructions. |

Each row in the panel shows the skill's name and its own one-line purpose, taken
straight from the skill file — so the panel can never describe a skill differently
from what the session actually reads.

### `delivery-watchdog` is the second heartbeat over dispatched work

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
watching. It reads every running **mission** in the repo — the structured record the
orchestrating session keeps — and looks for: a mission Harnu has flagged as stalled
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

### The delivery skills work on Missions

`mission`, `status`, `orchestrate-delivery`, `delivery-watchdog` and
`delivery-verifier` all keep a coordinated delivery as a **Mission** — a structured
record Harnu stores in your repo's `.harnu/missions/` — rather than a free-form notes
file. What that changes for you:

- **You agree the finish line up front, and you end the mission at the end.** An
  orchestrating session sets up its mission before it sends out any work, proposes the
  finish line from the spec and asks you to confirm it in one question — your answer
  in chat is the agreement, so there is nothing to approve afterwards. It declares the
  whole plan at once, one step per pull request, and attaches the spec as scope. No
  skill can end a mission on your behalf, and once you end one (close or discard), its
  session stops coordinating it.
- **They report a mission the way the topbar does.** The `status` card, the `mission`
  tick and the watchdog all say "Step 4 of 5 · 2 verified" — the same numbers as the
  pill, worked out by Harnu — instead of counting proven steps on their own, and the
  status card prints each of its lines once.
- **Sign-offs are checks, not extra steps.** Tell a session "the designer must sign off
  the section" and it adds a check to that section's step for you to tick, rather than
  growing the plan. The same happens when `delivery-verifier` finds everything met
  except a part only a person can judge: the step counts as done and the human part
  becomes a check with a clear label.
- **When a session is waiting on you, Harnu tells you.** A session whose turn ends
  waiting on you — a merge, a key, a decision — raises a blocker in your name, which is
  what makes Harnu chime and remind you (after 30 minutes, then 1, 2 and 4 hours) until it's handled or the reminders run out.
- **Change the rules and the finish line follows.** Tell the session the delivery now
  ends differently (stacked PRs you merge yourself, a different target branch) and it
  proposes the new finish line on the spot, for you to approve.
- **Missions can actually close.** Before asking you to merge, the session retargets
  stacked PRs to your default branch. Once every unit is verified, it verifies the
  finish line itself — it built none of the units, so that counts — and asks you to
  close.
- **"Is it stuck?" has one answer.** Harnu works out whether a mission has stalled by a
  fixed rule, and every skill reads that same answer instead of guessing its own.
- **A step only counts as proven when someone other than its author verified it.**
  `delivery-verifier` grades code, UI, research and decision work each against its own
  rubric. With no browser tools available in the session, anything visual lands on your
  "check by hand" list rather than being passed on a code-reading argument.
- **Sessions reporting back find the right session.** A helper session addresses the
  session that dispatched it by its permanent id and looks up its current address right
  before sending — so a report is not lost when that session was parked and resumed —
  and it never sprays its report to other sessions when it can't reach the right one.

The `mission` skill no longer writes the old-style notes file in `.harnu/goals/` next to
each mission — the mission is the only record. Old notes files are left where they
are, and a session can still bring one over as a mission. If you had your own personal
`mission` or `status` skill, it is still there, untouched — removing it is your call.

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
