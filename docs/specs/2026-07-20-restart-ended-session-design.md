# Design: show "Restart session" for ended real sessions

Date: 2026-07-20
Status: Approved

## Problem

The "Restart session" context-menu item (`SessionMenu.vue`) is only shown while
a session's PTY is still running (`isLive === true`). The moment a real
(disk-backed, non-synthetic) session's process exits, `isLive` flips to
`false` and the item disappears — even though the underlying restart
mechanism (`sessions.reloadSession` → `registerReloadHandler` in
`TerminalPane.vue`, which disposes the dead `LiveTerminal` and respawns a
fresh `claude --resume <uuid>` PTY) works correctly and needs no live process
to invoke.

Root cause chain (confirmed by reading the code, not assumed):

- `TerminalPane.vue`'s `onPtyExit` handler sets `live.dead = true`, calls
  `sessions.unregisterLiveSession()` (which flips `isSessionLive()` to
  `false` immediately), and marks `taskState` via `markSessionExited()` — but
  it never deletes the entry from the module-level `liveTerminals` cache.
- `SessionMenu.vue`'s `entries` computed hides the `'restart'` entry whenever
  `!isLive`, on the assumption (stated in a comment) that "selecting it
  starts it fresh anyway." That assumption is false for a session whose
  `LiveTerminal` is still cached (dead): `activate()`'s reuse branch only
  disposes-and-recreates a dead cached entry for **synthetic** sessions; for
  a real session it just re-attaches the same dead terminal
  (`attachLiveTerminal()`, which never calls `ptyCreate`).
- The one thing that _does_ correctly dispose the dead entry and respawn a
  fresh PTY is `sessions.reloadSession()`, wired only to the `'restart'` menu
  item — which is hidden exactly when it's needed.

Today the only workaround is toggling "Enable remote control" on the dead
session, which incidentally forces a fresh PTY to spawn. That's a workaround,
not a feature.

Synthetic sessions already have their own recovery affordance (Retry/Dismiss,
gated on `taskState === 'failed' | 'completed'`) and are out of scope here —
this spec covers real, disk-backed sessions only.

## Design

### 1. `SessionMenu.vue` — extend "Restart session" visibility

The existing gate (only reached once we know the session is not synthetic):

```js
if (!isLive) return all.filter((e) => e.id !== 'restart')
return all
```

becomes:

```js
const taskState = targetSession.value?.taskState
const hasEnded = taskState === 'failed' || taskState === 'completed'
if (!isLive && !hasEnded) return all.filter((e) => e.id !== 'restart')
return all
```

The item keeps its current label ("Restart session", `t('actions.restart')`)
in both the live and the ended case — no new i18n key. The underlying action
is conceptually the same either way: dispose whatever PTY exists (if any) and
spawn a fresh one.

A dormant, never-opened-this-run disk session (no `taskState` set yet) still
does not get the item — for that case, plain selection already spawns fresh
via `activate()`'s create path, so no explicit affordance is needed.

### 2. `TerminalPane.vue` — harden the reload handler

Current handler no-ops (silently, with a misleading success toast still fired
by the caller) when the session was never cached in `liveTerminals` during
this app run:

```js
const offReload = sessions.registerReloadHandler(async (sessionId: string) => {
  const live = liveTerminals.get(sessionId)
  if (!live) return
  const wasAttached = attachedId === sessionId
  if (wasAttached) attachedId = null
  disposeLiveTerminal(live)
  liveTerminals.delete(sessionId)
  if (wasAttached && sessions.selectedId === sessionId) {
    await activate(sessionId)
  }
})
```

New version drops the early-return so the currently-attached case always
resolves to a fresh spawn, regardless of whether a cached (possibly dead)
entry existed:

```js
const offReload = sessions.registerReloadHandler(async (sessionId: string) => {
  const live = liveTerminals.get(sessionId)
  const wasAttached = attachedId === sessionId
  if (live) {
    if (wasAttached) attachedId = null
    disposeLiveTerminal(live)
    liveTerminals.delete(sessionId)
  }
  if (wasAttached && sessions.selectedId === sessionId) {
    await activate(sessionId)
  }
})
```

Behavior for a live session (the existing, already-shipped case) is
unchanged. Behavior for a non-attached session is unchanged (lazy respawn on
next selection, same as today). The only behavior change is: an
ended-and-currently-viewed session with no cached `liveTerminals` entry now
actually spawns a fresh PTY instead of silently doing nothing.

## Out of scope

- Synthetic sessions' Retry/Dismiss flow — untouched.
- Any change to the "Enable remote control" feature — the workaround simply
  becomes unnecessary for this case, the feature itself is not touched.
- Changing the restart label/copy based on live-vs-ended state (considered,
  rejected — same label in both cases, per user preference).
- A restart affordance directly inside the terminal pane (e.g. a clickable
  hint under `[session ended]`) — considered, rejected in favor of the
  existing context-menu-only pattern.

## Testing / verification

- Existing unit tests (if any) covering `SessionMenu.vue`'s `entries`
  computed should be extended to cover: real session + `isLive=false` +
  `taskState='failed'` → `'restart'` present; real session + `isLive=false`
  - `taskState=undefined` → `'restart'` absent (unchanged case).
- Manual live-app verification per `docs/dev/live-verify-second-instance.md`:
  start a real session, let the underlying `claude` process exit naturally
  (e.g. it finishes or is killed), confirm `[session ended]` appears, confirm
  "Restart session" now appears in the context menu, click it, confirm a
  fresh `claude --resume` PTY spawns and the terminal becomes interactive
  again — without needing to toggle remote control.

## Changelog

A `CHANGELOG.md` entry is required (per repo convention) under `### Fixed`:
the "Restart session" menu item now appears for ended sessions, not only
live ones.
