# T454 — Mission step rail above the prompt

**Status:** specified (not implemented) · **Date:** 2026-10-09 (round 2) · **Card:** T454 ·
**Mission:** `mnt-f92b3961` · **ADR:** [`ADR-draft.md`](ADR-draft.md) (proposed; numbered on merge)

Files: this spec; [`01-prototype.md`](01-prototype.md) (the prototype, its `validate` / `test`
/ `tsc` output and the live session transcripts); [`02-host.md`](02-host.md) (the Harnu side:
which step is this session's, freshness and cost, the route of a press, security and provenance);
[`03-prototype-source.md`](03-prototype-source.md) and [`04-prototype-tests.md`](04-prototype-tests.md) (the prototype's files);
[`ADR-draft.md`](ADR-draft.md).

## 0. Summary

A session that builds a step of a Harnu Mission shows that step in a one-line band above the
prompt, and the person at the terminal can claim the step, raise or clear a blocker, or add a Log
note with a key, without typing a verb:

```
◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  c: Claim  b: Block  l: Log  [-]
```

Seven decisions shape it:

1. **The rail is content of T389 P4W2's band, not a new site.** P4W2 specified the companion's
   one `AbovePrompt` hook, its wrap-never-replace rule, its debounce and TTL, and the
   `ui.band.set` command. None of it has shipped (§4.2). The rail's first wave lands that site as
   P4W2 wrote it and adds an optional `rail` payload to `ui.band.set` (§4.3).
2. **Harnu main resolves the mission and pushes it.** The sessions the rail is for, executors an
   orchestrator dispatched, are spawned without the Harnu MCP server (`pty.ts:811-818`), and the
   companion may not call `$.mcp.call` (T389 SEC-9 (b)). So the host matches the session to its
   step and pushes the result over the companion channel every spawn already has
   ([`02-host.md`](02-host.md) §1–§2).
3. **The target rests on what Harnu observed, never on what a session reports.** The session ids
   the host matches against are the ones its own PTY index holds for the binding's PTY, and a
   change of id the companion reports is recorded but never matches a step or an owner: only spawn
   keys and migrations Harnu correlated itself do ([`02-host.md`](02-host.md) §1.2). A press carries the action and the revision the person
   saw when the key was drawn or the field opened, never a step id or a session id; the host
   answers `RAIL_STALE` when that revision's step is no longer the current one.
4. **Four actions, all agent-level writes, each with provenance.** Claim
   (`mission_update_step` with `proof: 'claimed'`), block (`mission_set_blocker`), clear block
   (`mission_clear_blocker`), log (`mission_log`). The host applies each with the verb's own pure
   mutation and a Log entry in one locked write, with a header only the rail writes (`mission_log` neutralises heading lookalikes) and a
   `via: 'rail'` mark on the record ([`02-host.md`](02-host.md) §3). Verify, request close, end, checks
   and re-scope are deliberately absent (§7.2).
5. **The person ends what the person started.** An open confirm or text field is never removed by
   a push, an expiry or a width change, and it pins the revision and step number it opened on;
   an idle row that drew keys keeps one. This is the fix for the live finding F-1 and its
   follow-up E15, whose residual is named (§7.5, K-10).
6. **Who sees it.** A linked child, inside Harnu, gets the rail with actions; the Topbar pill is
   owner-only, so this is chrome Harnu does not have for that session. An orchestrator inside
   Harnu gets nothing by default (the pill already says it, T389 R20). Outside Harnu the owner row
   is P4W2's row 4, with the pill's state word added (§5).
7. **Off until its live checks pass, then on; fails open.** A new Harnu mod key `rail`, one switch
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
- G5. It never makes the session worse: no keys sent to the model, no stale step left on screen,
  nothing drawn over another mod's band.

**Non-goals.**

- **The model does not read the band.** `AbovePrompt` is drawn on the surface; nothing in it
  enters the transcript or a request. The idea's "executor never loses its step after compaction"
  is about the model's context, which is idea 45 ("Mission-aware compaction") and T389 P4W5. A
  closed-registry context row telling the executor's model that the operator moved its step is
  possible through P2W4's `context.append` and is left as open question OQ-5.
- No verification, close, re-scope, check or human-step door from the terminal (§7.2).
- No step list, no second row, no pane: one row, like every P4W2 line.
- No `$.harnu` dependency (T447) and no new MCP verb are required. The resolver it adds is the
  core T447 named as D-A ([`02-host.md`](02-host.md) §1.4).
- No `/harnu-link` change (P4W2 §7.2), no open link (P4W2 §7.6).
- `desktop`, `vscode` and `mobile` surfaces: the hook returns `next(e)` there, as P4W2 does.

## 2. Conventions and sources

| Tag      | Source                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPES`  | `claude-code.d.ts` written by Claude Code **2.1.295** for the `plugin-authoring` skill (line 1: "Written by Claude Code 2.1.295."). Line numbers are that file's.                                                                                       |
| `REF`    | That skill's `reference.md`, 2.1.295.                                                                                                                                                                                                                   |
| `KB`     | The default keybinding table shipped with 2.1.295 (the `keybindings-help` skill's "Available Actions" and "Available Contexts" tables). The operator's own `~/.claude/keybindings.json` holds no binding.                                               |
| `TC`     | `src/main/mcp/tool-catalog.ts` at this branch's base `cb7fb58`. Every other repo path is at that base too.                                                                                                                                              |
| `T389/x` | `docs/specs/T389-companion-mod/<x>.md`. `T447/x` is `docs/specs/T447-harnu-sdk-noun/<x>.md`.                                                                                                                                                            |
| `KIT`    | `claude plugin validate`, `claude plugin test` (11 tests) and `tsc -p` on the prototype, 2026-10-09 ([`01-prototype.md`](01-prototype.md) §3).                                                                                                          |
| `LIVE`   | The prototype in real interactive sessions, Claude Code 2.1.295 in tmux, driven by key, 2026-10-09: round 1 and the round-2 experiments E1–E8 ([`01-prototype.md`](01-prototype.md) §4).                                                                |
| `MEAS`   | A count made for this spec on the main checkout's `.harnu/missions/`, 2026-10-09: 17 mission files (6 `active`, 5 `delivered`, 6 `closed`), 109 steps, 141 `session` links; step title length min 15, median 40, 90th percentile 73, max 97 characters. |

**Verified** means read in the cited file or observed in `KIT`/`LIVE`. **Assumption** marks what
is inferred; each is listed in §13 with the check that settles it.

A note on the card's context: it calls T447 "PR #41, not merged". It merged as `9142876` before
this branch's base, so T447's spec is on `main` (spec only; no `resources/harnu-sdk/` exists and
`mission_get` still has no `childSessionId`, `TC:1394-1404`).

## 3. Grounding in the engine (C-1)

Every mechanism the design relies on, where it is declared, and how it was shown.

| #   | Mechanism                                                                                                                                                                                                                                                        | Declared                                        | Shown by                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| E1  | `ui.render` on `{ component: 'AbovePrompt' }`: "A hook draws a tree, or passes; one instance … Raised on the terminal and desktop surfaces only."                                                                                                                | `TYPES:10245-10254`                             | `KIT` (every test mounts it); `LIVE`                                                                                   |
| E2  | `AbovePrompt` props `hasSurvey` (a hook yields to a survey), `isWorking`, `maxRows`, `bodyColumns`                                                                                                                                                               | `TYPES:10255-10284`                             | `KIT` (survey test); `LIVE`                                                                                            |
| E3  | `bodyColumns` is "its column's width less the engine's five at the right end"                                                                                                                                                                                    | `TYPES:10276-10284`                             | `LIVE`: rows fitted to `bodyColumns` = terminal width − 5 at 144, 120, 80, 62, 45 and 38 columns                       |
| E4  | `Button.hotkey`: one digit or lowercase letter; pressed "while the plugin's site holds the focus … the band … after ctrl+x tab, a click"; "never the composer, save that a bare digit in an empty one answers a band Button (a survey)"; "two clash, later wins" | `TYPES:1081-1088`; `REF:133`                    | `LIVE`: `c` with the prompt focused was typed into the prompt; after `ctrl+x tab` it pressed; `1` stayed in the prompt |
| E5  | `Button.plain` draws `c: Claim`; the kit's `find` reports the label alone, so the cells a key takes are `hotkey` + 2 + label                                                                                                                                     | `TYPES:1099-1106`                               | `LIVE` (drawn); `KIT` (the width checks count the hotkey)                                                              |
| E6  | `Input`: same focus ring; "while it has focus every printable key reaches it alone and Esc returns them"; `onSubmit` on Enter; `autoFocus`; the engine draws `label` + `: ` and `⏎ {submitLabel}`                                                                | `TYPES:5463-5513`                               | `KIT`; `LIVE` (E7: the field kept every key across a push; Enter submitted nothing to the model)                       |
| E7  | `ui.press`: "Fires when a `Button` … is pressed on a surface"; any plugin's hook may pass, rewrite or take a press                                                                                                                                               | `TYPES:3991-3999`                               | declaration (risk K-3)                                                                                                 |
| E8  | No plugin can press a Button at run time: `EngineInterface`'s `ui` noun has `focus` (`TYPES:2558`) and no `press`; `press(...)` exists only in the test kit                                                                                                      | `TYPES:2540-2558`, `:15121`, `:15636`           | declaration (assumption A-4)                                                                                           |
| E9  | `$.state`: a `get` while drawing subscribes the drawing; "Any plugin reads any value; its owner alone writes it"; another plugin "changes it by hooking `state.set`"                                                                                             | `TYPES:3376-3383`; `REF:118`                    | `KIT` (the row redraws after every push and press without `$.ui.invalidate`)                                           |
| E10 | `TextProps.wrap` (`truncate-end`)                                                                                                                                                                                                                                | `TYPES:12580`                                   | `KIT`                                                                                                                  |
| E11 | Test kit: `$.ui.mount` on a named surface, `press`, `input`, `find`, `redraw`; `mock.clock`; inline `plugins`                                                                                                                                                    | `TYPES:15086`, `:15636`, `:15453`; `REF:81`     | `KIT`                                                                                                                  |
| E12 | Keybinding contexts: `AbovePrompt` binds `tab`/`right`/`down`, `shift+tab`/`left`/`up`, `enter`/`space`, `escape`, the scroll keys; **no letter**. `abovePrompt:focus` is `ctrl+x tab`, `abovePrompt:toggle` is `ctrl+x ctrl+a`                                  | `KB`                                            | `LIVE` for `ctrl+x tab`                                                                                                |
| E13 | A `.ts` hooks module may import a `.tsx` view (P4W2 §7.4 left this open: "If the engine refuses JSX in a file that a `.ts` module imports …")                                                                                                                    | `REF:14`                                        | `KIT` and `LIVE`                                                                                                       |
| E14 | When a redraw leaves the band with no Button and no `Input`, the keys go back to the prompt                                                                                                                                                                      | not declared                                    | `LIVE` round 1, finding F-1                                                                                            |
| E15 | **A key the band does not bind, typed while the band holds the keyboard, goes to the prompt, and the keyboard goes with it**                                                                                                                                     | not declared                                    | `LIVE` E6: after `ctrl+x tab`, `q` was typed into the prompt and the next `c` too                                      |
| E16 | A pushed redraw that swaps the band's keys for others (a different set, or a Dismiss) keeps the keyboard in the band, while at least one is drawn                                                                                                                | not declared                                    | `LIVE` E2–E5: after a push removed Claim, or every action, `b` and `x` still pressed in the band                       |
| E17 | `ui.focus` fires only when the ring moves onto an element (Tab, arrows, click, `autoFocus`, `$.ui.focus`); `ctrl+x tab` leaves the ring "on nothing" and no event says when the band gives the keyboard back                                                     | `TYPES:4054-4064`, `:13863-13895`, `:5494-5500` | declaration: the mod cannot know whether the band holds the keyboard (§7.5)                                            |

E14 to E17 are not in the declarations as such, and together they decide §7.5.

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

### 4.3 Decision: the rail is content of P4W2's band

Three shapes were possible: a client of a shipped band, the band's first content, or a site of its
own. **The rail is content of P4W2's band; since the band has not shipped, the rail's W1 lands
P4W2's site as P4W2 specifies it, which makes the rail its first content.**

- **Not a separate site.** A second `ui.render{component=AbovePrompt}` hook in the companion
  breaks MOD-4 (one `on()` per pair, P4W2:204). A separate plugin would need its own channel to
  Harnu: `$.mcp.call` is absent where the rail matters ([`02-host.md`](02-host.md) §2.1), and a
  second command channel is a second copy of P2W1.
- **Not a client of something shipped.** Nothing is shipped (§4.2).
- **So:** one hook, one `ui.band.set` command, one `band` key, one debounce, one TTL. The rail adds
  a field to the payload and actions to the edge event.

Deltas to P4W2, each the smallest change that carries the rail. Everything not listed stays as
P4W2 wrote it, including `/harnu-link`, the open link, the fitting of P4W2's own lines and every
row of P4W2 §8. W1 records them in P4W2's own document (§12).

| #   | P4W2 says                                                                     | T454 changes it to                                                                                                                                                        | Why                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Δ1  | `ui.band.set { line, parts?, link? }`                                         | adds `rail?: BandRail` (§6.5). When present, the mod draws the rail (§6) and `line` stays the plain fallback text                                                         | one command and one key carry both kinds of line                                                                                                                                                                                               |
| Δ2  | row 1 (P4W2:178): no band for a spawned session inside Harnu (R20); AC-P4W2-9 | a **linked child** inside Harnu gets the rail. An **owner** inside Harnu still gets none by default (OQ-1). AC-P4W2-9 keeps holding for P4W2's own `line`                 | R20's reason is that "the Topbar mission pill … already say[s] it" (P4W2:178, :293). The pill is owner-only (`missionForSession`, `lib/mission-view.ts:266-277`; `stores/missions.ts:163-166`): a child's session has no mission chrome at all |
| Δ3  | "No `Button` in the band" (P4W2:76)                                           | Buttons for the rail's actions, its confirm, Retry and Dismiss; one `Input`. P4W2-S3 holds: no control resolves, answers or dismisses an approval                         | G2                                                                                                                                                                                                                                             |
| Δ4  | `ui.action { name: 'open' }`                                                  | `name` gains `step.claim`, `step.block`, `step.unblock`, `step.log`, with `rev` and, for block and log, `text` ([`02-host.md`](02-host.md) §3.1)                          | the press route                                                                                                                                                                                                                                |
| Δ5  | row 4: detail `{n} held in Harnu`                                             | detail `{state}` or `{state} · {n} held in Harnu`, `{state}` the pill's primary state word when it is not `active` or `total-changed` (§6.3, S2)                          | G3: the pill shows a tone the terminal row cannot colour (P4W2 uses `dimColor` and bold only, :224)                                                                                                                                            |
| Δ6  | `ui.band` gated by the `surface` key                                          | W1 registers `surface` itself, as P4W2 §13 specifies, and the new key `rail`; `ui.band` is enabled when either is on; the new feature `ui.rail` gates the actions (§10.1) | the rail must not depend on turning `/harnu-link` on; reading an unregistered key throws (`companion-prefs.ts:216-218`)                                                                                                                        |
| Δ7  | the `band` key holds one line                                                 | the `band` value gains `rail?: BandRail`; a new mod-local key `railMode` holds the confirm, field, saving and final states                                                | the redraw after a press is a `$.state` write (E9)                                                                                                                                                                                             |
| Δ8  | `bodyColumns < 40` → no row; a line that expires is cleared                   | the rail's focus rules (§7.5): an open confirm or field is never removed by a push, expiry or width; an idle row that drew keys keeps one, under 40 columns too           | F-1 (E14) and E15                                                                                                                                                                                                                              |

## 5. Who sees what

The host decides per binding. Trust classes are `operator | agent | read-only | tick`
(`session-table.ts:29`), from `trustFor` (`spawn-inject.ts:111-119`): an MCP-spawned agent
(`agentControlled`) or a board/manifest dispatch (`spawnedBy: 'agent'`) is `agent`. "Matched by"
refers to the resolver of [`02-host.md`](02-host.md) §1.

| Binding                                                     | Role in a non-closed mission, matched by  | Band                                               | Actions                                                        |
| ----------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| inside Harnu, trust `agent` or `operator`, interactive      | child, by a `session` link on its own ids | the rail (§6.3)                                    | the ones §7.1 offers                                           |
| inside Harnu, trust `agent` or `operator`, interactive      | child, by a `worktree` link only          | the rail, display only                             | none: a folder is not a session (another session may share it) |
| inside Harnu, trust `agent` or `operator`, interactive      | owner                                     | none by default (R20 kept; OQ-1)                   | —                                                              |
| inside Harnu, trust `read-only` (the review companion)      | any                                       | the rail, display only                             | none: a read-only spawn writes nothing                         |
| a Scheduler tick (trust `tick`, headless)                   | any                                       | none: `ui.render` is not raised headless (P4W2 §8) | —                                                              |
| outside Harnu (P4W3), corroborated                          | owner                                     | P4W2 row 4 with Δ5                                 | none (P4W2 row 4 is display)                                   |
| outside Harnu (P4W3), corroborated                          | child                                     | the rail, display only                             | none: an external binding gets no `act.*` and no write         |
| outside Harnu, not corroborated                             | any                                       | none (P4W2 row 6)                                  | —                                                              |
| any                                                         | none                                      | none: `next(e)` unchanged                          | —                                                              |
| a session owning one mission and building a step of another | both                                      | the child rail (the step is the actionable fact)   | as child                                                       |

## 6. States and copy (U-2)

### 6.1 Words, read from `derived.progress`, never recounted

**Position.** The owner's lead is `progressHeadline(derived.progress)` (`mission-progress.ts:130-145`),
printed with the pill's own strings (`en.json` `mission.headline`: "Step {n} of {m}", "Steps
{n}–{to} of {m}", "Step {m} of {m} ✓"; `design.md:5292-5297`). An `empty` headline draws no row.
Its short form is the sidebar chip's (`mission.chip`: "{n}/{m}").

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

**Notes.** A transient outcome replaces the status word with a note that has a long and a short
form; the short form is never cut:

| Note                            | Long form                                             | Short form           |
| ------------------------------- | ----------------------------------------------------- | -------------------- |
| saving                          | `Saving…`                                             | `Saving…`            |
| logged                          | `Logged.`                                             | `Logged.`            |
| refused (one revision)          | `Not saved: {reason}.`                                | `Not saved.`         |
| unreachable after a press       | `Harnu is not reachable. Nothing was saved.`          | `Nothing was saved.` |
| final: line gone, press lost    | `Mission closed or step unlinked. Nothing was saved.` | `Nothing was saved.` |
| final: step changed, press lost | `The step changed. Nothing was saved.`                | `Nothing was saved.` |
| final: Harnu gone, press lost   | `Harnu is not reachable. Nothing was saved.`          | `Nothing was saved.` |
| final: line gone, nothing lost  | `Mission closed or step unlinked.`                    | `No step now.`       |
| final: Harnu gone, nothing lost | `Harnu is not reachable.`                             | `Not reachable.`     |

`{reason}` comes from a closed table keyed by the refusal code ([`02-host.md`](02-host.md) §3.1):
`mission closed`, `this folder is blocked for agents`, `the step changed, look again`, `already
verified`, `too fast, try again`; any other code reads `Harnu refused it`. "Mission closed or step
unlinked" is deliberately both: a `null` push does not say which.

### 6.2 Fitting the row: one cut order, keys reserved first

The prototype's `fitRow` ([`03-prototype-source.md`](03-prototype-source.md), `rail-core.ts`) is
the specification. A row is `◆`, then the parts joined with `·`, then two spaces and the keys
(`c: Claim` takes `hotkey` + 2 + label cells, E5). While the row is wider than `bodyColumns`, it
cuts, **in this order**, until it fits:

1. the verification level;
2. the stale age;
3. the title: truncated with `…`, then dropped once fewer than 12 characters would remain;
4. the blocker reason: the same;
5. the note's long form, replaced by its short form;
6. the keys not marked `keep`, last first (each row has one `keep` key: the first offered action,
   Dismiss on a final or unreachable row, both keys of the claim confirm);
7. the lead's long form, replaced by the chip form (`Step 3 of 7` → `3/7`);
8. the lead itself, only when a note stands (`◆ Nothing was saved.  x: Dismiss`).

**Never cut:** the status word, a note's short form, a `keep` key. The narrowest such rows are
`◆ Nothing was saved.  x: Dismiss` (32 cells) and the confirm's `◆ Claim step 3?  y: Yes  n: No`
(30 cells). Below that, the only thing left to cut is the text, and the engine truncates the text
end (`wrap: truncate-end`, E10): that is the one case in which "Nothing was saved." can lose
characters, in a band under 32 cells (a terminal under 37 columns), and the key is still drawn.

**Cells, not code units.** The fitting counts one cell per character. `◆` (U+25C6), `·`, `…`,
`✓` and `⏎` are East-Asian-ambiguous: a terminal configured to draw them two cells wide makes a
row up to about ten cells wider than counted. P4W2 already uses `◆` and `·`. The engine truncates
the row's text at the end (E10), so the keys, which sit beside it, are the only part at risk
of being pushed off; A-9 has W0 measure what the engine does on such a terminal, and the fit
budget gets a slack constant if it pushes them off.

**Floors.** An idle rail that drew no key in its last frame draws nothing below 40 cells, P4W2's
floor (P4W2:217). One that did keeps drawing its row with at least its `keep` key, at any width
(§7.5). A confirm or a field draws at any width.

The limits on what the host sends: a title at most 64 characters, a reason at most 48 (§6.5).
`MEAS`: the median title (40) shows whole at `bodyColumns` 75 beside two keys and at 115 beside
three; about one title in ten is capped at 64 (90th percentile 73).

### 6.3 Every state, at three widths

Fixture: a child building step 3 of 7, "Wire the rail IPC channel", verification `verifier`.
`bodyColumns` 115 (a 120-column terminal), 75 (80 columns), 40 (45 columns). Every row below is
the prototype's output, printed by `KIT` test 9 ("every state fits at 115, 75 and 40"), which also
asserts that text and keys never exceed the width. The engine's `[-]` is drawn after them.

**S0. No mission** (the session owns none and builds no step, or the rail key is off). No row; the
hook returns `next(e)` unchanged, so another mod's band is exactly as it was.

**S1. Owner inside Harnu.** No row by default (§5, OQ-1). The Topbar pill shows the mission.

**S2. Owner outside Harnu.** The rail supplies the lead and the state word; P4W2 row 4 adds its
held count and link with its own fitting (widths 40/80/110/144, P4W2:212-225). The prototype draws
the rail's part, `◆ Harnu Steps 3–4 of 7 · blocked`, at all three widths (32 cells). With P4W2's
additions:

```
110–143  ◆ Harnu Steps 3–4 of 7 · blocked · 1 held in Harnu  Open in Harnu
80–109   ◆ Harnu Steps 3–4 of 7 · blocked  Open in Harnu
40–79    ◆ Harnu Steps 3–4 of 7 · blocked
```

`{state}` is the pill's primary state (`missionState`, `lib/mission-view.ts:152-162`) in short
words: `blocked`, `needs you`, `stale`, `re-scope pending`, `delivered`; none for `active` and
`total-changed`.

**S3. Child, working.**

```
115  ◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier  c: Claim  b: Block  l: Log
75   ◆ Step 3 of 7 · Wire the rail IPC ch… · Running  c: Claim  b: Block  l: Log
40   ◆ Step 3 of 7 · Running  c: Claim
```

**S4. Step blocked** (an operator blocker "needs the staging API key", the mission stale 2 h 15 m;
at 139 the level and the stale age also fit, `KIT` test 7):

```
115  ◆ Step 3 of 7 · Wire the rail IPC channel · Blocked: needs the staging API key  u: Clear block  l: Log
75   ◆ Step 3 of 7 · Blocked: needs the staging API key  u: Clear block  l: Log
40   ◆ Step 3 of 7 · Blocked  u: Clear block
```

**S5. Claimed, self-verified, verified, done.**

```
claimed        115  ◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Verifier  b: Block  l: Log
               75   ◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log
               40   ◆ Step 3 of 7 · Claimed  b: Block
self-verified  (the same three rows: a self-verification reads `Claimed`, as in the popover)
verified       115  ◆ Step 3 of 7 · Wire the rail IPC channel · ✓ Verified · Verifier  l: Log
               75   ◆ Step 3 of 7 · Wire the rail IPC channel · ✓ Verified · Verifier  l: Log
               40   ◆ Step 3 of 7 · ✓ Verified  l: Log
done           115  ◆ Step 3 of 7 · Wire the rail IPC channel · Done · Verifier  l: Log
(needs-human)  75   ◆ Step 3 of 7 · Wire the rail IPC channel · Done · Verifier  l: Log
               40   ◆ Step 3 of 7 · Done  l: Log
```

**S6. Mission stale** (here with the step waiting):

```
115  ◆ Step 3 of 7 · Wire the rail IPC channel · Waiting · Verifier · mission stale 2h 15m  c: Claim  b: Block  l: Log
75   ◆ Step 3 of 7 · Wire the rail IPC ch… · Waiting  c: Claim  b: Block  l: Log
40   ◆ Step 3 of 7 · Waiting  c: Claim
```

The owner row outside Harnu carries it as its state word, `stale` (S2).

**S7. Mission closed (`MISSION_CLOSED`).** Three ways to meet it:

- **A press refused by the handler** (the close raced the press). The next revision says it once:

  ```
  115  ◆ Step 3 of 7 · Wire the rail IPC channel · Not saved: mission closed. · Verifier  c: Claim  b: Block  l: Log
  75   ◆ Step 3 of 7 · Not saved: mission closed.  c: Claim  b: Block  l: Log
  40   ◆ Step 3 of 7 · Not saved.  c: Claim
  ```

- **The line goes away while a field or a confirm is open** (closed missions leave the host's list,
  `mission-ipc.ts:181`, so the host pushes `null`). The field stays; when the person presses
  Enter (or `y`), nothing is sent and the row says so until Dismiss (`LIVE` E7):

  ```
  115  ◆ Mission closed or step unlinked. Nothing was saved.  x: Dismiss
  75   ◆ Mission closed or step unlinked. Nothing was saved.  x: Dismiss
  40   ◆ Nothing was saved.  x: Dismiss
  ```

- **The line goes away while the row is idle.** If the band drew keys in its last frame, it keeps
  one (§7.5); otherwise the row simply disappears:

  ```
  115  ◆ Mission closed or step unlinked.  x: Dismiss
  75   ◆ Mission closed or step unlinked.  x: Dismiss
  40   ◆ No step now.  x: Dismiss
  ```

**S8. Harnu not reachable.** Without a press, the row stands at most `BAND_TTL_MS` (90 s) after the
last push. Then a band that drew no key in its last frame disappears (`LIVE` round 1: gone 95 s
after the host died); one that drew keys turns into the final row `◆ Harnu is not reachable.  x:
Dismiss` (37 cells, so the same at 40; `KIT` test 4), and an open field or confirm stays
until the person ends it (§7.5). A press that cannot reach Harnu:

```
115  ◆ Step 3 of 7 · Wire the rail IPC channel · Harnu is not reachable. Nothing was saved.  r: Retry  x: Dismiss
75   ◆ Step 3 of 7 · Nothing was saved.  r: Retry  x: Dismiss
40   ◆ 3/7 · Nothing was saved.  x: Dismiss
```

Retry sends the same action and text again; nothing is queued in the background: a write replayed
when Harnu comes back would act on a mission the operator may have changed since (T447 §7.2 makes
the same rule for the same reason).

### 6.4 Transient states, at three widths

| State                             | 115                                                                                          | 75                                                                            | 40                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| claim confirm (`verifier` step)   | `◆ Claim step 3 as done? A verifier still checks it.  y: Claim  n: Cancel`                   | the same (72 cells)                                                           | `◆ Claim step 3?  y: Yes  n: No`    |
| claim confirm (`human` step)      | `◆ Claim step 3 as done? You still mark it verified in Harnu.  y: Claim  n: Cancel`          | `◆ Claim step 3 as done?  y: Claim  n: Cancel`                                | `◆ Claim step 3?  y: Yes  n: No`    |
| blocker field                     | `◆ Blocker on step 3: [what blocks it (Enter on empty cancels)] ⏎ raise`                     | `◆ Blocker on step 3: [what blocks it] ⏎ raise`                               | `◆ Block: [] ⏎ raise`               |
| log field                         | `◆ Log on step 3: [note (Enter on empty cancels)] ⏎ log`                                     | `◆ Log on step 3: [note] ⏎ log`                                               | `◆ Log: [] ⏎ log`                   |
| saving                            | S3's row with `Saving…` in place of the status word                                          | the same                                                                      | `◆ Step 3 of 7 · Saving…  c: Claim` |
| logged (one revision)             | `◆ Step 3 of 7 · Wire the rail IPC channel · Logged. · Verifier  c: Claim  b: Block  l: Log` | `◆ Step 3 of 7 · Wire the rail IPC ch… · Logged.  c: Claim  b: Block  l: Log` | `◆ Step 3 of 7 · Logged.  c: Claim` |
| refused (one revision)            | S7, first case                                                                               | S7                                                                            | S7                                  |
| unreachable after a press         | S8                                                                                           | S8                                                                            | S8                                  |
| final, step changed, a press lost | `◆ The step changed. Nothing was saved.  x: Dismiss`                                         | the same                                                                      | `◆ Nothing was saved.  x: Dismiss`  |

Brackets mark the field and its placeholder. The verifier-step confirm, the blocker field, the
logged row and the finals are `KIT` test 9 output; the confirm at 38 columns is also `LIVE` E8.
The human-step confirm, the log field and the saving row are the same functions (`confirmRow`,
`inputLabels`, `fitRow`) worked by hand, not printed: a press resolves before the kit can look at
its saving state. The 30-cell confirm is the narrowest row of the table (§6.2).

### 6.5 The pushed payload

```ts
/** Δ1: the optional `rail` field of `ui.band.set` (contract §9). Built by the host only. */
interface BandRail {
  v: 1
  /** Per binding, strictly increasing. A press names it (02-host §3.1). */
  rev: number
  role: 'owner' | 'child'
  /** Owner: progressHeadline(derived.progress). Child: { kind: 'single', n: k, to: k, m: total }. */
  headline: { kind: 'single' | 'range' | 'done' | 'empty'; n: number; to: number; m: number }
  /** Owner only: the pill's primary state, absent for active / total-changed. */
  state?: 'blocked' | 'needs you' | 'stale' | 're-scope pending' | 'delivered'
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
`RailView` ([`03-prototype-source.md`](03-prototype-source.md), `types/index.d.ts`) is this
shape.

**Why titles are allowed here and not in P4W2's status text.** P4W2 §7.5 bans titles from
`/harnu-link status` because that output is a transcript row the next model turn reads (R29). The
band is drawn and never read by the model (E1; §1). Titles are written by the orchestrator, a
different session, so the host strips control characters and escape sequences before sending, to
keep a title from writing to the operator's terminal (K-4).

### 6.6 Copy rules

`design.md` §8 applies: no emoji, no exclamation marks; short labels without a trailing period
(`Claim`, `Block`, `Clear block`, `Log`, `Retry`, `Dismiss`, `Cancel`); full sentences with one
(`Nothing was saved.`). Position before counts, as "Mission progress" (`design.md:11246-11251`)
requires; no copy promises a guarantee (SEC-7): the confirm says a verifier still checks the step,
never that it is done. The terminal text is English literals in the mod, not i18n, for the reason
P4W2 §10 gives: it is CLI output and the repo's language policy covers it. `◆` is P4W2's band mark.

## 7. Actions (U-3)

### 7.1 What a press does

| Key      | Button        | Offered in the revision when                                                                                                             | The host applies (02-host §3.2), as the verb would                                                           |
| -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `c`→`y`  | `Claim`       | child matched by a session link; level `verifier` or `human`; proof `unproven`; state not `done`/`verified`; no open blocker on the step | `mission_update_step` (`TC:1464`) with `set: { proof: 'claimed' }`                                           |
| `b`→text | `Block`       | same match; state not `done`/`verified`; no open blocker                                                                                 | `mission_set_blocker` (`TC:1531`): `reason: text`, `unblocks: 'the operator clears it'`, `owner: 'operator'` |
| `u`      | `Clear block` | same match; the step has an open blocker                                                                                                 | `mission_clear_blocker` (`TC:1553`): the newest blocker on that step, as the host read it for this revision  |
| `l`→text | `Log`         | same match                                                                                                                               | `mission_log` (`TC:1513`) on that step                                                                       |

`existence` steps are never offered a claim: the handler refuses it (`PROOF_NOT_CLAIMABLE`,
`tool-handlers.ts:4193`), Harnu proves those from links. A blocker raised from the rail is owned by
the **operator**: the person who pressed is the operator by construction, and an operator blocker
lands on the `you` list and re-nudges every 30 minutes until cleared (`docs/harnu-features.md`,
Missions), which is what keeps a hand-raised blocker from being forgotten. OQ-3 asks whether an
"agent's move" variant is wanted. The confirm, the fields, Retry and Dismiss are local to the mod
and reach Harnu only through the action they lead to.

### 7.2 What is deliberately not offered

| Not offered                                                                                  | Verb or door                                                                     | Why                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify a step                                                                                | `mission_verify_step` (`TC:1600`)                                                | Verification belongs to an **independent** verifier session. A press in the builder's own terminal is self-verification by construction: the verb would record `self-verified`, "which the operator never sees as proven" (`docs/harnu-features.md:849`).                                                                              |
| Tick, add or delete a check; mark a human step verified; approve a re-scope; end the mission | the operator doors `mission:operatorDoor` (`mission-ipc.ts:11-19`, `:300`)       | These are the **operator's doors**, reachable only through renderer IPC and pinned so that "No MCP verb reaches this module" (`mission-ipc.ts:16-18`). A press reaches Harnu over the companion channel, which SEC-3 (c) treats as untrusted input; it must never reach an operator door. The operator has the popover one click away. |
| Request close                                                                                | `mission_request_close` (`TC:1637`)                                              | The owner's "it's done" signal, refused until the end is verified. A child has no business with it, and the operator closes directly with **End mission…**.                                                                                                                                                                            |
| Re-scope, add a step, link a child, add a check                                              | `mission_set_end`, `mission_add_step`, `mission_link_child`, `mission_add_check` | The plan's structure is the owner's. A one-key structural change from a builder's terminal is the drift the mission exists to prevent.                                                                                                                                                                                                 |
| Any action on the owner row, or on a child matched only by its folder                        | —                                                                                | Owner inside Harnu: off by default; outside: an external binding gets no write. A folder match is not this session's link (§5).                                                                                                                                                                                                        |
| Idea 115's `[Request close]`                                                                 | —                                                                                | See "Request close".                                                                                                                                                                                                                                                                                                                   |

### 7.3 Keys: collisions, checked

The rail's keys are `c`, `b`, `u`, `l`; `y`/`n` in the confirm; `r` (Retry) and `x` (Dismiss) on
final and unreachable rows.

- They are letters, so they act only while the band holds the keyboard (E4). `KB` binds no letter
  in the `AbovePrompt` context (E12); `Chat` and `Global` bind letters only with a modifier.
  `LIVE`: `c` typed with the prompt focused went into the prompt.
- Letters bound in other contexts: `x` is `footer:close` in `Footer` (footer indicators focused);
  `r` is `settings:retry` in `Settings`; `b`, `q`, `j`, `k`, `g` and `space` are scroll and exit
  keys in `Transcript` (the transcript view, `ctrl+o`). Those contexts are different focus
  targets from the band. Whether the fullscreen layout keeps `Transcript` bindings live while the
  band holds the keyboard is untested (A-7; W0 tests `b` in fullscreen).
- **No digit, ever.** "A bare digit in an empty one answers a band Button (a survey)" (E4). The
  parenthesis may mean the rule exists for surveys only; whether a non-survey band Button with a
  digit hotkey is pressed from an empty prompt was not tested. The ban does not depend on it: a
  digit hotkey would at worst turn the first character of a prompt like "1. fix the test" into a
  mission write, and at best buy nothing a letter does not.
- Two Buttons with one hotkey: "later wins" (E4). Another mod drawing a `c` hotkey under the rail's
  row would take `c` (risk K-3).
- The focus is taken with `ctrl+x tab` (`abovePrompt:focus`) or a click, and left with `escape`.
  The rail never moves the focus itself.

### 7.4 Why the keyboard is fragile

What `LIVE` showed about the band's keyboard, in round 1 and in the round-2 experiments:

- E14: a redraw that leaves no Button and no `Input` hands the keys back to the prompt.
- E15: a key the band does not bind, typed while it holds the keyboard, goes to the prompt, and
  the keyboard goes with it.
- E16: a pushed redraw that swaps the keys for others keeps the keyboard, as long as one is drawn.
- E17: the mod cannot know whether the band holds the keyboard.

E15 is the one that matters most. A person typing into the blocker field when a push removes the
field keeps typing, and with the field gone the rest of the text goes to the prompt; one Enter
later it is a user turn for the executor's model. That is F-1's failure, and a final row with a
Dismiss key does not prevent it: the person's next letters are not `x`. So the rules below protect
what the person is in the middle of, not the focus as such.

### 7.5 The rules (Δ8)

1. **An open confirm or field is the person's.** No push, no TTL expiry, no width change removes
   it. It ends with the person's own key: Enter in a field (empty: cancel), `y` or `n` in the
   confirm. **It pins what the person saw when it opened:** the revision `rev` and the step
   number `n` of that frame. Its label keeps naming that step ("Log on step 3") whatever arrives
   later, and the press names the **pinned** revision, never the current one. At the moment the
   person ends it the mod checks the line is still there and the action is still offered
   (`checkTarget`); if not, nothing is sent and a final row says so (S7, second case; §6.4, last
   row) until Dismiss. If the line is there, the press is sent with the pinned revision and the
   host decides (02-host §3.1): it resolves the step that revision showed, and answers
   `RAIL_STALE` when that is no longer the step it resolves now. So a note typed for step 3
   cannot land on step 5, and an operator blocker cannot be raised on the wrong step.
   **No timer closes it.** A field the person left with Esc stays drawn until they end it
   (`ctrl+x tab`, then Enter on an empty field cancels). Round 3 tried a five-minute idle close and
   the round-3 grading showed why it cannot be had: closing to the idle row with the line gone
   leaves nothing focusable (E14), and closing it with the line present moves the person's next
   letter, once they return, into the prompt (E15). The pin makes a lingering field harmless: a
   note typed an hour later still names the step the field opened on, and the host answers
   `RAIL_STALE` if the child has moved on.
2. **An idle row that drew keys keeps one.** When a push or an expiry would leave it with none (the
   host sends `actions: []`, as in Ask mode; the line goes away; the width drops), the row draws a
   `keep` key instead: the first offered action, or Dismiss on a final row. Only Dismiss, the
   person's own press, may leave the band with nothing to focus.
3. **A press while saving is ignored**, and the keys stay drawn while saving and while Harnu is
   unreachable, so the band keeps a focusable element through every step of a press.
4. **The mode never outlives its reason.** `reconcile` (`rail-core.ts`) maps every push and expiry:
   idle + line gone → final (nothing lost); final (nothing lost) + a line again → idle. An expired
   line is set to `null` with the cause `unreachable`, so the final row says what happened.

The cost of rule 2: a session whose band drew keys and whose mission then closes shows `◆ Mission
closed or step unlinked.  x: Dismiss` until someone presses `x`, whether or not the band had the
keyboard, because E17 leaves the mod no way to tell. OQ-9 asks whether that is acceptable.

**Residual: a letter for a key no longer drawn (E15).** Rules 1 to 4 protect an open field and keep
one key drawn; they cannot make the engine route a letter the band does not bind. Two cases remain,
and they are named here as residual risk (K-10), not fixed:

- _A push swaps the actions_ (to `[unblock, log]`, say) and the person presses `b`, which is no
  longer drawn: the letter goes to the prompt and takes the keyboard with it; a reason typed next
  plus Enter is a user turn. The window is the time between the push and the person noticing.
- _A field or confirm the person walked away from_ stays drawn with the keys hidden behind it, so
  a person who comes back and presses `b` meets a field instead of a key, or the prompt if they
  left with Esc. The pin keeps what it eventually sends safe; the first keystroke is theirs to aim.
- _A narrow band_ (40 to about 50 columns) draws only the `keep` key. A person who learned the
  keys at a wider size and presses `b` meets the same thing.

What limits it: any letter the band does not bind has this effect (E6 used `q`), so it is not
specific to the rail; the person has to have taken the keyboard on purpose (`ctrl+x tab`); the
keys drawn are the only keys the docs tell the person to press; and the effect is a text turn the
person sees in the prompt before Enter. A candidate mitigation is probed in W0 (A-8): draw every
unbound letter as a hidden Button that does nothing, so that no letter leaves the band. It is not
adopted, because it would also swallow letters the person means for the prompt while the band
holds the keyboard.

`KIT` test 5 asserts at least one Button or `Input` after every push and every expiry tick while a
mode is open, in the four cases the round-1 verification probed: the blocker field open when the
host pushes `null`; the log field open while Harnu is down for 46 ticks past the TTL; idle keys
when the host pushes `actions: []`; the claim confirm at widths 59 and 39 with Claim withdrawn.
The verifier's own probes, run against the round-2 prototype, report a focusable element in every
one ([`01-prototype.md`](01-prototype.md) §3). `LIVE` E7 typed half a blocker reason, had the host
push `null`, typed the rest and pressed Enter: the prompt stayed empty, no event was sent, and the
final row appeared; E8 opened the confirm, narrowed the terminal to 38 columns and pressed `y`: the
claim was sent.

## 8. Data source, freshness, cost (U-4)

Specified in [`02-host.md`](02-host.md): why not MCP (§2.1), the resolver and the identity it may
trust, including T447's finding and D-A (§1), freshness from a timer Harnu main owns (§2.2), the
cost across a fleet (§2.3), and every environment (§4).

## 9. Packaging (C-3)

**A mix: the existing Harnu mod and Harnu main. No new mod.**

| Part                                                                                                         | Where                                                                                                                        | Why there                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `AbovePrompt` hook, the views, the fitting, `reconcile`, the `ui.band.set` handler, the `ui.action` emit | `resources/companion/` (`register.ts`, a `surface.tsx` per P4W2, a `$`-free `lib/rail-core.ts`)                              | It is the one plugin every Harnu spawn loads and it already owns the channel; MOD-4 allows one `AbovePrompt` hook. Nothing it adds needs `$.mcp.call` or `$.process` (SEC-9 holds). |
| The resolver, the trusted id set, the publisher and its timer, the action executor, the audit record         | `src/main/mission-role-core.ts`, `src/main/companion/rail.ts` (+ `rail-core.ts`); `pty-session-index.ts` gains a key history | It owns the PTYs, the missions, the handlers, the gates and the audit log.                                                                                                          |
| The switch; the `via: 'rail'` mark in the popover                                                            | renderer: Settings → Mods (P4W1's settings region); `MissionPopover.vue`                                                     | the operator's control and view (§10)                                                                                                                                               |

**Not `$.harnu` (T447).** The noun needs MCP and answers `NO_MCP` in the rail's main sessions. A
third-party band on the `harnu.mission` atom (T447 §14) stays possible and is a different mod; the
rail neither depends on nor blocks it.

**A session started outside Harnu** gets the rail only through P4W3's opt-in switch, which already
stages the companion there. It draws the owner row (Δ5) and a display-only child row, both once
the binding is corroborated, and never offers an action. With P4W3 off it gets nothing.

### 9.1 Relation to every wave and spec it touches (C-2)

Status checked in code at `cb7fb58`. The rail specifies only the right-hand column.

| Wave or spec                                     | Status                                                                                                                          | Relation                                                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T389 **P4W2** terminal band                      | not shipped (§4.2)                                                                                                              | **builds on and lands it**: W1 implements P4W2 §7.4 as written; Δ1–Δ8 are the only changes, recorded in P4W2's document by W1                                                                                                  |
| T389 **P2W1** command channel                    | shipped (`command-channel.ts`, `command-gate-core.ts`)                                                                          | **uses** `enqueue`, the observe-only admission of `ui.band.set`, the edge-event flush                                                                                                                                          |
| T389 **P1W3** identity, rebound                  | shipped: `session.rebound` is handled in `identity-adapter.ts:259-268` (`onRebound`), which re-keys a binding on the mod's word | **does not trust it for a target**: a reported rebound is recorded (audit, the OQ-8 gesture) and never matches a step or an owner; only spawn keys and migrations Harnu correlated itself do ([`02-host.md`](02-host.md) §1.2) |
| T389 **P1W4** prefs keys, feature policy         | shipped (`companion-prefs.ts`, `feature-policy.ts`)                                                                             | **uses** `registerPrefsKey('surface' \| 'rail')`, `registerFeaturePolicy('ui.band' \| 'ui.rail')` (Δ6)                                                                                                                         |
| T389 **P4W1** Mods tab                           | shipped (`mods-audit-core.ts`)                                                                                                  | **uses** its settings region for the switch; the `terminal` chip appears (§10.3)                                                                                                                                               |
| T389 **P4W3** outside Harnu                      | shipped (`external-binding.ts`, `external-corroboration.ts`)                                                                    | **uses** corroboration; outside sessions get display only (§5)                                                                                                                                                                 |
| T389 **P2W4** live contract (`context.append`)   | not shipped (absent from `IMPLEMENTED_COMMANDS`)                                                                                | **not used**; OQ-5                                                                                                                                                                                                             |
| T389 **P3W1** approval hold                      | not shipped (no ask broker in `src/main`)                                                                                       | **independent**; A-5 (the band under the permission dialog) is P3W1's open question too                                                                                                                                        |
| T389 **P4W5** compaction digest                  | not shipped                                                                                                                     | **independent**; the model-side half of "the executor never loses its step" (§1)                                                                                                                                               |
| **T447** `$.harnu` noun (merged spec, `9142876`) | spec only: no `resources/harnu-sdk/`, no `childSessionId` (`TC:1394-1404`)                                                      | **not used**; its D-A matching is **implemented as a core** by the rail, and D-A's verb later wraps it, with the role order reconciled ([`02-host.md`](02-host.md) §1.4)                                                       |
| Mission v3 UI (`MissionPill.vue`, popover)       | shipped                                                                                                                         | **reuses** its wording and rules (`progressHeadline`, `missionState`, the step-rail words); W3 shares `missionState` instead of copying it; W2 shows `via: 'rail'`                                                             |

## 10. Control and failure (C-4)

### 10.1 On and off

- **Keys.** W1 registers P4W2's `surface` (default `false`, P4W2 §13) and the new `rail`, both with
  `registerPrefsKey` (`companion-prefs.ts:211-221`): boolean, `observeCap: false` (a CLI above the
  tested ceiling turns them off, like `modsLive`, `mods-observed.ts:58-63`). Both are registered
  before any rule reads them, because `prefsKey` throws for an unregistered key
  (`companion-prefs.ts:216-218`). `rail` defaults to **`false`**; W3 sets it to `true` once
  LV-T454-a and LV-T454-b pass, the same pattern as `surface`.
- **Features.** `ui.band` (P4W2's): `prefsKey('surface') || prefsKey('rail')`, the mode not `off`,
  the lease live. `ui.rail` (new): `rail` on, profile `interactive`, trust `agent` or `operator`.
  Both are attempt-proven like `ui.band` (`command-channel.ts:171-172`).
- **Where the operator flips it**: Settings → Mods, the Harnu mod's settings region (P4W1 part A),
  a `ToggleSwitch` and a `SettingHint`. It applies to sessions started afterwards, since features
  are fixed at hello. Inside a session the person collapses the band with the engine's `[-]` or
  `ctrl+x ctrl+a` (E12); the rail respects it.
- **Kill switch.** The Harnu mod's mode `off` empties `enable` for every binding
  (`feature-policy.ts:76`), so the rail is gone with the rest.

### 10.2 Failure: open, always

| Failure                                                    | Behaviour                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The render hook throws                                     | `catch` returns `below`, what the plugins beneath drew (prototype `register.ts`; P4W2:207-208) |
| A `$` promise rejects in a handler (`update`, emit, flush) | every closure ends in `.catch(() => undefined)`; the row stays as last drawn                   |
| The resolver throws for one binding                        | that binding gets `line: null`; one log line; the others are unaffected                        |
| Harnu down                                                 | S8; an open field or confirm stays (§7.5)                                                      |
| A handler refuses                                          | the next revision carries `result.code`; the row says so once (§6.1)                           |
| `ui.band` not enabled, feature not declared, CLI too old   | no row; `next(e)` unchanged                                                                    |
| Another mod's band                                         | drawn below the rail's row, never replaced (`KIT` test 8)                                      |

Fail-open is right here because the rail is a convenience over the Mission, never a gate: when it
is missing, the executor's work and the operator's popover are exactly as they are today. The one
thing the rail does not do on failure is remove what the person is typing into (§7.5).

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

- **L1, pure (vitest).** `resolveMissionRole` and the trusted id set (02-host §1), the `BandRail`
  builder (each row of §6.1, position never a count, caps and control-character stripping), the
  action checks and the single-write apply functions (02-host §3), and the copy tables.
- **L3, mod (`claude plugin test`).** The prototype's eleven tests, ported onto the companion's rig
  (`resources/companion/tests/support/rig.ts`), plus: `ui.band.set` with and without `rail`, a
  lower `n` never overwriting a higher one, the hot reload. Test 5 (F-1) and test 9 (every state
  fits at three widths) are kept verbatim as the contract of §6 and §7.5.
- **L4, live (`--with-cli`).** LV-T454-a: in Harnu's own xterm.js terminal (not tmux), in both
  layouts (`CLAUDE_CODE_NO_FLICKER` on and off, as LV-P4W2-a), the round-1 sequence and E1–E8,
  including `b` in fullscreen (A-7). LV-T454-b: the same in an `agentControlled` spawn (no Harnu
  MCP) against a real mission file, plus `/clear` in the executor and one more press (A-1).

## 12. Implementation outline (C-6)

Sizes: S ≤ 1 day, M 2–4 days, L a week or more. An outline; no cards are created.

| Wave | Content                                                                                                                                                                                                                                                                                                                                                                                                                         | Size | Depends on         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------ |
| W0   | **Spike in Harnu itself.** The prototype in an isolated second Harnu (`docs/dev/live-verify-second-instance.md`): xterm.js, `ctrl+x tab`, the fullscreen layout, E14–E17 again, A-1 (a `/clear`'s transcript and the watcher), A-3 (`conn` unreadable from the Bash tool), A-7 (`b` in fullscreen), A-8 (catch-all Buttons), A-9 (ambiguous-width terminals), A-10 (the host half of the pin). Evidence note in this directory. | S    | —                  |
| W1   | **The band site and the display rail.** P4W2 §7.4 as written (hook, `surface.tsx`, `ui.band.set` handler, `band` key, TTL tick); Δ1, Δ2, Δ6, Δ7, Δ8; `surface` and `rail` keys and the `ui.band` rule; `mission-role-core.ts`; the PTY key history and the trusted id set; the publisher and its timer; L1 + L3.                                                                                                                | M    | W0, P2W1 (shipped) |
| W2   | **Actions.** Δ3, Δ4; the `ui.action` handler and its checks; the pure apply functions extracted from the three handlers, the single locked write with the `· rail ·` Log header and `via: 'rail'`; the `rail` audit record; the Ask-mode rule; the popover's "from the terminal rail" mark; L3 for every refusal; LV-T454-a/b.                                                                                                  | M    | W1                 |
| W3   | **Owner row outside Harnu and default on.** Δ5 (moves `missionState` to a shared pure module the renderer and main import, rather than copying it); flips `rail` to default `true` after LV-T454-a/b.                                                                                                                                                                                                                           | S    | W2, P4W3 (shipped) |
| W4   | **D-A over the resolver** (optional, owned by T447): `mission_get({ childSessionId })` wraps `resolveMissionRole` (02-host §1.4).                                                                                                                                                                                                                                                                                               | S    | W1                 |

Order: W0 → W1 → W2 → W3; W4 any time after W1. W1 alone is useful: the executor's step is on
screen.

**Repo contracts each wave owes.**

| Contract                               | W1                                                                                                                                                                                                                              | W2                                                                                                                                                                                       | W3                                                      | W4                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                         | `Added`: an executor's mission step above the prompt                                                                                                                                                                            | `Added`: claim, block, clear and log a step from the terminal                                                                                                                            | `Changed`: the rail is on by default; owner row outside | `Added`: `mission_get` finds the mission a child session builds                       |
| `docs/harnu-features.md` + marker bump | yes: the step a child builds is drawn in its terminal                                                                                                                                                                           | yes: an operator may claim, block, unblock or log a step from the executor's terminal; such writes carry a `· rail ·` Log header and `via: 'rail'`; in Ask mode the rail is display-only | no                                                      | yes: the `childSessionId` selector and what it matches                                |
| `docs/user/`                           | `sessions.md` § "Mission step rail" (what it shows, `ctrl+x tab`, Dismiss); `mods.md` (the switch, the chip)                                                                                                                    | `sessions.md` (the keys, the confirm, "Nothing was saved", Retry); `agent-control.md` § Missions (presses are writes, marked as rail); `troubleshooting.md` (the unreachable row)        | `sessions.md` (default on)                              | `agent-control.md` § Missions                                                         |
| `design.md`                            | §6 new "Terminal mission rail (T454)" with §6.1–§6.4's tables and §7.5's rules; §8 Do line                                                                                                                                      | §6 the keys and transient states; the popover's rail mark                                                                                                                                | —                                                       | —                                                                                     |
| i18n (`en.json` and `pt-BR.json`)      | `harnuMod.rail.label`, `harnuMod.rail.hint` (terminal text is English literals, §6.6)                                                                                                                                           | `mission.viaRail` (the popover mark)                                                                                                                                                     | —                                                       | —                                                                                     |
| T389 documents                         | **P4W2 amended**: §6 non-goal (line 76) and §7.3 row 1 (line 178) and AC-P4W2-9 annotated with Δ2–Δ3, §7.4 with Δ8; `01-contract.md` §9 (`ui.band.set` `rail`), §22 (the `band` value, `railMode`), §11 (`ui.rail`, `rail` key) | `01-contract.md` §6 (`ui.action` names), `RailRefusal`; master §12 audit table: the `rail` record kind                                                                                   | —                                                       | —                                                                                     |
| CI gates                               | the `mod` step covers the new companion files; `user-docs-gate` fires on the new top-level `src/main/mission-role-core.ts`, satisfied by the `docs/user/` update                                                                | `awareness-gate` does not fire (no `tool-catalog.ts` or `harnu-features.ts` change); the doc is owed by the contract anyway                                                              | —                                                       | `awareness-gate` and `user-docs-gate` both fire on `tool-catalog.ts`; both docs above |

## 13. Assumptions and what settles them

| #    | Assumption                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Settled by      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| A-1  | After `/clear` or `/resume` inside a Harnu PTY, Harnu's watcher sees the new transcript and its birth time is after the PTY's spawn, so the corroboration rule of 02-host §1.2 admits it. The birth time is the **first timestamped record** of the file (a `user`, `assistant` or snapshot row's own `timestamp`; on this machine the file's btime and that timestamp agree to the second), with the file's btime only as a fallback, because `birthtimeMs` is 0 on file systems without `statx` support | W0, LV-T454-b   |
| A-2  | Harnu's xterm.js passes `ctrl+x tab` and the letter keys to `claude` as tmux does, and E14–E17 hold there                                                                                                                                                                                                                                                                                                                                                                                                 | W0, LV-T454-a   |
| A-3  | A process started by the Bash tool cannot read `conn` out of the `claude` process (it is in module memory and `$.state`, SEC-8)                                                                                                                                                                                                                                                                                                                                                                           | W0              |
| A-4  | No plugin can press another plugin's Button at run time (E8 is an absence in the declarations)                                                                                                                                                                                                                                                                                                                                                                                                            | W0 probe        |
| A-5  | The band is not visible while the engine's permission dialog is open (P4W2 Q-P4W2-c, master Q26); the rail then simply waits                                                                                                                                                                                                                                                                                                                                                                              | P3W1 / W0       |
| A-6  | The publisher's per-tick cost at fleet scale is small (02-host §2.3 is an estimate for the resolver; the derive is the existing list's)                                                                                                                                                                                                                                                                                                                                                                   | W1 measurement  |
| A-7  | In the fullscreen layout, `b` (and `x`, `r`) pressed while the band holds the keyboard reach the band, not the `Transcript` context's scroll bindings                                                                                                                                                                                                                                                                                                                                                     | W0              |
| A-8  | Hidden catch-all Buttons (every unbound letter) keep the keyboard in the band without drawing anything or arming a key the person did not mean; if so, OQ-A                                                                                                                                                                                                                                                                                                                                               | W0              |
| A-9  | On a terminal that draws the East-Asian-ambiguous glyphs two cells wide, the engine truncates the row's text and leaves the keys on screen                                                                                                                                                                                                                                                                                                                                                                | W0              |
| A-10 | The host half of the pin (a 32-revision target record per binding, `RAIL_STALE`, `RAIL_NOT_OFFERED`, the fresh re-read under the lock) behaves as 02-host §3.1 says, and 32 revisions outlast a field a person leaves open for a long time (or the ring must be larger)                                                                                                                                                                                                                                   | W0, W2 L1 tests |

## 14. Open questions (C-7)

| #    | Question                                                                                                                                                                                                                                                          | Default until settled                               | Who decides         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------- |
| OQ-1 | Should an **orchestrator inside Harnu** also get the owner row, given the Topbar pill shows the same headline (R20)? A case for it: a helper pane shows a terminal while the pill follows the selected session.                                                   | no owner row inside Harnu                           | Operator            |
| OQ-2 | Is claim-with-confirm right, or should claim be one press like block?                                                                                                                                                                                             | two presses (a claim has no undo through the verbs) | Operator            |
| OQ-3 | A blocker raised from the rail is owned by the `operator` (it chimes and re-nudges). Offer an "agent's move" variant (a second key; Shift is the same key, E4)?                                                                                                   | operator-owned only                                 | Operator            |
| OQ-4 | Should a refused or unreachable press also raise a `notify` in Harnu's Activity, or is the row enough?                                                                                                                                                            | the row only (no toast, P4W2 noise rules)           | Operator            |
| OQ-5 | Should the executor's **model** be told that the operator moved its step, through P2W4's `context.append` with a closed-registry row ("The operator claimed step stp-3 from the terminal.")? R29 forbids free text there; ids only.                               | not told; the orchestrator reads the Log            | Operator, with P2W4 |
| OQ-6 | Does the rail stay display-only in Ask mode (02-host §3.3), or should a press in Ask mode park a confirm in the Approval Inbox like an agent's write?                                                                                                             | display only in Ask mode                            | Operator            |
| OQ-7 | Is a `rail` key separate from P4W2's `surface` wanted, or one switch for "Harnu in the terminal"?                                                                                                                                                                 | separate (§10.1)                                    | Operator            |
| OQ-8 | When a `/clear` or `/resume` cannot be corroborated (A-1 fails), or a re-link makes the new id look contested (02-host §1.2), should the rail stay display-only until the operator uses a gesture (a popover action, "this is still my step") that Harnu records? | display only; no gesture in v1                      | Operator            |
| OQ-9 | Rule 2 of §7.5 leaves `◆ Mission closed or step unlinked.  x: Dismiss` in every executor whose band drew keys, until someone presses `x` (E17: the mod cannot tell whether the band had the keyboard). Is that noise acceptable for the safety?                   | keep the row                                        | Operator            |
| OQ-A | If A-8 holds, should the band swallow every unbound letter while it holds the keyboard (no letter ever leaves it), at the cost of the "Esc is not needed to type" convenience?                                                                                    | no; residual K-10 stays                             | Operator            |

## 15. Risks

| #    | Risk                                                                                                                                                                                                | Sev    | Mitigation                                                                                                                                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| K-1  | F-1 regresses: the operator's typing reaches the executor's model                                                                                                                                   | High   | §7.5; `KIT` tests 5 and 9 are kept as L3 contract tests; LV-T454-a repeats E7                                                                                                                                                                                                                    |
| K-2  | A forged `ui.action` (any plugin holding `conn`) writes a step                                                                                                                                      | Medium | bounded to four agent-level writes on the step Harnu resolved from ids it observed itself; revision check; rate limit; `· rail ·` header, `via: 'rail'`, audit (02-host §3.3–§3.4)                                                                                                               |
| K-3  | Another mod's band takes `c`, `b`, `u` or `l` ("later wins"), or a plugin above the rail rewrites its tree: relabels a Button or changes a hotkey, while a press still runs the companion's closure | Medium | not preventable in-process (a plugin is trusted code, smoke D6); what a press did is what the Log line and the popover say, never the label; documented in `docs/user/`                                                                                                                          |
| K-4  | A step title or blocker reason carries terminal escape sequences                                                                                                                                    | Medium | the host strips C0/C1 controls and ESC sequences before sending; L1 test                                                                                                                                                                                                                         |
| K-5  | The rail shows a step the session no longer builds (a stale link after a re-dispatch)                                                                                                               | Low    | the resolver re-runs on every tick and write; the orchestrator can re-link                                                                                                                                                                                                                       |
| K-6  | The child's "Step k of m" and the pill's "Steps a–b of m" are read as a contradiction                                                                                                               | Low    | both are positions (§6.1); `docs/user/` says the rail shows _this session's_ step                                                                                                                                                                                                                |
| K-7  | Noise: the row changes on every derive; the Dismiss row of OQ-9 lingers                                                                                                                             | Low    | only a changed value is sent; debounce 500 ms; OQ-9                                                                                                                                                                                                                                              |
| K-8  | A forged block raises an operator-owned blocker that chimes every 30 minutes                                                                                                                        | Low    | the popover marks it "from the terminal rail" with the session; one click clears it; the same blocker is already reachable by any MCP holder through `mission_set_blocker`                                                                                                                       |
| K-9  | A forged `session.rebound` aims a press at a sibling's step                                                                                                                                         | Medium | a companion-derived id never matches a step or an owner: only spawn keys and migrations Harnu correlated itself do (02-host §1.2); a derived id is recorded, flagged contested when linked, and must pass four conditions to be recorded as plausible. What remains is audit noise, not a target |
| K-10 | A letter for a key no longer drawn (a pushed swap of actions; a narrow band) sends the keyboard to the prompt                                                                                       | Medium | named residual (§7.5): any unbound letter does this (E6); the person took the keyboard on purpose; `docs/user/` says to press the drawn keys; A-8 probes a mitigation                                                                                                                            |
| K-11 | A terminal that draws `◆`, `·`, `…`, `✓` or `⏎` two cells wide pushes the keys off the row                                                                                                          | Low    | the engine truncates the row's text at the end; A-9 measures it in W0; a slack constant if needed                                                                                                                                                                                                |

## 16. Acceptance-criteria traceability

| AC  | Where                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-1 | §4 (P4W2 summary with lines, shipped status checked in code, the decision and its eight deltas)                                                          |
| U-2 | §6 (vocabulary, one cut order with keys reserved first and protected parts, S0–S8 and every transient at 115/75/40 from `KIT` test 9), §7.4–§7.5 (focus) |
| U-3 | §7.1 (keys → verbs), §7.2 (not offered, with reasons), §7.3 (collisions, checked live and against `KB`)                                                  |
| U-4 | [`02-host.md`](02-host.md) (no MCP and why, the resolver and trusted ids, T447's finding and D-A, a main-owned timer, cost, environments)                |
| C-1 | §3 (E1–E17 with `TYPES`/`REF`/`KB` lines and the run that shows each); [`01-prototype.md`](01-prototype.md) §3–§5                                        |
| C-2 | §4 (P4W2), §9.1 (every T389 wave and T447, status checked in code), [`02-host.md`](02-host.md) §1.4 (T447 D-A)                                           |
| C-3 | §9                                                                                                                                                       |
| C-4 | §10                                                                                                                                                      |
| C-5 | [`01-prototype.md`](01-prototype.md): source, `validate`, `test` (11 pass on 2.1.295 and 2.1.296), `tsc` (no error), the verifier's probes, live runs    |
| C-6 | §12, including W4's contracts and the P4W2 amendment                                                                                                     |
| C-7 | §14                                                                                                                                                      |
| C-8 | English only; neutral vocabulary; `npx prettier --check` and the identifier gate (see the report)                                                        |
