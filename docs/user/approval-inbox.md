# Approvals

When a Claude session (or any agent acting through Harnu's [control server](agent-control.md)) wants to do something that changes state — start a session, create a worktree, write to project memory, move a roadmap card into dispatch — and that action needs your approval, it waits for you in **Needs you**, at the bottom of the sidebar: one place for every pending decision, instead of prompts scattered across whichever terminal happens to be open.

Harnu's optional **hook interceptor** parks its decisions in the same place — see [Intercepting Claude Code's own prompts](#intercepting-claude-codes-own-prompts) below if you've turned that on in Settings.

## Needs you

**Needs you** sits above **Add folder**. It shows only while something is waiting, and it starts folded: one line with the number of pending items and how long the oldest has been waiting. Click it to open the list; the list scrolls inside its own box when it is long. Each request shows the whole command it is asking about, never shortened, with Allow and Deny under it. It never opens by itself. A new request plays its sound and raises a system notification and the number goes up, but nothing on screen moves until you ask.

Three things open it, and each one also expands the sidebar if you had collapsed it:

- clicking the system notification,
- `Cmd/Ctrl+Shift+A` (press it again to fold the section),
- **Open approvals** in the command palette.

With the sidebar collapsed there is nothing new on the screen besides the Activity bell, the system notification and the count in the window title.

## What else tells you about the fleet

There is no separate status column. The sidebar tree says it: a ring on each folder, a dot on each session and a coloured bar beside a working checkout (see [Folders and worktrees](folders-and-worktrees.md)). Sessions that need your input or have failed are also gathered in **Needs attention**, pinned above the folder list (see [Sessions](sessions.md#needs-attention)).

## Reviewing a pending item

Most tool calls show as a simple row: what folder/session it's from, a short technical summary of the call, and **Allow** / **Deny**.

A confirm that's been parked from a live session (because you weren't looking at its window when it needed you) expands into more detail: the exact prompt, any shell command it wants to run, its permission mode, and any non-default flags — reviewed before you decide, not after. This kind of row can also carry:

- An **"always allow this verb here"** checkbox. Checking it makes that specific verb (e.g. `create_worktree`) run without asking again, for that folder only, from then on — persisted so it survives a restart. It's unchecked by default for the more consequential verbs.
- A **dispatch checklist**, when a session has proposed a batch of roadmap cards to run (a "manifest"). Every card starts checked; you can uncheck individual ones before approving — unchecked cards are simply left alone, not denied — and adjust where each one runs (a plain session, a fresh worktree, etc.) before you commit to the batch.

If a session's window is focused when it needs a decision, you'll see the same information in a blocking dialog instead of Needs you — it can't be dismissed by clicking away or pressing Escape; only Allow, Deny, or letting its deadline lapse (which auto-denies it) closes it.

## Activity bell

The notification history lives in a bell icon in the top bar, next to the session title — reachable even when you don't have a session selected, since the history isn't tied to any one folder. The bell shows a count badge when there's anything in the list; clicking it opens a popover with every notification, newest first.

Each row shows a short title (and sometimes a longer description) with a colored bar on the left marking its kind — success, warning, danger, or a plain info notice. If a session posted the notice itself, it's marked "Session says." Short text always shows in full; if it's long enough to need clamping, you'll always see an expand arrow rather than text quietly getting cut off.

When the same piece of work reports again, the bell doesn't pile up rows. If a session tied to a mission step or a roadmap card finishes, or needs you, a second time within 10 minutes of the last notice of that kind, Harnu keeps the one row, moves it to the newest time and adds a small "already reported · ×N" line under it. A different step or card, a different kind of notice (finished versus needs your input), or a repeat after more than 10 minutes gets its own row, and a session that isn't linked to any step or card is never folded. Dismissing a folded row removes it entirely; the next notice starts a fresh one. The toast and the OS notification still appear each time — only the history is tidied.

Clicking a row jumps to the session it's about — revealing and scrolling to it in the sidebar, not just switching tabs — and removes it from the list. Hovering a row swaps its timestamp for a small × so you can clear it without navigating anywhere, and "Clear all" empties the whole list from the popover's header. There's no read/unread state to track — being in the list is the only signal; once you've dealt with a notice (or just don't need it anymore), dismissing it is the only action.

## Mission grants

Rather than approving a fan-out one call at a time (say, a session creating five worktrees in a row), a session can ask for a **mission grant**: a single approval that covers a specific goal, a set of folders, a specific list of verbs, a budget (how many actions it covers), and a time limit. Approve it once, and every matching action within that scope runs without a further prompt until the budget or the timer runs out — anything outside that scope still asks normally. Live grants are listed in **Settings → MCP**, each with its goal, how much of the budget is left, the minutes remaining and a **Revoke** button if you want to cut it short early.

## Intercepting Claude Code's own prompts

Separately from Harnu's own control-server verbs, Harnu can optionally act as a responder for Claude Code's _native_ permission hooks — the same prompts you'd otherwise see asking whether a tool call is allowed. This is configured in **Settings → Interceptor** and has three modes:

- **Off** — Harnu doesn't touch Claude Code's own prompts at all (the default).
- **Shadow** — Harnu computes what it _would_ decide, but never actually acts on it — every decision is written to a shadow log instead. This is the safe way to try it out. The screen that showed that log was part of the removed status column; Harnu keeps recording it, and a view for it will come back in Settings.
- **Active** — Harnu actually starts allowing/denying, but only for folders you've explicitly put "on the ramp" (or for every folder, if you flip the "Trust all folders" switch). A folder that's active but not on the ramp still only gets previewed, never acted on — Harnu never blocks a call it can't confidently attribute to a trusted folder.

In other words: the interceptor is a separate, opt-in layer on top of Claude Code's own permission system, with its own confidence ramp (shadow first, then active per-folder, then trust-all) — it's not required for, and doesn't change, how the [MCP control-server](agent-control.md) approvals above work.

## Sessions you start in your own terminal

A session you started outside Harnu is **not** held in the Inbox. With **Harnu mod outside
Harnu** on ([Mods](mods.md#harnu-mod-outside-harnu)), the native permission dialog in that
terminal and any Claude Code hook behave exactly as they did before; the Inbox is not a gate
for them. The one exception is a folder you have already put **on the ramp** (Settings →
Interceptor): there Harnu's interceptor parks the call whoever started the session, the
dialog in the terminal stays usable, the first answer wins, and the Inbox row says **outside
Harnu**. If Harnu is not running, the session is unaffected.

## Where this fits together

The Approval Inbox is the human side of the gate described in more detail in [Agent control](agent-control.md) — that page explains what a session can actually do and why each action is or isn't gated; this page is about how you act on what it's asking for.
