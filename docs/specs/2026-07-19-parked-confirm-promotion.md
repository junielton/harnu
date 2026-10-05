# A parked confirm promotes to the modal when the operator returns

**Date:** 2026-07-19
**Card:** `bug-32-a-parked-confirm-waits-in-silence-a-blocking-gate-must-su`
**Status:** design approved, not implemented

## Problem

An orchestration session called `submit_manifest` and got back
`{"status":"pending","approvalId":"confirm-7","message":"Parked in the Approval
Inbox — the operator was away. It will actuate when they Allow."}`. Nothing
popped. The operator was in the app the whole time, on another screen. The confirm
sat in the Inbox and **the dispatched work stayed frozen** until they happened to
look.

A confirm is a **blocking gate**: an agent is stopped mid-mission waiting on it.
Parking it behind a surface the operator must remember to visit inverts the cost —
the machine is idle and the human doesn't know.

## Root cause — verified, and it is not what the card guessed

The card asked the executor to first answer _"the sound/attention card shipped, so
why did this land silently?"_ and offered three hypotheses. The answer is the third,
and it narrows the fix considerably:

- **Sound and OS attention DO fire on the parked path.** `addParkedConfirm`
  (`src/renderer/src/stores/session-mcp-confirms.ts:69-86`) unconditionally calls
  `playNotificationSound()`, `window.api.requestAttention()`, `window.api.notify(…)`
  and `window.api.pushSend(…)`, never gated on notify prefs. That card did not
  regress and does cover this path.
- **The overlay already renders above every screen.** `McpConfirmOverlay` is mounted
  at `src/renderer/src/App.vue:791`, a root-level sibling of every takeover view
  (`CleanupView` / `UsageDashboard` / `SystemMonitor` at `:695-697`) and of
  `SettingsDialog` (`:780`). It is not nested inside any screen. Nothing about the
  active screen prevents it from showing.
- **The actual defect: a parked confirm is never routed to the overlay, ever.**
  `confirm-core.ts:369` stamps the mode once, at park time:
  `const mode: 'modal' | 'parked' = deps.isFocused?.() ? 'modal' : 'parked'`, where
  `isFocused` is `win.isFocused()` (`confirm-resolver.ts:62-64`). If the OS window
  was unfocused for the instant the confirm arrived, the confirm is `parked`
  **permanently**. `addParkedConfirm` early-returns on `p.mode !== 'parked'`
  (`session-mcp-confirms.ts:63`), and its sibling — the overlay — only ever sees
  `modal`. There is no promotion path. The operator's return is not an event
  anything listens to.

So the card's framing ("the modal can't reach every screen") is wrong; the correct
framing is **"parked confirms are routed away from the modal forever, including
after the operator comes back."** That makes this a small, well-bounded fix rather
than a re-architecture of the overlay.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **On window focus regain, every still-pending parked confirm promotes to modal.** Main listens for the window `'focus'` event and re-emits each live parked confirm with `mode: 'modal'`; the overlay picks them up and renders, over whatever screen is active.                                |
| D2  | Promotion is **idempotent and re-entrant**. Promoting removes the confirm from the parked queue and hands it to the overlay; a second focus event with nothing pending is a no-op. Settled confirms are never re-emitted (the existing `pending` map in `confirm-core` is the source of truth). |
| D3  | **Dismissing the promoted modal returns it to parked/Inbox — it never denies.** Dismissal is "not now", not "no". The confirm keeps its id, its TTL continues to run, and it reappears in the Inbox "Needs you" tab. A verdict is only ever produced by an explicit Allow or Deny.              |
| D4  | A dismissed confirm **does not re-promote on the next focus event** within the same focus session — otherwise dismissal is unusable. It re-promotes only after a subsequent blur → focus cycle. Track a per-confirm `dismissedAtFocusEpoch`; a monotonic counter incremented on each blur.      |
| D5  | Multiple pending confirms promote as a **queue, one modal at a time**, in park order. The overlay already renders one confirm; answering or dismissing the front one surfaces the next. No stacked modals.                                                                                      |
| D6  | **The agent-facing park ACK contract is UNCHANGED.** See the scoping note below.                                                                                                                                                                                                                |

### Scoping decision — no ADR, no `capy-features.md` bump

The card warns that `docs/capy-features.md` documents the parked-confirm contract to
agents (`"Parked in the Approval Inbox — the operator was away"` plus the
`get_approval` poll loop) and that changing it forces a marker bump and CI gate.

**This spec deliberately changes nothing an agent can observe.** The ACK an agent
receives on park is byte-identical (`src/main/mcp/server.ts:999`), `get_approval`
still returns `pending` → `allowed`/`denied`, the TTL is untouched, and a promoted
confirm that the operator dismisses stays `pending` exactly as before. Promotion is
purely operator-side surfacing: the agent's world model — "I parked, I poll, I get a
verdict eventually" — remains true in every case.

Therefore: **no `docs/capy-features.md` edit, no version-marker bump, no ADR.** This
is a bugfix restoring the intended behavior of an existing mechanism, not an
architectural decision. If a future change did alter the ACK or the TTL semantics,
that would need its own ADR — this spec does not license it.

`design.md` needs no new component either: `McpConfirmOverlay` is an existing §6
component being reused as-is, in a state it already renders.

## Reconciliation with neighbouring work

- **`approval-inbox-is-too-easy-to-forget-…` (status: done).** Shipped and correct;
  its sound + OS attention fire on this exact path (`session-mcp-confirms.ts:69-86`).
  Do not add a second chime — promotion must NOT replay the sound, or a returning
  operator gets chimed for a confirm they were already notified about.
- **BUG-25 (fix commit `b3218c60`, `card/BUG-25`).** That fix re-hydrates parked
  confirms at boot via `mcpConfirmsList()` so a renderer reload doesn't drop them
  (documented in `session-mcp-confirms.ts`'s header). It is **complementary, not
  overlapping**: BUG-25 makes parked confirms survive; this spec makes them surface.
  Both feed the same queue. If `card/BUG-25` is unmerged, stack on it — the boot
  re-hydration path is where promotion must also apply (a confirm re-hydrated at
  boot into a focused window should promote immediately).
- **T83 notification-center (backlog).** Not pre-empted. This spec adds no new
  notification surface, no toast, no inbox redesign — it routes an existing confirm
  to an existing modal. A blocking gate is a different animal from a toast, and T83
  remains free to design the latter.

## Scope boundary — files

**In scope:**

- `src/main/mcp/confirm-core.ts` — a `promotePending(): ConfirmWire[]` returning
  still-pending parked confirms and flipping their mode (around `:369`).
- `src/main/mcp/confirm-resolver.ts` — subscribe to the window `'focus'` event and
  re-send promoted confirms over the existing `mcp:confirm:pending` channel (`:54`).
- `src/renderer/src/stores/session-mcp-confirms.ts` — handle a `parked → modal`
  arrival for a confirm already in the map: remove from the parked queue, hand to the
  overlay, do **not** replay the sound; add the D3 dismissal path.
- `src/renderer/src/components/McpConfirmOverlay.vue` — a Dismiss affordance
  distinct from Deny (D3), and the D5 one-at-a-time queue.

**Out of scope:** redesigning the Approval Inbox; changing what a confirm _means_
(grants, budgets, TTL); the manifest checklist UI; `docs/capy-features.md`;
`design.md`; the hook-approval queue (`session-approvals.ts`) — parked _hook_
approvals are a different queue and this spec does not touch them.

## Acceptance criteria

1. With the window unfocused and the app on any screen (board, Settings, Usage
   Dashboard, maximized terminal, Markdown pane), a new agent confirm parks, chimes,
   and requests OS attention — then **surfaces as a modal over that screen the moment
   the operator focuses the window**.
2. Verified from at least three different active screens.
3. Dismissing the promoted modal leaves the confirm `pending`, returns it to the
   Inbox "Needs you" tab, and produces **no verdict** — the agent's `get_approval`
   still reads `pending`.
4. A dismissed confirm does not immediately re-promote while the window stays
   focused; it re-promotes after a blur → focus cycle.
5. Promotion replays no sound and requests no new OS attention.
6. Two pending parked confirms promote one at a time, in park order.
7. The agent-facing ACK string and `get_approval` state machine are byte-identical
   to today (regression-asserted).
8. `npm run typecheck` + `npm run build` pass.

## TDD plan

Harness: **vitest**. Existing suites: `tests/mcp-approval-stash.test.ts`,
`tests/mcp-approval-status.test.ts`, `tests/approval-resolver.test.ts`.

**Write this failing test FIRST**, in a new `tests/mcp-confirm-promotion.test.ts`:

```
describe('parked confirm promotion', () => {
  it('promotes a still-pending parked confirm to modal on focus regain', ...)
})
```

Build a `confirm-core` instance with `deps.isFocused = () => false`, `park()` a
disclosure, assert `mode === 'parked'`; then flip `isFocused` to `true`, call
`promotePending()`, and assert it returns that confirm with `mode: 'modal'`. This
fails today at the API boundary — `promotePending` does not exist and the mode is a
`const` decided once at `:369`.

Then, in the same file:

1. `promotePending()` twice with nothing new pending → second call returns `[]` (D2).
2. A settled confirm is never returned by `promotePending()` (D2).
3. Dismissal leaves the confirm in `pending` with no `onSettled` call and no verdict
   (D3, AC3, AC7) — the critical safety assertion.
4. A dismissed confirm is excluded from `promotePending()` until the focus epoch
   advances (D4).
5. Two parked confirms promote in park order (D5).

Renderer-side, extend `tests/session-notify-store.test.ts`'s patterns in a store test:
feeding the same confirm id a second time with `mode: 'modal'` must move it out of
`parkedConfirms` **without** calling `playNotificationSound` (AC5) — today
`addParkedConfirm` would simply early-return on the mode check
(`session-mcp-confirms.ts:63`) and the row would be stranded.
