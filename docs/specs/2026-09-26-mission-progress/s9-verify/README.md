# S9 visual proof (T370)

Captured 2026-09-28 from an **isolated** Capy instance, never the operator's window:
`electron out/main/index.js --user-data-dir=/tmp/capy-verify-s9 --remote-debugging-port=9471`,
renderer served on `127.0.0.1:5471` (`ELECTRON_RENDERER_URL`), a throwaway `HOME` whose
`~/.claude/projects` held one demo repo with ten seeded sessions, and a stub `claude` on `PATH`
so selecting a session never started a model. One mission file per popover state was seeded
into the demo repo's `.capy/missions/`. Screenshots are `Page.captureScreenshot` of that
instance's page over CDP, clipped to the surface. Only the PIDs this run started were killed.

| File                              | What it shows                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `pill--none.png`                  | a session with no mission — nothing renders                                   |
| `pill--draft.png`                 | neutral tone, `Step 0 of 5`                                                   |
| `pill--active.png`                | accent tone (`total-changed` shares it)                                       |
| `pill--blocked.png`               | warning tone (`needs-you`, `stale`, `rescope-pending` share it)               |
| `pill--delivered.png`             | success tone, `check` glyph                                                   |
| `popover--<state>.png`            | the popover for each of the eight in-mission states                           |
| `sidebar--chips.png`              | calm `N/M` on the selected row, flagged (amber, pinned) on rows that need you |
| `door--approved.png`              | after **Approve mission** on the draft: now `active`, `Step 2 of 5`           |
| `door--human-step-ticked.png`     | after **Mark verified** on a human step: done, **Unmark** offered             |
| `door--closed-pill-gone.png`      | after **Close mission**: the mission is `closed` and the pill is gone         |
| `capture-report.json`             | per state: the pill tone and popover state the DOM reported                   |
| `doors-report.json`               | per door: what the mission file on disk said afterwards                       |
| `door--close-confirm.png`         | AC-S9-8: **Close mission** opens the confirm; focus on Cancel                 |
| `door--close-confirm-context.png` | the same, full window: the popover stays open behind the dialog               |
| `close-confirm-report.json`       | AC-S9-8 live run: file `delivered` after open and Cancel, `closed` on confirm |

Not reproducible in the seed: a child row's `working` (green, pulsing) and `needs-input`
(amber, blinking) dots need a live session with hook state; the seeded child is `idle`. The
`needs-you` state is shown through an operator-owned blocker instead of a waiting child.

**AC-S9-8 (delta, 2026-09-28).** Captured the same way from a fresh isolated instance
(throwaway `--user-data-dir`, CDP :9472, renderer :5472, throwaway `HOME`, stub `claude`) seeded
with one delivered mission whose close was requested. The chime and OS-attention calls are not
observable in a screenshot; `tests/mission-close-confirm.test.ts` asserts them.
