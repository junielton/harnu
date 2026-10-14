# PRD — T483: Pinned Scheduler workers

> Draft 2026-10-14. Lands at `docs/prds/T483-scheduler-pinned-workers.md` as the
> first commit of the implementation branch. Mockup:
> `.harnu/out/scheduler-pin-mockup.html`.
> House shape: problem / who / what v1 delivers / out of scope / how we know /
> cost & risk.

## 1. Problem

The Scheduler list has two groups, **Enabled** and **Off**, in creation order.
That was fine at five workers. Measured on the maintainer's machine on
2026-10-14 it holds **22 workers — 4 enabled, 18 off** — and most of them are
`delivery watchdog` workers an orchestration minted through `create_worker`
and that outlived the delivery they watched.

The handful of workers the operator actually uses every day (a PR review
watcher, a price monitor, an "address PR's" loop) are scattered through the
Off group among a dozen near-identical watchdog names. Finding one means
scrolling and reading every row, every time. Turning one back on for the day
is the most common action in this view, and it is the slowest.

## 2. Who

The operator who keeps a small personal set of workers (3–6) they toggle on and
off through the day, on a Scheduler that agents also write into. The pain grows
with every orchestration run, so it gets worse for exactly the heaviest users.

## 3. What v1 delivers

### 3.1 Pin a worker

- A worker can be **pinned**. Pinning is an operator's curation choice: it
  never changes whether, when or how the worker runs.
- Persisted on the worker definition as `pinnedAt?: number` (epoch ms) in
  `schedulers.json`. Present = pinned; the value orders the group. Absent =
  unpinned. Additive: a file written before T483 loads with every worker
  unpinned and nothing else changes.
- `normalizeWorker` (`src/main/scheduler-store.ts`) is a **whitelist** — the
  field must be added there or the first load strips it and the pin silently
  vanishes on restart. This is the single biggest implementation trap.

### 3.2 Where the toggle lives

- **Row hover actions** gain a third icon button, **Pin / Unpin**, before
  Run now and Delete (`Pin` / `PinOff`, lucide, `.iconbtn`, 22×22px). Same
  hover/`.is-hovered` reveal as the existing two.
- **Detail title row** gains the same toggle as an icon button between the
  badges' spacer and **Run now**. Pinned state shows the filled-accent
  variant (`--accent` icon on `bg-accent-soft`), so the detail always tells
  the truth about the pin even when the row is out of view.

### 3.3 A Pinned group on top

The list becomes up to three groups, in this order:

| Group           | Holds                                     | Order               |
| --------------- | ----------------------------------------- | ------------------- |
| **Pinned · n**  | every pinned worker, enabled or off       | `pinnedAt` asc      |
| **Enabled · n** | unpinned workers with `enabled === true`  | unchanged (storage) |
| **Off · n**     | unpinned workers with `enabled === false` | unchanged (storage) |

- A worker appears in exactly one group — pinning moves it, it never
  duplicates it. Counts never double-count.
- A pinned worker keeps its own row state. A pinned **off** worker stays in
  Pinned and keeps the 55% `.is-off` dim, so "my daily workers, two of which
  are off right now" reads at a glance and turning one on is one click on the
  detail toggle.
- The Pinned group header is hidden when no worker is pinned — a Scheduler
  nobody has curated looks exactly like today.
- Ordering by pin time (first pinned stays first) means no drag-and-drop in
  v1 and an order that never jumps around on its own.

### 3.4 Collapse the Off group

- The **Off · n** group header becomes a toggle with a chevron. Collapsed, it
  shows only the header and its count.
- The collapsed state is a per-viewer convenience in `localStorage`
  (`om2tab.scheduler.offCollapsed`, wrapped in try/catch), default expanded —
  nothing changes until the operator asks for it.
- If the selected worker is in a collapsed group, the group stays collapsed
  and the detail stays on that worker; selection is never lost by collapsing.

### 3.5 Default selection follows the display order

Today the view selects `workers[0]` in storage order. With Pinned on top, the
default must be the **first visible row** — the first pinned worker when one
exists — so opening the Scheduler lands on a worker the operator uses.

### 3.6 Agents cannot pin

`pinnedAt` is not accepted by `create_worker` or `update_worker`, and
`list_workers` does not report it. An agent edit through `update_worker`
merges through the store and must **preserve** an existing `pinnedAt`. No
change to `tool-catalog.ts`, so no `docs/harnu-features.md` change.

## 4. Acceptance criteria

- [ ] AC-1 — Pin from a row's hover action moves the worker into **Pinned**
      at once; the row is gone from Enabled/Off — verify: test + visual
- [ ] AC-2 — The pin survives an app restart (`pinnedAt` written to and read
      back from `schedulers.json` through `normalizeWorker`) — verify: test
- [ ] AC-3 — Unpin returns the worker to Enabled or Off according to
      `enabled` — verify: test
- [ ] AC-4 — Pinned is ordered by `pinnedAt` ascending; a pinned off worker
      keeps the `off` state and the 55% dim — verify: test + visual
- [ ] AC-5 — The Pinned header is not rendered when nothing is pinned —
      verify: test
- [ ] AC-6 — The detail title row toggle reflects and changes the same pin
      state as the row action — verify: test + visual
- [ ] AC-7 — Off group collapses/expands from its header; the state survives
      reopening the Scheduler; collapsing never clears the selection —
      verify: test
- [ ] AC-8 — With no prior selection, the view selects the first visible row
      (first pinned worker when any) — verify: test
- [ ] AC-9 — A `schedulers.json` without `pinnedAt` loads unchanged;
      `update_worker` refuses `pinnedAt` and preserves an existing pin —
      verify: test
- [ ] AC-10 — `design.md` Scheduler section, `en.json` + `pt-BR.json`,
      `CHANGELOG.md` and the `docs/user/` Scheduler page are updated in the
      same change — verify: review

## 5. Out of scope (candidate follow-ups)

- **Search / filter box** over the list. Worth it past ~40 workers; pinning
  plus collapse covers today's 22.
- **Drag-to-reorder** pins.
- **Who created it.** Most of the clutter is agent-minted. A `createdBy:
'operator' | 'agent'` stamp (set by the MCP path) would let the list group
  or badge agent workers — a separate card.
- **Watchdog lifecycle.** A `delivery-watchdog` worker should end with its
  mission instead of lingering as an Off row forever. This is the root cause
  of the clutter; pinning only routes around it. Separate card.
- Pinned workers in the footer Scheduler pill.

## 6. How we know it worked

The operator opens the Scheduler and the workers they use daily are the first
rows, without scrolling — on the same 22-worker list measured above.

## 7. Cost & risk

Small: one optional field, one list regrouping, two icon buttons, one
collapsible header. The risks are the whitelist strip (§3.1) and an
`update_worker` merge that overwrites the field (§3.6); both are covered by
AC-2 and AC-9.
