# Fleet rail

The right rail is Harnu's fleet-wide status column: **what the fleet is doing right now**, stacked above **what's waiting on your say-so**. When a Claude session (or any agent acting through Harnu's [control server](agent-control.md)) wants to do something that changes state — start a session, create a worktree, write to project memory, move a roadmap card into dispatch — that action needs your approval before it runs, and the rail is where that happens: one place for every pending decision, instead of prompts scattered across whichever terminal happens to be open.

The same rail is also where Harnu's optional **hook interceptor** surfaces decisions — see [Intercepting Claude Code's own prompts](#intercepting-claude-codes-own-prompts) below if you've turned that on in Settings.

## The rail

The rail lives as a permanent column on the right edge of the window — it's not a popup you open and lose track of. It has three states: **expanded** (the full panel), **minimized** (a thin strip), and **hidden**. `Cmd/Ctrl+Shift+A` toggles between expanded and minimized.

**Minimized still shows you the whole fleet.** The thin strip isn't just an icon and a counter — it stacks one small card per active session, each carrying the same state ring you'd see on the full card, in the same priority order. So you can shrink the rail to reclaim the width and still answer "is anything stuck?" at a glance. Hover any of them for the same preview you get from a full card; click to jump to that session, right-click for its menu.

Because of that, **Harnu no longer forces the rail open when something arrives.** It used to — back when minimizing hid everything, an incoming approval would pop the panel open so you couldn't miss it. Now that the strip keeps showing the fleet and the counter, that would just be an interruption: if you put the rail away, it stays away until you bring it back. You still get the sound and the system notification, and the counter still ticks up — and clicking that notification does open the rail, because that's you asking for it.

Inside, top to bottom:

- **Fleet** — the scrolling body: every session that needs input, has errored, is stuck, or is working, plus recently finished ones. Idle sessions aren't shown — a quiet fleet just means a short list. There are no state labels; a small **ring** on the left of each card tells you the state (a bright edge orbiting a faint circle while working, a breathing amber ring when it needs you, a broken red ring — two arcs with gaps — when it's stuck, a solid still red ring when it's errored, a quiet green ring when it's done). The ones that are still are still on purpose: a session that stopped shouldn't look like one that's running. Cards are ordered so nothing that needs attention can ever be pushed down by something that's merely working, and inside each group the cards stay in the order the sessions were created — newest on top — so activity never makes the list jump. The arrow button in the header (next to the state filter) flips every group to oldest first, and Harnu remembers your choice.

  A card goes **stuck** for one of two reasons, and the card's second line tells you which: either its transcript has gone quiet for a few minutes, or — even while it's still actively writing — it's stuck repeating itself: the same failing command, or the same file read, over and over with no edit in between. In that second case the card's second line names what's repeating and how many times (e.g. "repeating Bash: npm test ×10"), and its "last active" time can still read as recent — that's expected, not a bug: the session is genuinely alive, just going nowhere. Either way the action is the same — go look at it — which is why it's still just `stuck`, not a separate state.

  A filter icon in the header lets you hide any of the five states — handy for hiding `done` once it's piled up and pushed the sessions you're actually watching below the fold. Click it for a popover listing each state with a live count and a toggle (it also works as a legend, in case you forget what a given ring means); your choice is remembered across restarts. This is deliberately **not** a safety-relevant filter: hiding a state only removes it from the scrolling list. The count badge on the rail's header and its minimized strip always reflect every session that needs input, has errored, or is stuck, no matter what's hidden — and if the active filter is hiding any of those, a warning strip appears above the list telling you how many and offering a one-click way to show everything again.

- **Needs you** — the actionable queue: things waiting on an Allow or Deny. A collapsible section, open by default; it disappears entirely when there's nothing pending.
- **Would-have** — a read-only, collapsed-by-default diagnostic log. This isn't a record of what was auto-allowed; it's the hook interceptor's **shadow log** — a trace of decisions Harnu computed but deliberately did not apply, so you can preview what turning on interception would actually do before you commit to it. See below.

They're stacked, not tabbed, on purpose — an urgent item can never hide behind a tab you didn't happen to have selected.

## Reviewing a pending item

Most tool calls show as a simple row: what folder/session it's from, a short technical summary of the call, and **Allow** / **Deny**.

A confirm that's been parked from a live session (because you weren't looking at its window when it needed you) expands into more detail: the exact prompt, any shell command it wants to run, its permission mode, and any non-default flags — reviewed before you decide, not after. This kind of row can also carry:

- An **"always allow this verb here"** checkbox. Checking it makes that specific verb (e.g. `create_worktree`) run without asking again, for that folder only, from then on — persisted so it survives a restart. It's unchecked by default for the more consequential verbs.
- A **dispatch checklist**, when a session has proposed a batch of roadmap cards to run (a "manifest"). Every card starts checked; you can uncheck individual ones before approving — unchecked cards are simply left alone, not denied — and adjust where each one runs (a plain session, a fresh worktree, etc.) before you commit to the batch.

If a session's window is focused when it needs a decision, you'll see the same information in a blocking dialog instead of the rail — it can't be dismissed by clicking away or pressing Escape; only Allow, Deny, or letting its deadline lapse (which auto-denies it) closes it.

## Activity bell

The notification history used to live as a section inside the rail; it now lives in a bell icon in the top bar, next to the session title — reachable even when you don't have a session selected, since the history isn't tied to any one folder. The bell shows a count badge when there's anything in the list; clicking it opens a popover with every notification, newest first.

Each row shows a short title (and sometimes a longer description) with a colored bar on the left marking its kind — success, warning, danger, or a plain info notice. If a session posted the notice itself, it's marked "Session says." Short text always shows in full; if it's long enough to need clamping, you'll always see an expand arrow rather than text quietly getting cut off.

Clicking a row jumps to the session it's about — revealing and scrolling to it in the sidebar, not just switching tabs — and removes it from the list. Hovering a row swaps its timestamp for a small × so you can clear it without navigating anywhere, and "Clear all" empties the whole list from the popover's header. There's no read/unread state to track — being in the list is the only signal; once you've dealt with a notice (or just don't need it anymore), dismissing it is the only action.

## Mission grants

Rather than approving a fan-out one call at a time (say, a session creating five worktrees in a row), a session can ask for a **mission grant**: a single approval that covers a specific goal, a set of folders, a specific list of verbs, a budget (how many actions it covers), and a time limit. Approve it once, and every matching action within that scope runs without a further prompt until the budget or the timer runs out — anything outside that scope still asks normally. While a grant is live, the rail shows a small strip above the queue with its goal, how much of the budget is left, minutes remaining, and a **Revoke** button if you want to cut it short early.

## Intercepting Claude Code's own prompts

Separately from Harnu's own control-server verbs, Harnu can optionally act as a responder for Claude Code's _native_ permission hooks — the same prompts you'd otherwise see asking whether a tool call is allowed. This is configured in **Settings → Interceptor** and has three modes:

- **Off** — Harnu doesn't touch Claude Code's own prompts at all (the default).
- **Shadow** — Harnu computes what it _would_ decide, but never actually acts on it — every decision goes to the "Would-have" shadow log instead, so you can see how it would have behaved with zero risk of it getting something wrong. This is the safe way to try it out.
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
