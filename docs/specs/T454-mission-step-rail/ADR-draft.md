# ADR-draft: the mission step rail is host-resolved band content, and a press is an event Harnu acts on

- **Status:** proposed (numbered on merge)
- **Date:** 2026-10-09
- **Card:** T454 · Spec: [`00-spec.md`](00-spec.md)
- **Related:** ADR-0018 (the Harnu mod as integration substrate), ADR-0019 (the `$.harnu` noun's
  transport), T389 P4W2 (the terminal band), T447 (the `$.harnu` noun and its D-A)

## Context

The rail draws a session's own Mission step above the prompt and lets the person at that terminal
claim the step, raise or clear a blocker, or log a note with a key. Three facts constrain where it
can live and how a press reaches a mission:

1. The sessions it is for, executors an orchestrator dispatched with `create_session`, are spawned
   **without** the Harnu MCP server (`src/main/pty.ts:811-818`). `$.mcp.call('harnu', …)` has no
   server there, and T447's `$.harnu` noun answers `NO_MCP` for every mission method.
2. The Harnu mod (`harnu-companion`) **is** loaded in every such session
   (`src/main/pty.ts:836-857`) and already holds a command channel to Harnu (T389 P2W1). It may not
   call `$.mcp.call` (T389 SEC-9 (b)), and it may have one `AbovePrompt` hook (MOD-4), which T389
   P4W2 specified and which has not shipped.
3. Harnu main already derives every open mission (`listMissionViews`) and owns the `mission_*`
   handlers, the blocked-folder check and the audit log. A value in `$.state` can be rewritten by
   any plugin through a `state.set` hook, and the channel's `conn` is readable by any plugin
   (smoke D6), so nothing the mod holds can name the target of a write with authority.

## Decision

1. **The rail is content of P4W2's band.** It adds an optional `rail` payload to `ui.band.set` and
   is drawn by the one `AbovePrompt` hook P4W2 specified. Because that site has not shipped, the
   rail's first wave lands it as P4W2 wrote it. No second site, no second plugin.
2. **Harnu main resolves and pushes.** Main matches the binding to its mission and step (owner by
   `owner.sessionId`; child by a `session` link on the binding's id chain, then by a `worktree`
   link to its folder), builds the rail from the mission's `derived.progress`, and pushes it over
   the channel when the derived value changes. The match is one pure function that T447's D-A verb
   later wraps.
3. **A press is an edge event carrying the action and the revision only.** Harnu main checks it,
   takes the mission and step from its own snapshot of that revision, and runs the same handler the
   `mission_*` verb runs (claim, block, clear block, log), with the verb's refusals, a Log line
   naming the rail, and an audit record. It never reaches an operator door (verify, checks,
   re-scope, end).

## Consequences

- The rail works in every session Harnu spawns, with or without MCP, and costs no MCP or `gh` call
  per session: it reuses the mission list the app already builds every 20 s and republishes on
  every mission write.
- A sibling plugin in the same session can forge a press (tokens are correlation, not
  authentication, SEC-3). The effect is bounded to four agent-level writes on the step Harnu
  resolved, one per 2 s, each logged and audited, which a plugin able to write the mission file
  directly does not gain anything from. The model cannot press. In "Ask before agent actions"
  mode the rail is display only.
- The companion gains a `ui.render` hook, so the Mods tab shows its `terminal` chip.
- P4W2 is amended in eight named places (spec §4.3), including its "no band inside Harnu" rule for
  linked children (the Topbar pill is owner-only) and its "no Button in the band" non-goal.

## Alternatives considered

- **A third-party mod on `$.harnu` (T447).** Rejected: it needs MCP, which the rail's main
  sessions do not have; it would also add a poll per session.
- **A separate plugin with its own `$.mcp.call`.** Rejected for the same reason, and it would put a
  second `AbovePrompt` site next to the companion's.
- **The mod sends the step id with the press.** Rejected: the state the row was drawn from can be
  rewritten by any plugin; the host must name the target.
- **Presses as operator doors (renderer-only writes).** Rejected: the operator doors are reachable
  only from renderer IPC by design, and a press arrives over an untrusted channel.

## Kill criteria

- W0 shows that the companion's bound `sid` is not the id missions link, and `sidHistory` cannot
  recover it: the rail falls back to the worktree match alone, or waits for D-A.
- W0 shows that a process the Bash tool starts can read `conn`: the action half (W2) does not
  ship until presses carry a proof the model cannot produce.
