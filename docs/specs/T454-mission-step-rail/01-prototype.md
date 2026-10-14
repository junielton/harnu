# T454 — Prototype: the mod half of the rail, and its runs

Part of the [T454 spec](00-spec.md) (AC C-5, and the "shown by a run" half of C-1). This file
holds the complete prototype mod (round 2), the real output of `claude plugin validate`,
`claude plugin test` and `tsc -p`, the round-1 verifier's probes run against it, and the
transcripts of the live sessions that drove it by key.

## 1. What the prototype is, and what it is not

It is the **mod half** of the design: the band above the prompt drawn from host-pushed state, the
one cut order of spec §6.2 with keys reserved first, the four actions with their confirm and
fields, Retry and Dismiss, the focus rules of spec §7.5, the press that leaves as an event
carrying the action and the revision only, the TTL, and the fail-open render hook. It is a
standalone plugin named `rail-proto` so it can run from the session scratchpad.

It is **not** the companion. In the spec the mod half lives in `resources/companion/` (spec §9)
and talks to Harnu over the companion's command channel: the host pushes the rail inside
`ui.band.set` and a press leaves as a `ui.action` edge event. The prototype replaces that channel
with one `$.http.fetch` POST to a stand-in host that carries both directions, so the kit can
script the host with one bottom hook. The host half ([`02-host.md`](02-host.md)) is not
prototyped.

Files, as run (formatted with the repo's `.prettierrc.yaml`):

| File                         | Role                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json` | manifest, names the contract                                                                        |
| `hooks/hooks.json`           | one module, `./register.ts` (a `.ts` module, as the companion's is)                                 |
| `hooks/register.ts`          | owns `$`: the poll, the TTL, the presses, the per-instance "drew a key last frame", the render hook |
| `hooks/rail-core.ts`         | pure and `$`-free: the status word, `fitRow` (the cut order), every row, `reconcile`, `checkTarget` |
| `hooks/rail-view.tsx`        | pure: the trees, built from the resolved elements and closures, never `$`                           |
| `types/index.d.ts`           | the contract: the pushed `RailView` and the local `RailMode`                                        |
| `tests/rail.test.ts`         | eleven kit tests, mounting the band on the `terminal` surface                                       |

The split `register.ts` + imported `rail-view.tsx` is the layout T389 P4W2 planned for the
companion (`surface.tsx` imported by `register.ts`, P4W2 §7.1), and P4W2 §7.4 left open whether
the engine accepts JSX in a file a `.ts` module imports. It does on 2.1.295: it validates, tests
and draws in a live session.

What changed since round 1: notes are fitted inside the row instead of appended after it (no
overflow at any width, test 9); an open confirm or field is never removed by a push, an expiry or
a width change, and its target is checked when the person ends it (`checkTarget`); an idle row
that drew a key keeps one (`keep` keys, Dismiss); the mode is reconciled on every push and expiry
(`reconcile`); Retry; the owner row matches spec S2. Round 3: a field or confirm pins the revision and step number it
opened on and the press names the pinned revision; no timer closes an abandoned field (a first
round-3 build closed it after five minutes and was withdrawn: closing to idle left nothing
focusable).

## 2. Source

The mod is in [`03-prototype-source.md`](03-prototype-source.md); its tests and the type-check
config are in [`04-prototype-tests.md`](04-prototype-tests.md),
split out for length.

## 3. Runs (2026-10-09, round 3)

Output pasted as printed; the scratchpad path is shortened to `<scratchpad>`. The session's own
Claude Code was 2.1.295; the CLI on `PATH` updated itself to 2.1.296 during the session, so the
kit runs are shown on both binaries (the 2.1.295 one run by its versioned path). Test 9 prints
every state at 115, 75 and 40 columns; spec §6.3–§6.4 are copied from these lines.

```
$ claude plugin validate rail-proto   # Claude Code 2.1.295
Validating plugin manifest: <scratchpad>/rail-proto/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: rail-proto.rail, rail-proto.mode

Validating hooks: <scratchpad>/rail-proto/hooks/hooks.json

  ❯ ./register.ts hooks: session.start, ui.render{component=AbovePrompt}
  ❯ ./register.ts calls: $.clock.every, $.clock.now (via sync, tick), $.http.fetch (via sync), $.state.get, $.state.set, $.ui.resolve
  ❯ ./register.ts state writes: rail-proto.mode, rail-proto.rail
  ❯ ./register.ts state reads: rail-proto.mode, rail-proto.rail

✔ Validation passed
(exit 0)

$ claude plugin test rail-proto   # Claude Code 2.1.295 (the stand-in host's thrown fetches print one "skipped" line each; filtered here)
S3 running @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  c: Claim  b: Block  l: Log
S3 running @75: ◆ Step 3 of 7 · Wire the rail IPC ch… · Running  c: Claim  b: Block  l: Log
S3 running @40: ◆ Step 3 of 7 · Running  c: Claim
S4 blocked, stale @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Blocked: needs the staging API key  u: Clear block  l: Log
S4 blocked, stale @75: ◆ Step 3 of 7 · Blocked: needs the staging API key  u: Clear block  l: Log
S4 blocked, stale @40: ◆ Step 3 of 7 · Blocked  u: Clear block
S5 claimed @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Verifier  b: Block  l: Log
S5 claimed @75: ◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log
S5 claimed @40: ◆ Step 3 of 7 · Claimed  b: Block
S5 self-verified @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Verifier  b: Block  l: Log
S5 self-verified @75: ◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log
S5 self-verified @40: ◆ Step 3 of 7 · Claimed  b: Block
S5 verified @115: ◆ Step 3 of 7 · Wire the rail IPC channel · ✓ Verified · Verifier  l: Log
S5 verified @75: ◆ Step 3 of 7 · Wire the rail IPC channel · ✓ Verified · Verifier  l: Log
S5 verified @40: ◆ Step 3 of 7 · ✓ Verified  l: Log
S5 done (needs-human) @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Done · Verifier  l: Log
S5 done (needs-human) @75: ◆ Step 3 of 7 · Wire the rail IPC channel · Done · Verifier  l: Log
S5 done (needs-human) @40: ◆ Step 3 of 7 · Done  l: Log
S6 stale @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Waiting · Verifier · mission stale 2h 15m  c: Claim  b: Block  l: Log
S6 stale @75: ◆ Step 3 of 7 · Wire the rail IPC ch… · Waiting  c: Claim  b: Block  l: Log
S6 stale @40: ◆ Step 3 of 7 · Waiting  c: Claim
S2 owner @115: ◆ Harnu Steps 3–4 of 7 · blocked
S2 owner @75: ◆ Harnu Steps 3–4 of 7 · blocked
S2 owner @40: ◆ Harnu Steps 3–4 of 7 · blocked
S7 refused, mission closed @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Not saved: mission closed. · Verifier  c: Claim  b: Block  l: Log
S7 refused, mission closed @75: ◆ Step 3 of 7 · Not saved: mission closed.  c: Claim  b: Block  l: Log
S7 refused, mission closed @40: ◆ Step 3 of 7 · Not saved.  c: Claim
logged @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Logged. · Verifier  c: Claim  b: Block  l: Log
logged @75: ◆ Step 3 of 7 · Wire the rail IPC ch… · Logged.  c: Claim  b: Block  l: Log
logged @40: ◆ Step 3 of 7 · Logged.  c: Claim
claim confirm @115: ◆ Claim step 3 as done? A verifier still checks it.  y: Claim  n: Cancel
claim confirm @75: ◆ Claim step 3 as done? A verifier still checks it.  y: Claim  n: Cancel
claim confirm @40: ◆ Claim step 3?  y: Yes  n: No
claim confirm @30: ◆ Claim step 3?  y: Yes  n: No
S8 unreachable after a press @115: ◆ Step 3 of 7 · Wire the rail IPC channel · Harnu is not reachable. Nothing was saved.  r: Retry  x: Dismiss
S8 unreachable after a press @75: ◆ Step 3 of 7 · Nothing was saved.  r: Retry  x: Dismiss
S8 unreachable after a press @40: ◆ 3/7 · Nothing was saved.  x: Dismiss
blocker Input @115: ◆ Blocker on step 3: [what blocks it (Enter on empty cancels)] ⏎ raise
blocker Input @75: ◆ Blocker on step 3: [what blocks it] ⏎ raise
blocker Input @40: ◆ Block: [] ⏎ raise
final, mission closed, a press lost @115: ◆ Mission closed or step unlinked. Nothing was saved.  x: Dismiss
final, mission closed, a press lost @75: ◆ Mission closed or step unlinked. Nothing was saved.  x: Dismiss
final, mission closed, a press lost @40: ◆ Nothing was saved.  x: Dismiss
final, step changed, a press lost @115: ◆ The step changed. Nothing was saved.  x: Dismiss
final, step changed, a press lost @75: ◆ The step changed. Nothing was saved.  x: Dismiss
final, step changed, a press lost @40: ◆ Nothing was saved.  x: Dismiss
final, line gone while the band held keys (idle) @115: ◆ Mission closed or step unlinked.  x: Dismiss
final, line gone while the band held keys (idle) @75: ◆ Mission closed or step unlinked.  x: Dismiss
final, line gone while the band held keys (idle) @40: ◆ No step now.  x: Dismiss
tests/rail.test.ts:
(pass) fits the child row to bodyColumns and cuts in the declared order [49.71ms]
(pass) claim is two presses and sends the action and revision, never a step id [23.20ms]
(pass) a blocker reason is typed into the band; an empty one cancels [23.63ms]
(pass) Harnu unreachable: nothing was saved, Retry and Dismiss, fitted at every width [60.28ms]
(pass) F-1: an open field or confirm outlives every push, expiry and width; an idle row keeps a key [83.96ms]
(pass) a refused press says so once, inside the width [36.19ms]
(pass) blocked: the reason outranks the title, the level goes first [33.12ms]
(pass) wraps what another mod drew and yields to a survey [41.03ms]
(pass) every state fits at 115, 75 and 40 (printed) [165.94ms]
(pass) a press carries the revision the person saw, and the field keeps naming its step [27.15ms]
(pass) a field left open stays, with the line present or gone, for as long as it is left [728.39ms]
 11 pass
 0 fail
Ran 11 tests across 1 file. [1.41s]

$ claude plugin test rail-proto   # Claude Code 2.1.296 (the CLI updated during the session)
 11 pass
 0 fail
Ran 11 tests across 1 file. [1.38s]

$ tsc -p tsc-rail   # TypeScript 5.6.3 against the 2.1.295 claude-code.d.ts
(exit 0, no output)
```

The tests were checked against deliberate breakages before they were trusted. Round 1: dropping
`{below}` from `stack` fails test 8, and adding a `stepId` to the press event fails tests 2 and 3.
Round 2: drawing the field only while the line exists fails test 5, and not adding Dismiss to an
idle row whose actions went away fails test 5. Round 3: sending the current revision instead of the
pinned one fails test 10, and closing a field on a timer (the withdrawn build) fails test 11. All were reverted.

**The round-1 verifier's probes**, copied unchanged from its scratchpad and run against this
prototype (`tests/probe.test.ts` in place of `rail.test.ts`; each line is the row's text and its
focusable elements):

```
PROBE75 "◆ Step 3 of 7 · Nothing was saved." 34 rail-retry,rail-dismiss
PROBE115 "◆ Step 3 of 7 · Wire the rail IPC channel · Harnu is not reachable. Nothing was saved." 86 rail-retry,rail-dismiss
PROBE before close rail-block
PROBE after close rail-block undefined
PROBE ask before rail-claim,rail-block,rail-log
PROBE ask after rail-dismiss ◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier
PROBE ttl rail-log
PROBE confirm@59 rail-yes,rail-no ◆ Claim step 3 as done?
PROBE confirm@39 rail-yes,rail-no
 5 pass
 0 fail
```

**The round-2 verifier's probes**, also unchanged (they add the race, the 40-column band and the
field left open past a new mission). Probe `sent` is the case round 2 failed: the log field opened
on step 3 at revision 5, the mission closed, a line for step 5 arrived at revision 9, and Enter
sent a note. It now names revision 5, the one the person saw, and the field's label still reads
"Log on step 3" (test 10 and `LIVE` E9). Probe `race b` is the residual of spec §7.5 (K-10): the
key is no longer drawn, so the kit cannot press it; in a live session that letter goes to the
prompt (E6).

```
PROBE75 "◆ Step 3 of 7 · Nothing was saved." 34 rail-retry,rail-dismiss
PROBE115 "◆ Step 3 of 7 · Wire the rail IPC channel · Harnu is not reachable. Nothing was saved." 86 rail-retry,rail-dismiss
PROBE before close rail-block
PROBE after close rail-block undefined
PROBE ask before rail-claim,rail-block,rail-log
PROBE ask after rail-dismiss ◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier
PROBE ttl rail-log
PROBE confirm@59 rail-yes,rail-no ◆ Claim step 3 as done?
PROBE confirm@39 rail-yes,rail-no
PROBE race keys rail-unblock,rail-log
PROBE race b NO BUTTON: press: no Button of rail-proto keyed "rail-block" is drawn i
PROBE @40 keys rail-claim
PROBE field after new line rail-log
PROBE sent [{"t":"ui.action","d":{"name":"step.log","rev":5,"text":"note"}}]
 8 pass
 0 fail
```

Every probe now ends with a focusable element: the field stays open when the host pushes `null`
and when the line expires, the actions give way to `rail-dismiss` when the host turns them off,
and the confirm keeps both keys at 59 and 39 columns. The unreachable row's text is 34 cells at 75 and 86
at 115; with its keys it fits both (test 4).

## 4. Live sessions (2026-10-09, Claude Code 2.1.295, tmux 3.4)

`tsc` and the kit exercise the hooks and the tree, never a surface's key routing or paint
(`TYPES:15584`, and the header at `TYPES:41-44`). The focus rules depend on key routing, so the
same mod ran in real interactive sessions:

1. A stand-in host (`node host.mjs`, 35 lines in its round-2 form) on `127.0.0.1:47999` answered
   every POST with the child band of the tests and logged every event; on `step.claim` it bumped
   `rev` and set the step to `claimed`/`done`. A `/set` route let the run change the band: turn
   the actions off, keep only block and log, change the state, push `null`.
2. `claude --plugin-dir <scratchpad>/rail-proto` in a detached tmux session, 120 × 30, in an empty
   folder.
3. Keys sent with `tmux send-keys`; after each, the rows holding `◆` and `❯` were captured with
   `tmux capture-pane`. The engine pads the band row to the `[-]` mark at the right edge; that
   padding is collapsed to two spaces below.

### 4.1 Round 1 (the round-1 build)

```
== start, 120 columns
◆ Step 3 of 7 · Wire the rail IPC channel · Running  c: Claim  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== c typed with the prompt focused
◆ Step 3 of 7 · Wire the rail IPC channel · Running  c: Claim  b: Block  l: Log  [-]
❯ c
== ctrl+x tab, then c
◆ Claim step 3 as done? A verifier still checks it.  y: Claim  n: Cancel  [-]
❯ Try "how does <filepath> work?"
== y
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== b
◆ Blocker on step 3: what blocks it (Enter on empty cancels) ⏎ raise  [-]
❯ Try "how does <filepath> work?"
== reason typed, Enter
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== Esc, then 1 typed into the empty prompt
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log  [-]
❯ 1
== terminal width 144
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Verifier  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== terminal width 80
◆ Step 3 of 7 · Claimed  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== terminal width 62
◆ Step 3 of 7 · Claimed  [-]
❯ Try "how does <filepath> work?"
== terminal width 45
◆ Step 3 of 7 · Claimed  [-]
❯ Try "how does <filepath> work?"
== terminal width 38
❯ Try "how does <filepath> work?"
== host log
{"listening":47999}
{"at":1791575769735,"ev":{"t":"ui.action","d":{"name":"step.claim","rev":5}}}
{"at":1791575772049,"ev":{"t":"ui.action","d":{"name":"step.block","rev":6,"text":"needs the staging API key"}}}
```

A separate run with the host killed: pressing `l`, typing a note and Enter drew the unreachable
note, and 95 s later the band row was gone (TTL 90 s, poll 2 s).

**Finding F-1.** The first round-1 run used a build whose "saving" state drew no Button. After
`ctrl+x tab`, `c`, `y`, the band held nothing focusable, the keys returned to the prompt, and the
next `b` and the typed blocker reason went into the prompt; Enter **submitted them to the model as
a user turn** (`❯ bneeds the staging API key`; the turn was interrupted with Esc before any tool
ran).

### 4.2 Round 2: what moves the keyboard (the round-2 build before the field rule)

The first round-2 run did `ctrl+x tab`, had the host turn the actions off, then typed `q`, `x`,
`q`: all three landed in the prompt (`❯ qxq`). The question was why. Five experiments, each in a
fresh session:

```
## E1 focus, then 5 s of polls that change nothing visible, then c
== c
◆ Claim step 3 as done? A verifier still checks it.  y: Claim  n: Cancel  [-]
❯ Try "write a test for <filepath>"
## E3 focus, the host changes the text only (running -> waiting), then c
== pushed
◆ Step 3 of 7 · Wire the rail IPC channel · Waiting · Verifier  c: Claim  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== c
◆ Claim step 3 as done? A verifier still checks it.  y: Claim  n: Cancel  [-]
❯ Try "how does <filepath> work?"
## E4 focus, the host removes Claim (block, log stay), then b
== pushed
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  b: Block  l: Log  [-]
❯ Try "refactor <filepath>"
== b
◆ Blocker on step 3: what blocks it (Enter on empty cancels) ⏎ raise  [-]
❯ Try "refactor <filepath>"
## E2 focus, the host removes every action (Dismiss drawn), then x
== pushed
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  x: Dismiss  [-]
❯ Try "fix lint errors"
== x
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  [-]
❯ Try "fix lint errors"
## E5 a press, then the host removes every action, then x
== c, n
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  c: Claim  b: Block  l: Log  [-]
❯ Try "create a util logging.py that..."
== pushed
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  x: Dismiss  [-]
❯ Try "create a util logging.py that..."
== x
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  [-]
❯ Try "create a util logging.py that..."
## E6 focus, then a letter that is no hotkey (q), then c
== q
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  c: Claim  b: Block  l: Log  [-]
❯ q
== c
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  c: Claim  b: Block  l: Log  [-]
❯ qc
```

- E1, E3, E4: polls, a pushed text change and a pushed removal of one key all leave the keyboard
  in the band.
- E2, E5: a push that replaces every action with a Dismiss keeps it too: `x` pressed Dismiss.
- **E6 (spec E15): a letter the band does not bind goes to the prompt, and the keyboard goes with
  it.** That explains the first run: its `q` left the band. It also shows that a Dismiss row does
  not protect someone who is typing: their next letters are not `x`.

### 4.3 Round 2: the field and the confirm (the final build)

```
## E7 the blocker field is open and half typed; the mission closes; typing goes on; Enter
== ctrl+x tab, b, 'needs the'
◆ Blocker on step 3: needs the  ⏎ raise  [-]
❯ Try "refactor <filepath>"
== the host pushes null
◆ Blocker on step 3: needs the  ⏎ raise  [-]
❯ Try "refactor <filepath>"
== typing goes on
◆ Blocker on step 3: needs the staging API key  ⏎ raise  [-]
❯ Try "refactor <filepath>"
== Enter
◆ Mission closed or step unlinked. Nothing was saved.  x: Dismiss  [-]
❯ Try "refactor <filepath>"
== x
❯ Try "refactor <filepath>"
## E8 the claim confirm at 38 columns, then y
== c, terminal width 38
◆ Claim step 3?  y: Yes  n: No  [-]
❯ Try "create a util logging.py that.…
== y
◆ Step 3 of 7 · Claimed  b: Block  [-]
❯ Try "create a util logging.py that.…
== back to 120
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Verifier  b: Block  l: Log  [-]
❯ Try "create a util logging.py that..."
== host log
{"listening":47999}
{"at":1791578225687,"set":"/set?band=null"}
{"listening":47999}
{"at":1791578242568,"ev":{"t":"ui.action","d":{"name":"step.claim","rev":1791578231}}}
```

E7 is F-1's scenario with the mission closing mid-sentence: the field kept every key, Enter sent
nothing and submitted nothing, and the final row said so. E8 is the confirm at 38 columns: both
keys stayed and `y` sent the claim.

### 4.4 Round 3: a note must not change step

The log field opened on step 3; the host pushed `null` and then a line for step 5 with a bumped
revision; the person typed a note and pressed Enter. The label kept reading "Log on step 3", and
the event the host logged carries the revision of the frame the field opened on (`1791579453`),
not the one in force when Enter was pressed:

```
## E9 the log field opens on step 3; the mission closes; a line for step 5 arrives; the note is sent
== ctrl+x tab, l
◆ Log on step 3: note (Enter on empty cancels) ⏎ log  [-]
❯ Try "how does <filepath> work?"
== null, then a line for step 5 (rev bumped)
◆ Log on step 3: note (Enter on empty cancels) ⏎ log  [-]
❯ Try "how does <filepath> work?"
== Enter
◆ Step 5 of 9 · Wire the rail IPC channel · Running · Verifier  c: Claim  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== host log
{"listening":47999}
{"at":1791579463829,"set":"/set?band=null"}
{"at":1791579466444,"set":"/set?n=5"}
{"at":1791579469591,"ev":{"t":"ui.action","d":{"name":"step.log","rev":1791579453,"text":"note for the old step"}}}
```

## 5. What the runs prove, and what they do not

| Claim                                                                                                                       | Shown by                                      |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Every state fits `bodyColumns` at 115, 75 and 40, keys included                                                             | kit test 9 (assertions and printout)          |
| The cut order, the reason outranking the title, "Nothing was saved." never cut                                              | kit tests 1, 4, 6, 7, 9                       |
| The rail wraps what plugins beneath it drew and yields to a survey                                                          | kit test 8                                    |
| A press leaves with the action and the revision, never a step id                                                            | kit tests 2, 3; live host log                 |
| Claim is two presses; an empty field cancels                                                                                | kit tests 2, 3; live                          |
| An open field or confirm survives a `null` push, the TTL, the host down, a width drop                                       | kit test 5; verifier's probes; live E7, E8    |
| An idle row whose keys go away keeps a Dismiss; past the TTL it turns final with Dismiss                                    | kit tests 4, 5; live E2, E5                   |
| Letters reach the band only after `ctrl+x tab`; an unbound letter returns to the prompt                                     | live round 1, E6                              |
| A press names the revision the person saw; a field keeps naming its step                                                    | kit test 10; verifier's `sent` probe; live E9 |
| A field or confirm left open stays, for ten minutes with the line present and past the TTL with it gone, and keeps its keys | kit test 11                                   |
| A digit typed into an empty prompt stays there when no band Button holds a digit                                            | live round 1                                  |
| A `.ts` hooks module may import a `.tsx` view                                                                               | validate, kit, live                           |
| **Not shown:** the companion channel, the host half, Harnu's xterm.js, the fullscreen layout                                | spec §12 W0, LV-T454-a/b                      |
