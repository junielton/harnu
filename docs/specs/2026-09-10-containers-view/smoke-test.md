# Smoke test — Containers takeover mockup (direction D)

**Date:** 2026-09-11 · **Spec:** `spec.html` at commit `88ebe98` (status: draft) · **Card:** T320

**Question:** does the mockup offer every action the operator needs, and nothing they don't?

## Method

1. **Mechanical inventory.** A parser walked `spec.html` and listed every `<button>`, every
   selectable row and every checkbox, grouped by `data-dsqa` root. The inventory comes from the
   markup, not from the author's memory of what was drawn.
2. **Journeys.** The operator's intents come from T320 and the operator's own words ("a worktree
   brought up a docker and it's been sitting for two days because the feature already shipped",
   "stop every zombie", "it's eating memory"). Each intent was mapped to the affordance that
   serves it.
3. **Verdict per journey:** covered, missing, or ambiguous. Affordances that serve no journey,
   or that can't work, are listed as extra.

## 1. Inventory

| Kind                   | Count | Items                                                                                                                                                                                                                |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distinct button labels | 12    | Scan now · Scan again · Stop 3 idle stacks · Stop stack · Stop container (quick, hover) · Start stack · Remove containers… · Remove volume… · Copy command · Cancel · Remove 4 containers · Containers (footer pill) |
| Selectable rows        | 10    | 8 stack rows (Needs you / Leave alone) + 2 Recent rows                                                                                                                                                               |
| Checkboxes             | 1     | "Also remove volume" in the remove dialog                                                                                                                                                                            |
| Close                  | 2     | takeover X (view, docker-unavailable)                                                                                                                                                                                |

Actions offered per verdict, as drawn:

| Verdict          | Stop               | Start | Remove containers | Remove volume | Note          |
| ---------------- | ------------------ | ----- | ----------------- | ------------- | ------------- |
| zombie, running  | ✅ primary + quick | —     | ✅                | ✅            |               |
| zombie, exited   | —                  | ✅    | ✅                | ✅            |               |
| orphan           | —                  | —     | ✅                | ✅            | warning note  |
| active           | ✅ neutral, warned | —     | —                 | —             | never in bulk |
| protected        | ✅ neutral         | —     | —                 | —             | never in bulk |
| unknown          | —                  | —     | —                 | —             | no actions    |
| recent (stopped) | —                  | ✅    | —                 | —             | copyable undo |

## 2. Journey coverage

| #   | Operator intent                                          | Affordance                                        | Result                                 |
| --- | -------------------------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| J1  | See what is eating RAM, ports, disk                      | hero numbers + meter + RAM per row                | ✅ covered                             |
| J2  | Stop every zombie at once                                | "Stop 3 idle stacks"                              | ⚠️ ambiguous — see A1, A2              |
| J3  | Stop one zombie                                          | detail "Stop stack" + hover quick stop            | ✅ covered                             |
| J4  | Know why a stack is flagged                              | evidence panel                                    | ✅ covered                             |
| J5  | Undo a stop                                              | Recent → Start stack; exited zombie → Start stack | ✅ covered (bulk undo ambiguous — A4)  |
| J6  | Clean the leftovers of a deleted worktree                | orphan → Remove… + dialog                         | ✅ covered                             |
| J7  | Delete a volume on purpose                               | "Remove volume…" + dialog checkbox                | ❌ broken — see X1                     |
| J8  | Leave active work alone                                  | active excluded from bulk; manual stop warns      | ✅ covered                             |
| J9  | Keep the main checkout's stack safe                      | `protected` verdict                               | ⚠️ not in T320 scope — X2              |
| J10 | Jump from a stack to its worktree or session             | —                                                 | ❌ missing — M1                        |
| J11 | Rescan                                                   | Scan now / Scan again                             | ✅ covered                             |
| J12 | Work at real scale (the measured repo had 40 containers) | master list                                       | ❌ missing — M2                        |
| J13 | Know something needs attention without opening the view  | footer pill                                       | ✅ covered (no notification pref — M7) |
| J14 | Tune the idle threshold                                  | —                                                 | ❌ missing — M7 (known open item)      |
| J15 | See an action in progress, or that it failed             | —                                                 | ❌ missing — M4                        |
| J16 | Open the view while the first scan runs                  | —                                                 | ❌ missing — M3                        |
| J17 | Remove a stopped zombie whose worktree still exists      | Remove containers… → dialog                       | ⚠️ dialog copy is orphan-only — M5     |
| J18 | Understand a "removed" Recent entry and what undo means  | Recent proj-19                                    | ❌ missing — M6                        |
| J19 | Close the view                                           | X                                                 | ✅ covered                             |

**Score:** 10 covered · 4 ambiguous or out of scope · 6 missing · 1 broken.

## 3. Findings

### Missing

- **M1 — No way to reach the worktree or session behind a stack.** Capy is a session manager, so
  a row that names a worktree should open it. Add "Open worktree" to zombie, exited, active and
  protected details, plus "Go to session" on active. Orphan has no target, so no link.
- **M2 — The master list can't hold real scale.** `.master` is `overflow: hidden`, so rows past
  roughly the tenth are clipped and unreachable. The measured repo had 40 containers across 8+
  stacks. The list needs its own scroll area. A filter is optional in v1.
- **M3 — No scanning state.** The first open runs `docker ps` + `docker stats` + `docker system df`,
  which takes seconds. Draw the loading state (hero placeholders + Scan button spinner, the
  Cleanup idiom).
- **M4 — No in-progress or failure state for actions.** Stop, start and remove call docker and can
  fail (daemon gone, container already removed, volume in use). Draw a button busy state and an
  inline error in the detail pane.
- **M5 — The remove dialog only exists for orphans.** Its copy says "Its worktree no longer
  exists". The exited-zombie path (proj-11) needs a variant whose copy fits a worktree that still
  exists.
- **M6 — No detail for a "removed" Recent entry.** Removed containers can't be restarted, so the
  undo is different: recreate from the worktree if it still exists, and the kept volume is named.
  Draw it, or cut "removed" rows from Recent.
- **M7 — No settings surface** for the idle threshold and a notify-on-new-zombies pref (Cleanup
  has `notifyOnHarvestable`). Already listed as open; it belongs in a Settings tab, not in the view.

### Extra or wrong

- **X1 — The standalone "Remove volume…" tier can't work.** Docker refuses to remove a volume
  while any container references it, and exited containers count. On every pane where it's drawn
  the containers still exist, so the button would fail every time. Merge tiers 2 and 3 into one
  **"Remove…"** that opens the dialog, with the volume checkbox unchecked by default. The mockup
  loses a button, and the MCP surface loses a verb.
- **X2 — The `protected` verdict isn't in T320's scope.** It is drawn in five places (row, chip,
  detail, meter legend, bulk exclusion). Either add it to T320 on approval, or remove it and treat
  the main checkout like any other stack.

### Ambiguous

- **A1 — Two words for one thing.** The chip says "zombie"; the hero and the bulk button say
  "idle". Pick one user-facing term.
- **A2 — Three different counts.** The bulk button says 3, "Needs you" lists 5, and the footer
  pill says 5. The button stops only running stacks, which is right, but the label doesn't say
  so. Suggestion: "Stop 3 running", or a caption.
- **A3 — What happens to a row after Stop?** A stopped zombie presumably turns into an exited
  zombie and stays in "Needs you" until removed. Specify it, so "Stop 3" doesn't look like it
  failed to clear the list.
- **A4 — Bulk undo granularity.** Is one Recent entry written per bulk action, or one per stack?
  One per action matches the click; one per stack matches Start.

## 4. MCP parity — every UI action, and its agent equivalent

After X1 is applied, the UI has four actions. Each one needs a verb, so the feature works end to
end for an agent as well as the operator.

| UI action                           | MCP verb            | Gate posture (existing precedent)                                                                                                                                                             |
| ----------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open view / Scan now / read Recent  | `list_containers`   | read (`mutates: false`, `discloses: 'paths'`, aliases redacted like `list_workers`)                                                                                                           |
| Stop stack · quick stop · bulk stop | `stop_containers`   | runs free (`silentAllowInAgentFolder`, like `archive_card`); `unknown` always refused; `active`/`protected` refused unless `force: true`, and `forceConfirmFor: force` (like `update_worker`) |
| Start stack · undo a stop           | `start_containers`  | runs free — reversible                                                                                                                                                                        |
| Remove… (+ optional volume)         | `remove_containers` | ALWAYS asks (like `delete_card` / `delete_worker`); one stack per call, never bulk                                                                                                            |
| Open worktree / Go to session (M1)  | —                   | UI-only: an agent already has the folder path and session id                                                                                                                                  |
| Settings (M7)                       | —                   | operator-only, like the routing table                                                                                                                                                         |

## 5. Recommended spec changes

Apply X1, M1–M6 and A3/A4 directly: none needs a decision. A1, A2 and X2 need the operator's
call. M7 is a separate Settings pane.

## 6. Resolution — 2026-09-11

**Operator decisions.**

- **A1:** "zombie" is the only user-facing term. The duration field now reads "Unused for".
- **A2:** the bulk button reads "Stop N running".
- **X2:** the `protected` verdict is in T320's scope.

**Applied to `spec.html`** (the spec is still `draft`):

| Finding | Change                                                                                                                                                                                                                     | Component                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| X1      | One **Remove…** (danger) opens the dialog, and it is offered only on a **stopped** stack. A running stack shows it disabled, captioned "Stop it first", because `docker rm` refuses a running container without `--force`. | every detail pane                                                         |
| M1      | "Open worktree" / "Go to session" / "Open folder" in the detail title row (orphan and unknown have no target)                                                                                                              | view, exited, active, protected, stopping, failed, recent, recent-removed |
| M2      | The master list scrolls (`overflow-y: auto`)                                                                                                                                                                               | `containers-view`                                                         |
| M3      | A scanning state: skeleton numbers and rows, busy Scan button                                                                                                                                                              | `containers-view--scanning`                                               |
| M4      | In-progress and failed action states                                                                                                                                                                                       | `containers-detail--stopping`, `containers-detail--failed`                |
| M5      | A zombie variant of the remove dialog; the orphan one is renamed                                                                                                                                                           | `containers-remove-dialog--zombie`, `containers-remove-dialog--orphan`    |
| M6      | Detail for a "removed" Recent entry, with the recreate command                                                                                                                                                             | `containers-detail--recent-removed`                                       |
| A3      | A stopped zombie stays in "Needs you" (RAM reads "stopped") until removed; the hero drops to the nothing-to-stop state                                                                                                     | `containers-master--after-bulk-stop`                                      |
| A4      | One Recent entry per action ("3 stacks stopped"), undone as one                                                                                                                                                            | `containers-detail--recent-bulk`                                          |

**Still open:** M7, the Settings pane (zombie threshold + notify pref). It is separate from the view.

**MCP consequence (T329):** `remove_containers` refuses a running stack with `STACK_RUNNING`, and a
bulk verb call writes one tombstone listing every stack, matching the UI.
