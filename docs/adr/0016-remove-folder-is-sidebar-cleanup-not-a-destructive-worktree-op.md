# ADR-0016 — `remove_folder` is sidebar cleanup, not a destructive worktree op

**Status:** Accepted
**Date:** 2026-07-18
**Author:** junielton (via dispatched agent)
**Deciders:** junielton
**Technical context:** Capy's MCP tool catalog (`src/main/mcp/tool-catalog.ts`), BUG-56

---

## 1. Context

`tool-catalog.ts`'s module doc states, as invariant #3: _"No destructive
worktree op ships in M1 (no `remove_worktree`)."_ BUG-56 asks for a new MCP
verb that removes a folder from Capy's sidebar. On its face this risks
reading as exactly the kind of destructive verb the invariant rules out —
worth writing down why it doesn't.

The actual defect BUG-56 fixes is unrelated to git state: Reaper and the
manual "Remove worktree" action already delete the worktree directory and
branch correctly. What's broken is that Capy's own sidebar (`pinned ∪
active`, see the PRD) doesn't notice the directory is gone, so a "ghost"
folder entry and its now-broken session linger indefinitely.

## 2. Decision

Add `remove_folder`, gated so it can **only** act on a folder whose directory
has already been confirmed absent from disk (`!existsSync(folder)`). It:

- Never deletes a git worktree, branch, or any file on disk — that work is
  already done by whatever caused the directory to vanish (Reaper, manual
  Remove-worktree, or an operator's own `rm -rf` outside Capy entirely).
- Never touches a folder whose directory still exists — that request is
  refused with `DIRECTORY_STILL_EXISTS`, full stop, no force flag.
- Only removes Capy's own bookkeeping of a directory that no longer exists:
  the `projects.json` pin and the transcript-derived `active` classification.

This keeps invariant #3 intact by construction: `remove_worktree` would mean
"delete git state Capy hasn't already been told is gone"; `remove_folder`
means "stop lying about a directory that's already gone." The two are
different in kind, not just in name — one is destructive, the other is
reconciling stale UI state with a fact already true on disk.

## 3. Alternatives considered

- **Do nothing, keep this in Reaper's/Remove-worktree's internal wiring
  only, no MCP verb.** Rejected: the operator explicitly asked for the verb,
  and a ghost folder can also be created by paths Capy doesn't control (a
  manual `rm -rf`, an external tool) — an agent needs a way to reconcile
  those too, not just the two call sites this PRD wires internally.
- **Make the verb also handle unpinning a folder whose directory still
  exists** (a true `adopt_folder` inverse). Rejected as a separate,
  materially riskier feature — it would hide a folder whose sessions/work are
  still real and reachable. Out of scope per the PRD; revisit only if
  explicitly requested.
- **Force-delete the directory as part of the verb** (turn it into an actual
  `remove_worktree`). Rejected outright — invariant #3 stays as written; this
  verb never touches disk.

## 4. Consequences

- The MCP surface gains its first "removal-shaped" verb, but its blast radius
  is provably bounded to sidebar bookkeeping — worth flagging in review if a
  future verb tries to reuse its precedent for something that DOES touch
  disk or git state; that would need its own ADR, not a silent extension of
  this one.
- `docs/capy-features.md` and `docs/user/agent-control.md` must describe the
  guardrail (directory-must-already-be-gone) plainly, so an agent doesn't
  reach for `remove_folder` expecting it to also clean up disk/git state.
