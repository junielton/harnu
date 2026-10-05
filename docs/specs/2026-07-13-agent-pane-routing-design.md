# Agent-opened panes land in the caller's folder

**Date:** 2026-07-13
**Card:** `open-file-lands-the-pane-in-the-selected-worktree-not-the-caller`
**Status:** design approved, not implemented

## Problem

The operator asks session A (folder A) to open a file in the helper pane. While the
agent is still working, the operator switches to a session in folder B. The pane opens
in **B's** split stack.

The misroute is deliberate, not a race in the store. `command-dispatch.ts:134` — the
shim binding the `pane.openMarkdown` router action to the helpers store — discards the
caller's folder and re-reads the routing key from the current selection at dispatch
time:

```ts
addMarkdownHelper: (worktreePath, filePath, cwd) =>
  helpers.addMarkdownHelper(sessions.selectedSession?.projectPath || worktreePath, ...)
```

Everything upstream is correct: `ctx.folder` (tool-handlers.ts:553) is threaded intact
through `command-router.ts` `handlePaneOpenMarkdown`. Only the last hop hijacks it.

The hijack was introduced by 6545353, `fix(mcp): open_file pane attaches to the selected
worktree stack (BUG-20)`, whose reported symptom was "the pane lands in an off-screen
stack — an invisible offer".

## The second, hidden cause

BUG-20's symptom was _invisibility_, and reverting the hijack alone would bring it back —
because there is a second defect nobody fixed.

`Session.projectPath` **is** `folder.path` (sessions.ts:2361). But `ctx.folder` is the raw
string the agent supplied. It is normalized only inside the permission gate
(`normalizePath`, plan-tool-call.ts:308) — **never before it becomes a routing key**. A
trailing slash, a symlinked path, or any other spelling produces a _phantom key_: the pane
is appended to a stack that no session ever renders, even with the operator sitting in the
calling session. That is a silent no-op, and it is the likely original trigger of BUG-20.

So the correct fix is not "revert the hijack" — it is "revert the hijack **and** make the
routing key canonical".

## Scope decisions (agreed)

- **Granularity: folder.** A pane belongs to a folder, and a folder may hold N sessions.
  (A folder may or may not be a git worktree — `byWorktree` in `stores/helpers.ts` is a
  legacy name for what is already a folder-path-keyed map.) Session-scoped stacks are
  explicitly out of scope: the shared-loopback MCP transport has no per-session identity
  (one `capy.mcp.json`, one token; the per-connection `mcp-session-id` is a random uuid
  unrelated to a Capy session), so "the pane bound to YOUR session" is not expressible
  today and is not worth buying for this bug.
- **Visibility: badge + active alert**, not silence and not focus-steal. The T78 headless
  contract (an agent open never selects a session or switches folders) is preserved.
- **Applies to every agent-opened pane**, not just `open_file`. A teammate pane opening in
  silence is worse than a markdown one.

## Design

### 1. Routing

1. **Drop the hijack** (`command-dispatch.ts:134`): route by the `worktreePath` the router
   passed — the caller's folder. One line.
2. **Canonicalize the folder before it becomes a routing key.** In `openFileHandler` (and
   the sibling pane handlers), resolve `ctx.folder` against the known folders already
   present in `ctx.folders` and route by the matching `FolderEntry.path`. A folder that
   resolves to nothing known returns a **steer error** to the agent — never a silent append
   to a stack nobody renders. The ACK becomes honest: either it opened in your folder, or it
   told you why not.

Net effect: `pane.openMarkdown` / `pane.split` / resume / teammate all route to the caller's
folder, and can no longer phantom-key.

### 2. Origin (agent vs. human)

The distinction is free. The agent path is exactly `buildDispatchActions()` in
`command-dispatch.ts`; human opens (Topbar "Browse files", FolderMenu, HelperStack
drag-drop) call the store directly. Mark the origin in the dispatch shim — no plumbing
through the router or main.

### 3. Badge

A per-folder "unseen agent panes" signal in the helpers store:

- incremented when a pane is added **by an agent** to a folder that is **not** the visible
  one;
- cleared when the operator selects any session in that folder;
- **not persisted** — the panes themselves persist, the "you haven't looked yet" flag is
  ephemeral by design;
- rendered as a discreet marker on the **folder** row in `SidebarFolder.vue`, deliberately
  distinct from the session status dots (working / needs-input / failed), which mean _session
  state_, not _content is waiting for you_.

### 4. Alert

Reuse the existing OS-notification seam end to end: `window.api.notify(...)` → native toast
(`src/main/notifications.ts`) → click restores + focuses the window and emits
`notify:activate`. Sound comes for free (the native `Notification` is not `silent`); no new
sound infrastructure.

Two anti-noise guards:

- fire only when the target folder is not currently visible;
- coalesce per folder — a burst of 3 panes is one toast saying "3", not three toasts.

`notify:activate` carries a `sessionId`, but a pane belongs to a folder. Activate the
folder's most recently active session — the least surprising choice, and it needs no new
channel.

## Testing

- **Regression (the reported bug):** `open_file` with `folder: A` while the selection is a
  session in folder B lands the pane in A's stack.
- **Canonicalization:** a trailing-slash / symlinked / unknown folder yields a steer error,
  never a phantom stack.
- **Origin + badge:** the unseen counter increments only for agent-origin panes in a
  non-visible folder, and clears on selecting a session in that folder.
- **Coalescing:** the toast throttle is pure and unit-tested.

## Contract obligations

- `CHANGELOG.md` — mandatory (user-visible fix + new badge/alert).
- `docs/capy-features.md` + version marker — `open_file`'s ACK gains a refusal the agent must
  read, and the "pane opens in the background" guarantee becomes "in **your** folder, in the
  background". Agent-facing; the CI awareness gate will demand it.
- `docs/user/` — the badge and the notification are new things a person can see. The user-docs
  gate will demand it.
