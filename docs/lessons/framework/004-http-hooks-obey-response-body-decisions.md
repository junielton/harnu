# 004-http-hooks-obey-response-body-decisions: Claude Code obeys `permissionDecision` in an `http` hook's response body, even when delayed

**Category:** framework (Claude Code hooks / hook-responder-dispatch)
**Discovered in:** protocol-gate spike for the hook responder / Approval Inbox (Jun 2026)
**Status:** active

## The open question this settles

The hook-responder-dispatch spec (`docs/superpowers/specs/2026-06-18-hook-responder-dispatch-design.md` §2.1) flagged a **high-risk unknown**: Harnu installs hooks with `transport: 'http'`, and the codebase had only ever _observed_ (always answered `200 {}`). It was unproven whether Claude Code actually obeys a **decision returned in the body of an `http` hook response**, or whether only the `command` transport (decision via process stdout) carries decisions. `off`/`shadow` modes don't depend on this; **`active` mode does** — and so does the entire interceptor family (Approval Inbox, Sentinel, auto-approve, re-entry brief).

## What the spike proved

On **Claude Code v2.1.191**, an `http`-transport `PreToolUse` hook that answers with

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "…"
  }
}
```

**blocks the tool.** Driven headlessly:

```bash
# isolated deny-server on :47891 + a standalone settings file (never touches global config)
claude -p "Use the Bash tool to run exactly: echo MARKER" \
  --settings ./spike-settings.json --allowedTools Bash --permission-mode default
# → "The command was blocked before it could run. The Bash tool returned a hook denial: …"
# → MARKER never echoed; the spike server logged the PreToolUse POST + DENY response.
```

Two facts established:

1. **`http` obeys the response body** — no need to switch the installed transport to `command`. This is exactly the wire shape `serializeDecision` emits (`src/main/responder-dispatch.ts`).
2. **A delayed/parked decision is still obeyed.** A second spike held the response **3 seconds** before answering deny; Claude waited and obeyed (_"denied … after a 3000ms delay"_). So the **async** Allow/Deny model (park the request, resolve on human input) is viable — within Claude Code's `timeout` (the `HOOK_TIMEOUT_S = 5` written into each handler, `hook-installer.ts:24`). Harnu's internal deadline (`RESPONDER_DEADLINE_MS = 3500`, `hook-bridge.ts`) sits comfortably under it.

## Implications

- `active` mode is **functional**, not gated — the responder can really allow/deny tool calls.
- The Approval Inbox (and Sentinel / auto-approve / re-entry) can rely on **`PreToolUse`** as the validated decision point: it fires before every tool, carries `tool_name`/`tool_input`, and obeys allow/deny.
- The usable human-decision window is **~3.5 s** (Harnu's deadline) before fail-open lets Claude fall back to its own terminal prompt. The inbox is a **fast-path while watching**, not a park-forever queue.
- `PermissionRequest` / `Notification(permission_prompt)` as _separate_ decision channels were **not** validated here (they need an interactive permission flow that `-p` mode doesn't exercise). Prefer `PreToolUse` until proven otherwise.

## How to re-verify

Spin up a throwaway loopback server that answers `PreToolUse` with a `permissionDecision: deny`, point a **standalone** `--settings` file at it (never edit `~/.claude/settings.json` for a spike — `--settings` is isolated), and run `claude -p "… use Bash to echo MARKER …" --allowedTools Bash`. If MARKER doesn't echo and Claude reports a hook denial, decisions are obeyed. Add a `setTimeout` before responding to re-confirm the parked-decision window.

## Related

- `framework/002-claude-code-strips-settings-hook-keys` — identity by URL-shape; the decision rides the response body, adding no new strippable settings.json key.
- `src/main/responder-dispatch.ts` (`serializeDecision`), `src/main/hook-bridge.ts` (dispatch branch), `docs/superpowers/specs/2026-06-18-hook-responder-dispatch-design.md` §2.1.
