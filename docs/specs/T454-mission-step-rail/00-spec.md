# T454 — Mission step rail above the prompt

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T454 · **Mission:**
`mnt-f92b3961` · **ADR:** [`ADR-draft.md`](ADR-draft.md) (proposed; numbered on merge)

Files: this spec, [`01-prototype.md`](01-prototype.md) (the prototype mod, its `validate` / `test`
/ `tsc` output and a live session transcript) and [`ADR-draft.md`](ADR-draft.md) (where the rail
lives and how a press reaches a mission).

## 0. Summary

A session that builds a step of a Harnu Mission shows that step in a one-line band above the
prompt, and the person at the terminal can claim the step, raise or clear a blocker, or add a Log
note with a key, without typing a verb:

```
◆ Step 3 of 7 · Wire the rail IPC channel · Running  c: Claim  b: Block  l: Log  [-]
```

Six decisions shape it:

1. **The rail is content of T389 P4W2's band, not a new site.** P4W2 specified the companion's
   one `AbovePrompt` hook, its wrap-never-replace rule, its debounce and TTL, and the
   `ui.band.set` command. None of it has shipped (§4.2). The rail's first wave lands that site as
   P4W2 wrote it and adds an optional `rail` payload to `ui.band.set` (§4.3).
2. **Harnu main resolves the mission and pushes it.** The sessions the rail is for, executors an
   orchestrator dispatched, are spawned without the Harnu MCP server (`pty.ts:811-818`), and the
   companion may not call `$.mcp.call` (T389 SEC-9 (b)). So no `$.mcp.call`, no `$.harnu` noun:
   the host matches the session to its step, as T447's proposed D-A would, and pushes the result
   over the companion channel that every spawn already has (§8).
3. **A press is an event, and the host acts on it.** The mod sends the action and the revision it
   showed, never a step id. Harnu main checks it, resolves the step itself, and runs the same
   handler the `mission_*` verb runs, with the blocked-folder check, an audit record and a Log line
   (§7).
4. **Four actions, all agent-level writes.** Claim (`mission_update_step` with
   `proof: 'claimed'`), block (`mission_set_blocker`), clear block (`mission_clear_blocker`), log
   (`mission_log`). Verify, request close, end, checks and re-scope are deliberately absent: they
   belong to an independent verifier or to the operator's own doors (§7.2).
5. **Who sees it.** A linked child, inside Harnu, gets the rail with actions; the Topbar pill is
   owner-only, so this is chrome Harnu does not have for that session. An orchestrator inside
   Harnu gets nothing by default (the pill already says it, T389 R20). Outside Harnu the owner row
   is P4W2's row 4, with the pill's state word added (§5).
6. **Off until its live checks pass, then on; fails open.** A new Harnu mod key `rail`, one switch
   in Settings → Mods; every failure draws the band as if the rail did not exist (§10).

The band is drawn for the person. **The model does not read it** (§1, non-goals).

## 1. Origin and scope

**Origin.** Ideas 43 and 115 of the operator's ideation report
(`.harnu/out/claude-code-mods-ideas.md` in the main checkout, gitignored):

- Idea 43: "An executor session always sees its own Mission step — 'Step 3/7: wire IPC · verify:
  typecheck passes · blocker: none' — as a band above the prompt, with hotkeys to mark the step
  done or raise a blocker without typing a verb." Ranked in the report's "Ten I would build
  first": "Transitions become presses, not regex."
- Idea 115: "The band above the prompt shows the active Mission … with `[Log] [Blocker] [Request
close]` buttons … mirroring Topbar's MissionPill without the Electron chrome." Named there as an
  extension of the planned Harnu band (T389 P4W2).

**Goals.**

- G1. A linked child session shows its own step: position, title, state, proof, verification
  level, open blocker, and the mission's stall.
- G2. The person at that terminal moves the step with a key: claim it, raise or clear a blocker,
  log a note. Each press becomes a recorded mission write, not an inference from the transcript.
- G3. An orchestrator sees the mission's progress with the pill's own wording, where the pill is
  not on screen.
- G4. It works in every session Harnu spawns for an agent, none of which has Harnu MCP.
- G5. It never makes the session worse: no stolen keys, no stale step left on screen, nothing
  drawn over another mod's band.

**Non-goals.**

- **The model does not read the band.** `AbovePrompt` is drawn on the surface; nothing in it
  enters the transcript or a request. The idea's "executor never loses its step after compaction"
  is about the model's context, which is idea 45 ("Mission-aware compaction") and T389 P4W5. A
  closed-registry context row telling the executor's model that the operator moved its step is
  possible through P2W4's `context.append` and is left as open question OQ-5.
- No verification, close, re-scope, check or human-step door from the terminal (§7.2).
- No step list, no second row, no pane: one row, like every P4W2 line.
- No `$.harnu` dependency (T447) and no new MCP verb are required. The resolver it adds is the
  core T447 named as D-A, so D-A becomes a thin wrapper later (§8.2).
- No `/harnu-link` change (P4W2 §7.2), no open link (P4W2 §7.6).
- `desktop`, `vscode` and `mobile` surfaces: the hook returns `next(e)` there, as P4W2 does.

## 2. Conventions and sources

| Tag      | Source                                                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPES`  | `claude-code.d.ts` written by Claude Code **2.1.295** for the `plugin-authoring` skill (line 1: "Written by Claude Code 2.1.295."). Line numbers are that file's.                                                                                                       |
| `REF`    | That skill's `reference.md`, 2.1.295.                                                                                                                                                                                                                                   |
| `KB`     | The default keybinding table shipped with 2.1.295 (the `keybindings-help` skill's "Available Actions" and "Available Contexts" tables). The operator's own `~/.claude/keybindings.json` holds no binding.                                                               |
| `TC`     | `src/main/mcp/tool-catalog.ts` at this branch's base `cb7fb58`. Every other repo path is at that base too.                                                                                                                                                              |
| `T389/x` | `docs/specs/T389-companion-mod/<x>.md`. `T447/x` is `docs/specs/T447-harnu-sdk-noun/<x>.md`.                                                                                                                                                                            |
| `KIT`    | `claude plugin validate`, `claude plugin test` and `tsc -p` on the prototype, 2026-10-09 ([`01-prototype.md`](01-prototype.md) §3).                                                                                                                                     |
| `LIVE`   | The prototype in a real interactive session, Claude Code 2.1.295 in tmux, driven by key, 2026-10-09 ([`01-prototype.md`](01-prototype.md) §4).                                                                                                                          |
| `MEAS`   | A count made for this spec on the main checkout's `.harnu/missions/`, 2026-10-09: 17 mission files (6 `active`, 5 `delivered`, 6 `closed`), 109 steps, 141 `session` links; step title length min 15, median 40, 90th percentile 73, max 97 characters. Method in §8.4. |

**Verified** means read in the cited file or observed in `KIT`/`LIVE`. **Assumption** marks what
is inferred; each is listed in §13 with the check that settles it.

A note on the card's context: it calls T447 "PR #41, not merged". It merged as `9142876` before
this branch's base, so T447's spec is on `main` (spec only; no `resources/harnu-sdk/` exists and
`mission_get` still has no `childSessionId`, `TC:1394-1404`).

## 3. Grounding in the engine (C-1)

Every mechanism the design relies on, where it is declared, and how it was shown.

| #   | Mechanism                                                                                                                                                                                                                                             | Declared                                    | Shown by                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1  | `ui.render` on `{ component: 'AbovePrompt' }`: "A hook draws a tree, or passes; one instance … Raised on the terminal and desktop surfaces only."                                                                                                     | `TYPES:10245-10254`                         | `KIT` (all tests mount it); `LIVE`                                                                                           |
| E2  | `AbovePrompt` props `hasSurvey` (a hook yields to a survey), `isWorking`, `maxRows`, `bodyColumns`                                                                                                                                                    | `TYPES:10255-10284`                         | `KIT` test 5 (survey); `LIVE`                                                                                                |
| E3  | `bodyColumns` is "its column's width less the engine's five at the right end"                                                                                                                                                                         | `TYPES:10276-10284`                         | `LIVE`: a 120-column terminal draws the 90–119 tier, 144 draws ≥ 120                                                         |
| E4  | `Button.hotkey`: one digit or lowercase letter; pressed "while the plugin's site holds the focus … the band … after ctrl+x tab, a click"; "never the composer, save that a bare digit in an empty one answers a band Button"; "two clash, later wins" | `TYPES:1081-1088`; `REF:133`                | `LIVE`: `c` with the prompt focused was typed into the prompt; after `ctrl+x tab` it pressed; `1` stayed in the prompt       |
| E5  | `Button.plain` draws `c: Claim`                                                                                                                                                                                                                       | `TYPES:1099-1106`                           | `LIVE`                                                                                                                       |
| E6  | `Input`: same focus ring; "while it has focus every printable key reaches it alone and Esc returns them"; `onSubmit` on Enter; `autoFocus`                                                                                                            | `TYPES:5463-5513`                           | `KIT` test 3; `LIVE` (reason typed, Enter, no prompt submitted)                                                              |
| E7  | `ui.press`: "Fires when a `Button` … is pressed on a surface"; any plugin's hook may pass, rewrite or take a press                                                                                                                                    | `TYPES:3991-3999`                           | declaration (risk K-3)                                                                                                       |
| E8  | No plugin can press a Button at run time: `EngineInterface`'s `ui` noun has `focus` (`TYPES:2558`) and no `press`; `press(...)` exists only in the test kit                                                                                           | `TYPES:2540-2558`, `:15121`, `:15636`       | declaration (assumption A-4)                                                                                                 |
| E9  | `$.state`: a `get` while drawing subscribes the drawing; "Any plugin reads any value; its owner alone writes it"; another plugin "changes it by hooking `state.set`"                                                                                  | `TYPES:3376-3383`; `REF:118`                | `KIT` (the row redraws after a press without `$.ui.invalidate`); the rewrite clause is why a press carries no step id (§7.3) |
| E10 | `TextProps.wrap` (`truncate-end`)                                                                                                                                                                                                                     | `TYPES:12580`                               | `KIT`                                                                                                                        |
| E11 | Test kit: `$.ui.mount` on a named surface, `press`, `input`, `find`; `mock.clock`; inline `plugins`                                                                                                                                                   | `TYPES:15086`, `:15636`, `:15453`; `REF:81` | `KIT`                                                                                                                        |
| E12 | Keybinding contexts: `AbovePrompt` binds `tab`/`right`/`down`, `shift+tab`/`left`/`up`, `enter`/`space`, `escape`, the scroll keys; **no letter**. `abovePrompt:focus` is `ctrl+x tab`, `abovePrompt:toggle` is `ctrl+x ctrl+a`                       | `KB`                                        | `LIVE` for `ctrl+x tab`                                                                                                      |
| E13 | A `.ts` hooks module may import a `.tsx` view (P4W2 §7.4 left this open: "If the engine refuses JSX in a file that a `.ts` module imports …")                                                                                                         | `REF:14`                                    | `KIT` (validate passes, tests run) and `LIVE` (it draws)                                                                     |
| E14 | A band that loses its last focusable element hands the keys back to the prompt                                                                                                                                                                        | not declared                                | `LIVE`, finding F-1 ([`01-prototype.md`](01-prototype.md) §4)                                                                |

E14 is the one behaviour the declarations do not state, and it changes the design (§7.5).

## 4. Delta against T389 P4W2 (U-1)

### 4.1 What P4W2 specifies for the band

From `T389/P4W2-terminal-band-and-commands.md` (status "Specified (not implemented)", line 5):

| Topic         | P4W2                                                                                                                                                                                                                  | Lines        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Ownership     | `register.ts` registers the one `ui.render{component=AbovePrompt}` hook (MOD-4); the view is a pure builder `bandRow(els, band, columns)` in `surface.tsx`, which never receives `$`                                  | 92-102, 204  |
| Composition   | `const below = await next(e)` first, always; return a column of the Harnu row then `below`; return `below` unchanged for any non-terminal surface, `hasSurvey`, `maxRows < 1`, no line, `bodyColumns < 40`, any throw | 206-211      |
| Fitting       | five widths, 40/80/110/144, lead never cut, `dimColor` and bold only                                                                                                                                                  | 212-225      |
| Command       | `ui.band.set { line, parts?, link? }`, observe-only (admitted while `channel` is `shadow`), gate row for profiles `interactive` and `external`, feature `ui.band`                                                     | 165-174      |
| Debounce, TTL | enqueue only on change after `BAND_DEBOUNCE_MS` (500); keep-alive every `BAND_REFRESH_MS` (60 000); the mod clears a line older than `BAND_TTL_MS` (90 000) on a 30 s tick                                            | 165-167, 201 |
| State         | the `band` key, `{ v: 1; lead; detail?; hint?; href?; label?; n; expiresAt } \| null`; a lower `n` never overwrites a higher one                                                                                      | 190-194      |
| Policy        | row 1: **no band for a spawned session inside Harnu** (R20); row 4: an external, corroborated owner gets `◆ Harnu {headline}` from `progressHeadline`, detail `{n} held in Harnu`, a link                             | 176-183      |
| Non-goals     | "No `Button` in the band: nothing in protocol 1 is answered from the band"                                                                                                                                            | 76           |
| Gate          | prefs key `surface`, default `false`, turned on once its live checks pass                                                                                                                                             | 518-523      |
| Commands      | `/harnu-link status`, `/harnu-link open`                                                                                                                                                                              | 104-152      |

Constants are in `T389/01-contract.md:467-469`; the `ui.band.set` row at `:764`; `ui.action` as
an edge event at `:359-361`, `:588`, `:649`.

### 4.2 What shipped, checked in code

| P4W2 piece                                  | In code at `cb7fb58`                                                                                                                                                                                               | Status            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `ui.band.set` in the contract               | `CommandArgs['ui.band.set']` (`resources/companion/hooks/contract.ts:417`), `BandParts`/`BandLink` (`:387-395`); the host re-exports the mod's contract (`src/main/companion/contract.ts:6`)                       | types only        |
| Its gate rows                               | named in `command-gate-core.ts:36`, external-allowed at `:109`, observe-only in `shadowRefusal` (`:127-142`); tokenless-allowed in the mod (`lib/command-core.ts:107`, `lib/commands.ts:17`)                       | rows only         |
| The mod running it                          | not in `IMPLEMENTED_COMMANDS` (`lib/command-core.ts:97-104`), so the mod answers `CMD_UNSUPPORTED`                                                                                                                 | **not shipped**   |
| A feature rule for `ui.band`                | listed in `EXTERNAL_ALLOWED` (`feature-policy.ts:50-59`), but no `registerFeaturePolicy('ui.band', …)` exists anywhere in `src/main`; "A feature with no registered rule is not enabled" (`feature-policy.ts:3-5`) | **never enabled** |
| The `AbovePrompt` hook, `surface.tsx`       | no `ui.render` hook in `resources/companion/`; `api-surface.json` lists no `ui.render` and no `$.ui.resolve`                                                                                                       | **not shipped**   |
| The `band` state key                        | absent from `resources/companion/types/index.d.ts` and from `api-surface.json` `stateKeys`                                                                                                                         | **not shipped**   |
| `ui.action` edge event                      | in `EventPayloads` as `{ name: 'open' }` (`contract.ts:356`); no emitter in the mod, no handler in `src/main`                                                                                                      | types only        |
| `/harnu-link`, the open link, `surface` key | no `command.register` in the mod, no `open-link-server.ts`, no `registerPrefsKey('surface', …)`                                                                                                                    | **not shipped**   |

The waves P4W2 depends on are in: P2W1's command channel (`src/main/companion/command-channel.ts`),
P4W3's outside install (`external-binding.ts`, `external-corroboration.ts`), P4W1's Mods tab
(`mods-audit-core.ts`).

### 4.3 Decision: the rail is content of P4W2's band

Three shapes were possible: a client of a shipped band, the band's first content, or a site of its
own. **The rail is content of P4W2's band; since the band has not shipped, the rail's W1 lands
P4W2's site as P4W2 specifies it, which makes the rail its first content.**

- **Not a separate site.** A second `ui.render{component=AbovePrompt}` hook in the companion
  breaks MOD-4 (one `on()` per pair, P4W2:204). A separate plugin would need its own channel to
  Harnu: `$.mcp.call` is absent where the rail matters (§8.1), and a second command channel is a
  second copy of P2W1.
- **Not a client of something shipped.** Nothing is shipped (§4.2).
- **So:** one hook, one `ui.band.set` command, one `band` key, one debounce, one TTL. The rail adds
  a field to the payload and an action to the edge event, and nothing else.

Deltas to P4W2, each the smallest change that carries the rail. Everything not listed stays as
P4W2 wrote it, including `/harnu-link`, the open link, the fitting of P4W2's own lines and every
line of §8 of P4W2.

| #   | P4W2 says                                               | T454 changes it to                                                                                                                               | Why                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Δ1  | `ui.band.set { line, parts?, link? }`                   | adds `rail?: BandRail` (§6.5). When present, the mod draws the rail layout (§6.2) and `line` stays the plain fallback text                       | one command and one key carry both kinds of line                                                                                                                                                                                               |
| Δ2  | row 1: no band for a spawned session inside Harnu (R20) | a **linked child** inside Harnu gets the rail. An **owner** inside Harnu still gets none by default (OQ-1)                                       | R20's reason is that "the Topbar mission pill … already say[s] it" (P4W2:178, :293). The pill is owner-only (`missionForSession`, `lib/mission-view.ts:266-277`; `stores/missions.ts:163-166`): a child's session has no mission chrome at all |
| Δ3  | "No `Button` in the band" (P4W2:76)                     | Buttons for the four rail actions only. P4W2-S3 holds: no Button resolves, answers or dismisses an approval                                      | G2                                                                                                                                                                                                                                             |
| Δ4  | `ui.action { name: 'open' }`                            | `name` gains `step.claim`, `step.block`, `step.unblock`, `step.log`, with `rev` and, for block and log, `text` (§7.3)                            | the press route                                                                                                                                                                                                                                |
| Δ5  | row 4: detail `{n} held in Harnu`                       | detail `{state}` or `{state} · {n} held in Harnu`, `{state}` the pill's primary state word when it is not `active` or `total-changed` (§6.3, S2) | G3: the pill shows a tone the terminal row cannot colour (P4W2 uses `dimColor` and bold only, :224)                                                                                                                                            |
| Δ6  | `ui.band` gated by the `surface` key                    | `ui.band` is enabled when `surface` **or** the new key `rail` is on; the new feature `ui.rail` gates the actions (§10.1)                         | the rail must not depend on turning `/harnu-link` on                                                                                                                                                                                           |
| Δ7  | the `band` key holds one line                           | the `band` value gains `rail?: BandRail`; a new mod-local key `railMode` holds the confirm/input/saving state                                    | the redraw after a press is a `$.state` write (E9)                                                                                                                                                                                             |
| Δ8  | (nothing)                                               | every rail state draws a focusable element (§7.5)                                                                                                | finding F-1 (E14)                                                                                                                                                                                                                              |

## 5. Who sees what

The host decides per binding. Trust classes are `operator | agent | read-only | tick`
(`session-table.ts:29`), from `trustFor` (`spawn-inject.ts:111-119`): an MCP-spawned agent
(`agentControlled`) or a board/manifest dispatch (`spawnedBy: 'agent'`) is `agent`.

| Binding                                                     | Role in a non-closed mission | Band                                               | Actions                                                       |
| ----------------------------------------------------------- | ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| inside Harnu, trust `agent` or `operator`, interactive      | child (builds a step, §8.2)  | the rail (§6.3)                                    | the ones §7.1 offers                                          |
| inside Harnu, trust `agent` or `operator`, interactive      | owner                        | none by default (R20 kept; OQ-1)                   | —                                                             |
| inside Harnu, trust `read-only` (the review companion)      | any                          | the rail, display only                             | none: a read-only spawn writes nothing                        |
| a Scheduler tick (trust `tick`, headless)                   | any                          | none: `ui.render` is not raised headless (P4W2 §8) | —                                                             |
| outside Harnu (P4W3), corroborated                          | owner                        | P4W2 row 4 with Δ5                                 | none (P4W2 row 4 is display)                                  |
| outside Harnu (P4W3), corroborated                          | child                        | the rail, display only                             | none: an external binding gets no `act.*` and no write (§7.4) |
| outside Harnu, not corroborated                             | any                          | none (P4W2 row 6)                                  | —                                                             |
| any                                                         | none                         | none: `next(e)` unchanged                          | —                                                             |
| a session owning one mission and building a step of another | both                         | the child rail (the step is the actionable fact)   | as child                                                      |

## 6. States and copy (U-2)

### 6.1 Words, read from `derived.progress`, never recounted

**Position.** The owner's lead is `progressHeadline(derived.progress)` (`mission-progress.ts:130-145`),
printed with the pill's own strings (`en.json` `mission.headline`: "Step {n} of {m}", "Steps
{n}–{to} of {m}", "Step {m} of {m} ✓"; `design.md:5292-5297`). An `empty` headline draws no row.

A child's lead is **its own step's position**: `k` = the index of its step in
`progressSteps(mission)` plus one (`mission-progress.ts:67-69`), the same order
`derived.progress.current` indexes (`computeProgress`, `:71-97`), and `m` = `progress.total`. It
says where this session's work is, as a position, in the pill's words: "Step 3 of 7". It never
counts done steps. Two numbers can therefore differ on purpose: the pill can say "Steps 3–4 of 7"
while child B's rail says "Step 4 of 7". The host computes `k`; the mod prints what it is sent.

**Status word**, first match wins, from `progress.states[stepId]` (`StepState`,
`mission-progress.ts:13`) and the stored `proof` and `blockers` (`mission-core.ts:76-96`):

| #   | Condition                                               | Word         | Source of the wording                                                                              |
| --- | ------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| 1   | state `verified`                                        | `✓ Verified` | `mission.visual.verified`; the pill's `✓`                                                          |
| 2   | state `done`, proof `claimed` or `self-verified`        | `Claimed`    | `mission.proof.claimed`; "`self-verified` renders the same … 'Claimed'" (`design.md` §6 step rail) |
| 3   | state `done`, any other proof (a `needs-human` verdict) | `Done`       | the counts line "{done} done"; the human part is a check the operator owes                         |
| 4   | the step has an open blocker                            | `Blocked`    | `mission.visual.blocked`                                                                           |
| 5   | state `running`                                         | `Running`    | `mission.visual.running`                                                                           |
| 6   | state `waiting`                                         | `Waiting`    | `mission.visual.waiting`                                                                           |
| 7   | otherwise (`todo`)                                      | `To do`      | `mission.visual.todo`                                                                              |

Row 4 sits after the done rows and before `running` on purpose: the derive puts `running` before
`blocked` (`mission-progress.ts:58-59`), so a step whose builder is working reads `running` even
with a blocker open. The rail shows the blocker anyway, because it is the fact the person at this
terminal can act on.

**Verification level**: `Existence check`, `Verifier`, `Human` (`mission.verification`). **Stale**:
`mission stale {d}`, `{d}` in the popover's `formatDuration` form (`lib/mission-view.ts:280-288`),
from `derived.stall.lastEvidenceAt`. The idea's "verify: typecheck" has no source: a step stores
a verification level, not a command (`MissionStep.verification`, `mission-core.ts:81`).

### 6.2 Fitting the row to `bodyColumns`

Each width tier adds parts; the narrower the band, the earlier a part goes. The lead and the
status word are never cut.

| `bodyColumns` | Row                                                                               | Cut                               |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| < 40          | no row (`next(e)` unchanged)                                                      | everything                        |
| 40–59         | `◆ Step {k} of {m} · {status}`                                                    | title, reason, stale, level, keys |
| 60–89         | `◆ Step {k} of {m} · {status}` + the action keys                                  | title, reason, stale, level       |
| 90–119        | `◆ Step {k} of {m} · {title} · {status}[: {reason}][ · mission stale {d}]` + keys | level                             |
| ≥ 120         | the 90–119 row + ` · {level}` before the stale part                               | nothing                           |

Inside a tier, when the text and the keys do not fit, parts shrink in this order: the title is
truncated with `…`, then dropped once fewer than 12 characters would remain; then the blocker
reason the same way. **The reason outranks the title** while blocked: it is the fact that needs
the person. The keys are reserved first, because a row whose keys are cut cannot be acted on.

The thresholds: 40 is P4W2's floor (P4W2:217). 60 is the narrowest width at which the longest
child row with keys fits (`◆ Step 12 of 12 · Running` + `c: Claim  b: Block  l: Log` = 52
cells). From 90 a title is worth drawing: it gets at least 37 cells beside a three-key row, close
to the median step title (40 characters, `MEAS`); a 120-column terminal (`bodyColumns` 115) shows
the median title whole. The host caps a title at 64 characters and a reason at 48 before sending
(§6.5), so about one title in ten is capped (`MEAS`: 90th percentile 73); a capped title shows
whole from `bodyColumns` 117, or 128 once the level joins at ≥ 120. `KIT` test 1 and
6 assert the table; `LIVE` drew it at 144, 120, 80, 62, 45 and 38 columns.

### 6.3 Every state, as drawn

Fixture: a child building step 3 of 7, "Wire the rail IPC channel", verification `verifier`. Rows
are shown at three widths: `bodyColumns` 115 (a 120-column terminal), 75 (80 columns), 40 (45
columns). `[-]` is the engine's collapse mark, drawn by the engine at the right edge.

**S0. No mission** (the session owns none and builds no step, or the rail key is off). No row; the
hook returns `next(e)` unchanged, so another mod's band is exactly as it was.

**S1. Owner inside Harnu.** No row by default (§5, OQ-1). The Topbar pill shows the mission.

**S2. Owner outside Harnu** (P4W2 row 4 with Δ5; P4W2's fitting table, its widths 40/80/110/144):

```
110–143  ◆ Harnu Steps 3–4 of 7 · blocked · 1 held in Harnu  Open in Harnu
80–109   ◆ Harnu Steps 3–4 of 7  Open in Harnu
40–79    ◆ Harnu Steps 3–4 of 7
```

`{state}` is the pill's primary state (`missionState`, `lib/mission-view.ts:152-162`) in short
words: `blocked`, `needs you`, `stale`, `re-scope pending`, `delivered`; none for `active` and
`total-changed`. A delivered mission whose every step is done reads `◆ Harnu Step 7 of 7 ✓ ·
delivered`.

**S3. Linked child, working.**

```
115  ◆ Step 3 of 7 · Wire the rail IPC channel · Running  c: Claim  b: Block  l: Log
75   ◆ Step 3 of 7 · Running  c: Claim  b: Block  l: Log
40   ◆ Step 3 of 7 · Running
```

`Waiting` and `To do` draw the same way. At 139 the 115 row gains ` · Verifier` after `Running`.

**S4. Step blocked** (an operator blocker "needs the staging API key", the mission stale for
2 h 15 m):

```
139  ◆ Step 3 of 7 · Wire the rail IPC channel · Blocked: needs the staging API key · Verifier · mission stale 2h 15m  u: Clear block  l: Log
115  ◆ Step 3 of 7 · Wire the rail… · Blocked: needs the staging API key · mission stale 2h 15m  u: Clear block  l: Log
75   ◆ Step 3 of 7 · Blocked  u: Clear block  l: Log
40   ◆ Step 3 of 7 · Blocked
```

(`KIT` test 6 asserts the 139, 115 and 75 texts.)

**S5. Claimed, self-verified, verified, done.**

```
claimed or self-verified   ◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log
verified                   ◆ Step 3 of 7 · Wire the rail IPC channel · ✓ Verified  l: Log
done (needs-human)         ◆ Step 3 of 7 · Wire the rail IPC channel · Done  l: Log
```

(115 columns. `self-verified` is drawn as `Claimed` on purpose, as the popover does: a
self-verification is not proof the operator sees as proven.)

**S6. Mission stale.** Shown on every row at ≥ 90 as ` · mission stale {d}` (S4 above); at 40–89
it is cut. The owner row outside Harnu carries it as its `{state}` word, `stale` (S2).

**S7. Mission closed (`MISSION_CLOSED`).** A closed mission leaves the host's list (closed
missions are filtered, `mission-ipc.ts:181`), so the next publish sends `line: null` and the
row disappears. An operator end runs through `runOperatorDoor` (`mission-ipc.ts:300`), which
re-publishes at once (§8.3). A press that races the close is refused by the handler
(`editMission`, `tool-handlers.ts:4065`) and the row shows, for that one revision:

```
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Not saved: mission closed.  b: Block  l: Log
```

**S8. Harnu not reachable.** The row stands at most `BAND_TTL_MS` (90 s) after the last push, then
the mod clears it (P4W2:201; `LIVE`: gone 95 s after the host died). A press in the meantime draws:

```
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Harnu is not reachable. Nothing was saved.  b: Block  l: Log
```

The keys stay drawn (§7.5); a later press retries. Nothing is queued for later: a write replayed
when Harnu comes back would act on a mission the operator may have changed since (T447 §7.2 makes
the same rule for the same reason).

### 6.4 Transient states (after a press)

| State         | Row (115 columns)                                                                   | Keys                      |
| ------------- | ----------------------------------------------------------------------------------- | ------------------------- |
| claim confirm | `◆ Claim step 3 as done? A verifier still checks it.  y: Claim  n: Cancel`          | `y`, `n`                  |
| … human step  | `◆ Claim step 3 as done? You still mark it verified in Harnu.  y: Claim  n: Cancel` | `y`, `n`                  |
| blocker input | `◆ Blocker on step 3: what blocks it (Enter on empty cancels) ⏎ raise`              | the field holds every key |
| log input     | `◆ Log on step 3: note (Enter on empty cancels) ⏎ log`                              | the field holds every key |
| saving        | the row + ` · Saving…`                                                              | drawn, ignored (§7.5)     |
| logged        | the row + ` · Logged.` for one revision                                             | as the row                |
| refused       | the row + ` · Not saved: {reason}.` for one revision                                | as the row                |
| unreachable   | S8                                                                                  | drawn; a press retries    |

The engine draws `label` + `: ` before an `Input`'s field and `⏎ {submitLabel}` while it has the
focus (`LIVE`). A claim, a blocker or a cleared blocker changes the row itself in the next
revision (`Claimed`, `Blocked: …`), so it needs no extra word. `{reason}` comes from a closed
table keyed by the refusal code (§7.3): `mission closed`, `this folder is blocked for agents`,
`the step changed, look again`, `already verified`, `too fast, try again`, `Harnu refused it`.

### 6.5 The pushed payload

```ts
/** Δ1: the optional `rail` field of `ui.band.set` (contract §9). Built by the host only. */
interface BandRail {
  v: 1
  /** Per binding, strictly increasing. A press names it (§7.3). */
  rev: number
  role: 'owner' | 'child'
  /** Owner: progressHeadline(derived.progress). Child: { kind: 'single', n: k, to: k, m: total }. */
  headline: { kind: 'single' | 'range' | 'done' | 'empty'; n: number; to: number; m: number }
  /** Owner only: the pill's primary state, absent for active / total-changed. */
  state?: 'blocked' | 'needs-you' | 'stale' | 'rescope-pending' | 'delivered'
  step?: {
    title: string // ≤ 64 chars, C0/C1 controls and escape sequences stripped
    level: 'existence' | 'verifier' | 'human'
    proof: 'unproven' | 'claimed' | 'self-verified' | 'verified'
    state: 'verified' | 'done' | 'running' | 'waiting' | 'blocked' | 'todo'
    blocker?: { reason: string /* ≤ 48, stripped */; owner: 'agent' | 'operator' }
  }
  /** Minutes since the mission's last evidence, when derived.stale. */
  staleMin?: number
  /** What a press may ask for in this revision (§7.1). Empty for display-only bindings. */
  actions: readonly ('claim' | 'block' | 'unblock' | 'log')[]
  /** The outcome of the last press, carried for one revision. */
  result?: { action: 'claim' | 'block' | 'unblock' | 'log'; ok: boolean; code?: RailRefusal }
}
```

The mod adds `expiresAt` when it applies the value, as for P4W2's line. The prototype's
`RailView` ([`01-prototype.md`](01-prototype.md), `types/index.d.ts`) is this shape less `state`,
`result` and the owner path.

**Why titles are allowed here and not in P4W2's status text.** P4W2 §7.5 bans titles from
`/harnu-link status` because that output is a transcript row the next model turn reads (R29). The
band is drawn and never read by the model (E1; §1). Titles are written by the orchestrator, a
different session, so the host strips control characters and escape sequences before sending, to
keep a title from writing to the operator's terminal (K-4).

### 6.6 Copy rules

`design.md` §8 applies: no emoji, no exclamation marks; short labels without a trailing period
(`Claim`, `Block`, `Clear block`, `Log`, `Cancel`); full sentences with one (`Nothing was
saved.`). Position before counts, as "Mission progress" (`design.md:11246-11251`) requires; no
copy promises a guarantee (SEC-7): the confirm says a verifier still checks the step, never that
it is done. The terminal text is English literals in the mod, not i18n, for the reason P4W2 §10
gives: it is CLI output and the repo's language policy covers it. `◆` is P4W2's band mark.

## 7. Actions (U-3)

### 7.1 What a press does

| Key      | Button        | Offered in the revision when                                                                                   | Host runs (in process)                                                      | Arguments the host fills                                                                                        |
| -------- | ------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `c`→`y`  | `Claim`       | child; level `verifier` or `human`; proof `unproven`; state not `done`/`verified`; no open blocker on the step | the `mission_update_step` handler (`TC:1464`; `tool-handlers.ts:4142-4207`) | `{ missionId, stepId, set: { proof: 'claimed' } }`                                                              |
| `b`→text | `Block`       | child; state not `done`/`verified`; no open blocker                                                            | the `mission_set_blocker` handler (`TC:1531`; `:4291-4323`)                 | `{ missionId, stepId, reason: text, unblocks: 'the operator clears it', owner: 'operator' }`                    |
| `u`      | `Clear block` | child; the step has an open blocker                                                                            | the `mission_clear_blocker` handler (`TC:1553`; `:4325-4357`)               | `{ missionId, stepId, reason }`, `reason` the newest blocker on that step as the host read it for this revision |
| `l`→text | `Log`         | child                                                                                                          | the `mission_log` handler (`TC:1513`; `:4550-4573`)                         | `{ missionId, stepId, note: 'Operator note from the terminal rail: ' + text }`                                  |

After a successful claim, block or clear, the host also appends one `mission_log` entry on that
step from a fixed template, so the orchestrator reading the Log sees that the move was a press in
this terminal and not its child's report: "Claimed from the terminal rail (operator, session
`{8 chars}`)", "Blocker raised from the terminal rail …", "Blocker cleared from the terminal rail
…". The `folder` of every call is the binding's `cwd`; `missionRoot` resolves the main checkout as
for the verbs.

`existence` steps are never offered a claim: the handler refuses it (`PROOF_NOT_CLAIMABLE`,
`tool-handlers.ts:4193`), Harnu proves those from links. A blocker raised from the rail is owned by
the **operator**: the person who pressed is the operator by construction, and an operator blocker
lands on the `you` list and re-nudges every 30 minutes until cleared (`docs/harnu-features.md`,
Missions), which is what keeps a hand-raised blocker from being forgotten. OQ-3 asks whether an
"agent's move" variant is wanted.

`TOOL_HANDLERS` is module-private (`tool-handlers.ts:4576`); W2 exports a narrow
`runMissionWrite(op, args, ctx)` for exactly these four ops, so the rail runs the verbs' code and
nothing else (one mutation path, one set of refusals).

### 7.2 What is deliberately not offered

| Not offered                                                                                  | Verb or door                                                                     | Why                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify a step                                                                                | `mission_verify_step` (`TC:1600`)                                                | Verification belongs to an **independent** verifier session. A press in the builder's own terminal is self-verification by construction: the verb would record `self-verified`, "which the operator never sees as proven" (`docs/harnu-features.md`, Missions).                                                                        |
| Tick, add or delete a check; mark a human step verified; approve a re-scope; end the mission | the operator doors `mission:operatorDoor` (`mission-ipc.ts:11-19`, `:300`)       | These are the **operator's doors**, reachable only through renderer IPC and pinned so that "No MCP verb reaches this module" (`mission-ipc.ts:16-18`). A press reaches Harnu over the companion channel, which SEC-3 (c) treats as untrusted input; it must never reach an operator door. The operator has the popover one click away. |
| Request close                                                                                | `mission_request_close` (`TC:1637`)                                              | The owner's "it's done" signal, refused until the end is verified. A child has no business with it, and the operator closes directly with **End mission…**.                                                                                                                                                                            |
| Re-scope, add a step, link a child, add a check                                              | `mission_set_end`, `mission_add_step`, `mission_link_child`, `mission_add_check` | The plan's structure is the owner's. A one-key structural change from a builder's terminal is the drift the mission exists to prevent.                                                                                                                                                                                                 |
| Any action on the owner row                                                                  | —                                                                                | Inside Harnu the owner row is off by default; outside Harnu the binding is external, which gets no `act.*` (contract §21 item 3) and no write (§7.4).                                                                                                                                                                                  |
| Idea 115's `[Request close]`                                                                 | —                                                                                | See "Request close".                                                                                                                                                                                                                                                                                                                   |

### 7.3 The route of a press

1. The Button's `onPress` (or the `Input`'s `onSubmit`) runs in the mod. Claim first switches the
   row to its confirm; block and log switch it to an `Input`.
2. The mod queues the edge event `ui.action { name: 'step.<action>', rev, text? }` and flushes it at
   once (edge events flush immediately, `T389/01-contract.md:359-361`). It carries **no step id,
   no mission id**: any plugin can rewrite another's `$.state` value through a `state.set` hook
   (E9), so whatever the row was drawn from cannot be trusted to name the target.
3. Harnu main checks, in order, and answers a refusal code on the first failure:
   - the binding is bound with a live lease, profile `interactive`, trust `agent` or `operator`,
     and has `ui.rail` enabled (`RAIL_NOT_ENABLED`);
   - "Ask before agent actions" is off (`ASK_MODE`; §7.4);
   - `rev` equals the binding's current rail revision (`RAIL_STALE`) and the action is in that
     revision's `actions` (`RAIL_NOT_OFFERED`);
   - `text`, when the action takes one, is 1–200 characters after trimming and stripping control
     characters (`BAD_TEXT`);
   - at most one action per `RAIL_MIN_INTERVAL_MS` (2 000) per binding (`TOO_FAST`).
4. Harnu main takes `missionId` and `stepId` from **its own** snapshot for that revision, runs the
   handler of §7.1 under the handler's own lock and checks (`editMission`,
   `tool-handlers.ts:4051-4084`: the blocked-folder refusal, `MISSION_CLOSED`, `STEP_NOT_FOUND`,
   `PROOF_NOT_CLAIMABLE`), appends the Log line, writes one companion audit record, re-derives that
   mission and publishes the next revision with `result` (§8.3).
5. The mod draws the next revision. No toast, no `$.ui.status`: P4W2 keeps the band and the status
   line from saying the same thing (P4W2 §7.4).

```ts
/** Δ4: the edge event (contract §6). */
type RailActionEvent = {
  name: 'step.claim' | 'step.block' | 'step.unblock' | 'step.log'
  rev: number
  text?: string // block and log only; ≤ 200 chars
}
type RailRefusal =
  | 'RAIL_NOT_ENABLED'
  | 'ASK_MODE'
  | 'RAIL_STALE'
  | 'RAIL_NOT_OFFERED'
  | 'BAD_TEXT'
  | 'TOO_FAST'
  | 'MISSION_CLOSED'
  | 'FOLDER_NOT_ALLOWED'
  | 'STEP_NOT_FOUND'
  | 'PROOF_NOT_CLAIMABLE'
  | 'REFUSED'
```

`KIT` tests 2 and 3 and the `LIVE` host log show step 2: `{"name":"step.claim","rev":5}` and
`{"name":"step.block","rev":6,"text":"needs the staging API key"}`.

### 7.4 Who can press, and what that grants

The question is whether the rail gives an agent-dispatched session a mission write that Harnu
deliberately withheld (SEC-9 (g): "agent-controlled spawns get no Harnu MCP").

- **The model cannot press.** A Button is pressed by person input on a surface (E7); no plugin can
  raise a press at run time (E8, A-4); the model has no route to the band at all. The rail adds
  no slash command (P4W2's Q-P4W2-d, "can the model invoke a registered command", does not arise).
- **A sibling plugin can forge the event.** `conn` lives in the companion's `$.state` (SEC-8) and
  any plugin reads any value (E9, smoke D6), so a plugin in the same session can send `ui.action`
  to the host. SEC-3 already says tokens are "correlation, not authentication". What a forger
  gets is bounded: the four agent-level writes, on the step the host itself resolved for that
  binding, in the current revision, one per 2 s, each leaving a Log line and an audit record. A
  plugin is unsandboxed code with `$.fs` and `$.process` (ADR-0018 Decision 3) that can already
  write `.harnu/missions/*.md` directly, so the route adds no capability such a plugin lacked.
- **The model's tools cannot forge it either**, provided the Bash tool's processes cannot read
  `conn` from the `claude` process (assumption A-3).
- **The same writes are open to any MCP holder.** The four handlers check no owner and no link
  (T447 §5.4: "any caller with the MCP server can write to any step of any mission in the
  folder"). The rail is narrower: one step, the one Harnu resolved.
- **External bindings get no actions.** An outside session is unverified until corroborated and
  is never given a write (P4W3; contract §21 item 3).
- **"Ask before agent actions" on → no actions.** The operator chose that agent-reachable writes
  wait for a confirm. The rail cannot prove a press came from the person (above), so in Ask mode
  the host sends `actions: []` and refuses any event `ASK_MODE`; the row stays, display only.
- **Audit (SEC-6).** One record of kind `rail` per accepted or refused event, in
  `<userData>/companion/audit.ndjson`: binding, action, mission id, step id, outcome, a hash of
  `text` (never the text). The mission Log line is the trace the orchestrator and the operator
  read.

### 7.5 Keys and focus

**Collisions, checked.** The rail's keys are `c`, `b`, `u`, `l`, and `y`/`n` in the confirm.

- They are letters, so they act only while the band holds the focus (E4). The default `KB` table
  binds no letter in the `AbovePrompt` context (E12): `tab`, arrows, `enter`, `space`, `escape`,
  page keys only. The `Chat` and `Global` contexts bind letters only with a modifier
  (`ctrl+…`, `meta+…`). `LIVE`: `c` typed with the prompt focused went into the prompt.
- **No digit, ever.** A bare digit typed into an empty prompt "answers a band Button" (E4): a digit
  hotkey would turn the first character of a prompt like "1. fix the test" into a mission write.
  `LIVE`: with no digit Button, `1` stayed in the prompt.
- `y` and `n` exist only in the confirm row, where the other keys are not drawn.
- Two Buttons with one hotkey: "later wins" (E4). Another mod drawing a `c` hotkey under the
  rail's row would take `c` (risk K-3). The rail cannot detect it; the person sees two `c:` labels.
- The focus is taken with `ctrl+x tab` (`abovePrompt:focus`) or a click, and left with `escape`.
  The rail never moves the focus itself.

**F-1: keep something focusable (Δ8).** `LIVE` found that when a press redraws the band with no
Button and no `Input`, the focus returns to the prompt, and the next keys the person types for the
band go into the prompt instead; one Enter later they were submitted to the model as a user turn.
In an executor that is operator text delivered to the executor's model. So **every rail state
draws at least one focusable element**: the action Buttons stay drawn while saving (a press then
does nothing) and while Harnu is unreachable (a press retries). The prototype does this and the
final `LIVE` run kept the focus through claim, confirm and the blocker input.

## 8. Data source and freshness (U-4)

### 8.1 Why not MCP, and why not `$.harnu`

- An executor dispatched with `create_session` is `agentControlled`; Harnu withholds its
  `--mcp-config` so "the agent gets NO Harnu MCP server" (`pty.ts:811-818`). A board or manifest
  dispatch gets the server (T447 SDK-Q10), but the MCP-spawned executor is the rail's main reader.
- In such a session `$.mcp.call('harnu', …)` has no server to reach, and T447's noun answers
  `NO_MCP` for every mission method (T447 `00-spec.md:501-508`).
- The companion may not call `$.mcp.call` at all (T389 SEC-9 (b), `00-master.md:502`).
- The companion **is** loaded in those sessions: the spawn path asks the companion provider with
  `trust: trustFor({ agentControlled, … })` and inserts its `--plugin-dir` for agent and non-agent
  spawns alike (`pty.ts:836-857`).

So the host is the only party that both knows the mission and reaches every executor. It already
derives every open mission for the renderer (`listMissionViews`, `mission-ipc.ts:168-205`).

### 8.2 Which mission is this session's: owners, children, and T447's finding

T447 found that "`mission_get` looks a mission up by `missionId` or `ownerSessionId` only …, so an
executor cannot find its mission by owner" (T447 `00-spec.md:408-409`), and that a linked
transcript id goes stale after `/clear` or a resume (T447 A7, `00-spec.md:236`). It proposed D-A:
a server-side child lookup that matches "**by binding first** … the binding's whole id chain …
**By worktree second**" (`00-spec.md:426-435`, `:862`).

The rail needs exactly that match, on the host, without a verb. One pure function,
`resolveMissionRole(views, chain, cwd)` in a new `src/main/mission-role-core.ts`:

1. **Owner:** the newest non-closed mission whose `owner.sessionId` is in `chain`, the rule the
   pill and `mission_get({ ownerSessionId })` use (`lib/mission-view.ts:266-277`).
2. **Child by session link:** the newest non-closed mission with a step whose `links` hold
   `{ kind: 'session', ref }` with `ref` in `chain`. Those steps are `mySteps`.
3. **Child by worktree link:** when no mission matched in 2, a step with a `worktree` link whose
   path, resolved like the derive resolves it, equals the binding's `cwd`. One worktree per card is
   the dispatch convention (`substrate: 'worktree'`).
4. A session that is both owner of one mission and child of another gets the child rail (§5).
   Several `mySteps`: the first in progress order that is not `done`/`verified`, else the last.

`chain` is the binding's current `sid` plus the ids it had before. Today `rebind` overwrites the
`sid` (`session-table.ts:266-269`), so the chain does not exist: W1 adds a bounded `sidHistory`
(≤ 8 ids) to the binding, appended by the `session.rebound` handler. That is the host-side half of
T447 A7, and it is why the rail keeps its step across `/clear` (assumption A-1).

**No duplication with D-A.** D-A, when it ships, is `mission_get({ childSessionId })` over this
same function: the verb wraps `resolveMissionRole`; it does not re-implement it. Whichever lands
first creates `mission-role-core.ts`, the first-lander rule P4W2 applies to its ask client
(P4W2:29-30).

### 8.3 Freshness: piggyback, then push

The rail adds **no poll of its own**:

- **Every list the app already builds.** The renderer polls `mission:list` every 20 s
  (`POLL_MS`, `stores/missions.ts:36`), and main builds it with `listMissionViews`. W1 adds a tap
  there: after each list, the publisher recomputes `BandRail` for every bound binding that has
  `ui.band` enabled and enqueues `ui.band.set` for those whose value changed. That bounds the
  time-dependent fields (`running`, `stale`) to one poll, ≤ 20 s.
- **Every write, at once.** After any mission write — a `mission_*` handler (`editMission`,
  `missionLogHandler`), an operator door (`runOperatorDoor`) or a rail press — the publisher
  re-derives that one mission with `prWaitMs: 0` (the sticky link cache, `mission-link-cache.ts`,
  answers PR states without waiting on GitHub) and republishes the bindings it touches.
- **The channel's own timing**, unchanged from P4W2: debounce `BAND_DEBOUNCE_MS` (500 ms),
  keep-alive `BAND_REFRESH_MS` (60 s), mod TTL `BAND_TTL_MS` (90 s). `ui.band.set` is
  observe-only, so it is admitted while the Harnu mod's `channel` key is at its default `shadow`
  (`command-gate-core.ts:127-142`; P4W2:168-172).
- A binding that rebinds (`session.rebound`) or re-hellos is republished, as P4W2 does
  (AC-P4W2-20).

### 8.4 Cost across a fleet

Measured (`MEAS`; method: parse the frontmatter of every `.harnu/missions/*.md` in the main
checkout and count statuses, steps, `session` links and title lengths):

- 17 mission files, of which 11 are not closed and would be in a list; 109 steps; 141 `session`
  links.

What the rail adds per list (every 20 s):

- **Zero** `gh` calls, MCP calls or file reads: it reads the views the list already built.
- One `resolveMissionRole` per bound binding: a scan of the open missions' links against a chain
  of ≤ 9 ids. With 20 bindings and this repo's 141 links that is under 26 000 string comparisons
  per 20 s. **Not measured as time**; an estimate, and W1's test fixes a ceiling (W1 measures it on
  a synthetic 50-mission, 50-binding fleet and records the number).
- `ui.band.set` only for bindings whose value changed, debounced. A steady fleet sends one
  keep-alive per binding per minute, the P4W2 rate.

Per press: the four checks, one handler write, one Log append, one single-mission re-derive with
`prWaitMs: 0`.

For contrast, T447's v1 `mission` topic polls one `$.mcp.call` per session every 10 s, with up to
10 `mission_get` calls to resolve a child (T447 `00-spec.md:414-420`, `:621-623`), and cannot run
in an executor at all.

### 8.5 Environments

| Session                                                         | What the rail does                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Spawned by Harnu for an agent (`agentControlled`), no Harnu MCP | full rail and actions: the data comes over the companion channel, not MCP (§8.1)                                  |
| Spawned by Harnu, operator-started, with Harnu MCP              | same; the rail never uses the MCP server                                                                          |
| Board or manifest dispatch (trust `agent`)                      | same                                                                                                              |
| Read-only review spawn                                          | display only (§5)                                                                                                 |
| Scheduler tick                                                  | nothing: headless, `ui.render` not raised; `ui.band` is never enabled headless (`feature-policy.ts:82`)           |
| Outside Harnu, P4W3 on                                          | owner row (P4W2 row 4 + Δ5), child row display-only, both after corroboration                                     |
| Companion `off`, CLI below the floor, sideload-blocked          | nothing: no companion, no band                                                                                    |
| Companion `legacy` (loaded, not authoritative)                  | nothing until the `rail` and `ui.band` features are enabled for the binding (§10)                                 |
| Harnu quits mid-session                                         | the row clears after the TTL (S8)                                                                                 |
| Hot reload of the companion                                     | the row redraws from `$.state` (the `band` value survives a reload, `TYPES:3376-3383`); `railMode` resets to idle |
| `/clear`, resume                                                | P4W2's `session.rebound` re-send; the resolver keeps the step through `sidHistory` (A-1)                          |

## 9. Packaging (C-3)

**A mix: the existing Harnu mod and Harnu main. No new mod.**

| Part                                                                                           | Where                                                                                           | Why there                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The `AbovePrompt` hook, the view, the fitting, the `ui.band.set` handler, the `ui.action` emit | `resources/companion/` (`register.ts`, a `surface.tsx` per P4W2, a `$`-free `lib/rail-core.ts`) | It is the one plugin every Harnu spawn loads (§8.1) and it already owns the channel; MOD-4 allows one `AbovePrompt` hook. Nothing it adds needs `$.mcp.call` or `$.process` (SEC-9 holds). |
| The resolver, the publisher, the action executor, the audit record                             | `src/main/mission-role-core.ts`, `src/main/companion/rail.ts` (+ `rail-core.ts`)                | It owns the missions, the handlers, the gates and the audit log.                                                                                                                           |
| The switch                                                                                     | renderer, Settings → Mods, the settings region of P4W1                                          | the operator's control (§10)                                                                                                                                                               |

**Not `$.harnu` (T447).** The noun needs MCP and answers `NO_MCP` in the rail's main sessions
(§8.1). A third-party band on the `harnu.mission` atom (T447 §14) stays possible and is a
different mod; the rail neither depends on nor blocks it.

**A session started outside Harnu** gets the rail only through P4W3's opt-in switch, which already
stages the companion there. It draws the owner row (Δ5) and a display-only child row, both once
the binding is corroborated, and never offers an action (§7.4). With P4W3 off it gets nothing.

### 9.1 Relation to every wave and spec it touches (C-2)

Status checked in code at `cb7fb58`. The rail specifies only the right-hand column.

| Wave or spec                                     | Status                                                                     | Relation                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| T389 **P4W2** terminal band                      | not shipped (§4.2)                                                         | **builds on and lands it**: W1 implements P4W2 §7.4 as written; Δ1–Δ8 are the only changes                                                     |
| T389 **P2W1** command channel                    | shipped (`command-channel.ts`, `command-gate-core.ts`)                     | **uses** `enqueue`, the observe-only admission of `ui.band.set`, the edge-event flush; adds nothing to it                                      |
| T389 **P1W3** handshake, identity, rebound       | shipped (`session.rebound` in `identity-core.ts`)                          | **extends** the binding with `sidHistory` (§8.2); the rebound handler appends to it                                                            |
| T389 **P1W4** prefs keys, feature policy         | shipped (`companion-prefs.ts`, `feature-policy.ts`)                        | **uses** `registerPrefsKey('rail')`, `registerFeaturePolicy('ui.rail')`; amends P4W2's `ui.band` rule (Δ6)                                     |
| T389 **P4W1** Mods tab                           | shipped (`mods-audit-core.ts`)                                             | **uses** its settings region for the switch; the `terminal` chip appears (§10.3)                                                               |
| T389 **P4W3** outside Harnu                      | shipped (`external-binding.ts`, `external-corroboration.ts`)               | **uses** corroboration; outside sessions get display only (§5)                                                                                 |
| T389 **P2W4** live contract (`context.append`)   | not shipped (`context.append` absent from `IMPLEMENTED_COMMANDS`)          | **not used**; OQ-5 asks whether a closed-registry row should tell the executor's model about a press                                           |
| T389 **P3W1** approval hold                      | not shipped (no ask broker in `src/main`)                                  | **independent**; A-5 (the band under the permission dialog) is P3W1's open question too                                                        |
| T389 **P4W5** compaction digest                  | not shipped                                                                | **independent**; it is the model-side half of "the executor never loses its step" (§1)                                                         |
| **T447** `$.harnu` noun (merged spec, `9142876`) | spec only: no `resources/harnu-sdk/`, no `childSessionId` (`TC:1394-1404`) | **not used** (it needs MCP, §8.1); its D-A is **implemented as a core** by the rail's resolver, and D-A's verb later wraps it (§8.2)           |
| Mission v3 UI (`MissionPill.vue`, popover)       | shipped                                                                    | **reuses** its wording and its rules (`progressHeadline`, `missionState`, the step-rail words); W3 shares `missionState` instead of copying it |

## 10. Control and failure (C-4)

### 10.1 On and off

- **Key `rail`**, a Harnu mod prefs key registered with `registerPrefsKey`
  (`companion-prefs.ts:211-221`): boolean, default **`false`**, `observeCap: false` (a CLI above
  the tested ceiling turns it off, like `modsLive`, `mods-observed.ts:58-63`). W3 sets the default
  to `true` once LV-T454-a and LV-T454-b pass, the same pattern as P4W2's `surface` key (P4W2 §13).
- **Features.** `ui.band` (P4W2's): enabled when `surface` or `rail` is on, the mode is not `off`
  and the lease is live. `ui.rail` (new): `rail` on, profile `interactive`, trust `agent` or
  `operator`. Both are attempt-proven like `ui.band` (`command-channel.ts:171-172`).
- **Where the operator flips it**: Settings → Mods, the Harnu mod's settings region (P4W1 part A),
  a `ToggleSwitch` and a `SettingHint`. It applies to sessions started afterwards, since features
  are fixed at hello. Inside a session the person collapses the band with the engine's `[-]` or
  `ctrl+x ctrl+a` (E12); the rail respects it.
- **Kill switch.** The Harnu mod's mode `off` empties `enable` for every binding
  (`feature-policy.ts:76`), so the rail is gone with the rest.

### 10.2 Failure: open, always

| Failure                                                    | Behaviour                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| The render hook throws                                     | `catch` returns `below`, what the plugins beneath drew (prototype `register.ts`; P4W2:207-208)                                            |
| A `$` promise rejects in a handler (`update`, emit, flush) | each is awaited inside `try` or ends in `.catch(() => undefined)`; the row stays as last drawn, the mode returns to idle or `unreachable` |
| The resolver throws for one binding                        | that binding gets `line: null`; one log line; the others are unaffected                                                                   |
| Harnu down                                                 | S8: a press says nothing was saved; the row clears after the TTL                                                                          |
| A handler refuses                                          | the next revision carries `result.code`; the row says so once (§6.4)                                                                      |
| `ui.band` not enabled, feature not declared, CLI too old   | no row; `next(e)` unchanged                                                                                                               |
| Another mod's band                                         | drawn below the rail's row, never replaced (`KIT` test 5)                                                                                 |

Fail-open is right here because the rail is a convenience over the Mission, never a gate: when it
is missing, the executor's work and the operator's popover are exactly as they are today.

### 10.3 Settings → Mods audit chips

`deriveCapabilities` (`mods-audit-core.ts:370-391`) maps hooks and calls to chips. The rail adds to
the companion one hook, `ui.render`, which maps to **`terminal`** ("draws in the terminal",
`modsAudit.cap.terminal`; `mods-audit-core.ts:389`). Its calls (`$.ui.resolve`, `$.state.get/set`,
the existing `$.http.fetch` transport) add no chip the companion does not already show: `network`
comes from `http.fetch` today, and `$.state` _calls_ map to nothing (only a hook on a `state.*`
event would map to `other-mods`, `:386`). P4W2's band would add the same `terminal` chip;
whichever lands first adds it. `api-surface.json` gains `ui.render`, `$.ui.resolve` and the
`band`/`railMode` state keys (the drift manifest).

## 11. Testing

- **L1, pure (vitest).** `resolveMissionRole` (owner, child by session, child by worktree, the
  chain across a rebound, closed and delivered missions, both roles), the `BandRail` builder (each
  row of §6.1, position never a count, caps and control-character stripping), the action checks of
  §7.3 (every refusal code), and the copy tables (no template takes a free string other than title,
  reason and the typed text).
- **L3, mod (`claude plugin test`).** The prototype's six tests, ported onto the companion's rig
  (`resources/companion/tests/support/rig.ts`), plus: `ui.band.set` with and without `rail`, a lower
  `n` never overwriting a higher one, the TTL tick, the hot reload, and F-1 (every state has a
  Button or an `Input`).
- **L4, live (`--with-cli`).** LV-T454-a: in Harnu's own xterm.js terminal (not tmux), the rail
  draws at 80, 120 and 144 columns in both layouts (`CLAUDE_CODE_NO_FLICKER` on and off, as
  LV-P4W2-a), `ctrl+x tab` reaches the band, and `c`, `y`, `b`, typing, Enter produce one claim and
  one blocker in a real mission's file with their Log lines. LV-T454-b: the same in an
  `agentControlled` spawn (no Harnu MCP), plus `/clear` in the executor and one more press.

## 12. Implementation outline (C-6)

Sizes: S ≤ 1 day, M 2–4 days, L a week or more. An outline; no cards are created.

| Wave | Content                                                                                                                                                                                                                                                                                                 | Size | Depends on         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------ |
| W0   | **Spike in Harnu itself.** The prototype in an isolated second Harnu (`docs/dev/live-verify-second-instance.md`): the band in xterm.js, `ctrl+x tab` through xterm.js, the fullscreen layout, A-1 (`sid` across `/clear`), A-3 (`conn` unreadable from the Bash tool). Evidence note in this directory. | S    | —                  |
| W1   | **The band site and the display rail.** P4W2 §7.4 as written (hook, `surface.tsx`, `ui.band.set` handler, `band` key, TTL tick, `ui.band` feature rule); Δ1, Δ2, Δ6, Δ7, Δ8; `mission-role-core.ts` with `sidHistory`; the publisher tap; the `rail` key and switch; L1 + L3.                           | M    | W0, P2W1 (shipped) |
| W2   | **Actions.** Δ3, Δ4; the `ui.action` handler and checks; `runMissionWrite` export; the Log template; the `rail` audit record; the Ask-mode rule; L3 for every refusal; LV-T454-a/b.                                                                                                                     | M    | W1                 |
| W3   | **Owner row outside Harnu and default on.** Δ5 (moves `missionState` to a shared pure module both the renderer and main import, rather than copying it); flips `rail` to default `true` after LV-T454-a/b.                                                                                              | S    | W2, P4W3 (shipped) |
| W4   | **D-A over the resolver** (optional, owned by T447): `mission_get({ childSessionId })` wraps `resolveMissionRole`.                                                                                                                                                                                      | S    | W1                 |

Order: W0 → W1 → W2 → W3; W4 any time after W1. W1 alone is useful: the executor's step is on
screen.

**Repo contracts each wave owes.**

| Contract                               | W1                                                                                                                                                                         | W2                                                                                                                                                                        | W3                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `CHANGELOG.md`                         | `Added`: an executor's mission step above the prompt                                                                                                                       | `Added`: claim, block, clear and log a step from the terminal                                                                                                             | `Changed`: the rail is on by default; owner row outside |
| `docs/harnu-features.md` + marker bump | yes: the step a child builds is drawn in its terminal; `/clear` keeps it                                                                                                   | yes: an operator may claim, block, unblock or log a step from the executor's terminal; such writes leave a "terminal rail" Log line; in Ask mode the rail is display-only | no                                                      |
| `docs/user/`                           | `sessions.md` § "Mission step rail" (what it shows, `ctrl+x tab`); `mods.md` (the switch, the chip)                                                                        | `sessions.md` (the keys, the confirm, "nothing was saved"); `agent-control.md` § Missions (presses are writes); `troubleshooting.md` (the unreachable line)               | `sessions.md` (default on)                              |
| `design.md`                            | §6 new "Terminal mission rail (T454)" with §6.2–§6.4's tables; §8 Do line                                                                                                  | §6 the keys and transient states                                                                                                                                          | —                                                       |
| i18n (`en.json` and `pt-BR.json`)      | `harnuMod.rail.label`, `harnuMod.rail.hint` (the switch only; terminal text is English literals, §6.6)                                                                     | —                                                                                                                                                                         | —                                                       |
| `T389/01-contract.md`                  | §9 `ui.band.set` `rail`; §22 the `band` value; §11 `ui.rail`                                                                                                               | §6 `ui.action` names, `RailRefusal`; the `rail` audit kind in the master's §12 table                                                                                      | —                                                       |
| CI gates                               | the `mod` step covers the new companion files; `user-docs-gate` fires on the new top-level `src/main/mission-role-core.ts`, and the `docs/user/` update above satisfies it | `awareness-gate` does not fire (no `tool-catalog.ts` or `harnu-features.ts` change); the doc is owed by the contract anyway (W4 does touch `tool-catalog.ts`)             | —                                                       |

## 13. Assumptions and what settles them

| #   | Assumption                                                                                                                                                             | Settled by     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| A-1 | The companion's bound `sid` is the transcript id `mission_link_child` stores, and `session.rebound` reports every change of it (T447 A7)                               | W0             |
| A-2 | Harnu's xterm.js passes `ctrl+x tab` and the letter keys to `claude` as tmux does, and the band draws there (P4W2 Q-P4W2-a / master Q21 covers the band, not the keys) | W0, LV-T454-a  |
| A-3 | A process started by the Bash tool cannot read `conn` out of the `claude` process (it is in module memory and `$.state`, SEC-8)                                        | W0             |
| A-4 | No plugin can press another plugin's Button at run time (E8 is an absence in the declarations)                                                                         | W0 probe       |
| A-5 | The band is not visible while the engine's permission dialog is open (P4W2 Q-P4W2-c, master Q26); the rail then simply waits                                           | P3W1 / W0      |
| A-6 | Recomputing every binding's rail per 20 s list is cheap at fleet scale (§8.4 is an estimate)                                                                           | W1 measurement |

## 14. Open questions (C-7)

| #    | Question                                                                                                                                                                                                                            | Default until settled                               | Who decides         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------- |
| OQ-1 | Should an **orchestrator inside Harnu** also get the owner row, given the Topbar pill shows the same headline (R20)? A case for it: a helper pane or a second window shows a terminal while the pill follows the selected session.  | no owner row inside Harnu                           | Operator            |
| OQ-2 | Is claim-with-confirm right, or should claim be one press like block?                                                                                                                                                               | two presses (a claim has no undo through the verbs) | Operator            |
| OQ-3 | A blocker raised from the rail is owned by the `operator` (it chimes and re-nudges). Offer an "agent's move" variant, e.g. `B`… (impossible: Shift is the same key, E4) or a second key?                                            | operator-owned only                                 | Operator            |
| OQ-4 | Should a refused or unreachable press also raise a `notify` in Harnu's Activity, or is the row enough?                                                                                                                              | the row only (no toast, P4W2 noise rules)           | Operator            |
| OQ-5 | Should the executor's **model** be told that the operator moved its step, through P2W4's `context.append` with a closed-registry row ("The operator claimed step stp-3 from the terminal.")? R29 forbids free text there; ids only. | not told; the orchestrator reads the Log            | Operator, with P2W4 |
| OQ-6 | Does the rail stay off in Ask mode (§7.4), or should a press in Ask mode park a confirm in the Approval Inbox like an agent's write?                                                                                                | display only in Ask mode                            | Operator            |
| OQ-7 | Is a `rail` key separate from P4W2's `surface` wanted, or one switch for "Harnu in the terminal"?                                                                                                                                   | separate (§10.1)                                    | Operator            |

## 15. Risks

| #   | Risk                                                                                                 | Sev    | Mitigation                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| K-1 | F-1 regresses: a state with nothing focusable sends the operator's next keys to the executor's model | High   | Δ8; an L3 test asserts a Button or `Input` in every state; LV-T454-a repeats the `LIVE` sequence            |
| K-2 | A forged `ui.action` from a sibling plugin writes a step                                             | Medium | bounded to four agent-level writes on the resolved step; revision check; rate limit; Log line; audit (§7.4) |
| K-3 | Another mod's band Button takes `c`, `b`, `u` or `l` ("later wins")                                  | Low    | visible as a duplicate label; documented in `docs/user/`                                                    |
| K-4 | A step title or blocker reason carries terminal escape sequences                                     | Medium | the host strips C0/C1 controls and ESC sequences before sending; L1 test                                    |
| K-5 | The rail shows a step the session no longer builds (a stale link after a re-dispatch)                | Low    | the resolver re-runs on every list and write; `sidHistory` is bounded; the orchestrator can re-link         |
| K-6 | The child's "Step k of m" and the pill's "Steps a–b of m" are read as a contradiction                | Low    | both are positions (§6.1); `docs/user/` says the rail shows _this session's_ step                           |
| K-7 | Noise: the row changes on every derive                                                               | Low    | only a changed value is sent; debounce 500 ms; a `running`↔`waiting` flip is the only frequent change       |

## 16. Acceptance-criteria traceability

| AC  | Where                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------ |
| U-1 | §4 (P4W2 summary with lines, shipped status checked in code, the decision and its eight deltas)                          |
| U-2 | §6 (vocabulary from `derived.progress`, fitting table, S0–S8 with exact text at three widths, transients)                |
| U-3 | §7.1 (keys → verbs), §7.2 (not offered, with reasons), §7.5 (collisions, checked live)                                   |
| U-4 | §8 (no MCP and why, the resolver and T447 D-A, freshness, cost, environments)                                            |
| C-1 | §3 (every mechanism with `TYPES`/`REF`/`KB` lines and the run that shows it); [`01-prototype.md`](01-prototype.md) §3–§5 |
| C-2 | §4 (P4W2), §9.1 (every T389 wave and T447, status checked in code), §8.2 (T447 D-A)                                      |
| C-3 | §9                                                                                                                       |
| C-4 | §10                                                                                                                      |
| C-5 | [`01-prototype.md`](01-prototype.md): source, `validate`, `test` (6 pass), `tsc` (no error), live run                    |
| C-6 | §12                                                                                                                      |
| C-7 | §14                                                                                                                      |
| C-8 | English only; neutral vocabulary; `npx prettier --check` and the identifier gate (see the report)                        |
