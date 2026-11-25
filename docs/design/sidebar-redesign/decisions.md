# Sidebar redesign: decisions and rejections

The record behind the approved screens in this folder. It translates the design notes of the mockup
rounds (2026-11-24 and 2026-11-25) and the Decided entry of the delivery's log. Where a screen and a
sentence here disagree, `design.md` wins and the disagreement is a defect to report.

## Approved

| What                    | Rule                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flat checkouts          | One folder header, then its checkouts (main first, then worktrees), then the sessions of each. No folder is nested inside another.                                                                                                                                                                                                                                                                   |
| Idle worktrees          | Worktrees with no listed session fold into one quiet row ("n idle worktrees").                                                                                                                                                                                                                                                                                                                       |
| Value slot (variant V3) | Folder and checkout rows share one 24px trailing slot: the count at rest, the chevron on hover or keyboard focus, same box, opacity swap.                                                                                                                                                                                                                                                            |
| Aligned lanes           | The value slot of folder and checkout rows and the trailing icon of session rows end on the same x in every row type.                                                                                                                                                                                                                                                                                |
| Session age             | Removed from the rows. It lives in the hover preview card.                                                                                                                                                                                                                                                                                                                                           |
| Mission chip            | Compact: `⚠ <number for the operator>`. The full text overlays the title tail on hover or focus, with no width change.                                                                                                                                                                                                                                                                               |
| Row states              | They live on the left bar only: session rows on their tree guide segment, checkout rows on the rail lane, folder headers on a 16px tick. Hover 2px light neutral, selected 2px accent (session rows and the current folder header only; a checkout row is never selected), keyboard focus 3px. The text lights up on hover, selected and focus; weight never changes. Resting text keeps its colour. |
| Group rail (variant V4) | One 2px rail per checkout group at the left edge, inset 2px top and bottom, never continuous. Colour from the hottest session: needs you, then failed, then working (green at 40%). Idle and done draw nothing. Folder headers never get a rail. Enter 140ms, exit 220ms, no motion under reduced motion. The rail and the tree guide of the last session end on the same y.                         |
| Needs attention         | One-line rows pinned above the list, only needs-you and failed sessions, most urgent first, hidden when empty.                                                                                                                                                                                                                                                                                       |
| Bottom dock             | Needs you and Return here as folded heads (label, count, age) above Add folder.                                                                                                                                                                                                                                                                                                                      |
| Would-have              | Off the main screen (its own card).                                                                                                                                                                                                                                                                                                                                                                  |
| Focus (variant V1)      | A Focus button on a folder header; focused, the list holds that folder under a sticky `‹ All folders` row that counts what waits elsewhere. It replaces the three-level drill.                                                                                                                                                                                                                       |
| Folder View             | Clicking a folder header opens it, slimmed to identity, git, actions and one roadmap line.                                                                                                                                                                                                                                                                                                           |
| Collapse cycle          | Everything open, then sessions folded, then folders folded, then everything open again; the button's dots show the level.                                                                                                                                                                                                                                                                            |
| Scrollbar gutter        | The list keeps `scrollbar-gutter: stable`, so the value lane does not move when there is nothing to scroll (Focus).                                                                                                                                                                                                                                                                                  |

## Rejected, and why

| Proposal                                                                                            | Reason                                                                |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Many status dots on the rows                                                                        | Noise.                                                                |
| A status badge on the checkout icon                                                                 | Too many dots ("muita bolinha" in the operator's words).              |
| A status ring replacing the home or branch icon                                                     | The row loses its identity (main checkout or worktree).               |
| Card-style rows                                                                                     | Waste width.                                                          |
| Layout shift on hover                                                                               | Not acceptable in any form.                                           |
| A focus outline box on session rows                                                                 | Looks bad; focus is the 3px bar.                                      |
| Row background fills on hover or selection                                                          | The operator asked for the states on the bar only.                    |
| Brightening the resting text                                                                        | Rest colours stay as they are.                                        |
| A continuous rail across neighbouring checkouts                                                     | Neighbouring groups must stay separate (moment 1b of the rail study). |
| Session age on the row                                                                              | No value on the row; the hover card is the single source.             |
| Working-checkout variants V1, V2, V3, V5 (tinted count, lit branch text, tinted icon, spinning arc) | V4, the group rail, was chosen.                                       |
| Lane variants V1 (chevron lane of its own) and V2                                                   | V1 removed the approved hover chevron; V2 still truncated titles.     |
| Hover variants H1 (bar only) and H2 (text only)                                                     | H3, bar and text, was chosen.                                         |
| Focus variants V2 (scope tabs), V3 (folder rail), V4 (soft focus), V5 (scope picker)                | V1, the back row, was chosen.                                         |

## Accepted trade-offs

- The dim working rail is 1.87:1 against the sidebar, below the 3:1 a meaningful bar should have. The
  working dot of each session still carries the state, so the rail is a secondary cue.
- When every checkout works, the folder ring, the rails and the dots say the same thing on three
  levels.
- In the Floating panels layout the rail sits close to the island border.

## Measured geometry

Sidebar 280px; the list reserves its scrollbar gutter, so rows are 270px wide (floating layout: the
value lane moves in by 2px, inside the island border).

| Row                 | Height | Left                                          | Right                                                    |
| ------------------- | ------ | --------------------------------------------- | -------------------------------------------------------- |
| Folder header       | 30px   | 16px state ring at x=12                       | 24px value slot ending at row width minus 12             |
| Checkout / idle row | 26px   | 13px icon at x=14                             | the same slot                                            |
| Session row         | 26px   | tree guide 1px at x=20; 12px dot slot at x=24 | mission chip, then a 14px icon slot ending on the same x |

Contrast against the sidebar: hover bar 6.95:1, selected bar 5.28:1, focus bar 15.94:1, green rail at
full strength 4.98:1, amber 5.58:1, red 5.12:1.

## How these screens differ from the design export

The screens were distilled from a design-tool export; the operator approved the export, not these
files. They match it except for:

- **No drill-depth button in the toolbar.** The export still drew it; Focus replaces drill-in, so the
  approved decision removes it.
- **No Google Fonts request.** The screens are self-contained and use the app's own font stack, so
  titles can truncate a few pixels earlier or later than in the export.
- **Hex values became tokens.** The dim working rail is `color-mix` of `--color-green` at 40%.
- **Sample data** is the export's, with "PR 381" in place of the number sign.

## Open

D-1 in the spec: whether the session hover card should also show mission progress and the
orchestrator role. The hover card contract lists neither today.
