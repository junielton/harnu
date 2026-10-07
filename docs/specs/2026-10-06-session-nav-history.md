# Session navigation history (back / forward)

- **Date:** 2026-10-06
- **Status:** draft, awaiting review
- **Scope:** renderer + application menu. No new MCP verb, so not agent-facing (`docs/harnu-features.md` stays untouched).

## 1. Problem

The only way to move between sessions is to click them in the sidebar (or use the palette).
The mouse's back/forward side buttons and the browser's `Alt+←` / `Alt+→` do nothing, so
"go back to the session I was just in" means finding its row again by hand.

## 2. Goal

Browser-style back/forward over the sessions you viewed, driven by:

- the mouse's **back / forward side buttons** (buttons 3 and 4), and
- the keyboard: **`Alt+←` / `Alt+→`** on Linux and Windows, **`⌘[` / `⌘]`** on macOS (see D-3).

It must work on Linux, macOS and Windows. Only Linux can be tested live by the maintainer
(see §8).

## 3. Non-goals

- Folder View and the takeovers (Board, PR Stack, Cleanup, Usage Dashboard, System Monitor)
  are **not** history entries. Only sessions are (D-1).
- No persistence. The history lives in memory and is empty after an app restart, like a
  fresh browser tab (D-2).
- No UI: no back/forward buttons in the Topbar, no history dropdown, no toast at the ends.
- No macOS trackpad swipe gesture.

## 4. Behaviour

The history is a list of session ids plus a cursor pointing at the session you are on.

| Situation                                                                                         | Result                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You open a session (sidebar, palette, approval row, board card, ⌘N, a fallback after closing one) | It is appended after the cursor; everything **ahead** of the cursor is dropped (forward history cleared). The cursor moves to it.                                                                 |
| You open the session already under the cursor                                                     | Nothing is recorded.                                                                                                                                                                              |
| **Back** while a session is on screen                                                             | The cursor moves to the previous entry and that session is shown.                                                                                                                                 |
| **Back** while the main pane is NOT showing a session (Folder View, or a takeover is open)        | The session under the cursor is shown again (takeover closed / Folder View left). The cursor does not move. A second **Back** then walks the history normally.                                    |
| **Forward**                                                                                       | The cursor moves to the next entry and that session is shown. Only possible after a Back.                                                                                                         |
| The target entry's session no longer exists (closed, deleted)                                     | It is skipped; the walk continues to the next live entry in that direction. Entries equal to the current session are skipped too, so a removed session never produces a "nothing happened" press. |
| No live entry in that direction                                                                   | No-op. No toast, no sound.                                                                                                                                                                        |
| More than **50** entries                                                                          | The oldest entry is dropped.                                                                                                                                                                      |
| A synthetic session gets its real id (`synthetic-…` → uuid)                                       | Every entry with the old id is rewritten to the new id.                                                                                                                                           |
| A modal / dialog / palette is open                                                                | No-op, same as every other global shortcut.                                                                                                                                                       |

Worked example: A → B → C, then open the Board.
Back → C (Board closes). Back → B. Back → A. Forward → B. Open D → history is A, B, D and
Forward is a no-op.

A hibernated (parked) session counts as live: navigating to it resumes it exactly like a
sidebar click.

## 5. Design

### 5.1 `src/renderer/src/lib/nav-history.ts` (new, pure)

No Vue, no store imports, fully unit-testable.

```ts
export interface NavHistory {
  /** Record a visit. No-op when `id` is already under the cursor. Truncates forward entries; caps at `max`. */
  push(id: string): void
  /** Move the cursor back to the nearest entry that `isLive` accepts and that differs from the current id. Returns the id, or null. */
  back(isLive: (id: string) => boolean): string | null
  forward(isLive: (id: string) => boolean): string | null
  /** The id under the cursor, or null when empty. */
  current(): string | null
  /** Rewrite every entry `from` → `to` (synthetic → real migration). */
  rename(from: string, to: string): void
}
export function createNavHistory(max = 50): NavHistory
```

### 5.2 `src/renderer/src/stores/sessions.ts`

- Own one `NavHistory` instance.
- **Recording:** one `watch(selectedId, …)` pushes every non-null value. This catches the
  user-intent path (`select()`) and the programmatic ones a user also experiences as
  navigation (spawn, close-fallback). Two writes are excluded:
  - back/forward themselves: a `navigating` flag suppresses the push while `goBack` /
    `goForward` write `selectedId`;
  - the synthetic → real migration: `fireMigrate` calls `history.rename(from, to)`, so by the
    time the (async) watcher sees the real id it already equals `current()` and is a no-op.
- **`goBack()` / `goForward()`** (new, exported):
  - liveness = the id exists in `allSessions`;
  - `goBack()` first checks whether the main pane shows a session
    (`selectedId !== null` and no takeover open). If it does not and `current()` is live, it
    shows `current()` without moving the cursor (§4, row 4);
  - otherwise it calls `history.back(isLive)` / `history.forward(isLive)` and, on a hit,
    shows that session through the same path as `select()` (closes takeovers, clears
    `selectedFolderPath`), with `navigating` set.

### 5.3 `src/main/menu.ts`

- Add `'nav.back' | 'nav.forward'` to `ShortcutActionId`.
- Two menu items (in the existing Session menu), emitting `shortcut:fired` like every other
  item:
  - accelerator `process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left'`, and likewise
    `'Cmd+]'` / `'Alt+Right'`.
- A menu accelerator is consumed before xterm sees the key (same reason `⌘B` lives there).

### 5.4 `src/renderer/src/App.vue`

- Two entries in the shortcut dispatch table (`id: 'nav.back' | 'nav.forward'`,
  `scope: 'global'`, handler → `sessions.goBack()` / `goForward()`), with a renderer `keys`
  fallback for window managers that drop accelerators, matching `view.toggleSidebar`.
- **Mouse:** a `window` listener in the **capture** phase (so it runs before xterm, which
  forwards mouse events to the PTY when the TUI enables mouse tracking):
  - `mouseup` with `button === 3` → back, `button === 4` → forward;
  - `preventDefault()` + `stopPropagation()` on `mousedown` / `mouseup` / `auxclick` for those
    two buttons, so the TUI never receives them;
  - skipped while a modal is open (same gate as global shortcuts);
  - removed on unmount.
- Electron's `app-command` (`browser-backward` / `browser-forward`, Windows + Linux) is
  deliberately **not** subscribed: Chromium already delivers the side buttons as DOM button
  3/4 events, and listening to both would fire twice.

## 6. Decisions

- **D-1 Only sessions are entries.** Folder View and takeovers are not (operator choice,
  2026-10-06). Back from one of them returns to the session you left (§4).
- **D-2 In memory only.** A restart starts with an empty history. Persisting buys "go back
  across a restart", which no browser offers per tab either.
- **D-3 Keyboard.** `Alt+←` / `Alt+→` on Linux and Windows (the browser convention there).
  On macOS the browser convention is `⌘[` / `⌘]`; `⌥←` is word-jump in every macOS text
  field. Mouse-vendor tools (e.g. Logi Options+) also map the side buttons to `⌘[` / `⌘]` on
  macOS, so that binding doubles as a mouse fallback there.
- **D-4 Accepted trade-off: `Alt+←` / `Alt+→` no longer reach the terminal.** In a shell or
  the Claude TUI those chords are word-left / word-right; the menu accelerator takes them.
  `Ctrl+←` / `Ctrl+→` usually do the same word-jump and are unaffected. Operator choice,
  2026-10-06.
- **D-5 Cap of 50 entries.** Enough for a working day of hopping; memory cost is trivial.

## 7. Files touched

| File                                           | Change                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/renderer/src/lib/nav-history.ts`          | new — pure history                                                                     |
| `tests/nav-history.test.ts`                    | new — unit tests (§8)                                                                  |
| `src/renderer/src/stores/sessions.ts`          | instance, watcher, rename in `fireMigrate`, `goBack` / `goForward`                     |
| `src/main/menu.ts`                             | two action ids + two menu items                                                        |
| `src/renderer/src/App.vue`                     | two dispatch-table entries + mouse listener                                            |
| `design.md`                                    | two rows in the shortcut table (§ Keyboard shortcuts) + the mouse buttons              |
| `CHANGELOG.md`                                 | `### Added` entry                                                                      |
| `docs/user/sessions.md`                        | "Going back and forward" section                                                       |
| `src/renderer/src/i18n/en.json` + `pt-BR.json` | only if the command palette lists shortcut actions; then both files in the same change |

## 8. Testing

**Unit (`tests/nav-history.test.ts`):** push / back / forward; push after back truncates
forward; same-id push is a no-op; cap drops the oldest and keeps the cursor right; back /
forward skip dead entries and entries equal to the current id; ends return null; `rename`
rewrites every occurrence; an empty history returns null everywhere.

**Live, Linux (second isolated instance, `docs/dev/live-verify-second-instance.md`):**

1. Open A → B → C; Back ×2 lands on A; Forward lands on B.
2. Open the Board and Folder View in turn; Back returns to the session you left.
3. Close B, then Back from C skips B.
4. A new session (⌘N) migrates synthetic → real; Back / Forward still reach it.
5. Mouse side buttons drive the same steps, including with the terminal focused and the
   Claude TUI running (no stray input reaches the TUI).
6. `Alt+←` with the terminal focused navigates, and does not flash the auto-hidden menu bar.
7. With a dialog open, neither key nor mouse navigates.

**macOS / Windows (not testable by the maintainer):** covered by the unit tests plus the
platform reasoning in §5.3–5.4. The CHANGELOG entry and the PR body state plainly that macOS
and Windows were not verified live, so the first user report on those platforms is the
check. Known residual risks:

- Windows: if a mouse driver turns the side buttons into `app-command` only (no DOM button
  3/4), the mouse will not navigate; the keyboard still will.
- macOS: mice whose side buttons are not exposed as buttons 3/4 rely on the vendor tool's
  `⌘[` / `⌘]` mapping (D-3).

## 9. Acceptance criteria

- **AC-1** Back / Forward walk the sessions you viewed, browser-style, per §4.
- **AC-2** From Folder View or a takeover, the first Back returns to the session you left.
- **AC-3** Closed or deleted sessions are skipped; the ends are silent no-ops.
- **AC-4** A synthetic session stays reachable after it gets its real id.
- **AC-5** Mouse buttons 3/4 and `Alt+←/→` (Linux/Windows) / `⌘[`/`⌘]` (macOS) trigger it, with
  the terminal focused or not; nothing reaches the TUI.
- **AC-6** Nothing navigates while a modal is open.
- **AC-7** The history holds at most 50 entries and is empty after a restart.
- **AC-8** `npm run typecheck`, `npm run build` and the unit tests pass; CHANGELOG,
  `docs/user/sessions.md` and `design.md` are updated.
