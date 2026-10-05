# T214 — A session blocked on an unknown boot prompt is a SCREEN fact Capy already reads, but never looks at for Claude panes

**Date:** 2026-08-08 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T214-detect-a-session-blocked-on-any-boot-prompt-generically-not-one.md`
**Verified against:** repo `main` @ `f35a79d` (= `2706083` + one docs-only commit), Claude Code **2.1.226** (`claude --version`, this machine, 2026-08-08)

> The card's premise — "one detector per known boot failure, six of them, and 2.1.225
> just added a seventh prompt" — is **correct about the count and wrong about the
> family**. All six detectors read the same axis (Capy's own delivery machinery, or the
> transcript). None reads the screen. Capy already owns a complete, tested screen-detection
> subsystem with a `blocked` state — and it is switched **off by an `isShellTerminal`
> guard** for exactly the pane class that matters. §1 proves this; §2 checks the claimed
> invariant predicate by predicate; §3 proposes the smallest change that makes it true.

## 1. Gap analysis — the existing family, read from source

Nine mechanisms are in scope. For each: the signal it consumes, what it catches, and what
it **structurally** cannot catch (not "hasn't been tuned for" — cannot, by construction).

### 1.1 Boot-timeout reaper (BUG-23 → BUG-37)

- **Signal:** `isSessionLive(syntheticId)` evaluated once, at a 120 s deadline
  (`AGENT_BOOT_TIMEOUT_MS`, `synthetic-reaper.ts:30`). Armed per synthetic
  (`sessions.ts:1268-1275`), fires into `reapSyntheticBoot` (`sessions.ts:1303`).
- **Catches:** a synthetic whose `ptyCreate` never produced a process → `taskState:'failed'`,
  `failureReason:'boot_timeout'` (`sessions.ts:1331-1335`).
- **Cannot catch:** anything with a live PTY. `bootVerdict` returns `'booted'` on the very
  first clause — `if (!p.present || p.isLive) return 'booted'` (`synthetic-reaper.ts:63`).
  A process that came up and immediately parked on a modal prompt IS a live PTY.
- **Second structural bound:** it only runs for rows where `s.synthetic === true`
  (`sessions.ts:1305`). Once a session migrates to a real uuid, **no** member of this
  family applies to it any more.

### 1.2 The `prompt_undelivered` reaper (BUG-60)

- **Signal:** `shouldReapUndeliveredPrompt({ promptQueued, ledgerStatus })`
  (`synthetic-reaper.ts:106-109`), called from the live-PTY branch of the same 120 s
  deadline (`sessions.ts:1307-1317`). Inputs are `hasAgentPrompt(id)` (`sessions.ts:1405`)
  and `injectionLedger.statusFor(id)` (`injection-ledger.ts:112`).
- **Catches:** a live PTY whose **paste-path** pre-prompt was never confirmed injected.
- **Cannot catch (a) — the common path:** BUG-66's mitigation made prompts ≤
  `AGENT_PREPROMPT_ARGV_MAX_CHARS = 8000` (`sessions.ts:605`) ride the deterministic argv
  positional (`sessions.ts:2556`, `:2655` → `claude-args.ts:418`). For those sessions
  `hasAgentPrompt` is `false` and the ledger is empty, so
  `shouldReapUndeliveredPrompt({ promptQueued:false, ledgerStatus:'none' })` is **`false`
  by design** (`synthetic-reaper.ts:107-108`) — deliberately, so a healthy promptless
  session is never flagged. `docs/capy-features.md:293-299` states this to the agent in
  as many words: an argv-delivered session "is watched by the boot-timeout reaper … but
  NOT by the undelivered-prompt reaper — it looks identical to a healthy promptless
  session because it IS one".
- **Cannot catch (b):** a session with no starting prompt at all (a plain "+ New session",
  or an operator-opened folder session). Same clause.
- **Net:** for the dominant dispatch shape as of `main` today, **1.2 is inert**.

### 1.3 Pre-prompt injection watchdog (spec `docs/specs/2026-07-15-preprompt-injection-watchdog.md`)

- **Signal:** `injectionVerdict` (`injection-watchdog.ts:85-91`) over the T172 ledger's
  `wasInjected(id)`. Shell in `TerminalPane.vue:1234-1288`; budget ≈ 3 s
  (`INJECTION_WATCHDOG_RETRY_MS = 750` × `MAX_ATTEMPTS = 4`, `TerminalPane.vue:1217-1218`).
- **Catches:** a queued prompt whose delivery attempt never resolved a PTY, or resolved one
  and never pasted.
- **Cannot catch (a):** it never arms unless a prompt is queued —
  `if (!sessions.hasAgentPrompt(sessionId)) return` (`TerminalPane.vue:1274`). The argv
  path never arms it. Same inert-ness as 1.2.
- **Cannot catch (b):** whether the bytes were **understood**. `paste-written` is recorded
  the moment `write()` succeeds, so a paste **into** a modal dialog reads as `injected` →
  `'delivered'` (`injection-watchdog.ts:86`). BUG-64 §"Mechanism" fact 3 names this
  explicitly.

### 1.4 BUG-61 — "delivered" meant "dequeued"

Not a new signal: a correction **inside** 1.3. The original core returned `'delivered'` on
`!promptQueued || !ptyLive`; the shipped core returns it only on `p.injected`
(`injection-watchdog.ts:86-88`), reading T172's ledger. It removed two false negatives from
the delivery axis. It added no new axis.

### 1.5 BUG-64 part A — `requireComposerReadyHook`

The **only** existing mechanism that is _about_ an unknown blocking prompt.

- **Signal:** the **absence** of a composer-ready hook. `fire(via)` refuses to paste when
  `via !== 'hook' && deps.requireComposerReadyHook`, recording `gate-escalated` instead
  (`prompt-inject-gate.ts:288-292`; ledger event type at `injection-ledger.ts:45-51`,
  status at `:116`). Wired from `hooksStatus().injectPerSession`
  (`TerminalPane.vue:1089-1092`, `:1164`, `:1175`).
- **Catches:** conceptually, _any_ first-run prompt — it declines to blind-type into a
  screen it cannot vouch for.
- **Cannot catch (a):** it exists only on the paste path. The argv path constructs no gate
  (`acquireInjectionTargetWithRetry` short-circuits on `hasPrompt()` — `TerminalPane.vue:1135`).
- **Cannot catch (b) — BUG-66, still open:** `settleWithoutInjecting` sets `settled` and
  calls `deps.onSettled` (`prompt-inject-gate.ts:280-286`), which is `teardown`
  (`TerminalPane.vue:1151-1159`, `:1169`) — disposing the `onHook` subscription
  (`:1178-1181`). So the first non-hook trigger to fire — quiescence at
  `INJECT_BANNER_QUIET_MS = 500` or the cap at `INJECT_READY_CAP_MS = 2500`
  (`TerminalPane.vue:1070-1071`) — destroys the listener that could still have rescued it.
  BUG-66 records 0/9 delivered on the build where this shipped.
- **Cannot catch (c) — the conceptual limit:** it can only ever say _"I have no proof the
  composer is ready"_. It can never say _"there is a prompt on screen waiting for a human"_.
  Those are different facts, and only the second one is actionable by an operator.

### 1.6 BUG-64 part C — the injection-escalation registry

- **Signal:** none of its own. `markPromptUndelivered` pushes a verdict the renderer
  already made over IPC (`sessions.ts:1354-1357` → `index.ts:889` →
  `injection-escalation-registry.ts:36`), which `taskStateRecord()` folds in as `'failed'`
  (`tool-handlers.ts:277`) with its reason (`:289`).
- **Catches:** the _visibility_ half — before it, `get_session`/`get_fleet` could not learn
  a session was stuck.
- **Cannot catch:** anything. It is pure transport. And the underlying blindness it was
  built around is untouched: `inflightToFleetInputs` still hardcodes
  `status: 'active' as SessionStatus` for every unmaterialized session
  (`tool-handlers.ts:236`).

### 1.7 BUG-64 part B — pre-seeding folder trust: **never implemented**

`grep -rn hasTrustDialogAccepted src/` → **0 hits**. The card's own CORRECTION
(2026-07-21) demoted it: ten Capy-created worktrees inside an already-trusted repo had no
trust entry and booted fine, so "fresh worktree ⇒ trust dialog" was false for the primary
use case. Recording this so T214 does not resurrect a premise its own card retracted.

### 1.8 Stagnation detector (T175 / T176)

- **Signal:** repeated tool-call fingerprints in the transcript tail —
  `deriveStagnation(entries)` (`stall-detect.ts:135-180`), consumed by `workingOrStuck`
  (`fleet-state.ts:173`).
- **Catches:** the _noisy_ stall — a busy session repeating itself while `modifiedMs` keeps
  advancing.
- **Cannot catch:** a session with no transcript. `deriveStagnation([])` returns
  `ZERO_VERDICT` (`stall-detect.ts:136`), and a session blocked before its first turn never
  writes a JSONL. It also requires `windowCalls.length >= STAGNATION_MIN_CALLS` (`= 8`,
  `stall-detect.ts:24`, `:177`) — the card's invariant is **zero** tool calls. T175 and
  T214 are exact complements: T175 is "many calls, no progress", T214 is "no calls at all".

### 1.9 The silence-only `stuck` rule

`workingOrStuck` (`fleet-state.ts:169-180`) is only reached from `resolveActivity` when
some upstream signal already says `working` (`fleet-state.ts:210`, `:215`, `:224`). A
boot-blocked session has **no** hook state, **no** PID-registry state, **no** transcript
state — it falls all the way to level 4, the legacy heuristic
(`fleet-state.ts:226-229`), where a synthetic's `status: 'active'` (set at creation,
`sessions.ts:2472`) plus a live PTY reads `working`. Forever.

### 1.10 T174 — validation, not a detector

T174 is the card that _proved_ the composition of 1.1–1.6 does not close the gap: 4 real
`create_session` calls into fresh `/tmp` repos, all 4 processes spawned, none received its
prompt, all 4 sat `active`/`inflight` 17+ min. Its output was BUG-64. It contributes
evidence, not machinery.

### 1.11 The screen-detection subsystem (A2) — the one that reads the screen

Complete, pure-core/thin-shell, tested (`tests/screen-detect-core.test.ts`,
`tests/detect-orchestrate-core.test.ts`, `tests/manifest-load-core.test.ts`,
`tests/manifest-registry.test.ts`, `tests/manifest-aider-real.test.ts`):

- `ScreenState = 'blocked' | 'working' | 'idle'` with **state** precedence
  `blocked > working > idle`, applied regardless of manifest rule order
  (`screen-detect-core.ts:42`, `:163-182`) — a spinner cannot mask a `(y/N)`.
- Blocked-**stickiness**: a `needs-input` pane holds until the normalized bottom buffer
  actually changes (`stickiness-core.ts:35-44`).
- Positive **classification** required: a manifest with no matching `process` / `titleRegex` /
  `contentAny` claims nothing, so an unrecognized pane is left alone
  (`screen-detect-core.ts:105-126`).
- User-**overridable and hot-reloaded**: `~/.claude/detectors/<agent>.json`, chokidar +
  100 ms debounce, merged per key over the builtin (`screen-detect.ts:98-137`,
  `manifest-registry.ts:111-131`).
- An `explain` trace logged on every state change (`screen-detect.ts:140-148`).
- Main-side authority retained for MCP: `screenStates` → `getScreenStates()`
  (`screen-detect.ts:54-62`) → `taskStateRecord()` (`tool-handlers.ts:271`).

**And it is structurally blind to Claude panes, by three independent guards:**

1. **No snapshot is ever emitted.** `wireLiveTerminal` computes
   `screenMode = …?.isShellTerminal === true` (`TerminalPane.vue:563-564`) and the
   per-chunk hook is `if (live.screenMode) scheduleScreenSnapshot(live)`
   (`TerminalPane.vue:618`). A Claude pane never calls `paneScreenSnapshot`.
2. **No `claude` manifest exists.** `BUILTINS` is `[CODEX, AIDER]`
   (`manifest-registry.ts:98`). Even if a snapshot arrived, `classifyManifest` would return
   `null` and `reduceDetect` would emit `undefined` (`detect-orchestrate-core.ts:137-142`).
3. **The merge tier would ignore it anyway.** `mergeState(hook, screen, 'hooks', now)`
   returns `hook ? hook.state : 'idle'` — the screen is never consulted
   (`state-merge-core.ts:85-87`). The module header says so as a design guarantee: "the
   hook FSM is the SOLE authority; the screen is never scraped, so a perfect-precision
   agent never regresses" (`state-merge-core.ts:15-17`).

### 1.12 The map, in one table

| #    | Mechanism                   | Axis it reads                       | Structurally cannot see                                 |
| ---- | --------------------------- | ----------------------------------- | ------------------------------------------------------- |
| 1.1  | Boot-timeout reaper         | PTY existence at T+120 s            | Any live PTY; any non-synthetic row                     |
| 1.2  | `prompt_undelivered` reaper | Prompt queue ∪ paste ledger         | The argv path (inert today); promptless sessions        |
| 1.3  | Injection watchdog          | Paste ledger, 3 s budget            | Unqueued prompts; whether bytes were _understood_       |
| 1.4  | BUG-61                      | — (correction to 1.3)               | —                                                       |
| 1.5  | `requireComposerReadyHook`  | Absence of a composer-ready hook    | The argv path; slow hooks (BUG-66); _what_ is on screen |
| 1.6  | Escalation registry         | — (transport for 1.2/1.3)           | —                                                       |
| 1.7  | Trust pre-seeding           | never built                         | —                                                       |
| 1.8  | Stagnation                  | Transcript tool-call tail, ≥8 calls | Zero-call / zero-transcript sessions                    |
| 1.9  | Silence `stuck`             | `max(modifiedMs, lastEventMs)`      | Anything never classified `working` upstream            |
| 1.11 | Screen detection            | **The rendered screen**             | **Claude panes** (3 guards above)                       |

**Finding.** There are not six detectors for six failures. There is **one signal family**
(Capy's own delivery bookkeeping) plus **one transcript detector**, and a **complete screen
detector that is turned off for the pane class in question**. A seventh member of the first
family would inherit the same blindness; the gap is not detector count, it is that nobody
looks at the screen.

### 1.13 One correction to the card

The card states a blocked session is "indistinguishable from a healthy idle session — same
`status: idle`". Against the recorded evidence it reads **`active` / `working`**, not idle:
BUG-60 ("sat in the Fleet as `working` indefinitely"), BUG-64 part C ("`get_fleet` reported
this stuck session as `status: "active"`, `inflight: true`"), and `fleet-state.ts:226-229`

- `tool-handlers.ts:236` explain why. This matters for the design: the false state to
  displace is an **over-reported `working`**, which is exactly the failure class
  `fleet-policy.ts`'s corroboration comment was written about (§2.2).

## 2. Is the invariant's signal already available?

> **Claimed invariant.** A session that booted, produced zero tool calls, and whose
> rendered screen shows a prompt awaiting input is blocked — regardless of which prompt it is.

### 2.1 Predicate by predicate

| Predicate                                             | Available today?                         | Where                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **booted** — a live process exists                    | **YES**                                  | renderer `liveTerminals` / `isSessionLive`; main `liveSessionKeys()` (`tool-handlers.ts:275`)                                                                                                                                                                                                                                                                                                  |
| **zero tool calls**                                   | **YES**, as a stronger and cheaper proxy | A `PreToolUse`/`PostToolUse`/`UserPromptSubmit` hook folds to `'working'` (`hook-state.ts:37-40`), so "the FSM has never recorded anything for this id" (`TaskStateRegistry.get(id) === undefined`, `task-state-registry.ts:28-30`) _is_ "zero tool calls, and in fact zero turns". The transcript-side form (`deriveStagnation`) cannot express zero — it floors at 8 (`stall-detect.ts:24`). |
| **the rendered screen shows a prompt awaiting input** | **NO — for Claude panes only**           | The classifier, the precedence, the stickiness, the hot-reload, the MCP disclosure all exist and are tested. The snapshot is never sent (`TerminalPane.vue:618`), no manifest claims the pane (`manifest-registry.ts:98`), and the merge tier discards it (`state-merge-core.ts:85-87`).                                                                                                       |

**Exactly one of three predicates is missing, and it is the one the card hinges on.** The
missing piece is not a detector — it is a wire, a manifest literal, and a tier flag.

### 2.2 The existing corroboration model, and why this design must copy it

`fleet-policy.ts:88-105`, verbatim in substance:

> A `working` claim is CORROBORATED, not trusted. […] An absolute `working` veto would
> make hibernation INERT […] So a session that claims to be working gets the STRICT
> threshold instead of immunity. The claim we lean on is weak and defensible: real work is
> never SILENT for a full hour […] We deliberately do NOT claim "work is never silent for
> 15 minutes" — that was spiked and came back inconclusive. The one-hour bar is the one the
> evidence actually supports.

Three transferable rules, all adopted below:

1. **Never veto on an unverified claim; downgrade its authority instead.** §3.3's boot
   window downgrades nothing that has evidence — it only fills a window where _no signal
   exists at all_.
2. **The corroborating signal must be one the claim cannot fake.** A hooked session cannot
   fake its own rendered screen, and a screen cannot fake a hook. They are independent.
3. **Set the bar where the evidence is, and say out loud what you refused to claim.**
   §7 lists the claims this spec explicitly does _not_ make.

`state-merge-core.ts:18-20` already anticipates this exact composition:

> `both` — an agent that emits hooks AND can be scraped. Hook wins while recent; a stale
> hook channel yields to the screen. (**Unused in v1, but the precedence is encoded +
> tested here so the tier is ready.**)

The tier this card needs was built and left dormant two features ago.

## 3. Decision — light up the screen tier for Claude panes during the boot window

**This is not a seventh detector.** It adds zero new modules under `src/main/detect/`, zero
new verdict cores, zero new failure reasons, zero new board states, zero new MCP verbs. It
is one builtin manifest literal plus two wiring changes plus one gate.

### 3.1 What ships

**(a) A `claude` builtin manifest** in `manifest-registry.ts`, appended to `BUILTINS`
(`:98`), classified by `match.process: ['claude']` with `contentAny` fallbacks (§3.5).

**(b) Snapshots for Claude panes.** `wireLiveTerminal`'s `screenMode`
(`TerminalPane.vue:563-564`) stops meaning "is a folder terminal" and starts meaning "this
pane is scraped". Concretely: `isShellTerminal === true || <this is a claude-kind pane>`.
The OSC-title subscription (`:584-589`) and the `paneScreenDetach` teardown (`:908-910`)
follow the same flag unchanged. `scheduleScreenSnapshot` already fires while the pane is
**detached** (`TerminalPane.vue:306-308`) — which is precisely the background-dispatched
fan-out case this card exists for.

**(c) The `both` tier, gated to the boot window.** `reduceDetect` hardcodes
`mergeState(null, screen, 'screen', now)` (`detect-orchestrate-core.ts:148`). It gains the
method as an input so a Claude pane resolves through `'both'` while a folder terminal keeps
`'screen'`.

**(d) The boot-window gate, main-side.** `registerScreenDetect` already takes one injected
predicate (`resolveProcess`, `screen-detect.ts:155-158`, wired at `index.ts:575`). It gains
a second — `hasHookState(sessionId): boolean`, backed by `hook-bridge.getTaskStates()`
(`hook-bridge.ts:252`). In the `pane:screen-snapshot` handler
(`screen-detect.ts:185-207`), a snapshot for a session that **already has a hook state** is
dropped and its `screenStates` entry cleared. The renderer stays dumb (it keeps sending; a
30-line debounced payload every 200 ms of quiet, bounded by `maxLive: 5`,
`fleet-policy.ts:53`) — simplicity over a chattier renderer-side disarm.

### 3.2 Why "boot window" and not `both` full-time

`HOOK_AUTHORITY_TTL_MS = 15_000` (`state-merge-core.ts:51`). A single long tool call (a
5-minute `npm test`) emits `PreToolUse` and then nothing until `PostToolUse`, so a
full-time `both` would hand authority to the screen mid-tool-call, every long call, for
every session — trading a rare boot failure for a common misclassification and knowingly
breaking the guarantee in `state-merge-core.ts:15-17`.

Restricting the screen tier to **"the hook FSM has never recorded anything for this id"**
is:

- **literally the card's invariant** — "booted, produced zero tool calls";
- **strictly additive** — today that window resolves to _nothing at all_ (`reduceDetect`
  is never invoked for the pane), so there is no state to regress;
- **self-closing** — a healthy session's first hook arrives in seconds and the pane reverts
  to `method: 'hooks'` permanently;
- **free of a new TTL** — no number to tune, no number to be wrong about.

**Cost, stated plainly:** a blocking prompt that appears _mid-session_ (a `/login`
re-auth, an MCP elicitation the hook channel misses) is **out of scope**. That is a
deliberate boundary, not an oversight — see §7 Q4.

### 3.3 What the verdict resolves to

`blocked → 'needs-input'` via the existing map (`state-merge-core.ts:53-63`). No new
vocabulary. Consequences, all free:

- Sidebar dot / Fleet card: `classifyFleetState` → `isNeedsInput` → `needs-you`
  (`fleet-state.ts:243-258`, `:276-282`).
- ActivityBell / Approval-Inbox surfaces: same `needs-input` axis they already read.
- MCP: `getScreenStates()` → `taskStateRecord()` (`tool-handlers.ts:271`) → `get_fleet` /
  `get_session` report `taskState: "needs-input"`.

**Deliberately NOT a `failureReason`.** A session waiting for a human is not a failure —
`prompt_undelivered` (`hook-state.ts:79-82`) means Capy lost the prompt, which is a
different fact with a different recovery (`retryPromptInjection`, `sessions.ts:1438-1449`).
Conflating them would make the retry action wrong.

### 3.4 One real hazard the wiring must handle

`screen-detect.ts:49-53` documents an invariant this change **breaks**:

> Disjoint from the hook FSM's `taskStates` by id space (`shellterm-*` vs a Claude uuid),
> so a merge never collides.

After (b), Claude ids appear in **both** maps. At the MCP layer the collision already
resolves correctly — `taskStateRecord()` writes screen states first and lets the hook FSM
overwrite (`tool-handlers.ts:271-276`, "hook FSM wins on overlap"), which is exactly the
`both` precedence. But the **renderer** push (`screen:state`, `screen-detect.ts:200-206`)
has no such guard. §3.1(d)'s boot-window gate is what keeps both paths honest: a session
with any hook state emits no screen state at all. **The doc comment at
`screen-detect.ts:49-53` must be corrected in the same change** — a stale invariant comment
is how the next reader reintroduces the bug.

### 3.5 The manifest — generic shape, not this week's prompt

This is the whole "ages well" claim, so it is a rule, not a preference: **`rules` key on the
STRUCTURE of a blocking prompt, never on its wording.** Load-bearing `blocked` alternatives:

- an Ink select menu — an arrow-marked option row (`❯`/`>` followed by an option, with or
  without a leading `1.`);
- the classic confirm shapes `(y/n)`, `(y/N)`, `[Y/n]`;
- `Press Enter to continue` / `Press any key`.

Plus `working` rules (the `esc to interrupt` / spinner family, same shape as `CODEX`,
`manifest-registry.ts:43`) and `idle` rules (the settled empty composer) so the fallback is
not doing the work, and **`fallback: 'idle'`** so an unmatched screen can never fabricate
`needs-input` — the same fail-safe posture the existing builtins take
(`manifest-registry.ts:20-23`: "a mis-tuned manifest fails safe toward `idle`, never a
false `blocked`").

Naming a specific prompt (2.1.225's workspace-trust dialog) is permitted only as an
_additional_ alternative, never as the only one — the generic set must stand on its own
with every named rule deleted.

**The escape hatch is the actual anti-aging property.** When Anthropic ships a prompt the
generic set misses, the fix is `~/.claude/detectors/claude.json` — a hot-reloaded JSON
override merged per key over the builtin (`screen-detect.ts:108-137`,
`manifest-registry.ts:111-131`), observable via the `explain` log
(`screen-detect.ts:140-148`). **No Capy release, no code change, no seventh card.** That is
what the card is asking for; it already exists and has never been pointed at Claude.

**Classifier caveat, verified:** `match.process` resolves through
`foregroundProcessName`, which is Linux-only — `if (process.platform !== 'linux') return null`
(`foreground-process.ts:47`). On macOS and Windows classification must fall to
`titleRegex` / `contentAny`, with the same scroll-fragility AIDER documents
(`manifest-registry.ts:60-65`). See §7 Q5.

### 3.6 Honest accounting: what this consolidates and what it does not

**Subsumes (as a follow-up card, not here):** BUG-64 part A's _purpose_. Once the screen
tier is live, `armInjectGate` can ask "is the screen `blocked`?" instead of "did a hook
arrive?" — a positive, content-based readiness proof. That also dissolves BUG-66's
regression, whose root cause is that the absence-of-hook proxy tears down its own listener
(`prompt-inject-gate.ts:280-292`). **Changing `fire()` belongs on BUG-66's card**, stacked
on this one. Recording the link, not doing the work.

**Does NOT subsume:**

- **1.1 boot-timeout reaper** — no PTY means no screen to read. Orthogonal, keep.
- **1.2 / 1.3 / 1.4 the delivery family** — a paste that never wrote leaves the screen
  looking like a _healthy idle composer_. The screen cannot see a missing byte. Keep,
  including the ledger.
- **1.8 stagnation** — the exact complement (≥8 calls vs zero calls). Keep.

**So the answer to the card's question is: a genuinely new layer — but assembled entirely
from existing, tested plumbing.** Nothing in §1 is deleted by this spec.

## 4. Files touched

| File                                                    | Change                                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/detect/manifest-registry.ts`                  | New `CLAUDE` `RawManifest` literal; append to `BUILTINS` (`:98`)                                                                                                                                |
| `src/main/detect/detect-orchestrate-core.ts`            | `reduceDetect` takes a `DetectionMethod` (default `'screen'`) and passes it to `mergeState` (`:148`); doc header (`:16-20`) corrected — the hook tier is no longer dormant                      |
| `src/main/detect/screen-detect.ts`                      | Second injected predicate `hasHookState`; boot-window drop + `screenStates` clear in the `pane:screen-snapshot` handler (`:185-207`); **correct the stale id-disjointness comment at `:49-53`** |
| `src/main/index.ts`                                     | `registerScreenDetect(…, foregroundProcessForSession, hasHookState)` (`:575`)                                                                                                                   |
| `src/renderer/src/components/TerminalPane.vue`          | `screenMode` = folder terminal **or** claude pane (`:563-564`); title sub (`:584`), snapshot hook (`:618`), detach (`:908-910`) follow it unchanged                                             |
| `docs/capy-features.md`                                 | §6 — agent-facing, + marker bump                                                                                                                                                                |
| `docs/user/sessions.md`, `docs/user/troubleshooting.md` | §6                                                                                                                                                                                              |
| `CHANGELOG.md`                                          | `### Added`                                                                                                                                                                                     |
| `tests/manifest-registry.test.ts`                       | The `claude` builtin compiles; override merge works                                                                                                                                             |
| `tests/manifest-claude-real.test.ts` _(new)_            | Real captured frames → verdicts (§5)                                                                                                                                                            |
| `tests/detect-orchestrate-core.test.ts`                 | The `'both'` method path through `reduceDetect`                                                                                                                                                 |
| `tests/screen-detect-boot-window.test.ts` _(new)_       | The `hasHookState` gate                                                                                                                                                                         |

No change to `src/main/mcp/tool-catalog.ts`, no new top-level `src/main/` file, no new
top-level component.

## 5. Test plan

| Test                                                                                                                                                                                                                                                                                                       | File                                              | Asserts                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `claude` builtin compiles and is claimed by `paneMatchesManifest` on `process: 'claude'`; a bash pane is still claimed by nothing                                                                                                                                                                      | `tests/manifest-registry.test.ts`                 | §3.1(a), `screen-detect-core.ts:105-126`                                                                                                             |
| **Real captured frames.** A verbatim capture of the 2.1.226 blocking prompt → `blocked`; a verbatim capture of the settled empty composer → `idle`; a verbatim capture of a running turn → `working`                                                                                                       | `tests/manifest-claude-real.test.ts` _(new)_      | §3.5. Mirrors `tests/manifest-aider-real.test.ts`, the precedent for tuning against captures instead of documentation (`manifest-registry.ts:57-65`) |
| **Generic-not-specific.** With every prompt-name-bearing alternative deleted from the manifest, the blocked capture still resolves `blocked`                                                                                                                                                               | `tests/manifest-claude-real.test.ts`              | §3.5 — the anti-aging property, pinned as a test                                                                                                     |
| A blocked frame co-rendered with a spinner still resolves `blocked`                                                                                                                                                                                                                                        | `tests/screen-detect-core.test.ts`                | `SCREEN_STATE_PRECEDENCE` (`:42`)                                                                                                                    |
| `reduceDetect(prev, snap, [claude], now, 'both')` with `hook: null` → screen decides; with a recent hook → hook decides; with a hook older than the TTL → screen decides                                                                                                                                   | `tests/detect-orchestrate-core.test.ts`           | §3.1(c), `state-merge-core.ts:92-98`                                                                                                                 |
| Boot window: a snapshot for an id with a hook state emits nothing **and clears any retained `screenStates` entry**; the same id with no hook state emits                                                                                                                                                   | `tests/screen-detect-boot-window.test.ts` _(new)_ | §3.1(d), §3.4                                                                                                                                        |
| A blocked pane holds `needs-input` across an identical re-render and releases on a changed buffer                                                                                                                                                                                                          | `tests/screen-detect-core.test.ts`                | `stickiness-core.ts:35-44`                                                                                                                           |
| An override at `~/.claude/detectors/claude.json` adding one `blocked` alternative merges over the builtin and keeps the builtin's `rules`… _(per-key overlay — verify the override shape actually needed: `resolveManifest` is a shallow top-level merge, so an override supplying `rules` REPLACES them)_ | `tests/manifest-registry.test.ts`                 | `manifest-registry.ts:111-131`, `manifest-load-core.ts:22-25`                                                                                        |

Shell wiring in `TerminalPane.vue` stays manual/e2e — the same boundary the existing screen
detection and boot-queue tests already draw.

**Live verification is mandatory, not optional.** Per `docs/dev/live-verify-second-instance.md`:
dispatch into a directory with no trusted ancestor (a fresh `/tmp` git repo — the condition
T174 actually reproduced under, per BUG-64's CORRECTION), and confirm `get_fleet` reports
`taskState: "needs-input"` instead of `status: "active"` with no `taskState`. This card is
about a failure that unit tests have repeatedly declared closed while it was live
(T174's whole reason for existing).

## 6. Contracts touched

- **`CHANGELOG.md` — YES.** `### Added`: a session parked on a first-run prompt now shows
  as needing you instead of reading as working.
- **`docs/capy-features.md` — YES, and bump `<!-- capy-features vN -->`.** This clears the
  `CLAUDE.md` litmus on two counts: the **shape of what `get_fleet`/`get_session` report**
  changes (a dispatched session can now come back `needs-input` before it has done any
  work — an orchestrator polling a fan-out must not read that as "still booting"), and it
  is directly actionable (go look at that session; do not dispatch a replacement). It also
  needs a sentence distinguishing it from the two adjacent states the doc already
  documents: `hibernated` (`:274-282`, not stuck) and `prompt_undelivered` (`:284-304`, a
  delivery failure, retryable). **Note:** `scripts/ci/awareness-gate-core.mjs` only fires
  on a diff touching `tool-catalog.ts` or `capy-features.ts`, neither of which this change
  edits — so **CI will not force this**. It is a discipline requirement.
- **`docs/user/` — YES, and CI will also not force it.** `user-docs-gate-core.mjs` rule 2
  fires on an added file _directly_ under `src/main/`, and explicitly excludes
  `src/main/detect/**` as "internal fleet-state heuristics" (`:15-17`); rule 1 needs a new
  top-level component; rule 3 needs `tool-catalog.ts`. None apply. The behavior is still
  user-visible: update `docs/user/sessions.md` (a session can now show the needs-you dot
  before it has done anything) and `docs/user/troubleshooting.md` (what to do when it does,
  and that `~/.claude/detectors/claude.json` is the tuning seam). Do **not** take the
  `no-user-docs` label to skip work the gate merely fails to catch.
- **`design.md` — NO.** No new token, dot, ring, or state: this reuses `needs-input` /
  `needs-you` end to end (§3.3). Same reasoning as T176's D4. If review wants a distinct
  "blocked at boot" badge, `design.md` §6/§7 is edited **first**, in the same change.
- **i18n — NO** as specified (no new visible string). If a hint line is added to the
  session preview, the key lands in `en.json` **and** `pt-BR.json` in the same commit —
  `MessageSchema = typeof en` breaks `vue-tsc` otherwise
  (`docs/lessons/i18n/002-vue-i18n-schema-parity.md`).
- **English-only — YES**, trivially: all new code, comments, manifest patterns and copy are
  English.

## 7. Open questions — real uncertainty, flagged before implementation

**Q1 (blocking — run this first). Does a Claude session parked on the workspace-trust
prompt ever emit a hook?** The entire boot-window gate (§3.1(d), §3.2) rests on "no hook
has arrived". If Claude Code fires `SessionStart` _before_ the trust gate, the window
closes instantly and the gate must be redefined as "no **working-class** hook
(`UserPromptSubmit` / `PreToolUse` / `PostToolUse`, `hook-state.ts:37-40`) has ever
arrived" — a one-line change to the predicate, but only if we know. Note `SessionStart`
folds to `'idle'` (`hook-state.ts:59-60`), so it _would_ populate the registry.
**Experiment:** spawn `claude` with the real `--settings` blob
(`hook-settings-blob.ts:90-94`) in a `/tmp` git repo with no trusted ancestor and watch the
hook bridge. Cheap; unambiguous; sits next to T208 §5's pending matcher work.

**Q2. Does the 2.1.225 workspace-trust prompt render inside the PTY at all?** The card
asserts it exists; nothing in this repo verifies it, and this machine runs 2.1.226 with no
local CC changelog to read (`~/.claude/CHANGELOG.md` absent). If it is an Ink prompt in the
terminal, the screen sees it. If it is gated some other way — or is skipped entirely when
a prompt arrives as an argv positional (`claude-args.ts:418`) — the headline motivating
case may not reproduce. This does **not** invalidate the design (the generic layer is
worth having regardless), but it does change the acceptance evidence in §5.

**Q3. No capture of any Claude first-run prompt exists in this repo.** `AIDER` was tuned
against real output; `CODEX` was not, and its header says so ("modelled on documented
prompts, NOT all verified against a live pane", `manifest-registry.ts:20-23`). Shipping a
`CLAUDE` manifest without a capture repeats CODEX's mistake on a far more important pane.
The `tests/manifest-claude-real.test.ts` fixtures in §5 are a hard prerequisite, not a
nice-to-have.

**Q4. Mid-session blocking prompts are out of scope.** A `/login` re-auth or an MCP
elicitation appearing after the first hook is not covered (§3.2). Widening to full-time
`both` requires measuring real hook cadence during long tool calls against
`HOOK_AUTHORITY_TTL_MS = 15_000` — the same "measure before you pick a number" discipline
`fleet-policy.ts:102-104` applied to the one-hour bar. Separate card, after data.

**Q5. macOS / Windows classification.** `foregroundProcessName` is Linux-only
(`foreground-process.ts:47`), so `match.process` is unavailable there. Does Claude Code set
an OSC title a `titleRegex` could claim? Unverified. Without either, classification falls to
`contentAny` against a banner that scrolls off — the exact limitation AIDER documents
(`manifest-registry.ts:60-65`). The feature may be Linux-first at v1; if so, say so in
`docs/user/troubleshooting.md` rather than shipping a silently-degraded detector.

**Q6. Can a healthy idle composer trip a `blocked` rule?** A false `needs-input` on every
freshly-booted session would be worse than the bug. `fallback: 'idle'` plus positive-only
blocked rules is the guard, but only a real capture (Q3) can confirm the settled composer
does not itself look like an option row.

**Q7. Claims this spec deliberately does NOT make** (per §2.2 rule 3): that the screen can
detect a _lost paste_ (it cannot — §3.6); that "no hook for N seconds" implies blocked (no
such N is claimed, hence the boot window rather than a TTL); that a screen scrape may
override a live hook (it may not — `both` precedence, `state-merge-core.ts:92-98`); that
this removes any existing detector (it removes none).

## 8. Acceptance

- [ ] **Q1 answered before any code is written**, with the verbatim hook trace recorded in
      this spec — the boot-window predicate is derived from it, not guessed.
- [ ] Real frames of the 2.1.226 blocking prompt, the settled composer and a running turn
      captured verbatim and committed as test fixtures.
- [ ] `CLAUDE` builtin manifest lands in `manifest-registry.ts`, `fallback: 'idle'`, with
      `blocked` rules that resolve the captured blocked frame **with every
      prompt-name-bearing alternative deleted** — pinned by a test.
- [ ] Claude panes emit `pane:screen-snapshot`; the pane still emits while **detached**
      (the background-dispatch case).
- [ ] `reduceDetect` resolves Claude panes through `mergeState(…, 'both', …)`; folder
      terminals are unchanged at `'screen'`.
- [ ] The boot-window gate drops any snapshot for a session that already has a hook state
      **and** clears its retained `screenStates` entry.
- [ ] **No regression to hook precision:** a session with a live hook stream never has its
      `taskState` decided by the screen. Pinned by a test, not by inspection.
- [ ] A blocked pane holds `needs-input` across identical re-renders and releases when the
      bottom buffer changes.
- [ ] The stale id-disjointness comment at `screen-detect.ts:49-53` is corrected in the
      same change.
- [ ] **Live-verified** against a second isolated instance
      (`docs/dev/live-verify-second-instance.md`): a dispatch into a directory with no
      trusted ancestor reports `taskState: "needs-input"` via a real `get_fleet` call,
      where `main` today reports `status: "active"` with no `taskState`.
- [ ] A `~/.claude/detectors/claude.json` override adds a new `blocked` pattern and takes
      effect **without restarting Capy** — demonstrated, since it is the card's whole
      anti-aging claim.
- [ ] No existing detector is deleted or weakened; §3.6's "does NOT subsume" list is still
      true after the change.
- [ ] `CHANGELOG.md`; `docs/capy-features.md` + marker bump; `docs/user/sessions.md` +
      `docs/user/troubleshooting.md` — all four updated despite **neither CI gate firing**.
- [ ] `npm run typecheck` and `npm run build` pass; `scripts/ci/local-pipeline.sh` green.
