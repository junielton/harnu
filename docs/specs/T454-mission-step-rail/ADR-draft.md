# ADR-draft: the mission step rail is host-resolved band content, and a press is an event Harnu acts on

- **Status:** proposed (numbered on merge)
- **Date:** 2026-10-09 (round 2)
- **Card:** T454 · Spec: [`00-spec.md`](00-spec.md), [`02-host.md`](02-host.md)
- **Related:** ADR-0018 (the Harnu mod as integration substrate), ADR-0019 (the `$.harnu` noun's
  transport), T389 P4W2 (the terminal band), T447 (the `$.harnu` noun and its D-A)

## Context

The rail draws a session's own Mission step above the prompt and lets the person at that terminal
claim the step, raise or clear a blocker, or log a note with a key. Four facts constrain where it
can live, how a press reaches a mission, and what may aim it:

1. The sessions it is for, executors an orchestrator dispatched with `create_session`, are spawned
   **without** the Harnu MCP server (`src/main/pty.ts:811-818`). `$.mcp.call('harnu', …)` has no
   server there, and T447's `$.harnu` noun answers `NO_MCP` for every mission method.
2. The Harnu mod (`harnu-companion`) **is** loaded in every such session
   (`src/main/pty.ts:836-857`) and already holds a command channel to Harnu (T389 P2W1). It may not
   call `$.mcp.call` (T389 SEC-9 (b)), and it may have one `AbovePrompt` hook (MOD-4), which T389
   P4W2 specified and which has not shipped.
3. Nothing the mod says is authority. Any plugin can rewrite a `$.state` value through a
   `state.set` hook and post events with the readable `conn` (smoke D6). The `session.rebound`
   handler re-keys a binding on the mod's word (`identity-adapter.ts:259-268`), so the binding's
   `sid` is sensor traffic too (SEC-3b: no consumer trusts events as authority).
4. Harnu main already derives every open mission (`listMissionViews`), owns the PTY index that maps
   a PTY to the session keys Harnu itself observed, and owns the `mission_*` handlers, the
   blocked-folder check and the audit log.

## Decision

1. **The rail is content of P4W2's band.** It adds an optional `rail` payload to `ui.band.set` and
   is drawn by the one `AbovePrompt` hook P4W2 specified. Because that site has not shipped, the
   rail's first wave lands it as P4W2 wrote it, with eight named deltas. No second site, no second
   plugin.
2. **Harnu main resolves and pushes, on its own clock.** Main matches the binding to its mission
   and step (owner; child by a `session` link; display-only child by a `worktree` link), builds the
   rail from the mission's `derived.progress`, and pushes it over the channel when the value
   changes, from a timer it owns and after every mission write. The match is one pure function
   that T447's D-A verb can later wrap, each keeping its own role order.
3. **A write is aimed only with ids Harnu observed.** The ids a press may target are those Harnu's
   PTY index holds for the binding's PTY: the spawn key, migrations Harnu correlated itself, and a
   companion-reported change only under four conditions: its transcript is corroborated on
   disk and born after the spawn, no live PTY holds it, Harnu never registered it for another
   PTY (a ledger kept for the process lifetime), and no mission step links it. Never the binding's `sid`, never a `session.rebound` as such.
4. **A press is an edge event carrying the action and the revision the person saw.** Harnu main
   checks it, takes the mission and step from its own record of that revision (which must still be
   the current target, else `RAIL_STALE`), and applies the verb's own pure mutation together
   with a Log entry in one locked write, under a `· rail ·` header (`mission_log` neutralises
   heading lookalikes) and with a `via: 'rail'` mark on the record, which no verb can set and
   every verb clears. It never reaches an operator door
   (verify, checks, re-scope, end).
5. **What the person started, the person ends.** An open confirm or text field is never removed by
   a push, an expiry or a width change; its target is checked when the person ends it. An idle
   row that drew keys keeps one. A key the band does not bind sends the keyboard back to the
   prompt (observed live), so removing a field under someone's typing would deliver the rest of it
   to the model.

## Consequences

- The rail works in every session Harnu spawns, with or without MCP, and costs no MCP or `gh` call
  per session: it reuses or runs the mission list on a 20 s timer of its own, with no GitHub wait,
  and republishes on every mission write.
- A sibling plugin in the same session can still forge a press (tokens are correlation, SEC-3). The
  effect is bounded to four agent-level writes on the step Harnu resolved from its own ids, one per
  2 s, each under a `· rail ·` header, marked and audited. It can also relabel the rail's Buttons,
  since plugins of one tier are not isolated. The model cannot press. In "Ask before agent
  actions" mode the rail is display only.
- After a `/clear` the rail is display-only until Harnu's watcher corroborates the new transcript.
- An executor whose band drew keys and whose mission closes shows a Dismiss row until someone
  presses it; the mod cannot tell whether the band had the keyboard.
- Residual, named: a letter for a key no longer drawn sends the keyboard to the prompt (K-10), and
  an id Harnu never spawned, linked to a step only after a forged rebound, can still be aimed at
  (K-9's remainder).
- The companion gains a `ui.render` hook, so the Mods tab shows its `terminal` chip. The mission
  file gains two optional fields (`Blocker.via`, `MissionStep.claimedVia`).
- P4W2 is amended in eight named places (spec §4.3), including its "no band inside Harnu" rule for
  linked children (the Topbar pill is owner-only) and its "no Button in the band" non-goal.

## Alternatives considered

- **A third-party mod on `$.harnu` (T447).** Rejected: it needs MCP, which the rail's main
  sessions do not have; it would also add a poll per session.
- **A separate plugin with its own `$.mcp.call`.** Rejected for the same reason, and it would put a
  second `AbovePrompt` site next to the companion's.
- **The mod sends the step id, or a session id, with the press.** Rejected: both can be rewritten
  or forged by any plugin; the host must name the target.
- **An id chain from `session.rebound` (round 1's `sidHistory`).** Rejected: it would let a forged
  rebound aim a press at any linked step.
- **Run the verb's handler, then `mission_log`.** Rejected: two writes, a gap between them, and a
  Log line any MCP holder could forge verbatim.
- **Presses as operator doors (renderer-only writes).** Rejected: the operator doors are reachable
  only from renderer IPC by design, and a press arrives over an untrusted channel.
- **Replace a field with a final row when its target goes.** Rejected after the live run: the
  person's next letters would go to the prompt.
- **Send the current revision with a press.** Rejected: a note typed for step 3 would be applied
  to whatever step the host resolves when Enter is pressed. A press names the revision the person
  saw.
- **Trust the Log header as provenance.** Rejected: `mission_log` inserts its note raw. `via` and
  `claimedVia` are the marks; `mission_log` also neutralises heading lookalikes.

## Kill criteria

- W0 shows that Harnu's watcher does not see a `/clear`'s transcript with a birth time after the
  PTY's spawn: actions after `/clear` stay off until the orchestrator re-links (OQ-8), and the rail
  ships display-only for those sessions.
- W0 shows that a process the Bash tool starts can read `conn`: the action half (W2) does not ship
  until presses carry a proof the model cannot produce.
- W0 shows that the field rule does not hold in Harnu's xterm.js (keys typed into an open field
  reach the prompt): the action half waits until it does.
