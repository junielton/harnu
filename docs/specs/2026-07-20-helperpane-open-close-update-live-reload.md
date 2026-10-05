# HelperPane: open/close/update verbs + live-reload for markdown panes

- **Date:** 2026-07-20
- **Status:** approved (design), not yet implemented
- **Card:** T171
- **Author:** Claude (brainstorming session with Junielton)

## 1. Problem

Confirmed by direct code inspection on 2026-07-19:

1. **`open_file` is open-only.** `MCP_OPS` (`src/main/mcp/tool-catalog.ts:57-105`) has
   no close op. An agent can open a pane in the HelperPane but cannot close a
   specific one — only the human can, via the pane header's `X` button
   (`HelperPane.vue` / `MarkdownPane.vue` → `helpers.removeHelper`).
2. **`open_file` doesn't force a refresh on repeat calls.** Panes dedup by
   `filePath` (`src/renderer/src/lib/pane-registry.ts:67-71`). Calling `open_file`
   again on an already-open path just returns the existing pane id — `addHelper`
   short-circuits on the dedup hit and never re-reads the file
   (`src/renderer/src/stores/helpers.ts:507-513`).
3. **No live-reload for opened documents.** `MarkdownPane.vue:400-403` has this
   comment on record:
   ```js
   /** Re-read the file from disk (v1 has no live-reload watcher), guarding edits. */
   ```
   None of the existing `chokidar` watchers in `src/main/` (session-registry,
   roadmap, team, settings, statusline, screen-detect) cover arbitrary files
   opened in a pane. If an agent overwrites a `.md` already open in a
   MarkdownPane, the user sees stale content until they manually click reload.

Requested by Junielton (2026-07-19): open, close, and update all need to exist
as first-class agent-facing capabilities, plus live-reload if feasible.

## 2. Goals / non-goals

**Goals**

- An agent can open, force-refresh, and close a markdown/memory/explorer pane
  it (or another agent) previously opened.
- An agent can close _any_ pane, including terminal/session panes, when it
  genuinely needs to — gated appropriately for that higher blast radius.
- A markdown pane open in view mode auto-refreshes when its file changes on
  disk, without user action.
- A markdown pane with unsaved edits never silently loses those edits to a
  disk change.

**Non-goals (this spec)**

- Live-reload for `memory` or `explorer` panes (folder/tree-backed — out of
  scope per the approved design; may follow later as its own card).
- Pushing content directly into a pane without a backing file (no "live
  buffer" pane type).
- Any change to how PTY-backed panes (`shell`, `claude`, `teammate`) render or
  refresh — `close_pane` only terminates them; their live content is already
  handled by the PTY pipe.

## 3. Verb surface

Four verbs total, extending `MCP_OPS`:

| Verb                   | Args               | Gate                                                                                      | Notes                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_file` (existing) | `{folder, path}`   | `alwaysAllowable`, `silentAllowInAgentFolder` (unchanged)                                 | ACK gains a `paneId` field (additive, non-breaking)                                                                                                                                                                                                                             |
| `update_file`          | `{folder, path}`   | `alwaysAllowable`, `silentAllowInAgentFolder`                                             | Forces the already-open pane for `path` to re-read from disk. No-op ACK (`{ok:false, code:'not-open'}`) if no pane has that path open — this is a refresh verb, not an open verb                                                                                                |
| `close_file`           | `{folder, path}`   | `alwaysAllowable`, `silentAllowInAgentFolder`                                             | Closes a `markdown` / `memory` / `explorer` pane by its dedup identity (mirrors `open_file`'s args exactly). Never touches PTY-backed panes — same risk class as `open_file` itself: reversible, the agent (or user) can reopen                                                 |
| `close_pane`           | `{folder, paneId}` | **not** `silentAllowInAgentFolder`, **not** `grantable` (mirrors `delete_card`'s posture) | Closes ANY pane by id, including `shell`/`claude`/`teammate` — kills a live PTY. Always falls to the per-call human confirm/park, exactly like `delete_card` and `submit_manifest`: irreversible from the agent's side, so it's a deliberate exception to "mutations don't ask" |

This mirrors an existing precedent in the catalog: `archive_card` (silent,
reversible) vs. `delete_card` (always confirms, no undo) — see
`tool-catalog.ts:83-96`. `close_file`/`close_pane` follow the identical shape:
the common, reversible case (closing a doc pane) is free; the destructive case
(killing a running terminal/session) always asks.

### 3.1 `open_file` — ACK change

Add `paneId: string` to the success envelope, so a caller that wants to later
target `close_pane` precisely (instead of `close_file` by path) can. This is
additive — no existing consumer reads a fixed-shape ACK that would break.

### 3.2 `update_file`

- Resolves the same confined roots as `open_file` (`markdownKnownRoots()` +
  `checkMarkdownReadAllowed`).
- Looks up the pane by `(worktreePath, filePath)` dedup key (same key
  `pane-registry.ts` already uses for `markdown`).
- If found: pushes the same "file changed" signal the watcher (§4) pushes —
  reuses one code path, see §4.3.
- If not found: `{ok:false, code:'not-open'}` — deliberately does NOT open a
  new pane (that's what `open_file` is for); keeps the two verbs' purposes
  distinct.

### 3.3 `close_file`

- Same containment + args shape as `open_file`.
- Resolves the pane by `(worktreePath, filePath)` across the three
  non-PTY, file/folder-backed pane types (`markdown`, `memory`, `explorer`) —
  same identity `pane-registry.ts`'s `dedupKey` already uses for each.
- Calls the existing `helpers.removeHelper(worktreePath, pane.id)` path (same
  function the UI's `X` button uses) — no new removal logic, just a new
  caller.
- `{ok:false, code:'not-open'}` if nothing matches — closing what's already
  closed is a no-op, not an error surfaced to the user.

### 3.4 `close_pane`

- `{folder, paneId}` — resolves the worktree stack containing `paneId` and
  removes that pane regardless of type.
- Gate gap intentional: this is the only one of the four verbs that can
  destroy a running PTY (kills `shell`/`claude`/`teammate` processes), so it
  is EXCLUDED from `silentAllowInAgentFolder`, `alwaysAllowable`, and
  `SAFE_GRANT_VERBS` — every call parks in the Approval Inbox for a human
  confirm, same posture as `delete_card`.

## 4. Live-reload (markdown panes only)

### 4.1 Scope

Only `type: 'markdown'` panes (`MarkdownPane.vue`). `memory` and `explorer`
panes are explicitly out of scope for this spec (folder/tree watchers are a
different cost profile — recursive, gitignore-aware for `explorer`; `memory`
already has its own T79 store). PTY panes are not file-backed and don't apply.

### 4.2 Main-process watcher — signal only, not content

New `src/main/markdown-watch.ts`:

- Ref-counted by resolved absolute path: `Map<absPath, {watcher: FSWatcher,
refs: Set<paneId>}>`. Two panes (even across different worktree stacks)
  watching the same file share one `chokidar` instance.
- A pane registers on mount (`markdown:watchStart`), deregisters on unmount /
  close (`markdown:watchStop`). When a path's ref count hits zero, its
  watcher is closed — no leaked file handles.
- Confinement: only paths that already pass `checkMarkdownReadAllowed` against
  `markdownKnownRoots()` are watchable — the watcher never observes outside
  Capy's known folders, mirroring the read gate exactly.
- **On change, the main process sends only `{path}` over IPC — never file
  content.** The renderer already owns a confined, gated content reader
  (`markdown:read`, `src/main/markdown-read.ts`) with the full containment +
  2 MB cap + binary sniff + image fast-path logic. Piping content through the
  watcher would duplicate that gate on a second code path; piping only the
  signal means the exact same `readMarkdownFile()` call serves both the
  initial open and every subsequent reload.
- Self-write suppression: `MarkdownPane`'s own `⌘/Ctrl-S` save
  (`markdown:write`) must not bounce back as a "file changed" event. The
  watcher module exposes a `suppressNextChange(path)` called by the write
  handler immediately before the write lands, consumed (once) by the next
  `chokidar` `change` event for that exact path. This is a pragmatic
  same-process guard — not a content-hash comparison — since writes and
  watches both live in the main process and are trivially sequenced.

### 4.3 IPC surface

- `markdown:watchStart({path}) -> void`, `markdown:watchStop({path}) -> void`
  — lifecycle, called from `MarkdownPane.vue`'s mount/unmount.
- `markdown:changed:<sanitized-path-or-id>` event (or a single
  `markdown:changed({path})` broadcast the renderer filters client-side —
  implementer's call, follow the existing per-instance vs. broadcast pattern
  already used elsewhere in `src/main/`, e.g. `pty:data:<uuid>` vs. a shared
  channel) pushed to the renderer on a real, non-suppressed change.
- `update_file`'s handler and the watcher's change handler both terminate in
  the same "notify this pane" function — one code path, two triggers (manual
  MCP call vs. chokidar event).

### 4.4 Renderer behavior

In `MarkdownPane.vue`:

- On mount: `markdown:watchStart` for the active `filePath`; on unmount or
  when `filePath` changes: `markdown:watchStop` for the previous path.
- On a `markdown:changed` event for this pane's `filePath`:
  - **No unsaved edits** (`!isDirty` — the existing dirty-tracking used by
    `withDiscardGuard` today): silently `load(filePath)` again, preserving
    scroll position. This is the common case and needs zero user action.
  - **Unsaved edits present**: do NOT reload. Set `staleOnDisk = true` and
    show a header banner ("file changed on disk" + a "Reload" action). The
    banner's Reload button routes through the existing `withDiscardGuard` —
    same confirm-and-discard flow already wired for the manual reload button
    and the `X` close button. This guarantees a disk change can never
    silently clobber in-progress edits.
- The manual reload button (`RotateCcw`, `MarkdownPane.vue:559-568`) is
  unchanged — it remains available regardless of watcher state as a
  belt-and-suspenders manual refresh.

### 4.5 Always-on, no per-pane toggle

The watcher attaches automatically to every open markdown pane — no setting,
no header toggle. Consistent with the zero-friction principle already applied
elsewhere in Capy (see `capy-zero-friction-principle` memory): the pane is
supposed to reflect the file; making that opt-in would just resurrect the
staleness bug behind a switch nobody flips. Cost is bounded by the existing
`MAX_MARKDOWN_PANES = 4` per-worktree cap, so at most 4 additional
`chokidar` watchers per worktree stack, deduped further by shared paths.

## 5. Error / edge cases

- **File deleted while a pane has it open + watcher active:** chokidar emits
  `unlink`. Treat as a change event → `load()` fails with `not-found` from
  `readMarkdownFile` → surface the existing not-found empty state in the pane
  (no new state needed, `MarkdownPane.vue` already renders read errors).
- **`close_file` / `close_pane` on a path/id from a different, unrelated
  worktree stack:** resolve strictly within the `folder` argument's stack;
  `{ok:false, code:'not-open'}` if the pane isn't in that stack, even if it
  exists in another one — no cross-stack search.
- **`update_file` racing a `⌘S` save in flight:** the save's own suppression
  window (§4.2) covers this — an `update_file` call landing during a save is
  functionally identical to a watcher event landing then, and both defer to
  the same dirty-check logic in §4.4.
- **Watcher on a networked/exotic filesystem where `chokidar` is unreliable:**
  explicitly why `update_file` exists as a deterministic fallback (§3.2) —
  the agent that already knows it just wrote a file doesn't have to trust the
  watcher fired.

## 6. Contracts this change must also satisfy

Per this repo's `CLAUDE.md`:

- **Self-awareness doc** (`docs/capy-features.md`): four new/changed verbs +
  a new `paneId` ACK field on `open_file` — bump the version marker, describe
  each verb's gate posture (the `close_file` vs. `close_pane` split
  especially, since it's the one place an agent needs to know a call will
  park for confirm).
- **User docs** (`docs/user/agent-control.md`): human-prose counterpart for
  all four verbs.
- **CHANGELOG.md**: dated entry once shipped.
- **`design.md` §6**: the stale-file banner is a new pane-header state and
  needs a token-backed treatment (colors/spacing from `themes.css`, not
  ad-hoc) added to the design doc _before_ implementation, per this repo's
  UI-work process.
- **i18n**: banner copy + any new confirm-dialog copy for `close_pane` needs
  keys in both `en.json` and `pt-BR.json` in the same change (schema parity
  is a build-breaking gate).

## 7. Out of scope / explicitly deferred

- Live-reload for `memory`/`explorer` pane types.
- A "live buffer" pane that isn't file-backed.
- Any change to `close_pane`'s gate posture based on pane type (e.g. "silent
  for markdown-by-id, confirm for PTY-by-id") — the gate fields
  (`silentAllowInAgentFolder`, `alwaysAllowable`) are static per-verb in
  `plan-tool-call.ts`, not conditional per-call, so `close_file` (silent) and
  `close_pane` (always confirms) are two separate verbs by construction, not
  one verb with dynamic gating.
