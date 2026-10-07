# T389 study — Claude Mods × Harnu, a cross-study

**Date:** 2026-10-02
**Card:** `T389` — Harnu companion mod
**CLI under study:** `claude` 2.1.287
**Status:** plan of record for T389. Every spec and plan in the epic derives its scope from this document.
**Reads:** `docs/studies/T389-smoke-evidence.md` (the live-test evidence the verdicts below cite) · the T389 binding decisions, `D1`…`D14` (the orchestrator's `DECISIONS.md`, carried into `docs/specs/T389-companion-mod/00-master.md`)

_Sources of the original study: the official docs (10 pages under `code.claude.com/docs/en/plugins/mods/`), the `anthropics/claude-code/mods` repo, issue #91870, the CLI 2.1.287 types (20 thousand lines), 5 videos with transcripts, 3 security blogs, and an inventory of the Harnu code._

---

## How to read this document

This is an English rendering of the study as it was written, **before** any live test. Its
claims are kept as written. Two things were added afterwards and are marked as such:

- a **Live verdict** column (or line) on every row of the cross table and on every item of the
  "new things" list. Values: **CONFIRMED**, **REFUTED**, **PARTIAL**, **UNTESTED**, each with
  the smoke-test reference (`A3`, `B1.7`, …) from `docs/studies/T389-smoke-evidence.md`;
- a **Deviation** pointer where a live test refuted or changed a claim. It names the binding
  decision (`D1`, `D5`, `D7`, `D11`, …) that replaces the study's wording.

Blocks that begin with **Live note** are also additions. Nothing else was rewritten.

**Precedence:** live smoke evidence > the binding decisions > this study > panel opinion. Scope
is not cut by a refutation: everything the study lists is still specified; a refutation changes
the mechanism or the phase, not the existence of the item.

---

## In one sentence

**Mods give Harnu, for the first time, an official foothold _inside_ the `claude` process.**
Almost everything Harnu discovers by guesswork today (scraping a file, pasting text into the
terminal, mirroring a private function of the binary) becomes a typed event. The recommendation
is to build a **Harnu companion mod** ("harnu-companion"): small, auditable, working as a sensor
and an actuator — Harnu stays the cockpit.

## What changed yesterday

- **Mods left early access on 2026-10-01 (v2.1.287) and are on by default.** The old variable
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored.
- A mod is an ordinary plugin with a TypeScript module: `on(event, ($, e, next) => …)`. There
  are ~100 events; `$` is the engine API (files, processes, HTTP, UI, session, model).
- **It runs everywhere** (terminal, embedded PTY, `claude -p`, SDK, VS Code, cloud). It
  **draws** only in the terminal and in Desktop.
- **There is no sandbox.** `$.fs` and `$.process` ignore deny rules. Companies
  (Team/Enterprise) get the `sec-default` mod, which locks the prompt, permissions and classic
  hooks against user mods, and can block personal mods (`allowManagedModsOnly`,
  `disableSideloadFlags`).
- The API **changes between releases without notice**; 104 commits in 23 days. Anthropic says
  it will migrate more native features to mods.
- Community: 359 mods in 373 repos in one month. Usage meters, PR/CI status bands, secret
  guards and small games dominate. A "fleet list" inside the terminal already exists
  (`claude-fleet`).

> **Live note.** Loading and running were observed in a terminal under tmux and in `claude -p`
> (A1, C1, D1). SDK, VS Code, Desktop, cloud and the managed-org controls were not tested. The
> "no sandbox" statement extends to mods against each other: a sibling mod at the same tier
> read and rewrote another mod's HTTP requests, env reads, store writes and tool results (D6).
> That is recorded as the security floor `D13`.

## The channel already exists

Harnu already passes `--plugin-dir` with the `harnu/` folder to every session (bundled skills,
T217). **That folder only needs to gain `hooks/hooks.json` + a `register.ts`** — no new
channel. For sessions outside Harnu, `CLAUDE_CODE_PLUGIN_DIRS` or installation in `~/.claude`
(the "Also outside Harnu" switch that already exists).

> **Live verdict: CONFIRMED for the mechanism (A1), changed for the staging.** One plugin
> folder with `skills/` and a hooks module loads both, through `--plugin-dir` and through
> `CLAUDE_CODE_PLUGIN_DIRS` alone, and `--plugin-dir` is repeatable. **Deviation `D1`:** the
> companion gets its own dedicated, versioned `--plugin-dir`, passed before the skills folder.
> The reason comes from reading the Harnu code, not from a smoke test: the skills folder does
> not exist when no skill is enabled, and it is replaced on every skill toggle, which would
> hot-reload live mods.

## Cross table: today's integration → what the mod delivers

| #   | Today in Harnu                                                                     | Known fragility                                                                                                 | With the mod                                                                                                                                                                                                             | Verdict                                                                   | Live verdict                                                                                                                                                                                                                                                                                                                                                | Deviation                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Approval Inbox** through HTTP hooks written into `~/.claude/settings.json`       | A 3.5 s window, then it falls to the terminal prompt; orphan ports break other sessions; only PreToolUse proven | `tool.check` hook: when the verdict is `ask`, the mod waits for Harnu's decision through `$.http.fetch` — **the hook's clock stops while the call is in flight**, so the 3.5 s limit disappears. Zero writes to settings | **Replaces** (needs a spike, see risks)                                   | **PARTIAL** (B1). The clock does stop during a `$` call: CONFIRMED (B1.2, 15 min hold for ~11 ms of budget). One `$.http.fetch` holding that long: REFUTED (B1.1, hard abort at 30 000 ms). A `tool.check` hold keeps the terminal dialog closed (B1.3). A held `classic.PermissionRequest` answers a dialog that is already open: CONFIRMED (B1.7, 15 min) | `D5`: hold in `classic.PermissionRequest` with a long-poll; `tool.check` is pass-through and only records `tool_use_id`. `D3`: every hold is re-issued in tranches under 30 s       |
| 2   | Per-session hook injection (inline `--settings`)                                   | New token on every boot → a session that survives a restart talks to a dead port                                | `classic.*` events fire with no hook configured; the mod re-reads port/token on every call                                                                                                                               | **Replaces**                                                              | **PARTIAL** (A4, B1.7, B1.8). `classic.*` events reach the module, including `classic.PreToolUse` (issue #96831 not reproduced). The runs had global settings hooks on `PreToolUse`, `PermissionRequest`, `Stop` and `Notification`, so "with no hook configured" was observed only for the other events. Re-reading port/token: UNTESTED                   | `D2`: a rendezvous file re-read on every connect failure, coordinates baked at staging                                                                                              |
| 3   | **Statusline** (a script that writes JSON into an inbox)                           | Single slot; it was once wiped for 13 h                                                                         | `session.measure` event (pushed, not polled): context, 5h/7d limits, cost                                                                                                                                                | **Replaces** and frees the user's statusline                              | **PARTIAL** (A3). The event fires and its figures equal the statusLine blob: CONFIRMED. "Replaces": REFUTED in part — lines ±, thinking, output style and PR have no mod source; model display name untested                                                                                                                                                | `D11`: the statusline is demoted, not removed                                                                                                                                       |
| 4   | **Plan usage** through `claude -p "/usage"` + a regex over human text, every 90 s  | Breaks if the text changes; boots a whole CLI per query                                                         | The same `session.measure` from any live session                                                                                                                                                                         | **Replaces** while a live session exists; keeps the polling as a fallback | **CONFIRMED** (A3, D7): rate-limit windows arrive in `session.measure` and `$.session.usage()` and equal the statusLine figures. A measurement triggered by a rate-limit move alone was not isolated (A3)                                                                                                                                                   | `D11`: the `/usage` poll runs only when no leased session reported within 90 s                                                                                                      |
| 5   | **Fleet state** (working/idle/stuck) from hooks + JSONL tail + a silence timer     | The on-disk format changes between versions; "stuck" is a guess and has raised false alarms                     | `turn.start` / `turn.step` (streaming) / `turn.complete` (with reason and tokens) / `classic.Notification` → an exact state machine                                                                                      | **Replaces** for live sessions; the watcher stays for cold sessions       | **PARTIAL** (A4). The events fire as typed. There is no "dialog answered" event; a main-loop `turn.complete` is not idle while background subagents run; a user "No" ends the turn with `reason:"answer"` and no `classic.Stop`                                                                                                                             | `D12`: mapping per A4, with the listed exits from `waiting-permission`; `turn.step` is not hooked in phase 1                                                                        |
| 6   | **Preamble** through `--append-system-prompt`, frozen at spawn                     | Promoting a session to orchestrator mid-session does not inject the contract                                    | `prompt.compose` adds a section **live**                                                                                                                                                                                 | **Improves** (outside managed machines, where `sec-default` locks this)   | **REFUTED** (C3). The system prompt is snapshotted on the first request until compaction; a section added mid-session had no effect by default. It works with `--system-prompt-snapshot off`, at a cache rewrite per change                                                                                                                                 | `D7`: mid-session contract through a hidden user-role row (`$.session.append`); `--append-system-prompt` stays the spawn-time carrier                                               |
| 6b  | **Orchestrator guard**: a Node script per edit + a write to `settings.local.json`  | Boots a node on every Edit                                                                                      | `tool.call` hook on Edit/Write returning `{deny}`, in process                                                                                                                                                            | **Replaces**                                                              | **CONFIRMED** (B3), with subagent and `.harnu/` exemptions and a live toggle. `NotebookEdit` and a symlink bypass of the path exemption were not exercised                                                                                                                                                                                                  | `D6`: matcher restricted to `Edit\|Write\|NotebookEdit`; a static test forbids any Bash `tool.call` matcher (B4)                                                                    |
| 8   | **Starting-prompt delivery** by pasting into the PTY                               | The most fragile point of the app (BUG-9, 17, 64, 85)                                                           | `$.prompt.submit()` in `session.start` — the mod fetches the prompt from Harnu and submits it                                                                                                                            | **Replaces** the paste path                                               | **CONFIRMED** (C1): the turn starts 857–906 ms after launch with nothing typed; 30 000 chars arrive intact. Text beginning with `/` is rejected; `@file` is not expanded                                                                                                                                                                                    | `D9`: one-shot claim keyed by spawn token, interactive only; `/` text through `$.command.run`; `@file` prompts stay on the legacy path or are inlined                               |
| 9   | **Cross-session messaging** by mirroring a private function of the minified binary | Needs a "re-verification ritual" on every upgrade; no sender identity                                           | Official `$.session.send({to:{sessionId}})` + the `session.receive` event (which also lets Harnu audit the native SendMessage, invisible to Harnu today)                                                                 | **Replaces** for live sessions; waking a parked session stays with Harnu  | **PARTIAL** (D1). The API delivers to idle, mid-turn and `-p` receivers, and the native SendMessage is auditable: CONFIRMED. `isDelivered` means written, not read. Each send runs settings `PreToolUse` hooks as tool `SendMessage`                                                                                                                        | `D10`: Harnu main has no session to send from, so a `message.deliver` command makes the recipient's companion submit a framed peer prompt; the legacy socket path stays as fallback |
| 10  | **MCP verbs with no identity** (ADR-0013: every `sessionId` is self-declared)      | Mission, `speak`, `orchestrator_arm` trust the agent's word                                                     | The mod rewrites the `mcp__harnu__*` call, stamping the real `$.session.id()`                                                                                                                                            | **Solves a structural problem**                                           | **CONFIRMED** (B5): the stamp arrives, overwrites a model-supplied value, and is invisible to the model and the transcript. A sibling mod at the same tier can forge it (D6)                                                                                                                                                                                | `D8`: stamp a per-connection token plus `agentId`; it is attribution, not authentication                                                                                            |
| 11  | **Synthetic → real id** guessed by time proximity                                  | Duplicate rows, BUG-65                                                                                          | Handshake in `session.start`: id + spawn token. `/clear` also announces the new id                                                                                                                                       | **Replaces**                                                              | **PARTIAL** (A2). Handshake: CONFIRMED, 657–827 ms after spawn, before the first prompt. "`/clear` also announces the new id": no mod `session.start` fires after `/clear` or in-session `/resume`; the new id is in `classic.SessionStart`                                                                                                                 | `D2`, `D3`: lazy, idempotent hello; re-key from `classic.SessionStart {source: clear\|resume}.session_id`                                                                           |
| 7   | Bundled skills                                                                     | —                                                                                                               | The same catalog starts carrying mods                                                                                                                                                                                    | **Extends**                                                               | **CONFIRMED** for co-loading (A1)                                                                                                                                                                                                                                                                                                                           | `D1`: a second, dedicated `--plugin-dir` instead of the skills folder                                                                                                               |

## What falls into disuse (over time)

`hook-installer`, the HTTP `hook-bridge`, `statusline-install`, the `/usage` parser,
`messaging-socket`, `prompt-inject-gate` + watchdog, `guard.mjs`, the synthetic-collapse window.
**It does not disappear at once:** everything becomes the fallback for CLI < 2.1.287 and for
managed machines that block mods.

> **Live note.** `D4` narrows this: both paths are always injected and Harnu main arbitrates per
> session and fact family by lease. `D4` also names what is never deleted: the transcript
> watcher, the PID-registry watcher, the `/usage` poll, the JSONL cost scan, the argv
> positional prompt, the task-state reducer, the resolver chain with Sentinel, and the
> hibernation guard. `D11` keeps the statusline (demoted). Retirement is its own phase (`D14`,
> P5).

## What can be built new

1. **Harnu → session command channel.** The mod opens no port, but it can keep a long call to
   Harnu (a Unix socket is accepted). Harnu answers with orders: submit a prompt, abort the turn
   (`$.turn.abort`), compact (`$.session.compact`), show a toast. None of this is possible
   today without typing into the PTY.
   - **Live verdict: PARTIAL** (C2; socket transport A2). A long-poll loop works idle and
     mid-turn, 0–2 ms from enqueue to the mod, and survives turns, `/clear` and hot reload.
     All six commands tried work. A single held call is REFUTED: `$.http.fetch` hard-aborts
     at 30 000 ms. In `-p` a pending fetch blocks process exit.
   - **Deviation `D3`:** holds of at most 25 s, re-issued; no long-poll when
     `isInteractive === false`.
2. **Mods audit — the strongest fit with Harnu's positioning.** Security companies already
   treat mods as an attack surface (127 of the 359 public mods run processes; 111 read every
   prompt). `claude plugin validate --json` lists what each mod intercepts and calls. A "Mods"
   tab in Harnu showing that per folder, with an on/off switch, is governance nobody has — the
   same thesis as the Approval Inbox.
   - **Live verdict: PARTIAL** (D2). `validate --json` lists hooked events, `$` calls, env
     names and state keys, but only as free-text `notes[]` strings, with no URLs, argv, fs
     paths or store keys. A user-tier gate can refuse only mods loaded after it. The 127/111
     counts are UNTESTED.
   - **Deviation `D13`:** the audit pane says "can", never "safe" or "verified". `D14`
     schedules the tab as P4W1, independent of the companion.
3. **Harnu inside the terminal.** A band above the prompt with "Step 4 of 5 · 1 approval
   pending"; `/harnu status` answered by the mod without spending a model turn; links that open
   Harnu. It matters mostly for sessions **outside** Harnu: they become a showcase and enter the
   "Active elsewhere" zone with real state and remote approval.
   - **Live verdict: CONFIRMED** (C4, C5) for the band, the status line and a `/harnu` command
     with no model turn and zero tokens. Clicking the link, rendering inside xterm.js, and the
     outside-Harnu path are UNTESTED.
   - **Deviation:** none; "remote approval" follows `D5`.
4. **Resume micro-plan before parking.** `$.model.fork` asks a cheap question about the
   conversation itself (it uses the cache). Before hibernating, the mod records "where I
   stopped / next step" — exactly what the supervisor-cognition research asked for.
   - **Live verdict: CONFIRMED** (D4). From a `turn.complete` hook: 1881 ms, `cache_read
50989`, a correct 3-line plan, no transcript rows added.
5. **Digest on compaction.** A `session.compact` hook writes the summary into project memory
   (T79 S2) and re-injects the mission state afterwards.
   - **Live verdict: CONFIRMED, with three traps** (D5). The summary is `messages[0].text`.
     A synchronous `$.session.append` inside the hook is lost. Writing to project memory is
     UNTESTED.
   - **Deviation `D7`:** re-inject through the compaction result `messages` or a deferred
     append.
6. **Structured Sentinel rules.** `tool.check` receives typed arguments instead of a regex
   over a Bash string.
   - **Live verdict: PARTIAL** (B1). `tool.check` delivers `tool`, `input` and `tool_use_id`,
     fires in every permission mode and in `-p`, and a hook can override the engine verdict.
     It has no `agentId`. No Sentinel rule was exercised.
7. **Exact cost per turn.** `turn.complete` carries tokens and model → the Usage Dashboard
   stops scanning and pricing every JSONL.
   - **Live verdict: CONFIRMED for tokens, PARTIAL for per-turn USD** (D7, A3). Summed
     `turn.complete` usage matched the CLI total exactly. `turn.complete` has no USD.
   - **Deviation `D11`:** USD from `session.measure.cost.usd` deltas; fork, complete and
     compaction spend is accounted separately.

## Where the mod does NOT reach (Harnu's moat)

- UI across sessions and across repositories — a mod only draws inside one session.
- Answering the permission dialog from another client; redrawing that dialog.
- Parked sessions (no process, no mod), worktrees, board, missions, containers.
- Surfaces that do not draw (VS Code, SDK, cloud).

The threat is at the low end: a usage meter, a session list, a diff panel and a PR inbox are
now one-file mods. **Whatever is "a widget of one session" becomes a commodity; whatever is
coordination and policy stays with Harnu.**

> **Live note.** The second bullet is **REFUTED in part** (B1.7): a mod holding
> `classic.PermissionRequest` can deliver a remote decision that closes a dialog that is
> already open. Redrawing the dialog stays out of reach (issue #98808 holds for drawing, not
> for answering). The third bullet is consistent with D1: a send to an exited session resolves
> `isDelivered:false`.

## Risks

- **Unstable API.** The mod must be thin, with a test (`claude plugin test`) running against
  each new CLI version, and the old paths as a fallback.
  - **Live verdict:** `claude plugin test` CONFIRMED (D3): offline, exit 1 on failure, 5 tests
    in 0.19 s. API drift itself is UNTESTED.
- **Issue #92533 (open):** any `tool.call` hook on Bash breaks subagents with an isolated
  worktree. Do not intercept Bash in `tool.call`; use `tool.check`.
  - **Live verdict: CONFIRMED** (B4). A pass-through `next(e)` on Bash is enough. Binding as
    `D6`.
- **Fail-open:** a hook that overruns or crashes is skipped. Three crashes unload all mods of
  the session.
  - **Live verdict:** fail-open CONFIRMED (A5, B6). "Three crashes unload all mods" **REFUTED
    as tested** (B6): five throws unloaded nothing; three worker wedges unloaded only each
    culprit. The observed hazard is different: a wedge by any mod skips the whole chain for
    that call. Reflected in `D5`.
- **Approval held in `tool.check`:** while the mod waits for Harnu, the terminal dialog does
  not open — whoever is looking at the terminal sees nothing. It needs design (a notice, a
  band or its own buttons) and a measurement of the real timeout of `$.http.fetch`, which the
  docs do not state.
  - **Live verdict: CONFIRMED** (B1.3: spinner only). The timeout is 30 000 ms (B1.1, C2).
    `$.ui.notice` never rendered (B2). **Deviation `D5`.**
- **Source conflict:** issue #94424 says there is no usage-change event; the 2.1.287 types
  declare `session.measure`. Verify live.
  - **Live verdict:** resolved — the event exists and fires (A3, D7); the issue's claim is
    REFUTED.
- **Trust:** Harnu's own mod is unsandboxed code on the user's machine. Keeping it small and
  readable is part of the product.
  - **Live verdict:** UNTESTED as a claim; D6 adds that sibling mods can read and forge the
    companion's traffic. Binding as `D13`.

## Recommended sequence

| Phase                  | Delivery                                                                                                                                       | Retires              | Live verdict                                                                                                                    | Deviation                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — spike (≈1 day)** | Mod skeleton in the folder already passed by `--plugin-dir`; prove: it loads, identity handshake, `session.measure`, long hold in `tool.check` | —                    | Done as smoke A–D. Loads: CONFIRMED (A1). Handshake: CONFIRMED (A2). `session.measure`: CONFIRMED (A3). Long hold: PARTIAL (B1) | `D1`, `D5`. `D14` P0 is "foundations": this study, the smoke evidence, the ADR, the master and contract specs                          |
| **1 — sensor**         | Identity + state + usage by events                                                                                                             | Rows 2, 3, 4, 5, 11  | PARTIAL (A2, A3, A4)                                                                                                            | `D4`: families ship in shadow and flip on parity evidence; `D11`, `D12`. Nothing is retired in this phase                              |
| **2 — actuator**       | Command channel: starting prompt, messages, live orchestrator contract, in-process guard, session stamp on the verbs                           | Rows 6, 6b, 8, 9, 10 | PARTIAL (C1, C2, C3, B3, B5, D1)                                                                                                | `D3`, `D6`, `D7`, `D8`, `D9`, `D10`                                                                                                    |
| **3 — approval**       | Approval Inbox over `tool.check`                                                                                                               | Row 1                | PARTIAL (B1)                                                                                                                    | `D5`: over `classic.PermissionRequest`                                                                                                 |
| **4 — surface**        | Band/commands in the terminal; mods audit tab                                                                                                  | —                    | CONFIRMED (C4, C5); audit PARTIAL (D2)                                                                                          | `D14`: P4 also carries the companion outside Harnu, the resume micro-plan and the compaction digest; P5 is a separate retirement phase |

Phase 0 decides everything: if identity and the long hold work, phases 1–3 remove the five most
fragile points of the app.

> **Live note.** Identity works (A2). The long hold works only as a long-poll, and at a
> different hold point than the study named (B1, `D5`).

## Raw material

Video transcripts, a copy of the docs and the issue dump are in the session scratchpad
(`<scratchpad>/yt/`, `docs/`, `issue.json`) — temporary; ask if they should become a document
in the repo.
