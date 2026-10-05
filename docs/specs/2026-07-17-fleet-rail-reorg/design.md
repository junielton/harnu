# Fleet rail reorg — design

Date: 2026-07-17 · Status: approved in brainstorming, pending operator review of this doc
Owner: operator (Junielton) + orchestration session

## 1. Problem

Three attention surfaces overlap and none of them does its job well:

- The **Fleet status board** lives behind a sidebar toggle (Folder view ⇄ Board). It buries
  the useful signal (working / stuck / errored / needs input) under a wall of idle sessions,
  and it competes with the folder tree for the same screen slot.
- The **Inbox rail** (4th column, T83 S0/S1) mixes genuinely blocking approvals ("Needs you")
  with a high-volume Activity history and an auto-approved "Would have" log. The flood of
  auto-handled rows steals attention from the few things that actually need a human.
- **Activity rows are a dead list.** "Session completed" rows don't navigate to the session
  (the "Go to session" button calls `sessions.select()` instead of `activateSession()` —
  the open BUG-31 symptom), and nothing ever leaves the list except by silent prune.

## 2. Decisions (made 2026-07-17 with the operator)

1. **The Fleet panel takes over the right rail.** `InboxRail.vue` is converted in place
   (approach A) into a Fleet rail; the rail's state machine, summon behavior, width
   persistence, and overlay-mutex exclusion are preserved as-is.
2. **Idle is never rendered in the rail. Done/return-here is.** Buckets shown, in the
   existing urgency order: needs-input → errored → stuck → working → done/return-here.
   Empty buckets collapse away (current `buildBoard` behavior).
   2a. **No state labels — the ordering rule replaces them.** The bucket eyebrow labels
   are removed; a card's state is carried by its dot + border animation. The list is
   one continuous, strictly-tiered column:
   - **Strict tiers:** needs-input → errored → stuck → working → done. A lower tier
     NEVER renders above a higher one — the anti-flood invariant: a newly-active
     working session can never push above anything needing attention.
   - **Within the attention tiers** (needs-input / errored / stuck): oldest-waiting
     first — the most neglected surfaces on top (against `buildBoard`'s current
     `modified` desc, this flips those tiers to ascending time-in-state).
   - **Within working / done:** most-recent first (recency desc, unchanged).
   - A newly-arriving card animates in (slide from the right, 1560ms ease-out) at its
     sorted position, never the absolute top.
     2b. **Needs-you and Would-have are collapsible sections pinned BELOW the fleet.** The
     fleet is the scrolling body; both sections sit at the bottom (needs-you default
     open with `max-height` + internal scroll, would-have default closed), each with a
     chevron and an animated open/close (grid-rows `1fr↔0fr`).
3. **The left-sidebar board dies.** The Folder/Board toggle and the left `FleetBoard.vue`
   view are removed; the sidebar is folders-only. `⌘⇧B` re-targets the Fleet rail toggle.
4. **Activity moves to a topbar notification bell.** Global (not gated on a selected
   session), badge = item count, popover lists the history. Click = navigate via
   `activateSession()` + the row is removed. No read/unread state: `dismiss(id)` +
   `clearAll()` replace `markRead`. Passive expiry (200 items / 7 days) stays.
5. **"Would have" stays in the rail but collapsed** — header + count only, never
   auto-expands, never triggers rail summon.
6. **Summon narrows to real approvals.** The rail auto-expands only on a rising edge of
   Needs-you (parked MCP confirms, hook approvals). Fleet-state transitions (a session
   turning stuck/errored) surface through the bell/notifications, not by moving layout.

## 3. Architecture after the reorg

```
┌─────────┬──────────────────────────┬───────────┬────────────┐
│ Sidebar │  Main (terminal)         │ Helper    │ Fleet rail │
│ folders │  Topbar: … [bell][acts]  │ stack     │ Needs you  │
│ only    │                          │ per-      │ Fleet      │
│         │                          │ worktree  │ Would-have │
└─────────┴──────────────────────────┴───────────┴────────────┘
```

- **Sidebar** — folder tree only. `sidebarView` state and its persistence are removed
  (with a one-time migration for stored `'board'` values → `'folders'`).
- **Fleet rail** — sections top to bottom: _Needs you_ (pinned, `flex: 0 0 auto`,
  never scrolls out) → fleet buckets (scrolling body) → _Would-have_ (collapsed footer).
  All-idle fleet renders the "You're all caught up" empty state + the collapsed footer.
- **Bell** — in the Topbar right cluster but outside the `v-if="sessions.selectedSession"`
  guard. Popover anchored to it; rows reuse the approved BUG-36/BUG-42 row anatomy
  (inner 2px kind-bar, "Session says" eyebrow for `source: 'agent'`).
- **Helper stack** — untouched.

## 4. Data & code reuse (no new heuristics)

- Classification: `stores/fleet-state.ts` (`classifyFleetState`, `resolveActivity`) and
  `components/fleet-board.ts` (`buildBoard`, urgency order) are consumed unchanged via
  `sessions.boardBuckets`. The rail is a projection, exactly like the old board view.
- Cards: `FleetBoardCard.vue` reused with layout tweaks defined by the approved mockup.
  Card click = `sessions.activateSession()`.
- Notifications: `stores/notifications.ts` remains the single history sink. Store API
  change: `markRead(id)` → `dismiss(id)` (removes) + `clearAll()`; `read` field dropped
  from `NotificationRecord` (migration: ignore the field on load).
- Navigation: every "go to session" affordance (bell rows, fleet cards) goes through
  `sessions.activateSession()` — closing BUG-31 wherever it still calls `select()`.
- OS notifications, toasts, sounds: unchanged. The bell changes where history lives,
  not how events are delivered.

## 4a. Approved mockups (2026-07-17)

Both mockups are approved contracts — implementation follows them 1:1:

- **Fleet rail** — `docs/specs/2026-07-17-fleet-rail/spec.html` (`status: approved`).
  Captures: no state labels; strict-tier ordering with anti-flood; Needs-you +
  Would-have as collapsible sections pinned below the fleet; 8px card inset + 6px
  top padding; per-state border motion (working=travelling green glint,
  needs-input=breathing amber, stuck=marching red dashes, errored=still red ring,
  **done=still green ring + green check**); the entrance (whole card fades + slides
  22px from the right as one unit, 620ms; border ring held until after entry then
  fades in over 900ms); `overflow-x: hidden` + `scrollbar-gutter: stable` +
  `.scrollable` scrollbar so a new card never shifts the list.
- **Activity bell** — `docs/specs/2026-07-17-activity-bell/spec.html`
  (`status: approved`). Captures: topbar bell + count badge; anchored dropdown
  popover; rows with the BUG-36/42 kind-bar anatomy; **no notification text ever
  lost** (short shows in full, long clamps to 2 lines _only_ with an expand
  chevron); optional per-row action buttons; row click → `activateSession` +
  remove; hover → dismiss ×; Clear all.

**Deferred sub-decision (does NOT block card C):** whether the "text-never-lost"
chevron rule also applies to the fleet _cards_ (title/pulse today truncate to one
line). Default for now: keep the current one-line truncation on rail cards; revisit
after C ships if it reads cramped.

## 5. Work breakdown (specs + mockups before any product code)

| #   | Card                                                                                              | Kind    | Depends on |
| --- | ------------------------------------------------------------------------------------------------- | ------- | ---------- |
| 0   | Land/coordinate open PRs #107 + #110 (both touch `InboxRail.vue`)                                 | chore   | —          |
| A   | Mockup: Fleet rail (dtk:create-mockup → approved spec.html)                                       | scout   | —          |
| B   | Mockup: topbar bell + Activity popover                                                            | scout   | —          |
| C   | Convert InboxRail → FleetRail (fleet buckets, idle hidden, summon narrowed, Would-have collapsed) | feature | 0, A       |
| D   | Bell + Activity migration out of the rail + dismiss model + BUG-31 fix                            | feature | B, C       |
| E   | Remove left FleetBoard + sidebar toggle; re-target `⌘⇧B`                                          | chore   | C          |

Sequencing invariants:

- Activity leaves the rail only in **D**, when the bell already exists — no window
  without a visible history.
- Mockups A and B can run in parallel; C → D → E are sequential (same files).
- Every implementation PR carries the repo contracts: `design.md` §6 updated in the same
  change, i18n parity (`en.json` + `pt-BR.json`), `CHANGELOG.md`, `docs/user/` updates
  (rail and bell are user-visible). `docs/capy-features.md` is NOT touched — nothing
  agent-facing changes (the `notify` verb's ACK and semantics stay identical; only where
  the operator reads the history moves).

## 6. Out of scope

- Any change to fleet-state heuristics or thresholds (`STUCK_AFTER_MS` etc.).
- Approval row internals (BUG-36/BUG-42 anatomy is reused, not redesigned).
- Helper stack / pane registry work (T121 family).
- Remote/push notification channels.
- Unifying the helper stack with the rail (explicitly discussed and deferred — the helper
  stack is per-worktree and hosts PTYs; the rail is fleet-global. Different lifecycles.)

## 7. Risks & mitigations

- **In-flight PRs #107/#110** rewrite the same rail file. Mitigation: card 0 lands them
  first; C rebases on top.
- **Summon narrowing** could hide a blocked session if its only signal was an Activity
  row. Mitigation: needs-input sessions still render as the top fleet bucket with the
  badge on the minimized strip; OS/toast channels are unchanged.
- **Dropping read/unread** loses "seen but kept" semantics. Accepted: the operator's
  model is "in the list = not yet handled"; passive prune covers abandonment.
- **`⌘⇧B` muscle memory** now opens a different surface. Accepted: it opens the same
  information in its new home.
