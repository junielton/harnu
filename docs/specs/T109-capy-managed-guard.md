# T109 — Capy-managed orchestrator guard (spec)

**Status:** Spec v1 (2026-07-09) · **Effort:** M · **Card:** [[T109]] · **Dep:** T108 (contract) · T98 (the toggle that arms it)
**Context:** Q22 rescope (harness-owned). Today enforcement is 100% hand-crafted by the operator (`~/.claude/hooks/orchestrator-guard.sh` + `~/.claude/orchestrator-mode.flags` + manual registration in settings). The product needs the same effect with **zero user setup**.

---

## 0. Nature of the guard (calibrates the whole design)

The guard is a **behavioral-drift brake, not a security boundary**. System security
lives in the doors (T104/T80: execution, done, routing) — which are server-side and
fail-closed. The guard only prevents an orchestrator session from "cutting a corner"
on a product file under long-session pressure. Design consequence: **fail-open is
acceptable** (broken guard ⇒ the session becomes a normal session, not a security
hole) — and that's what avoids bricking the user's Claude Code.

## 1. Components

1. **Script:** `<userData>/orchestrator-guard/guard.mjs` (node, no deps), versioned
   by Capy (rewritten on every app update — never hand-edited). Reads the hook
   payload (stdin JSON), decides, responds allow/deny.
2. **Flag file:** `<userData>/orchestrator-guard/armed.json` — a map
   `{sessionId: {folder, armedAt}}`. **Capy's, not the user's** — separate from the
   operator's personal `~/.claude/orchestrator-mode.flags` (no file collision).
3. **Registration:** a `hooks.PreToolUse` entry in the FOLDER's
   **`.claude/settings.local.json`** (the channel Capy already uses for
   always-allow) — matcher `Edit|Write|NotebookEdit`, command = node + script path.
   **Never** touches the user's global `~/.claude/settings.json`.

## 2. Script decision (order)

1. Does the payload carry `agent_id` (subagent/executor)? ⇒ **allow** (executors
   write code freely — that's the point of delegation).
2. `session_id` ∉ `armed.json`? ⇒ **allow** (normal sessions are never affected).
3. Target path inside allowed surfaces? ⇒ **allow**. Surfaces: repo's `.capy/` ·
   session scratchpad (`/tmp/claude-*`) · `~/.claude/projects/*/memory/` (harness
   auto-memory).
4. Otherwise ⇒ **deny** with a steerable message: "orchestrator session — delegate
   this write (contract: docs/capy-orchestrator.md)".
5. Any internal error (unreadable flag, weird payload) ⇒ **allow** + stderr
   (fail-open, §0).

## 3. Lifecycle

- **Arm:** promote (T98) writes the real sessionId (resolve synthetic→real first)
  into `armed.json` AND ensures the hook is registered in the folder's
  settings.local.json (idempotent: present = doesn't duplicate).
- **Disarm:** demote removes the entry. **Session close** removes it (Capy already
  observes the lifecycle — no orphaned ids). **Sweep at app boot:** entries whose
  session no longer exists ⇒ removed.
- **Uninstall:** disabling agent-control for the folder (or a "remove guard" in the
  MCP pane) removes the hook entry from settings.local.json — removal as clean as
  installation; the file never ends up with Capy leftovers.

## 4. Coexistence with the operator's personal hook

- Distinct files (Capy's flag in userData; personal flag in `~/.claude/`) ⇒ zero
  state collision.
- Both hooks may fire on the same call: the policy is practically identical (same
  allowed surfaces), and deny+deny = deny, allow+allow = allow — benign
  composition. Rare case allow(Capy)+deny(personal): the personal one wins (deny
  always wins in the hook runner) — correct: the more restrictive one rules.
- Capy **detects** the personal hook (registration in global settings) and shows it
  in the pane: "personal guard also active" — transparency, not interference.

## 5. ACs

- **AC-1:** promote arms (flag + idempotent registration); demote/close/sweep
  disarm; no orphaned id survives an app restart.
- **AC-2:** armed session: Edit/Write on production code ⇒ steerable deny; on
  `.capy/`/scratchpad ⇒ allow. Normal session: everything allow. Subagent of an
  armed session: allow (tests of the 5 §2 branches).
- **AC-3:** corrupted flag/script error ⇒ allow + log (fail-open proven by test).
- **AC-4:** settings.local.json: installs/removes without disturbing other keys
  (runs the existing always-allow parser); never writes to global settings.
- **AC-5:** capy-features/awareness untouched (the guard isn't a verb — but T98,
  which arms it, already covers the doc update) + CHANGELOG + typecheck/build
  green.

## 6. Out of scope

Guard for non-orchestrator sessions (generic sandboxing) · user-customizable path
policies (v2, along with board policy/I19) · mutating Bash enforcement (the Bash
PreToolUse hook is too noisy for v1 — the contract covers it via text; reevaluate
with real usage).
