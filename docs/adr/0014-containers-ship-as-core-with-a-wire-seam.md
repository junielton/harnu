# ADR-0014 — The Containers feature ships as core code behind a wire-type seam

**Status:** accepted · **Date:** 2026-09-11 · **Card:** T320

## Context

We want a takeover that finds docker stacks left behind by worktrees and lets the operator stop
or remove them (PRD [`T320`](../prds/T320-containers-takeover.md)). Before building it we asked
whether it could ship as a Capy extension instead of core code.

We checked 10 host requirements. 9 of them are unreachable from outside `src/`:

- privileged spawning through `spawnEnvOnce()`;
- IPC registration;
- preload entries;
- takeover registration (a compile-time `ViewId` union);
- the footer pill;
- the Settings tab;
- the i18n schema (`MessageSchema = typeof en`);
- prefs persistence (only partly reachable);
- the CI gates, which would not see out-of-tree code at all.

Only theme tokens are reachable.

Two constraints decide the question:

- **ADR-0002 §2.1.** Extensions never get a generic `window.api.invoke()` escape hatch, and there
  is "no raw DOM access for extension UI — ever, regardless of phase". Capy extensions today
  execute no code at all.
- **T139, the Extension SDK's Phase 3,** would add sandboxed panes. Its card says to wait for
  "real third-party (not self-authored) demand". This demand is self-authored.

## Decision

The feature ships as **core code**, built around a seam that a future pane host could lift out
without a rewrite:

1. `src/main/containers/containers-wire.ts` holds plain types that survive JSON round-tripping.
   It imports no Electron and no sibling main-process module. The view renders a
   `ContainersSnapshot` and imports nothing from `src/main/`.
2. `containers-shell.ts` is the **only** file that spawns `docker`, and it does so through
   `spawnEnvOnce()` (the login-shell PATH, BUG-34). `containers-core.ts` is pure: it owns
   attribution and the verdicts. This is the same `scanner-shell` → `scan-core` split the Reaper
   uses.
3. The stop, start and remove actions live in **one** main-process function. The IPC handler and
   the MCP verbs both call it, so the safety tiers are enforced once, in main. Reaper follows the
   same rule for `neverDeleteRemote`.

**Amended 2026-09-20 (T340).** The wire contract gained a fourth verb, `sweep`, and with it a
second type: `AgentActVerb` (`ActVerb` minus `sweep`). The seam itself is unchanged —
`containers-wire.ts` still imports nothing, and the sweep goes through the same single action
function as the other three. What changed is that the wire now states _who_ may drive a verb:
`sweep` is the operator's, and the MCP verb-to-op map is checked against `AgentActVerb`, so the
compiler refuses a map that quietly exposes it. A verb added to `ActVerb` from now on must either
be mapped to an MCP op or be excluded from `AgentActVerb` on purpose; neither can be forgotten.

## Alternatives rejected

- **An Extension SDK pane.** It requires a runtime for third-party code, a trust model, a
  brokered IPC channel and a `<webview>` pane host, none of which exist. It also contradicts
  ADR-0002's invariant. Phase 3 stays deferred.
- **Folding the feature into the Reaper.** The operator rejected it on 2026-09-10: the Reaper
  needs its own refactor first. The Reaper's snapshot is also scoped to repos, which has no room
  for an orphan whose worktree is gone. T321 adds a stop-stack step to the Reaper after that
  refactor.
- **Shipping only MCP verbs, with no view.** The operator's ask is the human-facing view, since
  they can already get every fact from the CLI. The verbs ship too (T328, T329), as parity.

## Consequences

- Every future change to the snapshot shape goes through `containers-wire.ts`. The view,
  `list_containers` and any later extracted pane all read that one contract.
- **Cost today:** one extra file, plus a hand-maintained parallel type instead of a direct
  `import type`. `pane-registry.ts` already makes the same trade.
- **Re-open this decision** if a second, third-party implementor wants to ship a Capy pane (T139's
  trigger), or if three or more features need the same "privileged spawn + pane" shape.
