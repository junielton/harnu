# Mission v3 S3 — visual proof (2026-10-01)

Captured from an isolated second Capy instance built from `feat/t381-s3-mission-ui`
(`docs/dev/live-verify-second-instance.md`; the two end-dialog captures were re-taken after the warnings-by-title fix): a clean env (the `CLAUDE_CODE_*` /
`CLAUDECODE` variables unset), a throwaway `--user-data-dir`, a fake `HOME` holding
one transcript per owner session, worktree-unique ports, driven over CDP at
1280×820. The demo repo held three real mission files, written with the main
process's `buildMissionFileContent` from the S1 progress fixtures
(`tests/fixtures/mission-v3/`), so everything except `parallel` went through the
real `mission:list` IPC and the real derive.

| File                         | Mission (fixture)                  | What it shows                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s3-faq-like.png`            | FAQ section (`faq-like`)           | Pill and header "Step 8 of 9", "6 done · 6 verified · 1 left behind", the left-behind mark on step 2, the marker on step 8, the scope link from the legacy fixed start                         |
| `s3-parallel.png`            | Billing area (`parallel`)          | "Steps 4–7 of 9", four running steps each with its one child row and go-to icon, chip "4–7/9" in the pill's accent tone                                                                        |
| `s3-delivered.png`           | Team settings (`delivered`)        | "Step 5 of 5 ✓", green pill, green chip "5/5 ✓" pinned with no warning mark, the `you` block's Close                                                                                           |
| `s3-checks-warnings.png`     | Pricing page (`faq-like` + checks) | Checks on their steps (one ticked, two "due"), a mission blocker under the current step, "+ check" on the current step's label row, warning tone on pill and chip                              |
| `s3-end-dialog-warnings.png` | Pricing page                       | The one end dialog: Close as delivered / Discard, the reason field, the four `closeWarnings` named by step TITLE with real plurals ("1 step left behind — Wire the checkout"), confirm enabled |
| `s3-end-dialog-discard.png`  | Pricing page                       | Discard chosen, a reason typed, the danger confirm (same title-named warnings)                                                                                                                 |
| `s3-after-discard.png`       | —                                  | Right after confirm: the pill, popover, dialog and the sidebar chip are gone                                                                                                                   |

Measured in the same run:

- The real `end` door (discard) removed the mission from the Topbar **18 ms** after
  the confirm click (no list refresh awaited). The file then read `status: closed`,
  `closedAs: discarded`, `closeReason: superseded by the new pricing epic`, and the
  Log gained `### … · operator ended (discarded)` with the reason.
- The pill, the popover header and the current marker agreed on every mission
  (faq-like 8, parallel 4–7, delivered none).

**One honest caveat — `parallel`.** Its running steps need linked child sessions
whose live `taskState` is `working`; an isolated instance has no running children,
so that view (built with `computeProgress` from the fixture, exactly as the server
shapes it) was injected into the missions store over CDP, with the store's
`refresh` stubbed so the popover's open-refresh would not replace it. The other
three missions are real files read through the real IPC.
