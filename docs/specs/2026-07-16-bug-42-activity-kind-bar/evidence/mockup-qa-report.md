# Mockup QA Report — Activity row kind-bar anatomy (BUG-42)

**Result:** ✅ Pass
**Spec:** `docs/specs/2026-07-16-bug-42-activity-kind-bar/spec.html` (approved 2026-07-14, distilled 2026-07-16)
**Dev URL:** Live Electron app (isolated instance, `--user-data-dir=/tmp/capy-verify-bug42`), renderer served at `http://127.0.0.1:5891`
**Target:** `src/renderer/src/components/InboxRail.vue` — Activity row (`data-dsqa="activity-row"`)
**Viewports:** 300 (rail default width)
**Method:** capture-and-compare (spec `file://`) + CDP-driven capture of the real running app (localStorage-seeded with the spec's deterministic sample data), computed-style diff, pixel diff

## Anatomy — authoritative, checked against the live DOM

| Fact                            | Spec                                                                                                            | App (live, computed styles)                                                                                                                                           | Match                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Kind color location             | `.kind-bar` child element, `background` only                                                                    | New `<span class="w-0.5 shrink-0 self-stretch rounded-full" :class="kindBarClass(n.kind)">`, first child of the row                                                   | ✅                                 |
| Row's own border                | `border-top: 1px solid var(--color-border)` only, never colored                                                 | `border-top` only; **`border-left: 0px`** confirmed via computed styles (the old `border-l-2 border-{color}` is gone)                                                 | ✅                                 |
| kind-bar width/radius           | `2px`, fully rounded                                                                                            | computed `width: 2px`, `border-radius: 3.35544e+07px` (Chrome's representation of `border-radius: 9999px` — visually identical to the spec's `2px` on a 2px-wide box) | ✅                                 |
| kind-bar height                 | `align-self: stretch`, dynamic per row                                                                          | computed `alignSelf: stretch`, heights 16.8–49.6px depending on content — matches dynamically, not fixed                                                              | ✅                                 |
| kind-bar colors                 | info `--accent` `#8090b4`, success `--green` `#7a9455`, warning `--warning` `#c08a3e`, danger `--red` `#c6675a` | computed `rgb(128,144,180)` / `rgb(122,148,85)` / `rgb(192,138,62)` / `rgb(198,103,90)` — exact matches, all four kinds verified live                                 | ✅                                 |
| Divider suppressed on first row | `:first-of-type { border-top: none }`                                                                           | Confirmed visually in the stacked app capture (no top rule on the first rendered row)                                                                                 | ✅                                 |
| `data-dsqa` on row root         | n/a (spec convention)                                                                                           | Added — `data-dsqa="activity-row"` on the row `<div>`                                                                                                                 | ✅ (new, per skill recommendation) |

All four kind variants (info/success/warning/danger) were seeded via `localStorage` (`om2tab.notifications`) with the spec's exact sample strings and rendered live in the running app — not inferred from code reading.

## Pixel diff

| Row     | Spec size | App size | Compared (cropped to min) | Mismatch |
| ------- | --------- | -------- | ------------------------- | -------- |
| info    | 300×30    | 300×51   | 300×30                    | 15.73%   |
| success | 300×56    | 300×67   | 300×56                    | 13.42%   |

**Data-match caveat (per mockup-qa Layer 3c):** the app's row is taller than the spec's for a reason **unrelated to this fix** — the row also renders a pre-existing, out-of-scope unread-status dot (`n.read ? 'bg-transparent' : 'bg-accent'`, a later slice's addition, explicitly "everything else … unchanged" per the card) between the kind-bar and the title. That extra 6px+gap column narrows the available text width just enough that the info row's title wraps to a second line in the app but fits on one line in the spec's wider mock body — the diff is a **content/width difference**, not an anatomy or token mismatch (confirmed by the side-by-side composite below: same font, same color, same position, just a different wrap point). Per mockup-qa's rule, this makes the pixel diff **advisory only** — the computed-style/anatomy table above is authoritative, and it passes cleanly on every property.

## Evidence

- `docs/specs/2026-07-16-bug-42-activity-kind-bar/evidence/side-by-side.png` — **primary evidence**: the distilled spec (left, 4 stacked kind variants) next to the live running app's Activity section (right, same 4 rows plus one real live notification that arrived during capture — proof the fix holds under real, non-seeded data too).
- `docs/specs/2026-07-16-bug-42-activity-kind-bar/evidence/app-fullpage.png` — full-app screenshot showing the fixed Inbox rail in context.
- Per-row spec/app/diff triptychs and individual crops were captured during verification (`mockup-qa/` working directory, gitignored — ephemeral) and are described in the Pixel diff section above.

### Confirmed matches ✅

- Kind color lives exclusively on the inner `kind-bar` element for all four semantics.
- The row box itself carries no colored border — only the neutral top-hairline divider.
- Divider suppressed on the first row in the stack.
- `kind-bar` stretches to the row's dynamic content height rather than a fixed size.
- Title/description/timestamp typography, colors, and clamp behavior are unaffected (out of scope, verified unchanged).

### 🟢 Minor (informational, not blocking)

- App row height differs from the spec due to the pre-existing unread-dot column narrowing the title's wrap width. Out of scope for BUG-42 (the card's objective explicitly leaves "everything else … unchanged"); noted for awareness only.

## Next steps

Zero Critical, zero Major findings. Component matches the approved spec. Proceed to `design.md`/`CHANGELOG.md` (already updated in this change), review, and PR.
