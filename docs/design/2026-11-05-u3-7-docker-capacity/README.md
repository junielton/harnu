# U3.7 mockup report — mission mnt-b6156a2c · step stp-7

Status: **approved by the operator on 2026-11-05** (all three screens), with the orchestrator's answers to the 10 open questions applied (below). Source mockup: `.harnu/out/u37/`.

Start at `.harnu/out/u37/index.html` (serve the folder: `cd .harnu/out/u37 && python3 -m http.server 8137`).

## Screens (approve one by one)

| #   | Screen                           | File                                                | States                                                                                                                         |
| --- | -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Cleanup → Docker card            | `.harnu/out/u37/screens/docker-card.html`           | default, capacity-low, capacity-zero, unknown-desktop, unknown-rootless, unknown-remote, no-actions, report-only, advice-offer |
| 2   | Address-pool advice (shown once) | `.harnu/out/u37/screens/docker-pool-advice.html`    | default, copied                                                                                                                |
| 3   | Activity → stale-volume warning  | `.harnu/out/u37/screens/activity-stale-volume.html` | default, several                                                                                                               |

Flow: `capacity-squeeze` — card (advice-offer) → dialog → Copy → Dismiss → card (low, offer gone). Walk it from `docker-card.html?state=advice-offer`.

## What each screen decides

1. **Docker card.** Two new blocks lead the grid: **Docker networks** ("16 of 31 network slots free" + 4px gauge; Low = warning triple, None left = red triple; Unknown = neutral with the reason) and **Paused stacks** ("3 paused", up to 3 rows with idle time and a copy-restore-command icon). One full-width **Automatic actions** block closes the grid: empty networks removed, orphan stacks removed with volumes kept, stacks paused, each with its reason and age. The three existing blocks are unchanged.
2. **Pool advice.** The standard 480px guided dialog: eyebrow, title, two numbered steps (daemon.json snippet with an inline Copy, then restart the daemon), a note "Harnu never edits this file. You'll only see this once.", and Dismiss. It is reached from a one-time callout on the card (state `advice-offer`).
3. **Stale volume.** An Activity warning row (kind bar `--warning`) with the "Open Containers" action pill. Several affected projects fold into one grouped entry, same anatomy as the mission cue.

Copy table (EN + pt-BR, "Paused"/"Pausada", never "parked") is in the index under Context.

## Open design questions

1. **Dialog as its own screen.** The convention treats a dialog as a state of the screen under it. I made it a separate file because you asked for three approvable screens and the spec calls it a dedicated guided dialog. OK, or fold it into `docker-card` as states?
2. **Where the pool advice is offered.** Spec says "offers once". I drew a one-time callout on the Docker card that opens the dialog (not an auto-popup). Alternative: auto-open the dialog on the first squeeze. Callout is less intrusive; auto-open is harder to miss.
3. **Block order.** New blocks lead the grid (status first), actions last. Alternative: capacity as its own row above the grid. At 1280px the auto-fit grid wraps to a lone Orphan volumes block; the real card is narrower, so wrapping will differ.
4. **Low-water mark number.** The caption says "fewer than 4 are free" and the sample uses 4. The spec gives no value; the real figure needs a decision.
5. **Paused rows: copy-command icon on the card or only in the digest/Containers?** C5 puts the `compose up -d` copy in the digest line. I added it to the card rows too; drop it if one place is enough.
6. **How many automatic actions to show.** Mockup shows the last cycle (3 rows). Real data could carry more (hourly ticks, watcher bursts); needs a cap or a "show more".
7. **Report-only first cycle (C1).** Drawn as a "Report only · first cycle" badge and "Would have" chips on each row. Confirm this wording, and whether the existing first-cycle banner should carry the acknowledgement instead.
8. **Unknown-reason copy.** Three reasons (Docker Desktop, rootless, remote) with one-line wording each. Check the technical claims match what the detector can actually distinguish.
9. **Stale-volume grouping.** One row per project when there is one; a grouped entry when several. Alternative: always one row per volume. Also open: does it re-fire per volume, once per volume, or once per project?
10. **Address-pool snippet values.** Example uses `10.200.0.0/16`, size 24 (256 networks). The range could clash with a user's VPN or LAN; the dialog says so but cannot detect it.

## Deviations from tokens/design.md (flagged, not hidden)

- **Dialog backdrop.** design.md says `rgba(0,0,0,0.55)`, which is not a token and the checker rejects raw colours. The mockup approximates it with `--color-bg` at 70% opacity. Implementation should use the real overlay class.
- **Plain numbers with `/* no token */` comments:** type scale sizes (live in `main.css`, not `themes.css`), `--radius-xs` 3px, 22px icon buttons, 26px bell, 2px kind bar, 340px popover.
- **Tokens source.** `tokens.css` is the default `@theme` block of `themes.css` (origin/main) re-homed under `:root`. Light theme not mocked.
- New design.md rows will be needed at implementation: the Docker card's two new blocks, the pool-advice dialog, and the stale-volume Activity row. No new colour, radius, easing or row height is introduced.

## Not covered

- The Containers inspector (the "Open Containers" destination) and the existing Activity out-of-capacity notification.
- Light theme, pt-BR rendering (copy table only), and narrow (< 800px) widths.

## Approved decisions (override the draft where they differ)

1. The pool-advice dialog is built as a Dialog, a state of the card flow.
2. One-time callout on the card, never an auto-popup.
3. Block order as drawn.
4. Low-water mark is **3** (`lowWaterSlots`): the card reads "Cleanup acts when 3 or fewer are free", and the low state "At the low-water mark of 3".
5. Keep the copy-command icon on Paused rows (the restore command is the `compose up -d` line).
6. Show the newest **5** automatic actions plus "Show all in Activity".
7. "Report only · first cycle" badge and "Would have" chips; the acknowledgement stays in Settings → Cleanup, and the badge links to it ("Review in Settings").
8. The unknown reasons match the engine detector (Docker Desktop, rootless, remote).
9. One stale-volume row per project, grouped when several; fires once per volume, again only if a new worktree mounts it.
10. Snippet `10.200.0.0/16`, size 24, with the VPN/LAN clash note.
11. The dialog backdrop uses the real overlay class at implementation.
