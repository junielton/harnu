# Harnu — Design Guide

> Visual language and usage rules for the session-management app
> for Claude Code. Dark, dense, sober — built for people who live between worktrees.

**Version:** 0.1 · **Target stack:** Electron + Vue 3

---

## Summary

1. [Logo](#1-logo)
2. [Colors](#2-colors)
3. [Typography](#3-typography)
4. [Spacing & radii](#4-spacing--radii)
5. [Iconography](#5-iconography)
6. [Components](#6-components)
7. [Motion](#7-motion)
8. [Voice & copy](#8-voice--copy)
9. [Tokens (CSS)](#9-tokens-css)

---

## 1. Logo

Three brand variants. **Prompt Tile** is the primary version — app icon,
favicon, social media. The others exist as supporting marks.

| Variant | Name              | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**   | Prompt Tile       | **Primary.** Rounded square with a `›` chevron, Ink/Dusk pairing. App icon, favicon. `BrandMark.vue` (in-app) renders a Dusk tile with an Ink chevron (`bg-accent text-accent-ink`); the exported app/taskbar icon (`scripts/gen-icons.py`) intentionally inverts it — an Ink tile with a Dusk chevron — so the OS-level icon reads as "a dark window with an accent mark" instead of a solid accent square. Both pairings pass contrast (same two colors, swapped fg/bg). |
| **B**   | Parallel Sessions | Conceptual. Three bars representing parallel sessions. Marketing.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **C**   | C-cursor          | Letter C with a terminal cursor block. Long wordmark.                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Primary variant lockups

- **Horizontal** (default): mark + "Harnu" side by side
- **Stacked**: mark above, wordmark below (tight spaces)
- **Mark only**: used in dense UI, dock, favicon
- **Wordmark only**: site header, footer, context where the brand is already clear

> **Sidebar header:** no longer renders the lockup/wordmark. The brand appears
> only on the onboarding, empty-state, and settings surfaces — the sidebar
> header is reserved for navigation (view-switch + search). The sidebar
> background (`#211c18`) remains valid as the mark's backdrop on those other surfaces.

### Allowed backgrounds

| Background | Hex       | Mark                  | Notes                          |
| ---------- | --------- | --------------------- | ------------------------------ |
| Sidebar    | `#211c18` | Colored (Prompt Tile) | App default                    |
| App bg     | `#17120e` | Colored               | Onboarding, splash             |
| Light      | `#f6f5f1` | Colored               | Marketing, README              |
| Accent     | `#8090b4` | Knockout (outline)    | Monochrome version over accent |

### Minimum size

**16px** (favicon). Below that the chevron loses definition — use the solid
square without the glyph.

| Context          | Size    |
| ---------------- | ------- |
| Favicon          | 16px    |
| Menu bar (macOS) | 24px    |
| Dock             | 32–64px |
| About            | 48px    |
| Onboarding hero  | 44–64px |
| Marketing        | 96px+   |

### Clearspace

Reserve at least **½ X** (half the mark's height) of free space on all
sides. In dense UI this can shrink to **X/4**, never less.

### Don't

- ❌ Rotate, distort, or apply perspective
- ❌ Use over loud gradients or colors outside the palette
- ❌ Add glow, dramatic drop-shadow, or other effects
- ❌ Stretch the aspect ratio (always 1:1)
- ❌ Use colors outside the Ink/Dusk pairing (§2)
- ❌ Combine with another glyph inside the same tile

---

## 2. Colors

The default theme (**Harnu**) is a **warm neutral palette** (Ink) with **a single cool
accent** (Dusk). The rule: use accent sparingly — it signals action or active state,
**never decoration**.

### The Harnu palette (Toffee / Ink / Dusk)

Three brand hues, one derived ramp. Fixed anchors below; any additional in-between UI
tone (e.g. `--surface`, `--surface-2`, `--text-2`) is interpolated in OKLCH along the
same hue/chroma trajectory — never invented off-palette.

| Ramp                                                           | 0/100                           | 200/300         | 400/500                           | 600/700         | 800/900                           |
| -------------------------------------------------------------- | ------------------------------- | --------------- | --------------------------------- | --------------- | --------------------------------- |
| **Toffee** (illustration only, never a UI token)               | `#EDE3DC` (100)                 | `#C9AE9B` (300) | `#8A6A55` (500)                   | `#5E4739` (700) | `#33251C` (900)                   |
| **Ink** (the system neutral — every surface/text/border token) | `#FAF8F6` (0) / `#E8E3DE` (100) | —               | `#8C8379` (400)                   | `#302A25` (700) | `#211C18` (800) / `#17120E` (900) |
| **Dusk** (accent)                                              | —                               | `#C3CADD` (200) | `#8090B4` (400) / `#55648B` (500) | `#455274` (600) | `#232B3D` (800)                   |

**Contrast rule (non-negotiable):** Dusk 500 (`#55648B`) is 3.2:1 on Ink 900 — it
**fails** as text or a thin border. Use **Dusk 400** (`#8090B4`, 5.8:1) for accent text,
icons, and borders. `--accent` is one shared token in this codebase (`text-accent` and
`bg-accent` both read it), so it must be the value that passes as text — Dusk 500 stays
reserved for a future dedicated solid-fill treatment (5.9:1 with white text) if the
accent token is ever split into a separate text/fill pair.

Session-status hues (desaturated to sit inside the palette, not generic
red/green/amber): `working #7A9455` → `--green`, `needs-input #C08A3E` → `--warning`,
`stuck #B85A4E` → `--red` (lifted and turned toward rose for the UI token, `#D1717C` —
the raw hex is only 4.08:1 on Ink 900, which fails for the body text `--red` renders as
elsewhere in the app. The plain lift to AA, `#D17163`, landed almost on Claude's coral
(OKLab ΔE 0.028 to `#D97757`), so the hue also moves from OKLCH 29 to 14; the result is
4.93:1 on `--surface` and ΔE 0.057 from the coral, at least as far as Capy's earlier red),
`idle #8C8379` (= Ink 400, no separate token needed).

**Contrast rule for text tokens:** every text token except `--text-disabled` must reach
**4.5:1 on `--bg` and `--surface`** (WCAG 2.x relative luminance). Measured values:

| Token      | Hex       | `bg` | `sidebar` | `surface` | `surface-2` |
| ---------- | --------- | ---- | --------- | --------- | ----------- |
| `--text-3` | `#948b80` | 5.55 | 5.04      | 4.85      | 4.62        |
| `--text-4` | `#8e867e` | 5.19 | 4.71      | 4.54      | 4.33        |
| `--red`    | `#d1717c` | 5.64 | 5.12      | 4.93      | 4.70        |

Three consequences of the owner-approved Brand v0 values (2026-10-03):

- **`--text-disabled` is deliberately below 4.5:1** (1.65:1 on `--surface`). WCAG 1.4.3
  exempts inactive controls, and lifting it would make disabled indistinguishable from
  enabled. It is the only text token allowed under the rule.
- **`--text-3` and `--text-4` are now near-equal in lightness.** The metadata tier no longer
  has its own contrast step: eyebrows, captions and metadata are told apart from body by
  size, case and tracking, not by being dimmer. Do not reach for `--text-4` to mean "less
  important than `--text-3`".
- **On `--surface-2` hover rows prefer `--text-3`.** `--text-4` is 4.33:1 there, under AA;
  `--text-3` is 4.62:1.

### Surfaces

| Token         | Hex       | Use                                                    |
| ------------- | --------- | ------------------------------------------------------ |
| `--bg`        | `#17120e` | App background (right-hand panel, modal backdrop tint) |
| `--sidebar`   | `#211c18` | Left sidebar                                           |
| `--surface`   | `#251f1b` | Cards, inputs, message bubbles                         |
| `--surface-2` | `#29231f` | Surface hover, `<kbd>`, quiet badges                   |
| `--border`    | `#302a25` | Default borders (1px)                                  |
| `--border-2`  | `#38312c` | Elevated borders (dialogs, menus)                      |

### Text

| Token             | Hex       | Use                                  |
| ----------------- | --------- | ------------------------------------ |
| `--text`          | `#faf8f6` | Primary text (titles, active labels) |
| `--text-2`        | `#ada59d` | Secondary text (body, values)        |
| `--text-3`        | `#948b80` | Tertiary text (captions, hints)      |
| `--text-4`        | `#8e867e` | Quaternary text (eyebrows, metadata) |
| `--text-disabled` | `#4a423c` | Disabled states                      |

### Accent + semantic

| Token            | Hex                      | Use                                                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `--accent`       | `#8090b4`                | Dusk — primary CTA, prompt, selection                                                |
| `--accent-soft`  | `rgba(128,144,180,0.12)` | Subtle background in the selected state                                              |
| `--accent-line`  | `rgba(128,144,180,0.35)` | Focus border, quote accent line                                                      |
| `--accent-ink`   | `#17120e`                | Text **on** accent (dark ink — Dusk is a mid-tone, needs a dark foreground)          |
| `--green`        | `#7a9455`                | Active session indicator                                                             |
| `--green-soft`   | `rgba(122,148,85,0.18)`  | Animated pulse halo; Success badge background                                        |
| `--green-line`   | `rgba(122,148,85,0.35)`  | Success badge border                                                                 |
| `--red`          | `#d1717c`                | Destructive, danger, diff removal                                                    |
| `--red-soft`     | `rgba(209,113,124,0.10)` | Subtle background in the hover state of destructive items (Delete, Remove, Discard). |
| `--red-line`     | `rgba(209,113,124,0.30)` | Danger badge border; the border of a danger button or callout                        |
| `--warning`      | `#c08a3e`                | Mild warning (rare)                                                                  |
| `--warning-soft` | `rgba(192,138,62,0.10)`  | Warning badge background                                                             |
| `--warning-line` | `rgba(192,138,62,0.30)`  | Warning badge border; the warmed border of a sensitive-path file box                 |

### Target ratio

Looking at a full screen, you should see:

```
Neutros  ████████████████████████████████████████  85%
Texto    █████                                     12%
Accent   █                                          3%
```

### When to use accent

- ✅ Selected-session indicator (2px sidebar bar + soft bg)
- ✅ **One** primary button per screen
- ✅ User prompt in the terminal (`›`)
- ✅ Markers for running tool calls (●)
- ✅ Blinking cursor in the input
- ❌ **Never** for decoration, separators, large backgrounds, or generic icons

---

## 3. Typography

Two families, no exceptions.

### Families

| Family                           | Stack                                                                                              | Use                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Inter**                        | `'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif`                                | All UI, marketing, copy                              |
| **JetBrainsMono Nerd Font Mono** | `'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace` | Terminal, code, paths, branch names, kbd, timestamps |

**Why the Nerd Font variant:** TUIs like `claude` draw icons (Powerline, Devicons, Codicons) that "clean" JetBrains Mono doesn't have — they render as tofu (▯). The patched **Mono** variant includes those glyphs at fixed width (correct cell alignment). The WOFF2 is bundled locally (see "Font imports"), with a fallback to the system `'JetBrains Mono'`. The family name matches the name installed on the OS, so it resolves in both cases.

**Enabled features:** `font-feature-settings: 'cv11', 'ss01', 'ss03';` on the body.

### Available weights

- Inter: 400 (regular), 450 (book), 500 (medium), 600 (semibold), 700 (bold — rare use)
- JetBrains Mono: 400, 500, 600

### Scale

| Role     | Size / Line | Weight | Letter-spacing    | Use                                      |
| -------- | ----------- | ------ | ----------------- | ---------------------------------------- |
| Display  | 32 / 36     | 500    | -0.02em           | Onboarding hero                          |
| Title    | 20 / 28     | 500    | -0.015em          | Section headers (Welcome panel)          |
| Subtitle | 15 / 22     | 500    | 0                 | Dialog titles                            |
| Body     | 13 / 20     | 400    | 0                 | Running text in dialogs, descriptions    |
| UI       | 12.5 / 18   | 450    | 0                 | Session rows, menu items                 |
| Caption  | 11 / 16     | 400    | 0                 | Hints, helper text                       |
| Eyebrow  | 10.5 / 14   | 500    | +0.07em UPPERCASE | Section labels, group headers            |
| Code     | 13 / 20     | 400    | 0                 | JetBrains Mono — paths, commands, values |
| Code-sm  | 11 / 14     | 400    | 0                 | JetBrains Mono — kbd, badges, timestamps |

### Tailwind type tokens

The Scale rows are available as Tailwind utilities declared in `main.css` `@theme` (size **and** line
height travel together): `text-title` (20/28), `text-subtitle` (15/22), `text-body` (13/20), `text-ui`
(12.5/18), `text-caption` (11/16), `text-eyebrow` (10.5/14; pair with `.eyebrow` for the weight, case and
tracking). New surfaces use these instead of an arbitrary `text-[Npx]`; a size that is not on the scale is a
documented exception in the component's own §6 section.

### Rules

- **Minimum size:** 10.5px (only for uppercase eyebrows with letter-spacing)
- **Negative letter-spacing** on anything above 18px to feel tighter
- **Tabular numerics** (`font-variant-numeric: tabular-nums`) on timestamps and metrics
- **Tokenized eyebrow:** the Eyebrow scale is implemented by the `.eyebrow` utility
  class (in `main.css`) — `10.5/14`, weight 500, `UPPERCASE`, `+0.07em`
  (**typography only**; color is applied per context). Section labels and group
  headers (sidebar zones, Fleet status board sections) **use `.eyebrow`** +
  a token color, never a raw `style=` with px/tracking. Default `--text-4`; the
  Fleet status board tints each header by its state color (see §6).

---

## 4. Spacing & radii

**4px** base. High density — most padding falls between **6px and 14px**.

### Spacing scale

| Token | Value | Typical use                                          |
| ----- | ----- | ---------------------------------------------------- |
| `s-1` | 4px   | Gap between consecutive kbds, inner gap in chips     |
| `s-2` | 8px   | Gap in flex rows, inner padding of dense items       |
| `s-3` | 12px  | Padding of small cards, gap in lists                 |
| `s-4` | 16px  | Padding of standard containers, gap between sections |
| `s-5` | 24px  | Padding of dialogs, gap between blocks               |
| `s-6` | 32px  | Margin between large sections                        |
| `s-7` | 48px  | Hero padding, strong visual separation               |

### Radii

| Value   | Use                                                                                |
| ------- | ---------------------------------------------------------------------------------- |
| `0`     | Reset / full-bleed containers                                                      |
| `3px`   | Badges, kbd, separator pills, treemap blocks and Docker-card blocks (`rounded-xs`) |
| `5px`   | Buttons, inputs, chips                                                             |
| `7px`   | Cards, dropdown menus, message bubbles                                             |
| `10px`  | Dialogs, large panels                                                              |
| `999px` | Status pills, accent indicators                                                    |

### Row density

The sidebar rows scale with a user-chosen **density preset** (Settings → SIDEBAR
→ Density: **Comfortable** / **Compact**, persisted globally under
`om2tab.sidebarDensity`, default **Comfortable**). Comfortable is the baseline
below; Compact tightens the sidebar's own rows (heights, gaps, and the session
indent — see §6 "Row anatomy & indentation") without touching any other surface.
Everything outside the sidebar (topbar, buttons, inputs, menus) is density-independent.

| Component                    | Comfortable | Compact |
| ---------------------------- | ----------- | ------- |
| Sidebar — folder row         | 26px        | 23px    |
| Sidebar — repo-group header  | 26px        | 26px    |
| Sidebar — session row        | 28px        | 24px    |
| Sidebar — terminal row       | 26px        | 23px    |
| Sidebar — agent/teammate row | 24px        | 22px    |
| Sidebar — "+ new session"    | 26px        | 23px    |
| Topbar                       | 42px        | —       |
| Default button               | 28px        | —       |
| Large button (CTA)           | 32–36px     | —       |
| Input                        | 32px        | —       |
| Menu item                    | 26px        | —       |

### Layout dimensions

| Dimension                              | Value                                                | Use                                                                                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar — minimum width                | 200px                                                | Drag-resize floor                                                                                                                                                                                              |
| Sidebar — default width                | 268px                                                | Initial width / reset on double-click                                                                                                                                                                          |
| Sidebar — maximum width                | 480px                                                | Drag-resize ceiling                                                                                                                                                                                            |
| Inbox rail — minimum width             | 260px                                                | Drag-resize floor (4th column, T83)                                                                                                                                                                            |
| Inbox rail — default width             | 300px                                                | Initial width / reset on double-click                                                                                                                                                                          |
| Inbox rail — maximum width             | 440px                                                | Drag-resize ceiling                                                                                                                                                                                            |
| Inbox rail — minimized strip           | 44px                                                 | Fixed width of the `minimized` state (icon + badge; does not resize)                                                                                                                                           |
| Resizable divider — hit area           | 6px                                                  | Handle drag area (`w-1.5`), shared by the sidebar and the split                                                                                                                                                |
| Resizable divider — visible stripe     | 1px                                                  | Colored center stripe (`w-px`) inside the 6px hit area                                                                                                                                                         |
| Footer / status bar — height           | 24px (`h-6`)                                         | Full-width footer, fixed to the bottom of the shell                                                                                                                                                            |
| Settings dialog — size                 | width `min(92vw, 940px)` · height `min(80vh, 720px)` | **Fixed-size** dialog derived from the window — switching tabs or searching does not resize it (nav + pane scroll independently)                                                                               |
| Settings pane — bounded list           | max-height `280px`                                   | A long row list inside a settings pane scrolls in place (`.scrollable overflow-y-auto`) instead of pushing the sections below it off the pane — see §6 "Bounded list (settings pane)"                          |
| Cleanup side panel — width             | 320px                                                | Docked detail panel beside the treemap (§6 "Workspace GC — unified Cleanup"); overlays the map below 1100px instead of docking                                                                                 |
| Cleanup treemap — region minimum width | 340px                                                | A repo region never lays out narrower; the map wraps onto another shelf (row) instead of squeezing, and the canvas height is computed from the data, not fixed (§6 "Workspace GC — unified Cleanup / Treemap") |
| Cleanup list dialog — width            | `min(720px, 90vw)`                                   | The bulk-clean / remove-selected confirm: wider than the 560px Dialog so a row holds name + chips; its list is capped at `--fv-rail-list-max-h`                                                                |
| macOS window-controls inset            | 78px (macOS only; 0 elsewhere)                       | Left inset on the corner header (sidebar always; topbar when sidebar collapsed) so content clears the macOS traffic lights                                                                                     |

Sidebar width is **state persisted globally** (`localStorage`,
key `om2tab.sidebarWidth`) — same anatomy as the theme. Out of range it is
clamped to `[200, 480]`; a missing/invalid value falls back to the `268` default. These
three limits are a runtime dimension (they feed the drag and clamp
math), not visual tokens — they live as constants in
`src/renderer/src/stores/layout.ts` (`SIDEBAR_WIDTH_MIN/DEFAULT/MAX`), not in
`themes.css`. The divider width uses the Tailwind utility `w-1.5`.

The **Inbox rail** (the 4th column, §6 → "Inbox rail") follows exactly the same
anatomy: width + state persisted **globally** (`om2tab.inboxRailWidth`,
`om2tab.inboxRailState`), clamped `[260, 440]`, default `300`, constants in
`layout.ts` (`INBOX_RAIL_WIDTH_MIN/DEFAULT/MAX`). **Global, not per-worktree**
like the helper-stack (which persists in `helpers.json`): the approvals queue belongs to the
**fleet**, so it needs to stay visible precisely while you're looking at
_another_ folder.

---

## 5. Iconography

**Lucide** ([lucide.dev](https://lucide.dev)).

### Rules

- **Stroke:** 1.5–1.6 (1.8 only for small decorative icons like `+`)
- **Fill:** none, always line-art
- **Default size:** 14px in the window chrome, 12–13px in sidebar/menu, 16px in CTA buttons
- **Color:** always via `currentColor` — inherits from adjacent text
- Alignment: baseline with the text, **never** with extra vertical padding

### Key app icons

| Name                                     | Use                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder`                                 | Folder                                                                                                                                                                                                                                 |
| `folder-plus`                            | Create subfolder (FolderMenu → "New folder…" / `NewFolderDialog`)                                                                                                                                                                      |
| `folder-search`                          | Open an existing subfolder (FolderMenu → "Open subfolder…" / `OpenSubfolderDialog`)                                                                                                                                                    |
| `folder-tree`                            | Browse project files (Topbar button + Explorer pane header, T100)                                                                                                                                                                      |
| `kanban-square`                          | Roadmap board (FolderMenu + session Context menu + Topbar button)                                                                                                                                                                      |
| `git-pull-request`                       | PR Stack Canvas (FolderMenu + Topbar button + the canvas' own header)                                                                                                                                                                  |
| `git-pull-request-arrow`                 | Open the repo's Pull requests page on GitHub (Topbar button, only when `origin` is on github.com)                                                                                                                                      |
| `message-square`                         | Unresolved review threads on a PR Stack card (T275 — readiness chip at `full`, identity-row badge at `compact`); Review pane companion link                                                                                            |
| `git-branch`                             | Branch badge (git folder) / repo-group header                                                                                                                                                                                          |
| `chevron-right`                          | Collapse folder / repo-group (rotates 90° when open)                                                                                                                                                                                   |
| `recycle`                                | Workspace GC: the Cleanup summary line, the single footer pill (replaces `trash-2` + `container` there) and the first-cycle banner. The spec's ♻ glyph, as a Lucide icon (§5 forbids text glyphs); the takeover header keeps `trash-2` |
| `circle-check` / `circle-help` / `lock`  | Cleanup bucket icons: Ready to clean / Needs review / In use — repeated in the legend, group headers, badges and list rows so a bucket never relies on colour alone                                                                    |
| `check` · `square-check` · `list-checks` | Checked-block badge (`check`, 16px badge) · checked list row (`square-check`) · "Select all in repo" on narrow regions (`list-checks`, icon-only 22px Ghost)                                                                           |
| `triangle-alert` · `rotate-ccw`          | Failed block / partial-failure pill / warning callouts (`triangle-alert`) · Retry a failed item (`rotate-ccw`)                                                                                                                         |
| `bookmark` · `sparkles`                  | Keep (`bookmark`) and Ask for an opinion (`sparkles`) on the Cleanup surface — new there; `package-minus` stays Dehydrate and `trash-2` stays Remove                                                                                   |
| `layout-grid` / `list`                   | Cleanup Map / List toggle                                                                                                                                                                                                              |
| `plus`                                   | New session, add folder / add file-folder to chat (Explorer pane row, T100)                                                                                                                                                            |
| `search`                                 | Global search / Explorer pane search bar (recursive finder, Cluster F)                                                                                                                                                                 |
| `loader-2`                               | Loading spinner (in-flight search in the Explorer pane, `animate-spin` — Cluster F)                                                                                                                                                    |
| `terminal`                               | CWD indicator                                                                                                                                                                                                                          |
| `square-terminal`                        | New folder terminal (FolderMenu + rows of the "Terminals" subgroup) / Copy --resume command                                                                                                                                            |
| `split-square-vertical`                  | Split the terminal                                                                                                                                                                                                                     |
| `maximize-2`                             | Fullscreen / maximize a helper-stack pane (pane header, §6 Pane header)                                                                                                                                                                |
| `minimize-2`                             | Restore a maximized helper-stack pane back to the normal split (pane header, §6 Pane header)                                                                                                                                           |
| `panel-left-close` / `panel-left-open`   | Collapse / show the left sidebar (Topbar button — §6 Collapse sidebars)                                                                                                                                                                |
| `panel-right-close` / `panel-right-open` | Collapse / show the right auxiliary panel (Topbar button — §6 Collapse sidebars)                                                                                                                                                       |
| `x`                                      | Close                                                                                                                                                                                                                                  |
| `more-horizontal`                        | Overflow menu                                                                                                                                                                                                                          |
| `edit-3`                                 | Rename                                                                                                                                                                                                                                 |
| `pencil-line`                            | Rename folder alias (FolderMenu → "Rename…" / `RenameFolderDialog`)                                                                                                                                                                    |
| `tag`                                    | Auto-alias from branch (FolderMenu → "Use branch as name" toggle)                                                                                                                                                                      |
| `copy`                                   | Duplicate / per-code-block copy button (Markdown viewer, hover-revealed) / "Copy file" toolbar action (Markdown pane)                                                                                                                  |
| `external-link`                          | Open in new tab                                                                                                                                                                                                                        |
| `file-text`                              | Markdown pane header / file row in the Explorer pane / "Copy transcript path" (§6)                                                                                                                                                     |
| `notebook-text`                          | Memory pane header / "Project memory" item (FolderMenu)                                                                                                                                                                                |
| `arrow-up-right`                         | Open the source session of a digest (Memory pane timeline, T79)                                                                                                                                                                        |
| `file-plus`                              | New markdown file (Explorer pane header — Cluster E, creates + opens in edit mode)                                                                                                                                                     |
| `pencil`                                 | Markdown pane → enter edit mode (view→edit toggle)                                                                                                                                                                                     |
| `save`                                   | Markdown pane → explicit save (edit mode; ⌘/Ctrl-S)                                                                                                                                                                                    |
| `rotate-ccw`                             | Restart session (context menu — kills and respawns the `claude` process)                                                                                                                                                               |
| `archive`                                | Archive                                                                                                                                                                                                                                |
| `archive-restore`                        | Unarchive (restore an archived session)                                                                                                                                                                                                |
| `trash-2`                                | Delete                                                                                                                                                                                                                                 |
| `clock`                                  | History, recents                                                                                                                                                                                                                       |
| `cloud`                                  | Cloud/bridge session (conversation lives on claude.ai, no resumable local transcript)                                                                                                                                                  |
| `check`                                  | Confirmation, checkbox, agent completed (`done`) / transient "copied" state on a `copy` button                                                                                                                                         |
| `bot`                                    | Subagent (agent row nested under the session) / agent-control badge on the folder row                                                                                                                                                  |
| `puzzle`                                 | Extension-origin badge (theme picker swatch, T137)                                                                                                                                                                                     |
| `users`                                  | Teammate count chip (leader row) / icon on the synthetic "Team session-… · N" header                                                                                                                                                   |
| `corner-down-right`                      | Nesting connector (agent → parent session / teammate → leader)                                                                                                                                                                         |
| `eye`                                    | Visibility state (filters, hide toggles) / Markdown pane → exit edit mode (edit→view toggle) / file row in the Explorer pane → "View file" (Cluster G, opens/edits any text file)                                                      |
| `corner-down-left`                       | Enter / return hint                                                                                                                                                                                                                    |
| `settings`                               | Settings                                                                                                                                                                                                                               |
| `cpu`                                    | Model (footer / status bar)                                                                                                                                                                                                            |
| `gauge`                                  | Context % (footer / status bar)                                                                                                                                                                                                        |
| `zap`                                    | Effort (footer / status bar) · PR Stack card: the staging-tip chip                                                                                                                                                                     |
| `timer`                                  | PR Stack card: the bare auto-merge armed marker beside the age                                                                                                                                                                         |
| `dollar-sign`                            | Session cost (footer / status bar)                                                                                                                                                                                                     |
| `triangle-alert`                         | Near `/compact` (footer — `exceeds200k` or context ≥95)                                                                                                                                                                                |
| `inbox`                                  | Inbox rail ("Needs you" queue — minimized strip of the 4th column + "Open approvals" palette action)                                                                                                                                   |
| `image`                                  | Pasted-images pill/popover (footer — gallery of screenshots pasted into the session)                                                                                                                                                   |
| `reply`                                  | Re-attach an image (re-injects the screenshot into the running session's prompt)                                                                                                                                                       |
| `volume-2`                               | Preview a voice (Settings → Voice → VOICES row — speaks the phrase in the voice already in use)                                                                                                                                        |
| `volume-x`                               | Nothing was spoken (Settings → Voice — the `dropped` / `stopped` outcome of a Test or a per-voice preview)                                                                                                                             |
| `list-checks`                            | Mission progress — the Topbar "Step N of M" pill's leading glyph (T370, Mission v3, §6 "Mission progress"); swaps to `check` once the headline is done or the mission delivered                                                        |
| `log-in`                                 | Mission progress — a child session row's in-app "Go to session" action (Mission v3, §6 "Mission progress"; replaces `external-link` there)                                                                                             |
| `contrast`                               | Mission progress — the step rail's `waiting` glyph (◐, Mission v3)                                                                                                                                                                     |
| `undo-2`                                 | Mission progress — the step rail's `left-behind` glyph (↩, Mission v3)                                                                                                                                                                 |
| `circle-check`                           | Mission progress — the step rail's `done` glyph (✓ hollow, Mission v3)                                                                                                                                                                 |
| `flag`                                   | Mission progress — the popover footer's "End mission…" button (Mission v3)                                                                                                                                                             |

### Novelty dot (on an icon button)

Visual indicator attached to an icon button to signal new content or an
update. Distinct from the amber attention dot (used in `needs-input`).

- **Shape:** 6px circle, `border-radius: 100%`, no border.
- **Color:** `--color-accent` (purple). Static — **do not animate**.
- **Anchor:** top-right corner of the button (`top: 3px`, `right: 3px`), `position: absolute`, `pointer-events: none`.
- **Semantics:** informational / "there's something new to see" (e.g., a new Claude Code version available).
  Distinct from the `--color-warning` attention dot (animated `.anim-attention-dot`, used in
  `needs-input`) which means "action required / needs input".

---

## 6. Components

### Buttons

| Variant | Background     | Color          | Border                 | Use                                                                                                                           |
| ------- | -------------- | -------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Primary | `--accent`     | `--accent-ink` | none                   | Single CTA per screen                                                                                                         |
| Soft    | `--surface`    | `--text`       | `--border`             | Frequent secondary actions                                                                                                    |
| Ghost   | transparent    | `--text-2`     | `--border`             | Cancel, tertiary actions                                                                                                      |
| Danger  | transparent    | `--red`        | `rgba(239,111,91,0.3)` | Destructive (delete, discard)                                                                                                 |
| Success | `--green-soft` | `--green`      | `--green-line`         | Reclaim / positive bulk actions — the same triple as the Badge "Success" row above (stop running containers, sweep worktrees) |

**Padding:** `7px 14px` · **Border-radius:** `5px` · **Font:** Inter 12.5 / 500 · **Internal gap (icon+text):** `7px`

Hover: lighten the background. Active: scale(0.98). Disabled: opacity 0.4.

**Icon-only size:** every icon-only trigger in the app (TakeoverShell's close button, a bare refresh glyph, a per-row Park/Close) already converges on one box before this line was written: `width`/`height` `22px`, `padding: 0`, `border: transparent` (unlike the text-bearing sizes above, an icon-only trigger never shows a border — it is a bare glyph until hover), radius/font/hover/active/disabled otherwise unchanged, icon centered, no internal gap (there is no second element to gap against). Any of the 5 variants may render icon-only at this size — the variant still decides the icon/background color and the hover fill — Ghost is the common case.

### Form controls — canonical components

> **Rule:** these four controls are **single components** in `components/ui/`.
> Never reimplement a toggle, an option group, inline help text, or a button —
> use the component. A visual tweak changes in one place and reflects across the whole app.
> (It was scattered reimplementation that let the active/inactive state and the help
> text drift apart between screens — and, before `Button` existed, let five different
> hand-rolled paddings answer to the same "Buttons" spec above.)

**`Button`** — the **only** clickable action trigger (a command, not a
navigation link or a `SegmentedControl` choice). Implements the 5 variants and
the icon-only size documented in "Buttons" above exactly — `variant`
(`primary`/`soft`/`ghost`/`danger`/`success`, default `soft`) and `size`
(`md`/`icon`, default `md`). Content is a default slot (an optional leading
icon + label for `md`, a bare icon for `icon`), so a call site keeps its own
loading-spinner-swap and disabled logic; the component only owns the box
(padding, radius, font, gap, hover/active/disabled treatment, per-variant
color triple). Replaces every hand-rolled `<button class="...">` that renders
a boxed action (a toolbar "Scan now", a modal's Cancel/Confirm pair, a
header's icon-only refresh) — it does **not** replace a bare text link
(no box, no border — e.g. "Revoke", "Clear selection") or a per-row inline
pill inside a dense list item, which stay their own smaller, established
idiom.

**`ToggleSwitch`** — the **only** boolean toggle (on/off / true/false). Slider
track + knob; the track fills with `--accent` when on (knob `--accent-ink`),
and turns `--surface-2` when off (knob `--text-3`, border `--border-2`). The
track's fill communicates the state **without relying on color alone**. Size
`34×20`, knob `14`. Disabled: `opacity 0.4`. Replaces any "Enabled/Disabled"
pill and any homemade switch.

**`SegmentedControl`** — the **only** "pick 1 of N" group (radio). Selected
option: `--accent-soft` / text `--accent` / border `--accent-line`
(= Badge Accent, §9 "selected"); idle: `--surface` / `--text-3` / `--border`.
**One deliberate exception:** the Scheduler's Permission-mode control renders
its `act` option in the danger triple instead — see "Scheduler (takeover,
T291)" § "The one red `SegmentedControl` selection in the app" below.
Optional tri-state (`allowDefault` → neutral "Default/Inherit" pill that maps
to _unset_; `inheritedValue` → the inherited option gets an accent only on the
border, `--text-2`). Sizes `md` (28px) / `sm` (26px). **Disabled** (`disabled`):
`opacity 0.4` + `cursor-not-allowed`, non-interactive — same treatment as
`ToggleSwitch` (used e.g. by the hook responder's mode selector when the
hooks are off, see Integrations). **HTML selects are forbidden
in production UI** when the options fit in buttons — they look out of place
and off-system; convert to `SegmentedControl`.

Extras (used by the provider picker): each option can carry an **`icon`** (a
lucide glyph before the label, `11px` at `sm` / `13px` at `md`, `gap` 5–6px); a
**`#trailing`** slot renders a **non-selectable** action (e.g. "Manage…") **outside**
the `role="radiogroup"` but in the same wrap. If the current value isn't among the
options (legacy config, a newer Claude version, a deleted endpoint still
referenced), the component **renders a synthetic pill** with the raw value so
the active state never shows as "nothing selected".

**`SettingHint`** — the **only** "help text" (the description line below a
label). Always `--text-3` (never `--text-4`, which fades out in low-contrast
themes), `11px` / line-height `1.5` (`sm` = `10.5px`). `--text-4` stays
reserved for ultra-secondary, non-prose meta: paths, `tabular-nums` counts,
session timestamps, chart axes, separators, and icons.

### Keyboard shortcuts (`<kbd>`)

- Font: JetBrains Mono 10.5px
- Background: `--surface-2`
- Border: 1px `--border`
- Border-radius: 3px
- Padding: `2px 6px`
- Line-height: 14px
- Always use the **Mac symbol** (`⌘`, `⇧`, `⌥`, `⌃`, `↩`, `⌫`) — we assume macOS as primary, but the app supports Linux/Win via Electron

Examples: `⌘K` (search), `⌘N` (new session), `⌘⇧P` (switch project), `F2` (rename), `⌫` (delete).

**Shortcut table** (renderer; the app's native menu mirrors the same ones):

| Shortcut           | Action                                                                                                                                                                                                                     | Scope    | Notes                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `⌘K`               | Open command palette                                                                                                                                                                                                       | global   | Also accepts `⌘⇧P` to open pre-filtered to projects                                                                                                                                                                 |
| `⌘N`               | New session in the current folder                                                                                                                                                                                          | global   | Spawns `claude` in `sessions.selectedPath`                                                                                                                                                                          |
| `⌘O`               | Add folder                                                                                                                                                                                                                 | global   | Opens `AddFolderDialog`                                                                                                                                                                                             |
| `⌘R`               | Rename selected session                                                                                                                                                                                                    | global   | Overrides Chromium's default reload; reload moves to `F5`                                                                                                                                                           |
| `⌘⇧R`              | Resume last session                                                                                                                                                                                                        | global   | Most recent by `lastActivity`                                                                                                                                                                                       |
| `⌘⇧A`              | Expand/collapse the Inbox rail                                                                                                                                                                                             | global   | 4th column "Needs you"; same helper as the Topbar button. **Never hides** — `minimized`/`hidden` always expand                                                                                                      |
| `⌘B`               | Hide/show the left sidebar (folders/sessions) — "full screen for the terminal"                                                                                                                                             | global   | Owned by the native menu (`&View`), so the accelerator is consumed **before** xterm (same as `⌘N`/`⌘K`); the renderer double-binds as a fallback. Also reopens via the Topbar's `PanelLeft` button (always visible) |
| `⌘⌥B`              | Hide/show the right auxiliary panel (helper-stack / split)                                                                                                                                                                 | global   | Same scheme (`&View` menu + fallback). Hides **even with panes**; visual no-op with no panes. Reopens via the Topbar's `PanelRight` button (visible whenever there are panes)                                       |
| `⌘W`               | Close selected session — **unless the terminal is focused**, in which case the shortcut is forwarded to xterm/PTY (becomes `\u0017`, used by programs like `nano` to delete the previous word). `⌘Q` still closes the app. | global   | Suppressed by `enabled: () => !terminalFocused.value` (T-4.5)                                                                                                                                                       |
| `⌥←` / `⌘[`        | Back to the previous session you viewed (browser-style history; also mouse button 3 — back)                                                                                                                                | global   | Native menu (`&Session`). Linux/Win: the renderer stops `⌥←` in the capture phase so xterm can't eat it. macOS: renderer fallback. From Folder View/a takeover: back to the session you left                        |
| `⌥→` / `⌘]`        | Forward through the session history after a Back (also mouse button 4 — forward)                                                                                                                                           | global   | Same scheme. Skips closed sessions; silent at the ends; 50 entries, in memory only. `⌥←`/`⌥→` no longer reach the terminal                                                                                          |
| `↑ / ↓ / ← / →`    | Sidebar navigation                                                                                                                                                                                                         | sidebar  | Only when the sidebar has focus                                                                                                                                                                                     |
| `Esc`              | Cancel edit / close overlay                                                                                                                                                                                                | modal    | Priority: palette > popover > input                                                                                                                                                                                 |
| `F2`               | Rename (Linux/Win)                                                                                                                                                                                                         | global   | Alias for `⌘R`                                                                                                                                                                                                      |
| `⌘C` / `⌃⇧C`       | Copy terminal selection                                                                                                                                                                                                    | terminal | Only with a selection; reads `term.getSelection()` (xterm's selection isn't a native DOM selection). On Mac, `editMenu` may intercept `⌘C` before xterm — see `menu.ts`                                             |
| `⌘V` / `⌃⇧V`       | Paste into the terminal                                                                                                                                                                                                    | terminal | Via `term.paste()` — respects _bracketed paste_, so a multi-line paste doesn't auto-submit in the Claude TUI                                                                                                        |
| `⇧↩`               | Line break (without sending)                                                                                                                                                                                               | terminal | Sends `\u000a` (LF, = Ctrl+J) to the PTY — Claude treats it as a newline; `Enter` alone (`\r`) sends. xterm's default ignores `Shift` and would send                                                                |
| `⌃⌫`               | Delete the previous word                                                                                                                                                                                                   | terminal | Sends `\u0017` (Ctrl+W) to the PTY; xterm's default for this chord is `\b`, which the Claude TUI ignores                                                                                                            |
| `⇧⌫`               | Delete the previous character                                                                                                                                                                                              | terminal | Sends `\u007f` (DEL), same as `Backspace`; xterm's default (`\b`) did nothing                                                                                                                                       |
| `⌘=` / `⌘−` / `⌘0` | Terminal font: bigger / smaller / reset                                                                                                                                                                                    | terminal | `⌃` on Linux/Win. `settings.setFontSize` (8–32); the watcher propagates it to every live terminal                                                                                                                   |

Shortcuts scoped to `terminal` are handled by `installTerminalKeymap`
(`src/renderer/src/lib/terminalKeymap.ts`) via xterm's single
`attachCustomKeyEventHandler` — **not** by the native menu — and only
fire while the terminal (main or helper) is focused.

### Session status

| State           | Visual                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **active**      | 6px green dot `--green` + pulsing `--green-soft` halo (1.8s loop)    | Only the session currently "running" (task-state `working`)                                                                                                                                                                                                                                                                                                                                                                                 |
| **needs-input** | 6px amber dot `--warning` + soft blink (`attention-blink`, 1.2s)     | **Blocked on an approval/permission** — requires human action (hook `Notification:permission_prompt`). **Doesn't decay on its own** like `idle` does by timer: it only clears on the next `Stop`/`working`. Must sort to the top of the list.                                                                                                                                                                                               |
| **failed**      | 6px red dot `--red`                                                  | Turn or session failed (`StopFailure` or `pty:exit ≠ 0`).                                                                                                                                                                                                                                                                                                                                                                                   |
| **stuck**       | **Ring** 6px `--red` (outline, no fill, no animation)                | **New gap from T67 §2.** A session in `working` with no transcript growth for **≥3min** (threshold N of the canonical `fleet-state.ts` classifier) — the PRD's "red-soft" is the **ring** (distinguishes it from `failed`, which is a **solid** red dot). Previously existed as an unnamed gray dot. **Aggregation:** a session with a live subagent/sidechain never goes stuck — it counts as `working`.                                   |
| **completed**   | `check` icon 11px `--text-4` in place of the dot                     | Session **ended** (`SessionEnd`/`pty:exit 0`) — distinct from `idle` (which is still alive and warm). Ephemeral state (doesn't persist on reload).                                                                                                                                                                                                                                                                                          |
| **idle-recent** | Solid 6px dot `--text-4`                                             | Recent session (< 24h)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **idle-old**    | 4px outline ring `--text-4`, opacity 0.55                            | Old session, the whole row goes to 62% opacity                                                                                                                                                                                                                                                                                                                                                                                              |
| **cloud**       | `cloud` icon 11px `--text-4` in place of the dot; row at 62% opacity | Bridge/cloud session with no locally resumable transcript (Claude Code 2.1.x). Doesn't fire `claude --resume` on click — opens the cloud status panel instead of the terminal.                                                                                                                                                                                                                                                              |
| **hibernated**  | `moon` icon 11px `--text-4` in place of the dot; row at 62% opacity  | **T119.** A session **at rest**: Harnu killed the `claude` process (~420 MB) after it went cold. **Not an error and not dead** — the conversation is intact on disk and clicking resumes it via `claude --resume`. Hence the faded treatment (`--text-4`, 62% opacity), **never** `--red`: red would signal failure, and the operator did nothing wrong. Precedes the dot chain — a session at rest has no task-state (nothing is running). |

Pulse animation — the halo is an `::after` ring animated with `transform` and
`opacity` only (compositor-only; a `box-shadow` animation repainted every frame).
`:where(.anim-pulse-dot)` sets `position: relative` at zero specificity, inside
`@layer components` (Tailwind v4 utilities are layered, and an unlayered rule would
beat them whatever its specificity), so a call site's `absolute` utility still wins. The ring is painted
**behind** the dot: `::after` (`z-index: -2`) sits under a static `::before` copy of the dot's own
colour (`background: inherit`, `z-index: -1`) inside the element's own stacking context
(`isolation: isolate`), so the halo never tints the dot — it only ever shows outside it. The ring's outer box is the dot + 4px each
side (the old `0 0 0 4px` spread); `--pulse-from` = dot ÷ (dot + 8) sets its start
scale (0.43 for the 6px default, 5px → 0.38, 8px → 0.5), and non-square elements
(the Inbox count badge) set `--pulse-from-x` / `--pulse-from-y`. The ring rests at
`opacity: 0`, so under `prefers-reduced-motion` (one 0.01ms pass, no fill) the dot shows no static halo.

```css
@keyframes pulse-ring {
  0%,
  100% {
    transform: scale(
      var(--pulse-from-x, var(--pulse-from, 0.43)),
      var(--pulse-from-y, var(--pulse-from, 0.43))
    );
    opacity: 1;
  }
  50% {
    transform: scale(1);
    opacity: 0;
  }
}
@layer components {
  :where(.anim-pulse-dot) {
    position: relative;
    isolation: isolate;
  }
}
.anim-pulse-dot::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: inherit;
  background: var(--green-soft);
  opacity: 0;
  pointer-events: none;
  z-index: -2;
  animation: pulse-ring 1.8s ease-in-out infinite;
}
.anim-pulse-dot::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: inherit;
  z-index: -1;
}
```

Attention blink (`needs-input` state) — opacity, not box-shadow, to read as
"blinking, needs you" without competing with the `active` green halo. Helper
`.anim-attention-dot` in `main.css`. Respects `prefers-reduced-motion` (§7).

```css
@keyframes attention-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
```

> Tokens: `needs-input` uses `--color-warning` (#c08a3e, §9), `failed` uses
> `--color-red` (#d1717c, §9), and `stuck` **reuses** `--color-red` on the `border` (ring),
> not the fill — all already exist, no new raw colors.

### Notifications (in-app toast + OS)

Background sessions are the whole point of the app — you're **not** looking at most
of them. The transitions that matter (a session asks for your attention, ends its turn,
or fails) fire a **focus-routed** notification:

- **Window focused** (you're inside Harnu) → **in-app toast** (bottom-right
  corner, §Toast), colored by state (needs-input = `warning`, completed =
  `success`, failed = `danger`) with an **"Open"** action that expands the folder and
  selects the session. Non-intrusive: it doesn't steal focus from another window.
- **Window unfocused** (you're away) → **native system notification**
  (`electron.Notification`), to pull you back in.

| Transition (edge)                                      | Notifies?                      | Title               |
| ------------------------------------------------------ | ------------------------------ | ------------------- |
| → **needs-input**                                      | yes (default)                  | "Needs your input"  |
| **working → idle** (end of turn, `Stop` hook)          | yes (default) — as `completed` | "Session completed" |
| → **completed** (`SessionEnd`/`pty:exit 0`)            | yes (default)                  | "Session completed" |
| → **failed**                                           | yes (default)                  | "Session failed"    |
| → working / stopped, or → idle not coming from working | never                          | —                   |

Rules:

- **Only on the edge** — a session that _stays_ in `needs-input` doesn't re-notify;
  a real re-block (`needs-input → working → needs-input`) is two edges,
  so it notifies again.
- **End of turn = `completed`** — when Claude finishes a turn the `Stop` hook
  drops it to `idle` (the sidebar dot **stays** `idle`, it doesn't turn green), but the
  `working → idle` edge fires a `completed` notification ("Claude is done,
  it's your turn"). Only counts when coming from `working`: `SessionStart`/`idle_prompt` →
  `idle` (prev ≠ `working`) does **not** notify. Governed by the same "Completed"
  switch.
- **Always shows you, but doesn't chime the one you're already looking at** — the **selected**
  session with the window focused still gets the **toast** (so you know the turn
  ended), but **without the sound**. Any other session (background, or window
  unfocused) plays the sound normally. In other words: the _chime_ is the "hey, look at
  that other session"; the toast for the one in front of you is just a silent confirmation.
- **Body** = `<folder alias> · <session summary>` (the `·` is a technical glyph,
  not translated — §8). Clicking focuses the app, **expands the folder** that owns the session,
  and selects the session.

Control in Settings → Integrations: a master "OS notifications" switch + three
per-state switches (Needs input / Completed / Failed) + a **"Sound"** switch
(plays a short bundled sound when notifying — except for the selected session with the
window focused, see the rule above; also on newer Claude Code versions; orthogonal
to the master, default ON), reusing the anatomy of the
Hook Bridge's switch/eyebrow. No new tokens — uses the already-
defined `--warning`/`--red`. Default: everything ON (opt-out), persisted in `localStorage`
(`om2tab.notify`).

**Safety confirms — sound + attention.** An **MCP control-server
confirm** (a mutation requested by an external agent — see "agent-action variant")
is a **safety cue**, not a convenience notification. When a
confirm **shows up parked** in the Approval Inbox (window unfocused → it didn't become the
focused modal), it **always** fires: the **chime** (`playNotificationSound()`, the same bundled
sound), **OS attention** (taskbar flash / dock bounce via
`requestAttention()`), and a clickable **native notification** (`notify({ activate:
'inbox' })` — clicking opens the Inbox). "Always" is literal: this rule is **independent**
of the per-state "OS notifications"/"Sound" switches — muting a session's
lifecycle notifications does **not** mute a safety confirm (granting or
denying a privilege to an external agent is the decision the operator can never lose
to inattention). No new token — reuses the bundled sound and the already-existing
attention primitives.

**Mission owes the operator — sound + attention + Activity (T373 S3, Mission v3
§3.12).** A mission that **starts owing the operator** something only they can
give fires the same pair as a safety confirm: the **chime**
(`playNotificationSound()`) and **OS attention**
(`window.api.requestAttention()`), plus **one Activity entry** (`kind:
warning`, bell only — no toast). Like a safety confirm it is independent of
the per-state "OS notifications"/"Sound" switches. The owed things are the
server's ordered `you` list: a **staged re-scope**, a **requested close**, an
**operator-owned blocker** (a merge, a key, a credential, a decision), **due
checks** (unticked checks on a reached step), **human steps** to confirm, and an
**imported end** to review. Rules (`lib/mission-cue.ts`, driven by the missions
store's existing 20 s poll — no per-mission timer):

- **Appear or grow only.** Each mission keeps one key per owed kind with its
  count (a blocker and a re-scope key on their reason / target, so a different
  blocker is a new key). A cue fires when a key **appears** or its **count
  grows** — due checks going 1 → 2 cue; 2 → 1, a tick, a resolution or any
  decrease never does. A later poll that sees the same keys stays silent.
- **Re-nudge every 30 min** (fixed, no Setting) while the mission still owes
  anything — the list as a whole, not per key. A mission that stops owing is
  forgotten; it never re-nudges.
- **Start/restart:** the first poll gives **one combined cue** for every
  mission already owed — never one per mission, never one per poll.
- **Only what a poll sees.** A blocker raised and cleared between two polls
  never cues.
- **Excluded:** pending **approvals** and a child's **needs-input** — the
  Approval Inbox and the task-state notifications already chime for them; a
  closed mission is gone from the list, so nothing fires after close. There is
  no draft kind: a dead legacy draft reads `active` + stale, and stale is not
  owed, so it never cues.
- **Copy** (`mission.cue.*`): one mission → "Mission “{title}” needs you:
  {what}", where `{what}` is the first owed item in words (the blocker's
  reason, "re-scope awaiting your approval", "delivered, awaiting your close",
  "2 due checks", …); clicking it opens the owner session (where the pill
  lives). Several → "{n} missions need you", with the titles as the
  description.

**Agent-opened pane alert (2026-07-13 agent-pane-routing design).** A pane an
agent opens (`open_file`, `spawn_terminal`, …) into a
folder the operator isn't currently looking at pairs the folder-row badge
above with a **native OS notification** — reusing `window.api.notify` end to
end (same seam as the state-transition table above), so the sound comes for
free and no new sound plumbing exists. Unlike the focus-routed table above,
this ALWAYS fires the native toast (never the in-app toast) — the trigger is
"is the target folder visible", not "is the window focused". Two anti-noise
guards keep it calm: it fires **only** when the target folder isn't visible,
and it **coalesces per folder** (a burst of 3 panes lands as one toast saying
"3", never three separate ones — a 1.5 s debounce window, mirroring
`byWorktree`'s own flush debounce in `stores/helpers.ts`). Clicking activates
the folder's **most recently active session** (`notify:activate`, unchanged
channel) — a pane belongs to a folder, not a session, so this is the
least-surprising target. No new token.

### Remote notifications (push)

Extends the notification funnel **off the machine** (remote-push spec): the
operator isn't always in front of Harnu — the edges that matter need to
reach the phone. The **same decision** in `decideNotification` that picks the
`os` channel (window unfocused) also fires a remote push to the configured
channels; a focused window (`toast` channel) **never** sends a push — if you're
at the machine, the phone buzzing is noise. A **parked MCP confirm** (a safety
cue, see above) also fires a push, like `needs-input`.

**Channels** (registered in Settings → **Remote notifications**, anatomy cloned from
the Endpoints pane — cards + an add form):

- **ntfy** — the recommended path to the phone: the user installs the ntfy app,
  subscribes to a secret topic, and pastes the URL (`https://ntfy.sh/topic`). We publish
  JSON at the server root (UTF-8 titles survive; HTTP headers are latin-1),
  with high priority (4) for `needs-input`/`failed` and an emoji tag per type
  (⚠️ / ✅ / ❌). Self-hosted works — the origin comes from the pasted URL.
- **Webhook** — generic POST JSON (`{event, title, body, text, content}` — the
  `text`/`content` fields make Slack and Discord incoming-webhooks work without
  a dedicated type).

**Controls** (the operator's ask: turn on/off, add more, disable,
pause): a **master** switch + a **pause** row (30 min / 1 h / 8 h, with "Resume"
and the return time in `--warning`), a **per-channel** toggle, per-event-type
checkboxes (Needs your input / Completed / Failed) per channel, a **"Send
test"** button per channel and on the draft (inline Delivered/Failed feedback, no toast).

Persistence: `<userData>/push.json` (main-side, `0600` — the channel token never
reaches the renderer outside the explicit editor), atomic tmp+rename write. The HTTP
goes out **only from the main process** (`push:send` fire-and-forget — a slow relay never
blocks the hook stream). No new visual tokens — the pane reuses the anatomy of
the Endpoints pane's card/eyebrow/input and the canonical
`ToggleSwitch`/`SegmentedControl`.

**StopFailure reason badge (stopfailure-badges spec).** When a session enters
`failed` for a known API reason (rate-limit / overload / billing), the row
shows a short badge next to the title — `Rate-limited · resets in 12m` (countdown from
`resets_at`), `Overloaded`, or `Billing` — distinct from the generic red dot.
`rate_limit`/`overloaded` use `--warning`, `billing` uses `--red`; no new token.
Unknown `error_type` → no badge (keeps today's red dot). The Hook Bridge
remains a **pure observer** (only reads the StopFailure body, never decides).

**Dead synthetic — boot failed.** An agent-created synthetic session
(MCP `create_session`) that **never turned into a PTY/transcript** within the boot
deadline (120s) is marked **`failed`** by the reaper, with `failureReason: 'boot_timeout'`. It
leaves the Fleet board's **WORKING** section (moves to the `errored` bucket) and
the dot's `working` reading, and shows the **solid red dot `--red`** (same as §6 "Session
status" `failed`) + a **`Failed to start`** badge (`--red` variant, same anatomy
as the StopFailure badge — **no new token**, reuses `--red`/`--red-soft`). It never
hangs around as "working" (that was the symptom of BUG-23: eternal rows reading "New session ·
working"). A dead synthetic's **Context menu** gains two actions at the top:
**Retry boot** (`RotateCcw`, re-enqueues the boot in background) and **Dismiss** (`X`,
destructive `--red`, removes the row — there's no JSONL on disk to delete).

**Hook responder — interceptor mode (hook-responder-dispatch spec).** The Hook
Bridge, a pure observer by default, gains a 3-state **mode selector** on the
Settings **Interceptor** tab (`SegmentedControl` off/shadow/active; the
Hook Bridge switch itself — Session state hooks — lives in General → Integrations):
`off` = pure observer (legacy); `shadow` (default) = runs the
resolvers and **logs** what it would decide, but responds `200 {}` (never alters the
session); `active` = serializes the decision (allow/deny/ask, injected context) that
Claude Code obeys. Depends on the hooks: with the Hook Bridge off, the selector
is **disabled** (the `SegmentedControl` disabled state, §6) with a hint. Technical
nouns (`shadow`, `active`, `allow`, `deny`, `ask`, `hook`, `tool call`,
`PreToolUse`) **stay untranslated** (§8); the `active` warning has a calm-
reversibility tone ("start in shadow to check"). No new token — reuses
`--accent-soft`/`--accent`/`--accent-line` (selected) and `--text-disabled`
(disabled).

**Trust ramp — the `active` panel.** Selecting `active` **reveals inline,
right below the selector**, a trust-ramp panel (`border-border` /
`bg-surface`, radius `6px`, padding `12px`) that decides **where** the gate bites. It's
the twin of the MCP allowlist (see "### Control server (MCP)") — same anatomy,
same tokens. Content:

- **"Trust all folders" toggle** (canonical `ToggleSwitch`) at the top, with a calm hint
  (`SettingHint`): flips the gate on for **all** folders at once (the
  fleet-active escape hatch). Turning it off returns to per-folder scope without losing the individual flags.
- **"Intercept per folder" eyebrow** (same eyebrow style as the other Settings
  blocks: Inter 11px/500 UPPERCASE, `letter-spacing 0.06em`, `--text-3`).
- **Ramp list:** one row per **pinned folder** (`border-border` / `bg-surface`,
  radius `6px`, padding `8px 10px`) — alias + mono path (`--text-4` `11px`) on the
  left, `ToggleSwitch` on the right, toggling the `interceptActive` flag.
  With "Trust all folders" on, the toggles are **disabled** and read as on.
- **Empty state (AC13):** when **no** folder is on the ramp **and** Trust-all
  is off, a `--text-4` `12px` text — "No folders intercepted yet — add one below
  or turn on Trust all folders." — makes clear that **nothing is being held yet**
  (never a silent no-op).
- **"Review shadow log":** an `--accent` text link (`hover opacity 0.8`) that opens
  the Approval Inbox (the "Would-have" tab is the interceptor's own preview).

**Sentinel — auto-deny.** A safety net above the interceptor: a resolver that
**auto-DENIES** a small, conservative set of catastrophic commands (`rm -rf /`,
`dd` to disk, `mkfs`, fork bomb, `chmod 777 /`, force-push to `main`/`master`,
`curl | sh`) **before** the Approval Inbox holds them. Only acts in a folder's `active`
on-ramp mode (respects the ramp); in `shadow`/off-ramp it only logs a "would-deny" in the
"Would-have" tab. It's **deny-only** (never grants anything) and conservative (a false positive costs a
retry, never data). When it denies, it fires a **`danger` toast** (`--red`/`--red-soft`,
title "Blocked a dangerous command" + the reason) + OS attention — so you know _why_
a command didn't run (never silent magic). Each block shows up in the
"Would-have" tab (`by:'sentinel'`).

Technical nouns (`shadow`, `active`, `tool call`, `worktree`) stay untranslated.
No new token — reuses `--accent`/`--accent-soft`, `--text-3`/`--text-4`,
`--border`/`--surface`, and the canonical `ToggleSwitch`/`SettingHint`.

### Bounded list (settings pane)

A row list inside a Settings pane that can grow past a handful of entries lives in a
**bounded scroller**, never at full length. The Settings dialog is a fixed
`min(80vh, 720px)` (§4), so an unbounded list does not make the pane taller — it pushes
every section under it below the fold, which reliably means the settings that matter
most become the hardest to reach.

- **Container:** `max-height: 280px` (§4 → Layout dimensions), `overflow-y: auto`, and
  the shared `.scrollable` class from `main.css` for the scrollbar — never a bespoke
  scrollbar, never a locally invented height.
- **Rows** keep their normal anatomy (`--surface`, `padding: 8px 10px`,
  `border-radius: 6px`, `gap: 4px`) and carry `shrink-0` so a long list does not
  compress them.
- **Keyboard:** the container is `tabindex="0"` with `role="group"` + an `aria-label`,
  so it can be scrolled without a mouse; the rows' own buttons stay in the tab order
  and nothing inside traps focus.
- **The selected row must stay findable.** A bound means the current selection is
  usually off screen, so a bounded list that carries a selection owes the operator
  **both** a summary line above it naming what is selected **and** a scroll-into-view
  on open (and whenever the selection changes).
- **Disclosures do not go inside it.** A row that explains why something is
  unavailable belongs _under_ the scroller, always visible — buried at the bottom of a
  scroller it would never be read.

First use: the VOICES list in the Voice pane (28 rows). Reuse this shape rather than
inventing a second one.

### Voice (Settings → Voice)

Dedicated **Voice** tab of the Settings dialog (`VoicePane.vue`) — a peer of the other
tabs via `ui.dialog === 'settings'` + `activeTab === 'voice'`, entering the `tabs` array
right after **Remote notifications**, because voice is a notification channel and not a
feature of its own. It is the interruptor for the engine T237/T241/T238 already built:
pick an engine, download the offline voice, choose which voice speaks, decide what it
says, and decide which sessions may use it. **No new token, no new component** — every
control below already exists (`ToggleSwitch`, `SegmentedControl`, `SettingHint`, the
Inputs frame, the ghost/accent buttons, `--accent-soft` for a progress fill).

A second, smaller surface lives in **General → Notifications**: one `ToggleSwitch`
directly under **Sound**, anchored `set-voice`. That is where voice is _discovered_ —
a sibling of the chime. It turns the engine on and nothing else: it never starts a
download, and its `SettingHint` points at this tab for everything else.

```
+---------------------------------------------------------------------+
| Speak notifications out loud                              [ o--]     |
| Off by default. Turn it on and Harnu reads what happened...           |
|                                                                      |
| ENGINE                                            <- eyebrow         |
|  [ System command ][ Built-in - Kokoro ]          <- SegmentedControl|
|  Command  [ spd-say -w                      ]           [ Test ]     |
|                                                                      |
|  or, with Kokoro selected and nothing downloaded:                    |
|  ~119 MB, once. Nothing is downloaded until you press Download.      |
|  kokoro-js Apache-2.0 - phonemizer embeds espeak-ng (GPL-3.0)        |
|                                          [ Download the voice ]      |
|  ############--------------  61.2 MB / 119 MB   model    [ Cancel ]  |
|                                                                      |
| VOICES                                            <- eyebrow         |
|  In use: Heart                                                       |
|  +----------------------------------------------------------- max   |
|  | Heart         en-US  A    511 KB   In use   [ Preview ]    280px  |
|  | Michael       en-US  C+   511 KB            [ Get ]        scroll |
|  | Bella         en-US  B-   511 KB            [ Use ]           v   |
|  +------------------------------------------------------------------+
|  pt-BR                      Not available - English only  (disabled) |
|  * Speaking...                                    <- probe line      |
|  28 voices - 2 languages - 1 downloaded                              |
|                                                                      |
| WHAT IT SAYS                                      <- eyebrow         |
|  [x] Needs input   [x] Completed   [ ] Failed    <- notifyPrefs      |
|  Phrase  [ {folder} - {session} {event}     ]           [ Test ]     |
|  -> "harnu - feat t216 is waiting for you"                            |
|  v Nothing was spoken - voice is muted.           <- probe line      |
|                                                                      |
| SESSIONS                                          <- eyebrow         |
|  Let sessions speak                       in every folder  [ o--]    |
|  Off means each folder decides for itself.                           |
|  Folders with exceptions:                                            |
|    acme        ~/w/acme           [ On ][ Off ] (Default)            |
|    sandbox     ~/w/sandbox        blocked for agents                 |
|                                        [ Clear exceptions ]          |
|                                                                      |
| Disk  93.5 MB in ~/.config/Harnu/voice-kokoro          [ Remove ]     |
+---------------------------------------------------------------------+
```

**Master switch** — a `ToggleSwitch` in a bordered `--bg` card at the top, the same
anatomy as the Remote-notifications master switch. It mirrors the General-tab toggle;
both write the same `enabled`. **Turning it on never starts a download** — that is a
product rule, not an implementation detail, and the pane states it in words.

**ENGINE** — a `SegmentedControl` with two options: **System command** (nothing to
download) and **Built-in — Kokoro**. Selecting Kokoro does **not** fetch anything
either; with nothing installed the pane shows the size, the destination directory and
the licence line, and a single accent **Download the voice** button. While a download
runs, the button is replaced by a progress row: a 4px `--surface-2` track with an
`--accent` fill (`width` in %, `transition: width var(--dur) var(--ease)`), the
`received / total` byte counts in `tabular-nums` `--text-3`, the current phase, and a
ghost **Cancel**. Cancelling leaves nothing behind (that is the download's own
contract, T241) and the pane returns to the pre-download state.

Under **System command**, the Inputs frame holds the TTS command (`font-mono` 12px,
main-owned via `speechCommandGet`/`speechCommandSet`) and a ghost **Test** button.

**VOICES** — one row per voice, **never per model**: the 92 MB model is shared
infrastructure that downloads once and then disappears from the UI, while each voice is
a separate ~511 KB file. Row shape is the bundled-skills row (`--surface`,
`padding: 8px 10px`, `border-radius: 6px`, `gap: 4px`): name in `--text` 12.5px with the
voice id in `font-mono` `--text-4` 11px underneath, then locale + upstream grade + size
as `--text-3` 11px, then the action — an **In use** badge, a ghost **Get** (downloads
just that voice), a ghost **Use** (`play` icon), or a ghost **Preview** (`volume-2`) on
the voice already in use. The footer line counts voices, languages and how many are
downloaded.

The catalog is 28 rows, so it lives in the **bounded list** documented above: a
280px `.scrollable` container, an **In use: {name}** line above it that stays visible
whatever the scroll position, a scroll-into-view onto the selected row when the pane
opens or the voice changes, and the pt-BR disclosure kept _outside_ the scroller.

**Use both selects and speaks.** The row's icon has always been a `play`, and a play
that plays nothing is the same invisible silence the probe line below exists to fix.
There is no preview-without-selecting: the engine reads the chosen voice from the
prefs at utterance time and takes no per-utterance override, so a preview of a voice
you have not chosen would be a lie about which voice you heard.

**pt-BR is a visibly disabled row, never a missing one.** `kokoro-js` hardcodes every
voice to `en-us`/`en-gb`, so Portuguese would come out as English phonemes over
Portuguese spelling. The row renders with the documented disabled treatment (opacity
0.45, non-interactive) and carries the reason inline (`voice.kokoro.englishOnly`) —
downloading more does **not** unlock it. Selling a language that does not work is worse
than not offering it.

**WHAT IT SAYS** — the three event toggles are the **existing** `notifyPrefs`
`needsInput` / `completed` / `failed`, rendered here as the same `ToggleSwitch` row the
General tab uses. Voice rides the notification decision, so it inherits those toggles
rather than inventing a second set. Below them, the **phrase template**: an Inputs-frame
`font-mono` field accepting `{folder}`, `{session}` and `{event}`, a live preview line
(`--text-3` 11px, prefixed `→`) and a ghost **Test** that speaks the preview. The
template is the point of the feature — a chime already tells you _something_ happened;
only the phrase tells you _which session_ and _what_.

**SESSIONS** — the `speak` verb's gate, rendered as **resolved state, never as
materialised inheritance**. A `ToggleSwitch` sets the global default; flipping it writes
`global` and nothing else, so a folder muted weeks ago stays muted. Below it, the
**exceptions list**: only folders that carry an explicit value, or that are blocked for
agents, get a row — each with a tri-state `SegmentedControl` (`allowDefault` → the
neutral **Default** pill = unset/inherit; `inheritedValue` → the inherited option keeps
the softer `INHERITED` treatment, an accent border with no fill). That contrast is the
whole audit surface: an inherited "on" and an explicit "on" must not look identical.
A folder **blocked for agents** renders silent-and-locked — the control is disabled, a
`ban` icon + `--text-4` reason replaces it, and the global cannot override it. A ghost
**Clear exceptions** removes every per-folder override and leaves the global untouched;
it is hidden when there is nothing to clear.

**Two disclosures, both there because the alternative is an unexplained silence.**
Voice rides the notification decision, so with the **OS-notifications master
switch off** nothing is ever spoken — the WHAT IT SAYS block then shows a
`--red-soft` notice saying so and pointing at General → Notifications, and dims
its three event toggles to the documented disabled treatment. And a download that
has started but not yet ticked (the click, or a return to a tab that was unmounted
while it ran — the status IPC carries no byte counts) renders an **indeterminate**
bar labelled "Starting" with the counts hidden, rather than a `0 B / 119 MB · 0%`
the app does not actually know.

**Probe line — a button whose only output is audio narrates itself.**
Every control here that speaks (the phrase **Test**, **Use**, **Preview**) renders its
own state in **words**, because audio is the one output an operator cannot see: a
muted OS, a cold Kokoro loading ~92 MB, an utterance the gate dropped on purpose and a
backend that failed all look identical as "nothing happened", which lets this silence
mask a real fault.

- **Immediately on click** (before any audio) the pressed button swaps its icon for a
  `loader-2` `.anim-spin` and a `--text-3` line reads "Starting…". Nothing is inferred
  from a timer; the line appears on the click itself.
- **While the engine holds the utterance** the line reads "Speaking…". The switch is
  driven by the engine's own `speaking` state, not by a delay.
- **When the `SpeakOutcome` promise settles**, the busy state ends and the outcome
  is spelled out, one line, one tone: `spoken` → `check` + `--green`; `dropped` →
  `volume-x` + `--text-2` **with the reason** (voice off / muted / empty phrase /
  the focus rule); `stopped` → `volume-x` + `--text-2`; `failed` → `triangle-alert` +
  `--warning` carrying the engine's own `speechErrorMessageKey`, which names **what**
  failed (a command not on PATH, a model never downloaded).
- **A failure never blames the volume knob.** The only place the operator's audio
  hardware is mentioned is the **`spoken`** line — "Spoken. If you heard nothing, check
  your system volume and output device." — where the app has positive evidence the
  utterance played and the remaining explanation really is outside it.
- **A second press is refused, not queued.** The engine serialises, so a second press
  would buy a second utterance played after the first. While a probe is in flight
  **every** speak control in the pane is `disabled` (the documented `opacity: 0.4`
  treatment). One probe for the whole pane, because there is one queue behind it.

**Status line (fail-soft, but never silent-and-unexplained).** When the engine's last
utterance failed, a `--red-soft` box with a `triangle-alert` icon and the translated
`speechErrorMessageKey` sits under the master switch. The notification still made its
sound — a failed utterance falls back to the packaged chime — so the operator loses
nothing; what they must never lose is the _reason_, which is what this line is for.

**Disk** — a footer row, the cleanup vocabulary (`--text-3` 11px + `tabular-nums`
size + the `font-mono` `--text-4` directory) with a ghost **Remove** that reclaims it
and returns the engine to its pre-download state. Shown only once something is
installed.

Technical nouns (`kokoro`, `en-US`, `{folder}`, the command, the path) stay
untranslated (§8).

### Badges

| Variant | Background       | Color       | Border           |
| ------- | ---------------- | ----------- | ---------------- |
| Default | `--surface`      | `--text-3`  | `--border`       |
| Accent  | `--accent-soft`  | `--accent`  | `--accent-line`  |
| Success | `--green-soft`   | `--green`   | `--green-line`   |
| Warning | `--warning-soft` | `--warning` | `--warning-line` |
| Danger  | `--red-soft`     | `--red`     | `--red-line`     |

Padding `2px 8px` · Border-radius `999px` · Font 11px

**Provenance badge (provider custom).** When the selected session runs on a
custom endpoint (≠ Anthropic), the Topbar shows a **Warning** pill (`border
--warning` + `text --warning`) with a `server` icon 10px + the endpoint name
(`Topbar.vue`, `providerName`). **Explicit** provenance — never a silent
quality downgrade (D6). The effective provider is resolved per session: the
one-shot `bootOverride.provider` (synthetics) or the resolved
global ⊕ folder `provider` (`claudeConfig:getResolved`) for the session's folder; the name comes
from the endpoints registry. No badge when the session uses the Anthropic default.

**Orchestrator badge (session role, T98).** A promoted session is visible
STATE, not a hidden flag file — three surfaces, one **Accent** variant (reuse
of the badge table above: `--accent-soft` bg, `--accent` text/icon, no new
token), all gated on the same `orchestratorSessionIds` truth (`sessions`
store) so they can never disagree:

- **Sidebar row** (`SidebarFolder.vue`): an inert `Crown` icon span (12px,
  `text-accent`), same non-interactive "status, not an action" pattern as the
  folder-level `sidebar.agentControlBadge` dot — placed in the trailing chip
  cluster (after the agent-count/teammate chips, before the relative-time
  label). `title`/`aria-label` via `sidebar.orchestratorBadge`.
- **Topbar pill** (`Topbar.vue`): identical shape to the provider pill above
  (`border-accent text-accent`, `Crown` 10px, height 18px, padding `1px 7px`)
  right after it in the title row, shown only for the currently selected
  session when armed. Title via `topbar.orchestratorBadgeTitle`.
- **Fleet marker** (`get_fleet` / `get_session`, `fleet-snapshot.ts`): a
  boolean `orchestrator` field alongside `taskState`/`status` on the
  redacted session row — the role is legible to an agent reading the fleet,
  not just to the human in the sidebar.

**Orchestrator-default indicator (folder role, T344).** Distinct signal from
the session badge above: not "this session is armed" but "this FOLDER will
arm every new plain session started in it". A small inert `Crown` icon
(12px, `text-accent` — same glyph and color as the session badge, so the two
read as one visual family, never confused with the **Accent** badge chip
shape) in the folder row's trailing chip cluster (`SidebarFolder.vue`), right
before the folder's own overflow/action affordances, shown only when
`orchestratorDefaultPaths` has the folder's path. `title`/`aria-label` via
`sidebar.orchestratorDefaultIndicator`. Non-interactive — toggling the
default is only ever done from the Folder context menu (see "Folder context
menu" above), never by clicking the indicator itself.

### Plan usage (usage meter)

Fixed panel at the bottom of the sidebar (above the "Add folder / Settings"
footer) showing usage of the Claude subscription plan, read from the official
client via `claude -p "/usage"`. One line per limit window: **session** (5h
limit), **weekly · all models**, and the per-model buckets (e.g. `Sonnet only`).

**Anatomy of a row (`UsageMeter`):**

- Top line: label on the left (`--text-3`, 11px, no trailing period) · `%`
  value on the right (`--text-2`, 11px, `tabular-nums`).
- **Bar:** track `--surface-2`, height **3px**, `border-radius: 999px`. The
  fill has width = `used%`, same height and radius.
- Bottom line: reset countdown (`--text-4`, 11px, `tabular-nums`) — relative
  ("resets in 57m") when the reset is parseable, otherwise the absolute string
  the CLI provides (which also goes in the `title`).

**Fill color by threshold** — keeps the accent as a **signal** ("close to the
ceiling"), never decoration (§2):

| Usage range | Color      |
| ----------- | ---------- |
| `< 80%`     | `--green`  |
| `80%–95%`   | `--accent` |
| `≥ 95%`     | `--red`    |

**Daily budget row (`UsageBudgetRow`, daily-budget spec).** A fourth, DERIVED
row below the reported windows: what is left of the 7d allowance, split across
the user's configured working days. It is separated from the 5h/7d meters by a
`border-t --border` hairline — Anthropic's reported limits and Harnu's own
arithmetic must not read as peers.

- Top line: label `Today` (`--text-3`, 11px) · value `{spent}% / {budget}%`
  (`--text-2`, 11px, `tabular-nums`), which becomes `--red` weight 600 when over.
- Bar: identical to `UsageMeter` (track `--surface-2`, 3px, radius 999px). Its
  width is `spent ÷ budget`, NOT the raw percentage, clamped to 100%.
- Bottom line (`--text-4`, 11px, `--red` when over) carries state, not a countdown.

**Fill color by threshold** — measured against the day's budget, and
deliberately NOT the 80/95 ramp of the window meters. 100% of a daily budget is
a real event with a consequence, so it takes the red; a step at 95 would be noise.

| Spend / budget | Color      | Bottom line                               |
| -------------- | ---------- | ----------------------------------------- |
| `< 80%`        | `--green`  | `on track`                                |
| `80%–99%`      | `--accent` | `{n}% left today`                         |
| `≥ 100%`       | `--red`    | `over · next {n} days drop to {pct}%/day` |

`{n}% left today` is differenced from the two figures the value already shows,
never rounded on its own — otherwise the row can contradict itself (`13% / 17%`
above `3% left today`).

When the week's allowance was already gone before the day began there is no
per-day figure left to quote, and the bottom line reads `over · nothing left
this week` instead.

**Day off.** On a weekday outside the working set the row renders label and
spent value with **no track at all** and the line `day off · not counted against
a budget`. Spending on a day off is a choice, not an overrun. The row is hidden
entirely — hairline included — when there is no 7d window, no history, or no
working days left.

**Panel (`UsagePanel`):** micro-label header `PLAN USAGE` (same style as the
section label — `--text-4`, 10.5px, uppercase, `letter-spacing 0.06em`),
padding `8px 12px`, separated from the footer by `border-t --border`. One
`UsageMeter` per bucket.

**`/usage` cooldown:** `claude -p "/usage"` has a ~20–40s cooldown — calls
within that window come back with only the preamble, **without the table**.
That's why there's **no fast retry** (any retry would land inside the cooldown
and fail); the 90s poll is already comfortably outside the cooldown and tends
to come back complete. The panel **must never flicker** because of an
incomplete poll.

**statusLine telemetry (zero-token cockpit, spec 2026-06-17).** In addition to
`/usage`, Harnu installs a `statusLine` in Claude Code that dumps per-turn
telemetry JSON; the panel now **prefers** this source (zero token, no
cooldown):

- **Rate-limit cockpit (merge by freshness):** two `UsageMeter`s (`5h` / `7d`),
  each fed by the **freshest source** between the statusLine aggregate (per
  turn — freezes when no session is running) and the `/usage` poll
  (`mergeRateWindows`, pure/tested). A window whose `resets_at` has already
  passed doesn't compete (its % is definitionally stale) — unless all of them
  have passed, in which case it shows the most recent one (an honest "last
  known" beats an empty meter). It's never either/or: below the 5h/7d meters
  come **all the per-model buckets** that only `/usage` reports (`Weekly ·
{model}`). A **freshness line** (`updated {time} ago`, `--text-4` 11px
  `tabular-nums`, age of the oldest displayed data) and the **fleet line**
  (`{cost} · N tabs`, same style, 2px gap) close out the panel.
- **Context chip on the session row** (§ "Session rows"): context `used%` to
  the left of the timestamp, `tabular-nums` 10.5px, **quiet by default**
  (`--text-4`) and turning into a signal by the same threshold rule —
  `--accent` ≥ 80%, `--red` ≥ 95%. Only appears once the tab has reported
  telemetry (additive).
- **Hover preview** (§3.9 / `SessionPreview`): swaps the hardcoded model for
  the real `model.display_name` and adds `cost · context% · +lines/−lines` +
  `thinking` / `effort` / `near /compact` badges.

Opt-out in Settings → Integrations (switch "Session telemetry (statusLine)",
default **on**); if the user already has their own statusLine, Harnu
**preserves theirs** and warns — never overwrites.

**statusLine resilience:** exit cleanup removes the key only when the
`command` is **exactly** this instance's (a dev/verify instance closing must
not kill production telemetry); a periodic **self-heal** (60s) reinstalls when
the key has **disappeared** (never fights a foreign statusLine or another live
instance); and the telemetry map is **persisted to disk** (24h TTL) so the
per-session HUD survives a restart instead of falling back to the name
placeholder until the next turn.

**Harnu self-awareness.** One more `ToggleSwitch` in Settings → General →
Integrations (right below statusLine, anchor `set-harnu-awareness`, same
anatomy: `--text-2` 12px label + `SettingHint`), **default on**. When on, the
versioned doc `docs/harnu-features.md` (short, updated on every release like
the CHANGELOG) gets **prepended** to the effective `--append-system-prompt` of
**every** `claude` session (composing with — never replacing — the user's
append; separator `\n\n---\n\n`; Claude's default `--system-prompt` is **not**
touched). This way the session knows it's running inside Harnu: MCP verbs, the
footer image gallery, the Approval Inbox, worktrees, and that it can guide the
user through the UI. The hint is **honest** about the cost (a few hundred
tokens per session, cached as system prompt). No new design token. Searchable
via "harnu", "awareness", "self", "mcp".

**Harnu mod (T389 P1W4).** One more block in Settings → General → Integrations, right
below the self-awareness switch (anchor `id="set-companion"`, same anatomy: `--text-2` 12px
label + `ToggleSwitch`, `flex items-start justify-between`, `margin-top: 14px`, the
`anim-setting-flash` jump). The label reads **Harnu mod**; the user-facing noun is never
"companion". Under the label, two `SettingHint` lines: what it is ("Harnu loads a small mod
into the sessions it starts. It runs unsandboxed inside the `claude` process and talks only
to Harnu on this machine.") and what **off** means ("Off stops Harnu from using it now and
from loading it into new sessions. Off means hooks and polling."). Below them: the staged
folder path (`font-mono`, 11px, `--text-4`, `truncate`, selectable) with a **Reveal folder**
ghost `Button`, and **at most one** status line (`--text-3`, 11px, no icon, **no warning
colour**: `legacy` is not an error). Which line: the CLI is older than the minimum, the CLI
is newer than the last version tested (the mod only observes), or nothing. The block hosts a
region `id="set-companion-keys"` at its end, where later waves mount their own feature
switches; the Mods tab moves the whole block when it lands. Searchable via "harnu mod",
"mod", "mods", "plugin". The kill switch is renderer IPC only: nothing an agent can call
reaches it. No new design token.

**Three display states:**

- **`ready`** — data available. Shows the `UsageMeter`s. If the last poll
  failed or came back incomplete, keeps the last good numbers (marked `stale`
  internally) instead of disappearing.
- **`loading`** — **only during the window of the first fetch** (no snapshot
  exists yet — `snapshot === null` in the renderer). Shows the **skeleton**
  (`UsageMeterSkeleton`): 3 placeholder lines mirroring the `UsageMeter`
  geometry (label line + 3px track), in `--surface-2` blocks with
  `.anim-shimmer-dot` (§7). Never shows fake text/numbers — only the neutral
  blocks. **Not sticky:** as soon as the first fetch resolves, the panel
  leaves `loading` (becomes `ready` if data came back, otherwise
  `unavailable`) — an incomplete poll never gets the skeleton stuck.
- **`unavailable`** — no usage to show (user without a subscription / API key,
  `/usage` unsupported, or the first fetch came back incomplete with no prior
  data). The panel **disappears silently**; a later complete poll fills it in.

**Motion:** bar-width transition via `--dur` / `--ease`; the skeleton uses
`.anim-shimmer-dot`. Respects `prefers-reduced-motion` (no transition/shimmer —
the skeleton stays static).

### Usage history / BI (Settings → "Usage history", issue #19)

Tab in the `Settings dialog` (same anatomy as the Changelog tab) that persists
quota telemetry — today only alive in memory and lost on close — and turns it
into **charts**, a **plan calculator**, and a **chat over the data**. The
capture data is the same per-turn statusLine telemetry blob (zero extra cost);
the tab **widens the modal** to `min(720px, 92vw)` (in v1.1 it becomes its own
view if it gets cramped).

**Account-wide vs local distinction (always explicit):** the `5h` / `7d` %s
are the whole account's `used_percentage` (source of truth); cost and session
count are **local** (this machine only). The note sits at `--text-4` 10.5px
above the charts; the calculator uses **only** the global %, so the verdict is
reliable.

**Trajectory charts (`UsageChart`).** Inline SVG, **no chart library**. One
bar chart per metric (5h, 7d, cost/day (peak), live sessions (peak)),
selectable by period (`24h` / `7d` / `30d` / `60d` / `90d` / `all` — chips
reusing the toggle style of the Settings buttons, **the same ranges as the
plan calculator** — T47 P4.5). The `24h` period shows **only the last real
24h** (never "the last N samples", which would stretch over weeks under
sparse usage); daily rollups group by the user's **local time zone** (the
mental day, not the UTC day). Geometry comes from the pure `barChartRects`
helper; **color follows the same rule as the meter**, via the fill twins
(`pctBarClass` → `fill-green` < 80%, `fill-accent` 80–95%, `fill-red` ≥ 95%) —
bars are SVG `<rect>`s and `bg-*` (background-color) **does not paint SVG**;
for series with no 0–100 ceiling (cost/sessions), flat `fill-accent`. The
cost label says **"(peak)"**: the value is the peak of the fleet's
accumulated total for the day (not daily spend — real cost per day comes from
the JSONL engine, T47 P5). A `null` bar = zero-height gap (never a false
"0"). 1px `--border` baseline.

**Honest names (T47 P4.5).** Two labels read as the opposite of what the
number is: "Sessions / day" looked like "how many sessions I ran that day",
but it's the **peak of simultaneous live sessions** (telemetry < 24h) —
renamed to **"Live sessions (peak)"** (short label, no trailing period). "Cost
/ day (peak)" already said "(peak)" in the label, but nothing warned that it's
**notional** (sum of accumulated cost, not the day's spend) — both gain a
subtitle line (`.chart-subtitle`, `--text-4` 9.5px, right below the chart
header): "Notional · cumulative session cost" and "Peak simultaneous sessions
with telemetry newer than 24h". The precision lives in the subtitle, not the
short label — the same rule as the "notional · local only" tile, now
replicated on the charts.

**"At-a-glance" legibility.** A mute bar chart doesn't answer "what
day is this bar? what's the value? is that a lot?". `UsageChart` carries
those answers on its own surface, with no hover required:

- **Current value in the title** (`.chart-title` → `.cur`, `--text-2`
  tabular-nums, on the right): "now 44%" / "today $16.30". The most important
  number is readable immediately.
- **Label on the peak and the current bar**: the value appears written out
  (`9px` mono, `--text-3`) above the **peak** bar and the **most recent** bar;
  if they're the same, only one. The rest stay clean (labeling all of them
  clutters) — **except in the `7d` period**, see density by range below.
- **Reference lines** (`pct` series only): dashed at **80%** (`--border-2`)
  and **100%** (`--red` at 45% opacity), labeled on the right. They turn "44%"
  into "44% of how close to the ceiling".
- **Per-bar tooltip**: native SVG `<title>` on each `<rect>` — hover shows
  "Tue 07/02 · 44%". Accessible and with no positioning JS.
- **Day axis**: date labels (`.xlabels`, `9.5px` mono `--text-4`) distributed
  under the bars (start / middle / end), not just the range — density by
  range below.

**Label density by range (T47 P4.5).** The `7d` period is small enough to
"take in at a glance" across all days at once — the other periods would get
cluttered with the same treatment. Pure policy in `axisTickIndicesForRange` /
`labelIndicesForRange` (`usage-history-format.ts`), `UsageChart` just reads
the result via the `range` prop:

| Range                         | Axis ticks                                                                            | Value labels       |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| `24h`                         | 4 spread-out ticks (unchanged)                                                        | peak + most recent |
| `7d`                          | **all 7 days**                                                                        | **every bar**      |
| `30d` / `60d` / `90d` / `all` | **weekly** (`weeklyAxisTickIndices` — every 7th index, always including the last one) | peak + most recent |

`null` days remain a zero-height gap (never a false "0"); the per-bar tooltip
doesn't change.

**Highlight tiles (`UsageStatTiles`).** A row of 4 KPIs at the **top of the
tab** (before the trajectory) — the answer a layperson/CEO extracts in 2
seconds, before any chart. Grid `repeat(4, 1fr)` (2×2 below 560px), each tile
in `--surface` / `border --border` / `--radius`: large number (`20px` mono
weight 650, tone by threshold when it's a %), `--text-3` `10.5px` label,
`--text-4` `10px` subtitle. Fixed **30-day** scope (explicit label),
independent of the charts' period toggle. The four, from data we already
have:

| Tile               | Value      | Source                            | Truth                                   |
| ------------------ | ---------- | --------------------------------- | --------------------------------------- |
| Times near the cap | count      | 5h windows with `peakPct ≥ 95`    | "did I hit the wall?" in plain language |
| Peak 5h            | `%` (tone) | max `fiveHourPeak` (sub: peak 7d) | how close I got to the limit            |
| Peak cost/day      | `$`        | max `costPeakUsd`                 | notional, local only (labeled)          |
| Peak sessions      | count      | max `sessionPeak`                 | intensity of fan-out days               |

Pure calculation in `usage-history-format.ts` (`summarizeUsage`, tested); the
component is a thin template over the result. No data in scope → the tile
shows `—` (never a zero that looks real). The 3rd tile ("busiest slot") comes
from `heatmap.heaviest` (see heatmap below); the 4th ("peak cost/day") is
notional and local only — real cost per day is P5 (JSONL engine).

**"Now" strip (`UsageNowStrip`).** Bridge between the footer's live telemetry
and the history: shows the **current 5h window**
(`window.api.telemetryGet` + `onTelemetryUpdated`), the **countdown** to reset,
and a **burn-rate projection** (pure `projectWindowPeak` —
`current / elapsed-fraction`, with a 10% floor so it doesn't explode at the
start of the window; the UI frames it as "at your pace ~X%", never a
promise). The meter reuses the `UsageMeter` palette (`barClass`); a tick marks
the projection, a thin line marks 80%. A 30s `clock` keeps the
countdown/projection alive. Disappears when there's no live 5h reading.

**Legibility of the projection tick and the 80% marker (T47 P4.5).** Two
points of confusion fixed: (1) the 80% marker's legend chip read as if it
were a _projected value_ — the text is now explicitly `"80% mark"` (key
`usageHistory.nowStrip.legendRef`, reused both in the marker line's own
`title` and in the legend chip), never a bare number; (2) the projection tick
on the bar got its own label (`~N%`, `9px`, `tabular-nums`, `--text-3`,
positioned 14px above the tick) so the tick and the header text "at your
current pace ~N%" are visibly the same number in two places. The
projection's legend chip also makes the scope explicit: "projected at reset
(this window)" — the current 5h window, not the weekly one.

**Trajectory — area mode (24h).** In the `24h` period the two `%` charts
become **line + area** (`mode="area"`): the sawtooth of resets becomes
legible. Cost/sessions stay as bars (no sawtooth). Line color follows the
series' peak rule (`stroke-green/accent/red`). 7d/30d stay as bars.

**Plan calculator (`PlanFitCard`).** **Deterministic** projection (not an LLM
guess): takes the distribution of per-window peaks (median / p95 / max of the
**complete** windows) and projects it onto another tier by the quota ratio
(`fromQuota / toQuota`). Anatomy:

- **Recency scope** (chips `30d` / `60d` / `90d` / `all`, default `60d`, in
  the card header, same SegmentedControl as the periods): limits the windows
  considered — without it the entire history weighs equally and months-old
  behavior poisons the verdict.
- **One-sentence verdict**, right below the verdict word: generated from the
  same stats that decided the verdict, with the **number of overages**
  (`exceedRate` × n — "N of M windows would have exceeded the limit") and the
  projected p95. `12px` `--text-2`, max-width `58ch`.
- **"Smallest plan that fits" recommendation** (`recommendTier`,
  deterministic sweep of all tiers): `--green-soft` chip with the label in
  `--green` weight 600; `--text-3` suffix "— your current plan" when the
  recommended tier is the current one; "(tight fit)" when only a tight fit
  exists. Disappears (never guesses) with insufficient data.
- **Dot distribution (`UsageDistribution`)**, above the table: each complete
  5h window in scope becomes a dot, on one row "observed on {current tier}"
  and another "projected on {target tier}", against a shared axis with
  reference lines at 80% and 100% (the 100% one in `--red`). "8 dots past the
  line" reads faster than a p95 in the table. Dot color follows the rule
  (`barClass`); stacks in 3 levels to avoid overlap; per-dot tooltip.
- **Per-window table** with an extra **overages** column (`N/M`, `--red` when
  N > 0), plus n / median / p95 / max / projected p95.
- The **verdict** with signal tone (`comfortable` `--green` · `tight`
  `--accent` · `over` `--red` · `insufficient_data` `--text-3`), the
  `PLAN_QUOTA_AS_OF` disclaimer, the note that the published ratios are
  **placeholders to confirm**, and a **manual ratio override**.
- **Coverage note** (`--text-4` 10.5px, next to the disclaimer): "X of Y
  windows in scope fully observed" — replaces the old all-time warning of "N
  partial windows", which grew forever and read as an alarm.

Partial windows (app was closed) are **flagged and excluded** so they don't
bias the verdict; with fewer than the minimum number of complete windows →
shows `insufficient_data`, never makes it up.

**Reset markers + per-window mode (T47 P4.5).** `UsageHistorySummary.windows`
(`WindowRecord[]`: `kind` fiveHour/sevenDay, `startedAtMs`, `resetsAtMs`,
`peakPct`, `partial`, `closedAtMs`) already arrives in the renderer with no
new collection cost — the two features below just read what's already there:

- **Reset marker on the 7d chart**: a dashed vertical line (`stroke-border-2`,
  `stroke-dasharray 2 2`) on each day where a `sevenDay` window closed
  (`resetsAtMs` mapped to the local day via `dayIndexForMs`, pure geometry in
  `resetMarkerIndices`). No marker → no line (never invents a reset). Native
  `<title>` per line + a note below the chart ("dashed line marks a weekly
  rate-limit reset") only appears when there's at least one marker in the
  visible period. Doesn't apply to the `24h` period (area mode, no day bars
  to align to).
- **"By window" mode on the 5h chart**: a small `SegmentedControl` ("By day" /
  "By window", `usageHistory.fiveHourMode`) above the chart switches the
  series from "peak of the day" to **one bar per closed 5h window** in the
  selected period, in chronological order (`windowSeriesFor`, pure) — so a
  95% window shows up next to its 30–40% siblings from the same day, instead
  of being hidden behind the day's peak. Each bar's label becomes
  `MM/DD HH:MM` (the window's start), color still follows the threshold rule
  (`pctBarClass`).
- **Partial windows are visually distinct**: `fill-opacity 0.4` + outline
  `--color-border-2` ("hollow" bar) — the `partial` flag passes straight from
  the data to the chart via the `UsageChart`'s `partials` prop, with no
  reweighting or exclusion (a recorded peak is still a real observation, it
  just may be underestimated). A note appears below the chart only when at
  least one partial bar is visible in "by window" mode.

**Real cost from the JSONL engine.** The notional "Cost / day (peak)"
chart (sum of accumulated `total_cost_usd` across live sessions — always an
overcount, see above) gets **replaced by REAL cost** as soon as the cost
engine (`usageCost:summary`, parsing + dedup + pricing of transcripts under
`~/.claude/projects/`) has data for **at least one day** in the visible
period. The swap happens **for the whole chart, never per bar**: once real
data covers the period, ALL bars come from the engine (a day with no real
data becomes a zero-height gap, same as a `null` — it never silently falls
back to notional, which would mix sources in the same series without
warning). With no day having real data at all (fresh install, engine hasn't
scanned yet), the whole chart stays notional — identical behavior to before
this feature.

- **Title and subtitle switch together**: the notional label says
  **"(peak)"** because it's literally the peak of an accumulator — it would
  lie if attached to a real daily total, so the title itself changes from
  `"Cost / day (peak)"` to `"Cost / day"` (no "peak") at the same instant the
  subtitle switches from `"Notional · cumulative session cost"` to `"Real ·
from transcripts"` (`--text-4` 9.5px, same rule as the honest subtitle from
  T47 P4.5). The notional value **doesn't disappear** — it's the only
  **intraday** signal that exists (the cost engine only resolves per day;
  today hasn't closed yet). A second small line (`--text-4`, below the chart)
  always shows the live notional value: `"live (notional): $X"` — read
  alongside, never hidden.
- **Estimate flagged**: if any contributing bucket used an unknown model
  (fallback tier — see T47 P5 in the engine), a `*` note appears next to the
  subtitle: `"* some costs are estimated"`. Never silent.

**Sessions worked.** The "Live sessions (peak)" chart (peak of
sessions with telemetry < 24h — a proxy, not a real count) gets a more honest
metric alongside it when the cost engine has data: **sessions worked** —
distinct sessions with **at least one priced request** on that local day
(deduplicated by the engine itself, T47 P5 semantics #7). Becomes the primary
chart ("Sessions worked / day", same bar, flat `fill-accent` color) when there
is real data for the period; the notional peak-live-sessions figure stays
accessible as a secondary reading (`chart-subtitle`, "peak live (notional):
N") — same pattern as the cost above, never a silent replacement.

**Top models by cost.** A simple list (not a new dedicated
component — it's honestly small enough not to need one) right below the
chart grid, titled `"Top models (cost)"`, appears only when the cost engine
has data. Up to 5 rows, sorted by cost desc: model name (`--text-2` 12px,
mono for the id), a small proportion bar (`--surface-2` background,
`fill-accent`/`bg-accent` filling the fraction of total cost — same visual
principle as the usage meter, no new color), `$` value (`tabular-nums`,
`--text`) and request count (`--text-4` 10px, "{n} requests"). A model whose
bucket carries `estimated: true` gets a `*` suffix on its name and shares the
same note text from the paragraph above (a single note, not repeated per
row).

**"When you use it" heatmap (`UsageHeatmap`).** A **weekday × hour** grid (T47
P4) of average 5h-window usage — visually answers "when do I use it most?".
Pure aggregation on the main process (`buildHeatmap`, tested) and sent in the
summary as a dense 7×12 grid (2h buckets); cell intensity = `avgPct /
maxAvgPct` rendered as **`--accent` opacity** via `color-mix` (token-backed,
no raw color). Rows in **Monday-first** order; hour ticks 0/6/12/18/24; a
`title` per cell with the exact reading. The heaviest cell feeds the "busiest
slot" tile. Disappears when there's no reading in scope.

**Chat over the data.** Runs **on demand** (never in the background), fed by
the **pre-computed rollups** (a few KB), never the raw JSONL → trivial token
cost and grounded answers. Configurable model (default `haiku`); the model
**only narrates**, the math is deterministic. Failure is non-fatal (shows an
error line, never breaks the tab). **Suggested-question chips** (`--surface`/
`--border-2` pill, `999px`) above the input — an empty field has high
friction; clicking fills it in + fires.

**Config (in the tab itself):** capture opt-out (default **on**, everything
fail-safe), current plan tier, chat model, and retention (`30d` / `90d` / `1
year` / `forever` — "forever" never deletes). Storage: **JSONL rotated
daily** under `~/.claude/om2tab/usage-history/` (not SQLite — avoids the
native module and the node-pty rebuild pain), behind a storage interface for
a future swap.

**Motion:** bars animate height via `--dur` / `--ease`; respects
`prefers-reduced-motion` (the global `transition-duration` reset in
`main.css` already zeroes the animation). No ad-hoc keyframes.

### Usage Dashboard (takeover)

A second Usage surface — it does **not** replace the `Usage history` tab in
Settings (which stays around for anyone who just wants the 4 charts + plan
calculator). The Dashboard is the **deep** view: one question at a time turns
into a glance-sized answer — "who spent", "when do I use it most", "which
SESSION was expensive and why" — combining the P5/P6 engine (`usageBi:
snapshot`, real cost + session anatomy) with the aggregates the Settings tab
already uses.

**Visual pattern: main-pane takeover, not a modal.** `TakeoverShell` chrome (T300/U3,
see "TakeoverShell — shared chrome" above) — replaces the `<main>` content (sidebar and
topbar stay visible), icon `LayoutDashboard`, a title, close `X`. No Teleported header
content beyond that. Body with `overflow-y-auto`, `max-width: 1400px` centered (same
width as the reference mockup), padding `20px 24px 48px`.

**Entry point: footer pill → "Open full dashboard".** The Footer fleet
pill's popover (§6 — "Footer / status bar", already opens `UsagePanel`) gets
a link/button at the bottom of the popover (`text-11px text-accent`,
`ExternalLink` icon 12px): "Open full dashboard". Clicking it closes the
popover and calls `ui.openUsageDashboard()`. Closing: the header's `X`
button, Esc (via `closeAll()`, same rule as the board), or navigating to
another view.

**Data source: one call, one snapshot.** `window.api.usageBiSnapshot({
range })` — called on mount and on every `range` filter change.
The `loading` state shows skeletons on the cards (same pulsing gray rule
already used in `UsageMeterSkeleton`); error/failure degrades to empty cards
with `—` (the backend is already fail-safe per block — it never throws).
**Model** and **project** filters are **local to the dashboard** (recomputed
client-side over the already-loaded snapshot — they don't trigger a new IPC
call), except for the **range** filter, which redoes the fetch (the day cut
happens on the main process, over already-cached buckets — cheap).

**Filter bar** (`sticky top-0`, same visual treatment as the `card`, with a
`--shadow-pop` shadow when stuck at the top): range `SegmentedControl` (`24h`
/ `7d` / `30d` / `60d` / `90d` / `all` — the SAME ranges as the trajectory and
the plan calculator); model chips (`chip-toggle`, one per model present in
the snapshot, color = model categorical palette — see below — toggles on/off,
all on by default); a native project `<select>` (list of the snapshot's
`projects[]` + "All projects"). A note on the right (`--text-4` 11px)
explains when a filter is inert (e.g. model disabled when the main chart's
metric is "Rate-limit %", which is account-wide and doesn't segment by
model).

**Model categorical palette.** Fixed colors per family, reused EVERYWHERE
this dashboard shows a model (chips, legend, stacked bars, bubbles, table
chip) — never relying on color alone (always paired with the model name in
text, legend, or tooltip). Five fixed colors covering the families priced by
the P5 engine (`usage-cost-core.ts`):

| Family                                     | Token / value                   |
| ------------------------------------------ | ------------------------------- |
| `claude-opus-4-7`                          | `#e66767` (coral red)           |
| any other opus (4, 4.5, 4.6, `4-8` onward) | `#3987e5` (blue)                |
| `claude-fable-5` / mythos-5                | `#199e70` (teal green)          |
| `claude-sonnet-5` (and sonnet 3.5–4.6)     | `#c98500` (amber)               |
| `claude-haiku-4-5` (and haiku 3.5)         | `#008300` (green)               |
| unknown/estimated model                    | `--color-text-4` (neutral gray) |

`claude-opus-4-7` gets its own color (coral), distinct from `claude-opus-4-8`
(blue) — they're not "the same tier" despite the similar name; the match rule
(`modelColor`, `usage-dashboard-format.ts`) tests `opus-4-7` BEFORE the
generic `opus` catch-all, otherwise the two would collapse into the same
color (bug caught by a test, `tests/usage-dashboard-format.test.ts`).

Pure mapping (`modelColor(modelId): string`) in a helper shared by all the
dashboard's sub-components — never an inline raw color outside of it.

**KPI strip (`UsageDashboardKpiStrip`).** Grid `repeat(5, 1fr)` (2 cols below
900px), each card = same anatomy as the generic card's `.kpi`
(`bg-surface border-border rounded-lg`, uppercase `--text-3` 11px label, large
`25px` weight 700 value, delta badge vs. the previous period — green/red
depending on whether "up is bad" or "up is good" for that metric —, 7-point
sparkline via inline `<svg>`, `--text-3` 11px footer): **5h window** (now,
delta vs. the previous closed window), **7d window** (today, delta vs.
yesterday), **cost today** (real, from P5; footer shows the live notional
value as a secondary reading — same "never hide the notional" rule as the
Settings tab), **sessions today** (real sessions worked; footer shows the
notional peak live sessions), **projected at reset** (circular
`conic-gradient` gauge, same `projectWindowPeak` formula already used in
`UsageNowStrip`). No data for the period → `—`, never a false zero.

**"Now" strip — direct reuse of `UsageNowStrip`.** Same component as the
Settings tab, no fork: current 5h window, countdown, burn-rate projection,
legend "now / projected at reset (this window) / 80% mark".

**Main grid — two columns.** `grid-template-columns: minmax(0,2fr)
minmax(280px,1fr)`, `gap: 14px`.

- **Left column:**
  - **Stacked-by-model chart** (`UsageDashboardStackChart`, NEW — the
    existing `UsageChart` is single-series and doesn't stack by model, so
    this component is a sibling variation, not a fork: same "inline SVG, no
    chart library" philosophy, same dashed gridlines, same native `<title>`
    per segment). Metric `SegmentedControl` in the card header: **Cost** /
    **Rate-limit %** / **Sessions**. In `cost` each bar is stacked by model
    (color = categorical palette) — the ONLY metric with per-model
    granularity in the snapshot (`costByModel` per day); `rate-limit %` and
    `sessions` become a single colored bar (green/amber/red meter for
    `rate`, flat `--accent` for `sessions` — the engine only tracks "sessions
    worked" as a daily total, with no per-model breakdown) — the model chips
    keep filtering (via the day's dominant model), but become visually
    `disabled` (reduced opacity) only in `rate-limit %` mode, which is
    account-wide and has no notion of model at all. Total label at the top
    of each bar; day axis below (rotates -55° on long ranges, same density
    rule as the T47 P4.5 trajectory).
    - **Weekly reset split.** When a `sevenDay` window reset happens in the
      middle of a day (`UsageBiDay.weeklyReset`), that day's bar — only in
      `rate-limit %` mode — becomes TWO stacked segments instead of one:
      pre-reset (the closed week) at the base, post-reset (the new week) on
      top, stacked touching with a thin divider (`border-b-2 border-surface`,
      the same divider the cost-by-model segments use). Each segment is
      threshold-colored by its OWN value (`pctThresholdColor`: green <80% /
      accent 80–95% / red ≥95%) — there is no `-soft`/muted variant and no
      summed total. Each carries its `%` label INSIDE the segment near the top
      (`.chart-fill-label` — white ink + soft shadow, legible on any fill),
      falling back to just above the segment when it's too short to hold the
      text. Square bottom / rounded top to match every other bar. This is the
      ONLY bar variant allowed past the 100% reference line, because the two
      slices are different quota windows, not a single fill. Hover on each
      segment shows that segment's value + the reset time. Days without a
      mid-day reset keep the usual single bar. **Data note:** `postPct` is the
      NEW window's peak after the reset drop, not `max(sevenDayPct after the
reset time)` — the account API keeps echoing the old window's high
      reading for a while after a mid-day reset, so the engine detects the
      reset drop and rejects those stragglers (`usage-history-core.ts`).
  - **Activity calendar** (`UsageDashboardCalendar`, NEW): current-month
    grid, week starting Monday, 5–6 rows × 7 columns. Selectable metric
    (`SegmentedControl`: Peak % / Cost / Sessions) tints each cell on a
    3-point green→amber→red ramp (`color-mix`, no raw color) by relative
    position within the visible month's min/max. Clicking a populated cell
    **highlights the matching bar** in the stacked chart above (same day)
    and shows a one-line summary below the grid — clicking again deselects.
    Days with no data stay empty/neutral (never a colored "0").
  - **"When you use it" heatmap — direct reuse of `UsageHeatmap`.** Same
    component as the Settings tab (weekday × hour grid, 7×12), fed by the
    snapshot's `heatmap` block. Note below: "Busiest slot: {day}
    {hour}–{hour}h".
- **Right column — three ranked lists** (`UsageDashboardRankList`, a generic
  component reused 3×: **Top models**, **Top projects**, **Top sessions**).
  Each row = rank, name + proportion bar (color from the categorical palette
  for a model; flat `--accent` for a project/session), `$` value + secondary
  metric (requests/sessions). Clicking a model row toggles the matching
  filter chip (same state as the filter bar); clicking a session selects it
  in the anatomy chart below (smooth scroll to the card).

**Session anatomy (`UsageDashboardAnatomy`, NEW — the center of the dashboard).**
Bubble scatter SVG: X axis = duration (hours), Y axis = cost (\$), bubble
area = total tokens (square root, never linear — avoids giant bubbles
visually dominated by an outlier), color = the session's dominant model (same
categorical palette), numeric badge in the bubble's corner = subagent count
(small `--color-bg` circle with a border in the model's color). A selected
bubble gets a dashed ring + higher opacity; hover shows a native tooltip (project ·
session · duration · cost · tokens · subagents). Clicking selects it and feeds the
**inspector** alongside (`flex: 0 0 320px`, `bg-surface-2 border-border-2`):
name/project, 4 stats in a 2×2 grid (duration, cost, turns, agents+sub),
stacked cost-per-model bar + list, 4 token bars (input/output/
cache-read/cache-write, same visual scale as the meter), peak-context bar
(colored by the green/amber/red scale). The bar **saturates at 100%
width**, but the raw number stays exact right next to it — a real
long-context session (e.g. Opus with the 1M beta on, with no `[1m]` marker in
the model id) can legitimately exceed 100% (T47 P6 S1 finding: the
200k/1M heuristic has no other signal to detect this). Above 100%,
a `--text-4` 10.5px note appears below the bar explaining the cause — never
letting the number look like a silent bug. With no session selected (the filter
zeroed out the list) → central empty state. An **insight line** below the
chart (`--surface-2 border-border-2`, `--accent` icon) narrates a
deterministic comparison (e.g. "model X sessions average \$N/h vs \$M/h on
model Y — Rx the burn rate") — never LLM-generated, pure computation over the
already-loaded snapshot.

**Explorer table (`UsageDashboardExplorerTable`, NEW).** Toolbar with a
`SegmentedControl` for grouping — **Days** / **Sessions** / **Models** /
**Projects** — each one swaps the ENTIRE column schema (not the same table
with hidden columns). Clickable header sorts (`▲`/`▼` arrow next to the
active column); clickable row selects (session → feeds the anatomy
inspector; model/day with no selection, just visual highlight). Columns by mode:

| Mode     | Columns                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Days     | Date · Weekday · Peak 5h % · Peak 7d % · Cost (bar) · Sessions · Dominant model (chip) · Δ vs prev · Windows (sparkline of the day's windows) |
| Sessions | Session (project · title) · Model mix (segmented bar) · Cost (bar) · Duration · Turns · Agents/sub · Tokens · Ctx peak                        |
| Models   | Model (chip) · Cost (bar) · Requests · Avg \$/req · Share of cost                                                                             |
| Projects | Project · Sessions · Cost (bar) · Share of cost · Avg \$/session                                                                              |

No rows in the current filter → centered `empty-state` (never a blank
table with no explanation).

**No new tokens.** The whole surface exclusively uses the tokens already
declared in §9 / `themes.css` — surface, text, accent, and semantic colors
(green/amber/red) and the categorical model palette above (fixed,
not theme-derived). Radii, spacing, and motion follow §4/§7 with no exception.
**Every scrolling container gets the `.scrollable` class** (thin rule,
`--border-2` thumb only on hover, transparent track — `main.css`) — never the
OS's native bar. A container that only needs horizontal scroll also
gets an explicit `overflow-y-hidden`: setting only `overflow-x` makes the
browser compute `overflow-y: auto` on its own (an overflow-spec quirk),
which leaked an unwanted native vertical bar in the stacked chart and the
explorer table (a live-verification finding, fixed in the same round).

**Motion:** cards do `anim-fade-in` on entry; bars/bubbles/cells
animate via `--dur`/`--ease` (height, width, opacity); respects
`prefers-reduced-motion` (global reset). No ad-hoc keyframes.

### Folder-first model (sidebar — flat list)

The sidebar organizes **folders** (the first-class unit — a folder IS what a
worktree used to be: an absolute path that hosts sessions directly). Git is
optional metadata, never structure (spec 2026-06-11).

**Folder row** (height 26px, `padding: 0 12px 0 8px`, `gap 4px`, `font-size
12.5px`, weight 500): chevron `12px` (`--text-4`, rotates 90° when expanded),
`folder` icon `13px` (`--text-3`), alias (`truncate`), and the **inline action
cluster** on the right (see below). Dismissed folders render with
`opacity 0.5` and the `eye-off` icon in place of `folder` (same anatomy as the
former hidden state). Branch **does not** appear on the folder row — the active
session's branch lives in the footer / status bar (HUD), avoiding noise and
duplication in the sidebar.

**Inline action cluster (folder row)** (spec 2026-06-24): on the right, in place
of the old session count, a discreet cluster (`gap 9px`, `shrink-0`) gathers the
three per-folder actions — previously stacked as rows at the end of the expanded
list. Each item is a `role="button"` (`tabindex 0`, Enter/Space + click, native
tooltip via `title`/`aria-label`) — **never** a `<button>`, since the folder row
is already a `<button>` and nesting buttons is invalid HTML (same idiom as the
agent chevron in session rows). Items, `--text-4` by default:

| Action   | Icon (§5) | Size / stroke | Appears when        | Hover      | Revealed (active) |
| -------- | --------- | ------------- | ------------------- | ---------- | ----------------- |
| older    | `clock`   | 11 / 1.6      | `olderCount > 0`    | `--text-2` | `--accent`        |
| archived | `archive` | 11 / 1.6      | `archivedCount > 0` | `--text-2` | `--accent`        |
| new      | `plus`    | 12 / 1.8      | always              | `--accent` | —                 |

The count follows `clock`/`archive` at `10.5px` `tabular-nums` (`gap 3px` from
the icon); `plus` has no number. The folder's **total session count** is **no
longer shown** — the cluster replaces it (a folder with no older/archived shows
just the `+`). Every item uses `@click.stop` so triggering the action never
collapses/expands the folder. The revealed item turns `--accent` to signal the
current "peek".

**Stats on demand (hover-only — T118):** the stats/action clusters on the right
edge of sidebar rows **don't** render permanently — stacked across the whole
list they turned into a wall of numbers. At rest they're invisible (`opacity 0`;
the space is **preserved**, no layout shift on reveal) and fade in
(`transition-opacity`; reduced-motion falls back to the global reset in
`main.css`) when the row is under the pointer (`group-hover`), has keyboard
focus (`group-focus-within` and the `data-focused` cursor), or the item carries
**active state or a signal** — which can never be invisible:

- **folder row:** the inline cluster (older / archived / `+`) and the `bot`
  badge are forced visible while a peek is revealed (the "Hide" `--accent`
  never disappears with the mouse off the row);
- **session row:** the agent (`bot` + n) and teammate (`users` + n) chips are
  hover-only — visible on the **selected** row; the teammate chip forces
  visible while the group is **expanded** (it's the collapse control). The
  StopFailure badge and the orchestrator `crown` are **signals** — always
  visible. Context % and relative time **no longer render on the row** — see
  "Context % and relative time (hover preview, not in the sidebar)" below;
- **repo-group header:** the count is hover-only when the group is
  **expanded** (the list below already counts itself) and **visible when
  collapsed** — there the count is the only clue to what's hidden. The
  folder-list toolbar's `⋯` (see "Folder-list toolbar (⋯ action)" below) is
  always visible — there is no zone count left to gate it on — but still
  forces visible while its popover is open (no behavior change there).

No new tokens — just `opacity` and the existing motion tokens.

**Agent-blocked badge (folder row)**: when the folder is **blocked** for agents
(`agentDeniedPaths` — the same source as the "Block / Unblock agent control"
toggle in the Folder context menu, §6), the row shows a **discreet** marker —
`bot-off` icon `11px` `--text-4`, immediately **to the left** of the inline
action cluster — with a native tooltip (`title`/`aria-label`, copy
`sidebar.agentBlockedBadge`) saying no agent can act in this folder.

**Inverted** from the old T71 "agent-allowed" badge: agents can act in every
folder by default, so badging the allowed state would mark every row. The
exception is what carries information. Consequently, unlike the stats cluster it
sits next to, this badge is **always visible** — never hover-gated (the same
reasoning as the unseen-agent-panes pill below: a folder the fleet cannot touch
must not be one hover away). It's **status, not action**: an inert `<span>`
(never `role="button"`; `aria-hidden` on the icon), it opens no menu and toggles
nothing — the toggle stays in the context menu. Doesn't change the row's height
or layout (joins the cluster's `shrink-0` flow).

**Unseen agent-panes badge (folder row)** (2026-07-13 agent-pane-routing
design): an agent-opened helper pane (`open_file`, `spawn_terminal`, a hosted
teammate, …) that lands in a folder the operator ISN'T currently looking at
must not go unnoticed — that's the badge's whole job. When a folder's
`helpers.unseenAgentPaneCount(folder.path)` is non-zero, the row shows a
**pill**: `PanelRight` icon `11px` + the count, `--accent` text on
`--accent-soft` background with an `--accent-line` border (the Badge
component's **Accent** variant, §6 Badges — no new token), `2px 6px` padding,
`999px` radius, `10px` font, `tabular-nums`. Placed in the trailing cluster,
**before** the (hover-only) agent-control `bot` marker and peek/`+` cluster.
Unlike that cluster it is **always visible** when non-zero (never
hover-gated) — an unseen offer is exactly the kind of thing "Stats on demand"
must not hide. Deliberately a different shape AND color from every session
status dot (§Session status: green/amber/red 6px circles) so it never reads
as a session's state — it's folder-level "something is waiting", not
"someone is running". Native tooltip (`title`/`aria-label`,
`sidebar.agentPaneBadge`). Clears the instant the operator selects ANY
session in that folder (`currentWorktreePath` watcher in `stores/helpers.ts`)
— ephemeral, never persisted (the panes themselves persist; the "haven't
looked yet" flag does not, so a fresh boot never resurrects a stale badge).

**One flat list** (2026-07-15, BUG-39 — supersedes the FOLDERS / ACTIVE
ELSEWHERE split below): every visible folder — pinned (added by the user,
members of `projects.json#projects[]`) **and** auto-discovered active (running
PTY, `taskState working`/`needs-input`, `status active`, or a session modified
within the configurable active window) — renders in **one** classify → sort →
`groupByRepo` → `groupByParentDir` pass, in one continuous list. No section header,
no divider, and **no visual distinction** between a pinned and a merely-active
folder (operator decision — revisit only if scanning a long flat list proves
it's needed). Stale folders (non-pinned with zero sessions, or old and inert)
don't list — reachable via ⌘K. Exception: a git worktree of a repo the
list already shows — pinned, or active on its own sessions — always lists, with
or without sessions, and appears or disappears live when it is added or removed
with `git worktree`. It renders as an ordinary folder row; there is no new
visual. A hidden path stays hidden. This also fixes the old duplicate-header bug:
because the two former zones each ran their own `groupByRepo` pass, a repo with
one pinned and one merely-active sibling worktree rendered **two** repo-group
headers for the same repo; the single combined pass now yields exactly one.

A small **folder-list toolbar** sits above the list — see "Folder-list toolbar
(⋯ action)" below — carrying the whole-list actions (Expand/Collapse all,
Hidden folders) that used to live on the `FOLDERS` eyebrow. It has no title,
no chevron, and controls nothing about visibility of the list itself (there is
no zone left to collapse).

**RepoGroupHeader** (height 26px): a single header component for BOTH kinds of
group (T182 — `FolderGroup`, discriminated by `source`), collapsing 2+ visible
folders that belong together. Reuses the sidebar-row / Section-label anatomy —
**no new tokens**: chevron `13px` (like the section menu), a `13px` source icon
(`--text-3`), label, count. Member folders render nested (indent +1 level) under
the header.

- `source: 'repo'` — 2+ visible worktree-folders sharing a `repoId`. Icon:
  `git-branch`. Label: the main worktree's basename when present, otherwise
  basename of `dirname(repoId)`.
- `source: 'path'` — 2+ visible folders sharing a **direct** parent directory.
  Icon: `folder`. Label: that directory's basename. See "Parent-directory folder
  grouping" below.

A group's members are always plain folders — **a group is never a member of
another group**, which is what holds the list to one level of indentation.

Clicking the header (or Enter on the keyboard cursor) **collapses/expands the
whole group** — hides/shows the member-folder rows behind the header (chevron
rotates 90° when open). This is a state **of its own** for the group (persisted
by `repoId` in `om2tab.repoGroupsCollapsed`), **independent** of each member
folder's `expanded` (which controls that folder's session list). Collapsing the
group **doesn't** touch the internal expansion of the folders — reopening
restores exactly what was open. An active text filter forces every group open
(a collapsed group would hide matches — same rule as the zones).

**Parent-directory folder grouping (non-git — T182, supersedes T70 Fix B):**
2+ visible folders sharing the **same direct parent directory** collapse under a
`RepoGroupHeader` with `source: 'path'`, labeled with that directory's basename.
The parent directory does **not** need to be pinned — the header is synthetic,
exactly like the repo one. When the parent directory **is** itself a visible
folder, it becomes **member #0** of its own group (keeping its own sessions and
row), mirroring the main worktree's position inside a repo group.

**The parent is always the DIRECT one.** This is the whole point of T182: the
old rule nested a folder under its _shallowest_ visible ancestor, so pinning
`$HOME` made it the umbrella for every non-repo folder beneath it at any depth.
A folder with no sibling under its parent stays a plain row.

**Hard 1-level limit (the anti-VS-Code, retained from T70).** Chains resolve
deepest-parent-first, and being a group's parent beats being another group's
member: with `~/x`, `~/x/y`, `~/x/y/z` all visible, `y` claims `z` and renders as
the `y` group, while `x` — now short a member — renders as a plain row. Never a
3+ level staircase.

Collapse state and group aliases are keyed by a **namespaced group key**
(`repo:<repoId>` / `path:<dir>`) so both kinds share one persisted store without
colliding. **No new tokens.**

**Worktree lineage (mother badge + child row + guide line) — T191:** a repo's
fan-out history — which worktrees were cut BY another worktree's session,
during an orchestrated dispatch — is real and load-bearing (the difference
between "12 unrelated branches" and "3 orchestrators, each with its wave"), and
otherwise invisible in a flat `RepoGroupHeader` member list. Structural, not a
declared role (D2): a folder gets the mother badge because worktrees were born
from it, so a promoted-but-idle Orchestrator session doesn't pollute the
sidebar. Applies **only within one `RepoGroupHeader`'s member list** — nesting
never reaches across a zone or a repo (D4); a fold whose recorded mother isn't
a visible member of the SAME group renders flat, same as a deleted or hidden
one.

- **Mother badge** (folder row, in the existing badge slot next to the
  agent-blocked marker): `git-fork` icon `11px` `--text-4` + the live child
  count, `--text-4` `10.5px` `tabular-nums` (`gap 3px`) — same compact recipe
  as the Accent badge (§6 Badges) but in the folder row's neutral badge tone,
  not accent, since this is provenance, not an alert. Shown **only when the
  count is ≥ 1** (D2 — a mother with zero live children is never marked).
  `role="button"`, `tabindex 0` (same idiom as the inline action cluster — the
  folder row is already a `<button>`): clicking (or Enter) **collapses/expands
  the children**, independent of the folder's own `expanded` (which still only
  controls that folder's session list). A **collapsed** mother keeps showing
  its badge count — collapsing never hides the information, only the rows
  (D5). Native tooltip (`title`/`aria-label`, `sidebar.lineageBadge`).
- **Child row:** the worktrees a mother cut render **indented one level**
  directly beneath it (same `+20px` indent step `RepoGroupHeader` members and
  `nestByPath` children already use — never a second, deeper step: **a
  grandchild flattens to its root mother**, D3). A **1px `--border-2`
  guide line** runs down the children's column, anchored at the mother's row
  and ending after the last child — a plain `border-left` on the children's
  wrapper `<div>`, no new token. No connector glyph on each child row (unlike
  the agent/teammate `corner-down-right` nesting, this is a column-wide cue,
  not a per-row one) — the guide line alone reads as "these belong to that
  mother" without repeating the icon on every row.
- **Collapse persistence (D5):** by path, in `localStorage`
  (`om2tab.lineageCollapsed`) — the same `persistedSet` mechanism
  `om2tab.repoGroupsCollapsed` uses, keyed on the mother's path instead of a
  `repoId`.
- **Manual override (`FolderMenu`):** "Set parent folder" opens a submenu
  (same flyout anatomy as "Modes ▸ …", §6 Context menu) listing this folder's
  sibling worktrees in the SAME repo (`git-branch` icon per row); picking one
  writes the `bornFrom` edge. "Clear parent folder" (shown only when a mother
  is currently set) removes it. Both live in the git-only block, alongside
  "New worktree…"/"WORKTREE.md". No new tokens — reuses the existing flyout,
  row, and separator styles verbatim.

#### `RETURN HERE` zone (closure axis)

An attention zone **at the top of the sidebar, above the folder list**.
Lists the sessions the operator **forgot**: a `needs-input` session they haven't
viewed for ~10 min and which is **not** the currently selected one (the closure
axis is orthogonal to `taskState` — it answers "have you seen this session's
current state?"). The goal is that a blocked-and-abandoned session doesn't get
lost below the fold.

**Calm-tech — only when there's something.** The whole zone (eyebrow + list +
divider) renders **only when the forgotten set is non-empty**. Zero persistent
chrome: it vanishes the instant the last session is seen/dispatched.

**Eyebrow** (Section-label): reuses the Section-label typography (uppercase
`10.5px`, weight 500, `letter-spacing 0.06em`, `--text-4`) with title + count —
`RETURN HERE · 2` (the middot is decorative, `aria-hidden`). **Not**
collapsible — it's a transient nudge, not an organizational zone (there is no
collapsible zone left in the sidebar to compare it against).

**Flat list** (this axis is **per session**, not per folder). Each row (height
`28px`, `padding: 0 8px 0 12px`, `gap 8px`, `font-size 12.5px`) is a `<button>`
— anatomy: **amber `needs-input` dot** (`bg-warning` 6px, `anim-attention-dot`),
the session's **name** (`truncate`; §"Session name", fallback "New
session"), and the **folder alias** (`--text-4`, `10.5px`, muted,
`truncate`).

**Interaction.** Clicking the whole row → `activateSession(id)` (expands the
owning folder

- selects → the session becomes selected and auto-clears from the zone). The
  **dismiss** (× on the right, `role="button"` — never a `<button>` nested in a
  `<button>`; `--text-3` → `--text` on hover, `@click.stop` so it doesn't jump
  along) → `markSessionSeen(id)` (stamps last-viewed = now → the predicate
  flips and the row leaves). **Zone divider**: 1px `--border` line with
  `margin: 6px 0`, separating `RETURN HERE` from the folder list below it.
  **No new tokens** — Section-label, `--color-warning`, `--border`, all
  already exist.

**Empty state (no folders):** when `sessions.folders.length === 0`, the tree
area shows static centered text, `--text-3` 11.5px, `padding: 14px 12px`,
`line-height 1.5` — `$t('sidebar.emptyShort')` ("No folders added yet.").

**Loading state (cold boot) — T180:** while the app's very first
`sessions.init()` scan of `~/.claude/projects/` is still in flight
(`sessions.foldersLoading === true`) and `folders.length === 0`, the tree area
shows a spinner instead of the static empty text — so a multi-minute cold-boot
scan on installs with hundreds of project folders reads as progress, not an
empty/broken sidebar. Centered in the tree area (`flex h-full flex-col
items-center justify-center gap-3` — `h-full` against the tree container's
own flex-grown height, not `flex-1`, since the tree container itself isn't a
flex context): the `RefreshCw` icon (20px,
`stroke-width 1.5`, `--color-accent`, `.anim-spin` — the same icon + spin
class the toolbar's rescan button uses, §6 "Sidebar toolbar") above the label
`$t('sidebar.loading')` ("Loading folders…", `--text-3` 11.5px). No new
tokens. Once the scan resolves (success or failure), `foldersLoading` flips to
`false` and the tree falls back to the real folder list or the static empty
state above — manual rescans (the toolbar's own spinner) never re-trigger this
state.

### Repo-group header (sidebar)

`RepoGroupHeader.vue` — the synthetic header for a **repo-group** (2+ visible
worktree-folders of the same repo in a zone; `groupByRepo`). `26px` row,
`padding: 0 12px 0 8px`, `gap 4px`, `12.5px`/500, reusing the sidebar-row anatomy
(hover `bg-surface`): chevron `13px` (rotates on expand), `git-branch` icon
`13px` `--text-3`, the **label**, and the member count (`--text-4`, `10.5px`,
tabular). Clicking the whole row → `toggleRepoGroup(repoId)`. The count follows
"Stats on demand": hover-only when the group is **expanded** (the member
folders are listed right below), visible when the group is **collapsed** (it's
the only clue to how many worktrees are hidden), and under the keyboard cursor
(`data-focused`).

- **Label resolution:** `repoAliases[repoId]` (per-repo alias) → **main
  worktree**'s alias (renaming the main folder renames the group for free) →
  derived basename (main's basename, else `basename(dirname(repoId))`, else the
  raw repoId).
- **Disambiguator:** when 2+ groups in the SAME zone resolve to the SAME
  label, each gets a **dim hint** with the parent dir's name (`· org-a` / `· org-b`),
  `--text-4` `10.5px`, to tell two `www` repos apart even before any rename.
- **Context menu:** right-click on the row opens an inline menu (Teleport,
  same visual idiom as `FolderMenu` — dismiss via Esc / click-outside / wheel):
  **Rename repo** (`pencil-line` icon) → opens `RenameRepoDialog`; **Reset name**
  (`rotate-ccw` icon, only when there's a custom alias) →
  `setRepoAlias(repoId, '')`, back to the derived basename. The alias is
  **renderer-only**, persisted in `localStorage` (`om2tab.repoAliases`), same as
  `collapsedRepoGroups` (also per-repoId) — no round-trip through
  `projects.json`. **No new tokens.**

### Session name

Every surface that names a session — sidebar row, top bar, fleet card, triage
and `RETURN HERE` rows, Approval Inbox, jump palette, `⌘K` palette, footer,
folder view, cloud panel, mission popover/rail, notifications — resolves it
through **one** function, `sessionTitle()` (`lib/session-label.ts`, BUG-78), so
two surfaces can never show two different names for the same session. Order
(each candidate trimmed; whitespace-only counts as empty):

1. **Teammate** (`teamName` set) → its `agentName`. An `agentName` without
   `teamName` is ignored — it is not teammate identity.
2. **Fork synthetic** → `session.forkPlaceholder` ("Fork of …") with the
   **source's** own name (rules 1 and 4 only — no recursion into a fork of a
   fork), else `session.unnamed`.
3. **Plain synthetic** → `session.newPlaceholder` ("New session").
4. `summary` (custom-title / ai-title) → Haiku `aiSummary.title` →
   `firstPrompt`.

Nothing left → empty, and each surface appends **its own** fallback:

| Surface                                                | Fallback                             |
| ------------------------------------------------------ | ------------------------------------ |
| Sidebar row, fleet card, Fleet minicard                | `session.unnamed` ("Untitled")       |
| Triage queue, `RETURN HERE` row, footer                | `session.newPlaceholder`             |
| Jump palette, `⌘K` palette, folder view, OS/toast body | the session id                       |
| Mission popover / step rail                            | id prefix (rail: folder alias first) |
| Top bar, Approval Inbox, cloud panel, recents          | none (empty)                         |
| Spoken notification                                    | none — **never** the id              |

The top bar's and sidebar's **folder-terminal** label ("Terminal") is decided
before the session name — a terminal is not a Claude session. The sidebar
filter matches a session by this name too, so every label you see is
searchable.

### Session rows (sidebar)

Stacked visual states:

| State            | Background                | Color                   | Decoration                                                   |
| ---------------- | ------------------------- | ----------------------- | ------------------------------------------------------------ |
| Default          | transparent               | `--text-2`              | —                                                            |
| Hover            | `rgba(255,255,255,0.025)` | `--text-2`              | scale(1.003) on transform                                    |
| Selected         | `rgba(217,119,87,0.08)`   | `--text`, weight 500    | 2px `--accent` bar on the left (border-radius `0 2px 2px 0`) |
| Faded (idle-old) | transparent               | `--text-2` opacity 0.62 | —                                                            |

#### Row anatomy & indentation (fixed slots)

A session row is a strict horizontal sequence of **fixed-width slots** so the
label baseline never shifts between rows, whatever status a row carries:

1. **Left indent** — `padding-left`, the only value that varies by density and
   nesting (see the table below). This is the empty column that indents a
   session under its folder; it aligns the row's leading edge under the folder
   **icon** (not the folder label), which is why it is far smaller than the
   folder-label offset.
2. **Agent-toggle slot** — fixed `12×12`, centered. Holds the disclosure
   chevron on a session that spawned subagents; empty (but reserved) otherwise,
   so agent and non-agent rows align.
3. **Status slot** — fixed `14×14`, centered. Holds **exactly one** status
   glyph: the `6px` dot (working / needs-input / failed / stuck / idle / archived)
   OR an `11px` icon (`check` completed, `cloud` non-resumable, `moon` hibernated).
   **This slot is mandatory and fixed** — a `6px` dot and an `11px` icon must
   occupy the _same_ column, or the label start drifts row-to-row (the bug this
   rule prevents). A **terminal row reserves both slot 2 and slot 3 exactly as a
   session row does** (an always-empty `12×12` toggle slot, then the `14×14`
   status slot holding its `square-terminal` icon or status dot), so a terminal's
   label starts in the **same column** as its folder's session labels — a
   terminal reads as a child of the folder, not as a sibling of it. Teammate
   child rows use a `13×13` status slot (agent child rows carry a fixed `bot`
   glyph, so they need none).
4. **Gap** `9px` (Comfortable) / `8px` (Compact), then the **label**
   (`flex-1 truncate`).

**Indentation** (`padding-left`), by density × context:

| Context                           | Comfortable | Compact     |
| --------------------------------- | ----------- | ----------- |
| Session — flat (no repo group)    | 24px        | 16px        |
| Session — nested under repo group | 44px        | 32px        |
| Session — drill-in folder screen  | 12px        | 8px         |
| Agent / teammate child row        | indent + 16 | indent + 14 |

The **drill-in** folder screen (§6 → drill-in) renders its sessions
`headerless`, so it uses the small drill indent — the back-row header already
names the folder, and there is no tree depth to justify the classic offset.

#### Trailing chips overlay the label (no reserved column)

The trailing signal chips (subagent count, teammate-group count, StopFailure
badge, orchestrator crown, mission chip — §6 "Mission progress") live in an **absolutely-positioned** cluster pinned
to the row's right edge — they do **not** reserve a horizontal column in the
flex flow. The label therefore always spans the full row width and truncates
under the chips. A short left-fading scrim (~24px, faded in with a
`mask-image` gradient) sits behind the cluster so the truncated label reads
cleanly beneath it. The scrim paints the row's own fill — `--sidebar`, with
`--accent-soft` layered on a selected row and the hover tint on a hovered one —
so the row background stays continuous behind the chips.
Hover-gated chips (subagent count, collapsed teammate count) and their scrim
reveal on row hover / keyboard focus / selection; always-on signals (failure,
orchestrator, an expanded teammate group) keep their scrim visible. This is what
lets a narrow sidebar keep readable labels instead of crushing them to make room
for a rarely-needed count.

#### Branch (footer, not in the sidebar)

Session rows **don't** show a branch chip. The **active** session's branch is
shown in the footer / status bar (HUD — see §6 "Footer / status bar"), which is
the single source for that information. The sidebar stays focused on identity
(alias, status, count) without per-line branch noise.

#### Context % and relative time (hover preview, not in the sidebar)

Session rows **don't** show a context % chip or a relative-time
(`relativeTime`) chip — both already live in the **Hover preview**
(`SessionPreview.vue`, §3.9): context % on the `cost · context · lines` line
and relative time in the card header. Same reasoning as the branch above — the
sidebar stays focused on identity and functional signals (status dots,
agent/teammate badges, StopFailure, orchestrator) without duplicating data the
hover already shows in full. The Hover preview is the **single source** for
these two fields; the context % there reuses the same per-band color coding
(`contextTextClass`) the row used to have, so the "close to /compact" signal
isn't lost in the change.

#### Age filter (Show sessions within)

The global **"Show sessions within"** preference (Settings → SIDEBAR) hides,
within each expanded folder, session rows older than the chosen window (`All` /
`24h` / `48h` / `7d`, default `48h`). The filter **never** hides the selected
session, a live session (PTY / `working` / `needs-input` / `active`), a
synthetic one, or any session during a text search (search covers the entire
history). The `olderCount` (how many the window hides) doesn't change with
expand/collapse.

When ≥1 session is hidden, the folder row's **older** cluster item (`clock`
icon + count — see "Inline action cluster" above) is how you reveal them;
there's no more reveal row at the end of the list. Triggering the item on a
**collapsed** folder expands and reveals it; on an **already expanded** folder,
it toggles reveal ↔ hide. The item turns `--accent` while revealed and the
tooltip swaps between `Show {n} older sessions` ↔ `Hide older sessions`. The
reveal is **ephemeral per folder** (doesn't persist — resets on reload **and
when the folder collapses**, via `forgetPeeks` in the store); it's just a
momentary peek. Resetting on collapse is what keeps the cluster item honest: in
an always-visible folder, a peek left marked in a closed folder would show
"Hide" `--accent` with nothing revealed, and the next normal expand would open
already showing what the user didn't ask for. The same pattern applies to
**archived** (`archive` icon + count, "Archive" action), with tooltip
`Show {n} archived` ↔ `Hide archived`.

#### "Terminals" sub-group (sidebar)

A folder can host **terminals** — plain shells tied to the folder's cwd
(`createFolderTerminal`), for running git, builds, creating worktrees, etc. —
**without** Claude. It's the explicit split in the operator's mental model:
**sessions** (Claude) on top, **terminals** (shell) below. A terminal is NOT
`synthetic`; it carries the explicit `isShellTerminal` marker and an id
`shellterm-<uuid>`, so it never enters the migration/collapse/auto-name/
slug-reconcile machinery for synthetics (lesson 003). It's ephemeral: it
survives a renderer reload, not an app restart.

**Creation:** the **"New terminal"** item in the Folder context menu
(`square-terminal` icon) — see "#### Folder context menu" below.

**Render:** below the session rows and "+ New session", when there's ≥1
terminal:

- **"TERMINALS" eyebrow**: reuses the Section-label typography (uppercase
  `10.5px`, weight 500, `letter-spacing 0.06em`, `--text-4`), height `22px`
  (`20px` Compact), starting at the **shared label column** (session indent +
  the reserved toggle + status slots, see "Row anatomy & indentation" above) so
  it heads the terminal rows it labels instead of hanging left of them.
- **Terminal row** (height `26px` / `23px` Compact, same session indent + the
  two reserved leading slots, `gap 9px`, `font-size 12.5px`):
  `square-terminal` icon `13px` (`--text-4`, or `--text-2` when selected), label
  `Terminal {n}` (`truncate`), and — on the right, visible on hover or when
  selected — an `X` button (`12px`, `18×18` hit area, `--text-4` → hover
  `--text` + `--surface-2`) that closes the terminal (`closeFolderTerminal` →
  kills the shell's PTY and removes the row). Selected reuses the session rows'
  anatomy: background `rgba(217,119,87,0.08)` + `2px --accent` bar on the left.

Terminals **don't** count toward the folder's count badge, don't appear on the
Fleet board, and have no status dot or OS notifications (a shell exiting isn't
a "completed task"). In the topbar the title is fixed as `Terminal` (not
editable).

### Agent row (sidebar)

Sessions that dispatched **parallel agents** (Task tool subagents) list those
agents **nested** right below the parent session's row. The relation is hard:
the subagent lives at
`~/.claude/projects/<slug>/<parent-session-uuid>/subagents/agent-*.jsonl`, so
the subdirectory name IS the parent's `sessionId` — no heuristics.

> **v1 scope:** subagents only (hard link). SDK reviews (`entrypoint:
"sdk-py"`, e.g. `/security-review`) have **no** hard link to the parent —
> attribution would be heuristic (worktree + time + diff). In v1 they stay
> filtered out (issue #6); nesting them is deferred to v1.1. Documented so the
> next maintainer doesn't assume reviews show up here.

#### Expand/collapse toggle

The parent session's row gets a **chevron** on the left (before the status
dot) **only when there's ≥1 agent**. `chevron-right` icon (`size 11`,
`--text-4`, rotates 90° when open), with `@click.stop` so it doesn't select the
session. Next to the timestamp, a discreet counter `--text-4` (`font-size:
10.5px`, `tabular-nums`) shows the number of agents. The open/closed state is
**persisted per session** in `localStorage` (`om2tab.agentsExpanded`, mirroring
`stores/theme.ts`); starts collapsed for sessions never opened.

#### Agent row anatomy

Indent `pl 60px` (one level beyond sessions, which sit at 44px). Height `24px`,
`font-size: 11.5px`, `gap: 7px`. Left to right:

1. **Connector** `corner-down-right` (`size 11`, `stroke 1.6`, `--text-4`) — the
   `↳`.
2. **Agent icon** `bot` (`size 12`, `stroke 1.6`, `--text-3`).
3. **Agent type** (`attributionAgent`, e.g. `general-purpose`, `explore`) in
   `--text-2`, `truncate`, `flex-1`. When `attributionAgent` is empty, falls
   back to the generic label `$t('agent.subagentLabel')` ("subagent").
4. **Source** (optional — `attributionSkill`/`attributionPlugin`, e.g.
   `superpowers:dispatching-parallel-agents`) in mono `--text-4`, `font-size:
10px`, `truncate`, `max-width: 120px`. Omitted when empty.
5. **Status pill** (see below).

Hover uses the same `rgba(255,255,255,0.025)` as session rows. The agent row
**isn't selectable** in v1 (no terminal of its own — the subagent flows in the
parent's transcript); it's informational.

#### Agent status

| State       | Visual                                                                                                                        | Notes                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **running** | Green 6px dot `--green` + pulsing `--green-soft` halo (same `pulse-ring` as an active session) + `running` label in `--green` | Subagent file received a recent append (< 15 s) |
| **done**    | `check` icon (`size 11`, `--text-4`) + `done` label in `--text-4`                                                             | No recent append; finished (or historical)      |

Status derivation (heuristic — there's no clean end marker in the subagent's
JSONL; the last line is `assistant/text` with `stop_reason: null`): at seed,
`running` if `Date.now() - fileMtime < 15 s`, else `done`. Live, a watcher
append (`claude:subagent:updated`) flips it to `running` and re-arms a 15 s
timer that falls back to `done` on silence. The status label is lowercase and
has no period (§8).

### Teammate group (sidebar)

Sessions created by Claude Code's native **agent-teams** feature (multi-agent
via `--teammate-mode`) write, on every JSONL line since the first `user`
message, two top-level fields: `teamName` (`session-<8 hex chars of the
leader's sessionId>`) and `agentName` (the teammate's short name, e.g.
`spec-ui`). Without this, a teammate shows up in the sidebar as a loose session
with the raw internal message label. The sidebar uses both fields to pull
teammates out of the flat list and nest them under the team-lead's session.

#### Leader present vs. absent

The **leader** is the session, in the SAME folder, whose `sessionId` starts
with the `teamName`'s hex (e.g.: `teamName: "session-7399191c"` → leader is
`7399191c-…`). The leader search scans **all** sessions in the folder — not
just the ones that pass the sidebar's age window — because the leader
typically goes idle as soon as it dispatches the team (it's waiting on the
teammates), so a search limited to the visible window would lose the team's
own leader the instant it stopped being "recent". Archived sessions stay out
of the search (archiving is an explicit user action, unlike the implicit age
cutoff).

- **Leader present in the folder** (at any age) — teammates leave the flat
  list and render nested under the leader's row, in the same place where
  "Agent row" (above) nests subagents. If the leader itself wouldn't pass the
  age filter, its row is **inserted** at the first teammate's position — it
  shows up precisely because it has an active/recent team to anchor. The
  leader's row gets a `users` **chip** + count (same anatomy as the bot chip —
  icon + `tabular-nums`), clickable to expand/collapse the group.
- **Leader absent from the folder** (no session, at any age, matches the
  prefix — e.g. the leader's session was deleted from disk, or the team runs
  in a different folder) — the group is **orphaned** and hidden from the
  sidebar entirely: no header, no nested rows. This is the residual case —
  the widened search covers the common case (idle leader, outside the age
  window) — and it's deliberately silent rather than standing in a row the
  operator cannot act on (T168; superseding T99's original synthetic-header
  fallback, which had no context menu — no Archive, no Delete — and whose
  displayed count only reflected the sidebar's own display window, not the
  group's real size on disk).
  - **Exception:** a teammate that is the sidebar's currently **selected**
    session never disappears, orphaned or not — it renders as an ordinary
    flat session row (see "Teammate row anatomy" below for how its label
    still resolves correctly outside the grouped/nested zone). This keeps an
    open terminal from losing its sidebar row out from under the operator.
  - An orphaned-but-hidden teammate that is `working` or `needs-input` still
    surfaces through the Fleet rail, which reads from `sessions.allSessions`
    independently of this grouping — hiding it from the sidebar tree never
    makes it unreachable.

Groups **start collapsed**. The state (expanded/collapsed) is persisted in
`localStorage` (`om2tab.teammatesExpanded`), keyed by the leader's `sessionId`.

#### Teammate row anatomy

Indent `pl 60px` (same level as the agent row), `corner-down-right` connector.
Unlike the agent row (an informational `<div>`, no terminal of its own), **a
teammate IS a real session**: the row is a clickable `<button>` with the SAME
anatomy as a normal session row — status dot (same `statusDot`/`activityOf`
machine as §"Session status"), label = `agentName` (never the raw message
content), relative time. Selecting it calls the same selection action as any
session, subject to the guard below.

Teammates stay always visible inside the group (expanded or not); only the
group itself collapses.

Outside the grouping (e.g. the "Active elsewhere" zone, before nesting), the
label cascade for any **teammate** (`teamName` set) uses its `agentName` —
never the raw `firstPrompt` — so a teammate never shows the agent-teams
message's internal text anywhere in the sidebar. An `agentName` on a session
without `teamName` is ignored by the label: it is not teammate
identity, and preferring it would freeze a renamed session at a stale name.

#### Active teammate guard

Selecting a teammate whose current activity is **`working`** (same
`fleet-state.ts` classifier that feeds the dot) asks for confirmation before
opening: the team-lead may be driving that teammate right now, and a manual
`claude --resume` would open a second writer on the same JSONL. A teammate
that's `idle`/`stuck`/inactive opens directly, with no friction — the
confirmation is only for the active case.

### Roadmap board (lifecycle kanban)

The **wide, side-by-side-columns panel** that the Fleet status board above
explicitly is **not**. These are **two deliberately separate boards**: the
sidebar's Fleet board answers _"who needs me NOW?"_ (attention, narrow,
vertical stack); the Roadmap board answers _"where is each piece of the PLAN?"_
(lifecycle, wide, columns). The Roadmap board is a **VIEW derived from Project
Memory** (`.harnu/memory/roadmap/`, T79): **1 card = 1 `.md` file with frontmatter
`status`**; columns derive from `status`; the files are the single source of truth
(the view never writes state outside the `.md`).

**Where it lives.** It's a surface of the **main body** (the transcript area), **per
repo**, opened from the folder's Context menu (`Roadmap board`, `kanban-square` icon)
**or from the Topbar's right cluster** (see "Topbar per-repo view buttons" below —
same 26×26 button anatomy as the other Topbar actions, acting on the **selected
session's** folder). It is **not** a sidebar mode of any kind. It sits
**outside the floating-surfaces mutex** (it's a content view, not an overlay); **Esc**
and **selecting a session** close it (reveal the terminal). Sibling of the future Memory
pane on the same project surface.

**Board header: `TakeoverShell` chrome (T300/U3, see "TakeoverShell — shared chrome"
above)** — `kanban-square` icon, title, close `x`. Teleported into the shell's header:
repo label (`--text-3`) right after the title; then, pushed right by the board's own
spacer, the **header-counts eyebrow** (T80 S2 PR2, `.eyebrow`) — `"{n} cards · {m}
working"` — `n` is every non-done card left after the filter bar's search + kind filters
(Done is always excluded from `n` regardless of the Hide-done toggle); `m` is the count of
bound sessions currently `working` per the SAME `classifyFleetState` wiring the card
dot reads (§ below), unaffected by the filter bar (it's a fleet fact, not a view
setting); and the **WIP chip** (In Progress `{n}/5`, `tabular-nums`, PRESERVED — a
distinct, older signal). The In Progress WIP
limit is **5** (default) — the 4–5 simultaneous-supervision ceiling (Cummings, T79 §5)
becoming a **board rule**: above 5 the chip tints `--warning` over `--red-soft` (the
science as structure, not help text). The limit is an **ACTIVE soft cap** (S4):
dropping OR dispatching a card that pushes In Progress past the ceiling **warns** via
toast (with an explicit override — the card moves anyway), never blocks. The raw count
(`wipStatus`/`wouldExceedWip` in `roadmap-core`) is measured BEFORE the move.

**Filter bar (T80 S2 PR2, 38px, `--bg`, `border-b --border`, directly under the board
header, above the columns).** Same visual system as the mockup's `.filterbar`
(`.harnu/memory/mockups/card-modal/v1-dossier.html`), existing tokens only:

- **Search** (`.search`, `--surface`/`--border-2`, `--radius-sm`, 200px, focus →
  `--accent-line`): a `search` (lucide) glyph + a text input, placeholder
  `roadmap.filterBar.searchPlaceholder` ("Filter cards…"). Filters LIVE by
  substring match against a card's `id` + `title` (case-insensitive). Ephemeral —
  never persisted (§ Persistence below).
- **Kind chips** (`.kindchip`, one per `roadmap-core.CARD_KINDS` — `bug · feature ·
chore · scout · review`, pill, `--surface`/`--border-2`): `on` state fills
  `--accent-soft`/`--accent-line` text `--text-2`; `off` state is the same pill at
  **40% opacity** (`opacity-40`, no color swap — a quiet dim, not a second palette).
  Filtering is opt-out, not opt-in: with **zero** chips on, every kind passes (matches
  the mockup's own filter semantics) — a card with no `kind` at all always passes
  (a filter can't hide what it can't classify).
- **Separator** (`.fsep`, 1px `--border`, 18px tall) then **Group** (`.seglabel`
  `--text-4`) + a `SegmentedControl size="sm"` with 3 options — `epic | kind | none`
  (`roadmap.filterBar.group.*`) — see "Group-by" below.
- **Separator** then **Hide done** — a `ToggleSwitch` + label (`--text-3`, 11px). ON
  (default) collapses the Done column to the rail (below); OFF expands it to a normal
  5th column. The SAME state also drives (and is driven by) clicking the rail itself —
  one boolean, two entry points.
- **Separator** then **Worktree** — a `.seglabel` label + a plain `<select>`
  (`--surface`/`--border-2`, `--radius-sm`, same pill height as the kind chips),
  listing the distinct branches present across the loaded cards (origin OR owner,
  deduped) plus a leading `roadmap.filterBar.worktree.all` entry ("All worktrees").
  Choosing a branch scopes the board to cards **born on it OR executed on it**
  (union, D3) — `matchesWorktreeScope` in `board-filters.ts`; a card with neither
  fact recorded only ever matches "All". **Auto-scope on open (D2):** opening the
  board from a folder that is not the repo's main checkout and has a resolvable
  branch pre-selects that branch — the dropdown makes the active scope visible
  rather than silently filtering, and switching back to "All worktrees" is the one
  click that clears it. **Ephemeral (D6):** unlike the kind chips/group/hide-done
  above, this selection is **never persisted** — it always resets to the
  auto-scope (or "All") on every board open, so a stale scope from yesterday can
  never silently hide today's board.
- The bar ends with a flexible spacer, then **`+ New card`** (T80 S2 PR3, B8,
  `.btn.new`, `--radius-sm`, `--accent-soft` background, `--accent-line` border,
  `--accent` text; hover deepens the border/text to solid `--accent`) on the far
  right — even on an **empty board** (no cards yet), the bar itself still renders
  so the button stays reachable to create the first one. Clicking it opens the
  card detail modal in **create mode** (below).
- **Overflow:** every direct control in the bar is `shrink-0` — none of
  them may be squeezed below its own natural width (a shrinkable `flex-wrap`
  child, like `SegmentedControl`'s root, would otherwise collapse to its
  narrowest child and explode onto multiple rows). If the bar's full content
  still doesn't fit, the bar itself scrolls horizontally (`overflow-x-auto`)
  rather than squeezing or wrapping any child — paired with the shared
  `scrollable` class (`main.css`) so the scrollbar is themed, not the native
  OS one, matching the same `overflow-x-auto`+`scrollable` pairing already used
  by this same "Roadmap board" section's own columns row (`RoadmapBoard.vue`).

**Group-by (T80 S2 PR2).** Inside each column's body, cards render under **eyebrow
sub-headers** (`.group-head`, `.eyebrow` + a mono count `.cap` in `--text-4`) instead
of one flat list — the in-column sort (priority, then id) is preserved within each
group, only the bucketing changes:

- **`epic`** (default-visualized in the mockup) — bucketed by the card's `parent`
  , label = the resolved parent card's `"{id} · {title}"` (falls back to the
  bare parent ref if the parent isn't on this board — still shows something rather
  than nothing). Cards with no `parent` land in a **trailing unlabeled bucket** — no
  `.group-head` rendered at all for it (same flat look as `none` mode), always LAST
  regardless of where it would sort by first-appearance.
- **`kind`** — bucketed by `card.kind`, label = the kind name verbatim (untranslated,
  same as the compact-card kind chip); a card with no `kind` falls into the same
  unlabeled, header-less trailing bucket.
- **`none`** — today's flat list, unchanged (no group headers rendered).

**Columns (5 fixed, derived from `status`):** `Backlog · Ready · In Progress ·
Review · Done`. `status` is the **only column primitive**; `blocked: true` is a
**FLAG (badge on the card)**, never a column — this keeps the board at 5 readable
columns. Each column: **eyebrow** (`.eyebrow`, §3 — label + count in `--text-4`), width
`272px`, `shrink-0`, vertical scroll (`.scrollable`); `--border` border over
`bg-surface/40`, and on **drag-over** turns `--accent-line` + `bg-surface`.

**Done rail (T80 S2 PR2).** When **Hide done** is ON (default), the Done column
collapses from a `272px` column into a **36px vertical rail**
(`.railcol` — `bg-sidebar`, hover `bg-surface`, `cursor: pointer`): a chevron
(`chevron-left`, `--text-4`) over a `writing-mode: vertical-rl` label
`"Done · {n}"` (mono, 10.5px, uppercase, `--text-4`, `roadmap.filterBar.doneRail`),
`n` = the Done column's card count AFTER the search/kind filters (so the rail number
never disagrees with what a click would reveal). Clicking the rail flips **Hide
done** OFF, expanding Done into a normal column with the same card anatomy, group-by,
and drag rules as every other column — **dragging a card onto Done (rail or
expanded) is still blocked** (§ Drag-and-drop below); only the human Close action
reaches Done, collapsed or not.

**Persistence (T80 S2 PR2, E9).** The kind-chip set, group mode, and Hide-done state
persist **per repo** under `om2tab.roadmap.filters.<repoKey>` in `localStorage`
(same mirrored-`localStorage` pattern as `stores/theme.ts`'s `om2tab.theme`) — reopen
the board on the same repo tomorrow, the filter chrome is exactly where it was left.
The search text is **ephemeral** (never written to storage) — a stale search query
silently hiding a repo's whole board on next open would be a worse default than
always starting empty.

**Card anatomy** (`bg-surface`, `--border`→`--border-2` border on hover, `--radius`,
`cursor: grab`; `draggable`):

1. **Line 1 — live state dot + title + provenance.** The **6px dot** of a card with a
   linked `session` reflects that session's **`classifyFleetState`** (S3), reusing the
   **`FleetBoardCard` state tokens** (the SAME engine as the sidebar dot — it
   never diverges): `working` (`anim-pulse-dot` `--green`), `needs-you`
   (`anim-attention-dot` `--warning`; `return-here` doubles here), `stuck` (hollow ring
   `--red`), `idle` (`--text-4`). No session → hollow ring `--text-4` (placeholder).
   Title in `--text` (13px, leading-snug). On the right, the **provenance icon**: `user`
   `--text-4` (human) or `bot` `--warning` (agent — the marker matters because S2's
   auto-dispatch **gates** on it).
2. **Line 1.5 — pulse.** When the linked session has a pulse (Haiku's "doing now"), the
   last sentence appears truncated (mono `--text-3`, `pl-3`) — the board shows what each
   agent is doing right now without switching sessions (§3.6, reuses the session's
   `pulse` field).
3. **Line 2 — meta.** `id` (mono `--text-4`); **`blocked`** badge (`--red-soft` +
   `--warning`) when flagged; `deps` (`git-branch` + count); `evidence` count when
   present. **(T105, schema v2):** a `kind` chip and a `complexity` chip when the card
   declares them; a `↑ <parent>` chip (`--text-4`) when the card has a parent (1 level
   only — no dedicated swimlane, that's future I5); and a **readiness** badge (reuses
   the `blocked` tokens — `--red-soft` + `--warning`) when `lintCardReadiness` reports
   a gap (e.g. `standard` without `## Acceptance criteria`) — **never blocks**, only
   warns, same as the WIP soft-cap. **(T80 S2 PR2 — colored kind chip, same tokens as
   the card-detail modal's `kindChipClass`, no longer plain `--text-3`):** `bug` →
   `--red-soft`/`--red`; `feature` → `--accent-soft`/`--accent-line`/`--accent`; every
   other kind (`chore`/`scout`/`review`) stays the quiet `--surface-2`/`--border-2`/
   `--text-3` pill. The `complexity` chip is unchanged (`--text-4`, discreet). **(T80
   S2 PR2 — bound-session chip):** when the card carries a `session`, a mono chip
   (`terminal` glyph 10px + the session id's first 7 chars, `--green` text, same pill
   shape as the other meta chips) appears alongside the kind/complexity chips — a
   glanceable "this card has a live/linked session" signal distinct from the dot
   (which shows STATE; the chip shows IDENTITY, so a human can tell two bound cards
   apart at a glance). The existing **Open session** action button (line 3) is
   unchanged and stays the click target — the chip is identification only, not a
   second button. **(T190 — worktree chip):** a `git-branch` glyph (10px) + the
   short branch name (mono, truncated), one chip, exactly one precedence order:
   `executedIn` (the stamped owner branch) as a **solid** pill (`--surface-2`/
   `--border-2`/`--text-3`, same quiet tokens as the complexity chip); else a
   **derived** owner (runtime-only substring match of the card id against local
   branches, never written to disk) in the SAME pill with a **dashed** border
   instead of solid — the only visual difference, so a guess never reads as a
   fact; else `provenance.branch` (the origin) as a solid pill; else no chip at
   all. Never more than one branch chip renders.
4. **Line 3 — actions.** **Dispatch** (`rocket`, `--accent-soft`/`--accent`) on
   `backlog`/`ready` cards **without** a session; **Open session** when a session is
   linked; **Move to Review** (`git-branch`, `--green-soft`/`--green`) on an
   `in-progress` card whose evidence says the work **has landed** (S3 — below); **Close**
   (on `review`, hover `--green-soft`/`--green`) → moves to Done.

**Evidence-based Review suggestion (S3 — golden rule §3.5).** A linked `in-progress`
card is reconciled against its branch's **merge-evidence** (`git rev-list
--count origin/main..<branch>` — the SAME gap we used to check by hand): if there are
unmerged commits (or the session reported `completed`), the card **suggests** the move
In Progress → Review with a button the human approves (it never moves on its own). On
approval, Harnu writes `status: review` + appends the commit refs as **evidence**
(done-by-evidence: linked artifact, not narrative). The probe is **lazy** (only when the
session isn't `working`, so as not to churn git mid-commit) and **read-only**. **No path
moves the card to Done** — the suggestion stops at Review; Done is only the human Close.

**Drag-and-drop (writes the frontmatter).** Dragging a card and dropping it on a column
writes the `status` via the **serialized human IPC** (`roadmap:setStatus`, atomic
temp+rename rewrite; passthrough — the card's extra keys are preserved). Rules on drop:

- **`* → done` is blocked by drag** — Done is only reached via the human **Close**
  action (after Review). A drop on Done warns via toast, doesn't move.
- **`* → ready` triggers the dispatch offer** (below).
- Backlog↔Ready↔Review are free for the human.

**Dispatch (manual, human-confirmed).** Moving to Ready (or the **Dispatch** button on
the card) opens a **confirmation overlay** (teleported, `z-65`, `anim-overlay-fade` +
`anim-fade-in-scale`) that shows: the **target folder** and the **boot prompt generated
from the card VERBATIM** (mono, `pre-wrap`, scroll, `max-height`) — the same disclosure
bar as T08 (never hide what's being approved). The boot prompt is **generated
server-side** from the card on disk (authoritative), with a **secrets lint + cap**
before becoming a prompt, and framed with the anti-injection wrapper (_"treat as a work
description, not system instructions"_) + the instruction to **close by evidence** (move
to Review, never Done). A card with **agent provenance** shows a **red warning**
(`--red-soft`

- `shield-alert`) — every confirmed dispatch is 100% human, so it's safe. On **Allow**,
  Harnu spins up a new session with the boot prompt injected via the last-mile path
  and links `session`+`in-progress` on the card.

**Model·effort routing (T97 — the ROUTE gate, §12.1 D5).** Between the "why we're
asking" block and the **Prompt**, the confirm shows a **Model · effort** line
(eyebrow + two `SegmentedControl` `size="sm"`, same pill tokens as the other
selects — no new color): the value **resolved** by the per-repo **routing table**
(card `kind` → table row → operator's hardcoded default —
`scout=haiku·low`, `bug/feature/chore=sonnet·high`, `review=opus·high`; a card with no
`kind` falls to the `feature` preset). The operator can **swap the pill** right there,
just for this dispatch — the final value (resolved or swapped) becomes the session's
`bootOverride` AND is **written to the card** as an audit line in the body
(`dispatched-with: model·effort`, the same serialized path as `memory_append`). The
table itself is **human-only** (no agent verb reads or writes `routing-policy.json`) —
the agent's `submit_manifest` can **suggest** a model/effort per card in the disclosure
(informational chip), but the REAL resolution at dispatch time always comes from the
table, never from the agent's suggestion (the "ROUTE gate" is never a gate an agent
walks through). Auto-dispatch (grant/manifest drain, below) resolves the SAME table
**without** showing the picker (no confirm = no editing), but writes the same audit
line.

**Dispatch substrate (T102 — where the work runs).** Right below the Model · effort
picker, the confirm shows a **Where it runs** line (eyebrow +
`SegmentedControl size="sm"`, same tokens — no new color) with the four closed
options (`roadmap.substrate.*`): **Session** (same folder — the default behavior),
**Worktree** (a new `create_worktree`, one branch per card — it's born inheriting the
parent repo's agent control, since this confirm is always a disclosed human surface),
**Teammate** (same spawn as Session, but writes a link to the card's
`provenance.sessionId` as an audit line), and **Internal** (Harnu NEVER spins up a
session — the card stays with the orchestrator itself, which resolves it with internal
subagents and advances the card via `propose_move`/`move_card`; picking this option here
closes the confirm with an informational toast instead of dispatching). The resolved
value (card frontmatter, default `session`) comes pre-selected; the operator can swap it
just for this dispatch — the final value is written to the card together with
`session`/`in-progress` in the same `roadmap:bindSession`. The **same selection** appears
in the manifest checklist (below) as a per-card `<select>` — the operator can override
the substrate there, and the choice is stamped alongside `approved` (before the drain
runs). An `internal` card never enters the auto-drain queue or the "Dispatch" button —
clicking it shows the same informational toast.

**Auto-dispatch under a mission grant (S2 — ⚠️ gated §0).** A **mission grant**
scoped to the board's repo, with `create_session` among its verbs, removes the
**per-card** confirm: moving a card **of human provenance** to Ready **auto-dispatches**,
spending 1 unit of the grant's budget (the same atomic `reserve`/`release` as the
http-guard). Two safety invariants visible in the UI:

- **The decision is server-side.** The renderer calls `roadmap:planDispatch`; main
  consults the **same `grantDecision`** as the MCP gate (full paths live there) and
  decides `auto` vs `confirm`, already reserving the budget on the `auto` path. The
  spawn remains a **full-permission human session** (never a downgraded agent
  session) — the grant only removes the confirm **click** for a card the human wrote.
- **Fail-closed.** A card with **agent provenance** (including missing/malformed
  provenance, assumed `agent`) **always** falls to the confirm, even under a grant. A
  dead/exhausted/out-of-scope grant **escalates to the confirm** (never silently
  extends nor denies — invariant 6), with the overlay explaining why
  (`roadmap.dispatch.reason.*`).

A live grant covering the board appears as a **strip** (`border-b --accent-line` over
`--accent-soft`, `shield-check` icon): goal + remaining budget (`{n}/{total}`,
`tabular-nums`) + TTL + a **Revoke** button. It's the T44 grants surface
(`useMissionGrants`) reused per-board; auto-dispatch **keeps the board open** (fan-out:
dropping several cards under a grant) and toasts the spend (`kind: success`, remaining
budget).

**Dispatch manifest (T104 — the single organize↔execute gate for agent-provenance
cards).** The S2 above only auto-dispatches a card of **human** provenance; a card of
**agent** provenance never skipped the confirm (§6.1) — until the manifest opens a
second path to `auto`, additive, never replacing the one above:

- **The manifest item in the Inbox is the list, not a text blob.** The `submit_manifest`
  verb (agent → Harnu) is **never** silent-allowed nor covered by a grant — it **IS** the
  gate request, so it **always** lands as a confirm (modal if focused, parked if not —
  same agent-action variant as above). The disclosure reuses the **Prompt** markup
  (mono, `pre-wrap`), but instead of a single block it's a **list with a checkbox per
  card** (`agentConfirm.manifest.cardsLabel`): title + `slug` + `kind`/`complexity`/
  `model` chips (the same discreet card tokens as the board card) + the **readiness
  gaps** (`--warning`, reuses `lintCardReadiness`) + a `<details>` preview of the **boot
  prompt** that would be generated (`previewPrompt`) — all assembled **server-side from
  disk**, never from the agent's text. A cost note (`manifestCostNote`) closes the
  list — today always "no history" until the T47 heuristic exists.
- **Substrate is a per-card `<select>`, not a chip.** Below each row's checkbox,
  a small select (`agentConfirm.manifest.substrateLabel`, the same four
  `roadmap.substrate.*` options) comes pre-selected with the resolved substrate (card
  frontmatter, or the `substrate` the agent suggested in `submit_manifest`, default
  `session`) — the operator can change it before Allow. The choice travels on
  **Allow** via `manifestSubstrateOverrides` (slug → substrate) and is written to the
  card **together with** the `approved` stamp — before the drain runs, so the drain
  never needs to negotiate substrate separately.
- **Partial-go is native, not a denial.** Every card starts **checked**; unchecking
  before Allow simply leaves that card out — it remains organizable, unstamped,
  eligible for another manifest later. The checked slugs travel on **Allow** via
  `mcpConfirmRespond(id, 'allow', { manifestSelectedSlugs })` — absent (or a Deny)
  stamps **nothing** (fail-closed: the checklist is the only authorization surface
  here, unlike the extra checkboxes of the other variants).
- **Allow stamps `approved` + `approvedBodyHash` — ONLY the manifest writes these
  fields.** They're controlled fields (like `status`/`session`/`evidence`/`provenance`):
  no agent verb writes them, not even `update_card`. The hash is a fingerprint (sha256)
  of title+spec+body — **exactly** the fields that become the boot prompt — recomputed
  **at dispatch time** (never by the watcher) and compared; a mismatch → invalid stamp.
- **Discreet "manifest ✓" badge on the board card** (`bg-green-soft`/`text-green`, the
  same success tokens as the rest of the system — no new color) when `card.approved`
  exists — signals that the card already went through the operator's go, without
  occupying its own column.
- **Drain counter in the grant strip** ("`{n}/{total} dispatched`", `tabular-nums`, next
  to the budget/TTL) while a batch is draining. The drain dispatches Ready's stamped
  cards **in the order declared in the manifest** (recovered from the staggered
  timestamps Allow wrote — not column priority), **pauses** at the WIP ceiling and
  **resumes** on its own when a card leaves In Progress — no new endpoint: the stamp
  already arrives via the watcher like any card write, and the drain just reacts to it
  reusing S2's same `planDispatch`/autodispatch. A card that falls to the confirm mid-
  drain (see below) is **skipped**, it doesn't hold up the rest of the batch — a toast
  warns how many need manual review (the usual **Dispatch** button).
- **Post-go editing doesn't block, but it knocks down the stamp.** `update_card`/
  `memory_append` on an already-approved card remain zero-friction — the ACK just
  **warns** that the stamp fell. In practice this is free: since the hash is recomputed
  from disk at dispatch time, a title/spec/body edited after the go simply no longer
  matches.
- **Gate v2, additive (`decideDispatchGate`).** Nothing changes for a human card (a live
  grant is still enough, as above). For an **agent** card, with a live grant, two new
  confirm reasons add to the existing ones: **`no-manifest`** (never went through a
  manifest) and **`manifest-stale`** (went through one, but the hash no longer matches)
  — the latter shows the **"summarized diff"** (`roadmap.dispatch.staleFields`): which
  fields (title/spec/body) changed since approval, without needing to store the old
  content (only the per-field hashes).

**Golden rule (safety invariant, T80 §0 / T96 §0).** No path — agent, drag — moves a
card to **Done**; Done is only the human **Close** action, after Review. **T96:** the
agent's three direct verbs (`create_card`/`update_card`/`move_card`) write `status`
**only** within `backlog`↔`ready`↔`review`, via the SAME serialized human IPC path
(`updateFrontmatterFields`, the sole file writer) — never `done` (only the human Close)
and never `in-progress` (only exists via a real dispatch bind): the `move_card` schema
doesn't even parse those two values, so the impossibility is structural, not a runtime
check. `memory_append` remains append-to-body only and never touches
frontmatter/`status`.

**Degradation without T74 (soft dep).** Cards render frontmatter + plain text (S1).
With T74, the card's body/spec becomes rendered markdown in the card detail and `spec:`
opens in the Memory/markdown pane — a reading upgrade, not a blocker.

### Meta-board (takeover)

One glance across every open repo's roadmap. Not a replacement for the per-repo
Roadmap board above — its aggregate: the SAME 5-column lifecycle view, populated
with every known repo's cards at once, each card wearing a small repo-identity
badge. Read-only in v1 — no dispatch, no drag; acting on a card still happens
inside its own repo's board, one click away.

**Where it lives / entry point.** A global main-pane **takeover**, same visual
pattern as `Usage Dashboard`/`System Monitor`/`Cleanup takeover` (§6 above):
replaces the `<main>` content (sidebar and topbar stay visible), fixed 40px
header (`h-10 border-b border-border bg-surface`), close `X` top-right. It
joins the SAME single-takeover mutex those three already share (`stores/
ui.ts`) — opening the meta-board force-closes any other open takeover and
vice-versa; Esc via `closeAll()`. Entry point: a link in the Footer fleet
pill's popover, alongside the existing "Open full dashboard" — not a
per-folder `FolderMenu.vue` entry, since the meta-board has no single
`folderPath` to scope to (exactly like `Usage Dashboard`).

**Data source.** A new purpose-built multi-root watcher, NOT an aggregation of
the existing per-repo Roadmap watcher (which is explicitly single-instance/
retarget-only — only one per-repo board is open at a time). The new watcher
opens one chokidar instance per known repo's `.harnu/memory/roadmap/` dir,
reusing the same pure parse/column-derivation code the per-repo board already
uses. Each card carries its source repo key so the aggregated store can badge
and column-bucket it, fully separate from the per-repo board's own store.

**Header (40px, `--surface`, `border-b --border`):** icon (`--accent`) +
"Meta-board" (`--text`) + an eyebrow count — `"{n} cards across {r} repos"`
(Done excluded from `n`, same convention as the per-repo board's header
count). Close `X` on the right.

**Columns (5 fixed, same as the per-repo board):** `Backlog · Ready · In
Progress · Review · Done`, same 272px width/scroll/eyebrow treatment as the
Roadmap board. A card's column is still derived purely from its own `status`
— the meta-board never recomputes or overrides it.

**Card anatomy.** The SAME compact card the per-repo board renders (title,
kind/priority chips, evidence count, session dot) — read-only here: no drag
handle, no dispatch button, no context menu. The one addition is a **repo
badge**: a small colored pill/dot + short repo label. Colors are drawn from
the existing terminal ANSI palette (`--term-ansi-*`, §9) — a stable hash of
the repo key picks one of the palette's non-semantic slots (blue/magenta/cyan/
bright-* family). Red/green/yellow deliberately stay OUT of the rotation pool:
`--accent`/`--green`/`--warning`/`--red` already carry status meaning
elsewhere on the same card, and a repo badge must never look like a status
signal. Clicking a card opens its own repo's Roadmap board and closes the
meta-board — the one interactive affordance in v1.

**Review column: evidence × no-evidence subgrouping.** Unlike the other four
columns (one flat list), Review renders two fixed sub-lists: **"No evidence"**
on top (`bg-red-soft`/`text-warning`, the same tokens as the per-repo board's
close-without-evidence warning) and **"Has evidence"** below — keyed on
`card.evidence.length === 0`, no schema change. Each sub-list gets its own
mini eyebrow with a count; the column header additionally shows an aggregate
**"{n} without evidence"** badge, summed across every repo. Cards within each
sub-list keep the existing priority-then-id sort — no age-based "stuck N
days" sort in v1 (no review-entry timestamp exists in the schema yet). This is
the view's whole point: the exploration behind this surface found 28 of 57
real cards sitting in Review — the meta-board makes that pathology visible at
a glance, not just another rendered column.

**Performance at scale.** No virtualization library exists anywhere in the
renderer today — introducing one is real new surface, not a drop-in. V1
follows the same precedent the Footer fleet rail's "Show all" filter and the
Usage Dashboard's ranked lists already use: a capped, paginated render (top-N
per column/sub-list + a "Show all" toggle) rather than a full virtual-scroll
list. Revisit with a real virtualization pass only if measured jank at the
operator's actual scale proves the cap insufficient.

**Golden rule / degradation.** Read-only means read-only: no verb this view
calls can move a card's `status`, bind a session, or touch `evidence` — every
mutation still flows through a repo's own board (the structural guarantee
that Done/In Progress are unwritable outside a real Close/dispatch is
unchanged; the meta-board adds no new write path at all). If a repo's roadmap
dir is unreadable or a card fails to parse, that repo/card is skipped from the
aggregate exactly like the per-repo board already tolerates malformed cards —
one bad file never blocks the rest of the view.

### Card detail modal (card dossier)

The board card is the **summary**; the modal is the **task**. Clicking the card (or the
hover expand icon) opens the full dossier — Goal, ACs, interview, docs, and the
session trail — without leaving the board. It's born from a post-T82 observation: all
the history (`session` bind, `evidence`, appends with provenance, `dispatched-with`) is
already **written** to the card's `.md`, but none of it was visible in the UI. The
modal is the window; the file remains the single source of truth (every edit writes to
the `.md` via the SAME serialized path as the board).

**Surface.** Teleported overlay (`z-65`, same layer as the dispatch confirm),
`anim-overlay-fade` on the backdrop (`bg-black/40`) + `anim-fade-in-scale` on the
dialog. Panel `min(760px, 94vw)`, `max-height: 88vh`, `--radius-lg`, `shadow-pop`,
`--border` border, internal scroll. **Esc** and click-outside close it; with a pending
edit draft, they ask for confirm before discarding (lesson from BUG-22). Direction
locked by the operator (2026-07-11): **single column** (dossier) — a reading flow, not
a metadata panel. Canonical mockup:
`.harnu/memory/mockups/card-modal/v1-dossier.html`.

**Anatomy (fixed order, sections with `.eyebrow`):**

1. **Header** — status chip (the column), `id` mono `--text-4`, kind/complexity/
   priority chips (same tokens as the compact card, T105); on the right, copy-link,
   maximize, and close (`x`). Copy-link copies the card's repo-relative path
   (`.harnu/memory/roadmap/<slug>.md`) to the clipboard and shows a confirmation
   toast — no navigation, no fetch, a plain string. **:** directly below the
   chip line, two compact metadata rows (`git-branch` glyph + `--text-3` label +
   mono branch name), rendered only when the fact is known: **Born in**
   (`provenance.branch`, the origin — immutable) and **Executed in** (`executedIn`,
   the owner — mutable, stamped at dispatch and never cleared by a later move;
   falls back to the same runtime-derived match the board card's dashed chip uses,
   marked with the identical dashed-border treatment when it's a guess rather than
   a stamped fact). Either row is simply omitted when its fact is unknown — no
   placeholder dash.
2. **Title** — 16px, `--text`. Hover shows a `--border-2` underline (the same
   click-to-edit affordance as the board's inline renames); clicking swaps the
   heading for an inline text input at the same size/weight. Enter or blur commits
   the new `title` through the serialized frontmatter writer (§ below); Esc reverts
   without writing.
3. **Goal** — the objective in 1–3 sentences, **before** the ACs (operator decision:
   the card's "go" is the intent summary, not a gate).
4. **Acceptance criteria** — interactive checklist; checking writes the checkbox in
   the body markdown. Tokens from the existing `.ac` (`--green-soft`/`--green` when
   done, line-through on the text).
5. **Open questions** — the async interview **lives on the card**: an open question
   with an inline input ("Answer — saved to the card as an append…") + **Send** (the
   answer becomes an append with provenance); an answered question becomes a block
   with a `--green` left border + a provenance eyebrow ("answered · human · data"). A
   `{n} open` badge (`--warning` over a soft tint) in the section header, counting
   UNANSWERED questions only (PRD OQ1 — not AC gaps). See "Open-questions convention
   (E7)" below for the exact storage format.
6. **Docs** — always THREE rows, one per artifact (`spec`/`prd`/`adr`, fixed order),
   **per-artifact state** driven by the ONE requirement matrix (`artifactRequirements`,
   T130 S3 — see "Artifact requirement matrix" below): present = ✓ `--green` + open in
   the pane (`↗`, MarkdownPane/`open_file`); required-and-missing = `--warning`, row
   background `--warning` @ 5%, plus a **Generate** button (`surface-2` bg, `--accent`
   text, sparkles icon, T130 S4/PR5, see D5) and a `--text-4` 10px hint below the row
   ("Drafts from card + codebase + memory. Assumptions made explicit; open questions
   parked below."); not required = dashed border, `--text-4`, no action ("not required
   for `{tier}`", or "not declared" for `adr` — its requirement isn't tier-gated, see
   below). A required-and-missing row additionally shows the convention-scan hint when
   one exists ("— found at `{path}` — not linked", `--text-4`) — DISPLAY only, never
   durable (see "Presence detection" below). The whole Docs section is omitted when
   every row is `not-required`/`not-declared` (a trivial/simple card with no ADR stays
   uncluttered — no empty section). **Generate** routes through the SAME dispatch
   confirm overlay a card's own Dispatch uses (§ below, "Generate dispatch recipe") —
   no second confirm surface.
7. **Linked cards** — chips with a status dot (deps/parent/related) AND a **relation
   label** (T130 S3, M9) when the ref is a `deps` edge in either direction: a ref in the
   OPEN card's own `deps` that isn't done yet reads `← blocked-by` (`--warning` text);
   once that ref lands (`column: done`) the label softens to `· done` (`--text-4` — no
   longer a warning, the dependency resolved); a card ELSEWHERE on the board whose own
   `deps` names the open card reads `→ blocks` (`--warning` — the open card is holding
   something else up). A `parent`/`[[wikilink]]` ref that isn't a `deps` edge in either
   direction carries no relation label (falls back to the plain `· {column}` it already
   had). Clickable regardless of relation (navigate the modal to the target card).
8. **Context** — the body markdown rendered as prose (MarkdownRenderer, T74).
9. **Trail** — a vertical timeline (left border + dots): `dispatched-with` (mono
   `--text-3`), linked session (dot from the board's SAME `classifyFleetState` engine +
   an "Open session" button), evidence (commit/PR/screenshot), and the dated appends
   (subtle `--surface` cards with a provenance eyebrow).
10. **Actions footer** (sticky, `border-t` `--border`) — icon-only **Archive**
    (`archive`, Soft) and **Delete** (`trash-2`, Danger) at the far left, then
    **Edit**; **Move** segmented control (Backlog | Ready | Review — never Done,
    golden rule); a readiness hint (lint) + a primary **Dispatch** on the right. The
    readiness hint is the `lintCardReadiness` verdict for the open card, in two
    states: clean shows `✓ ready to dispatch — no gaps` in `--green`; a gap shows
    `⚠ {n} gap — {detail}` in `--warning` (the `.gap` modifier on `.ready-hint`,
    mockup-canonical). Dispatch renders under the exact same condition as the board
    row's own Dispatch button (no bound session, column is `backlog` or `ready`)
    and, on click, closes the modal into the board's existing dispatch-confirm
    flow — one gesture, one gate.

    Archive and Delete are both disabled (opacity 0.4, tooltip explaining why)
    while the card is `in-progress` — a bound session keeps running either way, but
    pulling the card out from under it mid-flight would lose the live record; move
    it to Review first. **Archive** moves the card's file out of the active
    `.harnu/memory/roadmap/` into a sibling `roadmap-archive/` dir — never scanned
    by the board, so the card disappears from the columns immediately. No
    confirm: it's reversible, so the action closes the modal and shows an `info`
    toast with an **Undo** action (same pattern as Close's session-archive toast,
    §3.5) that moves the file straight back. **Delete** permanently removes the
    card's `.md` file — irreversible, so it's gated behind a native confirm dialog
    (the same precedent the sidebar's session Delete uses) before it closes the
    modal. Both are backed by matching MCP verbs (`archive_card`/`delete_card`) an
    agent can call — `archive_card` writes directly like the other board verbs;
    `delete_card` always asks the operator first, since there is no undo.

**Edit mode (full replacement).** Edit swaps the ENTIRE dossier body — every section
below the title, Goal through Trail (items 3–9; the raw body already contains the
Trail's appends as their literal `> provenance:`-stamped chunks, so nothing is
hidden, only re-rendered) — for **one** textarea (mono, 12px, min-height 320px) with
the raw markdown + Save/Cancel rendered directly below it, plus a `--text-4` hint:
"Full replace — everyone edits the same body". The sticky Actions footer (item 10)
itself is hidden while editing — Save/Cancel live with the textarea, not the footer.
Locked decision: **everyone replaces** — human and agent both rewrite the body; the
append trail keeps existing as history, but it isn't the only write path. Editing an
already-stamped card knocks down the manifest stamp (T104 §2.3) — Save on a card
with `approved` set surfaces a non-blocking `--warning` toast ("manifest ✓ will be
invalidated") with a "Save anyway" action before the write proceeds; the write is
never silently blocked (zero-friction posture, same as every other stamp-void
surface). Esc, the backdrop, and Cancel all route through the SAME dirty-editor
guard as `MarkdownPane` (BUG-22 lesson): a non-blocking toast with a "Discard &
continue" action, never a blocking `window.confirm`. Live AC checkboxes (item 4)
write through this identical `replaceBody` door — a single-line targeted rewrite of
the checkbox's `- [ ]`/`- [x]` marker, not a full-textarea edit; a stamp-void from a
checkbox toggle surfaces the same warning, but AFTER the (already zero-friction)
write, since a single checkbox flip doesn't warrant a pre-write gate.

**Create mode (T80 S2 PR3, M14/B8/E5).** The board's `+ New card` opens the SAME
modal chrome in a dedicated create surface — there is no `RoadmapCard` yet to back
the read/edit dossier, so the product implements this as a sibling component
(`CardCreateModal.vue`) rather than a branch inside the (already dense)
`CardDetailModal.vue`; visually identical shell, purpose-built contents:

- **Header.** The status chip is **fixed to `Backlog`** — the card is always born
  there, so it is never an input (§0/T96 invariant: no surface lets a card start
  anywhere else). The `id`/kind/complexity/priority read-mode chips are **replaced**
  by two `SegmentedControl size="sm"` pickers: **Kind** (`bug · feature · chore ·
scout · review`, the same order as the filter bar's kind chips) and
  **Complexity** (the REAL `roadmap-core.CARD_COMPLEXITIES` enum — `trivial ·
simple · standard · complex`; the canonical mockup's `quick`/`standard`/`deep`
  tier labels are illustrative placeholders, not a 4th palette to add). Both
  default-selected (first kind, `standard` complexity) — a starting point, not a
  meaningful product default. The close (`x`) button is the only header action;
  copy-link doesn't apply (there is nothing to link to yet).
- **Title** — the same underline `.title-input` treatment as the mockup: no border
  except a `--border-2` bottom rule (`--accent-line` on focus), placeholder
  `roadmap.create.titlePlaceholder` ("Card title…"), autofocused when the modal
  opens.
- **Body** — ONE raw textarea (identical visual treatment to the edit-mode
  textarea: mono, 12px, min-height 320px), seeded with the selected kind's
  **delegation-packet template** (`resources/board-templates/<kind>.md`, T105 §3)
  — the exact same files the agent's `create_card` seeds from
  (`roadmap:cardTemplates` fetches all five once, client-side). Switching the
  **Kind** picker reseeds the textarea **only while the body still matches what
  was last seeded** (a dirty check identical in spirit to BUG-22): the first
  reasonable template a picker click can't clobber is the operator's own typing —
  editing the body first "locks" it, so a later kind change no longer overwrites
  it.
- **Footer** — replaces Edit/Move/Dispatch entirely: a `--text-4` hint
  (`roadmap.create.hint`, "Born in Backlog — move to Ready when it's
  dispatchable") + a plain **Cancel** (`.btn`) + a primary **Create card**
  (`.btn.primary`, disabled until the title is non-empty).
- **Create** writes through a dedicated human IPC (`roadmap:createCard`) that
  reuses the **exact same** id-minting (`mintNextCardId`), slug-uniqueness
  (`resolveUniqueSlug`/`slugifyTitle`), and template-seeding (`shouldSeedTemplate`)
  engine as the agent's `create_card` — `buildNewCardContent` assembles the
  frontmatter with `provenance.author: human` instead of `agent` (the ONE line
  that differs). The card is **always** born `status: backlog`; on success the
  create modal closes and the board opens the fresh card straight into the
  **read-mode dossier** — the "look at what got written" instinct, the same as
  what a Save does in edit mode.
- **Esc / Cancel / backdrop** discard without writing anything to disk; with a
  non-empty title or a body diverged from the seeded template, they route through
  the SAME non-blocking dirty-editor guard as edit mode instead of
  silently dropping the draft.

**Compact card (board) — artifact badges.** After the kind/complexity chips: a badge
per artifact (`spec`/`prd`/`adr`, fixed order), **aware of the tier's requirement** —
present = `{key} ✓` (`--green-soft`/`--green`, e.g. `spec ✓`); required-and-missing =
dashed `--warning` border + `--warning` text (bare key, e.g. `prd`); not required by
the tier (or, for `adr`, not declared) = **doesn't render at all** — only present/
missing badges ever show on the compact card (mockup-canonical: "artifacts the tier
does NOT require are not rendered"). The pre-existing numeric readiness badge is
narrowed to NON-artifact gaps only (today: a missing `## Acceptance criteria`) — an
artifact gap always shows as its own badge above, never doubled into the number, so a
card can't disagree with itself between the two badges. A `? {n}` chip (B11, T130 S4)
— mono, `--accent-soft` bg / `--accent-line` border / `--accent` text — when the card
has UNANSWERED open questions (PRD OQ1: questions only, never AC gaps); hidden at
zero, the SAME `unansweredQuestionCount` predicate the modal's `{n} open` badge reads.
No new color — existing tokens only.

**Artifact requirement matrix (T130 S3 — the ONE predicate).** `artifactRequirements`
(`roadmap-core.ts`, mirrored byte-identical in `stores/roadmap.ts`) is the single
function that decides, per card, which of `spec`/`prd`/`adr` are required and whether
each is present — every renderer that shows artifact state (the compact-card badges
above, the modal's Docs rows, and the footer readiness hint, item 10) calls this SAME
function with the SAME card, so they can never disagree:

- `trivial` / `simple` — nothing required.
- `standard` — requires `spec`.
- `complex` — requires `spec` **and** `prd` (cascading, not "additionally": a complex
  card needs both).
- `adr` — required **independently of tier**, only when the card **declares an
  architectural decision**: an `adr:` frontmatter field is present (even before the
  file it names exists — the field itself is the declaration), OR the body carries an
  `## Architectural decision` heading with no `adr:` field yet (the author wrote the
  section but hasn't linked a file). A card that does neither never shows an ADR row
  requirement at all.
- **`present` is always the explicit frontmatter field — never inferred from body
  content, and never fs existence.** Judgment call (recorded on the PR): the prior
  `lintCardReadiness` let a `[[wikilink]]` satisfy a `complex` card's spec requirement
  in place of the `spec:` field; that escape hatch is retired here. Once `spec`/`prd`/
  `adr` are first-class fields with their own badge and Docs row, a wikilink silently
  satisfying a different artifact's badge would be exactly the kind of disagreement
  this matrix exists to prevent.

**Presence detection (E6).** `prd`/`adr` follow the explicit-field-first rule (§2-S3):
the `prd:`/`adr:` frontmatter field, when set, is what `artifactRequirements` reads —
durable, round-trips through `update_card.set` like `spec`. When the field is absent,
main additionally runs a **convention scan** (`roadmap:scanArtifacts`, `roadmap-ipc.ts`)
for `docs/prds/<id>-*.md` / `docs/adr/<id>-*.md` under the repo checkout and returns
what it finds. The scan result is **DISPLAY-only** — shown as a hint on a
required-and-missing Docs row ("— found at `{path}` — not linked", `--text-4`) so the
operator knows a candidate file already exists — but it never flips a badge/row to
"present" and is never written back: only the explicit field is durable, exactly as
the PRD specifies. Because of this, the compact-card badges (which don't call the scan
IPC — a per-card round trip for every visible card would be wasteful) and the modal's
Docs rows (which do, once per open card) are still never in disagreement about
required/present — only about whether a _candidate_ exists, which the badges don't
surface at all.

**ADR requirement rule, restated for implementers:** `declaresArchitecturalDecision(card)
= Boolean(card.adr) || /^##\s+Architectural decision\b/im.test(card.body)`. This is the
ONLY place "does this card need an ADR" is decided — both `roadmap-core.ts` and its
`stores/roadmap.ts` mirror implement it identically (ported test cases in
`tests/roadmap-core.test.ts` / `tests/roadmap-store-artifact.test.ts`).

**Open-questions convention (T130 S4, E7).** Within `## Open questions`, each question
is either a blank-line-separated paragraph or one line of a bullet list (`- `/`* `) —
a block mixing bullet and non-bullet lines falls back to being ONE question (the whole
block, joined). An answer is an ORDINARY provenance-stamped body append — the exact
same append door the Trail already renders — whose FIRST line anchors it to the
question:

```
> answers: <question text, whitespace-normalized>
<answer prose>
```

The modal's Send composes this anchor automatically (`buildAnswerAppend`,
`lib/card-detail.ts`); a human editing the `.md` by hand can write the identical line.
When more than one append answers the same question, the LAST one (body order) wins —
earlier answers stay in the raw file as history, simply superseded in the rendered
"answered" block. Answer-anchored appends are excluded from the generic Trail render
(item 9 above) — they already have a dedicated, better-fitting home in the Open
Questions block; nothing is deleted from the file, only not shown twice. The contract
is the RENDERED result, not this exact storage syntax — `parseOpenQuestions` is the
one place that decides answered vs. open, mirrored nowhere else.

**3-tier interview (Generate's contract, D6).** `trivial`/`simple` → generates
directly, never asks. `standard` → an immediate full draft with a mandatory
**Assumptions** section naming every call the generator made, plus up to ~3 **Open
questions** parked on the card (the draft is usable before the answers; answers
refine it). `complex` → interview-first: the generator's FIRST action is writing 3–5
highest-leverage questions to `## Open questions` and stopping — no draft yet;
generation resumes once the operator answers. The cross-session signal ("card X has
{n} questions for you") rides on T116/T83 once they exist — the block in the modal
doesn't depend on them.

**Generate dispatch recipe (T130 S4, E8).** Generate builds a SERVER-SIDE prompt
(`buildGeneratorPrompt`, `roadmap-core.ts`, mirrors `buildBootPrompt`'s shape and
anti-injection framing) instructing the generator to write the artifact to its
convention path (`docs/specs|prds|adr/<id>-<slug>.md` — `ARTIFACT_CONVENTION_DIRS`,
the same directories E6's presence scan checks for `prd`/`adr`), set the card's own
`spec`/`prd`/`adr` field via `update_card.set`, and touch NOTHING else. It flows
through the exact SAME auto-vs-confirm gate a card's own Dispatch uses
(`decideDispatchGate` — grant-covered human-authored cards auto-run, agent-authored
cards need a matching manifest stamp, everything else asks) and the SAME confirm
overlay (`roadmap.dispatch.generateTitle`, "Generate `{artifact}` for this card?") —
no second confirm surface, no lighter gate. The ONE difference from a card's own
dispatch: the spawned session is never bound to the card (`session:`/`in-progress`) —
Generate is a side-task on a card that may already be dispatched elsewhere, or still
sitting in Backlog, so its own status stays untouched.

Motion: default `--dur`/`--ease`; no new keyframe.

### Sidebar toolbar (one-line header: rescan · drill depth · collapse-all · hidden · search)

The Search button opens the [Sidebar jump palette](#sidebar-jump-palette); it does not turn
the header into a filter input.

**Layout:** ONE 42px row — the sidebar header itself (`role="toolbar"`,
`aria-label` `$t('sidebar.menu.label')`), `padding: 8px 8px 8px 12px`,
`gap: 2px`, `justify-content: flex-end`, bottom border `1px --border`. Contents,
right-aligned, in this order:

    rescan · drill depth · collapse-all · hidden(n) │ search

The first four are the tree actions, present only when
`sessions.folders.length > 0` (the same condition the old `⋯` trigger used);
they are followed by a **1px × 16px `--border-2` divider** (`margin: 0 4px`)
that separates them from the navigation affordance. **Search is always present
and always last** — it is the one control that means something with an empty
sidebar. All buttons are 26×26px, radius `--radius-sm`, ghost style (`--text-4`
default, `--text` + `--surface` background on hover), except the Hidden button
(auto width, `padding: 0 7px`, `gap: 4px`, to fit its count).

At the 200px width floor the five buttons + count + divider need ~165px, so
nothing collapses behind a `⋯`.

**macOS window-controls inset** still applies to this row's `padding-left`
(§4) — the `hiddenInset` title bar paints the traffic lights over this corner.

**The filter morph still exists**, but it is no longer reachable from the
header: the row swaps to the inline filter input (plus its `X` clear button)
only while `sessions.filterActive` is on, which now happens exclusively via the
jump palette's `⇥` fallback.

1. **Rescan folders** (leftmost). `refresh-cw` (14px). Forces a fresh disk
   scan and reconciles the store (`sessions.rescan()`) — the escape hatch for
   any watcher gap. Carried over from the old `⋯` menu's first
   item when that menu was removed; the failure path still raises a `danger`
   toast titled `$t('sidebar.menu.rescanFailed')`. While the rescan is in
   flight, the icon spins continuously (`.anim-spin`, 0.7s linear loop — see
   §7 Motion) — the only feedback that anything is happening, since
   `sessions.rescan()` has no other visible side effect until the watcher
   settles. Tooltip: `$t('sidebar.menu.rescan')`.
2. **Drill depth**. A three-state icon button (not a switch, not a toggle):
   `list-tree` (14px) at depth 0 (classic tree), `columns-2` at depth 1,
   `columns-3` at depth 2. Depths 1 and 2 also get the `--accent-soft`
   background + `--accent` icon color (the same convention selected/active
   icon buttons use elsewhere, e.g. `StatusFooter.vue`'s pill). Each click
   advances the depth, wrapping `0 → 1 → 2 → 0`. Tooltip:
   `$t('sidebar.toolbar.drillOn')` at depth 0 (it names the action), and
   `$t('sidebar.toolbar.drillLevel')` at 1–2 (it names the current level,
   since a click advances rather than toggles).
3. **Collapse all**. Two-state icon, following the same "icon names the
   action a click performs" convention as the drill depth button above:
   `chevrons-down-up` (14px) when any folder is expanded (clicking
   collapses), `chevrons-up-down` (14px) when every folder is collapsed
   (clicking expands) — the icon itself always names the action a click
   performs, not a static glyph with only the tooltip changing. Tooltip
   flips between `$t('sidebar.menu.collapseAll')` / `$t('sidebar.menu.expandAll')`
   in lockstep; same action (`sessions.expandAll()` / `sessions.collapseAll()`).
   **Hidden entirely at drill depth 2** — expand/collapse state is a
   classic-tree concept, and depth 2 navigates one screen at a time with
   nothing inline to act on. At depth 1 the group screen renders its member
   folders inline and expandable, so the button is present and meaningful
   there, exactly as at depth 0.
4. **Hidden**. `eye-off` (14px) + a numeric badge (the dismissed-folder
   count) — badge omitted at `0`, button stays present but visually and
   functionally inert. Click opens `SidebarHiddenPopover.vue`, anchored to
   this button's bounding rect (left-aligned, below) — same popover anatomy
   as the Context menu (220px min-width, 24px-tall items, `text-12px`,
   dismissal via Esc / click-outside / wheel), now scoped to just the
   Hidden-folders list (no more Expand/Collapse-all row above it).
5. **Search** (rightmost, after the divider). `search` (14px). Opens the
   [Sidebar jump palette](#sidebar-jump-palette) — it does NOT filter the tree.
   While the palette is open the button takes the `--accent-soft` background +
   `--accent` icon treatment (the same active convention the drill-depth button
   uses); clicking it again closes the palette. Tooltip:
   `$t('sidebar.jump.label')`. `⌘K` is NOT bound to it — that stays on the
   [Command palette](#command-palette).

**Hidden-folders popover.** The flat "Hidden ({count})" list became a
small palette — the operator's install carries 43 hidden aliases, which a bare
list cannot serve. Popover anatomy is unchanged (anchored to the Hidden button,
`--surface` on `--border-2`, `radius 7px`, `--shadow-pop`, dismissal via Esc /
click-outside / wheel-outside), but the body is now four bands, full-bleed (no
container padding — rows run edge to edge) at `min-width: 260px` /
`max-width: 340px`:

1. **Search row.** 32px tall, `padding: 0 10px`, `gap: 8px`, `border-bottom
--border`. `search` icon 13px `--text-3`; a borderless
   transparent input (12.5px, `--text`) that is **focused on open**; and a dim
   `--text-4` 10.5px `tabular-nums` "N of M" counter on the right. Typing
   filters case-insensitively on three fields — the folder alias, its
   `gitBranch`, and its absolute path — so a worktree is findable by whichever
   of the three the operator remembers.
2. **Grouped results.** Capped at `max-height: 60vh`, scrolls internally
   (`overflow-y: auto`, `.scrollable`); the wheel **inside** the popover
   scrolls, only the wheel **outside** dismisses. Rows sit under **eyebrow**
   labels (10.5px, 500, `letter-spacing .07em`, uppercase, `--text-4`,
   `padding: 4px 10px`) carrying the group label on the left and the section's
   row count on the right. Grouping is `groupByRepo` with the store's group
   aliases — the SAME resolution `RepoGroupHeader` uses, including the dim
   `· parentHint` when two groups collide on a label — so a repo renamed in the
   tree reads identically here. A folder that joins no repo group becomes its
   own single-row section labelled with its alias.
3. **Row.** 28px tall, `padding: 0 10px`, `gap: 8px`, 12px: `folder` icon 13px
   `--text-4` · the alias with the matched substring **bold** (`--text`, 600) ·
   a dim `--text-4` 11px session-count hint ("2 sessions" / "1 session" /
   "no sessions", `max-width: 46%`, truncating). The **selected** row (hover and
   keyboard share one cursor) takes `--surface-2` + `--text`, a 2px `--accent`
   bar down its left edge, and gains an **Unhide** chip — the §6 Badges
   **Accent** variant at popover scale (10px/14px, `padding: 1px 6px`,
   `radius 999px`). `↑`/`↓` wrap through the flat row order and scroll the
   selected row into view (`block: 'nearest'`) so the cursor never leaves the
   `60vh` viewport; hover moves the same cursor but never scrolls, so the list
   can't slide out from under a stationary pointer. `↵` unhides the selected
   row. Rows are `tabindex="-1"` and
   swallow mousedown, so focus never leaves the input and typing keeps working
   after a click. Because the body carries a textbox, the popover is a
   `dialog` — not a `menu` — wrapping a `listbox` whose eyebrows are `group`
   labels and whose rows are `option`s carrying `aria-selected`.
4. **Footer.** 26px tall, `border-top --border`, 10.5px `--text-4`: a `↵`
   `kbd` + "unhide" hint on the left and, **only while a filter narrows the
   list to N ≥ 2**, an `--accent` **"Unhide all N"** button on the right that
   restores the whole filtered set. With no filter the footer carries the hint
   alone.

Unhiding — one row or the whole filter — keeps the popover open, so several
folders can be restored in one visit. Empty results use the `--text-3` 11.5px
copy idiom (`padding: 14px 12px`, `line-height: 1.5`); with **zero** hidden
folders at all the popover falls back to the historical one-line
`sidebar.menu.hidden` message and shows no search row.

### Sidebar jump palette

**Search means "take me there", not "filter the tree".** Opened by the
one-line header's Search button (never by `⌘K` — that is the
[Command palette](#command-palette)), the jump palette floats **above** the
tree and leaves it untouched: nothing here writes `filterQuery`, so closing the
palette never loses the operator's place. Results are **targets**; `↵` goes
there.

Component: `SidebarJumpPalette.vue`. Rendered INSIDE the sidebar `<aside>`
(not `<Teleport>`ed to `<body>`) so it tracks the sidebar's width and clipping.

**Card:** `position: absolute; left: 8px; right: 8px; top: 46px` (42px header +
4px), background `--surface`, border `1px --border-2`, radius `--radius`,
shadow `--shadow-pop`, `overflow: hidden`, `.anim-fade-in`.

**Input row:** 34px tall, `padding: 0 10px`, `gap: 8px`, bottom border
`1px --border`. `search` icon 14px `--text-3`, borderless input (Inter 12.5px
`--text`, placeholder `--text-4`, `$t('sidebar.jump.placeholder')`), trailing
`esc` kbd chip. **Focused on open.**

**Section eyebrow:** `padding: 4px 10px`, Inter 10.5px/14px 500 UPPERCASE
letter-spacing `0.07em`, `--text-4`; the group label on the left, its **count**
on the right (the empty-query "Recent searches" eyebrow carries a lowercase,
non-uppercase `clear` action there instead).

**Result row:** 28px, `padding: 0 10px`, `gap: 8px`, `--text-2`; label
truncates, with the **matched substring bold** (600, `--text`); a dim `hint` on
the trailing edge (11px `--text-4`, `max-width: 46%`, truncating). Selected
(keyboard cursor): `--surface-2` background, `--text`, a **2px `--accent` bar**
on the left (`border-radius: 0 2px 2px 0`, a `::before`-style overlay — never a
`border-left`, which would shift the row's content against its peers), plus a
trailing `corner-down-left` 12px `--text-4`.

**Groups, in this order:**

| Group    | Rows                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Folders  | `git-branch` for a repo group's main worktree (hint = its path, in **mono**), `folder` otherwise (hint = the parent repo label) |
| Hidden   | `eye-off`, row at `opacity: .75`, an **"Unhide & go" chip** instead of a hint                                                   |
| Sessions | a 6px status dot (the plain fill — no pulse ring, no `stuck`/`archived` glyph), hint = the owning folder                        |

**"Unhide & go" chip** (Badge, Accent variant): 10px/14px, `padding: 1px 6px`,
`border-radius: 999px`, `--accent` on `--accent-soft` with a `--accent-line`
border. Activating that row **unhides the folder first**, then jumps to it.

**Matching:** the shared fuse.js matcher in `composables/useJumpSearch.ts`
(`threshold: 0.4` — the same matcher `CommandPalette.vue` drives off, so the
two palettes can never rank one query differently; both take it through
`useFuzzyMatcher`, which caches the index per collection so typing never
re-indexes an install's whole session list). Keys: a folder's **alias, git
branch and filesystem path**; a session's **summary and first prompt**.
Dismissed folders are searched too — that is the point of the Hidden group,
but only as FOLDERS: the **sessions inside a dismissed folder are not offered**,
because that folder is classified `hidden` and never renders in the tree, and a
session jump reveals but never unhides. Unhide the folder from the Hidden group
first — one keystroke, right there — and its sessions become jumpable.
**Archived sessions are not** searched either: the tree shows one only while its folder's
archived peek is open, and a jump does not open that peek, so an archived hit
would be a target with no row to land on. Hiding a FOLDER is recoverable here
("Unhide & go"); archiving a SESSION is not offered.

**Empty query = history:** **Recent searches** (the last 8 queries that
returned something, `history` icon, hit-count hint taken from the first
non-empty group at search time — "3 folders", "1 session" — and a `clear`
action) then **Recently visited** (the last 5 folders landed on, by jumping or
by selecting any session in them; `folder` icon, owning-repo hint, omitted for
a standalone folder). Both persist to `localStorage` under the `om2tab.*`
prefix. `↵` on a recent search **re-runs it in place** rather than jumping —
the counts are a snapshot, so the query is the only honest thing to replay.

**Footer:** 26px, `padding: 0 10px`, `gap: 10px`, top border `1px --border`,
10.5px `--text-4`. Hints: `↑↓ move` · `↵ jump` · `⇥ filter tree` (the last only
with a query to hand over), and, on the empty state, a right-aligned
"{n} hidden included".

**Keyboard:** `↑`/`↓` move the cursor across group borders, `↵` jumps, `⇥`
applies the current query to the tree filter (`filterQuery`, the morph above)
and closes, `Esc` closes. Click-outside and the Search button also close it.

**After a jump** the target row flashes once — see §7 "Jump flash". The ROW,
never the block: a folder's `data-folder-path` element wraps its whole expanded
session list, so the flash is scoped to the folder row inside it.

**A jump OPENS its target, it does not merely reveal it.** A folder result —
from the Folders group, from "Unhide & go", or from a Recently-visited row —
**selects** the folder, so its [Folder View](#folder-view-folderviewvue) renders in the main
pane, exactly as clicking that folder row in the tree does; a session result
selects the session. Either way any open takeover closes first, since a
takeover renders ahead of the Folder View and would otherwise leave the jump
invisible behind it. Landing on a highlighted-but-unopened row is the failure
this rule exists to prevent.

### Drill-in navigation (sidebar, depth 0–2)

Drill-in depth is a **budget of screens**, not an on/off mode. A row may push
another screen only while `drillStack.length < drillDepth`; past that, the
screen falls back to the classic inline tree.

| Depth | Root screen    | Inside a group screen                    |
| ----- | -------------- | ---------------------------------------- |
| `0`   | classic tree   | —                                        |
| `1`   | drillable rows | folders inline and expandable            |
| `2`   | drillable rows | drillable rows → the folder's own screen |

At depth 1 a standalone (ungrouped) folder on the root screen stays drillable
— it spends the single available step and opens its own session screen.

When drill-in is on (depth ≥ 1), the folder tree below the toolbar is replaced by one of
three screens, all sharing the toolbar above:

- **Root** — every repo-group and standalone folder as a flat, drillable row
  (30px tall, `chevron-right` trailing), no inline expansion. A repo-group
  row shows its `git-branch` icon, label, and a `"{n} worktrees"` count.
- **Repo screen** — reached by clicking a repo-group row: that repo's member
  folders, each a drillable row (`folder` icon). At depth 1 this screen
  renders its member folders inline via the same `SidebarFolder` component
  the classic tree uses inside a group, instead of drillable rows — but
  WITHOUT the `nested` prop the classic tree passes there. `nested` deepens
  the indent to read as "inside a `RepoGroupHeader` disclosure"; this screen
  has no `RepoGroupHeader` in the DOM (the back row above already plays that
  role), so the folders render at the default `flat` indent, the same one a
  `SidebarFolder` uses when it isn't part of any group.
- **Folder screen** — reached by clicking any folder row: that folder's own
  session list, rendered by the same row anatomy as the classic tree's
  session rows (status dot, teammate nesting) — nothing reimplemented, just
  displayed without the folder's own title row (and, with it, the classic
  tree's hover-revealed inline "+ New session" icon — replaced on this
  screen by the back row's own trailing `+` action, below).

A **back row** (30px tall) replaces the folder-screen/repo-screen's own
header while drilled in. The **entire row is the back button** — not just
the leading `chevron-left` — a `<button>` spanning the full width, so
clicking anywhere on the title bar navigates back, matching every other
row in the sidebar (folder rows, session rows) being fully clickable rather
than icon-only. A folder screen additionally shows its parent repo's label
as a dim subtitle when it has one, and — carried over from the classic
tree's inline action cluster (same `older`/`archived`/`new` set, "Inline
action cluster (folder row)" above) — the same trailing peek actions,
immediately before the **`+` (New session)** action: `clock`/`archive`
icon-only buttons (`role="button"`, 11px icon, `--text-4` default,
`--accent` while revealed, `@click.stop`), each shown only when its count
is non-zero, driving the same `sessions.toggleRevealOlder`/
`toggleRevealArchived` state the classic row uses. Unlike the classic
row's hover-gated reveal, this cluster is **always visible** in the back
row — a persistent header, not a row that fades stats in on hover — same
posture as the `+` action next to it (20×20px, `role="button"`,
`@click.stop` so it doesn't also trigger the back navigation) that opens
the new-session flow for the drilled-into folder
(`ui.openNewSession(folder.path)`) — and, last in the cluster, the row's
**`⋯` (folder actions)**, below. The repo screen has no peek or `+` actions,
only a folder screen hosts sessions directly.

**Row actions — every drill-in row has the menu its classic-tree twin has.**
Drill-in used to be a dead end for actions: right-clicking a back row or a
chooser row did nothing, and reaching Rename / Hide / New worktree meant
leaving drill-in first. Every row here now carries the SAME menu the classic
tree gives the same entity — nothing new is invented, only re-hosted:

- **Back row** — right-click anywhere on the row opens the drilled-into
  entity's menu: the shared **`FolderMenu`** on a folder screen, the
  **group menu** (Rename group / Reset name / Cleanup, the same items
  "Repo-group header" describes) on a repo screen. A trailing **`⋯`**
  (`ellipsis`, 14px, 20×20 `role="button"`, `@click.stop`) does the same for
  mouse users, placed **last** in the trailing cluster — after `+` on a
  folder screen, alone on a repo screen. Like the `+` beside it, this `⋯` is
  **always visible**: the back row is a persistent header, not a row that
  fades stats in on hover.
- **Chooser rows** (root screen and repo screen) — right-click opens the
  menu matching the row's kind (`FolderMenu` for a folder row, the group menu
  for a group row), and the same `⋯` sits at the row's right edge **before**
  the trailing `chevron-right`. Here it follows "Stats on demand": `opacity 0`
  at rest with the 20×20 space **preserved** (no layout shift), revealed on
  `group-hover` / `group-focus-within`, and forced visible while its own menu
  is open.

Both menus clamp against the viewport edges with the same estimate their
original host uses (180×60 for `FolderMenu`, 172×108 for the group menu), and
a keyboard activation — which has no cursor — anchors at the bottom-left of
the `⋯` itself instead. The group menu is rendered inside the drill view
rather than reached through `RepoGroupHeader`: that menu lives inside the
header component, and drill-in never mounts one (the back row plays its role).
Same items, same store actions, same Esc / click-outside / wheel dismissal —
plus one dismissal `RepoGroupHeader` does not need: a group that stops
rendering underneath an open menu closes it. Hiding the menu is not enough,
because its Esc / click-outside listeners would stay armed and an invisible
menu would eat the operator's next Escape.

**Persistence — the drill position survives a restart.** `drillStack` is
mirrored to `localStorage` (`om2tab.sidebarDrillStack`, the same
`persistedRef` idiom as `drillDepth`), so reopening the app lands on the
screen you left instead of bouncing back to the root. Restoring is two-phase:
the stored **shape** is validated when the store is built, and the
**resolution** check runs once the folder model has loaded — if any node in
the stack no longer resolves, the WHOLE stack is emptied (a partial stack
would leave the operator on a screen whose parent is gone). The restored stack
is also clamped to the current `drillDepth`, exactly as lowering the depth
truncates it.

The per-node resolution rule is deliberately asymmetric. A **group** node must
still be RENDERING (present in `visibleFolders`). A **folder** node must still
be KNOWN and **not dismissed** — known rather than visible, because a folder
that merely went `stale` overnight is still a legitimate place to be and
demanding visibility would empty the stack every morning; and not dismissed,
because restoring onto a folder the operator explicitly hid would resurface it
as the sidebar's entire content.

**Auto re-drill:** selecting a session — from a notification, the command
palette, the roadmap board, anywhere — while drill-in is on jumps the
navigator straight to that session's folder screen, skipping the
intermediate repo screen even when the folder belongs to a repo-group. The
drill position is always derived from the current selection; it is never
independent state the operator can get lost relative to. The jump is
clamped to the current depth: at depth 1 it lands on the owning group's
screen with the session's folder expanded inline, at depth 2 on the
folder's own screen.

### Resizable divider (handle)

A vertical, draggable bar that separates two panels. Used in two places with the same
anatomy: between the **sidebar and the content**, and between the **terminal and the
helper-stack** (split).

- **Width:** two layers. The **hit-area** (drag target) is the outer 6px `<div>`
  (`w-1.5`, `cursor-col-resize`), transparent. The **visible stripe** is a centered 1px
  child (`w-px`, `h-full`) — thin enough not to compete with the content, while the 6px
  hit-area stays comfortable to drag.
- **Background:** only the 1px stripe is colored — `--border-2` (default) →
  `--accent-line` on hover (via `group-hover`, since the hover is on the outer hit-area).
- **Cursor:** `col-resize` when hovering over it.
- **Drag:** adjusts the width in real time. In the sidebar, the `clientX` delta is
  added to the initial width and clamped to `[200, 480]` (see §4 — Layout dimensions).
- **Double-click:** resets to the default width (268px in the sidebar).
- **Motion:** only the background color transition (`--dur` / `--ease`); the width
  tracks the pointer 1:1 during the drag, **no** easing animation (an animated drag
  feels laggy). Respects `prefers-reduced-motion` via §7's global reset.
- **A11y:** `role="separator"`, `aria-orientation="vertical"`.

#### Origins of a helper-stack pane

A split pane is born from three paths, all using the same visual anatomy
(`HelperPane`) and differing only in the `kind` of PTY they spawn:

- **New shell** (Split menu) → `kind: shell` in the worktree's cwd.
- **Fork session** (Split menu / context menu) → `kind: claude-fork`
  (`claude --resume <src> --fork-session`), via a pending synthetic session.
- **Open in new tab** (session context menu, `external-link` icon) →
  `kind: claude-resume` (`claude --resume <uuid>`) of the clicked session, **alongside**
  the current session. The pane enters the **selected** worktree's stack (appears in
  the split visible at the time) but with the cwd of the target session's own folder.
  Hidden for synthetic sessions and **cloud/bridge** ones (no resumable JSONL); no-op
  if the target session is already the main pane or is already open in the stack
  (avoids two `claude --resume` fighting over the same JSONL).

#### Pane header (title bar)

Each helper-stack pane has a thin **title bar** at the top, mirroring the footer /
status bar anatomy (§6 — Footer / status bar): a full-width strip that identifies the
pane and offers the close button. Replaces the old floating `X` (corner, `--text-3`),
which was too dim over the terminal content.

- **Height:** 24px (`h-6`), `shrink-0` — doesn't steal a row from the xterm grid.
- **Background:** `--surface`; **border-bottom:** 1px `--border`.
- **Padding:** `0 8px`. **Font:** 11px, `--text-2`.
- **Content (left):** pane-type icon (`terminal` for shell, `bot` for claude,
  `git-fork` for a pending fork, 12px `--text-3`) + pane name (`cwd` basename,
  truncated with `…` on overflow). The native `title` exposes the full path on hover.
- **Maximize button (right, before close):** `maximize-2` icon 12px, 18×18px target,
  same hover treatment as the close button. Swaps to `minimize-2` while this pane IS
  the maximized one. `aria-label`/`title` = `helperPane.maximize` /
  `helperPane.restore`. `mousedown.stop` so clicking it doesn't trigger the resize.
  Every pane type (terminal/shell/claude via `HelperPane`, plus
  `MarkdownPane`/`MemoryPane`/`ExplorerPane`) carries this button in the same
  position — right before its own close button.
- **Close button (right):** `x` icon 12px, 18×18px target, `--text-3` → `--text` with
  `--surface-2` background on hover. Same action as the old `X` (`removeHelper`).
  `aria-label`/`title` = `helperPane.close`. `mousedown.stop` so clicking it doesn't
  trigger the resize.
- **Motion:** only the color transition (`--dur` / `--ease`) on the button's hover.

**The bar is also the resize handle between panes.** There's no longer a separate
divider line in the helper-stack: dragging a pane's header moves the boundary
**above** it (between `idx-1` and `idx`). The first pane in the stack has an inert
header (there's no boundary above it); the rest gain `cursor: row-resize` +
`border-top` 1px `--border-2` → `--accent-line` on hover, signaling the drag.

The bar sits **outside** the xterm layout (the host carries `padding-top: 24px` and
the cell measurement already discounts the padding), so it doesn't interfere with
focus capture or the pane's input forwarding. The helper-stack has **no** top
padding — the first pane touches the top of the column.

#### Maximizing a pane

Clicking a pane's maximize button grows it to fill essentially all of the
helper-stack's vertical space; every OTHER pane in the stack collapses to its own
24px header-only strip — still visible, still alive (a running shell command
keeps printing in the background; nothing unmounts or detaches). Clicking the
same button again (now showing `minimize-2`) restores the normal ratio split;
clicking a DIFFERENT collapsed pane's maximize button re-targets the maximize
directly, no need to restore first. Drag-to-resize is disabled on every pane
while one is maximized (ratios are meaningless in that state). The maximized
pane id is **ephemeral, per-worktree state** — never persisted to `helpers.json`
— so it resets to the normal split on a worktree switch or app restart.

#### Review companion pane

The pane that hosts the fresh session opened from the Review takeover's **Ask a
fresh session** button (see "Review pane" below). Structurally an ordinary
helper-stack pane — same 24px header, same maximize/close buttons, same
drag-to-resize — with a header **content** row of its own, because the two facts
worth reading at a glance about this pane are not its cwd:

- `chevron-right` glyph, 12px, `--accent` (the "a prompt, not a process" mark the
  approved spec uses), then `$t('reviewCompanion.title')` in `--text-2` and
  `$t('reviewCompanion.subtitle')` in `--text-4`, truncating in that order.
- **Read-only pill** — `border-border bg-surface rounded-full`, `1px 7px`, 10px
  `--text-3`, carrying the **word** `$t('reviewCompanion.readOnly')`. A lock glyph
  alone is forbidden here for the same reason the evidence header spells out every
  status dot (rule "no green means safe"): a reader who cannot tell at a glance
  whether the thing beside the diff can change the diff is exactly the uncertainty
  this pane exists to remove.
- **Promote button** — `border-border-2 bg-surface-2 rounded`, 18px tall, 10px
  `--text-3`, an `unlock` glyph + `$t('reviewCompanion.promote')`, hovering to
  `border-text-4 text-text`. `mousedown.stop`, like every other header control.
  It is the ONE door out of read-only, and taking it **closes the review**: a
  reviewer that edits is the author, which collapses the separation the fresh
  session exists to build. Promoting is allowed; drifting into it is not.
  **Disabled — not hidden — until the session has a transcript on disk**
  (`disabled:opacity-45`, `disabled:cursor-default`, no hover shift), with
  `$t('reviewCompanion.promoteNotYet')` as the tooltip: Claude writes the
  conversation on its first turn, so before that a promote would resume a
  conversation that does not exist. A control that only appears once you type is
  a control you cannot find when you go looking for it.

- **Orientation disclosure** — an 18×18 icon-only toggle carrying a
  `scroll-text` glyph, 11px, `--text-4`, hovering to `bg-surface-2 text-text` and
  reading `bg-surface-2 text-text-2` while open. `mousedown.stop` and
  `aria-expanded`, with `$t('reviewCompanion.disclosure')` as both `title` and
  `aria-label`. Sits between the read-only pill and the Promote button.

  Open, it reveals a panel **absolutely positioned under the header**
  (`top-6 inset-x-0 z-20`, `bg-surface`, `border-b border-border`, `shadow-pop`,
  `max-h-[45%] overflow-y-auto`, `anim-fade-in`): the label repeated as a 10px
  uppercase `--text-4` caption, then the orientation itself in a 10.5px mono
  `--text-3` `<pre>` with `whitespace-pre-wrap`. An overlay rather than an inline
  block because the header is a fixed 24px strip the xterm host is padded around
  — growing it would resize the PTY grid on every toggle.

  It exists because the orientation is delivered as `--append-system-prompt` and
  therefore **has no turn in the transcript**: invisible is what makes it safe to
  send, and invisible is what makes it need a surface. A reviewer who cannot audit
  what its reader was primed with is back to trusting a black box. The panel
  renders the exact composed string, not a re-description of it. Note the copy
  split: the **label** is UI copy and goes through `$t()` in both locales; the
  orientation it reveals is **model-facing prose** and deliberately does not —
  a translated corrective would fork model behaviour by the operator's language.

The pane is **transient** — `persistable: false` in `pane-registry.ts` — and is
disposed when the Review takeover closes. It never reaches `helpers.json` and
never reappears on a later boot; a companion that outlived its review would be
a permanent tab, which is the opposite of what it is for.

No new §9 token: every value above already exists.

#### Markdown pane (file viewer + editor, non-PTY)

A helper-stack pane that **renders (and edits) a file** instead of hosting a terminal.
Named "Markdown pane" in T74, when it only opened `.md`/`.markdown`/`.txt`; Cluster G
**removed that extension allowlist** — the pane now opens and edits **any text file**,
refusing only what the binary sniff (below) rejects; **common images render inline**
instead of being refused (image fast-path, §Admission). The component's name was kept
(smaller blast radius; most opened files are still markdown) but its scope grew:
`.md`/`.markdown` still render as **prose** via `MarkdownRenderer`; any other accepted
file (`.txt` included, now treated like the rest) renders as **monospaced plain text**
(same editor tokens — `--font-mono` 12px/1.6 — just read-only). Unlike the
shell/claude panes, it **has no PTY**: it's cheap, reproducible from the
`filePath`, and mounts/unmounts freely (it doesn't enter `liveHelpers`, no
`detach-not-dispose`). Component: `MarkdownPane.vue` (the file-backed "skin" that loads
both the viewer AND the editor, deciding prose-vs-plain-text by extension) over
`MarkdownRenderer.vue` (string→prose, **read-only** and reusable by the T79 memory pane
and T80 cards — editing NEVER lives in the renderer; it's only called for
`.md`/`.markdown`).

**Admission (Cluster G; image fast-path).** Only two things still refuse a file: (1)
**outside the known roots** (containment unchanged) and (2) **non-image binary** — a
cheap sniff of the file's start (looks for a NUL byte in the first ~8000 bytes, the same
heuristic as `git`/`grep --binary-files`) refuses files/binaries/executables before
decoding as UTF-8. **Images are the legitimate exception** (extension fast-path, BEFORE
the sniff): `.png`/`.jpg`/`.jpeg`/`.gif`/`.svg`/`.webp`/`.bmp`/`.ico` come back from the
read IPC as `kind: 'image'` with a base64 **data: URL** (the CSP already allows
`img-src data:`; `file://` would be blocked) and the pane **renders** instead of
refusing (§Body (image)). An `.svg` is text/scriptable — it ALWAYS renders via `<img>`
(which neutralizes scripts), never as inline HTML. The size cap (2 MB,
`MAX_MARKDOWN_BYTES`) still applies to any file, images included.

**How it opens.** Three paths, all entering the selected worktree's stack. **None uses
the OS-native dialog anymore** (Cluster E): on Linux/Wayland the XDG portal ignores
Electron's `defaultPath` and opens far from the project — real friction. Opening and
creating now go through the in-app **Explorer pane**, confined to the project root:

1. **Open** — clicking the **`eye`** icon of a file row (Cluster G; ANY file, not just
   markdown) in the Explorer pane (§Explorer pane) opens the file in a Markdown pane
   (confined by `markdown:read`; a non-image binary/too-large file is refused with a
   toast, doesn't open the pane; an **image** opens and renders inline). Clicking the
   row's **name/body** is inert for files (only folders expand/collapse in the body) —
   the `eye` icon is the ONLY way to open. Replaces the old "Open markdown file…" button
   in the Topbar (removed — the **"Browse files"** button + the `eye` icon cover this
   path).
2. **New** — the `file-plus` button in the **Explorer pane's header** reveals an inline
   input at the root; on confirm (Enter), it creates an empty `<root>/<name>.md` via the
   confined write IPC (§write) and opens the pane **directly in edit mode** to rename/
   write right away. No save dialog. A refusal (outside the roots / too large) becomes a
   toast.
3. **Agent** via the `open_file` MCP verb (T74 S4, extended by Cluster G): opens in
   **background** (doesn't steal focus — see §verb), now for ANY file — the verb's
   structure no longer requires a markdown extension; a binary still opens the pane
   (same path as a human click on `eye`) and it's the PANE that shows the refusal, not
   the verb. It's the canonical way for an agent to deliver a report without pulling the
   operator out of Harnu.

**Header (title bar, 24px).** Fully reuses the "Pane header" above (`h-6`, `--surface`,
`border-bottom --border`, header = resize handle between panes). Left to right:

1. `file-text` icon (12px, `--text-3`);
2. name = **file basename** (truncated with `…`; native `title` shows the full path);
3. **dirty dot** — a `•` in `--color-accent` (14px) right after the name, **only when
   there are unsaved edits**; `title`/`aria-label` = `markdownPane.unsaved.title`;
4. **view⇄edit toggle** button (only when `ready`) — `pencil` icon in view mode (→
   edit), `eye` in edit mode (→ preview); 18×18px target, `--text-3` → `--text`;
   `aria-label`/`title` = `markdownPane.editMode` / `markdownPane.viewMode`;
5. **save** button (`save` icon, **edit mode only**) — `--color-accent` when dirty,
   `--text-disabled` + `disabled` when clean; `aria-label`/`title` = `markdownPane.save`;
6. **copy file** button (`copy` icon, hidden for an **image** file) — copies the raw
   `draft` buffer (unsaved edits included) to the clipboard; swaps to `check`
   (`--color-green`) for ~1.5s on click, same idle/copied idiom as the per-block copy
   button below; `aria-label`/`title` = `markdownPane.copyFile`;
7. **reload** button (`rotate-ccw` icon, 12px, 18×18px target, `--text-3` → `--text`
   with `--surface-2` background on hover) — rereads the file from disk, with a
   **discard guard** if there are unsaved edits; belt-and-suspenders manual refresh
   alongside the automatic live-reload watcher (T171 — see Stale-on-disk banner
   below); `aria-label`/`title` = `markdownPane.reload`; `mousedown.stop`;
8. **close** button (`x` icon, identical to the Pane header's) — `removeHelper`.

All header buttons do `@mousedown.stop` so they don't trigger the pane's resize.

**Stale-on-disk banner.** When a markdown pane's backing file changes on disk
while the pane has unsaved edits, a one-line banner replaces the header's
filename row: `bg-warning/10 text-warning` background tint (mirrors the
existing warning-toast treatment — no new color token), a short message, and
a "Reload" text action that routes through the same discard-guard the manual
reload button and the close button already use. The banner is DISMISSED (not
shown) the moment the pane has no unsaved edits — a clean pane just silently
re-reads instead. Motion: `anim-fade-in` on appearance (T7 tokens), no exit
animation (it's removed the instant Reload or a save resolves the conflict).

**Body (prose).** A container with vertical scroll (`.scrollable`, `overflow-y-auto`),
`padding: 14px 16px`, below the header (the host carries `padding-top: 24px` like the
other panes). The sanitized HTML is injected via `v-html` into a `.md-prose` wrapper;
the styles below are **CSS scoped with `:deep()`** (`v-html` doesn't get the scope
attribute), mapped **only to §9 tokens** — no raw color:

| Element         | Spec (§9 tokens)                                                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h1`            | 18px / 600, `--text`, `margin: 4px 0 10px`, `border-bottom 1px --border`, `padding-bottom 6px`                                                                                                                                                  |
| `h2`            | 15px / 600, `--text`, `margin: 18px 0 8px`                                                                                                                                                                                                      |
| `h3`            | 13px / 600, `--text`, `margin: 16px 0 6px`                                                                                                                                                                                                      |
| `h4`–`h6`       | 12px / 600, `--text-2`, `margin: 14px 0 4px`                                                                                                                                                                                                    |
| `p`, `li`       | 12.5px / 1.6, `--text-2`                                                                                                                                                                                                                        |
| `a`             | `--color-accent`, no underline → underline on hover                                                                                                                                                                                             |
| `code` (inline) | `--font-mono` 11.5px, `--text`, bg `--surface-2`, `border-radius --radius-sm`, `padding: 1px 4px`                                                                                                                                               |
| `pre` (block)   | `--font-mono` 11.5px / 1.5, bg `--surface-2`, `border 1px --border`, `border-radius --radius`, `padding: 10px 12px`, `overflow-x: auto` (the inner `code` inherits, no own bg)                                                                  |
| `blockquote`    | `border-left 2px --border-accent-line`, `padding-left 10px`, `--text-3`, italic off                                                                                                                                                             |
| `table`         | wrapped by the seam in a **`.md-table-scroll`** div (`overflow-x: auto`, `margin: 0 0 10px`) — see below; the table itself `border-collapse`, `margin: 0`, `th`/`td` `border 1px --border` + `padding 4px 8px`; `th` bg `--surface-2`, `--text` |
| `ul`/`ol`       | `padding-left: 20px`; **markers restored per level** — `ul` `disc` → `circle` → `square`, `ol` `decimal` → `lower-alpha` → `lower-roman` (see below)                                                                                            |
| `hr`            | `border: 0`, `border-top 1px --border`, `margin: 16px 0`                                                                                                                                                                                        |
| `img`           | `max-width: 100%`; a remote one is blocked by the CSP (`img-src 'self' data:`) and shows the `alt` — v1 doesn't embed local images (left for a later iteration)                                                                                 |

**List markers.** Tailwind's preflight sets `list-style: none` on every
`ul`/`ol`, and this block never put it back — so `- item` rendered as an unlabelled
indented line in **all seven** consumers of the seam (Markdown pane, Folder View, card
detail, memory pane, review pane, folder preview, lessons), where a list is the most
common structure there is. The markers are restored **here, in the shared renderer**,
and **per nesting level** — a nested list whose marker is identical to its parent's
reads as one flat list:

| Level | `ul`     | `ol`          |
| ----- | -------- | ------------- |
| 1     | `disc`   | `decimal`     |
| 2     | `circle` | `lower-alpha` |
| 3+    | `square` | `lower-roman` |

**Named values, never `list-style: revert`.** `revert` would hand back preflight's
`margin` and `padding` along with the marker and silently reflow every list in the app;
a typography plugin would restyle headings, code and blockquotes in the same stroke.
The narrowest change the block already implies is the right one — nothing else about
the prose may move.

**Per-table scroll wrapper.** The seam wraps **each** `<table>` in a
`<div class="md-table-scroll">` (`overflow-x: auto`), and that wrapper — not the
rendered block — is the horizontal scroll container. Before it, the nearest scroll
container was the whole block: scrolling right to read column seven of a wide table
dragged the paragraphs above and below it out of the viewport, so the reader lost the
sentence that said what the table was. The wrapper also carries the table's bottom
margin (`0 0 10px`), which the table itself no longer has, so rendered spacing is
unchanged. One wrapper per table, emitted at the renderer rule so a table is never
double-wrapped.

**The table keeps its natural width** (`min-width: max-content`) — the other half of
the same fix, and the wrapper is inert without it. A table's default width is
shrink-to-fit, and this block's inherited `word-break: break-word` lets it shrink to
almost nothing, so a wide table compresses into the pane and breaks its own header
words mid-word instead of overflowing anything (measured at 560px: `Owner` renders as
"Owne r"). Pinned to max-content it overflows the WRAPPER, which is what the wrapper is
for. A table that already fits is unaffected — shrink-to-fit already renders it at
max-content. This is the rule the Scheduler's run-result block had to declare for
itself in T311; the seam owns it now, and that local copy is **redundant**.

**Heading ids are unique — the v1 "duplicates are acceptable" call is reversed
.** Headings still get a GitHub-style slug, and the first occurrence still
keeps the bare slug so an author's `#anchor` link resolves. On top of that: a repeated
heading in one document is **suffixed** (`intro`, `intro-1`, `intro-2`), and each
`MarkdownRenderer` **instance** prefixes its ids (`md3-intro`), because the app puts
several of these blocks on one page — a Folder View listing card bodies, a memory pane
beside a card modal, the Scheduler's Last-result card a few pixels above the same
result in a row disclosure. Two of them rendering the same source used to emit the same
`id`: invalid HTML, and a document-wide `getElementById` or an assistive tech's heading
map lands on whichever came first. It was never a _behaviour_ bug — the pane's anchor
handler is root-scoped — which is why v1 called it acceptable; it is a validity and
accessibility one. The click handler resolves the prefixed id first and falls back to
the bare slug, so `#anchor` links are unaffected.

**Copy button (per-code-block, `MarkdownRenderer.vue`) — T121.** Every fenced code block
gets a hover-revealed copy control. It lives in the shared renderer, not the pane, so
every surface built on it inherits the affordance for free: `MarkdownPane` (above),
`MemoryPane`, roadmap cards, and the T120 lessons viewer.

- **Placement.** Icon button, `20×20px`, `position: absolute`, `top: 6px; right: 6px`
  inside the code block's wrapper; `--radius-sm`, `--color-surface` background, `1px
--color-border` border.
- **States:**
  - **idle** — `opacity: 0` (invisible until revealed); icon `copy` (12px, `--color-text-3`).
  - **hover / focus** — `opacity: 1` when the **block** is hovered (`group-hover`-style,
    not just the button) OR the button itself is `:focus-visible` — a keyboard user
    tabbing through the pane must be able to reach and use it without a mouse hover; on
    direct hover the icon also brightens (`--color-text`, `--color-surface-2` background).
  - **copied** — icon swaps `copy` → `check` (`--color-green`) for **~1.5s**, then reverts
    to idle; `aria-label`/`title` swap in step (`markdownRenderer.copyCode` ⇄
    `markdownRenderer.copied`) so the state change is announced, not just visual.
- **Action.** `navigator.clipboard.writeText` with the **raw fence content** — the exact
  source text as authored, never the rendered `innerText` (which could carry
  syntax-highlight markup or normalized whitespace). The raw text reaches the DOM as an
  attribute **explicitly allowlisted via DOMPurify's `ADD_ATTR`** — the sanitizer's
  default `ALLOW_DATA_ATTR: false` stays in force for every other attribute; this is a
  named exception, not a loosened contract.
- **Independence.** Copying one block never touches another's icon state or timer.

**"Copy file" toolbar button (`MarkdownPane.vue`) — T121.** Same idle/hover/copied idiom
as above, at `18×18px` in the header (see Header, item 6): copies the **current `draft`
buffer** — raw markdown text, including unsaved edits — never the rendered HTML. Hidden
for an image file (nothing text-shaped to copy).

**Body (image).** When the read IPC returns `kind: 'image'` (image fast-path above),
the body swaps prose/text for an **`<img>`** inside the same scrolling container:

- container: the same `padding: 14px 16px` as `.scrollable`, content **centered** (flex,
  both axes) — an image smaller than the pane sits at the center, not stuck in a corner;
- `img`: `max-width: 100%` (never overflows the pane; height follows the aspect ratio),
  **`--color-surface` backdrop** + `border-radius --radius-sm` (gives a background to a
  transparent PNG/SVG without inventing a checkerboard), `alt` = **file basename** (no
  i18n key — it's the file name, a technical noun);
- header: the view⇄edit toggle and `save` **don't appear** (an image isn't editable —
  the edit model is textarea/UTF-8); `reload` and `x` remain normal;
- no new token — reuses `--color-surface` and `--radius-sm` from §9.

**Links (§3.5, reuses existing contracts).**

- **External** (`http`/`https`/`mailto`): rendered `target="_blank" rel="noopener noreferrer"`;
  the existing `setWindowOpenHandler` validates the scheme and opens it in the OS. The
  app window **never** navigates (`blockForeignNavigation` intact).
- **Anchor** (`#heading`): headings get a slugified `id` in the seam; the click does a
  `scrollIntoView` **within the pane itself**, no navigation.
- **Relative `.md`** (`./other.md`): resolved against the current file's dir (via the
  read IPC, which reconfines it to the known folders) and **reopened in the SAME pane**
  (docs browsing). Outside root, binary, or no `linkBase` → **inert** + steer
  (`markdownPane.relativeSteer`).

**States.** `loading` (`markdownPane.loading` text, `--text-3`), `ready` (the prose, the
editor, OR the image), and `error` — centered `--text-3` message per code
(`markdownPane.error.*`: outside the known folders, **binary** (Cluster G — replaced the
old "unsupported extension"; since the image fast-path it only fires for **non-image**
binaries — font, archive, executable), file too large, not found, read failure, **write
failure**). No new token.

**Edit mode (phase 2).** The header toggle switches between **view** (read-only prose
via `MarkdownRenderer`) and **edit** (a raw `<textarea>` — no heavy editor dependency;
the scope decision was a textarea, `--font-mono` 12px/1.6, `padding 14px 16px`,
`white-space: pre-wrap`, `bg --bg`, no border). **Explicit** save model (not autosave):
editing fills a `draft` buffer, the dirty dot lights up when `draft ≠ saved content`, and
the operator saves via the `save` button **or ⌘/Ctrl-S** inside the editor. A deliberate
choice — writing is the most sensitive surface; an explicit save with a visible dirty
state keeps the operator in control of a file an agent may have left behind. **View mode
previews the `draft`** (not disk), so toggling edit→view shows the in-progress edits. A
**blank** file (the "New" flow) opens directly in edit. **Discard guard**: reload,
navigating via a relative link, or re-targeting the file with pending edits do NOT
silently discard them — they trigger a non-blocking toast (`markdownPane.unsaved.*`)
whose "Discard and continue" action proceeds (same pattern as the stale-session toast;
never a `window.confirm`, which freezes the extension). On save: a short `success` toast
(`markdownPane.saved`); on refusal: a `danger` toast localized by the code.

**Confined write (write IPC).** `markdown:write` mirrors the read (§3.4): the same known
folders (`markdownKnownRoots`), the same size cap, reusing `checkMarkdownReadAllowed`.
Cluster G removed the extension allowlist on the write side too — any path inside the
known roots is writable (the content always comes from the editor, so there's no binary
to refuse on write; the binary sniff only applies to READING a pre-existing file). Writes
atomically (tmp + rename); NEVER creates/overwrites outside the known roots
(`..`/absolute/false-positive-prefix rejected before any byte). `MarkdownRenderer` remains
read-only — only `MarkdownPane` writes.

**`open_file` verb (MCP, S4, extended by Cluster G).** It's `mutates:true` (acts on the
operator's UI) with a **light confirm** whose disclosure SHOWS the path (containment-
checked) — "opens a read-only viewer". Opens in **background**: the renderer's
`pane.openMarkdown` does a headless append (never selects the session/worktree), so N
`open_file` under a grant don't pull the operator's focus. Grantable
(`SAFE_GRANT_VERBS`); the same **dedup by `filePath`** + **per-worktree cap** below
prevent grant × budget N from stacking N panes. Two-layer containment: (1) the `folder`
passes through the gate/allowlist; (2) the `path` is reconfined to the known roots in
`runMutation` — outside root → `steerError` (`MARKDOWN_OUTSIDE_ROOTS`). The verb's
structural validation no longer requires a markdown extension (Cluster G); a binary file
still opens the pane normally — it's the PANE, on reading the content, that shows the
refusal (non-image binary; an **image renders inline** via the fast-path), the same path
a human click on the `eye` icon would take.

**Persistence.** The pane is reproducible only from the `filePath` → **persists** in
`helpers.json` (adds `'markdown'` to the `toPersistShape` filter and to
`HelperPaneType`) and **reopens on boot**, like an editor's tabs.

**Anti-accumulation (grant × budget N in S4, and the manual open).** In
`addMarkdownHelper`: **dedup by `filePath`** (reopening an already-open file returns the
existing pane, doesn't add another) and a **cap of 4 markdown panes per worktree** (on
exceeding it, the **oldest** open is recycled, not stacked).

#### Quiz block (interactive lesson in the Markdown pane)

A ` ```quiz ` block inside a `.md` file **renders as an interactive widget** (real
inputs) instead of a code block. The rest of the file keeps rendering as prose via
`MarkdownRenderer`. The pane enters **lesson mode** when the file (in view mode) has at
least **one valid quiz block** — detected by content, not by extension or a frontmatter
flag, so any `.md` an agent writes with a `quiz` fence simply works; a `.md` with no quiz
renders exactly as before. **Edit mode doesn't change**: a lesson is still a text file
the operator can edit.

Component: `QuizBlock.vue` (one question, **purely presentational**) inside
`MarkdownPane` (which owns exam state, grading, and delivery). The parser
(`lib/lesson-blocks.ts`) **slices** the document into prose/quiz segments — the T74
seam returns a sanitized HTML STRING for `v-html`, and there's no way to mount a Vue
component inside it; rendering prose and quiz as siblings keeps the sanitizer as the
only audited sink.

**Anatomy.** Card `--surface`, border `--border`, `--radius`, padding `10px 12px`,
bottom margin `12px`. Prompt in `--text` 12.5px/600. Options below, stacked with a
`6px` gap. `explain` (if present) only shows after grading.

**Three shapes**, decided by the embedded answer key: **one** `[x]` → **radio**
(single choice); **several** `[x]` → **checkbox** (multi; correct = exact set match);
`open: true` → **textarea** (`--surface-2`, `--font-mono` 12px/1.5, 56–140px, vertical
resize).

**Why it does NOT use `SegmentedControl`** (the "the only choose-1-of-N group" rule
above): `SegmentedControl` is a **configuration** control — short pills, side by side,
with no notion of grading. A quiz option can be **prose** (a long sentence that wraps
across lines) and needs two states that control doesn't model (`graded-correct` /
`graded-wrong`). That's why a quiz option is its **own row** (native input + label),
documented here — and **exclusive to the lesson**: no other screen should reuse it in
place of `SegmentedControl`.

**Option states:**

| State                                               | Visual                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `unanswered`                                        | `--surface-2`, border `--border`, text `--text-2`; hover → border `--border-2` |
| `selected` (pre-grading)                            | `--accent-soft`, border `--accent-line`, text `--text`                         |
| `graded-correct`                                    | `--green-soft`, border `--green`, text `--text` + `check` icon 12px `--green`  |
| `graded-wrong` (selected and wrong)                 | `--red-soft`, border `--red`, text `--text` + `x` icon 12px `--red`            |
| `graded-missed` (correct, learner didn't select it) | **dashed** `--green` border, `--surface-2`, text `--text-2`                    |
| `open` (post-submit)                                | textarea becomes **read-only**, border `--border-2`, text `--text-2`           |

`graded-missed` exists to show the correct answer **without pretending the learner got
it right** — correction that teaches, not punishes. An open question never gets a
correct/wrong color: the teacher session grades it, not Harnu.

**Explanation (`explain`).** Appears **only after grading**, below the options,
`--text-3` 11.5px, with `.anim-fade-in` (§7). **Never** visible before — the answer key
is embedded in the file and must not leak into the render.

**Submit bar (lesson footer).** One button **per lesson**, not per question
(`markdownPane.lesson.submit`), accent, separated by a `border-top --border`. Disabled
(`opacity 0.4`) while no question has been answered. On submit: grades locally, the
button **becomes the scoreboard** (`3/4`, `tabular-nums`, `.anim-fade-in`) and the
answers **freeze** — submission happens **once**; the lesson becomes the record of what
the learner answered. Delivering the result to the teacher session is reported via
**toast** (`lesson.delivered` / `lesson.noSession`), not text in the pane.

**Checkpoint (`mode: check`).** The block gets its **own submit button** in the card's
footer (`markdownPane.lesson.check`, secondary: `--surface-2`, border `--border`, text
`--text-2`; never accent — accent belongs to the EXAM's submit, and the hierarchy needs
to say which is which). On submitting a checkpoint: **only that block** grades (colors +
`explain`, §States), **the rest of the lesson stays live** — the other questions remain
editable and the exam's submit bar is still there. A checkpoint already graded
**freezes only itself** and swaps its button for the verdict (`✓`/`✗` + the `explain`).
**The lesson's submit bar ignores checkpoints:** the exam's scoreboard only counts
`exam` blocks. A lesson made **entirely** of checkpoints (practice material, no exam)
**doesn't show the submit bar** — there's no exam to deliver. Motion: `.anim-fade-in`
on reveal, like the rest.

**Motion.** Only `.anim-fade-in` (§7) on reveals; row color transition on
`--dur-fast`/`--ease`. No new keyframe.

### Dropping a folder onto the sidebar (pin as a project)

Dragging a folder from the OS file manager onto the sidebar (or the empty-state
onboarding hero) pins it as a project. Both surfaces share one implementation —
`useFolderDrop()` owns the `dragOver` state and the three handlers, calling
`sessions.pinFolder(path)` for each dropped item and resolving the real path via
the preload bridge (`window.api.getPathForFile`, since `File.path` was removed in
Electron 32+); `FolderDropOverlay.vue` owns the visuals. `Sidebar.vue` and
`Onboarding.vue` only bind the handlers and pick a scrim.

**Affordance (the discovery is the point).** Originally this drew only a bare
`ring-1 ring-accent-line` on the container — too faint to read as "you can drop
here" against `bg-sidebar`. On the `dragover` of a file drag, the sidebar now shows
a full overlay: a **scrim** over its own content (`color-mix(in srgb,
var(--color-sidebar) 94%, transparent)` — `var(--color-bg)` for the onboarding
hero, since it sits on the main content area, not the sidebar surface), a **dashed
drop-target box** inset 10px (`border-radius: var(--radius-lg)`, `2px dashed
var(--color-accent)`) that **pulses**, a centered **`ArrowDownToLine`** icon
(30px, `text-accent`), and a label below it reading "Drop to add folder"
(`sidebar.dropHint`, a short label with no period — §8). The overlay uses
`.anim-overlay-fade` (§7) and is `pointer-events-none` so it doesn't trigger a
spurious `dragleave` by appearing under the cursor — same anatomy as the
terminal-pane drop overlay below.

**The pulse reuses `ring-breathe`.** Rather than a new keyframe, the dashed box's
pulse plays the SAME `ring-breathe` animation already defined for the Fleet
rail's `needs-input` ring (§7 — "a solid ring that breathes" / "I'm waiting on
YOU"), via a one-line utility class `.anim-drop-pulse`. Only the border pulses —
the icon and label stay fully legible throughout.

**The overlay always clears itself.** `dragOver` is set by `dragover` and cleared
by `dragleave`/`drop` — but two failure modes make that insufficient, and
`useFolderDrop` handles both. `dragleave` **bubbles**, so every nested row the
pointer crosses fires one at the host; clearing only when `relatedTarget` falls
outside the host stops the overlay flickering as you drag across the list (the
same guard `TerminalPane` uses). And a drag cancelled with the pointer still
inside (Esc, or a drop the OS swallows) may deliver **neither** closing event,
which would strand a full-bleed scrim over the UI — so every `dragover` re-arms a
900ms idle watchdog that clears the state on its own. Chromium re-fires
`dragover` roughly every 350ms while a drag hovers a target, so the watchdog
never fires mid-drag.

**No new §9 token** — reuses `--color-sidebar`, `--color-bg`, `--color-accent`,
`--color-text-2`, `--radius-lg`, the existing `ring-breathe` keyframe, and
`.anim-overlay-fade`.

### Dropping a file onto the session (dragging from the file manager)

Anyone coming from VS Code drags a plan/PRD straight into the chat. Harnu replicates
that: **dragging a file (or folder) from the OS file manager over a terminal pane
injects the absolute path into that pane's live PTY** — the same mechanism as the
footer's image re-attach (`injectPathIntoSession` → `shellEscapePath`

- a trailing space; no `Enter`, the user reviews and sends). Applies to `TerminalPane`
  (main pane, injects into `sessions.selectedId`) and to each `HelperPane` (injects into
  **that pane's own** PTY, via direct `ptyWrite` — helper panes don't go through the
  store's writer bus). Dropping multiple files injects each one (the trailing space
  separates them).

**Affordance (the discovery is the point).** On the `dragover` of a file drag
(`dataTransfer.types` includes `Files`), the pane shows an overlay with
**`ring-1 ring-inset ring-accent-line`** +
a **centered label** "Drop to attach to chat" (`terminalDrop.hint`, a short label with
no period — §8) in a `bg-surface` + `shadow-pop` chip. The overlay uses
`.anim-overlay-fade` (§7) and is `pointer-events-none` so it doesn't trigger a spurious
`dragleave` by appearing under the cursor. If the session has no live PTY
(dormant/synthetic), the drop writes nothing and raises a discreet `info` toast
(`terminalDrop.notLiveTitle` / `terminalDrop.notLiveBody`).

**No new §9 token** — reuses `ring-accent-line`, `bg-surface`, `shadow-pop`,
`text-text-2`, and the `.anim-overlay-fade` motion helper.

### Collapsing sidebars (collapse — "full screen for the terminal")

The layout shell (`App.vue`) can **hide both side columns** to give the terminal the
full width. It's global layout state (persisted alongside `sidebarWidth`), not
per-worktree.

- **Left sidebar (folders/sessions).** Collapses via `layout.sidebarCollapsed`. Uses
  **`v-show`** (not `v-if`) to preserve the list's scroll / filter / expand-state
  across a collapse round-trip. The resizable divider disappears with it (`v-if`,
  there's no width to drag). When collapsed, the `<main>` (Topbar + content) touches
  the edge and the terminal takes the space — the `TerminalPane`'s `ResizeObserver`
  already re-measures the PTY grid on the spot (no special handling).
- **Right auxiliary panel (helper-stack / split).** Collapses via
  `layout.helperCollapsed`. The actual visibility is `helperPanelVisible(hasHelpers,
collapsed) = hasHelpers && !collapsed`: it composes the existing **auto-show** (only
  appears when the worktree has panes) with the manual override — **collapsed hides
  even with panes present**. **Reveal-on-appear:** opening the first pane in an empty
  worktree (Split / fork / "open in new tab") clears a stale `helperCollapsed`, so the
  freshly-created pane never starts invisible (only on the `false→true` edge; a manual
  collapse with panes already open **stays**).

**Controls (two, redundant — shortcut + mouse):**

- **Shortcuts:** `⌘B` / `Ctrl+B` (left) and `⌘⌥B` / `Ctrl+Alt+B` (right), mirroring
  VS Code's "primary / secondary side bar". Both are **owned by the native menu**
  (`&View` in `menu.ts`) — the accelerator is consumed by the OS before xterm, the only
  reliable way to take a `⌘/Ctrl` chord away from the terminal (see `menu.ts`'s
  header); the renderer double-binds as a fallback for WMs that drop accelerators.
  `⌘B`/`Ctrl+B` **steals** the chord from readline/tmux inside the terminal — same
  choice (and same default) as VS Code.
- **Reopen affordance (no shortcut memorization needed):** buttons in the **Topbar**,
  always the primary mouse form. On the left, a `PanelLeft` button **always visible**
  (the icon toggles `panel-left-close` ↔ `panel-left-open` per state). On the right, a
  `PanelRight` button visible **while the worktree has panes** — stays visible when
  collapsed (`hasHelpers` remains `true`), so the panel is always reopenable. No border
  strip/stripe: the permanent space cost would fight the "full screen" the feature
  exists to deliver.
- **Icons:** `panel-left-open`/`panel-left-close` and
  `panel-right-open`/`panel-right-close` (§5 — reuses the `lucide` set, no new
  token). 26×26px target, `--text-3` → `--text` with `--surface` background on hover,
  same as the other buttons in the Topbar cluster.
- **Labels (i18n):** `sidebar.hide`/`sidebar.show` and
  `helperStack.hide`/`helperStack.show` (the `title`/`aria-label` toggles per state).
  No trailing period (short labels, §8).

#### Takeover dismissal (shared rule — all main-pane takeovers)

The seven main-pane takeovers (`Roadmap board`, `PR Stack Canvas`, `Usage Dashboard`,
`System Monitor`, `Cleanup`, `Review pane`, `Scheduler`) are mutually exclusive and cover
the transcript. Since T297/T299 they are not independently-tracked booleans a hand-kept
list has to remember — they are **one registry** (`VIEW_REGISTRY` in `stores/ui.ts`,
keyed by `ViewId`) and **one piece of state** (`activeView: { id, params } | null`).
Three dismissal rules apply to **every** entry in the registry; a new takeover inherits
them for free by being added to the registry, not by re-implementing them:

- **A view absent from the registry has no way to reach the screen.** `App.vue` holds
  no `v-else-if` per takeover — a single `<TakeoverHost />` renders
  `<component :is>` off `activeView.id`. There is no branch left to add and therefore no
  branch left to forget: adding a seventh view is a registry entry, not five separate
  manual registrations (a ref, an opener, a `closeAllTakeovers()` line, an
  `anyTakeoverOpen` clause, a template branch). `closeAllTakeovers()` itself is a single
  `activeView.value = null`, plus the leaving entry's own `onClose` hook if it declared
  one (the Review pane's is how the review companion pane gets disposed — see T245
  AC-6 — fired on the close EDGE only, never on open, so re-opening the review for a
  different card does not tear down the pane it is about to host).
- **The entry-point button is a toggle.** A persistent affordance that opened a
  takeover — the Topbar's `[board]`/`[pr-stack]`, the footer's `Cleanup` pill and heap
  gauge — closes it again on a second click (`ui.toggle*`, not `ui.open*`), and carries
  an **active state** while its view is open (`--accent-soft` background + `--accent`
  ink for the 26×26 Topbar buttons; `--accent` ink alone for the footer's borderless
  pills), plus `aria-pressed`. A button you can't un-press is a one-way door, and the
  operator has to hunt for the header `X` to get back to work.
  **Menu entries are NOT toggles**: `FolderMenu`, `SessionMenu`, `RepoGroupHeader`, and
  notification navigation (`openNavigableView`) keep calling `ui.open*` — an item
  labelled "Roadmap board" must open it, never close whatever is on screen.
  For a **`scope: 'repo'`** (or `'folder'`) registry entry, the toggle compares the
  folder the two calls target: clicking the button while ANOTHER repo's (or folder's)
  view is open **switches** instead of closing (closing there would cost a second click
  just to reach the view that was asked for). A **`scope: 'global'`** entry has no
  folder to compare — its toggle is a plain open/close flip. This lives once, in the
  registry-driven toggle, not per view.
- **Focusing a session dismisses every takeover — and the Folder View.** Selecting one
  (sidebar row, command palette, approval row, board card), minting one ("+ New
  session", the dedupe-to-existing-synthetic branch, a manual board dispatch), forking
  one, or opening a folder terminal are all the same intent — "show me that session's
  transcript" — so each one routes through the single primitive `sessions.select(id)`,
  which does `ui.closeAllTakeovers()` → `selectedId = id` → `selectedFolderPath = null`
  in that order. Clearing `selectedFolderPath` is what dismisses the Folder View: it
  is selection-driven — anchored on `selectedFolderPath`, not `activeView` — and stays
  **outside the registry**: it is not one of the six covering views, but it is bound by
  the exact same focus rule, through the exact same `sessions.select()` primitive, so a
  session it is displaying "for" is still dismissed the instant a session is focused.
  Only the user-intent path does this; programmatic selection (synth→real migration,
  spawn, closure fallback, the background dispatch drain) never yanks an open view —
  those keep their direct `selectedId.value = …` write.
- **Esc dismisses it too**, via the App-level `closeAll()` — same shared helper, so the
  list can't rot the way the hand-kept one did (it never learned about the PR Stack).
- **A takeover covers the terminal — it does not unmount it.** `TerminalPane` renders
  unconditionally in `App.vue`, absolutely positioned to fill the main-content
  box; every takeover, plus the Folder View, Onboarding, the Empty state and the Cloud
  session stub, render into their own opaque `absolute inset-0 bg-bg` layer stacked ON
  TOP of it instead of replacing it in a `v-else-if` chain. This exists because
  `TerminalPane` owns the ONLY watchers that drain `sessions.agentBootQueue` /
  `sessions.sessionWakeQueue` (the background agent-boot pipeline) — before this fix, a
  boot dispatched while ANY takeover was open silently never ran, because the component
  (and its watchers) simply didn't exist until the operator dismissed the takeover.
  `App.vue`'s `showTerminalForeground` computed decides which layer is on top: the hidden
  layer gets `invisible pointer-events-none` (paint and pointer input) plus `:inert`
  (sequential Tab-focus navigation and the accessibility tree, in one native attribute —
  Electron's pinned Chromium has supported it since Chromium 102, so a separate
  `aria-hidden` is redundant here). A companion watcher additionally blurs any focus left
  inside `.xterm` the moment the terminal stops being foreground — a backstop kept mainly
  because jsdom, this repo's unit-test DOM, does not implement `inert`'s native focus/blur
  behavior at all, so the explicit watch is what the test suite actually exercises. Between
  the two, a covered-but-still-mounted terminal never keeps keyboard focus (or receives
  keystrokes), and can never be Tabbed into, once its layer is covered. `TerminalPane.vue`
  itself needed no changes — the fix is entirely in what `App.vue` mounts.

#### TakeoverShell — shared chrome for all six takeovers

Before this slice the six takeovers each hand-rolled their own root and header: four used
`flex h-full w-full flex-col bg-bg`, two used `min-h-0` instead of `w-full`; four had
`font-medium` titles, two had `font-semibold`; four carried a root `aria-label`, two
didn't. Six independent copy-pastes, quietly disagreeing. `TakeoverShell.vue` is the one
root + header now — applied by `TakeoverHost`, **not imported by the six
views** (a view cannot render without it, and has no way to opt out). A view keeps
everything below the header; its own header markup (icon, repo label, KPI line, WIP
chip, heap gauge, the companion/refresh buttons, …) still lives in the view, just
relocated out of a `<header>` it no longer owns.

- **Root** — `flex h-full w-full min-h-0 flex-col bg-bg`, `:aria-label="$t(titleKey)"`.
  `min-h-0` is the deliberate pick, not an average of the two patterns: the two scrolling
  canvases (`PrStackCanvas`'s pannable world, `ReviewPane`'s diff scroller) need it so
  their own `min-h-0 flex-1 overflow-y-auto` body can actually shrink and scroll inside a
  fixed-height takeover — without it a flex item's height defaults to its content size and
  the inner scroller never gets a bounded height to scroll against. Adding it to the other
  four is inert: they have no sibling at this level competing for height, so it changes
  nothing for them. `w-full` is kept alongside it (redundant under the parent's
  `align-items: stretch`, but every one of the six already carried it, and dropping it
  would be inventing a smaller root than any of the six shipped with). Every takeover now
  has a root `aria-label` — `ReviewPane` and `PrStackCanvas` didn't before U3.
- **Header** — fixed 40px (`h-10 shrink-0 items-center gap-2 border-b border-border
bg-surface px-3 text-text-2`, the 4-of-6 majority shape; `ReviewPane`/`PrStackCanvas`'s
  `flex-none` + `pl-3.5 pr-2.5` reconciled down to it, not averaged). Title
  `text-[13px] font-medium text-text` (the 4-of-6 majority weight; `ReviewPane`/
  `PrStackCanvas`'s `font-semibold` reconciled down to it) from `$t(titleKey)` — the same
  `VIEW_REGISTRY` key `stores/ui.ts` already carries per view.
- **Icon + view-specific header content — via `Teleport`, not a `<slot>`.** A dynamically
  swapped child (`<component :is>`, chosen by `TakeoverHost` off `activeView.id`) cannot
  fill a named `<slot>` of the ancestor wrapping it — Vue slots only flow parent → child,
  and here the flow needed is the opposite. The header carries two DOM landing zones
  (`display: contents`, so an empty one adds no box of its own) that each view's own
  `<Teleport>` targets: one for its leading icon (exact size/stroke preserved per view —
  `Trash2`/`GitPullRequest` render at 16px, the rest at 15px, and forcing one size on all
  six would itself be a visual regression), one for everything else that used to sit
  between the title and the close button (a repo label, the header-counts eyebrow, the WIP
  chip, the heap gauge, the companion/refresh buttons — including, verbatim, whatever
  spacer/`ml-auto` each view used to push its own trailing content right). Singleton-safe:
  exactly one takeover is ever mounted at a time (the mutex above), so there is never a
  second `TakeoverShell` for a Teleport target to collide with.
- **Close** — one `22×22px` button, `hover:bg-surface-2 hover:text-text`, `X` at
  `size 14 stroke-width 1.6` (the 4-of-6 majority icon treatment). Click calls
  `ui.closeAllTakeovers()` directly — the shell only ever hosts one view, so there is
  nothing to disambiguate; no per-view `close*` wrapper is wired through it. `title` and
  `aria-label` reuse the view's own existing `<ns>.close` i18n key, derived from
  `titleKey` by the convention every view already followed (`<ns>.title` → `<ns>.close`,
  e.g. `roadmap.title` → `roadmap.close`) — so the accessible name and tooltip text are
  exactly what each view said before, not a new generic "Close". Four of six already
  paired that key with both `title` and `aria-label`; `ReviewPane` and `PrStackCanvas` had
  `aria-label` only. The shared button always sets both (the majority pattern), so those
  two gain a hover tooltip they didn't render before — the one intentional visible delta
  this slice makes, and the reason it carries a CHANGELOG entry.

A seventh takeover inherits all of this by being added to `VIEW_REGISTRY` — there is no
shell to remember to wrap itself in, the same way there is no `App.vue` branch to
remember (above).

#### Topbar per-repo view buttons (Roadmap board, PR Stack)

The two per-repo main-pane takeovers — the **Roadmap board** (`kanban-square`) and the
**PR Stack Canvas** (`git-pull-request`) — are reachable from the Topbar's right
cluster, not only from the folder's context menu. Rationale: both are views you open
_about the repo you are currently working in_, and the context menu costs a
right-click on the correct sidebar row first — a detour precisely when the operator is
already looking at that repo's session.

- **Anatomy:** identical to every other right-cluster action — 26×26px, `--text-3` →
  `--text` with a `--surface` hover background, 14px icon at `stroke-width 1.5`. No
  badge. **Active state** while their view is open for the selected session's folder:
  `--accent-soft` background + `--accent` ink (replacing the idle/hover pair), plus
  `aria-pressed` — the button is a toggle (see "Takeover dismissal" above), and a
  pressed-looking button is what makes the second click discoverable.
- **Order:** `[bell] [board] [pr-stack] │ [folder] [vscode] [github-pulls] [explorer]
[split] [panel-right]`. The two view buttons sit **before** the external-tool openers:
  they act _inside_ Harnu, the ones after them leave for the OS or another app.
- **GitHub pull requests** (`git-pull-request-arrow`, `topbar.githubPulls`): opens
  `https://github.com/<owner>/<repo>/pulls` in the browser for the active folder's
  `origin`. **Hidden, not disabled,** when the folder has no `origin` or it isn't on
  github.com — there is nothing to open. Same anatomy as the other openers, no active
  state (it leaves Harnu).
- **Visibility:** inside the existing `sessions.selectedSession` guard, like the rest
  of the cluster. They act on the **selected session's** folder (`projectPath` + the
  folder alias as the repo label) — exactly what the context-menu entries pass, so
  both routes land on the same view.
- **Labels (i18n):** `topbar.roadmapBoard` / `topbar.prStack` (`title` + `aria-label`).
  Short labels → no trailing period (§8).

#### Memory pane (project memory viewer, non-PTY)

A helper-stack pane that **renders a repo's project memory** (§4.2) — the T79 S3
visualization piece. Non-PTY like the Markdown pane (cheap, reproducible from the
`folder`, mounts/unmounts freely, outside `liveHelpers`). Component: `MemoryPane.vue`
over `MarkdownRenderer.vue` (the same reusable prose) + the `useMemoryStore` cache
(shared with the hover's hot cue). What it shows comes from the same memory **shared
per repo** (`.harnu/memory/`, resolved to the main checkout) — every worktree sees the
same spotlight.

**How it opens.** Via the **"Project memory…"** item in the `FolderMenu` (`notebook-text`
icon, right below "Launch options…"). The pane enters the **selected worktree's** stack
(appears in the split visible at the time); with no session selected, it enters the
target folder's own stack and appears when one of its sessions is opened. The target
`folder` is what the pane resolves — never the worktree it's anchored to. **Always
available** (every folder has memory: per-repo, or per-folder outside git, §3.1).

**Header (title bar, 24px).** Reuses the "Pane header" (`h-6`, `--surface`,
`border-bottom --border`, header = resize handle). Left to right: `notebook-text` icon
(12px, `--text-3`); **folder basename** (`title` = full path, truncated); **reload**
button (`rotate-ccw`, forces a bypass of the TTL cache → rereads disk); **close** button
(`x`, `removeHelper`). Same 18×18 targets and `mousedown.stop` as the Markdown pane.

**Tab strip (hot · decisions · timeline).** Below the header, a `border-b --border`
strip (`bg-bg`, `px-2`), `role=tablist`. Each tab: `padding 6px`, 11.5px; active in
`--text` with a `1.5px --accent` underline (`absolute inset-x-1 bottom-0`), inactive in
`--text-3` → `--text-2` on hover. Default = **hot** (the "where we left off"). Labels via
`memoryPane.tab.*` (`hot`/`timeline` tech nouns left untranslated; `decisions` is
translated in pt-BR).

**Body (scroll, `padding 14px 16px`).**

- **hot / decisions:** the rendered prose of `hot.md` / `decisions.md` via
  `MarkdownRenderer`; missing page → an empty note per tab (`memoryPane.hotEmpty` /
  `memoryPane.decisionsEmpty`, `--text-3` 12px).
- **timeline** (default view of the digests, §4.2): the `sessions/` list, **most recent
  on top** (`buildTimeline`, pure). Each row: **date** (`YYYY-MM-DD`, mono
  `tabular-nums` 10.5px `--text-4`) + **title** (digest's first `# `, 12px, truncated) +
  — when the digest references a session — the `arrow-up-right` icon (`--text-4`) on
  the right; below, the **visible provenance** (raw `author` `human`/`agent` + `branch`
  with the `git-branch` icon, 10.5px `--text-4`) — visible per §7 (cross-session
  prompt-injection mitigation). A row with a session reference is a `<button>`
  (`cursor-pointer`, hover `--surface-2`, `title` `memoryPane.openSession`); **clicking
  reveals + selects** the source session in the sidebar (`revealFolder` + `select`,
  matching the provenance's `session=` or the filename's `sessionId8` against
  `allSessions`). **Graceful degradation:** with no matching live session, a `warning`
  toast (`memoryPane.sessionNotFound`) instead of navigating nowhere.

**States.** `loading` (`memoryPane.loading`), `error` (read denied/failed →
`memoryPane.error`, centered `--text-3`), and **memory empty** (`data.exists === false`
→ title + body `memoryPane.empty.*`, centered) — honest: a repo with no memory yet
still shows the empty state, never an error. Today's empty timeline (S2's digest
doesn't run yet) falls to `memoryPane.timelineEmpty`.

**Persistence.** Reproducible only from the `folder` → **persists** in `helpers.json`
(`'memory'` added to `HelperPaneType` and to the `toPersistShape` filter) and **reopens
on boot**, like the Markdown pane. Dedup by `folder` in `addMemoryHelper` (reopening the
same repo's memory returns the existing pane). **No new §9 token** — reuses the pane
header, `MarkdownRenderer`'s prose, the existing dots/chips, and colors.

#### Explorer pane (project file browser, non-PTY)

A helper-stack pane that **browses the project's file tree** — the `<repo>` of the
selected worktree — **confined to the root**, respecting `.gitignore`, expanding
folders **lazily**, and letting the operator **inject any path (file OR folder) into
the chat** via a per-row button. It's the in-app answer to "I want to browse the
project's files and drop a plan/PRD into the chat without leaving Harnu": the OS-native
dialog is unusable on Linux/Wayland (the XDG portal ignores `defaultPath`), and that's
exactly why this lives inside the app. Non-PTY like the Memory/Markdown pane (cheap,
reproducible from the `root`, mounts/unmounts freely, outside `liveHelpers`). Component:
`ExplorerPane.vue`.

**How it opens.** Via the **"Browse files"** button (`folder-tree` icon) in the
Topbar's right cluster, next to Split. The pane enters the **selected worktree's**
stack and is confined to that worktree's root. **Dedup by `root`** in
`addExplorerHelper` → exactly ONE explorer pane per root (reopening focuses/returns the
existing one, never stacks).

**Reveal from the transcript.** Option/Alt+clicking — or Ctrl+clicking — a path
printed in a session's transcript (main terminal or a helper-pane terminal; the
underline and pointer cursor appear while either modifier is held) opens
(or reuses) this pane and **reveals** that path: search mode is
left, every ancestor directory is expanded in order (each listed lazily, exactly
as a manual click would), and the row is **selected** — `bg-accent-soft` +
`text-text`, `aria-current="true"` — and scrolled into view. Selection is
reveal-only: clicking rows in the tree never sets it, so the highlight always
answers "the path you clicked in the transcript is HERE". A **file** additionally
goes through the same `openFile` seam the `eye` icon uses, so the `markdown:read`
gate decides whether a viewer pane opens (and refuses a non-image binary /
oversized file with its usual toast). A **directory** is expanded instead;
nothing opens.

**`.harnu/` is always visible.** The agent's data dir — the root-level `.harnu/`
and everything under it, `.harnu/out/` deliverables included — is exempt from
`.gitignore` in all three gates (tree listing, finder walk, transcript
resolve), so a path an agent prints is reachable even though the repo ignores
it. Nothing else is exempt: every other gitignored path (`node_modules`, build
output) stays hidden, `.git` stays excluded, and root confinement is unchanged.
There is no legacy `.capy/` alias. The affordance itself is unchanged — same
rows, same selection — only more rows exist.

**Header (title bar, 24px).** Fully reuses the "Pane header" (`h-6`, `--surface`,
`border-bottom --border`, header = resize handle). Left to right: `folder-tree` icon
(12px, `--text-3`); **root basename** (`title` = full path, truncated); **new file**
button (`file-plus`, Cluster E — reveals an inline input at the root); **reload**
button (`rotate-ccw`, rereads the root and discards the children cache + expansion
state); **close** button (`x`, `removeHelper`). Same 18×18 targets and
`mousedown.stop` as the other panes.

**New file (inline input, Cluster E).** The header's `file-plus` reveals, at the top of
the body, a 24px row with a text input (`border --accent-line`, `bg --surface-2`,
placeholder `explorerPane.newFilePlaceholder`, auto-focus). **Enter** creates an empty
`<root>/<name>.md` via the confined `markdown:write` (§write; a name with no markdown
extension gets `.md`) and opens the file in a Markdown pane **in edit mode**;
**Esc**/blur/empty cancels. It's the **dialog-free** flow that replaces the old native
save picker. A write refusal (outside the roots / too large) becomes a `danger` toast
(same family as T74's `markdownPane.error.*`).

**Body (lazy tree, vertical scroll `.scrollable`).** On mount, `explorerListDir(root,
root)` (Cluster C — confined, gitignore-aware, cap of 1000). Each row (24px tall):

- **indentation by depth** (`depth * 12px + 4px` of padding-left);
- for a **folder**, a `chevron-right` **chevron** (`--text-4`, rotates 90° when open —
  same idiom as the sidebar); for a file, a spacer of the same size for alignment;
- **icon** `folder` (folder) / `file-text` (file), 12px `--text-3`;
- the **name** (basename, 12px `--text-2`, truncated; native `title` = full path);
- a **"view file" button** (`eye`, 18×18, `--text-4` → `--text`, FILE rows only —
  Cluster G) revealed on **row hover**, to the left of "add to chat" (reading order:
  view before acting); `title`/`aria-label` = `explorerPane.viewFile`;
- an **"add to chat" button** (`plus`, 18×18, `--text-4` → `--text`) revealed on **row
  hover** (`opacity-0` → `group-hover:opacity-100`, also on `focus-visible` for keyboard).

**Interactions.** Clicking a **folder's** body toggles expand — on the first expand,
`explorerListDir(root, folderPath)` and **caches** the children (collapsing keeps the
cache). Clicking a **file's body/name is inert** (Cluster G — reverses the T74/Cluster E
behavior): the ONLY way to open a file now is the **`eye`** icon, which emits
`openFile(entry)`; `HelperStack` wires this to `addMarkdownHelper` for ANY text file
(not just markdown), confined by `markdown:read` — a binary/too-large/outside-root file
refuses with a toast instead of opening the pane. The **add to chat** button injects the
absolute path (via `injectPathIntoSession` on the selected session — Cluster A;
`shellEscapePath` + a trailing space, no `Enter`); injecting a **folder** is valid
(Claude reads a dir). With no live PTY (dormant/synthetic session or nothing selected)
→ the same discreet `info` toast as the drop (`terminalDrop.notLiveTitle` /
`terminalDrop.notLiveBody`).

**States.** `loading` (`explorerPane.loading`, `--text-3`, while the root's listDir is
in flight — a loading subdir only appears once ready, the local disk IPC is fast),
`error` (`listing.error` on the root → `explorerPane.error`, centered `--text-3`; the
IPC returns `entries: []` on any failure — check `error` before rendering), `empty`
(root with no visible children after gitignore → `explorerPane.empty`), and the
**`…and more`** hint (`explorerPane.truncated`, `--text-4` 11px) at the end when the
cap of 1000 (`truncated: true`) was hit.

**Recursive search (search bar, Cluster F).** Right below the title bar lives its own
**search line** (28px, `bg --bg`, `border-bottom --border`) — the finder's primary
control, full width so it doesn't compete for space with the header buttons (new
file / reload / close stay in the title bar above). Left to right: `search` icon
(12px, `--text-3`), a full-width **input** (transparent `bg`, 12px `--text`,
placeholder `explorerPane.searchPlaceholder`), and a **clear** button (`x`, 18×18)
that appears only with text. Typing **≥2 characters** triggers a **recursive,
whole-project search** via `explorerSearch(root, query)` (Cluster F — recursive,
confined to the root, gitignore-aware, cap of 500) with a **~180ms debounce**; an
`Esc` in the input clears it. While there's a query (≥2 chars), a **flat results
list REPLACES the tree** in the body; clearing/shortening it **returns to the lazy
tree** (mode D) unchanged.

Each result row (24px) reuses the tree rows' idiom, `eye` icon included: `folder`/
`file-text` icon (12px, `--text-3`), the **path relative to root** with a **dimmed
directory prefix** (`--text-4`) and the **file name** in `--text-2`, the **view
file** button (`eye`, file rows) and the **add to chat** button (`plus`) revealed on
hover (`injectPathIntoSession` — Cluster A; file OR folder). The **row's body/name is
inert** (Cluster G, same rule as the tree) — the `eye` icon is the only way to open a
file result; **folder** results don't expand in flat mode — "add to chat" is the path.

**Search states.** `searching` (spinning `loader-2` + `explorerPane.searching`, while
the first batch hasn't returned), **empty** (`explorerPane.noMatches`, centered
`--text-3`), **error** (IPC error envelope → `explorerPane.error`), and the **cap**
hint at the end (`explorerPane.searchTruncated`, `--text-4` 11px) when the cap of 500
results — or the ~50k visited-entries ceiling — was hit (`truncated: true`). A late
response never overwrites a newer query (per-request sequence token).

**Containment.** Every listing goes through the `explorer:listDir` IPC gate
(Cluster C), which refuses any `dir` outside the `root` (`out-of-root`), an invalid
path, or a failed read — the pane only CALLS the IPC, never touches `fs`. **Search**
(`explorer:search`, Cluster F) is confined by construction — it only descends into
`root`'s subtree — and **prunes during the descent** `.git` and any gitignored
directory (the `.gitignore` layer stack accumulates live, the same semantics as C's
`readIgnoreChain`), so `node_modules` and friends are **never traversed** (correctness
AND the performance ceiling); every entry is still checked defensively via
`isPathWithinRoot`. Case-insensitive match against the path relative to root
(contiguous substring preferred, subsequence as fallback). **No new §9 token** — reuses
the pane Header/rows, the `search`/`loader-2` icon (§5), and existing colors.

**Persistence.** Reproducible only from the `root` → **persists** in `helpers.json`
(`'explorer'` added to `HelperPaneType` and to the `toPersistShape` filter) and
**reopens on boot**, like the Markdown/Memory pane. Expansion state is **not**
persisted — a reload re-lists the root and resets the expansion (acceptable: the tree
is cheap to rebuild). **No new §9 token** — reuses the pane header, the
`folder-tree`/`folder`/`file-text`/`chevron-right`/`plus` icons (§5), and existing
colors/hover.

#### Diagram pane (canvas viewer, non-PTY)

A helper-stack pane that **renders a canvas document** — an infinite whiteboard the
agent draws on and the operator annotates — instead of hosting a terminal. Component:
`DiagramPane.vue`, over the `canvas/` subtree (`canvas-graph.ts` builds the graph,
`canvas-cells.ts` maps the document to cells, `canvas-theme.ts` resolves the palette).
Spec: `docs/specs/2026-08-23-t218-canvas-pane.md` §6. The substrate is **AntV X6**,
pinned to core `2.19.2` + the 2.x plugins (spec §3.4 — core 3.x has no working plugin
ecosystem; the pin carries its reason as a comment in `package.json`).

**A pane, not a takeover** (spec §6.1). The canvas has to coexist with the terminal —
annotating a mockup _while talking to the agent about it_ is the whole loop, and a
takeover would put the conversation behind the drawing. It is per **file** and per
**worktree**, so two canvases open at once is legitimate, which a takeover's
`stores/ui.ts` mutex forbids by construction. The "give me room to draw" affordance is
the pane header's existing **maximize** button (§Maximizing a pane), inherited unchanged.

Like the Markdown/Memory/Explorer panes it **has no PTY**: it is reproducible from its
`filePath`, does not enter `liveHelpers`, and mounts/unmounts freely — the terminal's
detach-not-dispose rule does not apply.

**U2 renders read-only.** Editing, undo/redo, Save and the stale-on-disk banner are U3;
the header slots for them are specified here so the anatomy does not move when they
land, and the pane states what it is by showing a **read-only** badge until then.

**How it opens** (spec §6.3), mirroring the Markdown pane:

1. **Explorer pane `eye` icon** on a `*.harnucanvas.json` row — the suffix, not
   `extname()` (which yields a bare `.json` and would swallow every JSON file in a repo).
2. **`open_file`** from an agent, routed by the same suffix classifier — background,
   never steals focus (U4).
3. **The `draw_canvas` verb** on a canvas that is not open — it opens the pane the same
   way, so the agent's drawing is visible without a second call (U5).

**Header (title bar, 24px).** Fully reuses the "Pane header" above (`h-6`, `--surface`,
`border-bottom --border`, header = resize handle between panes). Left to right:

1. `shapes` icon (12px, `--text-3`);
2. name = **file basename** (truncated with `…`; native `title` shows the full path);
3. **dirty dot** — a `•` in `--color-accent` (14px, `line-height: 1`) right after the
   name, **only when there are unsaved edits**; identical to the Markdown pane's. It is a
   real element with `v-if="dirty"`, not a reserved gap: U2 omitted it entirely because a
   read-only pane can never light it, and U3 **adds** it;
4. ~~read-only chip~~ — **gone since U3.** It was an honest label for a half-built pane
   (`diagramPane.readOnly`, 10px, `--text-4`), and it disappeared when the editing
   affordances landed rather than becoming a mode switch. There is no read-only mode;
5. **undo** / **redo** buttons (`undo-2` / `redo-2`, 18×18px targets, `--text-3` →
   `--text` on `--surface-2`, `--text-disabled` + `disabled` when the history is empty at
   that end);
6. **save** button (`save` icon) — `--color-accent` when dirty, `--text-disabled` +
   `disabled` when clean, the Markdown pane's idiom exactly;
7. **reload** button (`rotate-ccw`, 12px in an 18×18px target, `--text-3` → `--text` on
   `--surface-2`) — re-reads the file from disk;
8. **maximize** button (inherited, unchanged);
9. **close** button (inherited, unchanged).

All header buttons `@mousedown.stop` so they never start a pane resize.

The **stale-on-disk banner** is the existing one (§Stale-on-disk banner):
`bg-warning/10 text-warning` replacing the filename row, with a `Reload` action routed
through the same discard guard. It appears **only** when the file changed on disk while
the pane holds unsaved edits (spec §7.3 case B); a clean pane reloads silently instead
(case A) and never shows it. The discard guard itself is the Markdown pane's
non-blocking "unsaved changes" toast, not a modal — one dialect of "are you sure" in the
helper stack, not two.

**Body: the X6 viewport.** `flex-1 overflow-hidden`, background `--bg` with a **dot
grid** built from `--border-2` at a 16px pitch and a **2px** dot — the only affordance
that makes panning legible, the same reasoning (and the same token) as the PR Stack
canvas's grid. The dot is 2px and not 1px because this grid **scales with the zoom**
(unlike PR Stack's CSS `radial-gradient`, which does not): a 1px dot renders sub-pixel
the moment the board is zoomed out, which is exactly when the grid is most needed. Nodes
are SVG shapes; a registered HTML shape (spec §5.2) is a real DOM node in the same
document, so it inherits the tokens for free rather than through an iframe.

Node and edge treatment, tokens only — **no raw hex anywhere in the component**:

| Element              | Fill / stroke                                                             |
| -------------------- | ------------------------------------------------------------------------- |
| `box` body           | `--color-surface` fill, `--color-border-2` 1.5px stroke, `--radius` rx/ry |
| `box` / `text` label | `--color-text`, 12px, `--font-sans`                                       |
| `text` node          | no body — label only, `--color-text-2`                                    |
| `image` node         | the asset, on a `--color-surface` ground                                  |
| edge line            | `--color-accent` 1.5px, `block` target marker, manhattan router           |
| edge label           | `--color-text-3` 11px on a `--color-bg` plate                             |
| grid dot             | `--color-border-2`, 2px dot, 16px pitch                                   |

**Theme (spec §6.4).** The palette is **resolved from CSS variables at mount and
re-resolved on every theme switch**, then pushed back onto every live cell and onto the
graph's own background/grid — the same contract `TerminalPane` honours when it reapplies
its palette to every live terminal. A theme change **must not** require a reload, and
must not move the viewport.

**Floating control cluster (top-left).** Absolute to the **viewport**, so it neither
pans nor scales — the anatomy the PR Stack canvas already established (§PR Stack Canvas
→ Floating controls): `bg-surface border-border`, `--shadow-pop`, `--radius`, 26px
buttons. It holds **Fit** (`scan`), **zoom −** (`minus`), the current percentage
(`--text-4`, tabular-nums, non-interactive), **zoom +** (`plus`). Zoom is clamped to
**0.2–3**; the wheel zooms with `ctrl`/`meta` held and the canvas pans on drag, so a
plain scroll gesture never fights the pane's own scrolling.

**The three blank-area gestures, and how they are split (U3).** A drag on empty board is
claimed by three things at once — pan, rubberband select, and draw-a-box — and X6 will
run two of them over one gesture if they are left to overlap (verified in the real app
during U2: a single drag panned _and_ left a selection box behind it). The split:

| Gesture                  | Does                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| plain left drag on blank | **draws a box** — the footprint follows the drag, floored at 48×32 |
| `shift` + left drag      | **rubberband select**                                              |
| right-button drag        | **pans**                                                           |
| `ctrl`/`⌘` + wheel       | zooms (0.2–3), unchanged from U2                                   |

Panning moved to a held **button** rather than a held key because every modifier was
already spoken for: `shift` by the rubberband, `ctrl`/`⌘` by zoom and multi-select. The
pane has no context menu for a right-drag to collide with, and **Fit** plus the zoom
cluster remain the discoverable way to move the view.

**Other edit gestures.** Double-click a node to rename it in place (an inline input over
the node itself, `--surface` on an `--accent-line` border; `Enter` commits, `Esc`
cancels). Drag from a node's **port** — four 4px `--accent`-ringed dots on `--bg`,
hidden until the pointer is on that node, and never present on a bare `text`
annotation — to draw a bound Manhattan edge. `Delete`/`Backspace` removes the selection,
`⌘/Ctrl-Z` / `⌘/Ctrl-Shift-Z` undo and redo, `⌘/Ctrl-D` duplicates, `⌘/Ctrl-A` selects
all, `⌘/Ctrl-S` saves, `Esc` clears the selection. Every shortcut is gated on the focus
being inside **this** pane, because several canvases can be open at once.

**Paste and drop an image (U6).** `⌘/Ctrl-V` with an image on the clipboard, and a drag
of an image file onto the board, are the SAME gesture with the same result: an `image`
node stamped `operator`, landing at the viewport centre (paste) or under the pointer
(drop), sized to the picture's aspect ratio and clamped to **320px** on its long side so
a 4K screenshot is a card rather than a wall, and floored at **48px** on either side so a
one-pixel-tall strip is still a thing the pointer can grab (`IMAGE_NODE_MIN_EXTENT`; the
same floor a drawn box has). Several in one paste stack at a 24px
offset. The bytes go to `assets/` next to the canvas and the node carries only the
relative path — **never a data URI** (spec §4.6; a 1.5 KB paste cost ~4.5 KB of canvas
file in the spike, and every Save rewrites the whole file). A refusal — over 6 images,
over 2 MB, not an image — is one `danger` toast (`diagramPane.imageFailed`) and **no**
node, never a partly-attached board. No new token: the node is the existing `image`
treatment.

**Registered component nodes — the mockup card (U7).** A node whose `shape` is
`harnu/<name>` is a **registered HTML component** (spec §5.2): the agent writes a NAME from
a fixed catalog and plain-JSON `props`, never markup, and the renderer owns how it draws.
It is a real DOM subtree inside X6's `foreignObject`, in **this** document — not an
iframe — which is exactly why it inherits the §9 tokens for free while an SVG cell has to
be repainted attribute by attribute on every theme switch. v1 ships one:
**`harnu/mockup-card`**, props `title` / `subtitle` / `status` / `body`, default footprint
**260×160**.

Anatomy, tokens only:

| Part          | Treatment                                                                          |
| ------------- | ---------------------------------------------------------------------------------- |
| card body     | `--surface` on a 1px `--border-2` border, `--radius` (7px), 10px padding, 6px gap  |
| `title`       | `--text`, 12px, weight 500, one line, `…`-truncated                                |
| `status` pill | 10px, `--radius-sm`, `2px 6px` — tone table below                                  |
| `subtitle`    | `--text-3`, 11px, one line, `…`-truncated                                          |
| `body`        | `--text-2`, 11px / 15px line-height, wraps, clipped to the card's remaining height |

The **status tone** is derived from the prop's own text, lowercased and trimmed, against a
fixed table — the manifest declares the key, not a vocabulary, so an unrecognized word must
still render rather than being refused or dropped:

| Tone                                                                                     | Words                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `--green` on `--green-soft`                                                              | `done`, `ready`, `shipped`, `ok`, `passed`               |
| `--warning` on `--warning` at 10% (`bg-warning/10`, the app's existing amber-pill idiom) | `wip`, `in progress`, `in-progress`, `review`, `pending` |
| `--red` on `--red-soft`                                                                  | `blocked`, `failed`, `error`                             |
| `--text-3` on `--surface-2` (**default**)                                                | anything else, including a word this build does not know |

**The node's own `label` is the card's title fallback, and X6's SVG label is not drawn.**
A mockup card renders its own heading, so painting the graph's `<text>` label over the DOM
card would show the same name twice. The label is still written to BOTH attribute paths
(§4.5, spike trap 3) so a Save round-trips it and double-click rename still works — it is
`display: none`, not absent. This is the one place a canvas node's label is deliberately
invisible, and the reason is that the component already shows it.

**A shape name this build does not know still opens the board** — it renders as the dashed
box the unknown-kind fallback already specifies, because `graph.addNode({ shape })` THROWS
on an unregistered name and a newer Harnu's board must not take the pane down.

**No new §9 token.** The card reuses `--surface`, `--border-2`, `--text`/`--text-2`/
`--text-3`, `--radius`, `--radius-sm`, and the green/warning/red state ramp already in use
by the status pills elsewhere in the app. The classes live in `main.css`
(`.canvas-mockup-card*`) rather than as Tailwind utilities for the same reason
`.fleet-ring` does: the element is built in JavaScript, outside a Vue template.

**Fit runs on open — never on a reload and never on a plain re-render.** Moving the view
under an operator who is reading it is the failure this rule exists to prevent, which is
why a theme switch, a manual Reload and a silent on-disk reload all preserve the
viewport (spec §7.3 case A). Only a fresh open and an explicit press of **Fit** move the
camera.

**States.** `loading` (`diagramPane.loading`, `--text-3` 12px, centred), `error` (the
reader's machine-readable deny code mapped to one localized line, centred `--text-3` —
never a raw code), and **empty** (`diagramPane.empty` + `diagramPane.emptyHint` centred over the grid when
the document parses but holds no nodes; the grid still shows, so the pane reads as "an
empty board" rather than "a broken pane", and the hint says the two things an empty board
cannot show — that a drag draws a box, and that an image can be pasted onto it).

**Persistence.** Reproducible from its `filePath` → **persists** in `helpers.json`
(`'canvas'` added to `HelperPaneType` and to the persist filter) and **reopens on boot**,
like the Markdown/Memory/Explorer panes. Deduped by `filePath`, capped at 4 per worktree
— the same rule and the same reason as the Markdown pane's cap.

**No new §9 token.** The pane reuses the pane header, the `shapes`/`scan`/`minus`/`plus`/
`rotate-ccw`/`undo-2`/`redo-2`/`save`/`maximize-2`/`x` icons (§5), and the existing
colour ramp. The in-flight draw preview is `--accent-soft` inside a dashed
`--accent-line` border — the tokens the selection treatment already uses, so a preview
of a node reads as "not yet a node".

### Inputs

- Background: `--bg`
- Border: 1px `--border` (default) → `--accent-line` (focus)
- Border-radius: 5px
- Padding: `8px 10px`
- Font: Inter 13px (or JetBrains Mono for paths/commands)
- Focus: changes only the border, no box-shadow

### Context menu

- Background: `--surface`
- Border: 1px `--border-2`
- Border-radius: 6px
- Padding: 4px (internal gap between items: 0, padding per item)
- Shadow: `0 12px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.3)`
- Minimum width: 200px (240px if it contains long items)
- Optional header (label + target name) with border-bottom

Each item:

- Padding: `6px 8px`
- Font: 12px
- Color: `--text-2`
- Icon+text gap: 9px
- Hover: bg `--surface-2`
- Shortcut on the right edge (`--text-4`, JetBrains Mono 10.5px)
- Destructive item: color `--red`, hover bg `rgba(239,111,91,0.10)`

Separator: `height: 1px`, bg `--border`, margin `4px 2px`.

#### Session copy actions (Copy ID / transcript path / --resume)

Group of three items in the session context menu (`SessionMenu.vue`), in its
own block right after **Open in new tab**, separated by a divider
(`sep-copy`). All copy to the clipboard via
`navigator.clipboard.writeText` (the click is a user gesture in Electron's
secure renderer, so it resolves without a prompt) and fire a confirmation
toast:

- **Copy session ID** (icon `hash`) → copies the session's uuid.
- **Copy transcript path** (icon `file-text`) → copies the absolute path of
  the `.jsonl` on disk (`transcript` kept untranslated).
- **Copy --resume command** (icon `square-terminal`) → copies the string
  `claude --resume <sessionId>` (`--resume` kept untranslated).
- **Copy context digest** (icon `copy`, T38) → reads the tail of the transcript and
  copies a **portable digest** in markdown (folder · branch · summary · first prompt ·
  last N turns) to paste into a new session / doc / issue — context reuse
  without "hunting the JSONL by hand". The digest content is technical and **not
  translated** (like the copied `--resume` / path); only the item label and the toast go through i18n.

Since they operate on a real `.jsonl` on disk, the four items (and the
`sep-copy` divider) are **hidden for synthetic sessions**, along with Fork / Archive /
Delete / Open in new tab. A clipboard rejection swaps the success toast for
a `danger` toast.

#### Session roadmap board (Roadmap board)

Item in the session context menu (`SessionMenu.vue`, icon `kanban-square`,
T149), in its own block right after the copy actions, separated by a divider
(`sep-roadmap`). Opens the per-repo Roadmap board scoped to **the
right-clicked session's own folder** — resolved from the menu's target
session, not `sessions.selectedSession` — so it works from a session that
isn't the currently active one. Mirrors the folder-menu **Roadmap board**
entry (`FolderMenu.vue`); unlike the copy actions above, it needs no
`.jsonl` on disk, so it stays visible for synthetic sessions too.

#### Session restart (Restart session)

Item in the session context menu (`SessionMenu.vue`, icon `rotate-ccw`), right
after **Fork session**. Kills the session's `claude` process and respawns
`claude --resume <uuid>` — the way to make the session **re-read what `claude`
only reads at launch**: a newly installed skill, an edited `settings.json`, a
new MCP server. The conversation is preserved (the `.jsonl` on disk is resumed by
`--resume`), so it's **non-destructive** and has no `window.confirm`. A
`success` toast ("Session restarted") confirms the action — it's the only visible signal
when the session is restarted in the background.

**Visibility:** only appears for sessions **with a live PTY** (`isSessionLive`) and
**non-synthetic**. On a dormant session (no process) there's nothing to restart —
selecting it already starts it from scratch with the new skill/config. On synthetic,
restarting would relaunch a _new_ `claude` (losing the in-progress conversation) or
re-fork from the origin, so the item is hidden along with Fork / Archive /
Delete / copies.

**Mechanics** (`reloadSession` → `registerReloadHandler` in `TerminalPane`):

- **Attached** session (main pane visible): dispose + immediate `activate`, the
  restart appears instantly.
- Session **live in background** (not visible): dispose only; the next
  `activate` (when the user comes back to it) respawns — recreating it now would open
  the xterm on the shared host and steal the view.

#### Session remote control (toggle Remote Control)

**Toggle** item in the session context menu (`SessionMenu.vue`, icon `smartphone`),
same anatomy as the **No flicker** toggle (label + on/off state). Turns Claude Code's
own **Remote Control** on/off (`claude --remote-control [name]`, the bridge
to the phone app). Label via `remoteControl.toggle`; the action alternates between
`remoteControl.enable` (turn on) and `remoteControl.disable` (turn off).

**Mechanics:** turning it on **marks the session's boot config** with the flag and **restarts** it —
kill + `claude --resume`, exactly the **Restart session** mechanics above — so it
comes up already with `--remote-control`. It's an **operator-only** flag: it lives in `ClaudeBootConfig`
and is emitted by `buildClaudeArgs`, but stays **outside** the agent's `bootOverride`
allowlist (`agent-boot.ts`), so **an agent can never turn on Remote Control** on a
session. Like the restart, it's **non-destructive** (the conversation is resumed via `--resume`).

**Disclosure on enable** (`remoteControl.disclosure`): before restarting, a note
makes the trust model explicit — rendered inline in the menu (same language as the
No flicker toggle's `hint`), visible **before** the user confirms. The text makes clear:
_reads_ (chat + tool results) can be pulled **off the device** to the
phone; _mutations_ still require the **confirm at the desk** (the §6 approval overlay),
which **doesn't reach the phone** → an unanswered confirm **denies**. Harnu's mutation MCP
server **never leaves loopback**; only the session's chat/tool-results cross the Claude
bridge. No new §9 token.

**Status:** with Remote Control active, the session is flagged with the
`remoteControl.status` indicator ("Remote control on"), so the active bridge is never invisible.

**Visibility:** like **Restart session**, only makes sense on real sessions (not
synthetic) — the toggle is hidden in synthetic alongside Fork / Restart / Archive /
Delete / copies.

#### Session orchestrator role (toggle Promote to orchestrator)

**Toggle** item of the session context menu (`SessionMenu.vue`, `Crown` icon),
same anatomy as **Remote Control** above: a single
static label ("Promote to orchestrator") with a trailing checkmark for the
on state — it does NOT flip its text like the folder-menu's agent-control
item. Label via `sessionMenu.orchestrator`.

**Mechanics:** turning it on **arms the Harnu-managed guard**
(`orchestrator-guard.ts#arm(sessionId, folder)`, T109) — a `PreToolUse` hook
that blocks `Edit`/`Write`/`NotebookEdit` outside `.harnu/` + scratchpad for
this session — and **restarts** the session (kill + `claude --resume`, the
same mechanic as **Restart session** / **Remote Control**) so it relaunches
with the orchestrator contract (`docs/harnu-orchestrator.md`) prepended to its
`--append-system-prompt`, exactly the T55 self-awareness preamble mechanism.
Turning it off **disarms** the guard and restarts again to drop the contract.
Closing an armed session disarms it automatically (`SessionEnd` → the guard's
boot-time observer) — a stale id never lingers across a restart.

**Disclosure on enable** (`orchestrator.disclosure`): before the restart, an
inline note (same placement/language as the **Remote Control** disclosure)
states the role plainly — this session becomes the repo's coordinator; it
plans, delegates, and reviews, but structural guard rails block it from
editing product code or committing/pushing directly. No new §9 token.

**Visibility:** like **Restart session** / **Remote Control**, only makes
sense on real sessions (not synthetic) — hidden in synthetic alongside Fork /
Restart / Remote Control / Archive / Delete / copies.

#### Submenu (flyout)

**What it is:** a `MenuItem` with `children` opens a **flyout** to its right instead
of running an action directly. Only use today: **Modes ▸** in the folder menu (see
"#### Folder context menu" below).

**Affordance:** a `chevron-right` (12px, `--text-3`) at the row's right edge signals
that it opens a flyout. Without it the row lies, looking like any other action.

**Opening:** hover **or** keyboard focus. `→` (or `Enter`) opens the flyout and focuses
the first child row; `↑`/`↓` move between children; `←` closes **only the flyout** and
returns focus to the parent row. `Esc` keeps the meaning it has everywhere else in the
app: it closes the **whole menu** (not just the flyout). The flyout opens to the right
of the row, aligned to its top; if it does not fit in the viewport, it **mirrors to the
left**.

**Visual:** the same card as the parent menu: `--surface`, border `--border`,
`--radius`, `--shadow-pop`. Same rows as the parent menu (`6px 8px`, 12px, `--text-2`
→ `--text` on hover). No new token.

**Content (Modes):** one row per mode in the registry (`SESSION_MODES`, main), with
the mode's icon. Selecting one **boots a new session in that folder, in that mode**;
it does not promote an existing session and opens no dialog.

**Motion:** `.anim-fade-in` (§7). No new keyframe.

#### Folder context menu (Hide / Unhide)

Right-click menu on a project row (`FolderMenu.vue`). Items:

- **New terminal** (icon `square-terminal`) → opens a shell attached to the
  folder's cwd (`createFolderTerminal`), rendered in the folder's "Terminals"
  sub-group (see "#### 'Terminals' sub-group"). Terminals **stack** (a folder can
  have several).
- **Modes ▸** (icon `graduation-cap`, T123) → opens the **Submenu** flyout
  described above, right below `New terminal` (its sibling: both spawn a new
  session; this one chooses **which type** of session gets born). One row per
  mode in the registry (`SESSION_MODES`) — today only **Learning**
  (`graduation-cap`). Selecting a mode calls
  `createNewSession(folderPath, undefined, modeId)`: boots directly, no
  intermediate dialog.
- **Rename…** (icon `pencil-line`, with ellipsis → opens a dialog) → renames the
  folder's sidebar **alias**. Opens `RenameFolderDialog` (see "### Rename
  folder"), right after `New terminal`. Always visible — every folder can have an
  alias. Renaming an auto-discovered folder **creates** the record in
  `projects.json` (implicit pin, like Hide), so the alias survives a restart.
  Non-destructive.
- Toggle **Use branch as name / Use folder name** (icon `tag`), which **flips** the
  folder's `aliasFromBranch` flag (`userProjectsSetAliasFromBranch`, T52): when ON
  and the basename differs from the branch, the label falls back to `gitBranch` (a
  custom alias always wins). Appears/disappears with the toggle. Non-destructive.
- **Startup options…** (icon `sliders-horizontal`) → opens the folder's Claude Boot.
- **Store memory in…** (icon `folder-cog`, with ellipsis → opens a dialog, T89) →
  the **per-project override** for the memory location, which wins over the global
  default (Settings → Memory). Opens `MemoryLocationDialog` (a `Dialog` variant,
  `min(520px, 92vw)`): a `SegmentedControl` with **three** options — **Global
  default** (follows the app default), **In this project** (forces
  `<repo>/.harnu/memory/`) and **Central folder** (its own root) — plus the same
  input+Choose… as central and the "Current location" line (`font-mono`
  `--text-4`, full path in `title`). When **saving** a different location with
  existing memory, the dialog offers **Move existing memory now** (fs move +
  verify + report for that repo) before closing. The override lives only in
  Harnu's config (`projects.json`), never in the repo. Right below "Project
  memory…".
- **New folder…** (icon `folder-plus`, with ellipsis → opens a dialog) → creates a
  subfolder **inside** this folder and pins it automatically, already organized in
  the structure. Opens `NewFolderDialog` (see "### New folder"). Its own block
  (divider above), right after `Startup options…`. Non-destructive.
- **Open subfolder…** (icon `folder-search`, with ellipsis → opens a dialog) →
  lists this folder's subfolders (recursive, depth ≤4, ignoring
  `node_modules`/`.git`/`vendor`/`dist`/`target`) in a searchable picker; choosing
  one pins it. Opens `OpenSubfolderDialog` (see "### Open subfolder"). Same block
  as `New folder…`. Replaces the "leave Harnu and run `harnu .`" flow with two clicks.
- **Create WORKTREE.md / Open WORKTREE.md** (icon `file-cog`) → creates or opens
  the repo's `WORKTREE.md` manifest. **Git folders only** (`isGitFolder`), its own
  block (divider above), right after `New worktree…`. The label alternates based on
  a probe when the menu opens (`worktreeMd:probe`): no manifest → **Create
  WORKTREE.md**; with a manifest present (any recognized name — `WORKTREE.md`,
  `worktree-manifest.md`, `.claude/worktree.md`) → **Open WORKTREE.md**. Selecting
  it fires `worktreeMd:create` (idempotent — **never overwrites** an existing
  manifest), which resolves the repo root (`git --git-common-dir`, never the
  clicked linked worktree), pre-fills via deterministic heuristics (no LLM), and
  writes the proposal; the Markdown pane opens the file in **edit mode**
  when it's a new proposal (`initialMode:'edit'`), in view mode when the manifest
  already existed. **Non-destructive and non-executable**: Harnu writes but
  NEVER runs the manifest — `setup` only runs on a worktree create, behind the
  existing confirm (the T87 trust boundary). Proposal anatomy under "#### WORKTREE.md creator".
- **Ask an agent to write WORKTREE.md** (icon `sparkles`) → option C (secondary),
  right below the primary item in the same block. Dispatches a session in the
  folder (the T80 dispatch engine, `dispatchCardSession`) whose boot prompt
  (`folderMenu.worktreeMdAgentPrompt`) asks the agent to study the repo and
  **PROPOSE** a `WORKTREE.md`; the human reviews it in the pane and commits.
  Plain synthetic (started by the human, not agent-controlled).
- Toggle **Block / Unblock agent control** (icon `bot`), which **flips** the
  folder's `agentDenied` flag (`userProjectsSetAgentDenied`), in its own block
  separated by a divider:
  - Folder reachable (the default) → **"Block agent control"** → refuses every
    agent verb in this folder **and its whole subtree** (blocking a repo blocks
    its worktrees).
  - Folder blocked → **"Unblock agent control"** → back to the default.

  Agents can act in every folder by default (see "### Control server (MCP)"), so
  this is an **opt-out**, not a grant — the inverse of the old "Allow agent
  control" toggle. The block is absolute: no mission grant and no "always allow"
  can reach into a blocked folder. Same source as the Settings → Control server
  list (they mirror the same flag). Non-destructive, no `window.confirm`.

- Toggle **"Intercept tool calls here"** (icon `shield-check`), right after
  agent-control, which **flips** the folder's `interceptActive` flag
  (`userProjectsSetInterceptActive`, T30) — the Approval Inbox trust ramp:
  - Folder off the ramp → **"Intercept tool calls here"** → under the hook
    responder's `active` mode (§6 → "Trust ramp"), gated tool calls from this
    folder start **stopping at the Approval Inbox**.
  - Folder on the ramp → **"Stop intercepting here"** → back to shadow behavior
    (logs, never blocks).

  Same source as the Settings → Hook responder ramp list (they mirror the same
  `interceptFolders` in the store). Non-destructive, no `window.confirm`.

- **Toggle "Auto-organize conversation into draft cards"** (icon `layout-list`,
  T106), right after the intercept toggle — the per-repo switch for whether a
  session may organize its own conversation into `backlog` draft cards on the
  roadmap board without being asked. **Default ON.** Alternates:
  - Enabled → **"Turn off auto-organize"** → the session should stop drafting
    cards on its own initiative for this repo.
  - Disabled → **"Turn on auto-organize"** → restores the default behavior.

  **Per REPO, never per session or per worktree** — a linked worktree
  (`isLinkedWorktree`) does not get this entry at all; it silently inherits the
  main worktree's value (`canonicalWorktreeParentRepo`, no re-asking, no
  extra dialog on `New worktree…`). Adding a folder asks nothing — the toggle
  is discoverable in this menu, never an onboarding interrogation.
  Non-destructive, no `window.confirm`. There is no enforcement code behind
  it — it is read by the promoted/executor session as one runtime line in its
  boot preamble (mirrors the T85 memory-language line), and honored as model
  behavior per the conservative task-smell contract in
  `docs/harnu-orchestrator.md`.

- **Toggle "New sessions start as Orchestrator"** (icon `crown`, T344), right
  after auto-organize — the per-FOLDER switch for whether every plain new
  session the operator starts here ("+ New session", the New session dialog,
  the keyboard shortcut) boots already promoted to Orchestrator (T98's
  contract doc injected + the structural guard armed), with no per-session
  click. **Default OFF.** Alternates like the auto-organize item above:
  - Disabled → **"New sessions start as Orchestrator"** → turns it on.
  - Enabled → **"Stop starting sessions as Orchestrator"** → back to the
    default (a plain session).

  **Per EXACT folder, never inherited** — unlike auto-organize, a linked
  worktree does **not** silently pick up its main worktree's value: an
  orchestrator's own folder is where its EXECUTORS get dispatched into
  worktrees, and an executor born armed would be structurally blocked from
  editing the code it was dispatched to write. The entry is shown for every
  folder, worktree or not, each independently toggleable. Non-destructive, no
  `window.confirm`. Agent-dispatched sessions (MCP `create_session`, a
  board/manifest dispatch, a Scheduler tick, a read-only review companion)
  are NEVER armed by this default, regardless of its state — only a plain
  operator-started `claude-new` session is eligible
  (`shouldArmAtSpawn`, `orchestrator-guard.ts`).

- Toggle Hide / Unhide, which **flips** according to the project's state:
  - Visible project → **Hide** (icon `eye-off`) → hides the project.
  - Already hidden project → **Unhide** (icon `eye`) → reveals the project.

The state comes from `manuallyHiddenPaths` in the store. A hidden row is only
clickable (and therefore only allows Unhide) once the user has activated the
reveal via the "{count} hidden — show" pseudo-row.

**Hidden project row (revealed):** when a hidden row appears in the list
(reveal mode or an active filter), it's rendered with `opacity: 0.5` and the
folder icon is swapped for `eye-off` (`--text-4`), signaling it's hidden
and indicating where to right-click to Unhide.

#### WORKTREE.md creator — generated proposal

**Create WORKTREE.md** doesn't ask the user anything or call an LLM: it assembles a
**deterministic** proposal from what it probes in the repo. The generator is pure
(`worktree-md-generate.ts`, unit-tested); the shell (`worktree-md-ipc.ts`) only probes
disk + git and writes atomically (tmp + rename) at the repo root. Heuristic matrix:

| Detection                                  | Manifest decision                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm`/`yarn`/`bun`/`npm` lockfile         | active `setup` install (`pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` / `bun install --frozen-lockfile` / `npm ci`) |
| `package.json` with no lockfile            | `#   - npm install` commented out (the author chooses the manager)                                                                        |
| `composer.json`                            | `setup: [composer install]`                                                                                                               |
| `.env` present                             | `seed.copy: [.env]` (active — real secret, gitignored)                                                                                    |
| `.env.example`/`.env.sample` (no `.env`)   | `cp .env.example .env` commented out in `setup` (a template isn't a secret)                                                               |
| `node_modules/` / `vendor/`                | `# link: [node_modules/]` **commented out** in `seed` (never active — trade-off caveat)                                                   |
| `.claude/worktrees/` exists                | `dir: .claude/worktrees/{slug}` (else `../{repo}-worktrees/{slug}`)                                                                       |
| default branch (origin/HEAD → main/master) | `from: <branch>` (else `# from: main` commented out)                                                                                      |

**Anatomy of the generated file.** _Front matter_ with only the **active** trusted
keys and everything else documented as a `#` comment (the 7 keys — `dir`/`from`/`seed`/
`setup`/`create`/`remove`/`boot` — each with a comment line explaining what it does).
_Markdown body_ with `# Worktree setup — {repo}`, a "What Harnu detected" block (why
each line exists), the reference for the 7 keys, the **`seed.link` caveat** (symlink =
a shared deps tree, wrong when the branch touches deps → prefer installing in `setup`),
and the trust reminder (review + **commit** — it's versioned content, like a
post-checkout hook). **Fidelity contract:** the generated front matter passes through
the resolver (`resolveManifest`) with **zero warnings** — the generator
never emits an "empty" `seed:`/`setup:` (comments only) that would degrade to null.

#### Session archive (Archive / Unarchive)

Item in the session context menu (`SessionMenu.vue`) that **flips** according to the
session's state (source: `archivedIds` in the store, persisted to `localStorage`):

- Normal session → **Archive** (icon `archive`) → pulls the session out of the
  sidebar's normal flow and ends its live terminal (if any). **Non-destructive**:
  the `.jsonl` on disk is preserved (unlike Delete), so there's no
  `window.confirm`.
- Archived session → **Unarchive** (icon `archive-restore`) → returns the
  session to the normal flow.

An archived session **doesn't** count toward the folder's count badge or the
attention counter (window title / OS badge). It's pulled out of the normal
list and only reappears under the **"Show {n} archived"** pseudo-row
(same anatomy as the "Show {n} older sessions" reveal) — there its status dot
is the `archived` dot (6px, `--text-4` border, `opacity: 0.55`) and the label
sits at `opacity: 0.62`, signaling the state and indicating where to
right-click to Unarchive.

### Toast

**Non-modal** visual notification, anchored to the bottom-right corner. Used
to announce passive system events (update downloaded, process failure,
etc.) without stealing focus or blocking the UI. Coexists with any
other floating surface — doesn't participate in the palette / dialog /
menu / preview mutex.

Files: `Toast.vue` (individual card) + `ToastStack.vue` (list).
Lifecycle in the `useUiStore` store (`pushToast` / `dismissToast`). **The only
entry point is `useUiStore().pushToast({ ... })`** — mounting `<Toast>`
directly in another component is a contract violation.

**Position & stacking**

- Container: `position: fixed`, `bottom: 16px`, `right: 16px`, `z-index: 80`
  (above the command palette — toasts can't be obscured while
  counting down to auto-dismiss).
- `display: flex; flex-direction: column-reverse; gap: 8px`. DOM order is
  `oldest → newest`; `column-reverse` flips the visual order so the
  **newest** toast appears at the **bottom** (closer to the cursor),
  mirroring Linear / Raycast / macOS Notification Center.

**Card (`Toast.vue`)**

- Width: `min-width: 280px; max-width: 380px` — a single fluid column.
- Background: `--surface`; border: `1px --border-2`; border-radius: `7px`;
  shadow: `--shadow-pop`; padding: `12px 14px`.
- **Accent by `kind`**: 2px left border in the semantic color
  (`info → --accent`, `success → --green`, `warning → --warning`,
  `danger → --red`). The body stays neutral regardless of `kind`.

**Internal layout**

- Single `flex` row with `gap: 10px`, `align-items: flex-start`.
- Content column (`flex: 1`, `gap: 4px`):
  - Title: `text-text`, Inter `13px / 500`, line-height `1.4`.
  - Optional description: `text-text-3`, Inter `12px / 400`, line-height
    `1.5`.
- Action column (`shrink: 0`, `gap: 8px`):
  - Optional action button (ghost): `text-accent`, Inter `12px / 500`,
    `hover:underline`, no padding/border (visual link). The label accepts an
    i18n key (`toast.actions.*`) or a literal string — `Toast.vue` falls
    back automatically via `te()`.
  - Close button (X): `lucide` `X` 12px, `stroke-width: 1.6`,
    `text-text-3 hover:text-text`. `aria-label` read from `toast.dismiss`.

**Clickable card (when it has an `action`)**

- A toast with an `action` makes the **entire card** clickable — not just the link.
  The root becomes `role="button"`, `tabindex="0"`, `cursor-pointer`, with an
  `aria-label` (the action's label, or the title as fallback) to announce it well.
  Enter and Space trigger the action (Space calls `preventDefault`). The action button
  ("Open") stays visible — clicking the card is an additional hit target.
  The action and close buttons use `@click.stop` so the card's click doesn't
  fire twice (and the X **only** dismisses, never triggers the action).
- Without an `action`, the card stays passive: `role="status"`, no cursor or focus.

**Auto-dismiss**

- Default `timeoutMs: 6000` — informational toasts disappear on their own.
- `timeoutMs: 0` turns off the timer — mandatory whenever a toast has an
  `action` (sticky), to guarantee the user has a chance to click.
  Examples: "Update ready" + "Restart now".
- Transient error toasts (`kind: 'danger'`, no `action`) use the
  default 6s **or** a longer window (8s) when the message needs to
  be read calmly — a call-site choice.

**Harnu mod uses (T389 P1W4).** No new variant. (1) The **one-time disclosure**: a sticky
`info` toast with an action (`timeoutMs: 0`), pushed once while the kill switch is on and
the notice has not been shown; mounting it stamps the notice as shown. The title and body
say the three facts (the mod runs unsandboxed, inside the `claude` process, and talks only
to Harnu on this machine); the action **Open Settings** opens General at `set-companion`.
It reads as a notice, never as a prompt: nothing waits on a click. (2) The **unloaded
notice**: a `warning` toast, once per session, only when the session owned at least one
fact family at the moment the mod was lost ("Harnu mod unloaded in {session}. Running on
hooks."). In plain `shadow` nothing changed for the operator, so the state line changes
silently instead.

**Animation**

- Entry: `.anim-fade-in` from `main.css` (fade + translateY 2px → 0,
  duration `--dur`, easing `--ease`). No new per-component keyframes.
- Exit (v1): instant unmount. Fade-out is v1.1 — Vue's `<TransitionGroup>`
  will drive the exit then.

**Accessibility**

- Container: `role="region"` + `aria-live="polite"`. The screen reader announces
  new toasts in DOM order (oldest → newest), independent of the visual
  flip via `column-reverse`.
- Card: `role="status"`.
- Close button: translated `aria-label` (`toast.dismiss`).
- `closeAll()` (the global Esc handler) does **not** clear toasts by design —
  an "Update ready" notification shouldn't be wiped out by an Esc in the
  middle of another task.

**Don't**

- ❌ Mount `<Toast>` or `<ToastStack>` directly in another component — go
  through `pushToast()`.
- ❌ Add a new `kind` color. Use one of the four existing semantics
  (`info` / `success` / `warning` / `danger`).
- ❌ Use a toast for a destructive confirmation or modal prompts. Toast is a
  **passive** notification — confirmations go in `Dialog`.

### Activity bell (Topbar notification popover)

The durable **history** of every toast the Toast section above describes — the
memory `Toast` doesn't have. A toast auto-dismisses in 6s (or on explicit
dismiss); once it's gone there was, until T83 S1, no record it ever happened.
This history used to live as a stacked section inside the Inbox rail (T83 S1
through T151); **T152 moved it out** into a **notification bell in the
Topbar's right cluster** (`ActivityBell.vue`), anchored **outside** the
`v-if="sessions.selectedSession"` guard — the history is fleet-global, not
per-worktree, so it belongs somewhere that's reachable with no session
selected, not a column that only exists once you have a folder open. This is
the surface the Toast section's own copy anticipates when it says the toast
pile "mirrors Linear / Raycast / **macOS Notification Center**" — the center
now lives where every desktop notification center lives, a bell in the chrome.

**Interaction model (T152 — replaces T83 S1's read-only display):**

- **Bell button** — `26×26`, same anatomy as every other Topbar right-cluster
  icon button (`rounded`, `--text-3` idle → `bg-surface`/`--text` hover), with
  a count **badge** (`bg-accent`/`text-accent-ink`, `tabular-nums`, top-right
  corner) showing `notifications.list.length` — hidden entirely at zero, never
  a `0` badge. Click toggles an **anchored popover** (`right-0 top-full`,
  340px wide, `max-height: 520px`, `bg-surface` / `border-2` / `shadow-pop` /
  `radius` — the `FolderPreview` popover convention); click-outside or `Esc`
  closes it. **Never steals focus** — no autofocus, no focus trap, same
  discipline as the Inbox rail.
- **No read/unread state.** `dismiss(id)` (removes one record) and
  `clearAll()` (empties the list) replace the old `markRead`/`unreadCount` —
  being in the list **is** the "not yet handled" signal, so the badge is
  simply the record count. `NotificationRecord` drops the `read` field
  (a persisted buffer written before T152 may still carry a stale `read` key
  on disk; it's just ignored on load).
- **Row click navigates + dismisses.** Clicking anywhere on a row calls
  `sessions.activateSession(sessionId)` when the record carries one — the
  **BUG-31 fix**: the old rail row called the bare `select()`, which changed
  the active session without expanding its folder or scrolling the sidebar to
  it. `activateSession()` does the full reveal (expand folder, clear a
  blocking filter, scroll into view, set the keyboard cursor) before
  selecting. The row is then removed regardless of whether it had a session
  to jump to — a row that's been clicked is handled.
- **Hover swaps the timestamp for a dismiss ×** (`group`/`group-hover`, same
  idiom as the footer's pasted-images tiles) — clearing a row without
  navigating anywhere. `Clear all` in the popover header does the same for
  the whole list; both header pieces (count + Clear all) disappear together
  when the list is empty.
- **Optional per-row action buttons** — when a record carries an `action`
  (`{ label }`), an `accent-soft`/`text-accent` pill renders below the
  description (same treatment as the rail's old "Go to session" pill),
  `stopPropagation`'d so it doesn't double-fire the row's own click.

**Row anatomy** (BUG-42, unchanged from the rail era) — reuses `Toast.vue`'s
semantic color map, expressed as a different element (an Activity row is a
divided list item, not a floating card, so kind color can't live on the row's
own border without colliding with the row divider below):

- **Inner 2px kind-bar** — a dedicated child element (the row's first child,
  `w-0.5 self-stretch rounded-full`), colored by `kind` via `background`, the
  **identical** semantic map as `Toast.vue`'s left border (`info → --accent`,
  `success → --green`, `warning → --warning`, `danger → --red`). Never a
  border or background on the row box itself.
- **"Session says" eyebrow** (`source: 'agent'`, T116) — `--accent`, `9.5px /
700`, uppercase, `0.06em` tracking, above the title.
- **Title / description — the text-loss rule.** Short text always
  shows in full, no chevron. Long text **clamps to 2 lines only when an
  expand chevron is offered alongside it** (`ChevronDown`, 16×16, rotates
  180° open) — collapsing never happens silently, and the chevron only
  renders when the clamp would actually hide content (measured off the live
  DOM, `scrollHeight` vs `clientHeight` — a character-count guess isn't
  precise enough for a "never lose text" contract). The chevron click
  `stopPropagation`s so it never triggers the row's navigate-and-dismiss.
- **Relative timestamp**: `text-text-4`, `10px`, `tabular-nums`, right-aligned
  — replaced by the dismiss × on row hover (above).
- Rows separated by a `1px --border` top rule; **order: most-recent-first**.

**Empty state:** "You're all caught up" (`--text-4`, centered, 28px vertical
padding) — the popover header also drops its count and Clear all button in
this state, matching the mockup's `activity-popover--empty` variant.

**Store.** `stores/notifications.ts` — a `NotificationRecord` (`id`, `ts`,
`source`, `kind`, `title`, `description?`, `sessionId?`, `folderPath?`,
`notificationType?`, `action?`) ring buffer, persisted to `localStorage` the
same way as `theme`/`layout` (`persistedRef`), capped by **count (200)** and
**age (7 days)** — whichever trims more wins. `useUiStore`'s `pushToast` is
the funnel: every toast becomes a record by default (`persist: true`); a call
site opts out (`persist: false`) for trivia not worth a history row (e.g.
"copied to clipboard").

**Not virtualized.** Unlike the old rail section (BUG-36, `useVirtualList`,
needed because the rail was _always mounted_), the popover only exists in the
DOM while open (`v-if`), so a plain `v-for` over up to 200 records is cheap —
no virtualization dependency needed here.

**Don't**

- ❌ Reintroduce `read`/`unread` or a `markRead` call — the dismiss model
  replaced it; "in the list" already means "not yet handled."
- ❌ Introduce a new `kind` color or row-height. Reuse the Toast's four
  semantics and the rail-era row's spacing.
- ❌ Show the expand chevron on a row whose text actually fits — that's a
  minor cosmetic miss, not a contract break, but the reverse (hiding a
  chevron a truly-clamped row needs) is a text-loss bug.

### Mission progress (pill, popover, sidebar indicator)

**T370 (T358 slice S9), rewritten for Mission v3 (T381 S3, spec
`docs/specs/2026-10-01-mission-v3/spec.md` §3.2).** The operator's view of a
**Mission** — the structured progress record an agent keeps with the
`mission_*` verbs. It answers four questions at a glance: **where the work is,
what is done, what is left, what waits on me**. Three surfaces, all reading ONE
derived model (`lib/mission-view.ts`) built from the **server's**
`progress` object (`derived.progress`, computed once in
`src/main/mission-progress.ts`) — the renderer **never recounts**: it does not
decide which step is done, which is current, or how many are left behind. A
session that owns no open mission renders **nothing** on any of them —
`no-mission` is a state, not a gap. A mission is matched to a session the way
`mission_get` does it: the newest non-`closed` mission whose `owner.sessionId`
is that session.

**Data.** Read over the `mission:*` IPC (`src/main/mission-ipc.ts`), which
returns the same projection `mission_get` builds: stored fields, the `derived`
block, `progress`, the ordered `you` list (spec §3.12) and the end dialog's
`closeWarnings`. `stale` is the **derived** flag — never a stored status. The
store polls while the app is open. **Doors answer with the view they changed**
(spec §3.2): the store patches that one mission in place, or removes it when the
door returns `view: null` after an end — nothing waits for the next poll. A door
answer for a mission the store no longer holds is ignored, and a poll that
started before a door landed is discarded (the read after the door supplies the
truth).

There is **no draft** and no Approve door (spec §3.4): a legacy `draft` file
reads `active`. No surface shows a draft state, callout or button.

**Cue (Mission v3 §3.12).** Each poll decides whether a mission newly owes the
operator something — chime + OS attention + one Activity entry, re-nudged
every 30 min. Rules under Notifications, "Mission owes the operator — sound +
attention + Activity".

#### The headline — "Step N of M"

One headline, printed by the pill, the popover header and (compactly) the
sidebar chip, from `progressHeadline(progress)`:

| Kind     | Pill / header           | Sidebar chip     | When                                                |
| -------- | ----------------------- | ---------------- | --------------------------------------------------- |
| `single` | "Step {n} of {m}"       | `{n}/{m}`        | one current step                                    |
| `range`  | "Steps {n}–{to} of {m}" | `{n}–{to}/{m}`   | several steps run in parallel                       |
| `done`   | "Step {m} of {m} ✓"     | `{m}/{m} ✓`      | `progress.allDone` only                             |
| `empty`  | _(no text)_             | _(not rendered)_ | nothing to count (no steps, or only a legacy start) |

N is **position**, never proof: the step carrying the rail's current marker is
always step N. Proof is a detail on the step (badges), never the headline. An
`empty` pill still renders its icon so the operator can open the popover and
end the mission.

#### Topbar pill (`MissionPill.vue`)

Byte-identical anatomy to the provider/orchestrator pills beside it: height
`18px`, padding `1px 7px`, `rounded` (`--radius-sm`), `border` + text in one
color, `10.5px / 500`, `tabular-nums`, a 10px leading icon (`list-checks`;
`check` when the headline is `done` or the mission is delivered). Label: the
headline above. It is a `<button>` and **clickable** — it toggles the popover.
Placed after the orchestrator pill in the title row, selected session only.

**Five tones for seven in-mission states.** The pill answers "is something here
worth a glance?"; the popover is where the difference between the warning
states shows.

| Pill tone | Classes                       | States                                             |
| --------- | ----------------------------- | -------------------------------------------------- |
| _(none)_  | not rendered                  | `no-mission` (also a `closed` mission)             |
| accent    | `border-accent text-accent`   | `active`, `total-changed`                          |
| warning   | `border-warning text-warning` | `blocked`, `needs-you`, `stale`, `rescope-pending` |
| success   | `border-green text-green`     | `delivered`                                        |

The neutral tone (`border-border-2 text-text-3`) is kept in the type for the
pill anatomy but no state maps to it since draft was removed.

**Primary state**, first match wins: `rescope-pending` (a `pendingRescope` is
staged) → `needs-you` (the `you` list holds any item other than the re-scope
and the requested close — an operator blocker, due checks, a human step to
confirm, an imported end to review, a child's approvals or needs-input) →
`blocked` (any mission- or step-level blocker) → `stale` (derived) →
`delivered` (the requested close is the delivered state's own owed item, so it
reads success, not warning) → `total-changed` (any step carries `addedReason`)
→ `active`. The popover itself is **compositional**: a blocker callout, a stale
callout, an "Added" badge render wherever their data exists, whatever the
primary state is.

#### Popover (`MissionPopover.vue`)

Shell reused verbatim from the Activity bell: `anim-fade-in-scale`, `absolute
top-full mt-1.5 z-50`, `rounded border border-border-2 bg-surface shadow-pop`,
**400px** wide, `max-height: 560px`, body scrolls (`.scrollable`). Anchored
left to the pill (`left-0`), flipped right when it would overflow.
Click-outside and `Esc` close it; it never steals focus.

- **Header** (`padding: 10px 14px`, `border-b border-border`): "Progress"
  (`12.5px / 500`, `text-text`) with the **headline** right-aligned (`11px`,
  `text-text-4`, `tabular-nums`, `data-test="mission-count"`); the mission
  title under it, truncated (`11px`, `text-text-3`); then the **counts line**
  (`11px`, `text-text-4`, `margin-top: 3px`): "{done} done · {verified}
  verified", then "· {n} left behind" in `text-warning` when n > 0; then the
  **scope links** (spec §3.3) — one `file-text` 11px + the path's last segment
  (`font-mono 10.5px text-text-3`, the full ref in `title`), and "on a branch"
  (`text-text-4`) for a path that does not resolve on this checkout. Optional
  sub-line (`11px`, `text-text-4`, `margin-top: 3px`): total-changed → "Total:
  {total} steps (was {was}) — {n} added"; delivered → "Delivered — awaiting
  your close".
- **Body** (`padding: 12px 14px 14px`): the step rail, a `1px --border` divider
  (`margin: 12px 0`), the `you` block, the optional open questions.
- **Footer** (`padding: 8px 14px`, `border-t border-border`, right-aligned):
  **End mission…** (Button `ghost`, `flag` 14px) — the always-available end
  door (spec §3.5). It opens the end dialog.

**Step rail (`MissionStepRail.vue`).** One row per **counted** step (a legacy
fixed start is scope, not a step — it is not in the rail). Each row: a 16px
rail column + the body, `gap: 10px`, `padding-bottom: 16px` between rows, a
`2px --border-2` connector line from each glyph down to the next row. The rail
glyph is one of **seven visuals**, read from `progress.states` and
`progress.leftBehind` (a left-behind step is `todo` before the last done one):

| Visual        | Glyph                                                      | State / when             |
| ------------- | ---------------------------------------------------------- | ------------------------ |
| `verified`    | 12px `bg-green` disc + `check` 8px in `text-bg` (✓ filled) | `verified`               |
| `done`        | `circle-check` 12px, `text-text-3` (✓ hollow)              | `done`                   |
| `running`     | 8px `bg-accent` dot, `.anim-pulse-dot`                     | `running`                |
| `waiting`     | `contrast` 12px (◐), `text-text-3`                         | `waiting`                |
| `blocked`     | `triangle-alert` 12px, `text-warning` (⚠)                  | `blocked`                |
| `todo`        | 8px ring, `1.5px border-text-4`, transparent (○)           | `todo`                   |
| `left-behind` | `undo-2` 12px, `text-warning` (↩)                          | in `progress.leftBehind` |

The step carrying the **current marker** (positions `current.from`…`current.to`)
gets its label in `text-text` / 500 and `aria-current="step"`; its glyph keeps
its visual (a current `todo` or `waiting` step adds the `ring-3
ring-accent-soft` ring so the position reads at a glance). Labels `12.5px`:
done/verified `text-text-3`; current `text-text` / 500; left-behind
`text-text-2`; other future steps `text-text-4` at opacity `0.7`. Each glyph
carries a `title` naming its visual ("Verified", "Done, not verified",
"Running", "Waiting", "Blocked", "To do", "Left behind").

The current step's label row (`flex-wrap`, `gap: 6px`) carries the **Badge**
component's variants (§6 Badges, unchanged — no new variant): verification
level ("Existence check" / "Verifier" / "Human", Default), proof ("Claimed",
Default — `self-verified` renders the **same** Default "Claimed" look), "✓
Proven" (Success, `check` 10px) for a verified `verifier`/`human` step, "Added"
(Accent) for a step with `addedReason`, "Re-scope pending" (Warning) on the end
step while a re-scope is staged. Captions `11px`, `text-text-4`, `line-height:
1.5`, `margin-top: 3px`:

- the **end** step (`kind: 'fixed-end'`, never found by position) carries
  `End: {kind} · {target} · evidence: {evidence}`;
- a verified end step names who verified it (`Verified by {session} —
{verdict}`);
- an added step quotes its reason (`Added — reason: {addedReason}`).

**Checks** (spec §3.6) render on their step, under the captions
(`margin-top: 5px`, `gap: 3px`): one row per check — a 12px checkbox
(`accent-color: var(--color-accent)`), the label (`11.5px`, `text-text-2`;
ticked → `text-text-4 line-through`), a **"due"** word (`10.5px`,
`text-warning`) on an unticked check of a reached step (`done`, `verified`,
`running`, `waiting`), and an `x` 11px delete button (`text-text-4
hover:text-red`) revealed on row hover / focus. Ticking or unticking fires the
`tickCheck` door; delete fires `deleteCheck`. **"+ check"** sits at the end of the step's label row (`ml-auto`, `11px`,
`text-text-4 hover:text-text-2`, always shown on the current steps, revealed on
step-row hover / focus elsewhere — it never adds a line to the rail) and opens an inline input (`11.5px`, `h-6`,
`rounded-sm border border-border-2 bg-bg`, placeholder "What to check by hand")
— `Enter` fires `addCheck`, `Esc` cancels. A label the step already holds
(any case) is deduped by the server (`deduped: true`): nothing is added and no
duplicate row appears. Checks never change the step's visual or the headline.

**Callouts** (`padding: 6px 8px`, `rounded-sm`, `11px`, `line-height: 1.5`,
`border`, `margin-top: 5px`, 13px icon): Warning = `bg-warning-soft
text-warning border-warning-line`. Blocked (`triangle-alert`) — "**Blocked** —
{reason}. Unblocks when {unblocks} · {owner}" under the step that owns it
(mission-level blockers under the first current step). Stale (`clock`) —
"**Stale** — no evidence in {duration}." under the first current step.
Re-scope (`triangle-alert`) — "**End changed, awaiting approval.**" + `was:` /
`now:` lines under the end step.

**Child session rows** (a step's `session` links, from the derived
projection): `bg-surface-2`, `rounded-sm`, `padding: 4px 8px`, `margin: 5px 0 0
2px`, `gap: 6px`, `11.5px` — `corner-down-right` 11px `text-text-4`, a 6px
status dot reusing §6 Session status verbatim (`working` green +
`.anim-pulse-dot`, `needs-input` warning + `.anim-attention-dot`, anything else
static `bg-text-4`), the session label in `font-mono 11px text-text-2`
truncated, a short state word (`10.5px text-text-4`), and a **go-to-session**
icon button (`log-in` 12px, `text-text-4 hover:text-text-2`, label "Go to
session") that selects the session in-app. **A session row appears once**: on
the step where it is running, else on its last linked step. Every other step it
links shows "+{n} session(s)" (`11px`, `text-text-4`) instead. When the
renderer cannot resolve the session (not loaded in the sidebar yet), the
go-to-session action raises an info toast ("Session not loaded yet") instead of
doing nothing.

**The `you` block never hides.** Eyebrow "You" (`9.5px / 700`, uppercase,
`0.06em`). It shows the **first** item of the ordered `you` list (spec §3.12),
translated per kind — never the English string `mission_get` prints — and
"+{n} more" (`11px`, underline-on-hover text button) below it, which expands
the rest as a plain list. Three looks: **clear** (`text-text-4`, no box —
"Nothing — you're clear."), **warning** (`bg-warning-soft text-warning
border-warning-line`, `padding: 8px 10px`, `triangle-alert` 13px), **success**
(`bg-green-soft text-green border-green-line`, same padding, `check` 13px) —
success only when the first item is a requested close and the server returns
no `closeWarnings`. A requested close carries a **Close mission** button
(Success) that opens the end dialog preset to "Close as delivered"; a staged
re-scope carries **Approve re-scope** (Primary).

**Open questions** render only when non-empty: an eyebrow ("Open questions",
`10.5px / 500`, uppercase, `0.07em`, `text-text-4`) + a plain list (`11.5px`,
`text-text-3`, `line-height: 1.65`, `padding-left: 15px`).

**Operator doors — the only writes this UI makes.** The canonical `Button`
(`components/ui/Button.vue`, §6 Buttons, `md` size, no new size) — disabled
(`opacity-40`) while any door is in flight. The per-row controls (the
human-step tick, the check box, the check delete, "+ check") follow the §6
Form-controls rule's "per-row inline control inside a dense list item": **Mark
verified** is a button wearing the Badge **Accent** anatomy (`check` 10px) and
**Unmark** a bare `text-text-4` text link (`hover:text-text-2`), both `11px`.

| Door                   | Where                                     | Variant                 | Main-process function     |
| ---------------------- | ----------------------------------------- | ----------------------- | ------------------------- |
| Approve re-scope       | `you` block (warning)                     | Primary                 | `applyApprovedRescope`    |
| End mission            | popover footer / `you` close → end dialog | Ghost → dialog          | `applyOperatorEnd`        |
| Mark verified / Unmark | a `human`-level step's label row          | inline pill / text link | `applyOperatorVerifyStep` |
| Add check              | "+ check" on a step                       | inline input            | `applyAddCheck`           |
| Tick / untick check    | the check's checkbox                      | inline checkbox         | `applyTickCheck`          |
| Delete check           | the check row's `x` (hover)               | icon button             | `applyDeleteCheck`        |

No MCP verb reaches any of them. A refused door, or an IPC failure, raises a
danger toast with the reason ("Mission action refused").

**End dialog (`MissionCloseConfirmDialog.vue`, spec §3.5).** One dialog ends
any non-closed mission, with a choice. Ending is the one irreversible door
(`closed` has no way out — the mission leaves the Topbar and the sidebar), so
the popover's buttons only **open** it; `door: 'end'` fires from its confirm
and from nowhere else.

- **Anatomy:** the `Dialog` variant verbatim, as "Remove worktree" uses it —
  Teleport to `<body>`, z-60, backdrop `rgba(0,0,0,0.55)` + `.anim-overlay-fade`,
  card `bg-surface border-border-2`, radius 9px, `--shadow-pop`,
  `.anim-fade-in-scale`, width `min(440px, 90vw)`, focus trap
  (`useFocusTrap`). No new token, size or keyframe.
- **Header** (`padding: 14px 18px 10px`, `border-b border-border`): title "End
  this mission?" (`13.5px / 600`) + the `X` button.
- **Body** (`padding: 14px 18px`, `12.5px`, `text-text-2`, `line-height:
19px`): "**{title}** leaves the Topbar and the sidebar and can't be
  reopened. The mission file stays on disk as the record." Then the **choice**
  — two radio rows (`gap: 6px`, `margin-top: 10px`, each `rounded-sm border
border-border-2 padding: 7px 10px`, the selected one `border-accent-line
bg-accent-soft`): **Close as delivered** ("The work is done.") and
  **Discard** ("Drop it — dead, duplicated or abandoned."). Then **Reason
  (optional)** — a label (`11px`, `text-text-3`) + a 2-row textarea (`12px`,
  `rounded-sm border border-border-2 bg-bg`, `padding: 6px 8px`), written to
  the mission's Log. Then, when the server returned `closeWarnings`, a
  **warnings** callout (Warning callout look, `triangle-alert` 13px, eyebrow
  "Before you end it") listing each warning by kind ("The end is not verified", "N steps left behind",
  "N checks not ticked", "N blockers still open", "A re-scope is staged"; the
  counted headings are vue-i18n plurals, never "(s)") with the matters under it in
  `text-text-3`, one line each. A line names the **step by its title — never its
  id** ("Design review — DSQA done"): the server's `closeWarnings` decide which
  warnings show, the renderer builds the lines from the view's structured data
  (`endWarnings`). Warnings **never** disable or hide the confirm.
- **Footer** (`border-t border-border`, `padding: 12px 18px`, `gap: 8px`,
  right-aligned): **Cancel** (Button `ghost`) + the confirm — **Close as
  delivered** (Button `success`, `check` 14px) or **Discard** (Button `danger`,
  `trash-2` 14px), following the choice. **Initial focus is Cancel**: the
  dialog exists to stop a stray click or `Enter`. Everything is disabled while
  the door is in flight.
- **Exits:** Cancel, `X`, `Esc` and a backdrop click close the dialog and **do
  not end the mission**. The popover stays open behind it. Confirm runs the
  door; on success the store removes the mission at once from the door's
  `view: null` — the dialog, the popover, the pill and the sidebar chip go with
  it in the same tick. On a refusal or an IPC failure the dialog closes and a
  danger toast carries the reason — except `MISSION_CLOSED` on an end (a double
  Close, or the mission was ended elsewhere): the mission is closed as asked, so
  it is dropped silently, with no toast.
- **Sound + attention.** Opening the dialog plays the bundled chime
  (`playNotificationSound()`) and calls `window.api.requestAttention()` — the
  "Safety confirms — sound + attention" pair, independent of the Sound switch.
  Once per opening.

#### Sidebar indicator (`SidebarFolder.vue`)

The **last** (rightmost) entry of the session row's trailing chip cluster:
StopFailure → subagent count → orchestrator crown → teammate count → **mission
chip**. The compact headline (`{n}/{m}`, `{n}–{to}/{m}`, `{m}/{m} ✓`),
`10.5px`, `tabular-nums`, `gap: 3px`, colored with the **pill's tone** (the
same `text-*` class as the pill: `text-accent`, `text-warning`, `text-green`)
— the separate amber "flagged" variant is gone, so the chip and the pill can
never disagree. While the operator owes the mission anything (its `you` list is
non-empty), the chip is **pinned always visible** like the StopFailure
badge (it keeps the trailing scrim on); on the warning tone it also carries a
leading `triangle-alert` 10px (a delivered mission awaiting its close stays
green, pinned, without it). Otherwise it is hover-revealed like the subagent
chip (`chipRevealClass`). An `empty` headline renders no chip.

`title`/`aria-label` spell it out ("Mission: Step 8 of 9 — needs you").
Non-interactive: the popover is reached from the Topbar pill.

**Don't**

- ❌ Recount progress in the renderer — no "done" rule, no current-step search,
  no left-behind rule outside `mission-progress.ts`.
- ❌ Print a count of finished steps as the headline ("8 of 10 done") — the
  headline is a position.
- ❌ Render `self-verified` (or `claimed`) as "Proven", anywhere.
- ❌ Give the UI a write path other than the doors above.
- ❌ Fire the end door without the end dialog, or hide its confirm behind a
  warning.
- ❌ Show a draft state, an Approve button or an approval callout.
- ❌ Show the mission's stored `status: 'stale'` — there is none; stale is derived.

### Dialog

- Backdrop: `rgba(0,0,0,0.55)`, full-screen, click outside = close
- Card: width `min(560px, 90vw)`, background `--surface`, border `--border-2`, radius 9px
- Header: padding `14px 18px 10px`, border-bottom, contains title + close button
- Body: padding `14px 18px`
- Footer: padding `10px 14px`, border-top, background `#0f0f12` (slightly darker), buttons right-aligned

### Settings dialog

Variant of `Dialog` (same backdrop/card/header anatomy above). Opened via the
**gear** button in the sidebar footer (`ui.openDialog('settings')`). Reuses
**exclusively existing tokens** — introduces no new color, radius, easing, or
size. v1 exposes a **single** setting: the terminal font size
(`8`–`32` px, default `13`), applied globally to the main terminal and to the
helper/split panes.

The card has a **fixed size derived from the window** (width `min(92vw, 940px)`, height
`min(80vh, 720px)` — see §4 → Layout dimensions): constant for a given window
size, so switching tabs or searching **doesn't resize** the dialog (the nav and
pane scroll independently; a short tab leaves empty space at the end of the pane, a tall tab scrolls).

**Nav — vertical sidebar on the left (with search).** The dialog is **tabbed**, but
navigation is a **vertical column on the left** (`shrink-0`, width `190px`,
`border-r --border`) between the header and the full-width footer; the tab content
occupies the right column (`flex-1`, scrollable). So the sidebar wouldn't squeeze the
content, the card was widened to `min(92vw, 940px)`.

- **Search** at the top of the sidebar: a text `<input>` (the **Inputs** §6 frame —
  `bg --bg`, `border --border` → focus `--accent-line`, radius `5px`, Inter 12px,
  with a lucide `Search` icon `13px` `--text-4` as prefix). The search **indexes the
  settings themselves**, not just the tab names. Matches by _substring_
  (case-insensitive, trimmed) against the **localized label** + a **keyword
  list** (en+pt intent hints — e.g. "sound"/"font"/"theme"/"trust" —
  internal, not i18n), for both settings and tabs.
  - **Empty search** = the normal vertical tab list (unchanged).
  - **Active search** = the list becomes a flat **results list** with two
    row types: (1) **setting matches** — the setting's label + a `--text-4` subtitle
    with the owning tab's name; clicking switches to that tab (`activeTab`), scrolls to the
    setting's **anchor** (`id="set-…"` on the row wrapper, `scrollIntoView({block:
'nearest'})` inside the content pane) and **flashes** the row; and (2) **tab matches** —
    the tab whose label/keywords match, clicking just switches tabs. No match → the
    `--text-4` "No results" row.
  - **Flash (jump target):** when jumping to a setting, its wrapper gets the
    `.anim-setting-flash` helper class (in `main.css`) — an `--accent-soft` fill
    - `inset --accent-line` ring that **decays to transparent** over ~1.2s
      (`--dur-slow`/`--ease`, `both`). A `highlightedAnchor` ref drives the flash and a
      timeout clears it (allowing a re-trigger). No new token/color.
  - **v1 scope:** only settings that live **directly** on the dialog's own tabs
    (General → Interface language / Interface scale / Font size / Session state
    hooks / statusLine / OS notifications / Sound; Appearance → Theme; Interceptor →
    Hook responder mode / Trust all folders / Review shadow log) have an anchor. Fields
    inside sub-panes
    (Claude Boot / Claude config / Endpoints / MCP) appear only as a **tab
    match** (via keywords), not as a setting result. Search resets on every open.
- **Tabs** (`General`, `Interceptor`, `Appearance`, `Startup`, `Claude config`,
  `Endpoints`, `MCP`, `Memory`, `Usage history`, `Changelog`, `Claude Code`): each is a
  full-width row (Inter 12.5px/500, `padding 8px 12px`, `text-left`) with a
  **2px accent bar on the left** (`border-l-2`): active = `border-l --accent`
  - `bg-surface-2` + `text --text`; inactive = `border-l-transparent` + `--text-3`
    → hover `--text-2` + `bg-surface-2`. Always opens on `General`. **No
    new token** — reuses `--accent`, `--surface-2`, and the text tokens.

- **General:** the remaining settings (Interface — UI language + scale —,
  Terminal, Integrations — Session state hooks/statusLine/OS notifications/Sound —,
  Intelligence, Sidebar, Storage).
  - **Interface → Language**: UI language selector (System default / English /
    Português (Brasil)) — segmented control with the same anatomy as the section's
    other toggles. `System default` clears the override and goes back to following
    the system language; the other options persist to `om2tab.locale` and switch the
    locale **live**. No new token.
  - **Interface → Interface scale**: `Minus`/`Plus` stepper
    (**same anatomy as Terminal → Font size** — 28×28 buttons, radius `5px`,
    `border --border`/`bg --surface`, lucide icons `13px`; central value
    `font-mono tabular-nums`) showing the scale as a **percentage** (`80%`–`150%`,
    default `100%`), with the hint "Scales the typography and icons across the whole app.". The
    stepper moves through discrete steps `[0.8, 0.9, 1.0, 1.1, 1.25, 1.5]`; the ends
    disable `Minus`/`Plus`. Behavior: applies `webFrame.setZoomFactor` to the
    whole frame — scales px typography, icons (`:size` px), layout, **and the
    terminal** together (`terminalFontSize` still handles the terminal's relative
    fine-tuning). Persisted in `settings.json` (`uiZoom`, clamped `0.5`–`2` as a safety
    net) alongside `terminalFontSize`. **No new §9 token** — reuses the
    existing stepper.
- **Interceptor:** the **Hook responder** moved out of General — the off/shadow/active
  mode selector + the trust ramp panel (see "Hook responder — interceptor mode"
  and "Trust ramp — `active` panel" above). The Hook Bridge switch itself
  (Session state hooks) stays in General → Integrations.
- **Startup:** the **Claude Boot** form (global scope) — see "### Claude Boot (Startup)" below.
- **Claude config:** GUI editor for the global `~/.claude/settings.json` — see "### Claude config (settings.json)" below.
- **Endpoints:** the **global** registry of Anthropic-compatible custom endpoints (`EndpointsPane.vue`)
  — see "### Endpoints (registry)" below.
- **Mods:** read-only audit of the mods a session can load and what each can do
  (`ModsAuditPane.vue`, T389) — placed directly after **Skills** — see
  "### Mods (Settings → Mods, T389)" below.
- **Memory:** the **global default location** for project memory (`MemoryLocationPane.vue`, T89)
  — `in-project` (default) or a **central root** outside the repo — see "### Memory (Settings → Memory)" below.
- **Changelog:** renders the root `CHANGELOG.md` (pure parser `changelog-parse.ts`,
  bundled into the renderer via `?raw`) — releases by date (`## YYYY-MM-DD`, eyebrow
  `--text-3` UPPERCASE 11px), categories (`--text-2` 12px/600), and items with a `·` bullet
  (`--text-3` 12px). It's the source of truth required by `CLAUDE.md`'s **"Changelog is
  mandatory"** contract (every feature/fix adds a dated entry).
- **Claude Code:** list of Claude Code CLI releases — one heading per version (`X.Y.Z`,
  `--text-2` 12.5px/500), change bullets (`--text-3` 12px). An unread marker
  (accent dot via §5 "Novelty dot") is attached to the `settings` icon whenever there are
  releases newer than the last version marked read. "View official changelog" link (external,
  `--accent` 12px) and a Refresh button (ghost, `12.5px`). Opening the tab automatically marks
  all releases as read (clears the dot on the sidebar's `settings` icon).

- Backdrop + card: identical to `Dialog` (backdrop `rgba(0,0,0,0.55)` `z-index: 60`
  `.anim-overlay-fade`; card `min(92vw, 940px)`, `--surface`, border `--border-2`,
  radius 9px, shadow `--shadow-pop`, `.anim-fade-in-scale`). Focus trap + Esc +
  click-outside close it. The footer is **contextual**: by default it has only **Close**, but on the
  **Claude config** tab with unsaved edits it gains **Discard** (ghost,
  `--text-2`) + **Save** (`--accent`/`--accent-ink`) to the left of Close — Save
  disables while saving (`Saving…`). Other tabs keep only **Close**.
- **Section eyebrow** ("INTERFACE", "TERMINAL", "INTEGRATIONS", "SIDEBAR",
  "STORAGE"): Inter 11px/500 UPPERCASE, letter-spacing `0.06em`, color `--text-3`
  (same style as the `AddFolderDialog` eyebrows).
- **"INTERFACE" block (UI language, T68):** the first section of the General
  tab. A single flex row — "Language"/"Idioma" label on the left (`--text-2` 12px),
  `SegmentedControl` on the right with three options: `System default` / `English` /
  `Português (Brasil)`. `System default` removes the override and goes back to following
  `navigator.language`; the other options pin the locale. Applied **live** and
  persisted to `localStorage` `om2tab.locale` (the same one `detectInitialLocale`
  honors at boot). `English`/`Português (Brasil)` are proper names — identical
  in both locales. No new token.
- **Font size row:** flex row — label on the left (`--text-2`, 12px), stepper on the
  right. Stepper = `[ − ]` button, the number (`font-mono tabular-nums`, `--text`,
  fixed min-width so it doesn't shift), `[ + ]` button. The `−`/`+` buttons use the bordered
  ghost button (`border --border`, `bg-surface` → hover `bg-surface-2`, ~28px square,
  radius `5px`), lucide icons `Minus`/`Plus` 13px. `−` disables at MIN,
  `+` at MAX (opacity `0.4` + `cursor-not-allowed`).
- **"SIDEBAR" block (folder-first model, spec §7):** reuses the same eyebrow +
  section anatomy (no new tokens). Flex rows (label on the left
  `--text-2` 12px, button group on the right):
  - **Sort folders by:** two segment buttons (`Recent activity` / `Name`),
    same anatomy as the others (bordered ghost, `height 28px`, `padding 5px 10px`,
    `12px`, radius `5px`; active `border --accent-line` + `text --accent`),
    **above** "Sort sessions by". Default `Recent activity` (preserves the legacy
    activity-based order). `Name` sorts **folders** A→Z stably, so a folder
    stops jumping to the top when a background session emits output
    (folder-sort spec §6). Governs the _order of folders_ in each zone; orthogonal to
    "Sort sessions by" (which orders sessions within a folder).
  - **Sort sessions by:** three segment buttons (`Attention` / `Recent activity` /
    `Name`) — bordered ghost button, `height 28px`, `padding 5px 10px`, `12px`,
    radius `5px`; the active one uses `border --accent-line` + `text --accent` (same
    treatment as the hooks toggle). Default `Attention`.
  - **Show sessions within:** four preset segment buttons (`All` / `24h` /
    `48h` / `7d`), same anatomy, **above** "Active-elsewhere window".
    Default `48h`. Filters **sessions within each folder** by age (mtime);
    `All` turns off the filter. Independent of "Active-elsewhere window" (which governs
    the _folder_, not the sessions). No free-form ms input.
  - **Active-elsewhere window:** three preset segment buttons (`24h` / `48h` /
    `7d`), same anatomy. Default `48h`. No free-form ms input.
- **"INTELLIGENCE" block (haiku-service-autoname spec):** same eyebrow + section
  anatomy. An "Auto-name new sessions" switch (default **OFF**) that has Haiku
  name a "+ New session" session from the first prompt. Persisted to
  `localStorage` (`om2tab.haikuAutoname`). The generated title enters the rows/Topbar
  **session name** (§"Session name") — `summary` (custom/ai-title) ›
  `aiSummary.title` (Harnu's Haiku) › `firstPrompt` › the surface's fallback —
  never overwriting a `/rename`.
  A 2nd switch, **"Live session pulse"** (default **OFF**, `localStorage`
  `om2tab.livePulse`), has Haiku generate a ≤8-word "doing now" line
  per session, updated on every turn (Stop/work). The text appears as a line with a
  `Sparkles` icon in the **hover preview** (§3.9) and — when on — as a **subtitle**
  `--text-4` 10.5px on the row (2nd line; rows without a pulse stay at 28px). It's a **subtitle**,
  never the label. Pausable per-folder from the folder's context menu. No new token.
- **Path display (STORAGE):** `font-mono`, 11px, `--text-4`, `truncate`, full
  path in `title`/`aria-label`.
- **Action buttons (Reveal / Change location… / Edit raw JSON):** bordered ghost
  button (`border --border`, `bg-surface text-text` → hover `bg-surface-2`,
  padding `7px 14px`, 12.5px, radius `5px`). Trigger `reveal()`,
  `changeLocation()`, and `openInEditor()` on the settings store.

### Claude config (settings.json)

**Claude config** tab (`ClaudeConfigPane.vue`) — GUI editor for the **global**
`~/.claude/settings.json` (issue #16). Reuses **exclusively existing tokens** (no new
color/radius/easing). Read-first structure: reading is safe; writing goes through the
hardened write layer (`claude-settings.ts`: atomic `tmp`+`rename`, per-path lock,
empty-read guard, pre-write backup, and a **surgical patch** that only touches changed
keys and preserves order + unknown keys — it never re-serializes the whole object from
the editor's state).

- **Scope note** (`--text-3` 12px) + file **path** (`font-mono` 11px `--text-4`,
  `truncate`, full path in `title`): v1 only edits the global file and says so.
- **Guard banner** (`--red-soft`, `triangle-alert` icon `--warning`): when the file
  exists but doesn't parse, editing is **disabled** (read-only) — degrades safely,
  never clobbers.
- **Groups** (`General`, `Permissions`, `Interface`) with the same eyebrow as the other sections
  (Inter 11px/500 UPPERCASE `0.06em` `--text-3`). Each row: label (`--text-2` 12px) +
  `external-link` icon 11px (docs), description (`--text-4` 11px), and the **Set/Default
  marker** (`--text-4` 10.5px; "Set" in `--accent` when there's a value; otherwise "Default: …").
  Controls on the right by type:
  - **toggle:** 34×20px pill switch (`bg-accent` on / `bg-surface-2` off, border
    `--border-2`, knob `--accent-ink`/`--text-3`).
  - **select:** bordered `<select>` (`border --border`, `bg-surface`, radius `5px`, 12px).
  - **number / text:** bordered input (same anatomy; number in `font-mono`).
  - **reset:** `rotate-ccw` icon 13px `--text-4` → hover `--text-2`, disabled (opacity
    `0.3`) when the option isn't "Set". Reverts the key to its default (delete via `UNSET`).
- **Advanced (raw):** on-disk keys **not covered** by a catalog control, in read-only
  mode (`<pre>` `font-mono` 11px `--text-4` over `--surface-2`), preserved intact on
  save. Covers both unknown top-level keys and **orphaned sub-keys** of a partially
  covered object — e.g. the control edits `permissions.defaultMode`, but
  `permissions.allow`/`deny`/`ask` still show up here read-only (otherwise they'd vanish from the UI;
  a safety valve against a stale catalog). `hooks`/`statusLine` are managed
  by Harnu's installers and appear only as a note — never editable here.
- **Save bar** (sticky at the body's footer, `border-top --border`, `bg-surface`): only appears
  when there's a pending edit. **Discard** (ghost text) + **Save** (`bg-accent` `--accent-ink`,
  radius `5px`). One toggle = a one-key diff.

### Claude Boot (Startup)

Form for **`claude` startup options** — controls the flags passed when a session
starts. Today boot only passes what the app manages (`--resume
<uuid>` / `--fork-session`); this screen adds user flags on top.

**Three scopes, one form.** `ClaudeBootForm.vue` is **scope-agnostic** (prop
`scope: 'global' | 'folder' | 'session'`); only the copy changes (neutral = "Default" on
global, "Inherit" on folder/session). The cascade is **global → folder → session**
(merge `global ⊕ folder ⊕ session`, the rightmost layer wins when set;
boolean `false` explicitly turns off an earlier layer's `true`).

**Merge semantics — scalar replaces, additive accumulates.** Most fields
are **scalar**: the lowest layer that sets the value wins (model, effort,
permission-mode, `--system-prompt`, boolean flags…). But fields with **additive**
semantics **accumulate** along the chain instead of replacing (T57 #1):
**append system prompt** and **pre-prompt** are **concatenated** (`global + \n---\n +
folder + \n---\n + session` — the inherited text is never discarded when you write
your own), and **lists** (`--add-dir`, `--allowedTools`, `--disallowedTools`,
`--mcp-config`) are **unioned** (dedup, order preserved). This kills the footgun where
setting an append-system-prompt at the folder level would silently erase the global one. Three
entry points:

- **Global** — **Startup** tab of the Settings dialog. Persisted in
  `<userData>/claude-boot.json` → `global`.
- **Per-folder** — `ClaudeBootDialog.vue` (a `Dialog` variant, z-60, peer of the
  other dialogs via `ui.dialog === 'claudeBoot'` + `ui.claudeBootPath`), opened
  from the **"Startup options…"** item in `FolderMenu`. Persisted in
  `claude-boot.json` → `folders[<normalized path>]`. Empty fields **inherit** the
  global.
- **Per-session** — `NewSessionDialog.vue` (see "### New session dialog"). One-shot,
  **not persisted**: it travels on the synthetic session → `ptyCreate({ bootOverride })` →
  the main process merges it on top of global + folder in `resolveClaudeBootArgs`.

**Anatomy.** Sections with eyebrow (same style as Settings': `--text-3` 11px
UPPERCASE `0.06em`): **Provider** · Model & effort · Integrations · Context & prompt · Tools ·
MCP · Session · Advanced · **Danger zone**. Controls, **only existing tokens**:

- **Provider (`provider`):** pill picker (same anatomy as the selects) with the
  neutral option **"Anthropic (default)"** (= absence of `provider`) + one pill per
  saved endpoint (`server` icon 11px + name) + a ghost pill **"Manage
  endpoints…"** that opens `Settings → Endpoints`. Override/inherited/idle follow the
  same treatment as the other selects. The `provider` is a **reference** to a
  global `EndpointProfile.id`; it does **not** become a CLI flag — the main process resolves it into
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` / auth and injects it into the spawn env (D4).
  When a provider ≠ Anthropic is **effective** (override OR inherited), the **Model**
  field becomes a **free-text input** (`font-mono`) instead of alias pills — the
  `opus`/`sonnet`/`haiku`/`fable` aliases don't map to a local id (D5) — and a
  `--text-warning` note reminds that the local model is a resilience fallback, not
  quality equivalent to Opus (D6).

- **Tri-state boolean** (segmented, 3 buttons `Inherit/Default · On · Off`): bordered
  26px pill. Three visual states: **override** (chosen here) =
  `border-accent-line` + `text-accent`; **inherited** (no override, the pill that
  matches the inherited value) = `border-accent-line` + `text-text-2` (border lights up,
  text stays neutral — distinguishes it from a local choice); **idle** = `border-border` +
  `text-text-3`. The neutral pill (`Inherit/Default`) only lights up when **nothing** is
  effective (no override and no inheritance). The neutral state writes `undefined`; `Off`
  writes `false`. The 3rd button (`Off`) only appears for negatable flags (`--no-chrome`)
  or in the `folder`/`session` scope (to turn off a level above).
- **Select** (`model`, `effort`, `permission-mode`): wrapping pills, values in `font-mono`
  (CLI tokens, untranslated) + neutral option.
- **Text / textarea / list:** input `border --border` `bg-bg` → focus
  `border-accent-line`; list = textarea, **one item per line**.
- **Danger zone:** eyebrow + label in `--text-red`, hint in `--text-warning`; the
  active `On` button becomes `border-red` + `text-red`. Covers
  `--dangerously-skip-permissions`.
- **Escape hatch (`extraArgs`):** free mono input; a `--text-warning` warning +
  `triangle-alert` icon lists flags that will be **ignored** (the session-breaking
  denylist — `--resume`, `--print`, `--session-id`, … — blocked in the main process by
  `claude-args.ts`, the source of truth).

**Visible inheritance (live).** The form receives an `inherited` prop = the resolved
config from the levels above, **always read by the main process** via `claudeConfig:getResolved` (single
source — the folder dialog asks for `getResolved(undefined)` = global only; the session one
asks for `getResolved(<path>)` = `global ⊕ folder`; T57 #2). On a field **not overridden**
at this level, the inherited value appears as **effective**: in select/boolean, the
**inherited value's own pill lights up** ("inherited" style, accent border + neutral
text — the neutral `Inherit` stays dim); in text/list, the placeholder shows
`{value} (inherited)`. This way the user **sees** what they inherit (e.g. global's `haiku` lit
up at the folder level) without it being written at this level — storage remains just the
level's **delta**. Inheritance is **live**: changing the global afterward reflects onto
whoever didn't override, **even with the dialog open** (the `inherited` prop re-resolves reactively,
T57 #4). Editing a level **never** writes to the level above.

On **additive** fields (append-system-prompt, pre-prompt, and the lists — see
"Merge semantics" above) an inherited placeholder would be misleading ("looks like it
replaces"), so besides it a **persistent note** (`--text-3` 11px, below the
input) says the value at this level is **added** to the inherited one, not replacing it —
visible even after the user starts typing (when the placeholder disappears).

**Model routing (T97 — folder scope only).** Below the Claude Boot form, its own
section (same eyebrow style, `border-t --border` above) hosts the **per-repo model
routing table**: one row per `kind` (`scout`/`bug`/`feature`/
`review`/`chore`, `font-mono` text — technical name, untranslated, same treatment
as the kind chip on the card) + a **Default** row (fallback when the card doesn't declare a
`kind`), each with two `SegmentedControl` `size="sm"` (**Model**: `opus`/`sonnet`/
`haiku`/`fable`; **Effort**: `low`/`medium`/`high`/`xhigh`/`max` — same catalogs as the
Claude Boot form). The neutral pill (`allow-default`, label "Inherit") leaves the row **without
override** — the kind row's `inherited-value` shows the **operator's hardcoded default**
(`scout=haiku·low`, `bug/feature/chore=sonnet·high`, `review=opus·high`)
lit as "inherited", matching the inheritance pattern of the form above; the **Default** row
has no single natural inherited value (stays unhighlighted when neutral). Debounce
250ms → write-through in `routing-policy.json` (its OWN file, separate from
`claude-boot.json` — never the same storage surface as the rest of Claude Boot).
**Deliberately no agent verb** — this table exists only to be read/written by
this editor + by the Roadmap board's dispatch resolution (§6 above, "Model·effort
routing").

**Behavior contract:** the flags apply **only to new sessions** (Claude reads them at
spawn); open sessions don't change. The argv is assembled in the main process (`buildClaudeArgs`),
never in the renderer. The per-folder dialog's footer has **Clear overrides** (clears
the folder) + **Close**.

### Endpoints (registry)

`EndpointsPane.vue` — **Endpoints** tab of the Settings dialog. The **global
registry** of Anthropic-compatible custom endpoints (e.g. a local model in LM Studio
at `http://127.0.0.1:1234`). It's the **only** surface that _defines_ endpoints; the
Provider pickers (Startup / per-folder / per-session) only _reference_ them by `id`
(D2/D3). Motivation: resilience fallback for when the Anthropic API goes down — a
session pointed at `localhost` never touches Anthropic.

- **Intro** (`--text-4` 11px) explaining the fallback purpose.
- **Saved endpoints:** one card per endpoint (`border --border`, `bg-bg`, radius 7px,
  padding 12px). Header with `server` icon + name + `trash-2` button (ghost → hover
  `--text-red`). Fields in a 2-col grid, editable inline (debounce 250ms → write-through):
  **Name**, **Default model** (`font-mono`), **Base URL** (`font-mono`, full-width),
  **Auth token** (`type=password`, full-width — plaintext on disk, fine for localhost
  with no key, O-4).
- **Add an endpoint:** same card with the 4 fields empty + `--accent`/`--accent-ink`
  button **"Add endpoint"** (`plus` icon), disabled until there's a Base URL.
- Persisted in `claude-boot.json` (bump to **`version: 2`**, new `endpoints: []` array;
  in-memory migration from v1). **No new token, no SQLite** (D7).

### Control server (MCP)

Dedicated **MCP** tab of the Settings dialog (`McpServerPane.vue`) — a peer of the
other tabs via `ui.dialog === 'settings'` + `activeTab === 'mcp'` (enters the `tabs`
array right after **Endpoints**, in the configuration cluster). Exposes the **MCP
control server** on loopback (`127.0.0.1`) that lets a Claude agent **see the fleet**
and **act on it**. Reuses **exclusively existing tokens** (no new
color/radius/easing). **On by default** (`ON`).

**Free by default (security posture).** Agents act in **every** folder, and their
mutations **do not raise a confirm**. There is no allowlist and no containment
boundary. This is a deliberate reversal of the original fail-closed model — the old
per-folder gate stranded work (an agent created a session, then could not read it)
while buying little, since an agent could pin folders itself. The **audit log**
(below) is the accountability surface that replaces the per-action confirm.

Two verbs still **always** face the operator: **`submit_manifest`** (the dispatch
go-door — the verb IS the approval request) and **`plan_mission`** (it mints a
grant).

**The three opt-outs** — all of them live in this pane, and the folder block is
mirrored in the Folder context menu:

1. **Ask before agent actions** (`mcpServer.ask`) — global, **default OFF**. Puts the
   fail-CLOSED Allow/Deny confirm back in front of **every** mutating verb (and
   re-arms the containment/`PATH_ESCAPE` check). This is the mode the confirm
   overlay, the mission grants, and the "always allow this verb here" checkbox all
   exist for.
2. **Block a folder** (`agentDenied`) — refuses every verb in that folder **and its
   subtree**. **Absolute**: no grant, no confirm, no discovery layer may promote it.
3. **The server kill switch** — denies everything, reads included.

When it fires, the confirm is **modal when the window is focused** and **parked in
the Approval Inbox when absent** — and it stays **fail-CLOSED** on an
actual non-response (the long `PARK_TTL`).

- **Eyebrow** "CONTROL SERVER" (Inter 11px/500 UPPERCASE, `letter-spacing 0.06em`,
  `--text-3` — same style as the other Settings eyebrows).
- **Toggle on/off:** same anatomy as the hooks/responder toggle — bordered ghost
  segment (`height 28px`, `padding 5px 10px`, `12px`, radius `5px`; active
  `border --accent-line` + `text --accent`). Label "Activate" / state "Off".
  A `description` line (`--text-4` 11px) explains the purpose and "Off
  by default".
- **Status (with the server on):** row with an **8px dot** + text. The dot
  follows the agent-connection state — **`--green`** when an agent is connected
  ("Agent connected"), **`--text-3`** when idle (server up, no agent). Static,
  **do not animate** (calm-tech, same precedent as the service-status dot). Text "Running on
  port {port}" (`--text-3` 11px, the number in `font-mono tabular-nums`). `MCP` / `port` /
  `token` remain **untranslated** (§8).
- **Endpoint + config (access):** for security the **bearer token does NOT cross into the
  renderer** — it lives `0600` in `harnu.mcp.json` and is auto-injected into the
  sessions Harnu itself opens (`mcpStatus()` returns only `{ enabled, port,
connected }`, never the secret, so the pane cannot reveal or copy the raw
  token). The pane instead shows the **loopback endpoint** (`127.0.0.1:{port}`,
  `font-mono tabular-nums` 11px `--text-4`) and a **"Copy config"** button (`copy`
  icon, bordered ghost `border --border`, `bg-surface` → hover `bg-surface-2`,
  `12.5px`, radius `5px`) that copies a ready-to-paste MCP-client block pointing
  at the endpoint. Fires the same clipboard `success` Toast (same precedent as the
  Session copy actions). (The `mcpServer.tokenLabel` / `mcpServer.copyToken` keys
  are reserved for when/if the token gets exposed via a dedicated IPC.)
- **Ask before agent actions** (`mcpServer.ask`): a **`ToggleSwitch`** in the server
  block (right below the endpoint/copy-config), **default OFF**. Label "Ask before
  agent actions" + a `SettingHint` that says plainly what OFF means (agents act
  freely; every call is in the audit log below) and what ON buys (a confirmation in
  front of every action). Writes the global `ask` pref (`mcpAskSet`), read live at
  every gate decision — no restart.
- **Per-folder block list** (`mcpServer.allowFolders`): sub-block titled "Folders the
  agent can act in", with a `SettingHint` stating the default ("Agents can act in
  every folder by default. Turn one off to block them there and in everything under
  it."). Lists **one row per pinned folder** (basename + path `font-mono` 11px
  `--text-4` `truncate`, full path in `title`) with a **`ToggleSwitch`** whose ON
  state means **reachable** (the default) — flipping it OFF writes the folder's
  `agentDenied` flag via `userProjectsSetAgentDenied`. **Same source** as the Folder
  context menu's "Block agent control" toggle (they mirror the same flag; changing it
  in one place reflects in the other). **Empty** (no folder pinned): "No folders yet —
  agents can act in every folder you add." (`--text-4`, no illustration).

  The switch reads as _allowed_ while the stored flag is _denied_ — deliberate: the
  row answers "can the agent act here?", which is the question the operator is
  actually asking, and ON-by-default matches the posture.

- **Worktree inheritance (T61 + T72): REMOVED.** The "Worktrees inherit agent
  control" toggle is gone, along with its i18n keys. It existed to derive a
  worktree's place on the **agent allowlist** from its parent repo's grant; with no
  allowlist, a worktree is reachable like any other folder and there is nothing to
  inherit — leaving the control would have been a switch that governs nothing. The
  T72 "discovery on friction" contextual confirm (`inheritDiscovery`) is likewise
  never raised: the only deny left is an explicit operator **block**, and promoting
  THAT to a confirm would put the denylist one click away from being undone. (The
  underlying plumbing — the birth marker, the registries, the confirm's
  `inheritScope` field — is retained but inert; see `plan-tool-call.ts`.)
- **Audit log** (`mcpServer.auditTitle`): title "Audit log" (`audit log` untranslated).
  Reverse-chronological list of audited tool calls — each row has the
  **tool** (`font-mono` 11px, untranslated), the folder (alias `--text-4` 11px) and a
  **verdict** colored via an existing token: `allow` → `text-green`, `deny` →
  `text-red`, with the `result`/reason (`--text-4` 10.5px, e.g. `CONFIRM_TIMEOUT`).
  Timestamps in `tabular-nums`. **Empty:** "No agent activity yet"
  (`--text-4`). Read-only (the source is `mcpGetAudit()`); no destructive action in v1.
- **Active missions** (`mcpServer.missions`, T44 S5): the operator's **visibility +
  kill-switch** over the **only path that auto-executes without a per-action confirm**. A
  _mission grant_ is a limited, revocable capability: with **one** Allow, agent actions
  matching its `verbs` in its `folders` run unattended until the
  `budget` runs out or the TTL expires; outside that scope, it goes back to parking in the Approval
  Inbox. Only appears with the **server on** (`status.enabled`). Eyebrow title
  "Active missions" (same style as the other eyebrows). Source:
  `mcpGrantsList()` + the `onMcpGrantsChanged` stream (via the `useMissionGrants` composable,
  the single source shared with the Approval Inbox strip). **One card-row per grant**
  (`border --border`, `bg-surface`, radius `6px`, `padding 8px 10px`):
  - **Goal** (`--text-2` 12px `truncate`, full path in `title`) on the top row,
    with the action to the right.
  - Muted row **folders · verbs** (`--text-4` 11px `truncate`) — comma-separated
    basenames + the grant's `verbs`. `verbs`/`grant`/`mission` **untranslated** (§8).
  - **Budget meter:** `bg-surface-2` track + `bg-accent` fill (same grammar as
    `UsageMeter` — `overflow-hidden rounded-full`, `height 3px`), width = `spent/budget`
    (clamped 0..100 via `clampPct`), followed by the `spent / budget` text (`tabular-nums`
    `--text-3` 11px).
  - **TTL:** "expires in {mins}m" (`--text-4` 11px `tabular-nums`), derived from a
    `now` ref ticked every ~30s (the registry also emits `changed` when the
    TTL expires, so the counter doesn't drift). Minutes = `ceil((expiresAt − now)/60000)`,
    floored at 0.
  - **Revoke** (only on a **live** grant): **destructive** button `bg-red-soft`/`text-red`
    (same anatomy as Deny/destructive item), hover `opacity 0.8`, radius `5px` →
    `mcpGrantsRevoke(id)` (optimistic; the broadcast reconciles).
  - **Dimmed state:** a non-live grant (revoked / expired / budget exhausted) has
    the whole row at `opacity-60`, swaps the Revoke button for a muted label
    `revoked` / `expired` (`--text-4`), and the TTL becomes the same label. Ordering:
    **live first** (soonest-expiry), then the dimmed ones.
  - **Empty:** "No active missions" (`--text-4`, left-aligned like the pane's other lists).

### Bundled skills (Settings → Skills)

Dedicated **Skills** tab of the Settings dialog (`BundledSkillsPane.vue`) — a peer of
the other tabs via `ui.dialog === 'settings'` + `activeTab === 'skills'`, entering the
`tabs` array right after **MCP**, in the configuration cluster. It lists the skills
Harnu ships (`resources/skills/`) with a per-skill on/off switch. **No new token, no new
component**: every control below already exists.

**Everything is OFF on a fresh install.** A skill silently added to a session's
catalog changes model behaviour without consent, so each one is a deliberate opt-in.

```
+---------------------------------------------------------------------+
| BUNDLED SKILLS                                    <- eyebrow         |
| Skills Harnu ships. All off by default - turn on what you want this   |
| project's sessions to be able to use.             <- SettingHint     |
| [ Global ][ my-repo ]                             <- SegmentedControl|
|                                                                      |
|  orchestrate-delivery                                     [ o--]     |
|  Decompose an objective into board cards, dispatch one Harnu...       |
|                                                                      |
|  delivery-verifier                                        [--o ]     |
|  Verify that a finished unit satisfies its acceptance criteria...    |
|  ! You already have a personal skill named delivery-verifier. Both   |
|    will be available - yours as delivery-verifier, Harnu's as         |
|    harnu:delivery-verifier.                                           |
|                                                                      |
| Changes apply to sessions started from now on.    <- SettingHint     |
| > ADVANCED                                                           |
+---------------------------------------------------------------------+
```

**Row shape** — the same shape as the MCP pane's per-folder list: one bordered
`--surface` row (`padding: 8px 10px`, `border-radius: 6px`, `gap: 4px` between rows),
label + secondary line on the left, the control on the right.

- **Skill name** — `font-mono` 12.5px, `--text`. It is a technical id the session sees
  verbatim, not a translated label (§8).
- **Purpose line** — **`SettingHint`** (`--text-3`, 11px, line-height 1.5), rendering
  the skill's `SKILL.md` `description` **verbatim**. It is model-facing trigger text
  and is deliberately NOT translated: one source of truth, so the panel can never
  describe a skill differently from what the session sees.
- **Collision hint** — `triangle-alert` 12px + 11px `--text-3` text, with the
  namespaced form (`harnu:<name>`) in `font-mono` `--text-4`. Shown when the operator
  already has a personal skill or command of that name. It is a **disclosure, never a
  suppression**: Harnu does not delete, rename, move or disable a user's own skill.
- **The switch** — **`ToggleSwitch`** (the canonical boolean control) under the Global
  scope.

**Scope switch** — a **`SegmentedControl`** at the top: **Global** / **the folder**.
"This project" acts on the folder owning the currently selected session; with nothing
selected that pill takes the **per-option disabled treatment** (opacity 0.4,
non-interactive — `SegOption.disabled`, the documented disabled treatment applied to a
single pill rather than the whole control, for a choice unavailable in the CURRENT
context) and a `SettingHint` says which selection it needs. Under a folder scope every
row switches to the tri-state form the component already supports (`allowDefault` → a
neutral **Default** pill meaning _unset / inherit_; `inheritedValue` → the inherited
option keeps an accent border only) — the same affordance Claude Boot uses for
global-vs-folder.

**Advanced** (collapsed by default, Global scope only) — a per-skill
**"Also outside Harnu"** `ToggleSwitch` that installs `~/.claude/skills/<name>/SKILL.md`
so the operator's own terminal sessions see it too. The exact path is shown under the
name in `font-mono` 11px `--text-4`. Default OFF. It lands **unnamespaced**, so it
competes by name with a personal skill — unlike the in-Harnu path, where both coexist.
A refusal (the folder exists and Harnu did not create it) surfaces as a `danger` toast.

**Restart notice** — a `SettingHint` under the list: _"Changes apply to sessions
started from now on."_ No toast: this is a standing property of the pane, not an event.

### Mods (Settings → Mods, T389)

Dedicated **Mods** tab of the Settings dialog (`ModsAuditPane.vue`), entering the `tabs`
array **directly after Skills**. A mod is a Claude Code plugin with a hooks module; it
runs unsandboxed inside `claude`. The pane lists every mod a session started in a
folder can load and says what each one's source **declares** it can do. **The list is a
disclosure, never a control and never a verdict**: it has no switch for anyone else's
mod, and no copy anywhere in it says a mod is safe, verified, trusted or approved. **No
new token, no new component**: `SegmentedControl`, `SettingHint`, the bordered
`--surface` row of the Skills and MCP panes, and the **Default** badge above.

```
+----------------------------------------------------------------------+
| MODS                                                   [ Refresh ]   |
| Mods run unsandboxed inside Claude Code. This list shows what each    |
| one can do, from a static read of its source.          <- SettingHint |
| [ Global ][ my-repo ]                             <- SegmentedControl |
| (#mods-companion: the Harnu mod switches; "Harnu mod outside Harnu")  |
|                                                                      |
|  harnu-companion                                   Harnu mod · 0.1.0 > |
|  (can use the network) (can decide permissions) (draws in the term…)  |
|                                                                      |
|  token-chart                                 installed · user    >    |
|  (can run processes) (can read every prompt)                          |
|  Changed since 28 Sep.                                                |
|                                                                      |
| 12 plugins without a mod are not listed.                              |
| Not shown: where data goes, which commands run, which files are       |
| read. To allow only your organization's mods, an administrator sets   |
| allowManagedModsOnly.                                  <- SettingHint |
+----------------------------------------------------------------------+
```

**Row shape** — the Skills pane's: one bordered `--surface` row (`padding: 8px 10px`,
`border-radius: 6px`, `gap: 4px` between rows). The whole header line is one button
(`aria-expanded`, hover `bg-surface-2`).

- **Name** — `font-mono` 12.5px, `--text`: the plugin's own `name`, verbatim and never
  translated. The Harnu mod is the row named `harnu-companion`, **row 1**, produced by
  the same code path as every other row: nothing about it is special-cased but its
  position and its source label.
- **Right side** — source label and version, 11px `--text-3` (`Harnu mod · 0.1.0`,
  `installed · user`, `skills folder`, `--plugin-dir`), then a chevron (`chevron-right`
  collapsed, `chevron-down` expanded, 12px).
- **Chips** — wrap under the name, `gap: 4px`. Every chip is the **Default** badge
  variant (`--surface` bg, `--text-3` text, `--border` border; `padding 2px 8px`,
  radius `999px`, 11px). **Colour would read as a verdict, so no chip is ever Accent,
  Warning or Danger.** A chip is a fact in the form "can …" ("can run processes", "can
  read every prompt"); the closed set and its source facts are in the spec table
  (15 chips). Order is fixed.
- **Status lines** (under the chips, 11px): `Analysing…` in `--text-4` while the read is
  pending; `Changed since {date}.` in `--text-3` when the content hash differs from the
  previous analysis; for a failed read, `triangle-alert` 12px + `--text-3` text and a
  **Retry** text button (`--text-2`, hover `--text`). Rows never blank each other: one
  failure leaves every other row's chips in place.
- **Expanded row** — hooks (event plus matcher), calls (with `via {helper}`), environment
  names read and written, state keys, notes the parser did not recognise **verbatim**,
  errors and warnings; all `font-mono` 11px `--text-2` under 11px `--text-3` captions. Then
  the folder path in `font-mono` 11px `--text-4`, `{hash8} · Last analysed {time}`, a
  **Reveal folder** action (Ghost button, 28px high — `showItemInFolder`) and one
  `SettingHint` naming the mechanism that **owns** the mod (`/plugin`, Settings → Skills,
  "remove its folder", the folder's startup arguments). The pane points at that mechanism;
  it never replaces it.

**Scope** — a **`SegmentedControl`**, the Skills pane's rule: **Global** / **the folder
of the selected session**; with nothing selected the folder pill takes the per-option
disabled treatment and a `SettingHint` says why. Global lists the Harnu mod, user-scope
installed plugins, `~/.claude/skills` and the settings `env` plugin directories; a folder
adds its own installed plugins, `.claude/skills`, staged skills and Claude Boot
`--plugin-dir` arguments.

**Settings region (`#mods-companion`)** — an element directly above the list, empty on a
build without the Harnu mod switches (it takes no space then). The Harnu mod's own
switches mount there; they are controls of Harnu's mod and never of anyone else's. Today
it holds one block, "Harnu mod outside Harnu" (next section).

### Harnu mod outside Harnu (T389)

The one switch of the settings region (`HarnuModExternal.vue`, mounted in `#mods-companion`):
it lets `claude` sessions started in the operator's **own terminal** load the Harnu mod too.
It is **not** the Skills tab's "Also outside Harnu" switch, which copies a `SKILL.md`; this
one adds one folder to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. Default
**off**. **No new token and no new component**: `ToggleSwitch`, `SettingHint`, the bordered
`--surface` row of the Skills Advanced block, the confirm-dialog anatomy of
`MissionCloseConfirmDialog` (Teleport, overlay-fade backdrop, fade-in-scale card, focus trap,
Esc and backdrop close), the canonical `Button`, and a `danger` toast for a refusal.

```
> ADVANCED
  Sessions you start in your own terminal can load the Harnu mod too. They
  report their state to Harnu on this machine. Harnu never starts prompts in
  them and does not hold their approvals.                       <- SettingHint
  +------------------------------------------------------------------+
  | Harnu mod outside Harnu                                     [ o--] |
  | ~/.claude/settings.json · env.CLAUDE_CODE_PLUGIN_DIRS            |
  +------------------------------------------------------------------+
  Last outside session seen: 2 min ago                          <- SettingHint
```

- **Block** — a collapsed **Advanced** button first (the Skills pane's eyebrow button:
  `chevron-right` / `chevron-down` 12px, 11px / 500 uppercase `--text-3`, `gap: 5px`). Opened,
  one `SettingHint`, then one bordered `--surface` row (`padding: 8px 10px`, radius 6px): the
  label in `--text-2` 12px, the settings path in `font-mono` 11px `--text-4` (verbatim, never
  translated), the `ToggleSwitch` on the right. Under the row one `SettingHint`:
  `Last outside session seen: {time}` or `No outside session has reported yet.`
- **The switch is the key.** It reads **on** only while the entry is in the file: a user who
  removes the path by hand sees it **off** on the next read. It is disabled (the toggle's
  per-option disabled treatment) while the Harnu mod itself is off, with the one hint
  `The Harnu mod is off. Turn it on first.`
- **Turning it on** opens the confirm dialog, always, every time: nothing is written before
  **Turn on**; **Cancel** and Esc leave everything untouched. Initial focus is **Cancel**.
  The dialog is the disclosure and names: the file that changes, that every `claude` session
  started in any terminal is affected, that it runs unsandboxed and talks only to Harnu on this
  machine, and that turning the switch off removes exactly that entry. The path of the entry
  is shown in `font-mono` 11px `--text-3`. The confirm button is the **default** variant
  (never `danger`, never `success`: it is an opt-in, not a verdict).
- **Turning it off** needs no dialog; it undoes exactly what was written.
- **A refusal** is a `danger` toast with one sentence and nothing else (`harnuMod.external.refused.*`),
  and the switch stays where it was. When the undo cannot run because the file no longer
  parses, the toast adds `To remove it by hand, delete {path} from CLAUDE_CODE_PLUGIN_DIRS.`
- **Wording** (§8): a managed cause is named only when a managed settings file was found
  (`Blocked by your organization's policy.`); when only the probe shows mods are off the
  sentence is the neutral `Turned off by a setting or by your organization's policy.` No
  workaround is ever offered on a managed machine.
- **Sidebar** — no chip, no marker. An outside session with a corroborated live binding
  simply has real state: its dot and the "Active elsewhere" zone follow turn events instead of
  the registry guess. The Harnu mod line of the hover preview gains the suffix below.

**Banners and hints** — the same pattern as the Skills collision hint: `triangle-alert`
12px + 11px `--text-3` text, no fill, no colour. Policy off (`Turned off by a setting or
by your organization's policy.`; it names no cause, because the probe shows that mods are
off, not why), a folder started with `--safe-mode` or `--bare`, installed plugins that
could not be read, a CLI that cannot analyse mods, and **CLI not found** (no rows, nothing
spawned). The pane states its blind spots in place, in the footer: no destinations, no
arguments, no paths, a static read only, and not what a running session actually loaded.
A skills-folder mod carries one more line, "Harnu cannot tell whether this one is allowed
to load", because its approval state is not readable from outside.

**Plugins without a mod** are not rows: one count line under the list ("{n} plugins
without a mod are not listed."). **No toast** on refresh; the standing state is the page.

### Memory (Settings → Memory)

Settings dialog tab (`MemoryLocationPane.vue`, T89) that defines **where** Harnu
stores project memory. Reuses **exclusively** existing tokens (eyebrows,
`SegmentedControl`, `SettingHint`, inputs, accent/ghost buttons) — no new
color/radius/easing.

- **Intro** (`--text-3` 11px): explains the two modes and that overrides live only in
  Harnu's config, never in the repo (the privacy goal).
- **Eyebrow "DEFAULT LOCATION"** (Inter 11px/500 UPPERCASE `--text-3`) + a flex
  row: label "Store memory" (`--text-2` 12px) on the left, `SegmentedControl` `size=sm`
  on the right with **two** options — **In the project** (default, `<repo>/.harnu/memory/`) and
  **Central folder** (a root outside the repo). Below, a `SettingHint` whose
  text swaps depending on the mode.
- **Central mode:** reveals a block with label "Central root" + a `font-mono` `<input>`
  (Inputs frame §6) and a ghost **Choose…** button (`folder-open` icon 13px) that opens
  the native directory picker (`dialogOpenDirectory`). The path is validated in the main process
  (absolute + directory exists) before persisting; invalid → `--red-soft` box
  with `triangle-alert` icon (`text-warning`).
- **Save** (accent button, 28px) persists the global default. Central storage
  layout (collision-proof, a lesson from T88's "two `www` repos"):
  `<root>/<repo-name>--<hash8(main-checkout-path)>/` with the **same internal
  layout** as `.harnu/memory/` (hot.md, decisions.md, roadmap/, sessions/, archive/) +
  a `where.md` backlink to the source project.
- **Assisted migration (never orphaned):** when you **switch** the default, a
  ghost card "Move existing memories" appears with a button that **moves the memory of every
  known project** (dedup by checkout; projects with their own override are skipped) to the new
  location — fs move + verify + report (`{moved}`/`{skipped}`). No `window.confirm`.

### New session dialog

`NewSessionDialog.vue` — `Dialog` variant (z-60, peer via `ui.dialog ===
'newSession'` + `ui.newSessionPath`). Clicking **"+ New session"** in the sidebar opens
this modal **instead of** firing the session directly. Anatomy:

- **Header:** title `New session` + folder basename (mono `--text-4`), `X` button.
- **Body (collapsed by default):** an intro line (`Start a new Claude session
in {folder}.`, `--text-3`) + an **"Advanced — launch options" disclosure** (ghost,
  `chevron-right` icon that rotates 90° on open — reuses the sidebar's expand-chevron
  idiom). Expanded, it reveals the `ClaudeBootForm` (`scope="session"`) in a
  scrollable area; the modal grows up to `max-height: 84vh`.
- **Footer:** **Cancel** (ghost) + **Start session** (`--accent`/`--accent-ink` button,
  **default-focused** → Enter starts it). Backdrop / Esc / Cancel = no session created.

On start: `createNewSession(folderPath, config)` attaches the `config` as a
one-shot `bootOverride` on the synthetic; the rest of the spawn flow is identical. Other
"new session" entry points (⌘N / palette) remain instant for now.

### Remove worktree

`RemoveWorktreeDialog.vue` — **destructive** `Dialog` variant (z-60, peer via
`ui.dialog === 'removeWorktree'` + `ui.removeWorktreeTarget` = `{ path, branch }`).
Same backdrop/card/header/footer anatomy as `Dialog` (backdrop
`rgba(0,0,0,0.55)`, card `--surface`/`--border-2`, radius 9px). **Reuses
exclusively existing tokens** — no new color, radius, or size.

- **Trigger:** **destructive** item `Remove worktree` (`trash-2` icon) in the
  `FolderMenu` — the only red item (`--red`, hover bg `--red-soft`,
  design.md §6 → Destructive item), in its own block (separator above). Only
  appears for a **linked** worktree (`repoId` present **and**
  `isMainWorktree !== true`); the main worktree is the repo itself and is never offered
  for removal.
- **Header:** title `Remove worktree` + `X` button.
- **Body:**
  - Confirmation sentence naming the worktree's basename (bold, `--text`) and the
    `branch` (mono `--text-2` chip).
  - Toggle **`Also delete branch {branch}`** (`ToggleSwitch`, **default OFF**) — the
    canonical boolean control, never a homemade checkbox.
  - **Force** (`ToggleSwitch`, default OFF) + the blocking message stay
    **hidden until a blocked attempt**: the backend guard refuses a
    worktree with uncommitted changes / unpushed commits, and only then does the app
    reveal a `--red-soft`/`--red` block explaining the risk and the `Force
remove (discards uncommitted / unpushed work)` toggle with a `--red` label.
- **Footer:** **Cancel** (ghost) + **destructive** button `Remove` — Danger variant
  (`bg-red-soft`/`text-red`, hover `opacity-80`, `trash-2` icon), **never**
  `--accent`. Backdrop / Esc / Cancel = doesn't remove.

On confirm: `window.api.worktreeRemove({ repoPath, worktreePath, force,
deleteBranch })` with `repoPath === worktreePath === target.path` (git resolves the
shared common-dir from the worktree itself). Success → `success` toast
`Worktree removed` + closes. A guard error (`uncommitted`/`unpushed`) without force
reveals the Force disclosure; any other error becomes a `danger` toast `Couldn't
remove worktree`. **UI-only** channel — never exposed to an MCP agent.

### New worktree

`NewWorktreeDialog.vue` — **non-destructive** `Dialog` variant (z-60, peer via
`ui.dialog === 'newWorktree'` + `ui.newWorktreePath` = the repo/folder path).
Same backdrop/card/header/footer anatomy as `Dialog` (backdrop
`rgba(0,0,0,0.55)`, card `--surface`/`--border-2`, radius 9px, `--shadow-pop`,
`.anim-overlay-fade` + `.anim-fade-in-scale`). **Reuses exclusively existing tokens
and motion helpers** — no new color, radius, size, or keyframe.

- **Trigger:** item `New worktree…` (`git-branch` icon, with an ellipsis → opens a
  dialog, non-destructive) in the `FolderMenu`, in its own block (separator above),
  right after `Startup options…`. Only appears for a **git folder** (`repoId`
  present **or** `gitBranch` non-empty) — any worktree of the repo can spawn
  siblings. Not the red item (that's `Remove worktree`).
- **Header:** title `New worktree` + target folder basename (mono `--text-4`),
  `X` button.
- **Body — Phase A (form + preview, default):**
  - **Mode** (`<SegmentedControl>` `size="sm"`, UPPERCASE eyebrow `--text-3`
    `Mode`): **New branch** (default) vs **Existing branch**. Chooses between creating a
    new branch or **checking out an existing branch** (the `ref` param of
    `create_worktree`, T44 S2 — the PR-review flow). Reuses the canonical
    component (selected `--accent-soft` pill), no new token.
  - **New branch** (default): **Branch** `<input>` (autofocus, UPPERCASE eyebrow
    `--text-3`, Enter fires the create when the plan is valid) + **Base ref
    (optional)** — a `<BranchCombobox>` (`ui/BranchCombobox.vue`), a searchable
    single-select over the repo's branches. The closed trigger reuses the same
    tokens the `<select>` it replaced used (`border-border`, `bg-bg`,
    `focus:border-accent-line`, height 32px, radius 5px, 13px); opening it
    reveals a floating panel (`border-border-2`/`bg-surface`, radius 7px,
    `--shadow-pop`, teleported to escape the dialog body's own scroll
    clipping — same idiom as `SessionMenu`) with an auto-focused search input
    on top that filters the list live (case-insensitive substring on branch
    name), followed by the same **Local**/**Remote** grouping as before.
    Populated on open via `worktreeBranches({ repoPath })`, default value =
    empty (base = HEAD); the remote `origin/HEAD` is discarded. No new
    color/radius/shadow token — a component variant over existing tokens,
    like the `<select>` it replaces.
  - **Slugify strip** (New branch mode only): the real input is a ticket title
    pasted from an issue tracker (`ACME-10996 Report Export Date Range
Filter`), which is not a valid branch name. When the typed value differs from
    its slug, a compact strip appears **directly below the Branch input**
    (`border-border`/`bg-bg`, radius 5px, padding `8px 10px`, `margin-top: 8px`
    — the same box tokens as the Target/Base/Mode preview below it), holding a
    `sparkles` icon (13px, `--accent`), the suggested name (mono 11.5px
    `--text-2`, truncated — it must never widen the dialog), and a ghost
    **Apply** button (`--accent`, 11.5px) that rewrites the input. It is
    **absent** for an already-clean name and **vanishes after Apply** (the slug
    is idempotent) — zero always-on chrome, same calm-tech idiom as the
    `RETURN HERE` zone. Below it, an **options disclosure** (ghost button, 11.5px
    `--text-2`, `chevron-right` rotated 90° on open — the same idiom as the
    Setup commands disclosure) reveals three controls: **Prefix** (`<input>`,
    same tokens as the Branch input), **slugify prefix** and **preserve case**
    checkboxes. The three are **preferences, not form state** — persisted to
    `localStorage` (`om2tab.worktreeSlugify`) and untouched by the dialog's
    reset. No new token, motion helper, or component.
  - **Existing branch**: a single **Branch to check out** `<BranchCombobox>`
    (same component, same tokens as Base ref) + a `--text-4` line explaining
    the flow (checking out an existing branch, e.g. reviewing a PR; the
    worktree gets the branch's name). **No name field** — the worktree
    directory is derived from the chosen branch (`branch === ref`). Sends
    `ref` (and no `baseRef`) to `worktreePlan`/`worktreeCreate`; the preview
    shows the real mode (`existing-branch`, or `detached` when the branch is
    already checked out in another worktree — it then detaches on commit).
    Because the trigger is a button rather than a native select, Enter on a
    _closed_ trigger opens the panel instead of submitting the create; inside
    the open panel, arrow keys move a highlighted row, Enter picks it, and
    Esc closes the panel without closing the dialog.
  - Both fields are **debounced (~350ms)** into `worktreePlan({ repoPath,
branch, baseRef })` — a **read-only dry-run that never throws** (a monotonic
    sequence discards stale responses). Empty branch → no call, no
    preview, **Create disabled**.
  - **Preview** (compact block `border-border`/`bg-bg` with `Target` / `Base` /
    `Mode`): the box is **always visible in Phase A** (it doesn't spring from the `plan`) — before
    the dry-run resolves, the values fall back to placeholders (`Target`/`Mode` = `—`, `Base`
    = the current selection/`HEAD`) in `--text-4`, and turn `--text-2` (`--text-4` keys,
    mono values) once there's a valid preview. This way typing the branch **doesn't materialize
    the box nor push the footer** (no layout shift). The validation error becomes a
    **band above** the box (the box stays put). The `new-branch`/`delegated-create`/`existing-branch`/`detached`
    mode becomes a friendly label. **Seed** line
    (`copy: … · link: …`, omitted if both are empty). **Setup commands disclosure**
    (ghost button with a `chevron-right` chevron that rotates 90° on open —
    reuses the `NewSessionDialog`'s idiom): lists the `commands` verbatim in a
    mono `bg-surface-2` box + a `--warning` warning reusing the copy
    `agentConfirm.commandsWarning` ("These run in a shell with your full access…"),
    only when `commands.length`. Manifest **warnings** as `--warning` lines, only
    when `warnings.length`.
  - **Agent control inheritance: never shown.** `worktreeInheritOffer(…)` now
    always resolves `false`, so the inherit checkbox never renders. There is no
    allowlist for a worktree to be excluded from — it is agent-reachable on birth like
    any other folder — so offering the choice would be a lie (the worktree is reachable
    whichever way the box is ticked). The branch is kept in the component (it costs
    nothing and a guarded mode could re-derive worktree scope), but the offer seam is
    hard-`false`.
  - **Validation error** (`'error' in plan`): `--red`/`--red-soft` block with a
    message localized by type (`target-exists` / `branch-checked-out` /
    `no-commits` / `unsafe-target` / `invalid-request`). **Create disabled**.
  - **Create worktree** button (`--accent`/`--accent-ink`, `git-branch` icon):
    enabled only when the current plan is a valid preview (not error, not
    loading, non-empty branch).
- **Body — Phase B (progress stepper, after Create):** the body swaps **in the same
  card** for a vertical list of stages `Resolve plan → Create worktree →
Seed files → Run setup → Adopt into Harnu`. Per-stage indicator, **no new
  token**: `pending` = dimmed `--text-4` dot; `running` = `--accent` dot
  with `.anim-shimmer-dot`; `done` = check (`check`, `--green`); `failed` = `x`
  (`--red`). Driven by `onWorktreeProgress(id, ev)` (marks `ev.stage` as
  running, earlier stages as done); the terminal event `{ stage:'adopt',
done:true }` marks everything done.
- **Footer:** Phase A → **Cancel** (ghost) + **Create worktree**. Phase B running →
  **disabled** `--accent` button `Creating…` (no canceling mid-run — there's no
  abort; Esc / backdrop / X stay inert while `creating`). Phase B with a failure →
  **Cancel** (closes) + **Back** (returns to Phase A with the inputs preserved).

On create: `worktreeCreate({ repoPath, branch, baseRef, ref, id })` (`ref` present
only in Existing-branch mode; id via `crypto.randomUUID()`, paired with the progress
subscription). **Rejects** on
failure — the engine already rolled back (no partial worktree), so the app marks the
current stage as `failed`, shows `e.message` verbatim inline + a `danger` toast
`Couldn't create worktree` and **keeps the dialog open**. Success → `success` toast
`Worktree created` + closes (the engine emits `folders:adopted`, the store
groups the new worktree on its own). The subscription is **always** torn down when the
create settles (success or failure) and on close/unmount. **UI-only** channel.

### New folder

`NewFolderDialog.vue` — **non-destructive** `Dialog` variant (z-60, peer via
`ui.dialog === 'newFolder'` + `ui.folderActionPath` = the parent folder). Same
backdrop/card/header/footer anatomy as `Dialog` (backdrop `rgba(0,0,0,0.55)`, card
`--surface`/`--border-2`, radius 9px, `--shadow-pop`, `.anim-overlay-fade` +
`.anim-fade-in-scale`). **Existing tokens/motion only** — nothing new.

- **Trigger:** item `New folder…` (`folder-plus` icon) in `FolderMenu`.
- **Header:** title `New folder` + parent folder basename (mono `--text-4`), `X` button.
- **Body:** a **Name** `<input>` (autofocus, UPPERCASE eyebrow `--text-3`, same
  tokens as `AddFolderDialog`'s input: `border-border`, `bg-bg`,
  `focus:border-accent-line`, height 32px, radius 5px, 13px). Below, a
  **path preview** line (mono `--text-4`) = `<parent-folder>/<name>`. An empty name, one with a
  path separator, or containing `..` → **Create disabled** (`--red` band
  above the input when the name is invalid).
- **Footer:** **Cancel** (ghost) + **Create folder** (`--accent`/`--accent-ink`,
  `folder-plus` icon), enabled only with a valid name. Enter fires the create.

On create: `foldersCreateSubfolder({ parentPath, name })` (recursive mkdir in the main process,
validates containment inside the parent folder) → `pinFolder(createdPath)` (which already probes git,
T70A → groups under the repo). Success → `success` toast + closes. Failure (invalid
name, already exists, permission) → `danger` toast with the verbatim message, keeps the
dialog open. **UI-only** channel.

### Open subfolder

`OpenSubfolderDialog.vue` — **non-destructive** `Dialog` variant (z-60, peer via
`ui.dialog === 'openSubfolder'` + `ui.folderActionPath` = the root folder). Same
`Dialog` anatomy. A **searchable picker**, in the Command palette's idiom.

- **Trigger:** item `Open subfolder…` (`folder-search` icon) in `FolderMenu`.
- **Header:** title `Open subfolder` + root folder basename (mono `--text-4`),
  `X` button.
- **Body — two modes** (T73; the search input at the top decides which, same tokens
  as the sidebar's search input):
  - **No search → lazy tree.** Only the root's **direct children** load on open
    (`foldersListChildFolders({ dirPath })` — **one level**, same ignore-list
    `node_modules`/`.git`/`vendor`/`dist`/`target` + dot-dirs). Each node with subfolders
    (`hasChildren`) shows a **chevron** `chevron-right` on the left (rotates 90°
    when open, `--dur-fast`/`--ease`; mirrors the sidebar's folder row);
    clicking it **expands/collapses** and reads THAT level on demand — the real repo no
    longer dumps the entire deep BFS at once. A leaf-node row (no children)
    gets a spacer the size of the chevron to align. Row anatomy: indentation
    (`depth × 14px`) + chevron/spacer + `folder` icon (`--text-4`) + **segment
    name** (`--text-2`, mono, `truncate`).
  - **With search → flat index.** On the 1st character the deep recursive index loads
    **lazily** (`foldersListSubfolders({ rootPath })` — depth ≤4, same
    ignore-list) and is filtered by relative-path substring; each row shows the
    **relative path** indented (no chevron). This is T69's behavior, now confined
    to search-mode.
  - **Keyboard navigation:** ↑/↓ moves the cursor (wraps); **→** expands the node (or enters
    the 1st child), **←** collapses (or goes up to the parent) — tree mode only; `Enter` opens the
    selected row. Hover/focus = `bg-surface-2`.
  - **States:** loading (root or search index) = muted line; empty (no
    subfolders) or no search matches = muted line. **Caps:** tree level capped
    (1000/level) and search index capped (2000 total); the muted footer warns when
    truncated (count on search; generic note on tree).
- **Footer:** **Cancel** (ghost) + **Open** (`--accent`, `folder` icon), enabled
  only with a row selected. Clicking/Enter on a row also confirms.

On choosing: `pinFolder(absolutePath)` (probes git, T70A) → closes. An already-pinned
subfolder just selects (idempotent via `addUserProject`). **UI-only** channel.

### Rename folder

`RenameFolderDialog.vue` — **non-destructive** `Dialog` variant (z-60, peer via
`ui.dialog === 'renameFolder'` + `ui.folderActionPath`). Same `Dialog` anatomy;
same input tokens as `AddFolderDialog`. **Existing tokens only.**

- **Trigger:** item `Rename…` (`pencil-line` icon) in `FolderMenu`.
- **Header:** title `Rename folder` + folder basename (mono `--text-4`), `X` button.
- **Body:** a **Name** `<input>` (autofocus, text pre-filled with the current alias
  and **selected** for typing over), UPPERCASE eyebrow `--text-3`. Muted hint
  below: clearing the field **resets** to the basename. Enter confirms; Esc cancels.
- **Footer:** **Reset name** (ghost, `rotate-ccw` icon, only when there's a custom alias) +
  **Cancel** (ghost) + **Save** (`--accent`/`--accent-ink`). Save/Enter →
  `renameFolder(path, name)`; Reset → `renameFolder(path, '')` (reverts to basename).

Persisted via `userProjectsSetAlias` (creates the pinned record if the folder was
auto-discovered; empty alias → basename), the store re-hydrates and `mergeFolders` applies it.
**UI-only** channel.

### Rename repo

`RenameRepoDialog.vue` — twin of `RenameFolderDialog` (renames the repo **group**,
not a folder): **non-destructive** `Dialog` variant (z-60, peer via
`ui.dialog === 'renameRepo'` + `ui.renameRepoTarget = { repoId, derivedLabel }`).
Same anatomy/tokens as `RenameFolderDialog`. **Existing tokens only.**

- **Trigger:** item `Rename repo` (`pencil-line` icon) in the `RepoGroupHeader`'s
  context-menu.
- **Body:** a **Name** `<input>` (autofocus, pre-filled with the current alias or the
  `derivedLabel`, selected for typing over), UPPERCASE eyebrow `--text-3`.
  Muted hint: clearing the field **resets** to the derived basename.
- **Footer:** **Reset name** (ghost, `rotate-ccw`, only when there's a custom alias) +
  **Cancel** (ghost) + **Save** (`--accent`/`--accent-ink`). Save/Enter →
  `setRepoAlias(repoId, name)`; Reset → `setRepoAlias(repoId, '')`.

Persisted in `localStorage` (`om2tab.repoAliases`, per-repoId) — **renderer-only**, no
`projects.json`. **UI-only** channel.

### Hover preview — interactive card (§3.9)

`SessionPreview.vue` and `FolderPreview.vue` are the SAME card contract: floating
**z-40**, anchored to the row's rect via `useHoverPreview` (400ms open delay),
sideways flip when it overflows to the right **with horizontal AND vertical clamping
against the viewport** (flipping sides isn't enough when NEITHER side has the
full `360px` — narrow window — hence the final clamp: without it the card could
render off-screen, with no visible padding), `.anim-fade-in`, `max-width
360px`. They share the store's `PreviewState` (`sessionId` **or**
`folderPath`) and the same mutex — never overlapping palette/dialog/menu/inbox.

**The card is INTERACTIVE (T86 — changes the old contract).** Before, the card was
`pointer-events: none` to never steal the mouse (otherwise `mouseleave` on the row → closes →
cursor goes back to the row → reopens = flicker loop). After T79-S3 the card carries
scrollable content (the `hot.md` "where we left off"), so "can't reach it with the
mouse" defeats the feature. The new contract (GitHub/Wikipedia hovercard pattern):

- **`pointer-events: auto`** on the card — you can move the mouse onto it and scroll.
- **Row + card = ONE hover zone.** Stays open while the mouse is over the row
  **or** the card. The card does `cancelClose` on `mouseenter` and `scheduleClose` on
  `mouseleave`; the row does `enter`/`enterFolder` (opens) and `leave` (schedules the close).
- **~200ms grace delay** on leave: closing is SCHEDULED, not immediate, so
  crossing the 8px GAP between the row and the card doesn't close it under the cursor. **It's the
  grace delay — not `pointer-events: none` — that kills the flicker loop.** The
  close timer is **module-level** in `useHoverPreview` (shared between the row and the
  card, which are separate instances of the composable).
- **Scrollable body:** `overflow-y: auto` + `max-height` (bounded by the viewport
  from the anchored top, in `anchorStyle`) + **`overscroll-behavior: contain`** so
  the wheel scrolls the card without chaining scroll into the sidebar's list underneath.
- Since the card is `<Teleport to="body">` (outside the sidebar's subtree) and stays on top
  (z-40), clicking it **does not** select the row underneath.

The z-40 layering stays untouched; the anchor logic gained the horizontal clamp
above (bugfix, not a contract change).

**`SessionPreview` content — transcript truth.** Three data points now come from
the transcript JSONL itself (no longer just from the statusLine):

- **ctx%** in the `cost · context · lines` line (and in the `nearCompact ≥ 90`
  trigger) **prefers** `session.ctxPct` computed from the JSONL (the assistant's latest
  `usage` over the model's window, reset on `/compact`); falls back to the statusLine
  only when absent. Since the session row stopped showing context % (see "Context % and
  relative time (hover preview, not in the sidebar)" above), the hover is the **single
  source** — the number reuses the same tiered color-banding the row had (`contextTextClass`:
  `--text-4` < 80, `--accent` 80–95, `--red` ≥ 95), instead of staying always
  `--text-3` like the rest of the `cost · context · lines` line.
- **Body = "what's happening right now"** (`whatsHappening`): `task-summary` →
  `last-prompt` → the user's first message (used to be just `firstPrompt`).
- **"While you were away" recap** (the CLI's `away_summary`, verbatim): an optional block
  with a left border `--accent-line` over `--accent-soft`, `--text-4` 10px
  uppercase label (`preview.awayLabel`) + `--text-2` 12px body. Only appears when the transcript
  brought the recap. Uses existing tokens — no new color/radius/spacing.

**Harnu mod line (T389 P1W4).** One line right after the boot-mode line: `font-mono`
`--text-4` 11px, `margin-bottom: 6px`, the same anatomy as the mode line. It reads **Harnu
mod: live**, **Harnu mod: off** or **Harnu mod: legacy — {reason}** (`harnuMod.state.*`,
`harnuMod.reason.*`); `live`, `off` and `legacy` stay untranslated state nouns. It is absent
when the state is `null` (a parked or shell row, an outside session that is not corroborated
yet, a spawn still inside its 15 s grace). A corroborated outside session reads **Harnu mod:
live · outside Harnu** (`harnuMod.state.live` + `harnuMod.state.outside`, joined by `·`). `legacy` is the same quiet `--text-4` as the rest of the line: never
`--warning`, never `--red`, no icon. The line states a fact and never implies protection.

**Footer: messages · agents.** `--text-4` `11px` mono, `tabular-nums`: message count
(`preview.messages`) and, when the session has subagents (`session.agents`),
`· {{ $t('agent.count', { n }) }}` in sequence — same wording as the row's `bot` chip
tooltip (§6 "Session rows"). The row keeps the `bot` chip + chevron (it's also a
**control**, expands the inline subagent list — not pure data), but the plain
**count**, with no control at all, also lives here: the hover is where the operator
confirms "how many subagents did this session spawn" without having to open the row. No new
icon — plain text, like the rest of the footer.

### Folder preview (hover card)

`FolderPreview.vue` — **mirrors** `SessionPreview` under the interactive contract §3.9:
floating **z-40**, `pointer-events: auto` (hoverable/scrollable card, T86), anchored
to the row's rect via `useHoverPreview.enterFolder` (400ms delay), sideways flip when
it overflows to the right with horizontal and vertical viewport clamping, `.anim-fade-in`,
`max-width 360px`. Shares the store's `PreviewState` (now `sessionId` **or**
`folderPath`) and the same mutex — never overlapping palette/dialog/menu/inbox. Reads
`ui.preview.folderPath`.

**Cheap/free fields (always, no new git call):** displayed alias (`displayAlias`),
`path` (mono `--text-4`, `truncate`), `gitBranch` (`git-branch` icon; `detached`/`—`
when absent), **main worktree** vs **worktree** chip (from `isMainWorktree`), session
count, and last activity (`folderActivity` → `relativeTime`).

**Expensive fields (T52 Slice 3, hover-triggered):** dirty count (`git status --porcelain`)

- ahead/behind (`rev-list --left-right --count @{upstream}...HEAD`), via
  `foldersGitStatus(path)` — **its own probe, throttled/cached 5s, outside** `git-probe.ts`'s
  hot `rev-parse`. Shows the cheap fields **right away** and the expensive ones with a "…"/skeleton
  until resolved; failure (not a repo, no upstream) **omits** the fields, never breaks the
  card. `dirty` in `--warning` when > 0; ahead/behind in `--text-3` (`↑n ↓n`).

**Hot cue (T79 S3 — "where we left off" in 1s):** below the session count, separated by
a `border-t --border` (`margin-top 8px`, `padding-top 8px`), a block with an **eyebrow**
(`memoryLabel` — "Where we left off", 10px UPPERCASE `--text-4` letter-spacing `0.04em`) +
the **top of that folder's repo `hot.md`**, rendered via `MarkdownRenderer` (the
first ~6 content lines, trimmed by `extractHotPreview` in the pure core — without the
`# ` title, the scaffold guidance, or the `> provenance:` stamp). Rendered in
full inside the scrollable card (T86 §3.9) — **no internal clamp/mask**; the wheel
scrolls the card. Read via the `useMemoryStore` **cache** (dedup + TTL over the confined
`memory:read` IPC) — **outside** the sidebar's hot path, same discipline as the expensive git status;
**omitted** when the repo has no memory yet (or the read is denied). The card is now
interactive, but the hot cue's prose stays inert (its links don't navigate).

### Command palette

Dialog variant. **Highest surface** — overlaps any other (including
modal). Opened via `⌘K` (Cmd+K / Ctrl+K).

- Backdrop: `rgba(0,0,0,0.55)`, full-screen, click outside = close
- Card: width `min(560px, 90vw)`, **`margin-top: 12vh`** (anchored near the top, not vertical-centered), background `--surface`, border `--border-2`, radius `7px`, shadow `--shadow-pop`
- Animation: backdrop `.anim-overlay-fade`, card `.anim-fade-in-scale`
- Input row: padding `12px 16px`, border-bottom `1px --border`, Search icon 13px on the left, borderless `<input>` (`bg-transparent text-text outline-none`, Inter 14px), autofocus on mount
- Results list: vertical scroll, `max-height: 60vh`, vertical padding `4px`
- Section eyebrow: `padding 6px 16px 4px`, Inter 10.5px 500 UPPERCASE letter-spacing `0.06em`, color `--text-4`
- Item row: `padding 8px 16px`, `gap 12px`, color `--text-2`, hover `bg-surface-2 text-text`
- Selected item (keyboard cursor): `bg-accent-soft text-text`, `2px --accent` bar on the left, `padding-left: 14px` to compensate
- Empty state: `--text-4` 12.5px text, padding `20px 16px`, center-aligned
- Sections (in order): **Recents** (top 3 sessions by mtime desc, only with empty input) → **Actions** → **Folders** → **Sessions**
- Filter: fuse.js, `threshold: 0.4`, key `label`. Sessions use their name (§"Session name", fallback: the session id) as the label
- Internal shortcuts: `↑/↓` moves the cursor; `Enter` activates; `Esc` closes; typing filters

### Cloud session panel

Shown in place of the terminal when the selected session is **cloud/bridge with no
a resumable local transcript** (`resumable === false`; see §6 Session status →
**cloud**). Avoids firing a doomed `claude --resume` (which would return
"No conversation found …" and end the PTY).

- Container: vertical+horizontal centered in the right panel (`--bg`), same as the Empty state.
- `cloud` icon 28px `--text-4`, `margin-bottom: 14px`.
- Title: the session's name (§"Session name"), Inter 15px 500, `--text-2`.
- Body: 1–2 lines `--text-4` 12.5px, centered, `max-width: 420px` — explains that the conversation lives on claude.ai and there's no local transcript to resume.
- No clickable actions in v1 (informational). Copy via i18n (`cloudSession.*`).

### Floating surfaces (z-order)

Floating surfaces are anchored via `<Teleport to="body">`
in `App.vue` and coordinated by the `ui` store with a **mutex** (one at a time). The
stacking order is fixed — the higher the `z-index`, the higher priority
the surface:

| Surface              | Component                  | `z-index` | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hover preview        | `SessionPreview.vue`       | 40        | `pointer-events: auto` — interactive/scrollable card (T86 §3.9); row+card hover zone with grace delay                                                                                                                                                                                                                                                                                                                                      |
| Hover preview        | `FolderPreview.vue`        | 40        | Folder card. Peer of `SessionPreview` — they share the `ui.preview` slot (a `sessionId` **or** a `folderPath`); `pointer-events: auto` (T86 §3.9)                                                                                                                                                                                                                                                                                          |
| Context menu         | `SessionMenu.vue`          | 50        | Suppresses preview on open                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Split menu           | `SplitMenu.vue`            | 50        | Mutex via `useUiStore.splitMenu`. Dropdown anchored to the Topbar's Split button. Peer of `SessionMenu` — never open simultaneously                                                                                                                                                                                                                                                                                                        |
| Footer fleet popover | `StatusFooter.vue`         | 50        | Anchored above-right of the footer; closes on click-outside / `Esc`. Peer of the menus — not modal                                                                                                                                                                                                                                                                                                                                         |
| Sidebar jump palette | `SidebarJumpPalette.vue`   | 50        | T288. Peer of the menus in the `ui` mutex (`ui.sidebarJumpPalette`), but the ONLY surface here NOT `<Teleport>`ed to `<body>`: it is `position: absolute` inside the sidebar `<aside>` so it tracks the sidebar's width and clipping. Not modal — closes on Esc / click-outside / the Search button                                                                                                                                        |
| Dialog (modal)       | `AddFolderDialog.vue`      | 60        | Suppresses menu + preview                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Dialog (modal)       | `SettingsDialog.vue`       | 60        | Peer of `AddFolderDialog` — they share the dialog slot (z-60) via the `ui.dialog` mutex; only one dialog open at a time                                                                                                                                                                                                                                                                                                                    |
| Dialog (modal)       | `ClaudeBootDialog.vue`     | 60        | Per-folder Claude Boot. Peer of the dialogs via `ui.dialog === 'claudeBoot'` (+ `ui.claudeBootPath`); opened from `FolderMenu`                                                                                                                                                                                                                                                                                                             |
| Dialog (modal)       | `NewSessionDialog.vue`     | 60        | Launch-options before creating a session. Peer via `ui.dialog === 'newSession'` (+ `ui.newSessionPath`); opened from "+ New session"                                                                                                                                                                                                                                                                                                       |
| Dialog (modal)       | `RemoveWorktreeDialog.vue` | 60        | **Destructive** worktree-removal confirmation. Peer via `ui.dialog === 'removeWorktree'` (+ `ui.removeWorktreeTarget`); opened from the `FolderMenu`'s destructive item (linked worktree only)                                                                                                                                                                                                                                             |
| Dialog (modal)       | `NewWorktreeDialog.vue`    | 60        | **Non-destructive** worktree plan + creation (dry-run preview → progress stepper in the same card). Peer via `ui.dialog === 'newWorktree'` (+ `ui.newWorktreePath`); opened from the `FolderMenu`'s `New worktree…` item (git folder only)                                                                                                                                                                                                 |
| Dialog (modal)       | `NewFolderDialog.vue`      | 60        | Creates + pins a subfolder **non-destructively**. Peer via `ui.dialog === 'newFolder'` (+ `ui.folderActionPath`); opened from the `FolderMenu`'s `New folder…` item                                                                                                                                                                                                                                                                        |
| Dialog (modal)       | `OpenSubfolderDialog.vue`  | 60        | Searchable subfolder picker (recursive, depth-capped) → pins the chosen one. Peer via `ui.dialog === 'openSubfolder'` (+ `ui.folderActionPath`); opened from the `FolderMenu`'s `Open subfolder…` item                                                                                                                                                                                                                                     |
| Dialog (modal)       | `RenameFolderDialog.vue`   | 60        | Renames a folder's alias. Peer via `ui.dialog === 'renameFolder'` (+ `ui.folderActionPath`); opened from the `FolderMenu`'s `Rename…` item                                                                                                                                                                                                                                                                                                 |
| Image lightbox       | `ImageLightbox.vue`        | 60        | Full-viewport viewer for one pasted screenshot. State is **local to `StatusFooter.vue`** (not the `ui`-store mutex — a single entry point: a tile in the footer's images popover). While open it owns `Esc` + outside-clicks; closing it also closes the footer popover behind it                                                                                                                                                          |
| Dialog (modal)       | `RenameRepoDialog.vue`     | 60        | Renames a repo-group's alias. Peer via `ui.dialog === 'renameRepo'` (+ `ui.renameRepoTarget`); opened from the `RepoGroupHeader`'s context-menu `Rename repo` item                                                                                                                                                                                                                                                                         |
| Agent-action confirm | `McpConfirmOverlay.vue`    | 65        | **Fail-CLOSED** confirm for a mutation requested by an MCP agent (`onMcpConfirmPending`). **Auto-shows** from its own local state (doesn't enter the `ui` mutex — it's a security gate, can't be suppressed by another surface) and **doesn't close** on Esc / click-outside: the verdict-producing exits are Allow, Deny, or the timeout (denies) — **Dismiss** is a non-verdict exit, "not now". Reuses the Inbox rail's visual language |
| Command palette      | `CommandPalette.vue`       | **70**    | Suppresses dialog + menu + preview                                                                                                                                                                                                                                                                                                                                                                                                         |

Rule: when introducing a new floating surface, **add a row here
in the same commit**. Raw `z-index` in components (with no table entry) is a bug.
The rule cuts **both ways**: the Approval Inbox **left** this table in
T83 (it was `ApprovalInbox.vue`, z-65, `ui.inbox` mutex) because it stopped being an
overlay — it became the **Inbox rail**, a column (below). It's not a forgotten row.

### Inbox rail ("Fleet rail" — 4th column)

The whole fleet's approval queue **and** its live state, in one column. Two
things share this rail: the **tool calls the responder is holding** for you
to decide (only in the responder hook's `active` mode, §6 → "Hook
responder"), plus parked agent confirms and hot proposals — resolved
Allow/Deny **without switching tabs** — and, since T151, the **Fleet bucket
cards** (below): every non-idle session in the fleet, one glance, no click
required. `InboxRail.vue` is the same file, converted in place — the state
machine, summon behavior, width persistence, and overlay-mutex exclusion
below are unchanged from T83.

**Not an overlay — a column.** It used to be a modal (until T83), and the modal had a
fatal flaw: it required a **click to discover whether something was waiting for you**.
When supervising 4–5 agents, "is anything stuck?" needs to be answered by a
**glance**, not a gesture — a confirm parked behind a closed modal is, in
practice, an invisible confirm. That's why the rail is **persistent**, lives to the
right of the helper-stack, and **doesn't enter the floating-surfaces mutex**
(no dialog/menu/palette can suppress it; `Esc` doesn't close it; it never pushes
the `modal` keyboard scope — if it did, with the rail _always_ open, every
global shortcut would die).

- **Panel header (`expanded` state) and `minimized` ribbon button:** both
  **42px** tall — the same value as the Topbar/Sidebar (§4) — so the header's
  bottom border aligns with the Topbar's border across the window's full width,
  instead of forming a step. No new token: reuses the `Topbar | 42px` row already
  existing in §4.
- **States (3, persisted globally — §4):**
  - **`expanded`** (default): full panel, width `om2tab.inboxRailWidth`
    (clamp `[260,440]`, default `300`), with the same 6px handle as the sidebar
    (double-click resets).
  - **`minimized`**: a **44px** strip with the `inbox` icon, the badge, **and
    the whole fleet as minicards** — one 28px card per non-idle session,
    carrying the same [state ring](#fleet-state-ring-fleet-rail)
    and the same strict tier order as the expanded body, so the two views can
    never disagree. Geometry: `8 + 28 + 8 = 44`, the strip's existing width,
    unchanged. Minimizing reduces **area**, never information — it used to
    cost you the entire fleet, which was backwards, because minimizing is
    exactly when the glance matters most. Identity comes from the **same hover
    preview** the expanded cards use; at 28px a baked-in label would be a lie.
    Click selects, right-click opens the session menu — identical to a full
    card.
  - **`hidden`**: off. A **HARD** state now (it used to be soft — an
    actionable arrival broke it open). Only the operator, or the OS
    notification deep-link, brings the rail back.
- **No auto-summon — `minimized` and `hidden` are HARD states.** The rail
  **never expands itself** when an item arrives. It used to (T83 §5.6, a watch
  on `sessions.actionableInboxCount` in `App.vue`), and that was justified by a
  premise the minicards removed: a minimized rail showed **nothing**, so an
  arriving confirm would have been invisible and the rail had to force itself
  open. Now the fleet stays fully legible at 44px and the badge still counts,
  so forcing the layout open stops being a rescue and becomes an
  **interruption** — the exact modal behavior this rail exists to avoid. The
  operator put the rail away; it stays away until the operator brings it back.
  `layout.summonInboxRail()` survives for **one** caller: the OS
  notification's **deep-link** (`onNotifyActivateInbox`), which is a real
  operator gesture. Escalation is untouched — sound and OS attention still
  fire at their own source (`session-mcp-confirms.ts`), and the badge still
  counts. Only the layout yank is gone.
- **Hot proposals:** a `hot.md` proposal is an informational
  suggestion (see the "Hot proposal row" bullet below) — it enters the
  displayed count (`inboxCount`, the badge) but not `actionableInboxCount`.
  It never forced the panel open even when the auto-summon still existed, and
  it still doesn't: the minimized strip's `inbox` icon gets
  `.anim-shimmer-dot` (opacity
  glow/pulse, `--color-accent`) only while there's **nothing** actionable
  pending — a real approval always takes visual priority over the glow. No sound,
  no `requestAttention()` beyond the existing gentle one, no forced focus
  notification: "memory update" should never demand that you look at anything.
- **Entry point:** the rail itself — always visible as the 4th column, so it
  doesn't need a dedicated Topbar button to "open" what's already on screen.
  Clicking the **minimized** ribbon (44px) expands it. Also `⌘⇧A` and the "Open
  approvals" action in the palette (which always **expands**, never toggles). (The `inbox`
  button that used to live in the Topbar was removed for being redundant with the
  persistent rail — it kept the same `toggleInboxRail`, today only triggered by `⌘⇧A`.)
- **Stacked sections (NOT tabs), T152 order:** `Active missions` (grants
  strip, unchanged) → **`Fleet`** (bucket cards, the scrolling body — below)
  → **`Needs you`** (actionable: allow/deny — parked fail-closed confirms
  lead, a **collapsible section** matching Would-have's chrome, default
  **collapsed**, internal `max-height: 40vh` scroll when open, never
  auto-collapses once opened) →
  **`Would-have`** (read-only shadow log, collapsible, **collapsed** by
  default). `Activity` (the notification history) **left the rail in T152** —
  it now lives in the **Topbar's Activity bell**, see "Activity bell (Topbar
  notification popover)" below; it's global (not gated on a selected
  session), so it had to leave a per-worktree column. Stacking instead of
  tabbing is what guarantees the **actionable is never hidden behind an
  unselected tab**: in a tall, narrow rail the attention hierarchy is
  **spatial and permanent**. Needs-you and Would-have share one visual
  language — a `.section-head` chevron button (rotates `-90deg`↔`0` on
  toggle) over a `.collapsible` body (`grid-template-rows: 1fr↔0fr`, §7) —
  and Needs-you **disappears entirely** (header included) when there is
  nothing pending, the same way the empty-fleet mockup variant shows no
  Needs-you section at all. Section header in caps `10px` `--text-3` +
  counter on the right.
- **Fleet bucket cards — the rail's scrolling body.** A projection of
  `sessions.boardBuckets` (`stores/fleet-state.ts` + `components/fleet-board.ts`,
  unchanged — no new heuristics), reusing `FleetBoardCard.vue`. Three rules
  make this different from the old sidebar Fleet status board it replaces:
  - **Idle is never rendered here** (the old board's `idle` bucket is
    dropped for this projection only — `fleet-board.ts` is untouched and
    still buckets `idle`; the rail simply doesn't render that bucket).
    `done` stays.
  - **No bucket eyebrows / state labels.** The board's per-bucket headers
    are gone — a card's state is carried entirely by its **16px state ring**
    (see "Fleet state ring" in §7), which replaced both the old dot and the
    card border ring. One continuous column, not sections.
  - **Strict-tier ordering (anti-flood).** Tiers render in the fixed order
    `needs-input → errored → stuck → working → done` — a lower tier can
    **never** render above a higher one, so a session that just turned
    `working` can never push above something that still needs attention.
    Within the three **attention tiers** (`needs-input`/`errored`/`stuck`),
    cards sort **oldest-waiting first** (most neglected on top) — the
    inverse of `working`/`done`, which stay most-recent-first. This flip
    happens inside `sessions.boardBuckets` (`stores/sessions.ts`) by
    re-sorting `buildBoard`'s per-tier output for those three states;
    `buildBoard` itself (`fleet-board.ts`) is untouched. It applies to every
    `boardBuckets` consumer (the old sidebar board included) — "most
    neglected on top" is a universal improvement for any attention-tier
    bucket, not a rail-only rule.
  - **Card inset:** 8px left/right margin + 4px bottom margin per card
    (`FleetBoardCard.vue`, not a wrapper's padding) + 6px top padding on the
    scroll body, so the first card's ring never touches the header's
    bottom border. `overflow-x: hidden` + `scrollbar-gutter: stable` +
    `.scrollable` (§9) on the scroll body, so an incoming card's entrance
    slide (§7) or the vertical scrollbar appearing never shifts existing
    card widths.
  - **Empty fleet:** "You're all caught up" (`--text-4`, centered) — the
    same copy the pending queue used to show, now the fleet's own empty
    state (an idle-only fleet has nothing left to render once idle is
    dropped).
- **State filter — icon → popover, doubles as the legend.** A `22×22`
  icon button (`ListFilter`, same anatomy as the minimize button beside it)
  sits in the header, right of the title/badge. It opens an anchored popover
  (`FolderPreview`/`ActivityBell` convention: `absolute right-0 top-full`,
  `anim-fade-in-scale`, `bg-surface`/`border-2`/`radius`/`shadow-pop`,
  `onClickOutside` + `Esc` to close) listing the **five non-idle states**
  (`needs-input`/`errored`/`stuck`/`working`/`done` — `idle` is never a row,
  see below) as rows: **dot + label + live count + `ToggleSwitch`**. The dot
  reuses `FleetBoardCard.vue`'s exact per-state markup and the label reuses
  `board.state.*` — so this popover doubles as the legend the removed bucket
  labels (§2a) used to provide, not just a filter. The icon gets a small
  accent dot indicator (`bg-accent`, 6px, top-right) whenever any state is
  hidden, so a filtered rail never silently reads as an empty/quiet one.
  - **No idle toggle.** "Idle is never rendered" (§2) is a settled decision;
    a sixth row would silently reopen it.
  - **Filtering is a derived projection, never a mutation.** The unfiltered
    `fleetCards` stay the honest source for both the popover's live counts
    and the safety affordance below; only the rendered list
    (`visibleFleetCards`) is narrowed.
  - **Persistence:** a `Set<BoardState>` of hidden states,
    `om2tab.inboxRailHiddenStates` (`stores/layout.ts`, alongside
    `inboxRailWidth`/`inboxRailState` — fleet-global, not per-worktree).
    Default empty (show all); an unknown/legacy persisted value is dropped
    rather than resetting the whole set, so it can only ever fall back
    toward showing more, never hiding everything.
  - **Safety divergence from `CleanupView.vue`/`RoadmapBoard.vue`'s "header
    counts reflect the filtered set" convention — the Fleet rail deliberately
    does NOT follow it.** The header badge and the minimized-strip badge
    (`sessions.inboxCount`) stay approvals/parked-confirms counts, entirely
    independent of this filter — filtering to `working` and then having a
    session go `errored` must never silently vanish from view. When the
    active filter is hiding one or more `needs-input`/`errored`/`stuck`
    cards, a warning-colored one-click strip (`TriangleAlert` + "N hidden by
    the filter" + "Show all") appears above the Fleet body and clears the
    filter entirely on click. This is commented in `InboxRail.vue` itself —
    do not "fix" it into consistency with the other two views.
- **Card anatomy** (`FleetBoardCard.vue`, clickable — selecting has the same
  effect as a session row; hover reuses the Hover preview):
  1. **Line 1 — dot + title + folder.** The per-state dot (same spans as a
     session row). Title = the session name (§"Session name"), fallback
     "Untitled". On the right, the owning **folder's alias** in
     `--text-4` (`folder` icon 11px), to give context without the user
     having to remember which folder the session belongs to.
  2. **Line 2 — pulse / last PTY line** (`Code-sm`, `--text-3`, truncated
     to 1 line). Preference: the session's Haiku pulse (when there is
     one); otherwise the last non-empty PTY line (ANSI-sanitized). Neither
     present → the line disappears (1-line card; additive).
  3. **Line 3 — per-state meta.** `errored`: the reason reuses the Failure
     badge (§6 — `rate limit · resets in …` / `overloaded` / `billing`).
     `needs-input`: time blocked (`blocked {time}`). `working`/`done`:
     context % chip (same `tabular-nums` + per-band row color) + relative
     time.
- **"Needs you" row (`ApprovalRow`):** amber dot `bg-warning` (same as
  `needs-input`, `margin-top: 4px` to sit level with the first text line) + the
  **tool summary** (`Bash(rm -rf build)` — technical string assembled in the
  main process, **untranslated**, mono `12.5px`) + `<folder alias> · <session
summary>` (`--text-4` `11px`). **2-line clamp** on both lines (`line-clamp-2`,
  `line-height: 1.4`) — BUG-36: this used to be single-line `truncate`, which
  crowded the Allow/Deny buttons against clipped mid-word text on any
  realistic tool summary. Clicking the **body** opens the tab (inspection). On
  the right, **Allow** and **Deny**, row alignment `items-start` (not
  `items-center`) with `margin-top: 2px` on the button pair so they don't sit
  flush against a row that's wrapped to 2 lines. The parked-confirm row
  (`McpConfirmRow`, collapsed state) gets the same clamp-2 + `items-start`
  treatment on its prompt line — Allow/Deny stay hidden until expanded either
  way (the T08 disclosure contract, unaffected by this fix).
- **"Would-have" row (shadow log):** reuses the **`ApprovalRow`'s visual grammar**
  (mono tool summary + `<folder alias> · <session summary>` `--text-4`, both
  **2-line clamp**), enriched with the folder alias + the session summary (same
  enrichment as the pending queue) and a **relative timestamp** (`--text-4`
  `10.5px`, `tabular-nums`, `margin-top: 1px`). **Two deliberate
  differences:** (1) **no** Allow/Deny buttons — it's review data, not action; (2)
  **muted gray** dot (`bg-text-4`), **never** the pending queue's amber `--warning`, so it
  doesn't read as a call-to-action. Ordered most-recent-first. The **badge counts only
  pending** entries — shadow entries **never** enter the counter (AC17). Not
  virtualized — the shadow log is a small preview ring, unlike Activity's
  unbounded history.
- **Allow/Deny buttons:** combinations of existing tokens, **no new color**. **Allow**
  = `bg-green-soft` / `text-green`; **Deny** = `bg-red-soft` / `text-red`
  (same anatomy as `SessionMenu`'s destructive item). `check` / `x` icons,
  `border-radius 5px`, hover `opacity 0.8`.
- **Empty ("Needs you"):** the whole section (header + body) doesn't render
  — an empty actionable queue isn't worth a permanent "you're all
  caught up" row once the Fleet section above already shows the fleet is
  quiet; the copy moved to the **Fleet section's own empty state** (above).
- **Empty ("Would-have"):** "No preview entries yet" (`--text-4`, centered). If
  the responder hook is `off`, the text becomes **"Preview is paused — the responder
  is off (observer mode)."** (AC11) — never an ambiguous empty list.
- **"Active missions" strip:** right **below the header and above the tabs**,
  a compact band (`border-b`, `padding 10px 16px`) lists the **live mission grants**
  — the running missions whose escalations land in the "Needs you" section right below, so the
  operator sees what's auto-allowed right there. Same source as the canonical Settings
  section (the `useMissionGrants` composable, `activeGrants`). Eyebrow "Active
  missions" (`--text-3` 11px UPPERCASE). **One line per grant** (lean, the detail
  lives in Settings): **goal** (`--text-2` 12px `truncate flex-1`), `spent / budget`
  (`--text-4` 11px `tabular-nums`), "expires in {mins}m" (`--text-4` 11px `tabular-nums`)
  and a **small Revoke** (`bg-red-soft`/`text-red`, `padding 3px 8px`, radius `5px`).
  **Hidden when there's no live grant** (`activeGrants.length === 0`). Never shows
  dimmed grants (revoked/expired) — those only in the Settings pane.
- **Short window:** an approval expires in ~3.5s (the substrate's deadline, below
  Claude Code hook's 5s timeout) → fail-open, and the session resolves in the
  terminal. The inbox is the **fast path while you're watching**, not a
  respond-whenever queue.

#### Agent-action variant (MCP control-server confirm)

The **same queue/overlay** gains a variant for the **MCP control-server
confirm** (`onMcpConfirmPending`, see "### Control server (MCP)"). It's the
sign-off row for a **mutation requested by an external agent** (create session / open
terminal / create worktree). It differs from the hook row on **two non-negotiable
security points**:

- **Fail-CLOSED (not fail-open).** Unlike the hook approval (which expires
  fail-open and resolves in the terminal), this confirm **denies automatically** if you
  don't respond. The row carries the explicit warning **"Denies in {seconds}s if you don't
  respond"** (`--text-4` 10.5px, `seconds` in regressive `tabular-nums`, derived
  from the wire's `deadline` — a ~30s window). Granting by silence would give an external
  agent privilege — exactly the escalation this gate exists to prevent.
- **Mandatory disclosure (requirement B2).** Approving an action you **can't
  see** isn't control. The row **must** disclose, before the buttons, the
  fields coming from the `mcp:confirm:pending` wire (`{ id, prompt, permissionMode,
nonDefaultFlags, commands, deadline }`), each with its own label:
  - **Prompt** (`promptLabel`) — the effective prompt/prePrompt **verbatim** (`font-mono`
    11px `--text-2`, `white-space: pre-wrap`, **not truncated** — it's
    security content; scrollable block `bg-bg` / `border --border` / radius `5px` if long).
  - **Commands** (`commandsLabel`) — for `createWorktree`, the shell commands
    (`sh -c`) from `WORKTREE.md` that will run, **verbatim and untruncated** (same
    scrollable `font-mono` 11px block `bg-bg` / `border --border` / radius `5px` /
    `white-space: pre-wrap` as the Prompt, each command prefixed with `$`). Comes right
    **below the Prompt** (it's the highest-risk disclosure) and comes with a **warning**
    (`commandsWarning`, `text-warning` 10.5px) because it's **arbitrary code
    execution** triggered by an agent request — it's the confirm's RCE trust
    boundary (see `SECURITY.md`). Disappears when the array is empty (ops with no command).
    The rollback's `remove` appears in the `prompt`'s narrative ("On failure, rollback
    runs…"), **not** in this success-path list. `worktree`/`shell` untranslated (§8).
  - **Inherit agent control** (T61, `inheritControl`) — **never shown.** The wire's
    `worktreeInheritOffer` is now always `false` (see "Control server (MCP)" →
    "Worktree inheritance: REMOVED"), so this checkbox never renders. The component
    branch + the `inheritWorktreeControl` response field are retained but inert.
  - **Inherit scope — discovery confirm** (T72, `inheritDiscovery`) — **never raised.**
    `inheritDiscoveryOffer` is never `true` post-reversal: a worktree needs no inherited
    grant, and the only `FOLDER_NOT_ALLOWED` left is an explicit operator **block**,
    which no layer may promote to a confirm (or the denylist would be one "Always" click
    away from being undone). The UI below is retained but unreachable; it is the spec a
    future guarded mode would restore.

    when the wire brings `inheritDiscoveryOffer: true`: the agent tried to **act** on a
    canonical `.claude/worktrees/*` worktree of a repo you **already unlocked**, and instead
    of the `FOLDER_NOT_ALLOWED` dead end the gate promotes it to a **contextual
    confirm**. There are **3 visual choices over 2 verdicts** (there's no third
    verdict — `confirm-core` is binary, fail-closed left untouched): a **segmented**
    `Just this one / Always` (`scopeOnce`/`scopeAlways`, eyebrow `scopeLabel`), default
    **"Just this one"** (least privilege), in a `border --border` `bg-surface-2`
    radius `5px` band — the selected item uses `bg-accent-soft`/`text-accent`/`border
--accent-line`, the other is ghost `--text-3`. The **green Allow button** carries the
    chosen scope in `mcpConfirmRespond(id, 'allow', { inheritScope })`; the **red
    Deny** is the "No" (nothing is granted). **"Always"** turns on the global opt-in **and** marks
    this `worktree` (persistent, revocable by turning off the repo's agent control);
    **"Just this one"** unlocks only this `worktree`, only for this app session (in-memory, gone on
    restart). The **three meanings are narrated in the `prompt`** (naming the parent repo), so it
    survives on the parked row — which **doesn't** have the segmented control and so resolves
    to **`'once'`** (a surface that couldn't display the choice **never** turns on the
    global capability). `worktree`/`agent control` untranslated (§8).

  - **Always allow this verb here** (T93, `alwaysAllow`) — **only** when the wire brings
    `alwaysAllowOffer: true` (every mutation that goes through the confirm, **except**
    `plan_mission` — durably granting the grant-minter would be an escalation — and **except**
    the T72 discovery confirm, which has its own selector). A **checkbox** in a
    `border --border` `bg-surface-2` radius `5px` band (same language as
    `inheritControl`), with copy explaining that checking it makes this verb run **without
    a confirm** in this folder from now on. The **default comes from the wire** (`alwaysAllowDefault`):
    **checked** for common verbs, **unchecked** for dangerous ones (`create_worktree`,
    `spawn_terminal` — run shell / open terminal). The choice travels on **Allow** in
    `mcpConfirmRespond(id, 'allow', { alwaysAllow })` and, on allow, the main process **writes
    the `mcp__harnu__<verb>` rule to** the folder's **`.claude/settings.local.json`**
    (read-merge-write, dedup, preserves unrelated keys) — CC's native persistence,
    which Harnu's own gate then honors (skips the confirm on subsequent calls).
    It's **independent** of the T61/T72 offers (can co-occur with `inheritControl` on a
    `create_worktree`), so the choices **combine** in the same `data`. Disappears when
    the offer is false. Also appears **on the Approval Inbox's parked row** (the checkbox
    lives in the expand-to-review, alongside the disclosure), since that's the approval surface
    the card names; absent → nothing is persisted (safe default). `settings.local.json`
    untranslated (§8).
  - **Manifest checklist** (T104, `manifestCards`) — **only** when the wire brings the
    `manifestCards` array (the confirm for the `submit_manifest` verb, see "Roadmap board" →
    "Dispatch manifest"): instead of a single Prompt block, a **checkbox-per-card
    list** in a `border --border` radius `5px` band, each row with title + `slug`
    (mono `--text-4`) + discreet `kind`/`complexity`/`model` chips +
    readiness gaps (`--warning`) + a `<details>` preview of that card's boot prompt
    (`previewPrompt`). Every card is born **checked**; unchecking it is the **partial-go**
    (§2.2) — nothing is denied, the unchecked card is just left out of the stamp. A
    cost note (`manifestCostNote`) closes the list. The checked slugs travel on Allow via
    `mcpConfirmRespond(id, 'allow', { manifestSelectedSlugs })` — absent stamps nothing
    (fail-closed: here the checklist is the ONLY authorization surface, unlike the
    extra checkboxes above that only adjust an Allow that was going to happen anyway). **Substrate is
    a per-card `<select>`, not a chip** (T102, `agentConfirm.manifest.substrateLabel`)
    — pre-selected with the resolved value, editable before Allow; travels as
    `manifestSubstrateOverrides` (slug → substrate) and is recorded along with `approved`.
  - **Permission mode** (`permissionLabel`) — the resolved permission mode (`font-mono`
    11px). `permission mode` stays **untranslated** (§8).
  - **Flags** (`flagsLabel`) — the **non-default** flags being requested (chips
    `font-mono` 10.5px `--text-3`); disappears when the array is empty.

  The action title reuses per-op copy: **"Create a session in {folder}"**
  (`createSession`) / **"Open a terminal in {folder}"** (`spawnTerminal`) /
  **"Create a worktree in {folder}"** (`createWorktree`). `worktree` untranslated.

- **Dismiss / Allow / Deny buttons:** Allow/Deny identical to the hook row's
  (`bg-green-soft`/`text-green` and `bg-red-soft`/`text-red`), responded via
  `mcpConfirmRespond(id, …)`. **Deny** is the safe path and what expiry already does
  for you. **Dismiss** (BUG-32, Ghost variant — §6 Buttons) sits to their left and
  responds via `mcpConfirmDismiss(id)` instead — no verdict, the confirm returns to
  parked/Inbox. No new color/token beyond the existing Ghost variant.

**Focus: modal when focused, parked when absent.** The confirm is
**routed by focus** — the wire gains `mode: 'modal' | 'parked'`:

- **`modal`** (window focused) → the overlay above, fast path: you're looking,
  so the sign-off appears right away with the ~30s countdown.
- **`parked`** (window unfocused) → does **not** become a modal immediately. It becomes a **row in the
  Approval Inbox** ("Needs you" tab, `McpConfirmRow.vue`), for you to respond **when
  you get back** — a distraction should never kill the request. The real fail-closed is the
  long `PARK_TTL` (~30min), not the modal's 30s. Its arrival triggers the
  cross-cutting **sound + attention** rule (see "Security confirms — sound + attention" in
  Notifications).

**Promotion on focus regain.** A parked confirm doesn't wait for you to notice
the Inbox — the moment the window **regains focus**, every still-pending parked confirm
promotes straight to the modal above, over whatever screen is active. Main listens on
`browser-window-focus` and re-sends each still-live parked wire (now `mode: 'modal'`)
over the same `mcp:confirm:pending` channel; the parked-queue store drops the row (no
chime replay — the sound already fired once, at the original park time) and the overlay
picks it up exactly like a fresh arrival. Multiple confirms promote together, in park
order — the overlay's existing multi-row list (badge + scrollable body, above) is what
renders them, so there's no separate one-at-a-time reveal to build. Idempotent: a confirm
already showing as a modal isn't re-sent on the next focus event.

- **Dismiss (`agentConfirm.dismiss`, ghost button — §6 Buttons) is a THIRD exit, distinct
  from Allow/Deny: "not now."** It defers the row back to the Approval Inbox without a
  verdict — the confirm stays `pending`, its TTL is untouched, and it does **not**
  re-promote on the very next focus event (only after a subsequent blur → focus cycle,
  so dismissal is actually usable instead of being immediately undone). Ghost styling
  (`transparent` / `--text-2` / `--border`, same variant as a dialog's Cancel) keeps it
  visually subordinate to the green/red verdict buttons — it sits to their left, `Clock`
  icon.

The **parked row** is **expand-to-review** (T08's disclosure never weakened).
By default it's **discreet/muted**: a 7px `--warning` dot, the `prompt` (op + folder,
truncated `font-mono` `--text-2`) and a hint (`parkedHint`, `--text-4` 11px); the
Allow/Deny buttons **don't** live on the collapsed row. **Expanding** it (chevron; aria `expand` /
`collapse`) reveals the **full disclosure** — verbatim Prompt, the
**Commands** block (`sh -c`, the RCE boundary), Permission mode and Flags, reusing the
overlay's markup — and **only then** the Allow (`bg-green-soft`/`text-green`) / Deny
(`bg-red-soft`/`text-red`) buttons, responded via `mcpConfirmRespond(id, …)`. In other words: you
**always** see the exact commands before approving — there's never a one-click Allow
over hidden commands. Parked confirms **count** toward the Inbox badge
(`inboxCount`) and the `attentionCount` (window title + OS badge) — they're
**actionable**, unlike the "Would-have" section's read-only entries. An
`mcp:confirm:resolved` (respond / TTL / cancel / quit) **removes** the row; **there's no
re-hydration channel** — a renderer reload discards the parked rows from the UI (the
confirm stays alive in the main process, and the agent keeps polling `get_approval`).

### Footer / status bar (active-session + fleet HUD)

**File:** `StatusFooter.vue`. **Full-width** bar (covers sidebar +
main, like VS Code), **24px tall** (`h-6`), `bg-surface`, `border-t
border-border`, `text-[11px]`, numbers in `tabular-nums`. Fixed at the shell's
bottom — always visible, doesn't scroll. Lucide icons 12px, `currentColor`.

**Left — active session** (reactive:
`usage.telemetryForSession(sessions.selectedSession)`). Passes the **Session object**
(not the raw id) because a new session is still `synthetic-<uuid>` while
telemetry is keyed by Claude's real UUID — `telemetryForSession` matches by
exact id and, when the session is synthetic, falls back to `cwd === projectPath`
(the blob arrives seconds after spawn), so the footer shows the chips **before** the
1st turn. Chips `icon + value`, `gap-3`, **additive** — the chip disappears when
the data is `null`, the bar never flashes empty. Order:

| Chip          | Icon                     | Color                                                    | When                          |
| ------------- | ------------------------ | -------------------------------------------------------- | ----------------------------- |
| model         | `cpu`                    | `text-text-2`                                            | there's a session + telemetry |
| context       | `gauge`                  | `text-text-2` <80 · `text-accent` 80–95 · `text-red` ≥95 | omitted if `null`             |
| branch        | `git-branch`             | `text-text-2` (mono)                                     | omitted if empty              |
| effort        | `zap`                    | `text-text-2`                                            | omitted if `null`             |
| cost          | `dollar-sign`            | `text-text-2`                                            | omitted if `null`             |
| lines         | `±` (text)               | `text-text-2`                                            | omitted if both 0             |
| near-/compact | `triangle-alert` + label | `text-red` / `text-accent`                               | `exceeds200k` or context ≥95  |

Footer tone: the footer is a **HUD** and reads brighter than the sidebar's chips
on purpose — every chip stays at the legible `text-text-2` tone (the same as
`model`). Context keeps the same signal semantics at the same 80/95 breakpoints as
`barClass`: `text-text-2` <80 · `text-accent` 80–95 · `text-red` ≥95 (only turns
alert color near the ceiling). The **sidebar's** context chip stays muted
(`contextTextClass`, `text-text-4` <80) — and, while muted, is hover-only ("Stats
on demand", T118); from 80 on it becomes a signal and stays always visible.

The **near-/compact** chip carries a visible label (not just a tooltip), to say
_why_ it lit up: context ≥95% → `footer.nearCompact` ("near /compact",
`text-red`); otherwise `exceeds200k` → `footer.over200k` (">200k tokens",
`text-accent`, can light up at a low % on a 1M window). The `≥95` condition
wins over `exceeds200k` when both hold (red wins, more urgent). The
tooltip/aria is specific per condition (`footer.a11yNearCompactPct` /
`footer.a11yNearCompactOver200k`).

**Empty states (left):** no session → muted label `footer.noSession`;
session (synthetic or real) **with no telemetry yet** → session label in
`text-text-4`, no chips (graceful degradation). On a synthetic session the chips
appear as soon as the first statusLine blob for that `cwd` lands in the inbox —
seconds after spawn, via `telemetryForSession`'s `cwd` fallback, without
waiting for the 1st-turn synth→real migration. At the migration, the exact-id
path takes over, without flicker.

**Images pill** (left of the `ml-auto` cluster): `🖼 N` for the active session
(`~/.claude/image-cache/<uuid>/`), **hide-when-zero** — disappears when N === 0 / the session is
synthetic / nothing is selected. Click → gallery popover. Full detail in
"Pasted-images pill + popover" above.

**Right — fleet** (`margin-left:auto`): summary `5h·{time} {n}% · 7d·{time}
{n}% · {cost} · {n} tabs`, from `usage.rateLimits` + `usage.fleetSummary`. The
window size (`5h`/`7d`) is constant — what matters is **how much is left**, not
the size: the window id stays quiet (`text-text-3` — `text-text-4` was tested
and failed legibility at 11px; it's identity only, and without it the two chips
get ambiguous near a weekly reset, where both windows can read in hours), the
**remaining time** (`footerWindowCountdown`, reuses
`humanizeDuration`) carries the HUD tone (`text-text-2`, it's the data that
matters), and the `%` keeps `footerPctClass`'s signal color (80/95 breakpoints),
unchanged. When there's no `resetsAtMs` (or it already passed), it degrades back
to today's chip — `5h {n}%`, with no dangling separator or an expired `0m`
window. Clickable → **popover** (z-50, `anim-fade-in-scale`, `shadow-pop`,
`bg-surface-2`, `border-border-2`, ~280px) that mounts the reused `UsagePanel`
(5h/7d meters with countdown). Closes on click-outside / `Esc`. Hidden when
`usage.status === 'unavailable'`.

**Consolidation:** `UsagePanel` leaves the sidebar and now lives only in this popover
— usage / limit / cost under one roof.

**Supervision-load counter (T67 §3):** in the right cluster (left of the
Claude service status dot), a **discreet number** `● {n}` — 7px `--green` dot +
count — of how many live sessions are in `working` **or** `needs-you` right now
(derived from the SAME `classifyFleetState` the dot/board consume, via
`sessions.supervisionLoad`). **Hide-when-zero** (disappears when n === 0). It's just
the number: **no alarm, no cap/limit in v1**. The tooltip cites the comfortable
supervision ceiling (~4–5 agents, from the supervisor-cognition
study). `stuck` and `return-here` **don't** enter this count by
definition — they're their own signals (dot/board).

---

### Claude service status (footer dot + panel)

**Files:** `StatusFooter.vue` (dot) + `ClaudeStatusPanel.vue` (popover). Brings the
Claude service status (`status.claude.com`) into the app: an **always-visible
health dot** in the footer (**left of the fleet block**), a **popover
panel** with per-component health + active incidents, and **native OS
notifications** on transitions (incident opened / worsened / recovered).

**Dot (footer):** 8px circle, `rounded-full`, always present (doesn't disappear,
unlike the fleet one). Color by severity — **reuses existing tokens, no new
token**:

| Severity      | Token        | Meaning                                             |
| ------------- | ------------ | --------------------------------------------------- |
| `operational` | `bg-green`   | Everything operational                              |
| `degraded`    | `bg-warning` | Light degradation / minor incident                  |
| `outage`      | `bg-red`     | Downtime                                            |
| `maintenance` | `bg-accent`  | Scheduled maintenance                               |
| `unknown`     | `bg-text-3`  | No network / pre-first-poll — **never a false red** |

Static — **do not animate** (distinct from the `needs-input` attention dot and the
accent novelty dot). Click → popover (same frame as the fleet popover: z-50,
`anim-fade-in-scale`, `shadow-pop`, `bg-surface-2`, `border-border-2`, ~300px).
Closes on click-outside / `Esc`. A clicked notification opens the panel.

**Panel:** overall banner (dot + page description, e.g. "All Systems
Operational"), **active-incident cards** (severity dot + name + status
`investigating`/`identified`/`monitoring`), a **components** list (name +
label + dot per severity), **scheduled maintenance** (listed only in v1), and the
external link **"View status history"**. When `stale` (offline), shows a
muted "last known status" note.

**Copy (§8):** short labels with no trailing period ("Operational", "Degraded",
"Active incidents"); Statuspage's technical nouns (`status.claude.com`,
incident, component) stay untranslated. Native notification text is
neutral English (generated in the main process, no i18n — same precedent as the changelog).

---

### Pasted-images pill + popover (ephemeral screenshot gallery)

**Files:** `StatusFooter.vue` (pill + popover scaffold) + `FooterImagePopover.vue`
(grid + tile + actions). Surfaces the invisible `~/.claude/image-cache/<uuid>/`
folder — the PNGs Claude Code saves when you paste a screenshot — as a **read-only
window** onto the active session. **Read-only and ephemeral:** Harnu lists what's on
disk at the moment it opens; it never writes to `image-cache`, never persists anything.

**Pill (footer):** `🖼 N` (`image` icon 12px + `tabular-nums` counter), left of
the fleet's `ml-auto` cluster — **between** the session's telemetry chips and the
service/fleet dot. **Hide-when-zero (calm-tech):** the pill **doesn't render** when
the session has 0 images, is synthetic / has no real UUID, or nothing is selected —
zero footprint, appears only when there's something to show. **Live (calm):** the count is
re-listed by a light poll (readdir, ~2s, only with the window visible and a real
session), so pasting a screenshot into the current session makes the pill appear/update without
switching tabs — no flicker (the re-list preserves already-loaded thumbnails). **Bumps when a
genuinely new screenshot lands:** `anim-pill-bump` (§7 — 300ms, scale 1→1.16→1 + accent
cross-fade, no overshoot) fires when the count goes **up for the session already on screen**.
It deliberately does **not** fire on a session switch (even into a session with more images) or
on the first image (0→1 — already covered by the hide-when-zero fade-in); appearing from zero
still gets nothing beyond the standard fade. Tokens — closed `bg-surface-2 text-text-2` (hover
`border-border-2`); open `bg-accent-soft text-accent border-accent-line` (same
grammar as the active chips). Click → toggles the popover; opening closes the fleet
popover and vice versa (footer-local mutex). `aria-label` via `images.pillAria`.

**Popover:** same frame as the footer's popovers (z-50, `anim-fade-in-scale`,
`shadow-pop`, `bg-surface-2`, `border-border-2`, `bottom-full`), closes on click-outside
/ `Esc`. Anatomy:

- **Header:** `images.title` ("Pasted images") + `<folder alias> · N` (same
  metadata band as the rows).
- **Grid:** `grid-cols-3`, `gap-2`, thumbnails **most-recent-session-first**
  (ordered by the filename's numeric stem — `7.png` before `1.png`). Each **tile**:
  - the image (`<img>` with a base64 data-URL, `object-cover`, fixed aspect);
  - tile footer: `N.png` (mono) + `W×H` (from the `<img>`'s `naturalWidth/Height`);
  - on-hover: 4 actions (`external-link`, `folder`, `copy`, `reply` icons) — **Open**
    (OS viewer), **Reveal** (file manager), **Copy** (clipboard), **Re-attach**
    (re-injects the path into the running session's PTY → Claude detects it as `[Image #N]`).
  - **the tile body is clickable** (`cursor-pointer`) → opens the [Image lightbox](#image-lightbox-pasted-images-gallery)
    on that image. No "expand" icon is added to the hover row — the tile itself is the
    affordance. The 4 actions `@click.stop` so they never also open the lightbox.
- **Loading:** while the base64 hasn't arrived (read lazily on-open), tiles show
  `anim-shimmer-dot`.
- **Ephemeral note (popover footer):** `images.ephemeral` ("Live cache — cleared
  when the session is pruned.") — makes explicit that this is **not** a file.

**Re-attach:** writes the absolute path into the focused session's PTY (no newline — the
user reviews the `[Image #N]` and submits it). **Disabled** (`:disabled` + tooltip
`images.reattachDisabled`) when the session has no live PTY (`isSessionLive`); Open /
Reveal / Copy stay active (they don't depend on the PTY). `N.png`, `W×H`, paths, and `·` are
technical — **untranslated** (§8).

---

### Image lightbox (Pasted-images gallery)

**File:** `ImageLightbox.vue`, mounted by `StatusFooter.vue` and opened by clicking a
tile body in the popover above. The in-app answer to "let me actually look at this
screenshot" — before it, the only way to see a pasted image full size was **Open**, which
leaves Harnu for the OS viewer. **Pure consumer:** it renders the same base64 data-URLs the
popover already loaded (no second read, no separate full-size asset) and calls the same
`window.api.*` functions the grid's hover actions do — no new IPC.

**Surface:** full-viewport `<Teleport to="body">` at **z-60** (see the z-order table
above), `anim-overlay-fade` in, backdrop `rgba(0, 0, 0, 0.82)` — darker than the dialogs'
`0.55` because the content is an image, not a card. State (`lightboxIndex`) is **local to
`StatusFooter.vue`**, not the `ui` store: unlike `SessionPreview`/`CommandPalette` it has
exactly one entry point, so it doesn't need the cross-component mutex — same precedent as
the footer's own popovers. Anatomy, top to bottom:

- **Top bar:** `N.png` (mono) · `W×H` · folder alias on the left; `n / N` counter
  (`tabular-nums`, `images.lightboxCounterAria`) + an `x` close button on the right.
- **Stage:** `chevron-left` · the image · `chevron-right`. The image is `object-contain`
  inside the remaining height (never cropped, never upscaled past the viewport),
  `rounded-lg`, `border-2 border-border-2`, `shadow-pop`. The nav buttons are hidden when
  there's only one image. A still-loading image shows `anim-shimmer-dot`.
- **Bottom:** the same 4 actions as the tile hover row — **Open**, **Reveal**, **Copy**,
  **Re-attach** — at **equal visual weight** (labelled `bg-surface-2` buttons, no primary),
  reusing the grid's icons and `images.*` strings verbatim; then a **filmstrip** of 48px
  thumbnails (current one carries the pill's `bg-accent-soft border-accent-line` grammar,
  `aria-current`), then a hint line `images.lightboxHint` in `text-text-4`.

**Navigation:** `←` / `→` and the chevrons step through the list and **wrap in both
directions**; the filmstrip jumps directly. Image swaps are a plain opacity cross-fade
(§7 — "Lightbox image swap"), never a slide.

**Exits are one flow, not a modal stack.** `Esc`, a backdrop click, the close button, and
**Re-attach** all call the footer's `closeImageFlow()`, which closes the lightbox **and the
popover behind it** — one clean return to the plain footer, no nested-Esc to reason about.
While the lightbox is open it **owns** `Esc` and outside-clicks: the footer's own handlers
no-op (the lightbox is teleported to `body`, so its prev/next clicks read as "outside" the
popover and would otherwise free the very thumbnails it's showing).

**Live list.** The 2s poll keeps running underneath, so the entry list can change while the
lightbox is open. The viewed file is tracked **by name, not by index** — pruning isn't
guaranteed to happen at the end of the list, so an index-only guard would silently swap the
displayed image. If the viewed file is still present but shifted, the index re-points; if it
disappeared, the lightbox closes.

**Zoom/pan is deliberately out** — these are pasted screenshots, not a photo library;
`object-contain` at viewport size is the whole feature. Keyboard surface stops at
`←` / `→` / `Esc`.

---

### Heap gauge (footer)

**Files:** `HeapGauge.vue` (new, presentational) grafted into `StatusFooter.vue`'s
existing **fleet pill** (the "Right — fleet" 5h/7d/cost button above). The
always-on early-warning signal the 2026-07-14 OOM incident (`docs/specs/T127-system-monitor.md`
§1) needed and didn't have: it reads live V8 heap pressure with the System Monitor
takeover **closed**, fed purely by S1's cheap heartbeat (`monitor:heap`, 30s,
`v8.getHeapStatistics()` only — no `/proc`, no process walk).

**Placement:** a small button in the footer's right cluster, immediately **left of**
the fleet summary button (between the Claude service-status dot and the fleet pill),
same `gap-3` rhythm as its neighbors. **Hidden until the first heartbeat lands**
(`monitor.lastHeap === null`) — same rule the takeover's own header gauge follows;
nothing ever renders a fake 0%.

**Anatomy** (mono, `text-[11.5px]`, matches the mockup's `.gauge`): `heap` label
(`systemMonitor.heapLabel`, reused — same word, one concept) → a **54px** `h-1.5
rounded-full bg-surface-2` track with a fill bar → the rounded percentage
(`tabular-nums`) → a `TriangleAlert` 12px icon when non-`ok`. Fill color is the
shared `heapBarClass` (`system-monitor-format.ts`, already used by the takeover's
header gauge): `--color-green` below 70%, `--color-warning` at 70%, `--color-red`
at 85% (`thresholds.ts` — `WARN_RATIO`/`CRITICAL_RATIO`, S1). No new tokens.

**Click → toggles the takeover** (`ui.toggleSystemMonitor()`) — this is the entry point
spec §4 calls out; the System Monitor section above no longer needs its "until it
ships" caveat, this is the ship. Hover: `hover:text-text` (same idiom as the other
footer buttons — `text-text-2` at rest). While the takeover is open the whole gauge
inks `--accent` and carries `aria-pressed` (the footer's borderless variant of the
active state — see "Takeover dismissal"), so the same click closes it again.

**Copy (§8):** `heap` and the percentage are technical/numeric, untranslated in
markup; the accessible label (`footer.a11yHeapGauge`) goes through `$t()`.

---

### System Monitor (takeover)

A Chrome-task-manager-style live view of every process's resource cost — the answer to
"what's using RAM/CPU right now, and why", built after Harnu's main process OOM'd on
2026-07-14 with zero visibility while it was forming (`docs/specs/T127-system-monitor.md`).
This is the **observe + act** surface — per-row Park now/Close ship in this slice;
the footer heap gauge is another (S3). The hibernation-policy editor these actions feed into
is a dedicated Settings tab, documented below (§ "Hibernation policy pane").

**Visual pattern: main-pane takeover, not a modal.** `TakeoverShell` chrome (T300/U3,
see "TakeoverShell — shared chrome" above) — replaces the `<main>` content (sidebar and
topbar stay visible), icon `Cpu`, a title, close `X`. Teleported into the shell's
header: an inline heap gauge, only rendered once the first heap sample has arrived. Body
`overflow-y-auto` with a sticky column header. A footer bar states the sampling cadence
and links to the hibernation policy editor in Settings.

**Data source: the two S1 cadences, both fed into `stores/monitor.ts`.** `monitor:heap`
(always-on, 30s, `v8.getHeapStatistics()` only) feeds the heap gauge; `monitor:sample`
(1–2s, `app.getAppMetrics()` + a `/proc` walk) feeds the table — but only while this
takeover is mounted and the window is focused. `SystemMonitor.vue` acquires the full
sampler (`monitorStart()`) on mount and on window `focus`, and releases it
(`monitorStop()`) on unmount and on window `blur` — a local `acquired` boolean guards
against a double-acquire (main's refcount only balances 1:1; an extra release is
harmless — `Math.max(0, refcount - 1)` — but an extra acquire would leak a live
refcount that never reaches zero).

**Row model — two groups, one row shape (`SystemMonitorRow`).** A 4-column grid (Name /
RAM / CPU / State-detail), default-sorted RAM descending (`null` — unmeasured or
parked — always sorts last, never mixed with real numbers):

- **Harnu group** — one row per Electron process (`main` / `renderer` / `GPU` /
  `network` / …, from `app.getAppMetrics()`, untranslated technical labels). The
  `main` row alone carries the inline heap gauge (track + %, `--warning` at `warn`,
  `--red` at `critical`, a `TriangleAlert` icon when non-`ok`) — this is the exact
  2026-07-14 OOM signal made visible.
- **Harnu mod cell (T389 P1W4).** A live session row's state-detail column gains one
  `text-[11px] text-text-3` span after the state pip: **Harnu mod live** / **off** /
  **legacy**, with the reason in the `title` tooltip (`harnuMod.reason.*`). Same rule as
  the hover preview: `legacy` is quiet, never `--warning` or `--red`; nothing renders when
  the state is `null`. `SystemMonitorRow` takes it as an optional `companion` prop and
  `SystemMonitor` reads `stores/companion.ts`; parked rows show none.
- **Test Harnu mod channel (T389 P2W1).** A live row whose Harnu mod state is `live` gains one
  more per-row action beside Park now and Close: a `RadioTower`-icon button, `22×22px`,
  `hover:bg-surface-2`, `--text-3` glyph, revealed on row hover like the other two (a `22×22px`
  placeholder keeps the pip aligned on rows without it). It sends the session a `flush` and a
  terminal toast and answers with one Harnu toast: `info` "Harnu mod channel answered in {ms} ms",
  or `warning` "Harnu mod channel did not answer" / "…is not available: {reason}". The reason
  comes from a fixed three-word map (`legacy`, `shadow`, `headless`), never from text the session
  sent. In the terminal the session shows the line `harnu-companion: Harnu mod channel check`
  for the default 4 s; the engine draws the prefix. There is no abort or compact control: none is
  designed yet. No new token, size or motion.
- **Sessions group** — one row per live-or-parked session. **Live**, expandable
  (`ChevronRight`/`ChevronDown`) into its real `/proc` descendants (flat list, `└`
  prefix, no further nesting) when it has any. Name is the owning folder's alias (or a
  path-basename fallback) + `· <branch>`, mirroring the sidebar's own labeling.
  **Own-memory row.** `sampler.ts` deliberately excludes the session's root pid from
  its descendant list (its cost rolls into the row's own total instead) — expanded
  without explanation, that reads as the children silently not summing to the parent.
  The first row under an expanded session is therefore a synthetic **own memory**
  row (`system-monitor-format.ts#selfSample`: the row's total minus every listed
  descendant, `null` — never a misleading `0` — if any one reading is unknown) with a
  `•` marker instead of `└` and muted italic text so it never reads as a real `/proc`
  entry; hovering the label explains what it is. This is a client-side subtraction
  over numbers already sampled — no extra `/proc` reads, no added sampling cost.
  **Parked**: `procs` is always empty (no caret), RAM/CPU render as an em-dash
  (`—`, `system-monitor-format.ts#formatBytes/formatPct` — never a false `0`), and a
  second `<tr>` right below it explains why: the policy `reason` chip, the RAM
  reclaimed (`savedBytes`, when known — `"saved ~290 MB"`, `--color-green`), and a
  hint to wake it by selecting it in the sidebar. **Live + a sweep candidate**
  (`reason` is `'lru'`/`'hard-idle'`) gets the same reason chip plus its idle duration
  inline next to the state pip, rather than a whole explain row — that distinction
  stays exclusive to already-parked rows, both because the row has room and because a
  parked row's idle clock has stopped. A live row whose `sweepRank === 1` (the
  coldest hard-idle candidate — i.e. `evaluateFleet`'s next actual sweep victim) gets
  a small `--warning` "next to be swept" note.
- **Per-row actions.** A live, resumable session row (`parkable: true`)
  gets a `Pause`-icon **Park now** button (`--warning`); every session row gets an
  `X`-icon **Close** button (`--red`). Both render at `22×22px`, `hover:bg-surface-2`,
  invisible at rest and revealed on row hover (`opacity-0 group-hover:opacity-100`,
  `transition`) so the table reads clean when nothing is being acted on — the exact
  `.actions`-on-hover mockup S2 shaped the row's 4-column layout for. The Park slot
  always reserves its `22×22px` box (an invisible placeholder when the row isn't
  parkable) so the state pip lands at the same x position for every session row,
  parkable or not — a row-to-row-varying actions width would otherwise shift the
  right-justified state pip out of alignment. **Park now**
  kills the session's PTY (`ptyDestroy`) then flags it parked (`monitor:park`); the
  row shows an em-dash + reason on the very next sample, same as an auto-parked
  session. **Close** calls the sidebar's own `closeSession` — no new verb, matching
  §3's "wake reuses the existing select-the-session path" posture for the whole
  action surface.

**Group headers** are a plain `<tr colspan="4">` (`bg-surface`, `--text-3` uppercase
11px), showing the running totals (`{n} processes · {size}"`, `"{live} live · {n}
parked"`) — same visual grammar as a table section break elsewhere in the app.

**RAM column hint.** An 11px `Info` glyph sits right of the "RAM" header label
(`normal-case`, `--text-4`, `cursor-help`), carrying a native-title tooltip that
explains the number is per-process RSS summed across rows — shared libraries get
counted once per process that holds them, so the total can read higher than an
OS-level tool (KDE System Monitor, `htop`) that deduplicates shared pages. Static
copy, no extra sampling — the same "answer the obvious next question inline" posture
as the own-memory row above.

**State pip.** `live` — `--green` dot + text; `parked` — `--text-4` dot, `--text-3`
text. Same `state.live`/`state.parked` shape the sidebar's own session rows use.

**Policy link.** The footer's "Edit hibernation policy → Settings" deep-links straight
into the Settings dialog's Hibernation policy tab (`ui.openSettings('hibernationPolicy')`).

**Entry point.** The footer heap gauge ("Heap gauge (footer, T127 S3)" above) is the
way in — clicking it calls `ui.openSystemMonitor()`. The takeover mutex in
`stores/ui.ts` treats it as a third peer of `roadmap`/`usageDashboardOpen` — opening
any one of the three closes the other two.

**Copy (§8):** process/session technical labels (`main`, `renderer`, `claude`, branch
names, the policy `reason` codes `lru`/`hard-idle`/`selected`/`active`/`not-parkable`/
`parked`) stay untranslated, same rule as git branches and tool names elsewhere;
everything else (state words, hints, column headers) goes through `$t()`.

### Hibernation policy pane (Settings tab)

The editor for the T119 hibernation policy (`src/main/fleet-policy.ts`'s `Policy` —
`maxLive`, `lruIdleMs`, `hardIdleMs`), previously hardcoded and only changeable by
editing source and rebuilding (`docs/specs/T127-system-monitor.md` §1, §3). A 13th
Settings tab, registered like every other tab (`stores/ui.ts`'s `SettingsTabId` union

- `SettingsDialog.vue`'s `tabs` array) — no dialog, no modal-over-modal.

**Layout: same anatomy as every other simple Settings tab** (`PushChannelsPane`,
`MemoryLocationPane`) — an uppercase eyebrow, a muted intro line, then a stack of
label-left/control-right rows, each with a one-line `SettingHint` under the label.
No section chrome (no bordered card) — three rows is not enough content to need one.

**Three fields, one row each:**

- **Max concurrent sessions** (`maxLive`) — a plain integer stepper input, `1`–`50`.
- **Idle threshold (cap)** (`lruIdleMs`) — a number input **in minutes** (nobody
  thinks in milliseconds) with a `min` suffix, converted to/from ms at the edges.
- **Idle threshold (sweep)** (`hardIdleMs`) — same minutes input pattern.

Each input debounces its write-through (300ms, mirrors `EndpointsPane`/
`PushChannelsPane`'s inline-edit `patch` pattern) and re-syncs its displayed value
from the server's response, since `policy-store.ts` clamps/rounds on save — the
field always shows what was actually persisted, never a stale optimistic guess.

**No restart, no rebuild.** `pty.ts`'s `runPolicy()` reads the persisted policy
(`monitor:policyGet`'s backing store) on every cap/sweep check rather than a cached
constant — a save here changes real hibernation behavior on the very next check.

### Cleanup takeover (CleanupView.vue, Reaper PR3)

A fourth main-pane takeover — same shape/rules as
`RoadmapBoard`, `UsageDashboard`, and `SystemMonitor` above (replaces
`<main>`, sidebar/topbar stay visible, mutually exclusive with the other
three), opened via `ui.openCleanup()`.

**Header: `TakeoverShell` chrome (T300/U3, see "TakeoverShell — shared chrome"
above)** — a `Trash2` icon (`--accent`, 16px), the title (`$t('cleanup.title')`), and
a close `X` — the shared shell now, not the single custom header row the superseded
2026-07-14 mockup showed. No Teleported header content beyond the icon.

**Toolbar row** (below the header, `padding: 12px 22px`, `border-b
border-border`): the KPI line on the left (`$t('cleanup.kpis', {...})` —
item count, harvestable count, reclaimable size; bold on each number via
`<i18n-t>` named slots, the same idiom `RemoveWorktreeDialog`'s confirm
sentence already uses); on the right, the scan timestamp ("scanned {ago}",
11px `--text-4`), a ghost "Scan now" button (`RefreshCw` icon), and the
"Sweep N green · size" button (`bg-green-soft text-green`, disabled when
nothing is harvestable).

**Body** (`padding: 6px 22px 22px`, `overflow-y-auto`): one section per repo,
each with a `repo-head` (repo basename, mono, 12.5px/600, `--text-2`) and a
one-line subtitle (counts, `--text-4`), then the candidate rows. Rows use
the grid `grid-cols-[20px_240px_1fr_150px_86px]` (kind icon / identity+meta /
checkpoint timeline / verdict chip + reason line / action cluster) — widened
from `20px_240px_1fr_120px_40px` by T255, whose "Cleanup row" section below
owns the row's states, chip, reason line and actions — `gap: 14px`,
row `padding: 12px 10px`; hover reveals a `border-border` outline over
`bg-surface`. **Kind icons are Lucide, not text glyphs** (§5): `House`
(worktree), `GitBranch` (local branch), `Archive` (hidden folder), `Cloud`
(remote branch), and `House` again for a **detached worktree** — 14px,
`--text-4`, `currentColor`. The detached kind deliberately reuses the worktree
glyph rather than minting a fifth one: it _is_ a worktree, and what separates it
is stated in words on the row's meta line ("detached worktree · 12d ago"), not
smuggled into a 14px icon.

**Row identity is short by construction, never a truncated absolute path**
(`cleanup-ident.ts`, shared with `SweepConfirmDialog.vue`). Branch-backed rows
show the branch; a **path-backed row with no branch** — a hidden folder, or a
detached worktree — shows exactly one path segment, with the folder's location
moved to the meta line and the absolute path one hover away in a native `title`
tooltip (§6 "Session rows" convention). T255 revised the rule BUG-95 first wrote
here: its nested form collapsed to an identical 18-character prefix for every
one of Harnu's own worktrees. The rule, the measurement behind it and its
consequences are in "Row identity in 240 pixels" under "Cleanup row" below.

**A live session (`verdict: 'active'`) is filtered out of the row list
entirely** — Reaper can't offer to clean up a folder a Harnu session is
running in, so showing the row would be noise. The `active` row/chip/pulse
variant stays documented in the 2026-07-17 spec (`cleanup-row--active`) purely as
a canonical capture target for the row component in isolation; the T255 gallery
restages it only as the ghosted row 12, to show what being filtered out looks
like, and does not redefine that capture target.

**One carve-out, and only one.** A row whose folder holds a Harnu session
that Harnu itself dispatched **for that row** keeps rendering, carrying the
`remediating` chip. Without it the feature is unbuildable: `computeLiveFolders`
marks the folder active the instant the remediation session starts working, so
the row it was dispatched from would vanish at the moment it became interesting.
The exception is deliberately narrow — it keys on Harnu's own dispatch record for
that item, not on "a session happens to be live here" — so an operator opening
their own terminal in a candidate worktree still hides the row, exactly as
today. The pulsing accent dot moves out of the action column (now the action
cluster) and into the chip.

**Tombstone footer** ("Recent cleanups", `$t('cleanup.recent')`, 11px
uppercase `--text-4` eyebrow): one row per journal entry — kind icon, mono
branch name, "swept {ago} · was {sha}", and a copy-restore-hint button
(monospace, `bg-bg border-border`) that copies `git branch <name> <sha>` to
the clipboard on click.

**Empty state:** `$t('cleanup.emptyState')` centered in the body when every
repo group is empty after the active-session filter.

**Repo-group header carries a scoped Sweep action**: when a repo group
has ≥1 harvestable item, its header shows a `Sweep {n}` pill button
(`border-green/40 bg-green-soft text-green`, same token pairing as the
toolbar's global Sweep button, `padding: 4px 10px`) flush right via `ml-auto`.
It cleans only that repo's harvestable items — the click handler calls
`stopPropagation()` so it never also triggers the header's collapse toggle.
Hidden entirely when the group has zero harvestable items (never shown
disabled).

**Harvestable rows carry a hover-reveal checkbox in the existing kind-icon
slot** — no new grid column. The icon (14px) is the row's resting
state; on row hover, or once the row is checked, a native checkbox fades in
over the same 14×14px box (`transition-opacity`, `--dur-fast`) and the icon
fades out. Blocked/unknown/active rows never get a checkbox — they were
never actionable. Checking rows across repos surfaces a **selection bar**
below the toolbar (`border-b border-border bg-surface-2`, `padding: 8px
22px`): a "{n} selected" count, a `Sweep {n} selected` button (identical
token pairing to the toolbar Sweep button), and a right-aligned "Clear
selection" ghost link — shown only while ≥1 row is checked, alongside (never
replacing) the toolbar's global Sweep button. Selection resets after a
successful sweep and after an explicit Scan now.

### Checkpoint timeline (CleanupTimeline.vue)

The 7-checkpoint horizontal strip (`pr → review → ci → pr-merged → in-main →
remote-gone → local-clean`, the exact order the engine's `classify()`
emits). Locked dimensions (plan T7 — edit this file first if any of these
need to change):

- Root: `grid` with 7 equal (`1fr` each) columns, `width: 100%` — the strip
  fills its parent's grid cell (`CleanupView.vue`'s `1fr` timeline column)
  instead of an intrinsic fixed width, so the 7 checkpoints stay evenly
  spread at any window width instead of leaving a dead gap before the
  verdict chip / action column.
- Dot: **14px** circle, **1.5px** border, 8.5px/700 glyph (`✓` / `✕` / `?` /
  empty). The green/red states fill **solid** (`bg-green` / `bg-red`, opaque
  tokens, not the `-soft` translucent ones) with a `text-bg` glyph for
  contrast — the same "dark glyph on a solid status color" idiom used by
  `UsageDashboardCalendar.vue`'s day badges. The dot still paints on an
  **opaque backing plate** — a same-size, same-shape layer directly beneath
  the border/fill layer, colored to match the row's current background
  (`bg-bg` at rest, `bg-surface` on `group/row` hover) — kept as a
  belt-and-suspenders compositing guard and because the `na` state's 35%
  whole-dot opacity fade still needs it; it is no longer load-bearing for
  green/red, whose opaque fill already blocks the connector on its own.
- Connector: **1.5px** horizontal bar, one per checkpoint column except the
  first, `right: 50%` anchored with `width: 100%` of its own (now dynamic,
  uniform) column — since every column is an equal share of the grid, this
  generalizes the old fixed-76px span and still lands the connector's far
  edge exactly on the previous dot's center at any width.
- Label: **9px**, below the dot with a 5px gap, `white-space: nowrap`.
- Width tiers: the labels are the first thing dropped when the Cleanup
  body gets narrow — **compact** renders dots and connectors only and lets the
  column shrink to a 160px floor, **bare** removes the strip from the row grid
  entirely. In both tiers each dot's `title` gains the checkpoint **name** —
  see "Narrow rows" under "Cleanup row" for why that is a change and not a
  restatement. Thresholds and rationale there too.

States: **green** (`bg-green border-green text-bg`, connector `bg-green/55`,
label `--text-3`) · **red** (`bg-red border-red text-bg`, label
`--color-red`) · **unknown** (dashed border, `--text-3`
glyph `?`, default `--surface-2` fill, default label color) · **na** (35%
opacity dot, 45% opacity label, `--border` border, empty glyph — "not
applicable", e.g. `local-clean` for a branch with no worktree, or every
PR-backed checkpoint when `gh` never saw a PR for this branch). A red/green
checkpoint's `detail` field becomes the dot's `title` tooltip (e.g. "gh:
checks failing").

**Upstream PR — `via: 'upstream'`.** When the PR was found through a
branch's _shared upstream_ and nothing corroborates it for this branch (BUG-93's
`upstream-unverified`), the classifier marks the four PR-backed checkpoints
(`pr`, `review`, `ci`, `pr-merged`) `via: 'upstream'`. They describe that
upstream's PR — a real relationship, and an open PR there is worth seeing — but
not this branch, so they are **qualified, never withheld**:

- **Dot:** a marked `green`/`red` renders **hollow** — the state colour on the
  1.5px border and the glyph (`border-green text-green` /
  `border-red text-red`), no fill, over the same opaque backing plate.
  `unknown`/`na` render unchanged (they claim nothing). The solid fill stays
  reserved for a fact about this branch.
- **Connector:** into a marked dot it is always `bg-border-2`, so the chain
  never reads as this branch's green.
- **Label:** the `pr` label reads `cleanup.checkpoint.prViaUpstream` ("PR ·
  upstream") instead of `cleanup.checkpoint.pr`; the other labels are unchanged.
- **Tooltip:** a marked dot's `title` is its `detail`, then `—`, then
  `cleanup.checkpoint.viaUpstream` ("via a shared upstream, not this branch's
  own PR") — or that string alone when the checkpoint has no `detail`.

A PR resolved by the branch's own name, or through an upstream whose PR head
_is_ the local tip (`upstream-corroborated`), carries no mark and renders
exactly as above.

### Cleanup row — states, verdict chip and action cluster

This section **extends** "Cleanup takeover" above rather than replacing it: that
section still owns the header, toolbar, repo group and tombstone chrome, none of
which this one touches.

This section exists because five cards want the row's single action slot at
once — T250 (dehydrate), T251 (Diagnose), T252 (Remediate, iceboxed), BUG-93
(the "abandoned" blocker) and BUG-95 (detached rows, landed) — and their
ordering runs several of them close enough together that two branches would
edit the same rows, the same `cleanup.*` i18n block and this same section,
producing a visual result nobody designed. The contract below is written first
so each card implements it instead of inventing a fourth answer.

**No new component results.** The T251 dossier renders in the existing
`MarkdownPane`; everything else here is a control on a row that already exists.
There is no design-entity map row to add to `CLAUDE.md`.

#### Four axes and a set, not eight states

The eight words in circulation are not one enumeration. They live on four
independent axes plus one set:

| axis                              | values                                                                                                         | exclusive?                          | renders in                      | written by                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| **Verdict**                       | `harvestable` · `blocked` · `unknown` · `active`                                                               | one per row                         | the verdict chip                | `classify()` in `reaper-core.ts` — the only writer, ever       |
| **Kind**                          | `worktree` · `local-branch` · `hidden-folder` · `remote-branch` · `detached-worktree`                          | one per row                         | kind icon + first meta fragment | the scanner                                                    |
| **Hydration**                     | `hydrated` · `dehydrating` · `dehydrated` · `rehydrating`                                                      | one per row, worktree kinds only    | a meta-line marker              | T250                                                           |
| **Occupancy**                     | none · `remediating`                                                                                           | one per row                         | the chip, by precedence         | the renderer, from the live-session set — never the classifier |
| **Blockers** (a set, not an axis) | `dirty` · `unpushed` · `ci-failing` · `pr-open` · `pr-closed-unmerged` · `changes-requested` · `detached-head` | 0..n, non-empty only when `blocked` | the reason line                 | `classify()`                                                   |

So `detached` is a **kind**, `dehydrated` is a **hydration** state, and
`remediating` is an **occupancy** state. Only four of the eight words are
verdicts, and `ReapVerdict` keeps exactly those four members.

**`abandoned` is none of the above — it is blocker copy.** BUG-93's own spec cut
the `abandoned` verdict and kept only the label
(`docs/specs/2026-08-28-reaper-detection-honesty.md`, "Cut from this card"):
`sweep` only ever receives `harvestable` items — guarded at `CleanupView.vue`,
`stores/reaper.ts` and `executor-core.ts` — so a closed-unmerged row is already
excluded three times over and a fifth verdict buys nothing. What BUG-93 lands is
a **rewording of the existing `pr-closed-unmerged` blocker** so it reads as a
fact about the branch instead of as Harnu refusing. No new verdict, no new chip,
no new key.

#### What composes with what

- **Verdict × kind** — free, with two exclusions the types already enforce:
  `detached-worktree` is never `harvestable` (no branch → no merge signal, and
  `classifyDetachedWorktree` narrows `justifiedBy` to `null`) and never
  `unknown` (it always carries the `detached-head` blocker). A detached row is
  `blocked` or `active`, nothing else.
- **Verdict × hydration** — free. All eight combinations are legal and
  reachable. Dehydration removes ignored, untracked, regenerable directories: it
  changes no commit, no edit and no merge signal, so it cannot move a verdict. A
  dehydrated worktree is still classified, still blocked by whatever blocked it,
  and still sweepable the moment those blockers clear.
- **Verdict × occupancy** — `remediating` implies a live session in that folder,
  so the classifier's verdict for that row is `active`. See the carve-out in
  "Cleanup takeover" above.
- **Hydration × kind** — hydration exists only for `worktree` and
  `detached-worktree` rows. A branch has no checkout to dehydrate, and a
  `hidden-folder` is an archived directory rather than a provisioned one: no
  `WORKTREE.md`, no `setup` to rehydrate with.

#### The chip shows one value, by precedence

1. `remediating`, when the row is occupied by a Harnu-dispatched remediation
   session;
2. otherwise the classifier's verdict, verbatim.

Pill geometry is unchanged: `10.5px/600`, `padding: 3px 9px`,
`border-radius: 999px` (`rounded-full`).

| chip                 | key                                 | English              | tokens                                                                              |
| -------------------- | ----------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| harvestable          | `cleanup.verdict.harvestable`       | harvestable          | `bg-green-soft text-green`                                                          |
| harvestable · remote | `cleanup.verdict.harvestableRemote` | harvestable · remote | as above, plus a `TriangleAlert` glyph (10px, `--color-warning`) **after** the text |
| blocked              | `cleanup.verdict.blocked`           | blocked              | `bg-red-soft text-red`                                                              |
| unknown              | `cleanup.verdict.unknown`           | insufficient signal  | `bg-surface-2 text-text-3`                                                          |
| active               | `cleanup.verdict.active`            | session live         | `bg-accent-soft text-accent`                                                        |
| remediating          | `cleanup.verdict.remediating`       | remediating          | `bg-accent-soft text-accent`, preceded by a 5px `.anim-pulse-dot` accent dot        |

The warning triangle is never baked into a translated string, so every locale
translates words only and carries no markup.

`cleanup.verdict.remediating` lives in the `verdict.*` namespace because that is
where chip copy lives — **not** because `remediating` is a `ReapVerdict`. It is
not one, and no card may add it to that union: the classifier is the sole writer
of a verdict, and a session must never be able to influence one
(`docs/specs/2026-08-28-reaper-guided-remediation-design.md`, "The verdict is
always the scan's").

#### The reason line — no bare `unknown`, ever

A second line inside the verdict cell, directly under the chip: right-aligned,
**10px**, `--text-4`, one line, `truncate`, with the full untruncated string in
the cell's native `title` (the convention the identity cell already uses).

| chip                              | reason line                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| harvestable, harvestable · remote | none — the chip is the whole story and the timeline shows the chain green                                                                                                                                          |
| blocked                           | the first blocker's `cleanup.blocker.<id>` label, plus `cleanup.reason.more` (`+{count} more`) when there are others; the `title` carries every blocker joined by `; `                                             |
| unknown                           | the `detail` of the first checkpoint, in the engine's emit order, whose `state` is `unknown` **and** which carries a `detail`; when no checkpoint has one, `cleanup.reason.noProbe` — "no probe reached a verdict" |
| active, remediating               | none                                                                                                                                                                                                               |

This line is what retires the padlock (below): a blocked row's blockers stop
being a tooltip on a 13px glyph and become visible row text. It is also why the
verdict column widens.

**A requirement this places on BUG-74 and BUG-93.** `classify()` today emits
`{ id: 'in-main', state: 'unknown' }` with no `detail` on both of its unknown
branches, so on current data most `unknown` rows would read "no probe reached a
verdict" — true, but thin. The cards that change _why_ a row is unknown must
supply the `detail` that explains it: a truncated PR set (BUG-74's
`prSetComplete === false`) must write one naming the truncation, and a patch-id
probe that came back `+` must write one saying containment was not proven.
Absent that, the honest fallback stands — the line degrades, it never blanks.

#### The meta line

Second line of the identity cell, `--text-4` 10.5px, `truncate`. Fragments in
this fixed order, joined by `·`, each omitted when it does not apply:

1. **kind** — `cleanup.kind.*` (always present)
2. **location** — `cleanup.meta.in` ("in {dir}"), path-backed rows only (below)
3. **hydration** — `cleanup.state.dehydrated` / `dehydrating` / `rehydrating` /
   `dehydratedNoRehydrate`; nothing at all for `hydrated`, which is the default
   and must not mint a key for the absence of a marker. **One exception:**
   a hydrated row whose last rehydrate rewrote tracked files reads
   `cleanup.state.rehydrateChanged` ("rehydrate changed {file}") or
   `rehydrateChangedMore` ("… {file} +{count}") in `--color-warning`
   (`text-warning`) — that is a fact the operator owes a decision on (commit or
   revert the lockfile), not the absence of a marker, and it is how the row
   names what the install changed. It clears itself once those files are no
   longer modified. The meta line's native `title` carries the full text plus
   every changed file (`rehydrateChangedTitle`) and every ephemeral path the
   dehydrate guards kept, with its reason (`cleanup.state.kept`)
4. **age** — `{n}d ago` / `today`, untranslated (unchanged)
5. **size** — `formatBytes(diskBytes)` in `--text-3`, omitted when `diskBytes`
   is `null` — which is every row on Windows, where `measureDiskBytes` returns
   `null` by design (`scanner-shell.ts`)

Occupancy gets no meta fragment: the chip already says `remediating`. Five
fragments is the cap; a sixth would make the line unreadable at 240px, which is
why the "no `setup`" condition folds into the hydration marker instead of adding
one.

**The order above is priority order**, because `truncate` eats from the right. A
detached Harnu worktree overflows the 240px meta line by design — measured at
289px against 240px in the gallery — and what survives the cut is kind and
location, while age and size are the first to go. That is the right trade: a row
whose age is clipped is still identifiable, a row whose identity is clipped is
not. Both the full meta text and the absolute path remain reachable through the
cell's `title`.

#### Row identity in 240 pixels

**Every identity line is exactly one path segment** (`cleanup-ident.ts`, shared
with `SweepConfirmDialog.vue`). A branch-backed row shows its branch, unchanged.
A path-backed row with no branch — a hidden folder, or a detached worktree —
shows the folder's own **basename**, never a multi-segment path.

BUG-95 first wrote this rule as "repo-relative when the folder is nested inside
the repo, basename otherwise". That is right for a folder one level down and
degenerates for exactly the population that matters. Harnu's own worktrees live
at `<repo>/.claude/worktrees/<name>`, so under that rule every one of them
renders `.claude/worktrees/<name>` — and the identity column is plan-locked at
240px, roughly 28 characters of 12px mono, with `truncate` eliding the **tail**.
The shared 18-character prefix survives and the distinguishing name is what
disappears: a screenful of rows reading `.claude/worktrees/card-T2…`, differing
only in the part that got cut. An absolute path fails the same way one level
earlier (`/home/user/Workspace/org/pr…`).

The folder's location moves to the meta line as the `cleanup.meta.in` fragment
("in `.claude/worktrees`") — repo-relative when the folder is nested inside the
repo, the parent directory's own basename when it is a sibling, and omitted
entirely when the parent **is** the repo root, where there is nothing to say. At
10.5px on the meta line it costs a fragment rather than the column. The absolute
path stays one hover away in the identity cell's native `title` (§6 "Session
rows" convention), omitted when it would only repeat the visible text.

**The consequence, stated:** two path-backed rows can now collide on their
identity line when two directories share a basename. The location fragment
separates them, the tooltip is exhaustive, and a row's `id` is still its
absolute path, so selection and sweep are unaffected. That is a strictly better
failure than the one it replaces, where every Harnu-managed worktree row is
already visually identical and the tooltip is the only thing telling them apart
at all.

**`SweepConfirmDialog` does not follow this rule.** It is not width-constrained
and it is the last screen before a destructive act, so it names the **absolute
path** (`identTitle`) rather than the segment. `identText` is the row's helper;
the dialog's job is disambiguation, not density.

#### The action cluster replaces the single action slot

The row's fifth column stops being one 40px slot and becomes a **three-slot,
right-aligned cluster**. The grid changes once, here, and not again per card:

```
grid-cols-[20px_240px_1fr_150px_86px]        (was 20px_240px_1fr_120px_40px)
```

`gap: 14px` and the row padding (10px) are unchanged; the row's **`min-height`
locks at 57px**. That is 4px taller than the 53px the row measures today, and
uniformly so: the chip-plus-reason stack is 35px against the identity cell's
33px, so the verdict cell becomes the tallest cell in the row. The floor is what
keeps a `harvestable` row — which carries no reason line — the same height as
every other, instead of the list jittering by state. Verified in the gallery:
every one of its twelve rows measures 57px.

The verdict column takes the 30px the reason line needs and the action column
takes 86px (three 26×26px buttons, 4px apart). Both come out of the body's
horizontal minimum rather than out of the `1fr` timeline: `CleanupView.vue`'s
body `min-width` moves **1020px → 1096px**, so the timeline column keeps the
same 500px floor it has today.

**Why 150px and not, say, 130px** — measured in the gallery at the chip's own
typography: the widest chip is `harvestable · remote` at **141px** in English
and `aproveitável · remoto` at **145px** in pt-BR, both including the warning
glyph. The shipped 120px overflows in both locales; 150px clears the wider of
the two by 5px. That budget is the constraint on any future chip copy — **a chip
is `nowrap` and must never be truncated**, because a clipped verdict is worse
than a tight one. A translation that will not fit may bleed left into the 14px
gap and the `1fr` timeline's tail (measured slack there is 23px on the tightest
row); it may not be given `truncate`, and it may not silently widen the column
for one locale.

**The highest-ranked legal action takes the rightmost slot**, and slots fill
right to left, so the primary target sits at the same x on every row no matter
how many actions that row offers.

| rank | action       | glyph                   | legal when                                                                                                     |
| ---- | ------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1    | Trash        | `Trash2`                | verdict is `harvestable`                                                                                       |
| 2    | Open session | `SquareArrowOutUpRight` | occupancy is `remediating`                                                                                     |
| 3    | Remediate    | `Wrench`                | verdict `blocked`, every blocker in the hygiene set (`dirty`, `unpushed`), occupancy none — **T252, iceboxed** |
| 4    | Diagnose     | `Stethoscope`           | verdict `blocked` or `unknown` — T251                                                                          |
| 5    | Rehydrate    | `PackagePlus`           | worktree kind, hydration `dehydrated`, and the manifest declares a `setup` step                                |
| 6    | Dehydrate    | `PackageMinus`          | worktree kind, hydration `hydrated`, ephemeral set non-empty                                                   |

**Three slots is a proven cap, not a guess.** Rank 1 requires `harvestable`;
ranks 3 and 4 require `blocked`/`unknown`, mutually exclusive with it. Ranks 5
and 6 are opposite ends of one axis, so at most one of the two. Rank 2 implies
`remediating`, which **suppresses rank 3 outright** — you never dispatch a
second session onto a row that already has one. The largest legal set is
therefore `{2 or 3} ∪ {4} ∪ {5 or 6}` — **three**. Any card that adds a seventh
action, or that breaks one of those exclusions, re-cuts the grid and comes back
to this section first.

The third slot is empty in every state that ships today, because T252 is
iceboxed. It is reserved rather than reclaimed so that card adds a button
instead of re-cutting the row a second time; right-alignment makes the vacancy
read as margin rather than as a hole.

**Absent, never disabled — with one exception.** An action that is not legal for
the row's state does not render at all, the same rule the repo-group `Sweep {n}`
pill already follows ("hidden entirely when the group has zero harvestable
items, never shown disabled"). An action that **is** legal but momentarily
unavailable — a sweep confirm is open, or this row has an operation in flight —
renders `disabled` at `opacity-40` / `cursor-not-allowed`, the existing
`:disabled="sweepItems !== null"` pattern.

**Button chrome.** 26×26px, `rounded-sm border border-border-2 text-text-3`, a
13px Lucide glyph at 1.7 stroke — the shipped trash button's box, unchanged.
Hover ink is per action: Trash keeps `hover:border-red hover:bg-red-soft
hover:text-red`; every other action uses the neutral `hover:border-border
hover:bg-surface-2 hover:text-text`. Dehydration is reversible and diagnosis is
read-only — neither earns red.

**In flight.** The acting button swaps its glyph for `Loader2` with
`animate-spin` (the toolbar's Scan-now idiom) and the whole cluster for that row
disables. The wait is real — a rehydrate is an `npm install` — so the meta line
carries `dehydrating` / `rehydrating` for the same window, which is what a
scrolled-away row or a collapsed group has to read. Failure returns the row to
its previous hydration marker and reports through the existing toast surface
(§6 "Toast"); the row never rests in a half state.

**When the manifest declares no `setup` step**, Harnu cannot rehydrate the
worktree and must say so _before_ the operator dehydrates it, not after
(`docs/specs/2026-08-28-reaper-dehydrate-worktrees.md`, "Rehydration"). The
Dehydrate button's accessible name and `title` both switch to
`cleanup.a11y.dehydrateNoSetup`; once dehydrated, that row renders no Rehydrate
button at all (rank 5's legality), and its hydration marker reads
`cleanup.state.dehydratedNoRehydrate` ("dehydrated · no setup") rather than
adding a sixth meta fragment.

**The padlock is retired.** `blocked` and `unknown` rows currently render a 13px
`Lock` glyph whose `title` is the only place the blocker list appears anywhere.
The chip already says "blocked"; the reason line now says why, in visible text.
The glyph was carrying nothing a sighted or an assistive reader could reach. A
row with no legal action renders an empty cluster.

**Sequencing constraint.** The reason line and the padlock's retirement are one
atomic pair: whichever card first re-cuts this grid must land both, or it ships
a build where a row's blockers appear neither in a tooltip nor on the row.

#### Narrow rows: degrade the timeline, never the actions

Today the body simply scrolls horizontally below its `min-width`. That keeps the
row's geometry constant, but it pushes the action cluster — now the row's
primary interaction — off the right edge of any window narrower than 1096px,
which a half-width Harnu window is. Identity, verdict, reason and actions are
load-bearing; the 7-label checkpoint strip is context. So the strip is what
gives way.

A `ResizeObserver` on the scroll body sets one tier from its client width. That
is the app's idiom for this — `ReviewPane.vue` and `PrStackCanvas.vue` both
measure a host that way — and the renderer uses no CSS container queries and no
Tailwind breakpoints anywhere, so introducing either for one row would be a new
mechanism with one caller.

| tier        | body client width | the row                                                                                                                                                                                         |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **regular** | ≥ 1096px          | the full grid above                                                                                                                                                                             |
| **compact** | 756–1095px        | `CleanupTimeline` drops its 9px labels and renders dots + connectors only; the timeline column's floor falls 500px → 160px                                                                      |
| **bare**    | < 756px           | the timeline column leaves the grid entirely — `grid-cols-[20px_1fr_150px_86px]`, identity taking the flex column with a 180px floor. Below ~522px the body finally h-scrolls, as it does today |

**Dropping the labels costs something, and the tier has to pay it back.** The
shipped dot's `title` is `cp.detail` (`CleanupTimeline.vue`), which is optional
and carries the _detail_ of a checkpoint — "not merged", "gh: checks failing" —
never its _name_. Most dots have no `detail` at all: `classify()` emits
`in-main` unknown without one, and six of `classifyDetachedWorktree`'s seven
checkpoints have none. So the name lives **only** in the 9px label, and a tier
that drops the label with no compensation drops the only thing identifying which
of the seven positions a dot is.

So, in the **compact** and **bare** tiers only, each dot's `title` becomes the
checkpoint name, with its `detail` appended after `—` when it has one ("CI",
"CI — gh: checks failing"). The name comes from the same `checkpointLabel(cp.id)`
the label span already uses, so this mints no key. In the **regular** tier the
`title` stays `cp.detail` exactly as it ships — the label is on screen, so
repeating it in a tooltip is noise.

With that, nothing is lost on the way down: the dot's colour still carries the
state, its tooltip still carries the name, and the seven positions are a fixed
order an operator learns once. Widening the window restores the labels.

#### Accessible labels

Every control on the row carries an explicit `:aria-label` through `$t()`,
interpolating the row's visible identity as `{what}` — the filter bar's pattern
(`cleanup.filterBar.searchLabel`, `cleanup.filterBar.verdictLabel`), extended
with the per-row interpolation `cleanup.selectRow` already uses. `{what}` is
`identText(item)`: the single segment the operator can actually see, never the
absolute path. A label that names something not on screen is not a label.

| control                    | `aria-label` key                                                                                                        | English                                      | native `title` |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------- |
| row checkbox               | `cleanup.selectRow` (existing)                                                                                          | Select {what}                                | —              |
| Trash                      | `cleanup.trashTitle` (existing key, newly used as the label too, and `{what}` moves from the kind to `identText(item)`) | Clean up: {what}                             | same           |
| Diagnose                   | `cleanup.a11y.diagnose`                                                                                                 | Diagnose {what}                              | same           |
| Dehydrate                  | `cleanup.a11y.dehydrate`                                                                                                | Dehydrate {what}                             | same           |
| Dehydrate, size known      | `cleanup.a11y.dehydrateSize`                                                                                            | Dehydrate {what} — frees {size}              | same           |
| Dehydrate, no `setup`      | `cleanup.a11y.dehydrateNoSetup`                                                                                         | Dehydrate {what} — Harnu cannot rehydrate it | same           |
| Rehydrate                  | `cleanup.a11y.rehydrate`                                                                                                | Rehydrate {what}                             | same           |
| Remediate                  | `cleanup.a11y.remediate`                                                                                                | Remediate {what}                             | same           |
| Open session               | `cleanup.a11y.openSession`                                                                                              | Open the session working on {what}           | same           |
| repo-header Dehydrate pill | `cleanup.a11y.dehydrateGroup`                                                                                           | Dehydrate {count} idle worktrees in {repo}   | —              |

Four notes, each closing a real gap:

- The shipped trash button carries a `title` and **no** `aria-label`, so a
  screen reader announces it as "button". It reuses `cleanup.trashTitle` rather
  than minting a parallel `cleanup.a11y.trash` — renaming a live key churns both
  locale files for no user-visible gain. **The key is reused; its interpolation
  changes.** `trashTitle()` passes `{ what: kindLabel(item.kind) }` today, so the
  button reads "Clean up: worktree" — the kind, which is already the row's first
  meta fragment and names nothing that distinguishes this row from the next. Under
  the `{what}` rule above it becomes `identText(item)` and reads "Clean up:
  PROJ-231-invoice-export". The English string is untouched, so neither locale
  file changes for this.
- The retired padlock needs no label because it stops existing. Its content is
  the reason line, which is text.
- The chip, the reason line and the meta line are text, not controls: they take
  no label. The verdict cell keeps a `title` carrying the untruncated reason.
- Buttons appearing and disappearing per state means the cluster's tab order
  varies by row. That is correct — an absent action is not focusable — and it is
  why the ordering is fixed right-to-left **by rank**, not by which card shipped
  which button.

#### The i18n key names, fixed here

Keys group by **surface** — `cleanup.verdict.*`, `cleanup.blocker.*`,
`cleanup.state.*`, `cleanup.action.*`, `cleanup.a11y.*`, `cleanup.reason.*`,
`cleanup.meta.*` — which is the shape the `cleanup` block already has
(`kind.*`, `checkpoint.*`, `filterBar.*`, `selection.*`). They are **not**
grouped by feature: `docs/specs/2026-08-28-reaper-dehydrate-worktrees.md`
mentions `cleanup.dehydrate.*` and
`docs/specs/2026-08-28-reaper-guided-remediation-design.md` mentions
`cleanup.remediate.*` in passing. Both predate this contract; the names below
supersede them.

Named here, added by the card that ships the surface — and added to **`en.json`
and `pt-BR.json` in the same change**, since the schema is `typeof en` and a
one-sided addition breaks `vue-tsc` (`docs/lessons/i18n/002-vue-i18n-schema-parity.md`).

**`cleanup.action.*` renders nowhere in this revision, and that is deliberate.**
Every control in the cluster is a 26×26px icon-only button whose accessible name
and `title` both come from `cleanup.a11y.*` — so on the row itself, the `a11y`
key is the only string a user ever encounters. The `action.*` names are reserved
here for a surface that does not exist yet: a text-labelled affordance for these
same actions — a row context menu, an overflow menu, or a repo-header pill
alongside `cleanup.sweepGroup`. They are named now for the same reason
`cleanup.filterBar.hydration.*` is: so the card that eventually builds that
surface inherits the namespace instead of opening a new one. A card that ships
no such surface adds no `action.*` key and is not missing anything.

**T250 — dehydrate**

| key                                   | English                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanup.action.dehydrate`            | Dehydrate                                                                                                                                                                  |
| `cleanup.action.dehydrateNoSetup`     | Dehydrate — no rehydrate                                                                                                                                                   |
| `cleanup.action.rehydrate`            | Rehydrate                                                                                                                                                                  |
| `cleanup.a11y.dehydrate`              | Dehydrate {what}                                                                                                                                                           |
| `cleanup.a11y.dehydrateSize`          | Dehydrate {what} — frees {size}                                                                                                                                            |
| `cleanup.a11y.dehydrateNoSetup`       | Dehydrate {what} — Harnu cannot rehydrate it                                                                                                                               |
| `cleanup.a11y.rehydrate`              | Rehydrate {what}                                                                                                                                                           |
| `cleanup.a11y.dehydrateGroup`         | Dehydrate {count} idle worktrees in {repo}                                                                                                                                 |
| `cleanup.state.dehydrated`            | dehydrated                                                                                                                                                                 |
| `cleanup.state.dehydratedNoRehydrate` | dehydrated · no setup                                                                                                                                                      |
| `cleanup.state.dehydrating`           | dehydrating…                                                                                                                                                               |
| `cleanup.state.rehydrating`           | rehydrating…                                                                                                                                                               |
| `cleanup.dehydrateGroup`              | Dehydrate {count} idle                                                                                                                                                     |
| `cleanup.dehydrateConfirm.*`          | T250 owns this dialog's keys under `cleanup.dehydrateConfirm.*`; it is a single-owner surface, not a collision surface — enumerated under "Dehydrate confirm dialog" below |

**T251 — the dossier**

| key                       | English         |
| ------------------------- | --------------- |
| `cleanup.action.diagnose` | Diagnose        |
| `cleanup.a11y.diagnose`   | Diagnose {what} |

**T252 — remediation (iceboxed; names reserved so the icebox does not thaw into a new namespace)**

| key                           | English                            |
| ----------------------------- | ---------------------------------- |
| `cleanup.action.remediate`    | Remediate                          |
| `cleanup.action.openSession`  | Open session                       |
| `cleanup.a11y.remediate`      | Remediate {what}                   |
| `cleanup.a11y.openSession`    | Open the session working on {what} |
| `cleanup.verdict.remediating` | remediating                        |

**BUG-93 — "abandoned"**

No new key. `cleanup.blocker.prClosedUnmerged` is **reworded** from "PR closed
without merge" to **"abandoned — PR closed unmerged"**, in both locales. The
blocker id `pr-closed-unmerged` and its `BLOCKER_LABEL_KEYS` entry are
unchanged; only the string moves. There is no `cleanup.blocker.abandoned` and no
`abandoned` verdict.

**Whichever card lands the row revision first** (the reason line + padlock pair):

| key                      | English                    |
| ------------------------ | -------------------------- |
| `cleanup.reason.more`    | +{count} more              |
| `cleanup.reason.noProbe` | no probe reached a verdict |
| `cleanup.meta.in`        | in {dir}                   |

**Not in this revision.** The filter bar keeps its four verdict options and gains
nothing here. If a hydration filter is ever wanted it is its own card, and its
keys are `cleanup.filterBar.hydration.*` — named now so that card does not open
a fifth namespace either.

#### Worked examples

Cluster is written right to left, primary first, matching the rendered order.

| #   | row                                          | chip                   | reason line                            | meta line                                                          | cluster (right → left)                                 |
| --- | -------------------------------------------- | ---------------------- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | merged worktree, deps installed              | harvestable            | —                                      | `worktree · 12d ago · 214 MB`                                      | Trash · Dehydrate                                      |
| 2   | merged branch, still on origin               | harvestable · remote ⚠ | —                                      | `local branch · 12d ago`                                           | Trash                                                  |
| 3   | worktree with tracked edits                  | blocked                | uncommitted changes                    | `worktree · 3d ago · 1.9 GB`                                       | Diagnose · Dehydrate                                   |
| 4   | **dehydrated and blocked**                   | **blocked**            | **uncommitted changes**                | **`worktree · dehydrated · 34d ago · 1.2 MB`**                     | **Diagnose · Rehydrate**                               |
| 5   | dehydrated, blocked, manifest has no `setup` | blocked                | unpushed commits                       | `worktree · dehydrated · no setup · 34d ago`                       | Diagnose                                               |
| 6   | blocked on two things                        | blocked                | abandoned — PR closed unmerged +1 more | `worktree · 61d ago · 2.1 GB`                                      | Diagnose · Dehydrate                                   |
| 7   | detached Harnu worktree                      | blocked                | detached HEAD — no branch              | `detached worktree · in .claude/worktrees · 9d ago · 480 MB`       | Diagnose · Dehydrate                                   |
| 8   | the same row, dehydrating now                | blocked                | detached HEAD — no branch              | `detached worktree · in .claude/worktrees · dehydrating… · 9d ago` | Diagnose · Dehydrate (spinner), whole cluster disabled |
| 9   | nothing probed cleanly                       | insufficient signal    | no probe reached a verdict             | `local branch · 210d ago`                                          | Diagnose                                               |
| 10  | PR list truncated                            | insufficient signal    | PR list truncated at 100               | `local branch · 44d ago`                                           | Diagnose                                               |
| 11  | remediation session running                  | remediating ●          | —                                      | `worktree · 3d ago · 1.9 GB`                                       | Open session · Diagnose · Dehydrate                    |
| 12  | any row with an unrelated live session       | —                      | —                                      | —                                                                  | not rendered — filtered out                            |

**Row 4 is the acceptance test for this section.** A dehydrated _and_ blocked
row reads its verdict from the chip (red, "blocked"), its cause from the reason
line ("uncommitted changes"), and its hydration from the meta line
("dehydrated"); the two states never compete for the chip because they are on
different axes. Its cluster offers Diagnose and Rehydrate and no Trash, because
Trash needs `harvestable` and Rehydrate is the `dehydrated` end of the hydration
axis. Row 11 is the only three-button row that ships before T252; the rank
table's `{2 or 3}` branch allows exactly one other, and T252 brings both. Taking
the `3` branch instead makes row 3 — blocked on hygiene alone, hydrated,
unoccupied — a Remediate · Diagnose · Dehydrate row. Those two shapes are the
complete set of three-button rows.

### Dehydrate confirm dialog (DehydrateConfirmDialog.vue)

The gate in front of every dehydration — the per-row Dehydrate button (one
item) and the repo-group "Dehydrate N idle" pill (every idle item in the group)
share one mount, exactly as the sweep's two entry points share
`SweepConfirmDialog`. Spec: `docs/specs/2026-08-28-reaper-dehydrate-worktrees.md`.

**Shape is borrowed, copy is not.** Anatomy is `SweepConfirmDialog`'s, unchanged:
Teleport → `.anim-overlay-fade` backdrop → `.anim-fade-in-scale` card
(`min(560px, 90vw)`, `max-height: 84vh`, 10px radius, `--shadow-pop`),
header / scrollable body / footer, focus trap, Esc and backdrop close, the
same item-row chrome (`rounded-sm border border-border bg-surface-2`, 12px).
Its copy is its own: five of `cleanup.sweepConfirm.*`'s sixteen keys describe
sweeping, and a dialog that never sweeps must not say "never swept".

**Body, top to bottom:**

1. **Item rows** — `House` 12px, the row's `identText` (mono 11.5px, absolute
   path in `title`), and right-aligned mono 10.5px `--text-4`: the removable
   paths joined by `·`, then the size (`formatBytes`) or
   `dehydrateConfirm.sizeUnknown` — never a guessed figure (Windows is always
   unknown). Under a row, when it applies: `dehydrateConfirm.noSetup` in 11px
   `text-warning`, and a "Kept" list (`keptTitle`, then one mono 10.5px
   `--text-3` line per skipped path: `{path} — {dehydrateConfirm.skip.<reason>}`).
2. **"Nothing removed is work"** — neutral block (`border-border bg-surface-2`,
   `ShieldCheck` 13px `--text-3`): the four guards in words
   (`regenerableTitle` / `regenerableBody`) and what Rehydrate does, including
   that installs can rewrite lockfiles (`rehydrateNote`). Neutral, because this
   is the guarantee, not a hazard.
3. **"Deleted outright — not moved to the trash"** — warning block, the same
   `border-warning/35 bg-warning/8` + `TriangleAlert` idiom as the sweep's
   remote warning (`permanentTitle` / `permanentBody`): there is no undo in the
   trash, on purpose. When any item has no `setup`, the block adds
   `noSetupCount` in `font-medium text-warning`, so the one irreversible case is
   restated at batch level and survives a long list.

**Footer:** `totals` ("{worktrees} worktrees · {size} back"), or `totalsUnknown`
when any item is unmeasured; Cancel/Close ghost button; the confirm button
`bg-accent-soft text-accent` with `PackageMinus` (spinner `Loader2` while
running) — accent, not red: dehydration is reversible by the repo's own setup.

**Progress and failure** follow the sweep dialog: a per-row `Check` (green) or
`TriangleAlert` (red) as results stream in (`reaper:dehydrateProgress`); a
successful run closes itself; any failure keeps the dialog open with a
`bg-red-soft` block per failed item listing each line — refusal, per-path error
(`failed`: "{path}: {error}"), a tracked-set change (`trackedChanged`, which
must never happen), and paths skipped at execution time. Dehydrate failures
therefore report **here**, not through a toast; Rehydrate, which has no dialog,
reports through the toast surface (`cleanup.toast.*`).

**Keys (`cleanup.dehydrateConfirm.*`):** `title` (pluralized), `subtitle`,
`close`, `cancel`, `confirm`, `sizeUnknown`, `noSetup`, `noSetupCount`
(pluralized), `regenerableTitle`, `regenerableBody`, `rehydrateNote`,
`permanentTitle`, `permanentBody`, `keptTitle`,
`skip.{sessionLive,tracked,notIgnored,symlink,notDirectory,unsafePath,probeFailed}`,
`totals`, `totalsUnknown`, `failed`, `trackedChanged`.

**Rehydrate toasts (`cleanup.toast.*`):** `rehydrated` ("Rehydrated {what}",
`success`, or `warning` with `rehydrateChanged` — "Setup modified tracked
files: {files}" — as the description), `rehydrateFailed` (`danger`, 8s, the
`WORKTREE_PROVISION_FAILED` message as the description).

### Repo-group Dehydrate pill (CleanupView.vue)

`cleanup.dehydrateGroup` ("Dehydrate {count} idle"), `aria-label`
`cleanup.a11y.dehydrateGroup`. Sits in the repo-group header's right-aligned
action group, **left of** the `Sweep {n}` pill, `gap: 6px`. Same geometry as
that pill (`padding: 4px 10px`, 10.5px/600, `rounded-sm`), **neutral** chrome —
`border-border-2 bg-surface text-text-2`, `hover:bg-surface-2 hover:text-text`
— with an 11px `PackageMinus` glyph: dehydration is reversible and is not a
sweep, so it takes neither green nor red. Counts rows that are dehydratable
(rank 6 legal) and whose last commit is at least `ReaperPrefs.dehydrateIdleDays`
old (default 7); an unknown age is never idle. Acts on real state, not the
filtered view — the sweep pill's rule. Hidden entirely at zero, never disabled
except while a confirm is open.

### Cleanup footer pill (StatusFooter.vue, lands in Reaper PR4)

> **Superseded by T443** — see "Workspace GC — unified Cleanup / Footer pill": one `Recycle` pill replaces this pill and the Containers pill. The text below is the history of the Trash2 pill.

Contract only — the pill itself is wired in a later PR. Right
cluster of the footer, before the fleet pill: a `Trash2` icon (12px,
`currentColor`) + `$t('cleanup.footerPill')` + a count badge
(`bg-green-soft text-green rounded-full`, tabular-nums) — visible only
while `reaper.totals.harvestable > 0`. Click **toggles** the Cleanup takeover
(`ui.toggleCleanup()`); while it is open the pill inks `--accent` and carries
`aria-pressed` (footer active state — see "Takeover dismissal").

### Workspace GC — unified Cleanup (T443)

**Source of truth:** the operator-approved mockup 3, revision 1 (disk-first treemap), promoted to
`docs/specs/2026-10-07-workspace-gc/spec.html`, and the Workspace GC spec §3/§6/§9. This section is
the contract the components are built against; where it says "supersedes", the older Cleanup and
Containers sections above and below keep their text for the parts it does not name.

One engine, one door. The Cleanup takeover (`CleanupView.vue`) is the **single home** of cleaning:
worktrees, the Docker stacks hanging off them, orphan volumes and Docker housekeeping. The Containers
takeover stays as an **inspector**; its sweep button routes here. One footer pill, one Settings tab.

**Supersedes** (named, not implied): the toolbar KPI line, the global "Sweep N green" button, the
per-repo "Sweep N" pill and the worktree rows of "Cleanup takeover" / "Cleanup row" for `worktree`
and `detached-worktree` kinds; "Cleanup footer pill"; "Containers footer pill"; the background-scan
and zombie controls of "Containers settings pane" that the GC prefs now cover. `local-branch`,
`remote-branch` and `hidden-folder` rows keep the old row UI, in the "Other leftovers" section.

#### Buckets — three encodings, never colour alone

| Bucket         | Colour triple (fill / line / ink)                                   | Pattern                                                                                                                                            | Icon           | Word             |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------- |
| Ready to clean | `--color-green-soft` / `--color-green-line` / `--color-green`       | solid fill                                                                                                                                         | `circle-check` | "Ready to clean" |
| Needs review   | `--color-warning-soft` / `--color-warning-line` / `--color-warning` | **hatch**: `repeating-linear-gradient(135deg, transparent 0 4px, var(--color-warning-soft) 4px 8px)` over the soft fill (4px = spacing step `s-1`) | `circle-help`  | "Needs review"   |
| In use         | `--color-surface-2` / `--color-border-2` / `--color-text-3`         | plain neutral fill                                                                                                                                 | `lock`         | "In use"         |

A block that is **planned, not done** (first-cycle report-only) takes a dashed border. An aggregate
("N smaller") takes a dotted border and an italic label. The hatch may also be reused by the existing
`blocked` chip; it is defined here once.

#### Page anatomy (top to bottom)

1. **TakeoverShell header** — `Trash2` icon, title, close (unchanged, see "TakeoverShell").
2. **Toolbar row** (`padding: 12px 22px`, `border-b border-border`, wraps): the **summary line**, the
   **hero button / progress chip**, the autopilot badge, the "Autopilot settings" Ghost button (opens
   Settings → Cleanup), the Map/List `SegmentedControl` (`size="sm"`; each option carries its icon,
   `layout-grid` / `list`, 12px) and a **rescan icon button** (Ghost, icon-only, `RefreshCw` — it spins while
   a scan runs; `aria-label` "Scan now").
   - Summary line: `Recycle` icon (`--green`), 13px/20px `--text-2`, then
     `{n} GB reclaimable · autopilot on|off · next cycle in {t}`; the size is 600-weight `--text`.
     "Reclaimable" is everything not In use plus orphan volumes (ready + needs review + orphan volumes);
     Docker build cache is added only when the engine reports it (see "Docker card").
   - Autopilot badge: Badge Success "Autopilot on · every {interval}" or Default "Autopilot off".
3. **Selection bar** (only with ≥1 checked block) — the takeover's existing selection band
   (`border-b border-border bg-surface-2`, `padding: 8px 22px`): `square-check` icon (`--accent`), the
   count `N selected · X GB` (13px; numbers 600-weight `--text`), then **Remove selected** (Danger,
   `trash-2`), **Dehydrate** (Soft, `package-minus`), **Keep** (Ghost, `bookmark`) — the same icons as the side
   panel's actions — **Ask for an opinion** (Soft, `sparkles`; enabled whenever the selection
   holds Needs review items — see "Opinion chip"), a `⇧` hint (`kbd`) and a right-aligned "Clear selection" ghost link.
4. **First-cycle banner** (only while `firstReportAcknowledged` is false and a report exists): see below.
5. **Split bar** (`.gc-split`): a 32px bar of up to four segments — _Ready to clean_ (ready worktrees only, Ready triple, so
   it agrees with the hero's count), _Docker (cleaned each cycle)_ (build cache + dangling images, Ready triple,
   `Container` icon, left out when there is nothing to take), _Needs review_ (hatch), _In use_. Widths
   proportional to bytes with a **144px minimum** (so "Docker" and its size both fit), `gap: 2px`, segment radius `--radius-sm` (3px), 11px text, label left, size
   right. A caption row above (eyebrow, 10.5px/500 uppercase `--text-4`) names the groups — a caption that does not fit wraps onto a second line instead of ending in an ellipsis, and the bars stay aligned along the bottom; the
   last-cycle line (11px `--text-4`) sits under it — **while a job runs it is replaced by "Cleaning now · N left"**
   (11px `--accent`; "Cleaning now" when nothing is left to count). There is no "Cancel after current": the
   engine has no verb to stop a running job, so it is not drawn.
   **Legend row** (`.lg`, 11px/16px, `gap: 16px`) directly under the split bar: three items — bucket icon +
   word in the bucket ink + a short gloss ("Ready to clean · cleaned by one click or the autopilot",
   "Needs review · your call", "In use · never touched") — then, pushed right in `--text-3`,
   **"Block area = size on disk · click a block to act"**. Without byte sizes the area note is dropped.
6. **Map** (or the List fallback), then the **Docker card**, then **Needs review**, then **Other leftovers**
   and **Recent cleanups** (the existing tombstone footer).

#### Treemap

- **Data hierarchy:** repo → bucket group → worktree block; the third level (deps / owned volumes /
  checkout) lives in the side panel as the composition bar. Area = bytes on disk.
- **Layout — shelves, growing downward.** Computed in `lib/gc-treemap.ts` from byte sizes; ties break by name so
  the order is stable between scans. The operator's rule (BUG-171): _the map may grow downward_ — vertical
  scrolling is fine, squeezing everything into the fold is not.
  - **Regions sit on shelves.** A shelf holds as many repo regions as fit at the **340px minimum width**
    (`floor((W + gap) / (340 + gap))`); regions fill shelves biggest first and the count per shelf is
    evened out (11 repos at 1298px lay out 3 / 3 / 3 / 2). Inside a shelf the widths are proportional to
    bytes with a floor at the minimum, so a small repo never collapses to a sliver. Byte totals are
    always printed on the region header. Gutter: **`s-2` (8px)** between regions and between shelves.
  - **Groups stack inside a region**, top to bottom (Ready to clean → Needs review → In use), each at the
    region's **full width** — so a bucket header always has the room for its whole word. A group's body
    height is its bytes at a fixed density of **24,000 px² per GB**, clamped to **48–560px**; a shelf is as
    tall as its tallest region, and the shorter ones spread the slack over their groups.
  - **Blocks inside a group are squarified** (Bruls et al.): area stays proportional to bytes.
  - The canvas has no fixed height; the page scrolls. Drilled into one repo the single region takes
    the full width and its groups grow the same way.
- **Repo region** (`.tm-region`): `border-border`, radius 7 (`--radius`), `bg-surface`. The header is **two
  lines, 50px**. Line 1: the **repo label** (mono 12.5px/600 `--text-2`, the last two path segments —
  `proj/www`, `org/portal`) on the whole line, with an ellipsis and the **full path as its `title`**; then
  **Select all in repo** (11px link in `--text-2`; icon-only 22px Ghost `list-checks` under 460px, which has
  no room for the label). Line 2: meta 11px `--text-4` (`61 worktrees · 27.8 GB`) and the count badges
  (Ready to clean / Needs review / In use) pushed right. **Counts go before the name does**: under 300px
  the worktree count drops from the meta and the size stays; the name is never the first thing to yield.
  Clicking the repo name drills in (breadcrumb + bucket filter `All / Ready to clean / Needs review / In use`).
- **Bucket group:** 22px header — bucket icon + eyebrow word in the bucket ink (`white-space: nowrap`, never
  truncated), count right in 11px `--text-3`. **The count drops first**: under 220px of region width it
  is hidden before any letter of the word is cut. Its area is itself a readable number.
- **Block** (`.tm-block`): `position: absolute; inset: 2px` inside its cell (a 2px gutter between
  blocks), radius 3, 1px border in the bucket line, `padding: 4px 6px`, 11px/14px text. Label ladder by
  **container query** on the cell: full name → ticket id (`PROJ-0412`) → `#0412` → icon only; a name
  that does not fit ends in an ellipsis.
  - **Readability rule — a visible block shows its label AND its whole size.** A block is drawn only when
    its cell is at least **88 × 44px** (block 84 × 40: icon + name line, size line, padding). Anything
    smaller folds into the group's **"N smaller"** block, which must meet the same minimum — it is given
    as much area as it needs, and if that still is not enough it takes in the next smallest block. The threshold is therefore geometric, not a
    byte constant: a taller map folds less. The "N smaller" block is clickable and opens that set as a list.
  - **A number is never truncated mid-digit.** The size is drawn whole or not at all: under 72px of cell
    width it is hidden (the tooltip keeps it); an ellipsis is for names only.
  - **Tooltip (`title`)** names the block's _real_ bucket and reason, never a borrowed sentence: the name,
    the repo, the size, then **bucket — reason**. Ready to clean reads "Merged, clean and idle past the
    grace period."; Needs review reads its reason code's sentence; **In use** reads one sentence derived from
    the bundle's own facts, first match wins: "the repo's main checkout", "on your never-clean list",
    "a session is working here right now", "its pull request is still open", "no sign of when it was last
    used", "last activity {ago}, inside the grace period", "you marked it Keep".

- **States** (the block's whole state machine; the row in Needs review mirrors it):

  | State        | Look                                                                                                                                              |
  | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
  | rest         | bucket triple                                                                                                                                     |
  | hover-linked | `box-shadow: 0 0 0 1px var(--color-text-2)` — the list row under the pointer outlines its block                                                   |
  | selected     | single block whose panel is open: `border-color: --accent` + `box-shadow: 0 0 0 1px --accent`, **no badge**                                       |
  | checked      | multi-select: the selected outline **plus** a 16px check badge (top-right, `--accent` fill, `--accent-ink` `check` glyph) — never colour alone    |
  | planned      | dashed border (first cycle)                                                                                                                       |
  | busy         | `--accent-soft` fill, `--accent-line` border, a 6px `--accent` dot with a 3px `--accent-soft` halo, and a 2px determinate sliver along the bottom |
  | done         | `opacity: 0.45`, dashed border, word "freed" + `check`; after `--dur-slow` it is removed and the layout is recomputed                             |
  | failed       | `--color-red-line` border + `triangle-alert` in `--red`; it is a Needs review block again                                                         |

  Only **Needs review** blocks are checkable; ready items are cleaned by the hero, In use blocks are never touched.

- **Interaction:** click opens the panel; **Shift+click** toggles checked; **Esc** clears the selection
  then closes the panel; arrow keys move to the nearest block in that direction, **↩** opens the panel,
  `K` keep · `R` remove · `D` dehydrate · `A` ask (disabled: it does nothing). **The four letters are wired**
  on the open panel and on a focused block: each acts only when the matching button is shown and enabled,
  never while a dialog is open, a field is being typed in, or a modifier key is held. Blocks are real `<button>`s with
  `aria-pressed` (checked) and an `aria-label` that states bucket, size and any busy/done/failed word.
- **Layout stability:** a finished item fades (`--dur-slow`) and the layout is recomputed **once per
  finished item**, never on pointer movement, so a block does not slide away from the cursor while it is
  being aimed at. There is no freeze-on-hover.
- **No bytes (Windows, `measureDiskBytes` null):** the map is unavailable; the List is the only view and
  the toggle says why. Bucket counts still render.
- **List fallback** (`.ls-*`): three bucket groups; rows `20px 260px 160px 1fr 70px` (icon / name + repo /
  6px bar / reason or note / size), the bar filled in the bucket ink.

#### Hero button and progress chip

The **hero** is the screen's single **Primary** button (28px) right after the summary line, so "how
much" and "do it" read as one sentence: `Clean 12 ready · 6.0 GB`. It acts on proven-ready items only.

- **Idle:** Primary, `Recycle` icon, label with count and bytes.
- **Nothing to clean:** disabled (`opacity: 0.4`), label stays **"Nothing to clean"** — the state is
  readable, not just dimmed.
- **Before the first scan:** disabled Soft button reading **"Scanning…"** with a spinning `Loader2` (see "First scan"); never "Nothing to clean", which would claim a result.
- **First-cycle state:** the hero is a **Soft** button, because "Enable autopilot" owns the one Primary.
- **Running** (the hero stops being a button): a **progress chip** — Badge Accent triple at button height
  (28px): static `--accent` dot (6px, 3px `--accent-soft` halo), `Cleaning 3/12 · 1.4 GB freed`, a
  **40 × 4px determinate bar** (`--accent` on `--border-2`, radius full) counting items, not bytes.
  `aria-live="polite"`, announcing at most once per finished item. The chip has no control: the engine
  has no cancel, so "Cancel after current" is **not drawn**.
- **Re-attach:** closing and reopening the view, or reloading the renderer, rebuilds the chip from
  `gc:jobs`. The view never awaits the `gc:clean` call.

#### Side panel (320px)

Dialog anatomy (`--surface`, `--border-2`, radius 10, 16px padding), docked right of the map;
**below 1100px it overlays the map as a popover** instead of docking (the mockup's honest problem).
Top to bottom: name (13px mono, `--text`) and repo (11px `--text-4`); size (20px/28px, 500); the
**composition bar** (8px, `--green` deps · `--border-2` checkout, with a legend of 11px rows and sizes)
— volume bytes are not reported by the engine, so a worktree's volumes are listed by name, never drawn; **Why it is here** (13px
`--text-2`, the engine's one-sentence reason, dirty-file count in `--warning`); **Takes with it** (the
confirm dialog's preview: stack containers, deps, checkout, branch; a worktree's volumes are kept and a
note says so); then the actions, stacked,
`justify-content: flex-start`, shortcut `kbd` right: **Remove** (Danger), **Dehydrate** (Soft),
**Keep** (Ghost), **Ask for an opinion** (Soft, `sparkles`) — and, once the block has an opinion, an **Opinion** section above the
actions (see "Opinion chip"). A Ready to clean block's panel offers
"Clean now" only. An orphan-volume block shows its project name and "no known worktree".
A failed or refused item's panel adds **what happened** — never a reconstructed history. The engine reports
only the step an item halted at and why, so the panel says **"Stopped at {step}"** plus a human sentence
for the reason, or, for a refusal made before anything ran (the pre-flight re-probe), **"Nothing was
changed"** plus the sentence. **A raw engine error is never visible text**: a code the catalog knows gets
its own sentence, anything else reads "Harnu stopped this item for a safety check." and the raw text travels
only with the **Copy error** action. A review item whose reason is `nested-worktree` or `locked` has **no Remove (and no
R)** — main always refuses it (removing the folder would trash the inner worktree too; git has the worktree
locked) — and an 11px `--text-3` line says which. It never draws ✓ for a step it was not told
ran, and it never shows volumes as removed — a worktree clean never removes one. Actions: **Retry**,
**Keep**, **Remove**. **Retry follows the item's _current_ bucket**: a ready item re-opens the ready
(bulk-style) confirm for that one id, a review item the review confirm — never a dialog that would send
nothing.
A pnpm hardlinked store can show deps that free nothing: the panel carries the engine's note.

#### Needs review list

A ranked list under the map, biggest first: grid `20px 220px 1fr 64px auto` (leading slot / name + repo /
one-sentence reason / size / row actions), `padding: 12px 10px`, radius `--radius-sm`. The leading slot
is the bucket icon, which becomes a hover-reveal checkbox (the Cleanup row pattern) and shows
`square-check` in `--accent` when checked; a checked row is `--accent-soft` with `--accent-line`; a failed
row is `--red-soft` with `--red-line` and `triangle-alert`. Header: eyebrow "Needs review" in `--warning`,
the count, and two header buttons that act on the **whole list** — "Ask for an opinion on all {n}"
(Soft, `sparkles`) and "Remove the {n} marked safe" (Success, hidden until at least one safe opinion
is current). Each row carries its **opinion chip** under the reason (see "Opinion chip"). Hovering a row
outlines its block. Footer: the keyboard hints (`kbd`).

#### Opinion chip ("Ask for an opinion", T444)

An **advisory, on-demand** verdict on a Needs review item, produced by a read-only headless session.
It never removes anything and never runs by itself: the timer and the autopilot do not ask. The three
entry points are the selection bar's button (the checked items), the list header's "on all {n}" (every
Needs review item, orphan volumes included) and the block panel's button (that one item).

- **Chip** (`CleanupOpinionChip.vue`): the Badges geometry (`2px 8px`, pill, 11px). Verdicts use the
  existing variants, label always in words (never colour alone): **safe** → Success, **keep** → Accent,
  **unsure** → Default. The chip's `title` is the reason, then the evidence on a second line.
- **Pending** (a request in flight for that item): a Default chip with a 6px `--accent` dot using the
  existing `.anim-shimmer-dot` helper and the word "Asking…". No chip is drawn for an item nobody asked about.
- **Panel section "Opinion"** (above the actions, only when there is an opinion): the chip, the reason in
  13px `--text-2`, and the evidence as an 11.5px `--text-3` line prefixed "Evidence". Nothing else.
- **An opinion is about the item as it was when asked.** Main binds each answer to its cache key
  (reason, fate, pull request state, head, the sorted dirty files, the volume) taken when the question
  went out. If the item moves while the model thinks, the answer arrives marked `stale` and is dropped;
  the renderer also drops a result whose asked-for fingerprint no longer matches the item. A chip that
  main cached is checked against main's cache again after every snapshot (`gc:opinion:cached`), so a
  change the snapshot does not carry (the dirty files, the pull request state) clears it too.
- **"Remove the {n} marked safe"**: counts only items that are still Needs review and whose opinion is
  still current. **Right before the dialog opens** it asks main's cache (`gc:opinion:cached`) about the
  marked ids again, under each item's current key, and pre-selects only those main still confirms as
  `safe`; the rest lose their chip and a one-line toast says how many were left out. If main could not be
  asked, nothing is selected. An item main always refuses to remove (a worktree that holds another one,
  or one git has locked) keeps its chip but is never counted or pre-selected. It **pre-selects those items and opens the existing remove dialog**; it never removes by
  itself. The binding is the `expected` the dialog captures **when it opens**, exactly as for Remove
  selected: the dialog sends `gc:clean(ids, { confirmed, expected })` and main refuses any item whose
  facts differ from that `expected` (`changed-since-confirm`). The opinion is advice shown before the
  dialog; it is not what `gc:clean` checks.
- **Failure and doubt are the same chip**: an advisor that could not run, answered badly, or marked
  something safe without evidence reads **unsure**; the reason says why. A failed answer is not
  remembered, so asking again asks again.
- **After a reload the chips come back by themselves.** Main keeps the opinions; when the Needs review
  list renders, the store asks main's cache (`gc:opinion:cached`, a read that never asks the model) for
  every item without a chip. Only an answer that still fits the item is returned (same head, dirty
  files, fate and reason); an item that changed shows no chip and costs a new ask.
- **What the session is given.** It reads files and runs nothing: it runs in the repository folder with
  `Read`, `Grep` and `Glob` only, started with `--tools Read,Grep,Glob`, which is what restricts its roster (`--allowedTools` and
  `--disallowedTools` are only permission rules and leave the built-ins offered; the real CLI then
  still offers CronCreate, EnterWorktree, RemoteTrigger and more). It has no shell, no tool that writes
  a file, no web tool and none of Harnu's own tools; `Bash` is denied entirely (even a git rule can write
  files through `--output=<path>`, which a prefix rule has no way to forbid), as are `Edit`, `Write`,
  `NotebookEdit`, `WebFetch` and `WebSearch`, and no MCP server, skill or plugin is configured.
  Everything git knows is in the dossier, which main computes. What it opens, the dossier and any file,
  is sent to the model like any request.
- **Where it reads.** There is no allow rule for Read, Grep or Glob: an allow rule such as
  `--allowedTools Read,Grep,Glob` auto-approves reads anywhere the user can read, while with none the
  Claude CLI's own permission check keeps a file, a search and a listing inside the folder it runs in (a
  symlink out of it included). That check is not a guarantee: the CLI may still allow a few of its own
  working folders, and two have been found. So Harnu explicitly blocks Claude's own data folder
  (`Read`, `Grep` and `Glob` of `~/.claude/**` and of `CLAUDE_CONFIG_DIR` when set; the project folder of
  the repository sits there next to the transcripts) and Claude's temp folder (`claude-<uid>` under the OS
  temp dir, `/tmp` and `CLAUDE_CODE_TMPDIR`, where other sessions' task outputs and scratchpads live),
  and auto memory is switched off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, because the CLI would otherwise
  inject that project's `MEMORY.md` into the model's context). The folder it runs in is chosen on real
  paths: HOME, an ancestor of HOME or a filesystem root is replaced by a fresh empty directory of its
  own, never the shared temp dir. Inside the repository folder any file can be opened, ignored ones such
  as `.env` included, and a hard link there to a file elsewhere reads as a file inside it. A worktree
  outside the repository folder is not readable. On Windows, where there is no per-user temp folder name
  to block, only `~/.claude` (and `CLAUDE_CONFIG_DIR`) are explicitly blocked. A blocked folder whose path
  holds a comma, a parenthesis or a control character has no safe form in a deny rule (a comma
  separates rules, parentheses end one): then the advisor is not run, every item is answered `unsure`
  ("Harnu could not express a safety rule for <folder name>"), and nothing is cached.
- **Git facts fail closed.** A dossier field that comes from git is either computed or marked
  `COULD NOT BE COMPUTED (reason)`: a failed diff or status is unknown, not "no difference" or "none". An
  item with a missing fact is answered `unsure` by Harnu without asking the model, has no cache key (so it
  is never cached and never confirmed as safe), and the prompt tells the advisor never to answer safe for
  such an item. The default branch is resolved from `origin/HEAD`, then `origin/main`, `origin/master`,
  `main`, `master`; none existing is an error, not a silent fallback.
- **Cost disclosure:** the button's tooltip says it uses the model on demand
  ("Asks a read-only model session. Uses tokens."). Docs say the same.

#### Bulk-clean and remove-selected dialog (`CleanupBulkConfirmDialog.vue`)

Dialog anatomy (radius 10, `--border-2`, `--shadow-pop`) at `min(720px, 90vw)`, backdrop
`rgba(0,0,0,0.55)`. Header: title, subtitle and a **`×` close button** (Ghost icon-only, `aria-label` "Close", same as Cancel).
Under it the **breakdown line** (11px/16px `--text-3`): "{n} stacks stopped · {m} dependency folders removed ·
{k} worktrees trashed" (and "· {v} volumes deleted" only when orphan-volume rows are in the list — a
worktree's volumes are never counted). A **bounded list** at `--fv-rail-list-max-h` (280px, `.scrollable`,
focusable, arrow-key scroll) of rows `20px 1fr 64px`: bucket icon, **mono row title** `repo › worktree`
(12.5px mono `--text`), a mono sub-line `branch {branch}` (11px `--text-4`), the **removal chips** (each with
a 10px icon: `container` stack, `package-minus` deps, `folder` checkout, `git-branch` branch, `database`
volume), size right.

- **Removal chip** (`.wchip`): Badge Default geometry at 10.5px/14px, radius 3, listing what the row takes
  with it — stack · deps · checkout · branch for a worktree; **a worktree's volumes are never listed**
  (they are kept). An orphan-volume row carries the one **volume chip, which uses the Warning triple**.
- **Warning callout** (the SweepConfirmDialog callout): `--warning-soft` / `--warning-line`,
  `triangle-alert`. Ready variant: _Volumes are kept. They show up in Needs review afterwards._; code,
  branch and dependencies can come back (archive refs, OS trash, `setup`) — and how. A row that is an
  orphan volume adds _Volumes cannot be restored_ in `--warning`. Remove-selected variant: each row also carries its
  one-sentence reason and, when it has one, its **opinion chip** with the evidence line under it; a stronger line names how many picked worktrees hold work that no other branch has,
  and says their code stays recoverable from archive refs and the OS trash.
- **Footer:** total (12.5px/500) left, reading **"{n} ready · {size}"** for the ready dialog and
  **"{n} selected · {size}"** for remove-selected; **Cancel** (Ghost) and the confirm, which carries a leading
  icon (`Recycle` on Success, `Trash2` on Danger). Confirm is **Success** for proven-ready items (positive
  bulk reclaim, like today's Sweep), **Danger** for remove-selected (it can include code that exists nowhere
  else but an archive ref). Confirming calls `gc:clean(ids, { expected })` for ready items and
  `gc:clean(ids, { confirmed, expected })` for review items, then closes the dialog at once.
- **`expected` is captured when the dialog opens**, not when it is confirmed. If the data behind an open
  dialog changes (an autopilot cycle or a job refresh), the dialog shows "This changed since you opened it —
  review again" in `--warning` and **disables the confirm until it is reopened**; the confirm never sends facts
  newer than the ones the operator was shown. A rejected `gc:clean` call shows an error toast.
- **Keyboard:** Esc or Cancel closes; **focus starts on Cancel, never the confirm button**; Tab cycles
  inside (focus trap); ↩ activates only the focused control.

#### Docker card

Its own region under the map (`.dk`, `border-border`, radius 7, `bg-surface`): header `container` icon,
title, a **subtitle** (11px `--text-4`: "runs each cycle · {size}", what the next cycle could reclaim from
Docker) and an **Inspect stacks** text link (11px/500 `--text-2`, right-aligned) that opens the Containers
inspector — the only in-app door to it now that the Containers footer pill is gone. (The mockup's "{n} stacks in use, never touched" note is omitted: the snapshot carries no such count.) Under the header, a 4px **split bar** (radius full, gap 2px) divides that reclaimable total by kind —
build cache, dangling images (Ready green) and orphan volumes (Needs review warning); it is omitted when
every figure is zero or unavailable. (The mockup's per-block "older than N days vs kept" bar needs the cache's
total size, which the snapshot does not carry.) Three blocks (Ready triple for cache and images, **Needs
review triple for orphan volumes**, `min-width: 200px`): **build
cache**, **dangling images**, **orphan volumes** — name, size right, a one-line sub, a toggle
(`ToggleSwitch`) on the cache and image blocks, both bound to `categories.dockerCache`. The orphan-volumes
block has **no switch** — a volume is never removed automatically — and is drawn in the **review (warning) colours** because it is the item the operator must act on, not one the
autopilot takes; it carries the Warning badge "can't be
restored", the project name of each volume and the line "Never removed automatically. Remove each one
yourself in Needs review." When the snapshot says the orphan list is empty **by construction**
(`docker.orphanVolumesHidden`: an unresolved compose project name, or the compose scan hit its limit), the
block's size line reads "hidden" in `--warning` instead of a confident "0 volumes", and a **two-line-at-most**
`note` in `--warning` with an `EyeOff` icon explains why — "Orphan volumes hidden: a compose project name
couldn't be resolved in {n} folders" (or "…: the compose scan hit its limit in {n} folders") — followed
inline by a **"Show folders"** disclosure (`aria-expanded`). The folder names stay out of sight until it is
opened; opened, they are a mono 11px list of basenames, each with its full path as a tooltip, capped at
`max-h-32` and scrolling inside — never a comma-separated wall. It disappears once the name resolves.
The hint is **only shown when it can be true**: the main side keeps `orphanVolumesHidden` only while at least one
volume is labelled with a compose project and used by no container (running or stopped). When every volume belongs
to a live stack, or Docker has none, the list is empty because there is nothing to list, and the size line reads
**"No orphan volumes"** in `--text-3` with no warning note.
**Scope line:** under the header, one 11px `--text-4` caption states what the card counts — "Counts only build
cache older than {n} days and dangling images. Images in use and the volumes of live stacks are never counted."
**Compact:** the three blocks sit in an auto-fit grid (`minmax(240px, 1fr)`) and are as tall as their own
content (`items-start`) — a short block is not stretched to the tallest sibling's height. The snapshot's `docker` figures feed the two blocks:
`buildCacheReclaimableBytes` ("{size} reclaimable") and `danglingImages` ("{n} images · {size}"); a `null`
figure reads **"Size unavailable — Docker did not answer"** in `--text-3`, never a confident zero. Once a
cycle has run, a second 11px `--text-3` line adds "Last cycle reclaimed {size}". Both figures count in the
summary line and in the split bar's Ready segment while `categories.dockerCache` is on. Zero state: real
zeros when Docker says so.

#### First-cycle banner

`.fc`: `--accent-soft` fill, `--accent-line` border, radius 7, `padding: 12px 16px`, `Recycle` icon in
`--accent`. Text 13px/500: "Found {n} ready items, {size} — enable autopilot?", 11px sub-line "The first cycle only
reports; nothing is deleted until you turn it on." Buttons: **Enable autopilot** (the screen's one
Primary) and **Not now** (Ghost). Enable calls `gc:ackFirstReport` **and** `gc:prefs:set({ autopilot: true })`.
Ready blocks are dashed ("planned, not done"); the summary reads "autopilot off".

#### First scan — never "All clean" before anything was scanned

The Cleanup gather reads the Reaper's last scan, which does not exist until the first scan has run. While
`reaper.snapshot` is null the body is a **"Scanning your worktrees…"** state (spinning `Loader2`, 13px
`--text-2`, a 11px `--text-3` line under it) and nothing else: no split bar, legend, map, Docker card or
"All clean". The hero is a disabled Soft button reading **"Scanning…"** — there is nothing to clean yet. The
screen starts that first scan itself and re-reads the gather when it ends. If the scan throws, the body
reads "The first scan didn't finish" in `--red` with the error and the toolbar's rescan button stays enabled.
"All clean" below is reserved for a **finished** scan that found nothing.

#### Empty state

`.em`: a green `circle-check` icon, "All clean" (20px/28px, 500), "Nothing to reclaim. Autopilot checked
{ago}." The map stays, showing only In use blocks, so the screen still answers "where is my disk";
the hero is disabled "Nothing to clean"; Docker shows zeros.

#### Footer pill — one pill (supersedes "Cleanup footer pill" and "Containers footer pill")

One `Recycle` pill (12px, stroke 1.6) in the footer's right cluster, before the fleet pill, 20px high,
`padding: 0 8px`, `gap: 6px`, 11px, radius `--radius-sm`. It replaces both old pills. Click **toggles the
Cleanup takeover** (`ui.toggleCleanup()`); while open it inks `--accent` and carries `aria-pressed`.

| State     | Content                                                          | Ink                                         |
| --------- | ---------------------------------------------------------------- | ------------------------------------------- |
| idle      | `Recycle` icon + `17 GB` (reclaimable total)                     | `--text-2`, hover `--text` on `--surface-2` |
| running   | `Recycle` icon + accent dot + `Cleaning 3/12`                    | `--accent`                                  |
| attention | `Recycle` icon + `1 needs review` (items that need the operator) | `--warning`                                 |

`aria-live="polite"`, one announcement per finished item. Hidden only when there is nothing to reclaim,
nothing running and nothing needing attention. An optional hover popover (the footer popover anatomy,
`--shadow-pop`, radius 7) previews the split.

#### Toasts

The documented Toast with an optional description and an action link — no new variant.

| Outcome         | Kind      | Title                                    | Action         |
| --------------- | --------- | ---------------------------------------- | -------------- |
| all ok          | `success` | `Freed {size} · {n} ready items cleaned` | "View journal" |
| partial failure | `warning` | `{n} cleaned · {m} needs review`         | "Review"       |

The count behind **attention** is the items that need operator action: a failed item, or a refusal the
operator did not choose. A refusal that is the operator's own setting (`kept`, `never-clean`) is not counted.

A toast shows only while the window is focused; otherwise the native notification applies (see
"Notifications"). Every run lands in the Activity bell and the journal.

#### Units

Every Cleanup surface — summary line, hero, chip, split bar, legend, map, panel, dialog, Docker card, toasts,
footer pill and Settings — formats bytes with the app's `formatBytes`, which is **decimal** (`6.44 GB`,
`715 MB`). The mockup and the spec write GiB; that is its sample data's unit, not the screen's. One system on
every surface, so two numbers on the same screen can be compared by eye. A native notification or
Activity line built in the main process is the one place a different unit could slip in; it uses the same
decimal system.

#### Type and spacing in the Cleanup files

The Cleanup surfaces use the §3 scale through Tailwind `text-*` tokens declared in `main.css`
(`text-eyebrow` 10.5/14 + the `.eyebrow` class, `text-caption` 11/16, `text-ui` 12.5/18, `text-body` 13/20,
`text-subtitle` 15/22, `text-title` 20/28 with `tracking-title`), spacing on the 4px grid with the 2px half
step Tailwind v4 allows (`h-5.5` = 22px, `py-0.75` = 3px), and the 3px radius as `rounded-xs`. Text that was
set at 10, 11.5 or 12px snaps to the nearest scale step (`caption`, `ui`). The layout dimensions of §4 are
`--gc-panel-w` (side panel 320px) and
`--gc-dialog-w` (`min(720px, 90vw)`) in `themes.css`, used as `w-(--gc-panel-w)`. The dialog backdrop
`rgba(0, 0, 0, 0.55)` is the documented one every dialog uses.

**Documented exceptions** (every raw size left in the files S5 created, listed once):

- **List-row column templates** — `grid-cols-[20px_1fr_64px]` (bulk dialog rows) and the three review/list
  row grids (`20px` icon · fixed name/branch column · flexible reason · size). They are per-list layouts, not
  reusable steps; a column that is a token elsewhere stays a token.
- **Treemap geometry** — the layout constants of `lib/gc-treemap.ts` (`TM`): region minimum width 340px, gutter
  8px, region header 50px, group header 22px, minimum cell 88 × 44px, density 24,000 px² per GB, group body
  48–560px. Block rectangles are computed from data and applied as percentages, so they are not tokens; the
  constants are asserted in `tests/gc-treemap.test.ts` and `tests/cleanup-design-contract.test.ts`.
- **The busy dot halo** — `shadow-[0_0_0_3px_var(--color-accent-soft)]` is the 3px `--accent-soft` halo of the
  6px static accent dot (see Motion below).
- **Settings → Cleanup rows** (`CleanupSettingsPane.vue`) keep the shared Settings-pane anatomy — inline 12px
  labels, 11.5px hints, 12/16px gaps — that every Settings tab uses (`SettingsDialog.vue`). Migrating the
  Settings family to tokens is one change for all panes, not a Cleanup-only one.

#### Motion

Fade-out of a cleaned block uses `--dur-slow` / `--ease` (opacity to 0.45, then removal); no new
keyframes and no new easing. The "busy" dot is static — a 6px `--accent` dot with a 3px `--accent-soft`
halo — because `.anim-pulse-dot` carries a green ring today; an accent variant of that class is a
follow-up, not part of this slice. `prefers-reduced-motion` already zeroes durations.

#### Settings → Cleanup (supersedes the Cleanup and Containers panes' overlapping controls)

One pane, the `CleanupSettingsPane.vue` anatomy (11px uppercase eyebrow, muted 11.5px intro, label-left /
control-right rows with `SettingHint`). Groups, 16px apart, every control writing through `gc:prefs:set`
(whole `GcPrefs`; main clamps and the pane re-syncs from the answer):

- **Autopilot** — `autopilot` toggle; **Run every** (`SegmentedControl`: 30m / 1h / 6h / Daily, the
  Reaper timer's interval); **Grace period** (days); **Per-cycle cap** (items).
- **What it cleans** — two toggles: `categories.worktrees`, `categories.dockerCache`; **Build cache max
  age** (days); and, instead of a volumes switch, a `--warning-soft` note: **Docker volumes are always
  kept** — cleaning a worktree never removes its volumes; they show up in Needs review as orphan volumes
  and each one is removed by hand — with "a removed volume cannot be restored" in `--warning`.
- **Never clean** — a list of absolute repo or worktree paths (`neverClean`), add/remove.
- **Scan** (Reaper-only, kept): scan in the background, notify, never delete remote branches, protected
  branches, minimum age. These are not GC prefs and are not duplicated anywhere.

The Containers pane keeps only what the inspector needs (its own scan timer and the idle clock for stacks
that belong to no worktree) and states that worktree-bound stacks are cleaned by Cleanup, with a link.

#### Entity map

`CleanupView.vue` (shell) · `CleanupTreemap.vue` · `CleanupBlockPanel.vue` · `CleanupHeroButton.vue` ·
`CleanupSelectionBar.vue` · `CleanupDockerCard.vue` · `CleanupReviewList.vue` · `CleanupListView.vue` ·
`CleanupSplitBar.vue` · `CleanupLegend.vue` · `CleanupFirstCycleBanner.vue` · `CleanupBulkConfirmDialog.vue` · `CleanupOtherItems.vue` ·
`CleanupOpinionChip.vue` · `lib/gc-opinion.ts` · `stores/gc.ts` · `lib/gc-treemap.ts` · `lib/gc-model.ts` · `lib/gc-jobs.ts`.

### Containers takeover (ContainersView.vue)

An eighth main-pane takeover, global like Cleanup: `ui.openContainers()` /
`ui.toggleContainers()`, registered in `VIEW_REGISTRY` as `containers`
(`titleKey: 'containers.title'`). The view never derives a verdict — it renders the main
process's `ContainersSnapshot` (`src/main/containers/containers-wire.ts`) as-is.

**Copy rule (operator decision, 2026-09-11):** "zombie" is the only user-facing word for a
forgotten stack. The UI never says "idle"; the duration row is **Unused for**; the bulk
button is **Stop N running**.

**Header: `TakeoverShell` chrome** — a Lucide `Container` icon (15px, stroke 1.6,
`--accent`) teleported into `#takeover-shell-icon`, the title, and the shared close `X`
pinned to the right edge by an `ml-auto` spacer teleported into `#takeover-shell-actions`
(the spec draws the close button flush right).

**Hero** (`flex flex-wrap items-end`, `column-gap: 36px`, `row-gap: 12px`,
`padding: 18px 22px 14px`): three stats, then the toolbar cluster pushed right (`ml-auto`,
`self-center`). Stats never shrink and captions never wrap (`whitespace-nowrap`); when the
main pane is too narrow for one line, the toolbar cluster wraps below the stats instead.

- A stat is a 20px/28px value (`font-medium`, `tracking-[-0.015em]`, tabular-nums,
  `--text`) over an 11px `--text-3` caption. The third stat ("in volumes — removal needs
  your confirm") is **at stake**, so its value reads `--text-2`, not `--text`.
- Values come from `totals`: RAM freed (`zombieRamBytes`), host ports released
  (`zombiePorts`), volume bytes at stake (`volumeBytesAtStake`). All three cover the whole
  "Needs you" set (zombie + orphan), so the hero equals what the bulk stop frees.
- Toolbar: "scanned {ago}" (11px `--text-4`), **Scan now** (default button, `RefreshCw`
  13px), **Stop N running** (primary button) — shown only while `totals.stoppable > 0`; it
  asks for no confirmation: stopping is reversible, the click is the consent — and
  **Clean up N stacks** (danger button, `Trash2` 12px), the mass-clean door.
- **Clean up N stacks** (danger button, last in the toolbar) is shown only while at least
  one stack is sweep-eligible — verdict `zombie` or `orphan`, running or exited, which is
  exactly `totals.needsYou > 0`. It is absent during the first scan and absent at 0. Unlike
  the bulk stop it never acts on the click: it only opens the **Clean-up dialog**, because
  a removal is not reversible. While a sweep runs it disables, spins a `Loader2` (11px) and
  reads "Cleaning… N of M" — M the stacks the sweep targeted, N how many the latest scan no
  longer reports. `Stop N running` is unchanged and disables for the same in-flight action.
- **N is what the operator ticked**, not what is eligible: the button counts the
  selected stacks, so unticking a row drops the number. With nothing ticked it is
  **disabled, never hidden** — the operator ticked their way to zero and the button has to
  stay where they left it, saying "Clean up 0 stacks"; hiding it at 0 is reserved for the
  case where nothing is eligible at all. `Stop N running` counts `totals.stoppable` as
  before and is untouched by the selection: stopping is reversible, so it stays one click
  over the whole "Needs you" list.
- **Nothing to stop** (`stoppable === 0`): both first stats go quiet (`--text-2` values)
  and their captions switch to "RAM held by zombie stacks" / "ports held by zombie stacks";
  the Stop button is absent.
- **Scanning** (first scan, no snapshot yet): each value becomes a static skeleton bar
  (`bg-surface-2`, 3px radius, 20px tall), the meta reads "reading docker…", and the Scan
  button is disabled with a spinning `Loader2` and "Scanning…". A rescan over existing data
  keeps the data on screen and only busies the button.

**Meter** (`padding: 0 22px 16px`, `border-b border-border`): an 8px pill track
(`bg-surface-2`, `rounded-full`, `overflow-hidden`, 2px gap) with one segment per running
stack, width proportional to its RAM, in snapshot order. Segment colors by verdict:
zombie and orphan `--green`, active `--accent`, protected and pending `--text-4`, unknown
`--border-2`. The legend below (`padding-top: 8px`, 10.5px `--text-3`, tabular-nums, 8px
swatches with a 2px radius) names each non-empty bucket: "zombie · X", "in use · X",
"main checkout · X", "not yet a zombie · X" (pending, provisional — shares the muted
swatch), "not attributed · X". While scanning the track is empty and the legend names the
three docker calls.

**Split** (fills the remaining height): a scrollable master list (`border-r border-border`,
`padding: 8px 10px`, `overflow-y-auto`) and the detail pane. Tracks are
`minmax(240px,340px) minmax(360px,1fr)`: at the spec's widths the master is exactly 340px;
in a narrower main pane (both sidebars open) it gives up to 100px before the detail does,
and below 600px the split scrolls sideways (`overflow-x-auto`, the Cleanup precedent)
rather than crushing the detail.

- **Eyebrows** — "Needs you" (zombie, orphan), "Leave alone" (active, protected, pending,
  unknown), "Recent": 10.5px/500 uppercase, `tracking-[0.07em]`, `--text-4`,
  `padding: 10px 8px 6px`. An empty section drops its eyebrow. The "Needs you" eyebrow is
  the one exception: it is a `flex items-center gap-2.5` row with `padding-left: 10px`, so
  its **select-all control** (below) sits in the same 14px column as its rows' checkboxes.
- **Stack row** — grid `1fr auto 56px 22px`, `gap: 10px`, `padding: 7px 8px 7px 10px`,
  `rounded-sm`: mono 12px name (truncating), verdict chip, RAM (mono 11px `--text-3`,
  right-aligned; "—" when nothing runs; "stopped" in `--text-4` when Harnu stopped it), and a
  22px slot. Hover `bg-surface`; selected `bg-surface-2` plus a 2px `--accent` bar drawn by
  the row's `::before` (`top/bottom: 7px`). **Quick stop:** a running "Needs you" row shows
  a 22px icon button (`Square`, 10px) in the last slot on hover only — it stops the stack
  without selecting it. Every other row leaves the slot empty.
- **Clean-up checkbox** — a **"Needs you" row only** carries a checkbox in the
  LEADING position, so its grid is `14px 1fr auto 56px 22px` with the same 10px gap. A
  "Leave alone" row keeps the four-track grid and has no checkbox: nothing there can be
  swept, and an unusable box would read as "Harnu could clean this if you asked". The box is
  the 14px control the Remove and Clean-up dialogs already use — `h-3.5 w-3.5`,
  `appearance-none`, `rounded-[3px]`, `border-border-2 bg-surface` — but it is a
  **selection**, not a destructive opt-in, so checked fills `--accent` with a `Check` (10px,
  stroke 3) in `--accent-ink` instead of the dialogs' `--warning`. It is always visible (not
  hover-revealed like the quick stop), carries `focus-visible:ring-1 ring-accent
ring-offset-1 ring-offset-bg`, and takes an `aria-label` naming its stack
  (`$t('containers.select.stack')`). **Every eligible stack opens ticked**, so the one-click
  clean-up is unchanged; unticking is how the operator leaves a stack out.
  - **Clicking or pressing Space on the box never selects the row** — the same isolation the
    quick-stop button has (`@click.stop`, and the row's Enter/Space handlers are `.self` so
    they never swallow the box's own activation). The detail pane keeps showing whatever was
    selected before.
- **Select all / none** — a 14px control of the same anatomy in the "Needs you"
  eyebrow, in the rows' checkbox column. Three states: **all** (checked, `Check`), **none**
  (empty), **mixed** (partly selected: `--accent` fill with a `Minus` 10px in
  `--accent-ink`, and the input's `indeterminate` property set, which is what maps to
  `aria-checked="mixed"`). Clicking it when everything is ticked clears the selection;
  clicking it in any other state ticks everything. Its `aria-label` says which it will do
  (`$t('containers.select.none')` / `$t('containers.select.all')`).
  - **The selection is keyed by stack id and survives a rescan.** It drops ids that vanish
    from the scan. A stack that appears AFTER the operator unticked something arrives
    **unticked** — a destructive action fails safe, and the operator never loses a stack to
    a box they never saw. While they have unticked nothing, arrivals are ticked, so the
    untouched flow stays one click over everything. "Select all" returns to that state.
- **Recent row** — grid `14px 1fr auto`, `padding: 6px 8px 6px 10px`, 11.5px `--text-4`:
  verb icon (`Square` stop, `Play` start, `Trash2` remove), mono who ("proj-54", or "3
  stacks" for a bulk action) + verb text, and a 10.5px tabular "ago". One row per journal
  tombstone (one per action, however many stacks it touched), newest first, capped at 10.
  Selectable like a stack row.
- **Verdict chip** — Cleanup's chip anatomy (10.5px/600, `padding: 3px 9px`,
  `rounded-full`): zombie `bg-green-soft text-green`, orphan
  `bg-warning-soft text-warning`, active `bg-accent-soft text-accent`, protected / unknown /
  pending `bg-surface-2 text-text-3`. Pending reads "zombie in Nd" (provisional).

**Detail pane** (`padding: 18px 22px`, flex column, `gap: 16px`): a scrolling body and the
action tiers pinned below it.

- **Title row** — a 15px `--text-3` icon (`Box` compose stack, `Container` standalone
  container, `Ghost` orphan, `Shield` protected, `CircleHelp` unknown, `History` a Recent
  entry), the mono 13px name, the chip (or, for a Recent entry, an 11.5px `--text-3` "when"
  line), a pulsing accent dot on active, then the nav buttons pushed right: ghost `sm`
  buttons with an `ArrowUpRight` 11px icon — "Go to session" (active only), "Open worktree"
  (zombie, pending, active, Recent), "Open folder" (protected). Orphan and unknown have no
  target, so no nav. A button renders only when Harnu knows the target folder or session.
- **Evidence grid** — `grid-cols-[150px_1fr]`, `row-gap: 7px`, `column-gap: 14px`, 11.5px:
  keys `--text-4`, values `--text-2` (mono paths at 11px). Value tones: `ok` `--green`
  (with a `Check` 12px), `bad` `--warning` (with an `X`), `live` `--accent`, and a deleted
  path struck through in `--text-4`. Rows per verdict follow the spec: Attributed by ·
  Worktree/Folder · Worktree exists · Harnu session · Unused for / State / Running. A mono
  value truncates with an ellipsis (full text in `title`); the plain suffix after it
  (" · 249.2 MB") never wraps.
- **Note** — `flex gap-2.5`, `padding: 10px 12px`, `rounded`, 12px/18px, 14px icon.
  `warn` (orphan: `bg-warning-soft border-warning-line`, icon `--warning`), `info` (active:
  `bg-accent-soft border-accent-line`), `quiet` (protected, pending, unknown, removed:
  `bg-surface border-border`, `--text-3`, icon `--text-4`), `error` (a failed action:
  `bg-red-soft border-red-line`, icon `--red`, docker's own message on a mono 11px line
  below the sentence).
- **Container list** — `border border-border rounded overflow-hidden`; rows
  `grid-cols-[minmax(0,1fr)_90px_80px_150px]`, `gap: 12px`, `padding: 7px 12px`, 11.5px, a
  `border-t` between rows: mono name, state (`--text-3`; exited `--text-4`; "stopping…" /
  "starting…" in `--warning` while an action runs), mono RAM (right, "—" in `--text-4` when
  none), and port tags (mono 10.5px, `bg-surface-2`, 3px radius, `padding: 1px 5px`).
  **Narrow detail** (the detail body is a size container; below 540px): the row drops to
  `minmax(0,1fr) auto auto` and the port tags move to a second line under the name
  (`col-span-full`, left-aligned, `row-gap: 4px`), so the name never collapses to nothing.
- **Restore box** (Recent entries) — under a "To undo" / "To bring it back" eyebrow: mono
  11.5px on `bg-surface border-border rounded`, `padding: 9px 10px 9px 12px`, with a 22px
  copy icon button pushed right. Long commands wrap (`break-all`, 18px line height).
- **Tiers** — `flex gap-2.5`, `padding-top: 14px`, `border-t border-border`; each tier is a
  button over a 10.5px `--text-4` caption (`--warning` for the active warning). Exactly
  what each verdict offers (PRD §3.4):

  | Stack                                 | Tier 1                                                               | Tier 2                                                               |
  | ------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
  | zombie, running                       | **Stop stack** (primary) · "Reversible · frees X"                    | **Remove…** disabled · "Stop it first"                               |
  | zombie, stopped                       | **Start stack** · "Back exactly as it was"                           | **Remove…** (danger) · "Asks first · volume kept unless you tick it" |
  | orphan, running                       | **Stop stack** (primary) · "Reversible · frees X"                    | **Remove…** disabled · "Stop it first"                               |
  | orphan, stopped                       | **Remove…** (danger) · "Asks first · volume kept unless you tick it" | —                                                                    |
  | active, running                       | **Stop stack** · warn "The session's app goes down with it"          | —                                                                    |
  | protected / pending, running          | **Stop stack** · "Reversible · frees X"                              | —                                                                    |
  | active / protected / pending, stopped | **Start stack** · "Back exactly as it was"                           | —                                                                    |
  | unknown                               | no tiers                                                             | —                                                                    |
  | Recent stop                           | **Start stack** / **Start all N** · "Runs the command above"         | —                                                                    |

  Manual stop on active and protected sends `force: true`; the main process refuses both
  without it. There is exactly one **Remove…**, and only a stopped zombie or orphan enables
  it — `docker rm` refuses a running container, and `--force` is never used.

- **In progress** — the acting button disables and swaps its icon for a spinning `Loader2`:
  "Stopping… N of M" (N counts the stack's containers already down), "Starting…". Its
  caption stays. The container list shows each container still pending as "stopping…".
- **Failed** — an `error` note above the container list ("Stop failed. Nothing changed —
  …", docker's message below it); the primary button reads **Try again**.
- **After a stop** a zombie stays under "Needs you" (its RAM reads "stopped") until it is
  removed; one Recent entry is written per action.

**Remove dialog** (`ContainersRemoveDialog.vue`, §6 Dialog anatomy): Teleport → overlay →
a 460px card (`bg-surface border-border-2 rounded-lg shadow-pop`, `padding: 22px 24px
18px`, `gap: 14px`). Title 15px/22px 500 ("Remove **name**?", mono 14px), a 13px/20px
`--text-2` sentence whose wording depends on the stack (orphan: its worktree is gone;
zombie: its worktree still exists, so running the stack again recreates it; standalone
container: it can't be restarted), the container list (mono 11px `--text-3` on `bg-bg`,
`border-border rounded`, `padding: 8px 12px`, name left and "exited Nd" right), then the
volume opt-in (`bg-warning-soft border-warning-line rounded`, `padding: 10px 12px`): a 14px
checkbox (`border-border-2 bg-surface`, 3px radius; checked fills `--warning`), "Also remove
volume **name** · size" (12px `--text`), and an 11px/16px `--warning` warning. **The checkbox
is always unchecked when the dialog opens.** Shared volumes are never offered. Footer: ghost
**Cancel** and danger **Remove N containers**; while removing the confirm spins and every
control disables; a failure shows an `error` note in the dialog and keeps it open. Esc and a
backdrop click cancel.

**Clean-up dialog — removed (T443).** The sweep button is now **"Open Cleanup · N stacks"** and routes
to the Cleanup takeover; the per-stack tick-list, the sweep dialog and its select-all header are gone. The
confirm for cleaning is the Cleanup bulk dialog (see "Workspace GC — unified Cleanup"). The text below that
describes the tick-list or the sweep dialog is history.

A sweep that did not fully succeed keeps the dialog open and shows an `error` note
(`bg-red-soft border-red-line`, `TriangleAlert` 14px) that says how many stacks were
cleaned and lists each one that was not, mono 11px, with its reason — the same
`containers.refusal.*` wording the detail pane uses. Nothing hides the stacks that did
succeed: they are gone from the list behind the dialog by the next scan.

**The dialog is binding**. What it lists is what gets removed: the confirm
sends the disclosed set back with it — plus, when the operator narrowed it, the selection
itself, as a separate field: the selection decides the targets, the disclosure is the
promise they are checked against, and one field doing both would let the assertion steer
what gets deleted. Main still picks its own set from its own tier table and merely
intersects it with the selection, so a selection can never add a stack Harnu refuses. If the
machine moved in between — a stack
crossed its zombie threshold, a worktree was deleted, a volume changed hands — the sweep
is refused whole and **nothing is deleted**. The dialog stays open, rescans so the list is
the current one, and shows the same `error` note anatomy with one line and no rows:
`$t('containers.sweepDialog.changed')`, which says plainly that nothing was deleted and to
confirm again. It never retries by itself — the operator reads the new list and clicks
**Remove N containers** again.

**The list is frozen at open**. The disclosure is read once, when the dialog
mounts — it is never a live view of the latest scan. A background scan that lands while
the dialog sits open therefore never rewrites the list under the operator's eyes: when the
sweep it would produce is no longer the one on screen, the dialog refreshes to the new one
**and says so**, with the same `error` note anatomy and no rows
(`$t('containers.sweepDialog.moved')`), and the volume checkbox is re-armed unchecked —
the tick was consent for the list that just changed. It never confirms by itself: the
operator reads the new list and clicks **Remove N containers** again. This is the
`SWEEP_SET_CHANGED` beat reached without asking main, and after a real refusal the dialog
re-freezes the same way, so the next confirm discloses what is now on screen.

The freeze holds while the sweep runs: a sweep eats its own list, so stacks vanishing from
the scan between the confirm and the answer are the sweep working, never the list moving.
The dialog keeps showing what the operator confirmed and raises no note. The same goes for
a dialog already showing an `error` note — a partial sweep's list of what failed is not
overwritten by a later scan; the operator cancels, or confirms again and main's own binding
check catches anything that moved.

**Docker unavailable** (`dockerAvailable: false`): the hero, meter and split give way to a
centered empty state (Cleanup's empty-state anatomy): a 28px `Container` icon (stroke 1.4,
`--text-4`), "Docker isn't reachable" (13px/500 `--text-2`), a 12px/1.6 `--text-3`
explanation (max 420px), docker's error in a mono 11px chip (`bg-surface border-border
rounded-sm`), and **Scan again**.

### Containers footer pill (StatusFooter.vue)

> **Superseded by T443** — the Containers pill is gone; the single Cleanup pill (see "Workspace GC — unified Cleanup / Footer pill") carries the review count. Containers has exactly two entry points now: **Cleanup → Docker card → Inspect stacks**, and the new-zombie notification.

Right cluster, next to the Cleanup pill, same anatomy: a Lucide `Container` icon (12px,
stroke 1.6), `$t('containers.footerPill')`, and a count badge (`bg-green-soft text-green
rounded-full`, 10.5px/700, tabular-nums) holding `totals.needsYou` — the zombie + orphan
stacks. Hidden at 0 and before the first scan. Click toggles the takeover
(`ui.toggleContainers()`); while it is open the pill inks `--accent` and carries
`aria-pressed`.

### Containers settings pane (ContainersSettingsPane.vue)

> **Narrowed by T443** — worktree-bound stacks are now judged and cleaned by Workspace GC (Settings → Cleanup). This pane keeps only the inspector's own scan timer and the idle clock for stacks that belong to no worktree, and links to Cleanup. See "Workspace GC — unified Cleanup / Settings → Cleanup".

Settings → **Containers** (`SettingsTabId` `'containers'`, listed after Cleanup). It has no
mockup of its own: its visual contract is `CleanupSettingsPane.vue`'s anatomy (PRD T320 §6)
— an uppercase 11px eyebrow, a muted 11.5px intro, then label-left/control-right rows
(12px `--text-2` label, one-line `SettingHint` under it, 12px gap, 14px between rows). No
section chrome. Two groups, 16px apart:

- **Background scan** (eyebrow + intro): **Scan in the background** (`ToggleSwitch`,
  `autoScan`) and **Scan every** (`SegmentedControl size="sm"`: 30m / 1h / 6h / Daily —
  Reaper's 30 min–24 h bounds; disabled while the scan is off).
- **Zombie after** (a 72px mono number input, `min="1"`, a `days` suffix, 400ms debounced
  write) and **Notify me about new zombies** (`ToggleSwitch`, `notifyOnNewZombies`).

Every control writes the whole prefs object through `containersSetPrefs`; main clamps it
(`normalizePrefs`) and the pane re-syncs from the answer. A changed threshold rescans at
once, so the view's rows re-sort without waiting for the next tick. The labels and defaults
are provisional (PRD §6). Copy: "zombie" is the only term — never "idle".

**New-zombie notification.** A quiet Activity-bell entry — `kind: 'info'`, no toast, no
sound, the same register as Cleanup's harvestable alert. Title: `{count} stack(s) just
became a zombie`; description: the first three stack names, then `+N more`. Clicking it
opens the takeover (`target: { view: 'containers' }`). Main decides when: once per stack,
remembered across restarts, only while the pref is on (a stack that turned zombie while it
was off is never replayed).

### PR Stack Canvas (PrStackCanvas.vue)

A **fifth main-pane takeover** — same shape/rules as
`RoadmapBoard`, `UsageDashboard`, `SystemMonitor` and `CleanupView` (replaces
`<main>`, sidebar/topbar stay visible, mutually exclusive with the other four
through the same `stores/ui.ts` mutex), opened via
`ui.openPrStack(folderPath, repoLabel)` — from the folder's Context menu
(`PR Stack`, `git-pull-request` icon) or the Topbar's right cluster (see "Topbar
per-repo view buttons").

**Scope is per repo, not global** — the same shape as `openRoadmap`, and for a
structural reason rather than a cosmetic one: the arrangement rule below is
"every chain converges on ONE base node", and two repos have no common default
branch to converge on. `CleanupView` is the global counter-example because
sweeping is a chore you batch; a merge chain is a decision inside one project.
Any worktree of the repo opens the same canvas.

**Header: `TakeoverShell` chrome (T300/U3, see "TakeoverShell — shared chrome"
above)** — a `GitPullRequest` icon (`--accent`, 16px), the title
(`$t('prStack.title')`), and a close `X`. Teleported into the shell's header: the repo
basename (mono, 11px, `--text-4`), then the KPI line (`$t('prStack.kpis', {...})` —
open count, chain count, ready count, retarget count; the ready count is a to-do
count, so it leaves out a merge-next PR with auto-merge armed; when review
threads were read it switches to `$t('prStack.kpisWithThreads', {...})`,
which adds `N with unresolved threads` right after `ready to merge` — and when
they were not, the count is **omitted, never printed as `0`**; bold on each number via
`<i18n-t>` named slots, the same idiom `CleanupView`'s toolbar already uses). There is
**no toolbar row**: the canvas owns its own floating controls, and a second control
surface would only compete with them.

**Body: the canvas viewport.** `flex-1 overflow-hidden`, `cursor-grab`
(`grabbing` while panning), background `--bg` plus a dot grid built from
`--border-2` (`radial-gradient(circle, … 1px, transparent 1px)`, 22px pitch) —
the only affordance that makes panning legible. Inside it, a single
`canvas__world` element carries `transform: translate(x,y) scale(z)` with
`transform-origin: 0 0`; nodes are absolutely positioned in world coordinates
and edges are one `<svg>` layer under them (`pointer-events: none`).

#### Layout contract — the arrangement rule

1. **Every chain is a vertical column**, and no column ever holds two chains.
   Column pitch 304px, row pitch 166px, both plan-locked.
2. **Columns are bottom-aligned**: every chain's base-most PR sits on the row
   directly above the base node and the chain grows _upward_. Stack depth
   therefore reads as column height at a glance, and — because a column
   contains only its own chain — an edge can never be routed across an
   unrelated card.
3. Chains are ordered left→right by depth, deepest first.
4. Edges always flow **downward**, from a PR to its base; exactly one outgoing
   edge per node. Same-column edges are straight verticals; the base-most edge
   fans into the base node, and incoming edges land on **distinct points** along
   its top edge so they stay countable.
5. All chains terminate on **one** base node (the repo default branch),
   horizontally centred under the columns. The base node is deliberately not a
   card — it is not work, it is the destination: a 34px pill, `bg-surface-2
border-border-2`, mono 12px/600.
6. A **draft worktree** (no PR yet) attaches to its `bornFrom` mother
   with a dashed edge entering the mother's **side**, not its top — it is
   lineage, not a merge target. It takes a free cell in the column to the right
   of its mother, never a cell inside a chain's own stack.
7. The top row starts at y=58, not y=0: fit-to-view insets the world by the
   floating control cluster's height so a tip card can never be born underneath
   it.
8. A worktree whose PR was **merged** is not a graph node at all — see the
   harvest tray below.

**All of the above is the DEFAULT arrangement, not the law.** Cards are freely
draggable. Edges are anchored to card edges and recompute on every drag frame,
so the **arrow** carries the chain and the coordinate never does — moving a card
cannot make the graph lie. A moved card becomes a **position override persisted
by PR number**: untouched nodes keep flowing with the computed layout, a new PR
is auto-placed, and a closed PR takes its override with it. A moved card is
marked only by a dotted 2px leading edge (`--text-4`) — provenance, not a state
to act on. The `Re-layout` control appears **only while ≥1 override exists** and
drops all of them at once.

#### Role markers — the two derived answers

The canvas exists to answer two questions GitHub answers nowhere, and they are
opposite ends of the same chain, so they are two markers and never one:

- **Staging tip** (`chip--tip`, `bg-accent-soft text-accent`) — the leaf of a
  chain, with a `carries N` count. Deploy this branch and you test N PRs at
  once. **A tip is a tip regardless of CI** — you deploy to staging precisely in
  order to test, so a red tip is still the right branch to push.
- **Merge next** (`chip--merge`, `bg-green-soft text-green`) — the base-most PR
  whose base is already the default branch, green, approved and conflict-free.
  Merge order runs bottom-up; deploy order runs top-down. A one-PR chain is
  both at once.
- **Base merged** (warning-toned) — the PR's base branch was merged and deleted,
  so GitHub silently retargeted it onto the default branch. The card's border
  and its outgoing edge both go warning-toned and dashed; the edge _is_ the
  hazard.

The `carries N` chip is **omitted when N = 1** — a one-PR chain carries only
itself, and saying so is noise on every single-PR node.

#### PR card (PrStackCard.vue)

Fixed **272px** wide so the layout pass can pack columns deterministically;
`bg-surface border-border rounded-[--radius-lg]`. Height varies only with the
marker strip and the expanded drawer.

- **Marker strip** — 24px, `bg-surface-2`, `border-b border-border`, holding 0–2
  role chips plus a right-aligned `carries N`. **Not reserved space**: a card
  with no role has no strip at all, so an unremarkable PR stays visually quiet.
- **Body** (`padding: 9px 10px 8px`): `#number` (mono 11px/600, `--text-3`,
  tabular-nums) with the age right-aligned (10.5px, `--text-4`); the title
  (13px/600, 2-line clamp); the branch line (`GitBranch` 11px + mono 10.5px
  `--text-4`, ellipsised); then the readiness row.
- **Draft badge** — a 14px uppercase pill (`bg-surface-2 text-text-3`,
  9px/700, `0.07em` tracking, `--radius-sm`) on the **identity row**, directly
  after `#number`. Draft lives here and not in the status slot for two reasons:
  a draft's review state is not meaningful, so ranking it against real verdicts
  would hide a `changes requested` behind "not finished yet"; and the identity
  row is the only row that survives `compact`, which is where "is this even
  finished?" still has to be answerable. Neutral tokens on purpose — a draft is
  a state of the card, not a verdict, and the red/green budget is spent
  elsewhere.
- **Auto-merge marker** — a bare 11px `Timer` in `--text-3`, on the
  **identity row** directly before the right-aligned age (`gap-1`), shown only
  when the PR has auto-merge armed, with a `title`/`aria-label` saying so. It
  renders at `full` and `compact` and not on the `far` pill. Same reasoning as
  the draft badge: an armed PR is a state of the card, not a verdict, so it
  **never takes the status slot**, and the identity row is the row that
  survives `compact`. Neutral on purpose — red and green are verdicts, and
  `--accent` is the staging tip. Not `Zap`: a lone PR off main is both staging
  tip and merge next, so an armed one would show the staging-tip chip's
  lightning bolt and a second one here, the same signal twice. The drawer spells
  it out.
- **The branch line is actionable, and quietly so.** The ellipsised name is a
  button: clicking it opens **the pull request** on GitHub — the PR's own `url`,
  no derivation and no extra API call. The name is what identifies the card to
  the eye, but a card _is_ a PR, and the page anyone wants after reading one is
  the PR's; the raw ref stays one click away through the copy button. A 16×16
  `copy` button sits at
  the trailing edge, **hidden until the branch line is hovered or the button is
  focused** (`opacity-0` → `opacity-100` over `--dur-fast`), and copies the raw
  branch name for a local `git checkout`; it confirms with a success toast, since
  a silent clipboard write is indistinguishable from a dead click. Hover paints
  the name `--accent` with an underline — the only underline on the card, so it
  reads as the one link. Collapsed cards stay visually unchanged at rest: this
  adds an affordance, not ink.
- **A linked worktree is reachable from the collapsed card.** When Harnu manages
  a worktree checked out on the PR's branch, a `House` button (10px icon in an
  `h-4 px-[3px]` hit target, `--text-3`, `hover:bg-surface-2 hover:text-text`)
  sits on the branch line's trailing edge, before the copy button, and carries
  the 6px pulsing dot (`.anim-pulse-dot`, `--green`) when a session is live in
  it. Unlike the copy button it is **always visible**, not hover-revealed: "this
  PR is checked out locally" is information, not only an action, and it appears
  on few enough cards to read as a signal rather than as ink. It **reveals** the
  folder in the sidebar and closes the takeover — it never selects a session,
  because the operator asked to see the worktree, not to have their current
  session swapped out. A **harvestable** worktree never lights this button: its
  PR already merged and the harvest tray owns that leftover.
- **A pointerdown on any card control never starts a node drag.** The canvas
  drags cards by capturing the pointer on the viewport host, and a captured
  pointer retargets the following `mouseup`, which makes the browser fire
  `click` on the host instead of on the button — every control inside a card
  would be dead. The drag handler bails out (and stops propagation, so the
  canvas does not capture for a pan either) whenever the gesture starts inside a
  `button` or `a`. Cards stay draggable by their body.
- **Readiness chips** (`.sem`, 18px, `--radius-sm`, 10px/600) — `ok` uses
  `bg-green-soft text-green`, `bad` `bg-red-soft text-red`, `wait`
  `bg-surface-2 text-text-3`, and `warn` `color-mix(in srgb, var(--color-warning)
10%, transparent)` + `text-warning` (identical to the `bg-warning/10` utility
  already used elsewhere in `components/`; `--color-warning` has no `-soft`
  sibling token and none is being added).
- **The readiness row is one CI chip, one status slot, then additive chips**, in
  a clipped track (`min-w-0 flex-1 overflow-hidden`) with the expand chevron as
  its `flex-none` sibling. The chevron is the card's only always-reachable
  control and a long chip row must never push it off a 272px card. A chip that
  does not fit is clipped from the trailing edge, so DOM order is clip order:
  CI chip, status slot, unresolved threads, `behind`, waiting on,
  diff size, labels. Only the additive chips after the status
  slot may overflow, and each of those must also be in the drawer (`behind` is,
  as the always-present vs-base row; threads are, as the threads row). The CI
  chip and
  the status slot are not repeated in the drawer, so a unit that adds a chip
  ahead of them, or lengthens their labels, must keep them inside the track or
  add them to the drawer.
- **The status slot holds exactly one chip** (T273 / `docs/specs/T272-pr-stack-card-signals.md`
  §4.1), chosen by `prStatusSlot()` in `pr-stack-format.ts` — a pure function
  rather than a template ladder, because six later units all target this one
  line and as `v-else-if` branches each would re-litigate its priority in
  template order. Precedence, highest first, with the chip variant each takes:

  | #   | Slot                | Variant | Reads                                     |
  | --- | ------------------- | ------- | ----------------------------------------- |
  | 1   | `conflicts`         | `bad`   | nothing can proceed until the tree merges |
  | 2   | `retarget`          | `warn`  | the PR points at a branch that is gone    |
  | 3   | `changes requested` | `bad`   | a human read it and blocked it            |
  | 4   | `blocked`           | `warn`  | policy blocks it, no human did            |
  | 5   | `approved`          | `ok`    | ready, pending mechanics                  |
  | 6   | `review`            | `wait`  | fallback: nothing above applies           |

  **Red and green are reserved for verdicts.** `changes requested` takes the same
  `bad` pairing as `conflicts` — a human's "no" is exactly as blocking as a
  tree's — while `blocked` is a policy state and takes `warn`. The neutral
  `review` chip is kept rather than dropped (T277 settled spec §7.1 this way):
  S5 did not make it redundant, it made it specific. With the waiting chip below
  drawn beside it whenever a request is pending, a **lone** `review` now means
  _no reviewer is pending_: either nobody was asked yet, or a reviewer answered
  with a comment-only review (GitHub removes them from `reviewRequests` without
  setting `reviewDecision`). Telling those two apart needs `latestReviews`, which
  the card does not read yet. Dropping it would
  draw that state as silence, which reads as "nothing to do" and cannot be told
  apart from a card whose review state never loaded (`reviewRequests` arrives as
  `[]` both when none are pending and when the field is absent).

  `blocked` comes from GitHub's `mergeStateStatus === 'BLOCKED'`, routed
  through `prStatusInput()` into the same ladder — never a second one. `DIRTY`
  lands on rank 1 with `mergeable === false`. `blocked` is withheld on a draft
  (GitHub folds its deprecated `DRAFT` state into `BLOCKED`; the draft badge
  already says why), while `reviewDecision === 'REVIEW_REQUIRED'` (the
  missing review is the block, and `review` names it), and while `ci === 'pending'`
  (GitHub reports `BLOCKED` until required checks finish; the `running N` CI chip
  names that wait). A failing required check keeps `blocked`.

- **`behind` chip** — `warn`, `ArrowDown` 10px, additive, after the status
  slot. Shown when GitHub reports `mergeStateStatus === 'BEHIND'` **or** the local
  `git rev-list` count is positive; it reads `N behind` when git counted it and
  bare `behind` when only GitHub knows. It degrades, it never disappears for lack
  of a local branch. No chip is ever drawn for "not measured" — that is a drawer
  fact, not a signal. Decision logic: `prBehindState()` in `pr-stack-format.ts`.

- **Waiting-on chip** (T277, spec §5.5) — `waiting @dberri`, or `waiting @dberri +2`
  with more than one pending request. The `wait` variant (`bg-surface-2
text-text-3`, `PR_WAITING_CHIP_CLASS`), never `warn`: a PR correctly awaiting
  review is not in a bad state. It is the **last additive chip**, after `behind`:
  it is informational and full-only, while `behind` is a warning that survives
  `compact` (spec §4.2), so when the track overflows a long login must clip the
  waiting chip, never the warning. It renders **only when the slot resolved to
  `review`** — `prWaitingOn()` takes the slot `prStatusSlot()` already picked, so
  a verdict silences a leftover request without a second ladder in the SFC. The
  lead names a user before a team (a person is who you can ping); a team slug
  reads `@slug`, and a team that arrived with only its display name stays plain
  text. The `waiting @login` text truncates at `max-w-32` so a long login can
  never push `+N` out of the chip, and the whole list is the chip's `title` and
  the drawer's `waiting on` row. Shown at `full` only (§4.2 budget). No request,
  a `null` list or a list of blank entries draws no chip — never an empty
  `waiting`.

- **Diff-size chip** (T276 / spec T272 §5.4) — `+412 −38 · 9 files`, the
  cheapest honest proxy for review cost. The `wait` variant (`bg-surface-2
text-text-3`, 10px/600, `tabular-nums`), with `−` as U+2212 so it is the width
  of `+`. **Muted, never coloured:** a size is not a verdict, and red and green
  are reserved for verdicts — GitHub's `+green −red` convention is deliberately
  not followed, or the chip would compete with the status slot for the colour
  budget. It is the **last** additive chip in the track, so it is the first the
  clip takes, and it is repeated with exact counts in the drawer's `diff` row.
  **It goes whole, never half:** a half-clipped `+412 −3` would misreport the
  size, so the chip sits in its own `flex-1 min-w-0` one-line slot
  (`h-[18px] flex-wrap overflow-hidden`) behind a zero-width spacer — a chip that
  does not fit in the room the track has left wraps to the hidden second line
  and vanishes entirely.
  Thousands abbreviate on the chip (`1.2k`, `48k`, `2.3M`), truncating rather
  than rounding so a size is never overstated; the drawer row does not
  abbreviate. **Missing data draws no chip and no drawer row** — never
  `+0 −0 · 0 files`, which would claim an empty PR the app has no evidence for.
  A PR GitHub _measured_ as touching nothing reads `empty diff` instead. Shown
  at `full` only: at `compact` the readiness row is gone and nothing replaces it
  (no S/M/L size dot — not accepted), and the `far` pill never carried it.
  Zooming back past 0.70 is the way to read it.

- **Unresolved-threads chip** (T275 / spec §5.3) — `warn` variant
  (`bg-warning/10 text-warning`), a 10px `message-square` glyph plus
  `$t('prStack.unresolved', { n })`, `tabular-nums`. It is an **additive** chip,
  not a status: it sits directly after the status slot and never displaces it,
  because "approved, with three open threads" is two facts. Neither red nor
  green — an open thread is a pending action, not a verdict (spec §4.3). It
  counts threads that are `isResolved === false && isOutdated === false`; an
  outdated thread points at code that no longer exists, so it is listed only in
  the drawer. `N+` when GitHub holds more threads than were read (100 per PR).
  **No chip** when the count is `0` (nothing to act on) and **no chip** when the
  threads could not be read — absence is never drawn as `0 unresolved`. Chosen
  by the pure `prThreadChip()` in `pr-stack-format.ts`, never a template
  condition. At `compact`, where the readiness row is shed, the same count moves
  to the identity row as a 14px badge on the draft badge's recipe (9px/700,
  `--radius-sm`, 9px glyph + count only, the full sentence in its `title`), so
  "is this waiting on the author?" survives zooming out, as spec §4.2 budgets.

- **Label chips** (T278 / spec §5.6) — **opt-in, off by default** (Settings → PR
  Stack → _Show labels on cards_), and the last additive chips in the readiness
  track, so they are the first thing the track clips. At most **2** render, and
  only at `full`; `compact` and `far` render none. Each is an 18px `.sem` chip on
  the neutral `wait` pairing (`bg-surface-2 text-text-3`, 10px/500 — one weight
  below the verdict chips, because a label is information and not a verdict),
  capped at `max-w-24` with an ellipsis and the full name in `title`. Past the
  cap, a bare `+N` count (`text-text-4`, 10px/600, no fill, `flex-none`) says
  more exist. Label chips are the **only shrinkable chips** in the track: on a
  crowded row they give up width to an ellipsis first (floored at `min-w-8`),
  so the `+N` count after them survives instead of being the first thing
  clipped — measured live, `CI` + `review` + two ordinary labels already
  overflow 272px.
  **No colour, ever:** GitHub's per-label hex is never carried to the renderer
  (`PrEntry.labels` is names only), so no label can paint a raw colour into the
  card — the label's text is the signal. The drawer carries a `labels` row
  listing **every** label, so a chip the track clipped, or one past the cap, is
  still findable at `full` + expanded. An empty label list renders no chip, no
  count and no drawer row. The cap and the split live in `labelChips()`
  (`pr-stack-format.ts`), not in the template.
- **Expand button** — 20×20px `ChevronDown`, `hover:bg-surface-2`, rotating 180°
  over `--dur` when open.
- **Drawer** (`border-t border-border`, `bg-bg`): a `64px 1fr` key/value grid
  (base, author, waiting on, auto-merge, vs base, diff — exact counts,
  absent when GitHub sent none — threads, labels when the toggle is on, merge,
  linked worktree), then the individual checks, then the actions. The `auto-merge`
  row appears only when armed and names the method (lowercased GitHub noun,
  untranslated) and the arming actor — `squash, armed by @x` — dropping
  whichever half GitHub did not report, and reading `armed` when it reported
  neither (`autoMergeDetail()`). The **threads** row reads
  `N unresolved`, or `N unresolved · M outdated` when outdated threads exist —
  the one place outdated threads are shown. It is present whenever threads
  were read (so a measured `0 unresolved` is visible here) and absent when
  they were not, leaving the drawer exactly as it was without thread data.
  - **`vs base` is always present** and holds exactly one of four
    sentences: `N behind its base` · `behind its base, per GitHub` ·
    `up to date locally` · `could not measure locally`. The last takes `--text-3`
    instead of `--text-2`: it is an absence of data, not a finding. An empty row
    is never drawn, because an empty row is what used to make "up to date" and
    "never fetched here" look identical. `up to date` says **locally** because
    the count runs on this checkout's refs: a stale local base also counts `0`.
    The base counted against is the PR's own `baseRefName` (the default branch
    only when that base was merged away) — `behindBaseRef()` in `pr-stack-core.ts`.
  - The `vs base` and `merge` values carry a `title` with their full sentence:
    the `1fr` column is ~178px and truncates, and some translations run longer.
  - **`merge`** appears only for GitHub's `BLOCKED`
    (`blocked by branch protection`; not on a draft) and `UNSTABLE`
    (`a non-required check is failing`) — the verdicts the chip row does not
    already carry in full.
    `UNSTABLE` never gets a chip: the CI chip already reads `failing N`.
- **Actions are read-only.** Open on GitHub and open the worktree — plus, on a
  `base merged` card only, a full-width monospace copy button carrying the exact
  `gh pr edit <n> --base <branch>` command. The canvas is a read model; a write
  to GitHub is a different risk class. This is the same copy-the-command idiom
  as the Cleanup tombstone's restore-hint button.
- A **live Harnu session** on the linked worktree shows the 6px pulsing dot
  (`.anim-pulse-dot`, §7), same as the fleet rail.

**Draft worktree node** — the same card at 240px, `border-dashed`, transparent
background, a `House` icon and the literal word `worktree` where the PR number
would be, and a single `no PR yet` chip.

#### Level of detail — zoom sheds detail, not pixels

Fit-to-view over twenty cards that only _scales_ produces a graph that fits and
cannot be read: "does not fit" traded for "fits, illegible". So the world scale
changes **what a card renders**:

| World scale | Card renders                                                  |
| ----------- | ------------------------------------------------------------- |
| `> 0.70`    | the full card                                                 |
| `0.70–0.45` | identity + one-line title. No branch line, no chips, no strip |
| `< 0.45`    | a 32px pill: role bar + `#number` + `carries N`               |

The role the marker strip carried is not lost when the strip goes: it collapses
into a **3px bar on the card's leading edge** (`--accent` / `--green` /
`--warning` / `--red`, `--border-2` when roleless) which survives any zoom.

**Fit runs automatically on open and when the graph _shape_ changes** — never on
a plain data refresh, which would move the view under the operator mid-read.

#### Focused-card highlight (PR links from the transcript)

The canvas can be opened _onto_ one PR: Option+click on a link to an **open** PR
of the session's own repo (opt-in, Settings → PR Stack → _Open PR links in the PR
Stack_) opens this takeover and **focuses** that card. Focus does two things:

- **Pan to it.** The viewport pans so the card's centre lands on the viewport's
  centre. The current zoom is kept unless the card would be off-screen _after_
  that pan at the current scale (a card wider/taller than the viewport), in
  which case the scale drops just enough to fit it. A refocus on an
  already-open canvas does the same. If the snapshot has not landed yet the
  request waits (`pendingFocus`) and runs the moment it does.
- **Ring it.** The card gets a `2px` `--accent` ring (`box-shadow`, outside the
  border, so the 272px layout width never changes) for **2s**, then the ring
  fades out over `--dur-slow` / `--ease` (§7 "PR focus ring"). It is a
  `transition` on the card, not a keyframe — under `prefers-reduced-motion` the
  transition is zeroed and the ring simply appears and disappears, so the cue
  survives with no motion. Defined once as `.pr-focus-ring` /
  `.pr-focus-ring--on` in `main.css`; applies to both the full card and the
  far-LOD pill. Only one card is highlighted at a time; a second focus replaces
  the first.

A link that is not an open PR of this repo (another repo, merged/closed, `gh`
missing or unauthenticated, no answer within 5s) is not an error: it opens in the
browser exactly like a plain click.

#### Floating controls (top-left) and harvest tray (bottom-left)

Both are absolute to the **viewport**, never to the world, so they neither pan
nor scale. The control cluster (`bg-surface border-border`, `--shadow-pop`,
`--radius`, 26px buttons) holds: **Refresh** with the last-fetch stamp beside it,
a separator, **Fit**, **zoom −**, the current percentage (`--text-4`,
tabular-nums, non-interactive), **zoom +**, and — only while ≥1 position
override exists — a separator and **Re-layout · N**. While a refresh is in
flight the refresh icon spins (`900ms linear`, killed under
`prefers-reduced-motion`); the **background job and the manual button share that
one state**, so the operator never has to wonder which one is running.

**Stale refresh.** When the last `gh` read failed TRANSIENTLY (timeout,
buffer overflow, network, rate limit) but a good snapshot is on the canvas, that
snapshot **stays** — an empty read must never replace a populated graph — and the
Refresh button turns into a warning chip: `bg-warning-soft`, a 1px inset
`--warning-line` ring, `text-warning`, a leading `TriangleAlert` (13px), then the
age of the last _good_ read (the failed fetch never advances it), then the refresh
glyph. Hover or focus shows a 250px `bg-surface` / `border-border` / `--shadow-pop`
popover 6px below it — a 600 title (`prStack.refreshFailed.<kind>.title`) over a
`--text-2` 11px body that names the age and says "click to retry"; clicking the
chip retries. The next good read clears it. Visual contract: state 9
(`pr-stack-refresh--stale`) of the filters mockup. A `gh` that is genuinely
unavailable is **not** this state — that is the empty state below.

**Two clocks, and only one of them is this view's.** The canvas rides the
Reaper's background scan (Settings → Cleanup, hourly by default) for topology
and harvest verdicts, and adds a _foreground_ poll that runs only while the
takeover is open — readiness rots on a different clock than debris does. That
foreground interval is **Settings → PR Stack** (`PrStackSettingsPane.vue`, prefs
at `<userData>/pr-stack-prefs.json`): a toggle plus a four-way
`SegmentedControl` (30s / 90s / 5min / 10min, default 90s), the same anatomy as
the Cleanup tab's scan-interval row. Discrete options rather than a slider —
each tick is one `gh` call per open repo, and four choices make that trade-off
legible in a way a continuous track does not. Off leaves the manual button as
the only way in. Writing the pref re-arms the live canvas immediately rather
than at the next open, since the Settings dialog opens _over_ the takeover.

The same pane carries a second section, **Cards**, holding one toggle —
_Show labels on cards_, **off by default** — in the same label/hint/`ToggleSwitch`
row anatomy as _Refresh while the canvas is open_. Labels are the one card signal
whose worth is entirely repo-dependent (a repo that labels liberally drowns the
chip row; one that never labels gains nothing), which is why it alone is a toggle
and the rest of the chip budget is fixed. Like the refresh prefs, flipping it
applies to a canvas already open behind the dialog.

The Cards section is followed by the same row anatomy for one more opt-in,
_Open PR links in the PR Stack_ (**off by default**, `openPrLinksInCanvas`):
_Option+click a link to an open pull request in this repo to show it on the
canvas. Each click checks the PR with gh first, which can take a second._ It
lives in this pane because it changes where a PR link lands, not how a card
looks; it is off by default because every Option+click pays a `gh pr view`
round-trip before anything moves, and a plain click is unchanged either way.

The **harvest tray** is a 30px strip on the canvas floor. A worktree whose PR
already merged has no place in a merge chain, so drawing it in the graph would
misrepresent the topology; it leaves the DAG and lands here instead — the graph
stays a picture of GitHub, local debris stays a footnote. The strip shows a
`Broom` icon, "N worktrees harvestable", the reclaimable size, a
`Sweep in Cleanup` button (`bg-green-soft text-green border-green/40`, the same
token pairing as `CleanupView`'s Sweep) and an expand toggle; expanded it lists
one row per leftover (branch, "#N merged {ago}", size). **The verdict is never
recomputed here** — it is the Reaper's own `ReapVerdict` (`reaper-core.ts`), and
the sweep itself stays in the Cleanup takeover. The tray is a pointer, not a
second cleanup UI.

**Legend** (bottom-right, non-interactive): four 8px swatches naming the four
signals — staging tip, merge next, needs attention, blocked.

**Empty state:** centred in the canvas, in one of three variants named after
what actually happened (`prEmptyStateKind()` in `pr-stack-format.ts`):
`$t('prStack.emptyState')` when the repo has no open PRs;
`$t('prStack.ghMissing')` only when `gh` genuinely cannot be used here (missing,
not authenticated, not a GitHub remote); and — when the read failed and there is
no earlier snapshot to keep — the failure title (`--text-2`, 600),
`$t('prStack.refreshFailedEmpty')` and a **Retry** button (`soft`). A slow or
failed read is never reported as "GitHub CLI is unavailable".

#### PR Stack filters (PrStackFilterBar.vue)

The canvas
gets a **client-side filter** over the snapshot it already holds — no new `gh`
call, no new IPC channel. State is **per repo and session-only**: it lives in
`stores/pr-stack.ts`, is never written to `localStorage`, and is gone after a
restart. The Dim/Hide mode follows the same rule. All colors are token utilities
(`bg-surface`, `border-border`, `text-text-3`, `bg-accent-soft`, `border-accent-line`,
`bg-warning-soft`, …) — no raw values.

**Filter bar** (`data-dsqa="pr-stack-filterbar"`). A floating toolbar in the same
shell as the refresh/zoom control (`rounded border border-border bg-surface p-1
shadow-pop`, `gap-0.5`), at `top-3`, **immediately right of it** — both live in one
`absolute left-3 top-3` flex row with `gap-2`, so the bar follows the control when
its width changes. Left to right: the **query field** (26px high, min-width 260px,
`Search` 13px, placeholder 11px `--text-4`, a `/` keycap in `font-mono` 10px at the
right), a 1px separator, then four **facet buttons** — Author, Review, Checks,
Labels (26px, 11px/500, `--text-3`, a `ChevronDown` 11px). The field is a token
field: every complete term is a chip (`h-[18px] rounded-[3px] border
border-accent-line bg-accent-soft px-1.5 font-mono text-[10.5px]`, the key in
`--accent` 500 weight, the value in `--text`, a negated term keeps its leading
`-`); the term being typed lives in the input after the chips. **A term the grammar
does not know** (unknown key or value) keeps its chip but takes the warning tone
(`border-warning-line bg-warning-soft`, key in `--warning`) so a typo is visible
rather than silently ignored. Focused, the field gets `bg-bg` and an inset 1px
`--accent-line` ring. `/` focuses it while the canvas has focus; `Esc` blurs, and a
second `Esc` (canvas focused) clears the filter.

**While any filter is active** the bar grows a second group after a separator: the
result count (`7 of 19`, 11px, the first number `--text-2`, `of M` `--text-4`,
`tabular-nums`), the **Dim / Hide** segmented control (`p-0.5 rounded-sm bg-bg`,
buttons 20px high, 10.5px/500, the active one `bg-surface-2 text-text`) and a
26px icon button (`X`, `aria-label` "Clear filters"). A facet that contributes at
least one token is lit (`bg-accent-soft text-text`) and shows its token count in
`--accent` 10px.

**Qualifier suggestions** (`pr-stack-filter-suggest`). A 300px popover under the
field (`rounded border border-border bg-surface p-1 shadow-pop`) listing the nine
qualifiers while the field is focused and the current term is empty or a key
prefix: a 10px uppercase `Qualifiers` heading, then 26px rows with the key in
`font-mono` 11px and its values as a right-aligned 10.5px `--text-4` hint; the
highlighted row is `bg-surface-2 text-text`. A footer line reads "Prefix with `-`
to exclude" and "↵ apply · esc close". Arrow keys move, Enter completes the key.

**Facet menu** (`pr-stack-filter-menu`). The same popover shell, 230px, anchored
under its button: multi-select rows (26px, 11.5px) with a 13px checkbox
(`rounded-[3px] border-border-2`; checked → `bg-accent border-accent`, a 9px
check in `--accent-ink`) and a right-aligned `tabular-nums` count in `--text-4`.
Counts are **live over the unfiltered snapshot** — each option counted on its own,
so a number does not collapse as the query narrows. **Facets and the query are two
views of one state**: checking a box writes the token, deleting the token
unchecks the box. The Review menu carries a second `Threads` group
(`Unresolved threads`). Author and Label menus scroll (`.scrollable`) past ~10 rows.

**KPI presets** (`pr-stack-kpis`, `--active`). The takeover header's KPI line is
buttons, not a sentence: `ready to merge` applies `is:merge-next`, `with unresolved
threads` applies `threads:unresolved`, `needs retarget` applies `is:stale`. A KPI
button is 20px high, `rounded-sm px-1.5`, `--text-3`; hovered it takes `bg-surface-2
text-text`; the **active** one (the preset is the whole query) takes `bg-accent-soft
text-text` with an inset 1px `--accent-line` ring and `aria-pressed`. Clicking the
active preset clears it. A KPI whose count is `0` is **inert** — plain text, no
hover, not focusable. `open` and `chains` stay plain text. The middle dots are
`--text-4`.

**Dim mode** (`pr-stack-scene--dim`, the default). Layout untouched: a card that
does not match drops to `opacity-40` (the existing dim convention) and an edge is
dimmed unless **both** endpoints match (the base node always counts as a match).
Dimmed cards stay fully interactive. With zero matches the canvas stays dimmed and
the count reads `0 of M`.

**Hide mode** (`pr-stack-scene--hide`). Opt-in. The canvas re-lays out over the
matches only. A match whose ancestors do not match keeps its path to base through a
**ghost pill** per contiguous run of skipped ancestors (`h-6 w-44 rounded-full
border border-dashed border-border-2 bg-bg`, 10px `--text-4`, "`N hidden · #a #b`"):
siblings under the same skipped parent share one. Clicking a pill appends
`chain:#<match>` to the query and switches to Dim, so the hidden ancestors show in
context. Operator card-position overrides are **ignored while Hide is on** (cards
are not draggable then) and restored the moment it is turned off. Zero matches
shows `pr-stack-empty--no-match`: `$t('prStack.filter.noMatch')`, 13px `--text-3`,
centred, with a `Clear filters` button (26px, `rounded-sm border border-border-2
bg-surface`, 11px/500).

---

### Review pane (ReviewPane.vue)

PRD: `docs/prds/T164-review-pane.md` · highlighter:
[ADR-0011](docs/adr/0011-syntax-highlighting-mapped-onto-the-ansi-palette.md).

A **sixth main-pane takeover** — same shape/rules as `RoadmapBoard`,
`PrStackCanvas`, `UsageDashboard`, `SystemMonitor` and `CleanupView` (replaces
`<main>`, sidebar/topbar stay visible, mutually exclusive through the same
`stores/ui.ts` mutex; see "Takeover dismissal").

**Every scroll container in the pane carries `.scrollable`** (§9) — the pane's
body, each file box's horizontal diff scroller, the intent rail's body and the
bounce note's textarea. A native OS bar in here is a bug, not a variant.

**Scope is one branch, not one card.** The pane is anchored on the
worktree/branch; a bound card is enrichment, never the key. Half the fleet is
sessions with no card, and an `internal`-substrate card has no branch at all —
card-anchored-only would make the surface dead weight for both.

**The pane's job is to make Close a decision instead of a discovery.** Three
rules constrain every element below and are not style preferences:

- **Agents report, humans conclude.** No agent output is a verdict, a gate or a
  Close-enabler. v1 renders no agent-produced claim at all.
- **No green means safe.** Nothing here may render as a completion-looking
  badge. "0 findings" is a different sentence from "this is fine", so the pane
  never draws the first one.
- **Sensitive paths force the human read.** A blast-radius-flagged file renders
  expanded, and no summary may stand in for its diff.

**Header: `TakeoverShell` chrome (T300/U3, see "TakeoverShell — shared chrome"
above)** — a `check-square`/`file-diff` icon (`--accent`, 15px), the title
(`$t('review.title')`), and a close `X`. Teleported into the shell's header: the
**subject** in mono 11px `--text-4` — the card id when one is bound (`BUG-57`), the
branch name when none is (`bug/57-reaper-force-push`) — then, pushed right, the **Ask a
fresh session** button and a refresh `↻` (22×22). No toolbar row.

**Ask a fresh session** is a labelled secondary control, not an icon:
`h-22px`, `border-border-2 bg-surface-2 rounded-sm px-[9px]`, 11px `--text-2`,
a 12px `message-square` glyph + `$t('review.companion')`, hovering to
`border-text-4 text-text`. It sits in the takeover header and **nowhere else** —
the evidence header, the discrepancy strip and the diff are receipts, and a
conversation opened from among them is the first step toward a model's opinion
occupying the space a `git` fact occupies. There is deliberately no twin
offering the session that wrote the branch: the interlocutor is always a
stranger, and that is the only behaviour, not a default with an override. (The
frozen spec's `review-pane--with-session` root shows a `switch to author` badge;
it predates the 2026-08-27 decision and is not built.)

**Disabled — not hidden — while there is no review to be beside**:
`disabled:opacity-45 disabled:cursor-default`, no hover shift, while
`store.snapshot === null` or `store.error !== null` — the same two windows
`store.load` already leaves the pane in (a fresh, non-silent load and any
thrown IPC failure both null the snapshot). `title`/`aria-label` swap to
`$t('review.companionDisabledHint')` in that state. A companion opened in
either window would start with nothing to read, which is the defect this
button exists to not reship.

**A second activation is never a no-op.** The pane's `dedupKey` is a constant
(`pane-registry.ts`), so re-clicking with a companion already running returns
that SAME pane's id instead of spawning a stranger with no shared context — and
that id is used to bring the running companion into focus (`helpers.maximizePane`,
the same re-targeting behaviour "Maximizing a pane" above already documents for
its own button), not silently discarded.

Body: `p-4 px-5 pb-7`, a vertical stack at `gap-14px` — the evidence header,
then the split.

#### Evidence header (the receipts)

The one genuinely new component; nothing in §6 precedes it. It reads as a
**ledger**, not a dashboard: `border-border rounded-[--radius] bg-surface`,
`overflow-hidden`, three stacked strips.

1. **Top row** (`h-auto`, `p-[10px_12px]`, `gap-10px`): a `git-branch` icon
   (13px) + `branch → base` in mono 12.5px (branch `--text`, the `→` and base
   `--text-3`/`--text-4`), the card badge when bound (`badge--accent`, §6
   Badges verbatim), then the actions pushed right at `gap-7px`: **Bounce back**
   (secondary `.btn`) and **Close** (`.btn--primary`, `--accent` fill,
   `--accent-ink` ink, 550). With no card bound both are replaced by a single
   **Open in terminal** — there is nothing to close or bounce.
2. **Receipts row** (`p-[0_12px_10px]`, wraps): label/value pairs, value first.
   Value mono 12px `--text`, label sans 11px `--text-4`, `gap-6px`; pairs are
   separated by a hairline `border-r border-border` with `14px` either side,
   and the last pair drops its rule. A value with nothing to report is `--text-3`
   (`clean`, `none`, `local only`) — dimmed, never hidden, because an absent
   receipt is itself evidence. Counts: commits · files · lines (`+n` `--green`,
   `−n` `--red`) · uncommitted · session end state · CI · PR · PR review. The
   git-only variant simply carries fewer pairs; it is a first-class state, not
   a degraded one, and it raises no error.

   **Reviewing a PR that was never checked out here** changes two pairs
   and adds one. The `uncommitted`/`worktree` pair is **dropped**, not dimmed:
   that review runs in the repo's main worktree, whose uncommitted files are the
   operator's own work and say nothing about someone else's branch — `clean`
   there would be a claim about the wrong tree. `commits` and `files` render
   `—` (`--text-3`, never the red `0`) whenever the head could not be read at
   all, because a `0` in the strip's loudest hue is exactly how "nothing was
   fetched" gets misread as "nothing was done". And a **`head`** pair states
   whether the copy on disk is still the PR's head — `current` or `moved`,
   plain `--text`, **no dot and no hue**. Staleness is a boolean, not an age:
   "this commit is 3 days old" describes the code, not the operator's copy. The
   age survives only as a `fetched 3h` pair when there is no `headRefOid` to
   compare against, and `head unknown` (dimmed) when neither is knowable.

   > **`current` is not an "up to date" badge, and must never grow into one.**
   > It is a statement about one ref sitting among the other receipts. The
   > moment it takes a green dot it starts reading as a verdict on the review,
   > which is the R2 failure the whole pane is built around.

3. **Discrepancy strip** (`border-t border-border bg-surface-2`,
   `p-[7px_12px]`, `gap-5px`): one line per named discrepancy, in words. A
   12px-wide mono glyph column carries severity — `✕` `--red`, `!` `--warning`,
   `·` `--text-4` — followed by 12px `--text-2` prose with paths in an inline
   `code` chip (`bg-surface border-border rounded-[4px] px-1`). This is the strip
   that makes "the session said done but committed nothing" impossible to miss.
   It renders **facts**, never a verdict: "No commits on `feat/x` — the session
   reported done but nothing was committed", not "not ready".

   T246 adds lines for the foreign-PR states — head not fetched, fetch failed,
   base unresolved, the PR moved since this copy was fetched, and a refresh that
   could not reach the network while an older copy still renders. There is
   deliberately **no line for `current`**: an "up to date" row is the all-clear
   badge R2 forbids, and the receipts strip already states it as one word.

**Status dots are never alone.** Every `.dot` (6px, `--green`/`--warning`/
`--red`/`--text-4`) is followed by the word it encodes (`passing`, `ended done`)
— colour is a second channel here, never the only one (§2).

#### Split — two columns, never three

`display:flex`, `gap-14px`, `items-start`. The evidence header is **horizontal**
precisely so it never eats a column and turns the body into three cramped ones.

- **Diff column** — `flex-1 min-w-0`, the dominant region, files stacked at
  `gap-10px`.
- **Intent rail** — `w-320px flex-none`, `sticky top-12px`, `border-border
rounded-[--radius] bg-surface`, `overflow-hidden`. Header strip
  (`p-[9px_11px] border-b`): an 11px uppercase `--text-4` label with `0.04em`
  tracking, and a mono chevron pushed right. Body `p-[11px]`, 12.5px/1.55
  `--text-2`, `max-h-460px overflow-y-auto` — the bound card's body through the
  `MarkdownRenderer` seam (§6 Markdown pane), so headings, lists, `code` chips
  and the AC lines all inherit their existing prose treatment.
- **With no card bound the rail is absent, not empty.** The diff takes the full
  width. An empty box would advertise a feature the branch cannot have.

#### Intent rail collapse (~1000px)

Below **~1000px** the 320px rail stops being affordable — measured on the
approved spec, at 714px the diff column truncates code mid-line, which breaks
the one thing the pane exists for. At that width the rail collapses to a
**36px strip that keeps its position** (right edge, `flex-none`, `sticky
top-12px`, same border/background as the expanded rail): a mono `‹` chevron, a
5px `--accent` dot marking "there is intent here", and the label rotated
vertically (`writing-mode: vertical-rl; rotate(180deg)`, 11px uppercase,
`0.06em` tracking, `--text-4`).

Two rules make the collapse cheap rather than lossy: the strip stays **where
the muscle memory is**, and expanding it **overlays** the diff instead of
squeezing it. The same collapsed state is what the pane uses when it shares the
row with the HelperStack (a session beside the review) — that is the same
breakpoint reached from the other direction, not a second mode.

#### Diff — file box

`border-border rounded-[--radius] bg-surface overflow-hidden`, one per file.

**File header** — `p-[8px_11px] bg-surface-2 border-b border-border`,
`sticky top-0 z-2` so the path stays readable while scrolling a long file:
the path in mono 12px (directory segments `--text-4`, basename `--text`), a
spacer, the `+n`/`−n` counts in mono 11.5px (`--green`/`--red`), and the
collapse caret `▾` in mono 11px `--text-4`.

**Blast-radius marker.** A file on the repo's sensitive-path list is marked by
an **inner 2px bar**, painted as a `::before` child of the **file header**
(`position:absolute; left:0; top:0; bottom:0; width:2px; background:
var(--color-warning)`), plus a `sensitive path` badge (`badge--warning`) as the
first item in the header row. The file box itself only warms its border to
`--warning-line`.

> **It is a bar child, not a border on the box, and that is the contract.** A
> left border on the rounded box would be clipped by `border-radius` into a
> tapering sliver at both ends, would shift every row inside it by its own
> width, and would collide with the sticky header's own background. The inner
> bar is full-height against a square-cornered strip, moves with the sticky
> header, and costs the content no horizontal space.

A flagged file **renders expanded** and cannot be collapsed by the
above-threshold auto-collapse rule.

#### Diff — the viewed mark

A file header carries a **viewed checkbox** as the last item before the collapse
caret: an 18×18 `rounded-sm` box with a 11px lucide `check` inside it, a real
nested `button` with `@click.stop`. It sits on the **right** because the left
edge of this header belongs to the blast-radius bar, and nothing may crowd that.
"I have read this" and "show me this" are different gestures, so they never
share a hit box — the header toggles the file, the box toggles the mark.

Four states, and each is a different sentence rather than a different shade:

| state       | box                                              | what it says                                    |
| ----------- | ------------------------------------------------ | ----------------------------------------------- |
| `unviewed`  | `border-border-2 bg-surface`, glyph transparent  | not read; hover reveals the glyph at `--text-4` |
| `viewed`    | `border-green/40 bg-green-soft`, glyph `--green` | read, and GitHub agrees (or has no opinion)     |
| `pending`   | `border-border-2 bg-surface-2`, glyph `--text-3` | read here, **not yet synced** with GitHub       |
| `dismissed` | rendered UNCHECKED, plus the badge below         | read, and then the file moved                   |

**`pending` is neutral, never a warning hue and never green.** Green would be
exactly the claim the state exists to refuse — an unsynced write is not a
synced one (AC-6) — and `--warning` on this row already belongs to the
blast-radius bar. Its title states it in words: `Read — not synced with GitHub
yet`.

**`DISMISSED` is its own state, not a flavour of never-read.** GitHub clears the
mark itself when a file changes after you read it, and Harnu reproduces the same
semantics locally by keying the mark on the file's blob SHA. It renders as an
unchecked box **plus a badge** — `changed since you read it`, a pill on
`border-border-2 bg-surface`, 11px `--text-2` — placed after the sensitive badge
and before the path. It carries the word, never a hue alone (§2). "You have not
read this" and "you read this, then it moved" must never share a sentence.

**A file that has been read collapses; a sensitive file never does.** Marking a
file read collapses it, and a file already read opens collapsed — that is the
whole ergonomic point, and what keeps a nine-file diff from swallowing the place
you left off. A blast-radius file is exempt in both directions: R3 says a flagged
file renders expanded, and having-been-read does not outrank sensitivity any more
than a row budget does. A read file's basename dims to `--text-3`; a sensitive
one never dims, read or not.

> **There is no aggregate.** No "all files viewed" badge, no `7/9` count, no
> green summary, at any combination of marks. A progress count over a review is
> the purest form of the completion-looking state R2 forbids — it reads as "you
> are done" while stating nothing about whether anything is right. The pane
> renders the same chrome whether nothing or everything has been read, and
> `tests/review-pane-contract.test.ts` pins that structurally rather than by eye.

#### Diff — row anatomy

`font-mono 12px / line-height 1.65` — a diff set at prose density is unreadable,
and the extra leading is what makes twenty minutes of reading survivable.

Each row is `flex items-start`:

- **Gutter** — `w-92px flex-none`, `bg-surface-2`, `border-r border-border`,
  11px `--text-4`, `user-select:none` so copying a hunk copies code and not line
  numbers, and **`sticky left-0` `z-1`** so it stays put while the code column
  scrolls (below). Three cells: old line no. and new line no. (each `w-34px`,
  right-aligned, `pr-6px`; the empty one on an add/del row is blank, never `0`)
  and the **sign cell** (`w-16px`, centred): `+` `--green`, `−` `--red`, blank
  on context.
- **Code** — `flex-none`, `px-12px`, `white-space:pre`, no scroller of its own,
  `--text-2` on context and `--text` on changed rows.

#### Diff — horizontal scroll

**One horizontal scroller per file box, never one per row.** The file box's diff
body is the scroll container (`overflow-x:auto` + an explicit
`overflow-y:hidden`, `.scrollable` — §9); the rows sit inside a
`min-width:max-content` track, and each row's **gutter cell is `sticky left-0`
over an opaque background**. That is the shape GitHub's diff table
(`td.blob-num { position: sticky; left: 0 }`), VS Code and every other diff
viewer converged on, and the reasons are the contract:

> **Long lines must scroll _together_.** A scroller per row lets one line drift
> away from the lines above and below it, so a long line can never be read
> beside its context — which is the entire reason a diff renders context at
> all. It also drops a scrollbar into the middle of a file, attached to one
> line.
>
> **The gutter must not scroll with the code.** Simply hoisting `overflow-x`
> to the file box would carry the 92px gutter off the left edge along with the
> code, which is worse than the per-row bug. `sticky left-0` pins it; the
> opaque background is load-bearing, or code shows through the line numbers at
> any offset above zero.
>
> **Lines are never wrapped.** Wrapping would break the one-row-per-line
> alignment the gutter depends on, so the scroller is what makes a long line
> reachable.

The gutter's `z-1` sits **below** the file header's `z-2`: the header has to
paint over the gutter as a long file scrolls under it, not the other way round.
The hunk (`@@`) and unchanged-gap (`⋯`) markers are pinned the same way, so the
whole left edge holds as one column.

**The add/remove tint lives on the row, not on the code cell.** The row
stretches to the full width of the `max-content` track, so the stripe survives
being scrolled instead of ending where that line's text happens to end.

**Add/remove surfaces.** `.diff-line-add` → `--green-soft`, `.diff-line-del` →
`--red-soft`; word-level marks `.diff-word-add` / `.diff-word-del` →
`--diff-add-word` / `--diff-del-word` at `rounded-[2px]` (§9 "Diff surfaces").
**The sign glyph is the second channel** — colour never carries add/remove
alone (§2).

Removals read slightly lighter than additions (`--red-soft` is `.10` against
`--green-soft`'s `.18`). That is the approved rendering: the alphas were tuned
for badges where red is an alarm, and in a diff the word mark plus the `−` glyph
already carry the signal. There is deliberately no `--diff-del-line`.

**Word-level marks are the point, not a flourish.** On a modified line, only the
span that actually changed is marked — a one-character edit is findable without
reading the line. It is the biggest comprehension win after add/remove colouring.

**Hunk label** — `@@ -176,9 +176,14 @@ …` on `bg-bg`, hairline top and bottom,
11.5px `--text-4`, with the `@@` glyph sitting in a gutter-width cell so it
aligns with the line numbers below it.

**Collapsed context** — an `expander` row on `bg-bg` between hairlines, a `⋯`
in the gutter cell and "`n` unchanged lines" at `pl-12px`, 11.5px `--text-4` →
`--text-2` on hover. Expands in place; it never opens a new surface.

**Syntax colours come from the ANSI palette** — §9 "Syntax highlighting is the
ANSI palette". The component emits classes and writes no colour of its own.

**Binary files** are listed by path with a `binary` marker and no hunk body; no
render is attempted.

#### Submitting a review to GitHub

PRD: `docs/prds/T244-approve-from-review.md` · spec:
`docs/specs/2026-08-27-t244-approve-from-review.md`.

**The pane's only write, and the only surface in Harnu that speaks under the
operator's own GitHub identity.** Everything else here is `git` reads and one
cached `gh pr list`; this one produces an artifact other people see and act on.
The anatomy below is small — the constraints are the component.

**Entry point.** A secondary `.btn` labelled **Submit review**, in the evidence
header's top row, in its own `ml-auto` span BEFORE the card's Bounce/Close pair.
It is orthogonal to the card — a branch with no card still has a PR to review —
and it is **absent, never disabled, when there is no PR**: with no `gh`, no auth
or no pull request the evidence carries no `pr` at all, and a greyed-out Approve
sends the operator hunting for a reason that does not exist.

**Composer.** A strip on `border-t border-border bg-surface-2`,
`p-[10px_12px]`, opened by that button and built from the same primitives as the
bounce composer directly above it: an 11px `--text-4` label, the repo + PR
number in mono 11px `--text-3` pushed right, a 4-row mono textarea
(`.scrollable`), then the **copy-paste boundary line** in 11px `--text-4`, then
the action row — **Cancel** on the left, the three verdicts pushed right at
`gap-7px`.

**The three verdicts carry one class string between them.**

> `APPROVE`, `REQUEST_CHANGES` and `COMMENT` get **equal prominence, equal click
> cost, and no default selection.** A surface where approving is one click and
> objecting is three teaches people to approve, and that is the review theatre
> this whole epic exists to fight — the research behind it found 31% more PRs
> merging with no review at all.

Concretely: all three are secondary buttons (`h-26px border-border-2
bg-surface-2 rounded-sm px-[11px]`, 12px `--text-2`, hovering to `border-text-4
text-text`), rendered from **one constant in a `v-for` over `REVIEW_VERDICTS`**,
so there is nowhere for an accent fill or a heavier weight to attach itself to
one of them. None takes `.btn--primary`. None is pre-selected. All three require
a body and disable identically without one — GitHub itself lets an approval skip
the prose and demands it from the other two, and that asymmetry is exactly the
one this surface must not inherit.

**Nothing recommends a verdict.** No "CI is green — approve?", no pre-filled
body, no Approve disabled by red checks (which reads as the tool having an
opinion) and none encouraged by green ones (which reads as endorsement). The
receipts state facts, the human concludes, the pane carries it — three different
jobs, and this strip does exactly one of them.

**Confirm.** Every submission passes a modal first (`min(460px, 90vw)`,
`radius 10px`, `--shadow-pop`, the standard dialog anatomy of
`SweepConfirmDialog`): the **verdict** in the title, `owner/repo #n` in mono
12px `--text-3` under it, the **copy-paste boundary** as 11.5px `--text-3`
prose, and Cancel + a single `.btn--primary` naming the verdict again. A review
submitted to the wrong PR is not undone by an undo; it is undone by an
explanation.

> **The boundary line is the one sentence that changes what someone does next.**
> Once text from a companion session is pasted into that body it goes out under
> the operator's identity and carries no different status from words they typed
> themselves. Pasting is allowed and unenforceable anyway — saying it at the
> moment of submission is the whole intervention.

**Outcome.** A submitted state renders ONLY off a zero exit code. A guard
refusal, a `gh` failure and an IPC failure all raise a `danger` toast carrying
the reason verbatim and leave the composer open with the operator's prose still
in it. An approval someone believes happened and did not is strictly worse than
a visible error.

#### Empty and degraded states

Never a blank pane. `border border-dashed border-border-2 rounded-[--radius]`,
`p-[26px_18px]`, centred, `bg-surface`: a 13px `--text-2` headline and 12.5px
`--text-3` prose, with branch names in mono `--text`. The states are: no commits
ahead of base (paired with the `✕` discrepancy line above), nothing to review /
already merged, and worktree gone — the last offers the card, not the diff.

**Three more, added by T246, and they take PRECEDENCE over every state above.**
Same panel anatomy; what makes them their own states is that each says why there
is no diff rather than reporting a count of zero.

- **`head not fetched`** — the head of a PR nobody checked out here has never
  been fetched. Adds a secondary `.btn` (`Fetch this head`, refresh icon,
  `h-26px`) directly in the panel, `mt-3`: this is the one state whose fix is a
  single gesture, and sending the operator hunting for the header's refresh icon
  is the difference between a state and a dead end.
- **`head fetch failed`** — a fetch ran and did not go through. Same panel, same
  button, a different sentence (network / `gh` auth).
- **`base unresolved`** — the PR targets a base that does not exist in this repo.
  **No button**: fetching would not help, and offering one would promise a
  recovery that cannot happen.

> **This ordering is the whole point of the card, not a detail.** `runGit`
> degrades every failure to `null` and `parseCount(null)` is `0`, so a diff
> against a ref that is not on disk renders IDENTICALLY to a branch with nothing
> committed on it. An operator reads "no commits", concludes nothing happened,
> and Closes — the R2 failure the pane exists to prevent, reached from a new
> direction. "Nothing was read" and "nothing is there" must never share a
> sentence, a panel, or a receipt value.

---

### Scheduler (takeover)

A **seventh main-pane takeover** — same shape/rules as
`RoadmapBoard`, `PrStackCanvas`, `UsageDashboard`, `SystemMonitor`,
`CleanupView` and `ReviewPane` (replaces `<main>`, sidebar/topbar stay
visible, mutually exclusive through the same `stores/ui.ts` registry; see
"Takeover dismissal"). **Global scope, not per repo** — a worker names its own
folder on its own row, so the list spans every repo at once, the same posture
as `CleanupView`.

A **worker** runs one prompt, in one folder, on a cadence, without ever
opening a session — the surface exists to create, watch and tune those.

**Header: `TakeoverShell` chrome (T300/U3, see "TakeoverShell — shared chrome"
above)** — the shared 40px header, **not one this view draws**. It supplies the
`h-10 border-b border-border bg-surface` bar, the title ("Scheduler"), and the
close `X` (22×22px, labelled from `scheduler.close`). Teleported into it by
`SchedulerView.vue`: the `Clock` icon (`--accent`, 15px) into
`#takeover-shell-icon`, and into `#takeover-shell-actions` the live subtitle
(`"{n} workers · {m} running"`, 11px `--text-3`) → spacer → the primary **New
worker** button (`btn-primary btn-sm`, `Plus` icon).

Until BUG-120 this view still drew that header itself — it shipped before
`TakeoverShell` existed and was the one takeover never migrated — so the
Scheduler rendered **two** stacked headers, two titles and two close buttons,
one under the other. Both `<Teleport>`s carry `defer` and are the **last** root
siblings, for the two reasons the shared-chrome section gives: without `defer`,
opening the Scheduler as the first takeover of a session resolves the target
before the header span is in the document (a silent missing icon, no error);
and a Teleport placeholder as the first root node breaks `wrapper.element` in
Vue Test Utils.

**Root: `flex min-h-0 flex-1 flex-col bg-bg`** — a well-behaved flex child of
the shell's column, the same posture as `SystemMonitor`'s
`min-h-0 flex-1`. Never `h-full`: the view sits BELOW the shell's 40px header,
so `h-full` asks for 100% of the shell one header lower down. **It did not
overflow, and that was measured rather than reasoned** — the view is the shell's
only flex child, so the default `flex-shrink: 1` absorbs the surplus exactly and
a `h-full` root still lands at `shell − 40px` (rebuilt with `h-full` restored,
and again with the whole pre-BUG-120 component: the bottom edge sits on the
footer's top edge either way). The reported doubling was the header and the
bottom bar, not this. `h-full` still goes, for the two honest reasons: the
declaration is wrong about its own box, and one sibling at this level or a
`flex-none` turns it into a real 40px spill over the status footer.
`tests/e2e/ci/scheduler-result-css.spec.ts` pins the bottom edge against the
footer in a real browser and injects that exact break to prove the assertion
still catches it.

**Body: list/detail split**, `flex; min-height: 0`.

#### Worker list (`SchedulerWorkerRow.vue`, 300px column)

`width: 300px; border-right border-border; bg-sidebar; overflow-y: auto` —
the same shell as the sidebar itself, because a worker list reads like a
second sidebar, not a table. Grouped under two `wgroup` headers (`24px`,
`bg-surface`, 11px uppercase `--text-3`, `0.04em` tracking): **Enabled · {n}**
then **Off · {n}** — off workers sink into their own group instead of
interleaving, so a quiet list reads at a glance.

**Row anatomy** (`46px`, `padding: 0 10px 0 12px`, `border-bottom
border-border`, `cursor: pointer`, `position: relative`):

- **Main column** (flex, min-width 0): the worker name (12px/500 `--text`,
  ellipsised) over a meta line (11px `--text-4`) — `folder · branch ·
cadence`, separators inked `--text-disabled` (dimmer than the meta text
  itself — a separator earns less ink than the words it splits).
- **State column** (right-aligned, 11px, flex: none): a 6px dot + a label,
  one of the five states below.
- Hover: `bg-surface`. Nothing else about the row's geometry moves on hover —
  the actions cluster (below) slides in over the same fixed layout rather
  than reflowing it.

**Five row states, five token pairs:**

| State      | Dot                                                          | Label color | Copy                      |
| ---------- | ------------------------------------------------------------ | ----------- | ------------------------- |
| `waiting`  | `--text-4`                                                   | `--text-3`  | `next in {duration}`      |
| `running`  | `--green` + `.anim-pulse-dot`                                | `--green`   | `running · {elapsed}`     |
| `failed`   | `--red`                                                      | `--red`     | `failed · {n} in a row`   |
| `disabled` | `--red` (the SAME `dot-failed`/`st-failed` pair as `failed`) | `--red`     | `disabled · {n} failures` |
| `off`      | `--text-disabled`                                            | `--text-4`  | `off`                     |

**`disabled` reuses `failed`'s exact tokens — no new pair.** A worker
auto-disables after N consecutive failures (the tick runner's own guard,
`card/T294-scheduler-runtime`); the row's copy is what tells the two apart,
because both are the same fact from the operator's chair: "this worker's
cadence stopped producing anything trustworthy." `off`, in contrast, is a
**deliberate** stop (the header `ToggleSwitch`, see below) — it gets its own
quieter `--text-4`/`--text-disabled` pair and, on top of the row's own
coloring, dims the **entire row** to `opacity: 0.55` (`.wrow.is-off`). That
55% dim is the row's only opacity rule, and it applies to nothing else —
`failed`/`disabled` stay at full strength, because a red row that is also
dimmed would read as "less broken" than it is.

**Selected row: a 2px accent rail, painted as a `::before` bar — never a
border.** `.wrow.is-selected::before { position: absolute; left: 0; top: 0;
bottom: 0; width: 2px; background: var(--color-accent) }`, layered over the
`bg-surface` wash `.is-selected` itself already applies. This is the exact
contract the Review pane's blast-radius marker already established (§ "Diff —
file box" above, "It is a bar child, not a border on the box"): a left
**border** on a row that also carries its own `border-bottom` would either
collide with that border's shorthand or get silently clipped, and — because
the list column has no per-row rounding — would still shift every row's
content box by its own width the instant it toggled on. The rail is a sibling
layer instead, so selecting a row costs zero reflow.

**Row actions — hover-revealed, two icon buttons.** `.wrow-actions { opacity:
0; transition: opacity var(--dur) var(--ease) }`, revealed on `:hover` or
`.is-hovered` (keyboard/touch parity, the same idiom every other hover-gated
row action in this app follows): **Run now** (`Play`, `.iconbtn`) and
**Delete** (`Trash2`, `.iconbtn.is-danger` — `--text-3` at rest, `--red` on
hover). `22×22px`, `hover:bg-surface-2`. The actions cluster and the state
column share the same slot at the row's trailing edge; hovering (or the
`.is-hovered` state) is what decides which one is currently showing.

#### Worker detail (`SchedulerWorkerDetail.vue`, remaining width)

`flex: 1; min-width: 0; bg-bg`. Head block (`padding: 12px 14px 0`, column,
`gap: 8px`):

- **Title row:** the worker's name (13px/600) + its mode badge (`observe`
  shown in the frozen spec → Badge **Accent**, §6 Badges) + a model·effort
  badge (Badge **Default**, e.g. `haiku · low`) → spacer → **Run now**
  (`btn-sm`) → the enable `ToggleSwitch`.
- **Tabs:** `Runs` / `Settings`, `border-bottom border-border`, the active tab
  underlined in `--accent` (`margin-bottom: -1px`, overlapping the row's own
  border) — the standard tab idiom, no new pattern.

`.wd-scroll`: `flex: 1; overflow-y: auto; padding: 12px 14px 16px; gap: 14px`,
direct children pinned to `flex: none` — a flex column's children shrink by
default, and without this a card would compress and clip its own body text
instead of letting the column scroll (the spec's own reasoning for the rule).

**Runs tab, four blocks — only the runs table is unconditional:**

1. **Running strip** — only while the worker has a run in flight:
   `bg-green-soft border-green-line`, `padding: 8px 10px`, 11.5px, `--green`
   text, the pulsing dot, `"Running now — started {elapsed} ago, times out at
{timeout}"`, spacer, a **Stop** button (`btn-danger btn-sm`, an outlined
   stop-square icon).
2. **Last result** card — the `.card` shell (`border-border rounded
bg-surface`), a `.card-head` (a list icon + uppercase 11px `--text-3` label,
   `"Last result · {ago}"`), body `padding: 10px`: the newest run's **run-result
   prose block** (below). A run with no text renders the same muted line the
   disclosure uses — _"This run produced no result."_ — never a bare `—`.
3. **Recent runs** card — a `table.runs`: `Time / Status / Turns / Cost /
Duration`, header row `bg-surface` uppercase 11px `--text-3`, body rows
   `--text-2`, numeric columns right-aligned `tabular-nums`. **The status
   cell carries a dot only for `running`** — `ok` renders as plain `--text-2`
   with no dot and no green (a finished run isn't "safe", it's just done —
   the same posture the Review pane's own "no green means safe" rule takes,
   arrived at independently here), `skipped` reuses the muted `.st-off`
   (`--text-4`), `error`/`timeout` reuse `.st-failed` (`--red`). A dot on a
   table row would claim the row is still live; only `running` ever is.

   **Row disclosure.** Every stored run keeps its full `result`,
   `terminalReason` and `denials`, 200 deep — the table showed five numbers of
   it and nothing else, so 199 of the 200 results were unreachable. A body row
   is therefore a **disclosure trigger**: `cursor: pointer`, `hover:bg-surface-2`,
   and a leading `chevron-right` (10px, `--text-4`) in the Time cell that rotates
   90° when open — the same chevron-rotate idiom the Settings tab's own
   **Advanced** disclosure uses. One
   row is open at a time (opening another closes the first): this is a reading
   surface, not a comparison surface. **It expands in place** — an extra `<tr>`
   with a single `colspan="5"` cell directly under the row, inside the Recent
   runs card, in the Runs column. Never a modal: the Scheduler is already a
   takeover, and a dialog over a takeover is the one stacking the app doesn't do.

   **The control is a `<button>` in the Time cell, not the `<tr>` itself.**
   The row keeps `role="row"`; the button inside it carries `aria-expanded` and
   `aria-controls` pointing at the detail row's `id`. Putting `role="button"` on
   the `<tr>` — which is what shipped first — replaces the row's semantics
   wholesale: assistive tech announces a button instead of "row 3 of 12", and the
   `<td>`s lose the row ancestor that makes their column headers mean anything.
   The whole row stays clickable, because a 5-column row whose only hit target is
   the timestamp is worse to use with a mouse; that pointer affordance is a
   convenience layered on the control, never the control itself. The row's
   `@click` and the button's `@click.stop` are what keep one click from toggling
   twice. **Any future table-row disclosure in this app follows this shape.**

   The detail cell is `bg-surface-2`, `padding: 10px`, a column at `gap: 8px`:

   - **Result** — the **run-result prose block** (below), the run's own text. A
     run that never executed (`skipped`, `stopped`) or that produced no text
     renders one muted line (`--text-4`, 11.5px) — _"This run produced no
     result."_ — never an empty box that reads as broken.
   - **Ended** — a `--text-4` 11px line, `"Ended: {terminalReason}"`, shown only
     when the run recorded one.
   - **Tried and couldn't** — denial pill chips: `border-border-2`, mono 11px,
     `--text-2`, on **`bg-surface`** — shown only when THIS run has denials. The
     card in (4) stays bound to the newest run; this is how a past run's denials
     become visible at all.

     **The chip's fill is the one thing that flips with its context, and it has
     to.** The card in (4) is a `--surface` card, so its chips take `--surface-2`;
     this detail cell is itself `--surface-2`, so its chips take `--surface`. Same
     border, same type, opposite fill — each chip is one step off its own ground.
     A `--surface-2` chip here would be the cell's own colour (measured on the
     running app: `rgb(41,35,31)` on `rgb(41,35,31)` in `default-dark`,
     `rgb(236,236,239)` on `rgb(236,236,239)` in `light`) and only the border
     would survive. Read the pair as "one step off the ground you're on", never
     as a fixed token.

**Run-result prose block.** `Run.result` is whatever the model wrote in
a headless `claude -p` — very often a full triage report with headings, bold and
a markdown table. Both surfaces that show that field — the **Last result** card
and the row disclosure's **Result** — render it through the app's existing
markdown seam (`MarkdownRenderer.vue` → `renderMarkdown`, §6 "Markdown pane"),
never as raw text. **One class list, used verbatim by both**, because they show
the same field a few pixels apart and must not disagree: before T311 the card
collapsed every newline into one run-on paragraph and the disclosure kept the
newlines but printed `##` and table pipes literally.

- **Shell:** `max-height: 220px` + `overflow: auto` on **both** axes, `.scrollable`
  (the 8px hover-revealed scrollbar every other scrolling surface uses). No
  border, no fill — it is prose on the card's own ground, not a nested card.
- **Vertical clamp** — a long report scrolls inside the block instead of pushing
  the Runs tab's other cards off screen. 220px is the same clamp the roadmap
  card's own raw-text block uses; a result longer than that is a document, and a
  document is read by scrolling it, not by growing the page.
- **Horizontal scroll is load-bearing, not decoration.** A markdown table in a
  result nests a `<table>` inside the runs `<table>`; the block is a scroll
  container, whose min-content contribution in its scrolling axis is zero, so the
  outer table keeps shrinking to its column and the wide table scrolls inside the
  block instead of widening the panel.
- **A markdown table keeps its natural width** (`min-width: max-content`) instead
  of compressing into the panel — left to compress, a 7-column triage table
  breaks its own header words mid-word (measured on the running app at 560px,
  `Owner` renders as "Owne r"). **BUG-119 lifted both this rule and a per-table
  `.md-table-scroll` wrapper into the shared seam**, so the natural width now
  widens the WRAPPER's scroll, not the block's: the result's paragraphs stay put
  while the table scrolls. This block's local `min-width: max-content` is
  therefore **redundant** — it restates what the seam already says. It is left in
  place deliberately (BUG-119 was scoped not to touch this component beyond
  deleting the list-marker override), and removing it is a follow-up.

  **One T312 browser guard is superseded by this and currently RED**: `a wide
table scrolls the result block, never the runs column` asserts
  `scrollWidth > clientWidth` on the block, and the block correctly no longer
  scrolls — measured 806 vs 806 with the fix in. Its other assertions (the runs
  column and the `overflow-hidden` runs card are never widened by a nested table)
  still hold and still matter. Re-expressing that first assertion against the
  wrapper is the follow-up; it was left red rather than edited so the conflict is
  visible instead of absorbed. See `tests/e2e/ci/scheduler-result-css.spec.ts`.

- **List markers come from the shared seam** (`MarkdownRenderer.vue`), not from
  here. They were briefly restored in this block alone, when the seam was out of
  T311's scope; BUG-119 lifted them to the renderer for all seven consumers and
  **deleted the local override**, so there is exactly one place that decides what
  a bullet looks like.
- **`white-space: pre-wrap` on the block's paragraphs** — and only its
  paragraphs. A result is not always markdown: a stack trace or a JSON blob is
  parsed as one paragraph, and the seam runs `markdown-it` with `breaks: false`
  (shared with six other consumers, so not ours to re-tune), which collapses
  those newlines to spaces. `pre-wrap` restores them without changing how
  headings, lists, tables or fenced code render.
- **Sanitising is the seam's job, and the point of routing through it.** A result
  is text a model wrote after reading a repository, so it can carry whatever the
  repository carries; `renderMarkdown` is `markdown-it` with `html: false` plus
  DOMPurify (§6 — Markdown pane, layers 1–2), so a `<script>` tag renders as
  literal text and a `javascript:` link renders inert.

4. **Tried and couldn't** card (denials) — only when the worker's recent runs
   hit permission denials: a `.card-head` with a `TriangleAlert` icon, then a
   `.denials` wrap of pill chips (`bg-surface-2 border-border-2`, mono,
   `--text-2`, a trailing `×{n}` count in `--text-4`) — one pill per distinct
   denied tool call, e.g. `Edit ×9`. A `.hintline` (11px `--text-4`) closes
   it: _"This worker keeps reaching for write access. Either narrow its
   prompt, or switch it to **act** and accept what that means"_ (the bold
   word inline-styled `--text-2`, the sentence's only emphasis).

**Settings tab** — `.fsection` groups at `gap: 16px`, each a `label-left
(132px) / control-right` row (`.flabel`/`.fctl`, a `SettingHint`-style
secondary line under the label), separated by `.divider` hairlines. No card
chrome — the same "plain stack, no card" rule the Hibernation policy pane
(above) already uses for a Settings tab this short:

- **Identity** — Name (`.input`); Folder (`ui/FolderCombobox.vue` — folder
  icon, `{alias} · {branch}` value with the branch dimmed, chevron; hint
  _"Where the tick runs, and where its skills come from"_); Prompt
  (`SchedulerPromptField.vue` — a 4-row `.textarea` plus the mention popup and
  chip row defined immediately below; hint _"Type / to name a skill. Only the
  skills you name are staged for the tick"_).
- **Schedule** — Every `{n}` minutes (`.input.short` + a `minutes` suffix);
  Run on boot (`ToggleSwitch`, hint _"Fires once when Harnu starts,
  staggered"_); Remember last run (`ToggleSwitch`, hint _"Prepends the previous
  result as one line"_); **Notify me** (`SegmentedControl` at `sm`, three
  options — `Silent` / `On failure` / `Every run`, no `allowDefault` pill: the
  default IS `Silent` and a fourth neutral pill would only make it ambiguous).
  Hint, on two lines under the control (`--text-4`, 11px/1.5): _"Silent still
  tells you when a worker disables itself or its folder disappears. A worker's
  own prompt can notify you too — leave this Silent to avoid hearing the same
  thing twice."_ The scheduler's own voice is about the machinery; the prompt's
  voice is about the findings, and the control exists so the two don't overlap.
- **Execution** — Model (a combo); Effort (`SegmentedControl`,
  `low/medium/high/xhigh/max`); Timeout (`.input.short` + a `seconds` suffix).
  **No Provider picker**: one was drawn and persisted, but nothing on
  the spawn path ever read it, so the control promised a bill it could not move.
  A control that cannot change the outcome is worse than a missing one — it was
  removed rather than left inert. Same for the transcript toggle: it
  only chose `--output-format stream-json`, which nothing wrote down.
- **Permission** — Mode (`SegmentedControl`, `observe` / `act` — see the
  callout immediately below) with a one-line dynamic hint under it that
  changes with the selection (`observe`: _"Reads the repo, never writes to
  it. Can raise a card and notify you"_); then, **only while `observe` is
  selected**, a **Network access** row (BUG-166): a `ToggleSwitch` (off by
  default) under the 132px label _"Network access"_ with a `SettingHint`
  (_"Off by default. Without it this worker cannot reach the internet."_). While
  the switch is off the row carries nothing else. While it is on, the same
  danger callout the `act` mode uses sits under the switch (`TriangleAlert`
  13px `--red`, `border-red-line bg-red-soft`, 11.5px/1.5), bold lead in
  `--red` _"Lets this worker send data from files it reads to the internet."_ and
  the rest in `--text-2`: _"A prompt injection in anything it reads — a README, a
  commit, a PR body — is enough to try."_ The switch is the opt-in to
  `WebFetch`: it is the one place the operator turns the network on, and it has
  no confirm of its own (the operator is the author). An agent turning it on
  through `create_worker` / `update_worker` is confirmed instead by the
  agent-action confirm (§6 → Agent-action confirm: the fail-closed
  `McpConfirmOverlay` modal when Harnu's window is focused, parked in the
  Approval Inbox when it is not, and back in the modal on focus), whose
  disclosure carries a **NETWORK ACCESS ON** paragraph in the same words. Nothing else in the Permission group changed:
  the **Extra read commands** tag field is gone (BUG-164), since `observe`
  runs with no shell for a rule to widen.
  **Migration notice:** a worker saved before this switch existed loads with
  it off. There is no banner and no dialog: one Activity entry, _"Scheduler:
  network access is now opt-in"_, lists the observe workers whose prompt names
  a URL or WebFetch and names the **Network access** switch (the exact label)
  as the place to turn it back on. The command bridge refuses until the
  renderer is ready, so the notice is owed, not fired: it is written to
  `schedulers.json` in the same write that heals the workers, retried until a
  dispatch succeeds, and cleared only then (a boot that never gets a ready
  bridge leaves it for the next one). It is delivered once.
- **Delete worker** — a lone `btn-danger btn-sm` at the foot of the tab, no
  divider beyond the group's own.

#### Prompt field — skill mentions (`SchedulerPromptField.vue`)

A tick is spawned with `--setting-sources ''`, so it never discovers the
operator's own `~/.claude/skills/` or the repo's `.claude/skills/` the way a
session does. The only skills it can see are the ones Harnu copies into the
staged plugin dir. This field is where the operator says which ones — and,
just as importantly, where Harnu says back whether the name it was given
actually resolves.

**The whole control is a view of one string.** Nothing beside the prompt is
stored: the chips are recomputed from the prompt text on every render, and the
tick recomputes the same set from the same string when it fires. A mention
deleted by hand loses its chip; a mention typed by hand gains one.

**The textarea** is unchanged from the rest of the Settings tab (4 rows,
`w-full resize-y rounded-sm border border-border-2 bg-surface px-2.5 py-2`,
12px/1.55, `--text`).

**The mention popup** — the dropdown-over-input idiom already established by
`ui/FolderCombobox.vue` and `ui/BranchCombobox.vue`, with the same tokens and
the same keyboard contract:

- Opens only when `/` is typed at a **word boundary** — start of the field or
  after whitespace. A `/` inside `src/main/` or `docs/user/` opens nothing; a
  prompt full of paths must stay comfortable to type in.
- Anchored under the **textarea's own box**, not the control's — the chip row
  below grows, and a popup measured against the whole control would drift
  further from the caret with every skill named. `absolute z-20 mt-1 w-full
max-h-[220px] overflow-y-auto rounded border border-border-2 bg-surface
shadow-pop`.
- One row per skill, 26px, `px-2.5`, 12px `--text`: the skill name in mono,
  then its **origin tag** pushed right (11px `--text-4`, uppercase-free) —
  `bundled` / `personal` / `project`. Active row: `bg-surface-2`.
- Filtered by what has been typed since the `/`, prefix-first.
- `↑`/`↓` move, `Enter`/`Tab` pick, `Esc` dismisses; a space or a character
  that matches nothing dismisses too. Picking inserts the literal `/{name} `
  into the prompt at the caret — the model reads the name, Harnu parses it.
- `role="listbox"` on the list, `role="option"` + `aria-selected` on the rows,
  `aria-expanded` on the textarea — the same a11y wiring the two comboboxes use.
- Empty result set: one non-interactive 26px row, 11px `--text-4`, `$t(...)`
  _"No skill matches"_.

**The chip row** sits directly under the textarea (`flex flex-wrap gap-1.5
pt-0.5`), one chip per distinct mention in prompt order. A chip is 20px,
`px-2 rounded-sm border`, 11px, the name in mono followed by a `·` and its
origin word in `--text-4`. Two states, and the second is the reason the row
exists rather than inline colouring inside the textarea:

- **Resolved** — `bg-surface-2 border-border-2 text-text-2`, e.g.
  `land-prs · personal`. Same pill shape as the denial chips in the Runs tab.
- **Not found** — `bg-red-soft border-red-line text-warning`, a
  `TriangleAlert` (11px) ahead of the name, and the origin word replaced by
  `$t(...)` _"not found"_. This is the failure the field exists to make
  visible: a skill name that looks perfectly fine and silently resolves to
  nothing at 3am. It is never suppressed, and it never blocks saving — the
  operator may be about to create the skill.

The mention the caret is still **inside** gets no chip while the popup is open:
`/l`, `/la`, `/lan` would each flash their own "not found" the whole time the
operator is picking from the list that resolves them. It is still a view of the
text — the row simply declines to render the one token that is mid-keystroke,
and the chip appears the moment the caret leaves it.

A prompt with no mentions renders no chip row at all (no empty container, no
placeholder line).

#### The one red `SegmentedControl` selection in the app

`SegmentedControl`'s selected option is `--accent-soft` / `--accent` /
`--accent-line` everywhere else in Harnu (§6 Components, "`SegmentedControl`").
**The Permission mode control's `act` option is the sole, deliberate
exception**: selecting it renders `.is-on-danger` — `bg-red-soft`,
`border-red-line`, `color: --red` — instead of the accent triple. Every other
warning surface in this app puts the danger color on a **separate** element
next to the choice (the blast-radius marker, a destructive button's own
border); here the danger color sits **on the choice itself**, because the
selection _is_ the warning — there is no way to pick `act` and not be
choosing the exact thing the red communicates. Directly beneath the control,
a `.warnbox` (`bg-red-soft border-red-line`, `padding: 9px 10px`, 11.5px, a
`TriangleAlert` icon in `--red`) restates it in prose — _"**This worker
writes, commits and pushes on its own, every {n} minutes.** It does not stop
at the Approval Inbox — nobody is there to answer. Harnu still blocks
catastrophic shell commands, but nothing stops a bad prompt from committing
garbage."_ — but the box is reinforcement, not the primary signal: the pill
has already said it.

**Delete confirm.** A `.confirm` panel (`border-red-line bg-red-soft
rounded`, `padding: 11px 12px`): `"Delete "{name}"?"` (12px/500) + a body
line (_"Its {n} stored runs go with it. Nothing else is touched — no card, no
session, no file in the repo"_) + a `Delete worker` (`btn-danger btn-sm`) /
`Cancel` (`btn-ghost btn-sm`) pair. Same shape as every other destructive
confirm in the app — a danger-toned card, prose that names exactly what is
and isn't touched, two buttons.

**Empty state.** No workers yet: the takeover shrinks to a 320px shell
(header unchanged, no toolbar), a centred `.empty` block — a 26px `Clock`
glyph (`--text-4`), a 13px/500 headline (_"No workers yet"_), a 380px-capped
12px `--text-3` body (_"A worker runs one prompt in one folder, on a cadence,
without opening a session. Good for watching a repo, answering review
comments, or checking something on a timer."_), and the same primary **New
worker** button as the header.

**Footer caption** (30px, 11px `--text-4`, `padding: 0 12px`, **no background
and no top border**): a `Clock` icon + the tick engine's own facts, never
per-worker state — `"Checks every {n}s · max {n} workers at once · nothing runs
while Harnu is closed"`. It sits on the view's own `--bg`, as the last
`flex-none` child.

It was a **bar** (`bg-surface border-t border-border`) until BUG-120, and that
is what the operator's screenshot was actually reporting: the app status footer
is `h-6 border-t border-border bg-surface` with 11px text, so the two carried
the identical treatment and sat flush — 54px of chrome reading as one doubled
bar with a hairline through the middle, the mirror at the bottom of the doubled
header this view had at the top. **The window has exactly one bar at its
bottom, and it belongs to the status footer.** A takeover's own trailing note is
a caption on its own ground; `tests/e2e/ci/scheduler-result-css.spec.ts` asserts
the property directly — no element of the takeover that ends where the footer
begins may carry both a top border and the footer's background — and injects
the old treatment to prove the assertion still fires.

**Copy (§8):** worker names, folder aliases, branch names, model ids and
tool-call denial labels (`Edit`, `Bash(git commit)`) stay untranslated, the
same rule branches and tool names follow everywhere else; every state word,
hint and button label goes through `$t()`.

### Scheduler footer pill (StatusFooter.vue)

Right cluster of the footer, the same slot family as the Cleanup pill and the
heap gauge above (`.fpill`, borderless, `20px`, `padding: 0 7px`, 11px). **Two
variants, gated on whether anything is running:**

- **Quiet** — a `Clock` icon (11px) + `$t('scheduler.footerPill')`
  ("Scheduler"), `--text-4` at rest, `--text-2` on hover (`bg-surface-2`) —
  present whenever at least one worker exists, so the entry point doesn't
  disappear the moment nothing happens to be running.
- **Running** — replaces the icon+label with the pulsing green dot
  (`.anim-pulse-dot`) + `"{n} running"`, `.fpill.is-running { color:
--green }` — the pill itself turns into the count, the same trade the
  sidebar's own supervision-load counter makes (§ "Footer / status bar"
  above): the number _is_ the status, no separate badge needed.

Click **toggles** the Scheduler takeover (`ui.toggleScheduler()`); while it is
open the pill inks `--accent` and carries `aria-pressed`, the same
active-state contract every other takeover entry point follows (see
"Takeover dismissal").

---

### Folder View (FolderView.vue)

Spec: `docs/specs/T212-folder-view.md` (the original view). The main-pane view a **folder click**
opens — the folder's home screen. Deliberately **not** a sixth takeover: it is
**selection-driven**, exactly like `TerminalPane`. `sessions.selectedFolderPath`
drives it, and it sits after the five takeovers in `App.vue`'s view chain
(`… → RoadmapBoard → Onboarding → FolderView → EmptyState → TerminalPane`). So
opening the Roadmap board from a folder shows the board, and closing it returns
here, because the folder selection was never lost.

**Selection is symmetric with a session.** `select(id)` and `selectFolder(path)`
each clear the other, so a folder and a session can never both read as selected.
This is why "+ New session" clicked from the Folder View reaches the terminal
instead of staying stuck behind the index: minting, forking, and opening a folder
terminal all route through `select(id)`, same as clicking a session row (shared
rule above). The sidebar folder row paints `--accent-soft` when selected, identical
to a selected session row — the two are peers and must read as peers. The keyboard
path matches: `cursorActivate` (Enter on the arrow-key cursor) mirrors the click
exactly — select, expand on the way in, collapse on a repeat with the selection
kept. The row's visual focus ring is not DOM focus, so this parity has to be
written, not inherited from the native `<button>`.

#### Scope is the organising idea

**Half of this view is not about the folder you clicked.** `resolveMemoryCheckout`
and `resolveMemoryLocation` collapse every worktree of a repo onto its main
checkout, so "Where we left off" and the roadmap counts a worktree shows are
**byte-identical** to what main shows; the worktrees list is the repo's siblings,
not this folder's children. The first version printed all of it in one undivided
column, which read as a description of the folder. That is the ambiguity this
redesign exists to kill.

| Block                         | Real scope    | Why                                                   |
| ----------------------------- | ------------- | ----------------------------------------------------- |
| Sessions                      | `this folder` | `folder.sessions`, keyed by cwd                       |
| Git (branch, dirty, ↑↓)       | `this folder` | `folders:gitStatus` on this path                      |
| The card this branch owns     | `this folder` | `card.executedIn` === this branch                     |
| Where we left off (`hot.md`)  | `repo`        | `resolveMemoryCheckout` collapses worktrees onto main |
| Roadmap counts / cards        | `repo`        | same collapse, via `roadmap:peek`                     |
| Worktrees                     | `repo`        | siblings by `repoId` — all of them                    |
| Worktrees in flight (fan-out) | `repo`        | every sibling, not just children                      |
| Activity · 14d                | `repo`        | sessions bucketed across the repo                     |

That table is **data, not prose**: it lives in `folder-view-format.ts` as
`BLOCK_SCOPE`, and every header reads its tag from it through `scopeOf(block)`.
A block can never be tagged by hand in a template, so a tag can never drift from
the read that feeds it.

**Scope tag (`ui/ScopeTag.vue`).** A 10px chip: `--border` 1px, radius
`--radius-sm` minus 2 (3px), `0 5px` padding, `--text-4` text, no uppercase and
no letter-spacing — deliberately quieter than the `eyebrow` it sits beside, since
it qualifies the label rather than competing with it. Two variants:

- **`this folder`** — plain border (`--border`).
- **`repo`** — `--border-2` border plus a 9px `git-fork` icon. The stronger border
  and the icon are the whole signal: repo-wide blocks are the ones that lie if you
  read them as folder-local, so they are the ones that get marked.

Each carries a `title` explaining _why_ (`folderView.scope.thisFolderHint` /
`folderView.scope.repoHint`), so the chip teaches the model instead of just
labelling it.

#### Two profiles, one view

The view resolves a **profile** from the folder, in `folder-view-format.ts`:

```
resolveProfile(folder) → 'worktree'  when the folder is a git folder AND
                                       isMainWorktree === false
                       → 'main'      otherwise (main checkout, or a plain
                                       non-git pinned folder)
```

A non-git folder gets the `main` profile: it has no siblings and no branch, so
the worktree cockpit would be a frame around nothing.

**Profile 1 — main checkout: the orchestration home.** Main has few sessions and
they are the ones that plan and dispatch, so the lead block in the content stack
is the **fan-out** (`Worktrees in flight`) — the one thing only main can show.

**Profile 2 — worktree: one feature's cockpit.** A worktree exists to land one
card and then die, so the hero above the grid is **the card this branch owns**
plus its progress rail. The repo-scope blocks stay present but shrink into the
labelled rail, never pretending to be about this folder.

Neither profile duplicates the other's hero: the fan-out is meaningless in a
worktree (it is the repo's view of itself), and the owned card is meaningless on
main (main owns no card).

> **Reserved slots.** T285 landed the skeleton — the profile switch, the scope
> tags, the width and the shaping seam. The two hero blocks were dispatched
> separately: **T286** filled the main profile (the `Worktrees in flight` fan-out
> table, the KPI strip and the `Activity · 14d` sparkline), and **T287** filled the
> worktree profile's hero (the owned-card block, below). Both have landed, so the
> T212 rule now applies only to what each profile deliberately omits: a section
> with nothing in it renders nothing at all, and a placeholder is worse than an
> absence. **The activity strip is absent from the worktree profile permanently**,
> not pending: a two-day worktree has nothing to trend, and the sessions bucketed
> into it are the repo's, not the branch's.

#### Container and grid

**No width cap.** The 880px column is gone; the view uses the pane. Outer element
is `overflow-y: auto`, inner column `padding: 24px`, `gap: 24px`.

The body below the action bar (and below the worktree hero) is a two-column grid:

| Pane width | Grid                                                            |
| ---------- | --------------------------------------------------------------- |
| `> 1100px` | `minmax(0, 1fr) 320px` — content stack + rail, 24px gap         |
| `≤ 1100px` | one column; the rail becomes a **2-up grid** below it, 16px gap |
| `≤ 760px`  | one column throughout; the rail stacks 1-up                     |

1100 and 760 are the view's own breakpoints (they match the approved spec's
viewports) and are declared in `FolderView.vue`'s scoped style, not as global
Tailwind screens — no other surface shares them. Every grid child carries
`min-width: 0` so a long branch name truncates instead of widening the column.

**The folded rail is `align-items: start`.** At full width the rail is a flex
column, where each card is its own content's height. When it folds to a 2-up
grid it must keep that: a grid's default `stretch` makes every card as tall as
the tallest in its row, and on a real repo — a roadmap card listing 88 cards in
review, a worktree list with 90 rows — that drags its row-mate to some 3000px,
so a 44px activity chart floats at the top of a bordered box three screens tall.
A card's height means "this is how much this block has to say"; a fold must not
change that.

> **They are container queries (`@container folder-view`), never media queries.**
> The Folder View is a pane, not a page. The sidebar and the Fleet rail routinely
> take half the window: a 1440px window gives this view ~850px, and an 820px
> window gives it ~230px. Keyed on the viewport, the rail's 2-up fold fires inside
> a 230px pane and paints two ~110px columns of one-letter lines — measured, not
> hypothetical. `.fv` carries `container-type: inline-size`, so the breakpoints
> describe the space the view actually has. Any breakpoint added to this view
> later must be a container query, for the same reason.

#### Height caps — the two lists that scroll

Measured on this repo: **102 worktrees, 128 cards**. The redesign was drawn
against six rows, and at that scale the two long lists simply ran off the bottom.
The fan-out pushed the Sessions block roughly three screens down; the rail's
roadmap list did the same to everything under it. The page's own
`overflow-y: auto` was the only scroll in the view, so the operator paid for the
length of the longest list with the visibility of every block below it.

Two blocks therefore carry a **fixed cap and scroll inside themselves**:

| Block                                  | Token                  | Value   | ≈ rows |
| -------------------------------------- | ---------------------- | ------- | ------ |
| Fan-out table body                     | `--fv-fanout-max-h`    | `380px` | 11     |
| A rail list (roadmap cards, worktrees) | `--fv-rail-list-max-h` | `280px` | 9      |

They are **tokens, declared in `themes.css` beside `--radius`** (§9), never px
literals in a component: three components read them, and a height that lives in
one of them is a height the other two can drift from. Both containers carry the
global `.scrollable` helper so they get the app's thin, hover-revealed scrollbar
rather than a platform one.

**`max-height` + `overflow-y: auto`, never a fixed `height`.** A list shorter
than its cap renders at its natural height, with no scrollbar and no reserved
gutter. A block's height must still mean "this is how much this block has to
say" — the same rule the folded rail's `align-items: start` exists to protect. A
cap is a ceiling, not a frame, and `scrollbar-gutter: stable` is deliberately
**not** used here for exactly that reason.

**The fan-out's header row stays put while its body scrolls.** ONE table inside
the scroll container — never a split header table and body table, which
desynchronises the `table-layout: fixed` column widths the fan-out's contract
depends on — with `thead th` at `position: sticky; top: 0` on `--bg`. Its bottom
rule is an `inset 0 -1px 0` box-shadow rather than a `border-bottom`: under
`border-collapse: collapse` a collapsed border is painted by the table, not by
the sticky cell, so a real border scrolls away with the rows.

Section micro-labels use the `eyebrow` idiom — 10.5px / `0.07em` tracking /
uppercase / `--text-4` — with the scope tag beside them on a shared header row
(`space-between`, the label group left, any link right).

**Rail blocks are cards, stack blocks are not.** Every block in the 320px rail is
a `--surface` card (`--border` 1px, `--radius`, `14px 16px` padding, `10px` gap);
blocks in the content stack are bare sections separated by the grid's 24px gap.
That is what makes the rail read as a rail rather than as floating text beside a
column, and it is the same card idiom the Settings panes and `UsageStatTiles`
already use.

#### Header and action bar

**Header.** Alias (18px/600), branch (mono 12px with a `git-branch` icon, 12px,
`--text-4`), a worktree-kind badge (`--border` 1px, radius 4px, 10px) reusing
`preview.folder.mainWorktree` / `preview.folder.worktree`, then the absolute path
(mono 11.5px, `--text-4`) and the git line: dirty count (`--warning` when > 0,
else `--text-4`), `↑ahead` / `↓behind` in `tabular-nums`. All of it reuses
`FolderPreview`'s copy keys — the two surfaces must never disagree about the same
folder. The header carries **no scope tag**: it _is_ the folder's identity, and
tagging it would imply the rest of the view is equally local.

**Action bar.** One accent-filled primary (`New session`, `--accent` on
`--accent-ink`) followed by bordered secondaries: Roadmap board, PR Stack, Browse
files, Open in VS Code, Open folder, Terminal here. Buttons are radius
`--radius-sm`, `7px 12px`, 12px text, with a 13px lucide icon at 1.6 stroke. This
duplicates the Topbar cluster on purpose: the view is the folder's home, and a
home you must leave to act on is not one. Identical in both profiles.

#### Blocks, by profile

Each renders **nothing at all** when it has no content — an empty box is worse
than an absent section. This rule is unchanged from T212 and survives the
redesign intact.

**Main profile**

| Slot  | Blocks                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------- |
| Strip | **KPI strip** — four tiles above the grid                                                                         |
| Hero  | — (the fan-out is the stack's lead, not a hero)                                                                   |
| Stack | **Worktrees in flight** `repo` · **Sessions** `this folder`                                                       |
| Rail  | **Where we left off** `repo` · **Activity · 14d** `repo` · **Roadmap** `repo` · **Worktrees in this repo** `repo` |

**Worktree profile**

| Slot  | Blocks                                                                           |
| ----- | -------------------------------------------------------------------------------- |
| Hero  | **The card this branch owns** `this folder` __                                   |
| Stack | **Sessions** `this folder`                                                       |
| Rail  | **Where we left off** `repo` · **Sibling worktrees** `repo` · **Roadmap** `repo` |

The worktree rail puts siblings above the roadmap because in a worktree the
neighbouring branches are the live context (what am I stacked on, what was cut
from me) and the board is background; on main the board is the work queue and the
siblings are its execution, so the order flips.

**The main rail leads with the short blocks.** `Activity · 14d` is a
44px chart with two axis labels — the most glanceable thing in the view — and it
originally rendered _last_, under both text lists. On a 102-worktree repo that
put it below some 230 rows: the operator had to scroll past every branch and
every card to reach the one block that could be read at a glance. Order in a rail
is a claim about how long a block takes to read, not about how important it is,
so the fixed-height blocks come first and the capped lists follow. The caps above
are what make that stable: without them the order alone would only move the
problem one block down.

Block-by-block:

1. **Where we left off** — the `hot.md` cue through `MarkdownRenderer`, in a
   `--surface` card. Absent when the repo has no memory. Tagged `repo`: a worktree
   shows its main checkout's snapshot verbatim.
2. **Sessions** — rows of `status dot · title · message count · relative time`,
   `hover:bg-surface`, radius `--radius-sm`. Clicking is `sessions.select(id)`,
   the same call the sidebar row makes. With zero sessions the section becomes a
   bordered `--surface` card carrying `folderView.noSessions` plus the primary
   CTA. The only block tagged `this folder` — and the reason the tag is worth
   having.

   **The dot is the sidebar's dot.** It is resolved by the same recipe
   `SidebarFolder`'s `statusDot` uses — archive overrides, then the canonical
   `dotFor(taskState, status, activityOf(...), transcriptState)` — and then folded
   onto three buckets by `activityBucket`: `stuck` counts as **working** (a
   stalled session is not an idle one), `needs-input` is its own, and every
   terminal or lifecycle state (`idle`, `completed`, `failed`, `archived`) reads
   **idle**. Colours are the sidebar's: 6px `--green` with `anim-pulse-dot` for
   working, `--warning` with `anim-attention-dot` for needs-input, flat
   `--text-4` for idle. A session must never read `working` in the sidebar and
   `idle` here, so neither surface owns its own opinion.

   The message count is `session.messageCount`, `tabular-nums` / 11px /
   `--text-4`, **omitted at zero** rather than printed as `0` — a synthetic
   session that has not spoken yet has no count to show, and a `0` reads as a
   fact rather than an absence.

3. **Older / Archived** — disclosure toggles (11px, `--text-4`, rotating
   `chevron-right`) with counts, expanding in place. These retire the
   discoverability problem of the hover-gated peek icons on the sidebar row; the
   peeks remain as a shortcut but are no longer the only path.
4. **Roadmap** — a counts strip (backlog / ready / in-progress / review, all
   `tabular-nums`) plus every `in-progress` and `review` card named, with a
   "session bound" marker when the card carries one. The card **id** is
   `shrink-0` **and capped at `max-width: 96px` with `truncate`** (full id on
   `title`): a card whose frontmatter carries no short `id` falls back to a
   slug-shaped one, and an uncapped `shrink-0` id measured 418px — three times
   the rail — and forced the whole view to scroll sideways. A fixed cap is the
   only thing that holds in a 320px rail, since `shrink-0` by definition opts out
   of flex shrinking. Fed by the read-only
   `roadmap:peek` IPC, never `roadmapLoad` — there is a single roadmap watcher,
   and peeking must not steal it from another repo's open board.

   **The card list is capped at `--fv-rail-list-max-h` and scrolls inside the
   card**. The counts strip and the section label stay put above it, so
   a 128-card board still answers "how many, and what is moving" at a glance
   instead of burying the rest of the rail. The counts are the summary; the list
   is the detail, and only the detail scrolls.

5. **Worktrees** — siblings by `repoId`, with a "this one" marker and a
   `git-fork` "cut from here" marker for children whose `bornFrom` is this folder
   (T191 lineage). Absent for a lone checkout. Titled `Worktrees in this repo` on
   main and `Sibling worktrees` in a worktree: same list, and the second name is
   the honest one when you are standing inside it.

   **Each row carries a state dot** — the same 6px sidebar dot, resolved
   by the same `dotFor` recipe and folded by `activityBucket`, then folded again
   across the worktree's sessions **worst-first**: `needs-input` beats `working`
   beats `idle`. That order is the point: the reason to print a sibling's state
   at all is to surface the branch you are stacked on that is blocked on _you_,
   and an averaged dot would bury it.

   **The sibling list carries the same `--fv-rail-list-max-h` cap** as the
   roadmap list, and for the identical reason: 102 rows in a 320px rail is a
   column of branch names three screens tall. The two rail lists are the same
   shape of block and must not disagree about how much room a rail list gets.

#### The card this branch owns (`FolderViewOwnedCard.vue`)

The worktree profile's hero, above the grid. spec.html `#d-worktree` `.owncard`.
A worktree exists to land one card and then die, so the question it must answer
on sight is **"what is this branch FOR"** — not "which sessions live here".

**The card is found by ownership, not by recency.** `roadmap:peek` is called with
this folder's branch and answers with the card whose `executedIn` names
it. `executedIn` is the **owner** branch, stamped at dispatch; `provenance.branch`
is the **origin**, and it is never the answer to this question.

**Container.** The only accent-filled block in the entire view, deliberately:
`--accent-line` 1px border on `--accent-soft`, `--radius`, `14px 16px` padding,
`10px` gap. Everything else in this view is `--surface` or bare, so the one block
that answers "what is this folder for" is the one that is coloured.

**Top row.** Card id (mono 11px, `--accent`, capped at `max-width: 96px` with
`truncate` — the same cap and the same reason as the roadmap rail's id), the
title (14px/500, `--text`, `flex-1` + `truncate`), the **PR state pill**, and the
`this folder` scope tag.

**PR state pill.** Radius `999px`, `1px 8px`, 10.5px. Four tones, all token-backed
— `ok` = `--green-soft` / `--green`, `warn` = `bg-warning/10` / `--warning` (the
app's existing amber-pill idiom; there is no `--color-warning-soft` token and one
pill does not justify inventing one), `bad` = `--red-soft` / `--red`, `mute` =
`--surface-2` / `--text-3`. Merged and approved are `ok`, changes-requested is
`warn`, draft and closed and plain in-review are `mute`. **Absent when there is no
PR** — including when `gh` could not be reached, because "we did not look" is not
a state worth a chip.

**The four-step rail.** `dispatched → commits → PR → merge`, a 4-column grid with
a 2px gap so the bars read as one segmented track. Each step is a 4px `999px` bar
over a 10.5px label. Three states, and the bar **is** the state: `done` =
`--green`, `current` = `--accent`, `pending` = `--border` with a `--text-4` label.

The state comes from `featureRail` in `folder-view-format.ts`, and it is a
**frontier**, not four independent booleans — the furthest step whose evidence is
actually present becomes `current`, everything before it is `done`, everything
after is `pending`. There is therefore never more than one accent bar. A merged
PR is the one terminal state: nothing follows it, so it reads `done`.

> **The `merge` step does not light up yet.** `pr-stack:load` builds its graph
> from OPEN pull requests only (`buildGraph` filters `state === 'OPEN'`), and the
> snapshot carries no other PR list, so a MERGED entry never reaches this block.
> A landed branch therefore falls back to "no PR" and the rail stops at
> `commits` — it under-reports rather than over-reports, which is the required
> side of the rule below, but the terminal state is unreachable and the `merged`
> and `closed` pill tones are latent with it. Closing this needs a merged-PR read
> in `pr-stack*.ts`, out of T287's scope (T280 single-owns those files).

> **The `pr` step does not show the open-thread count.** The approved mockup
> draws
> this step as `PR #195 · 2 threads open`; what ships is `PR #{n}` and nothing
> more. The count is not withheld for room — it does not exist on this side of
> the wire: `PrEntry`/`PrNode` in `src/main/pr-stack-core.ts` carry
> `reviewDecision`, `checks` and `behind`, and no thread total, and no other
> preload verb supplies one. Widening the entry is a `pr-stack*.ts` change, and
> those files are single-owned by T280, so this block reports the half it can
> read rather than guessing at the other. **The step lights up with the count the
> day `PrEntry` carries one** — a single field on the entry the block already
> matches by `pr.branch`, no new call and no new match — and not before.

> **A step whose evidence cannot be read renders as "not yet", never as done.**
> This is the single rule this block must not break — an unknown step painted as
> complete is the worst thing it could say. `null` ("read it, there is none") and
> `undefined` ("could not read it") are different inputs to `featureRail` with
> different answers, and unreadable evidence never advances the frontier: no
> upstream truncates the rail at `dispatched`, no `gh` truncates it at `commits`.
> A merged PR behind an unreadable commit count still prints as "not yet".

**Where each step's evidence comes from — all of it already exists** (no new
main-process call, and nothing in `pr-stack*.ts` is touched):

| Step         | Evidence                         | Read                                             |
| ------------ | -------------------------------- | ------------------------------------------------ |
| `dispatched` | age of the card's bound session  | the card's `session`, dated by `session.created` |
| `commits`    | commit count + latest short SHA  | `roadmap:mergeEvidence` (`ahead`, `refs[0]`)     |
| `pr`         | PR number only — no thread count | `pr-stack:load`, matched on `pr.branch`          |
| `merge`      | merged / not                     | the same entry's `state === 'MERGED'` _(latent)_ |

Two honesty notes on that table. **The card carries no dispatch timestamp** —
`provenance.at` is when the card was _raised_, a different event — so the age is
the bound session's own `created`, which is exactly the moment the dispatch
spawned it; when that session is not on disk here the step prints its bare name
rather than inventing an age. And the **`gh` read is gated on the card**: it only
fires once a card has claimed the branch, so the common hand-cut worktree costs
no network call at all.

**Meta line.** 11.5px `--text-3` with `--text` for the values, `6px 18px` gaps:
card status (through `roadmap.columns.*`), the owner session's title, the git
line (`↑ahead` unpushed · dirty count, reusing `preview.folder.changes` /
`preview.folder.clean` so this and the header can never disagree), and the branch
this worktree was cut from (T191 `bornFrom`). Each half is omitted when its read
came back empty.

**Absent, not empty.** A worktree whose branch owns **no** card renders no hero at
all — not a placeholder, not a "no card yet" box, not a skeleton. The profile
falls back to the sections already there and must still read as a finished view.
This is the common case for a worktree cut by hand rather than by a dispatch, and
it is the T212 rule applied to the one block most tempting to fill with a stub.

**Fold.** The rail folds to 2 columns at `≤ 760px` — a `@container folder-view`
query, like every other breakpoint in this view, because four labels in a 230px
pane are four one-word ellipses.

#### Worktrees in flight — the fan-out (main profile)

`FolderViewFanout.vue`. The one block only a main checkout can show, and the
reason the main profile exists: every worktree of the repo as one row, so "what
is in flight and what needs me?" is answered without opening anything.

A `table`, `table-layout: fixed`, `border-collapse: collapse`, 12.5px. **The
column widths are part of the contract**, not a detail — without them a long
branch name or a card title widens its column and the whole view scrolls
sideways, which is exactly the T285 AC-3 failure.

| Column       | Width   | Content                                                              |
| ------------ | ------- | -------------------------------------------------------------------- |
| **Branch**   | `250px` | status dot · `git-branch` 12px · branch, mono, truncated             |
| **Card**     | fluid   | card `id` (mono 10.5px `--text-4`) + title, truncated, or an em-dash |
| **Sessions** | `92px`  | `{n}` or `{n} · {live} live`, `tabular-nums` 11px                    |
| **Git**      | `92px`  | `↑ahead` / `↓behind` (`↑0` when both are zero), `tabular-nums`       |
| **PR**       | `150px` | one pill, or the `this folder` scope tag on your own row             |

Rows separate with a `--border` bottom rule (none on the last), hover paints
`--surface-2`, and **your own row carries `--accent-soft`** — the folder you are
standing in is the anchor, not the news. It sorts **last**, with everything else
alphabetical by branch; deliberately not sorted by liveness, since a session
going quiet would reorder the table under the operator's cursor.

**The body is capped at `--fv-fanout-max-h` and scrolls under a sticky header** —
see "Height caps" above for the mechanics and the reason.

##### A row expands in place; it does not navigate

Clicking a row used to call `sessions.selectFolder(row.path)`: the whole view
switched to that worktree, and there was **no way back to the fan-out you were
reading**. A table you can only leave is not a table you can scan — the operator
was one click from losing their place in 102 rows, with the browser-style "back"
that would rescue them nowhere in this app.

A row click now **toggles a detail row open underneath it**, and the anatomy is
`SystemMonitorRow.vue`'s, copied rather than reinvented: a second `<tr>` rendered
as a **sibling** of the first inside the same `<tbody>` (Vue 3 multi-root
components make this a plain two-`<tr>` template — never a nested table, which
would break the shared fixed column widths), a `chevron-right` → `chevron-down`
toggle carrying `aria-expanded` and a collapse/expand `aria-label`, and a real
`<button>` so the whole interaction is keyboard-reachable without a `tabindex`.

**Opening a row reveals it.** The cap and the expansion collide: the porthole
leaves ~354px of body under the 26px sticky header, and an open detail row is
roughly half of that, so a row clicked in the lower half would render its panel
below the fold with only the chevron flip as feedback. On open — never on close —
the panel is brought into view with `scrollIntoView({ block: 'nearest' })`, the
same idiom `CleanupView.vue` uses after a group expands. `nearest`, so a panel
that already fits does not move the table under the operator's cursor.

**At most one row is open at a time.** State is a single `expandedPath` — the
worktree's path, not the row object and not its index. That is what makes the
expansion survive the fan-out's three async reads (`folders:gitStatus`,
`roadmap:peek`, `pr-stack:load`) resolving underneath it: every one of them
rebuilds `rows` as fresh objects through `fanoutRows`, and an expansion keyed on
identity rather than on a path would silently collapse each time a git probe came
back. Changing repo clears it.

**The detail row shows what the collapsed row had to truncate**, in a two-column
grid of label/value pairs — one column under the `folder-view` container query's
760px breakpoint, with **Path** spanning the full width in both — plus one
explicit action:

| Field      | Collapsed                      | Expanded                                             |
| ---------- | ------------------------------ | ---------------------------------------------------- |
| **Branch** | truncated at 250px, mono       | the full name, wrapping                              |
| **Card**   | id + title, ellipsised         | id + the full title, wrapping; else `noCard` in full |
| **Git**    | `↑n` `↓n` glyphs               | `n ahead` / `n behind` spelled out, or "unavailable" |
| **PR**     | a pill with the state and `#n` | the PR's **title** and number, linked                |
| **Path**   | absent                         | the worktree's absolute path, mono                   |

Navigating away stays possible — it is just no longer accidental: the detail row
carries an **Open this worktree** button (`--accent-soft` on `--accent-line`,
`--radius-sm`), and that button is now the only caller of `selectFolder` in this
block. Your own row's button is replaced by a line saying you are already there.

The PR **title** is the one field that needed widening to print: `FanoutPr`
carried `number`/`url`/`tone`/`key`, and `prPill` now also passes through
`PrEntry.title`, which the entry has always had. No new read, no new IPC.

**Every cell degrades to nothing, and never the row.** The four reads behind it
fail independently: the store's counts always exist, `folders:gitStatus` runs per
sibling, `roadmap:peek` per branch (T284's `owned`), and PR state comes from a
single existing `pr-stack:load` for the repo. A worktree whose git probe failed
is still a worktree in flight, so its git cell empties and the row stays. A
branch no card owns gets an **em-dash**, never a blank (a blank reads as "not
loaded") and never a guess.

**The PR pill** (`--radius` 999px, `1px 8px`, 10.5px) reads worst-news-first:
lifecycle → `changes requested` → `draft` → CI. `changes requested` outranks
`draft` on purpose — it is the one state that feeds the needs-you tile, and a
draft carrying it still needs you.

| Pill                                | Tone                           |
| ----------------------------------- | ------------------------------ |
| `checks passing`                    | `--green-soft` on `--green`    |
| `checks failing`                    | `--red-soft` on `--red`        |
| `changes requested`                 | `bg-warning/10` on `--warning` |
| `draft` / `open` / `checks running` | `--surface-2` on `--text-3`    |

`bg-warning/10` is the app's existing amber-pill idiom (`PrStackCard`); there is
no `--color-warning-soft` token and one pill does not justify a theme-wide
addition across 13 themes.

> **No `merged` pill today.** `buildGraph` (`pr-stack-core.ts`) filters the
> snapshot to `state === 'OPEN'` before it leaves the main process, and
> `WorktreeNode.mergedPr` is a caller-supplied echo rather than a lookup, so a
> merged PR is not observable from `pr-stack:load`. `prPill` maps the lifecycle
> states anyway (it is a total function over `PrEntry`), but until the snapshot
> widens — `pr-stack*.ts`'s call, not this view's — a merged branch shows an
> empty PR cell rather than a wrong one.

**Absent, not empty (AC-10).** A repo with exactly one worktree renders **no
fan-out section at all**. A lone checkout fans out to nothing, and a one-row
table of yourself is a frame around nothing.

#### KPI strip (main profile)

Four `UsageStatTiles`-idiom tiles above the grid — `--surface` card, `--border`,
`--radius`, `12px 14px`, value line 20px/500 with an 11px unit beside it, then a
key line (`--text-3`) and a sub line (`--text-4`). 4-up, folding 2-up at 1100px
and 1-up at 760px, on the same container queries as the grid.

| Tile              | Value                         | Reads                                  |
| ----------------- | ----------------------------- | -------------------------------------- |
| **Needs you**     | sessions + PRs blocked on you | across N worktrees, with the breakdown |
| **In flight**     | worktrees with a live session | N total · N idle                       |
| **In review**     | the board's `review` count    | plus the four-segment pipeline bar     |
| **Sessions here** | this checkout's working set   | plus how many folded into "Older"      |

The strip renders in the main profile of a **git** folder only: a plain pinned
directory has no fan-out and no board, so three of the four tiles would be a
frame around nothing. The roadmap tile follows the roadmap block's own rule and
is absent when the board has no cards.

**The needs-you tile declares what it cannot read.** It counts two real signals —
sessions in `needs-input`, and PRs with changes requested. When PR state is
unreadable (no `gh`, no network, the call threw), the PR signal is **excluded and
named** (`PR state unavailable`), never counted as zero. A tile that silently
folds an unreadable signal into "nothing is waiting on you" is under-reporting
exactly when the operator most needs to know it is blind.

#### Activity · 14d (main profile rail)

**It leads the rail's lower blocks** — directly under "Where we left
off" and above both capped lists. See "Two profiles, one view" above for why:
this is the shortest block in the view and it was rendering last.

Sessions **started** per local day over the last fortnight, from `sessionsPerDay`
— keyed on `created`, not `modified`, so the strip answers "when did work start
here" instead of moving every old session onto today. Tagged `repo`: it counts
every sibling's sessions, which is precisely why it needs the tag.

A 280×44 `svg`, one series, so **one accent at one opacity** (0.55) with today at
full — no categorical palette for what is a single measure. A `--border` baseline
rule sits at `y=43.5`. A day with nothing on it is a flat 2px `--border-2` tick
rather than a gap: a sparkline with holes punched out of it reads as a shorter,
busier history than it was. Non-zero bars carry a 4px floor so one session cannot
round down to invisible. Axis labels are 10px `--text-4`: the oldest day on the
left, `today · n` on the right. Absent when the repo has no sessions at all.

**Topbar with a folder selected.** The breadcrumb carries the folder icon, alias
and branch; there is no editable title, provider badge or orchestrator pill —
those describe a session, and there is none. The right cluster is gated on
`sessions.activeFolderPath` (the selected folder, else the selected session's
folder), so Roadmap, PR Stack, Open folder, VS Code, Browse files and the shell
are reachable in a folder with no sessions at all. A `+` (`topbar.newSessionHere`)
appears in the folder branch only.

---

## 7. Motion

Short movement, ease-out, rarely noticed. **If the user notices the animation,
it ran too long.**

| Action                  | Duration     | Easing      | Description                                                                                                                                                                                               |
| ----------------------- | ------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hover row               | 100ms        | ease        | Background fade + scale 1.003                                                                                                                                                                             |
| Select                  | 120ms        | ease-out    | Background cross-fade + accent bar appears                                                                                                                                                                |
| Expand project          | 220ms        | ease-out    | Chevron rotate + max-height reveal                                                                                                                                                                        |
| Overlay (dialog/menu)   | 140ms        | ease-out    | Fade + translateY 2px → 0                                                                                                                                                                                 |
| Divider hover           | 140ms        | ease-out    | Background `--border-2` → `--accent-line` (width follows the pointer with no easing)                                                                                                                      |
| Pulse (active status)   | 1.8s loop    | ease-in-out | Breathing halo (`pulse-ring`)                                                                                                                                                                             |
| Terminal cursor         | 1s           | steps(1)    | Blinking accent block                                                                                                                                                                                     |
| Chart bar (BI)          | `--dur`      | `--ease`    | Bar height animates when the period/data changes (`UsageChart`)                                                                                                                                           |
| Copy button reveal      | `--dur-fast` | `--ease`    | Opacity 0 → 1 on block hover / button focus-visible (T121 copy affordance)                                                                                                                                |
| Copy → copied           | 1.5s         | steps(1)    | Icon swaps `copy` → `check`, then reverts to idle (no cross-fade — a hard icon swap)                                                                                                                      |
| Fleet card entrance     | 620ms        | custom¹     | Whole card fades + slides 22px from the right, as one unit (`.card-enter`)                                                                                                                                |
| Fleet card ring fade    | 900ms        | custom¹     | Border ring eases in after the entrance settles (suppressed during the slide)                                                                                                                             |
| Fleet rail section      | `--dur-slow` | `--ease`    | Needs-you / Would-have collapse via `grid-template-rows: 1fr↔0fr` (`.collapsible`)                                                                                                                        |
| Rescan spin             | 0.7s loop    | linear      | `refresh-cw` icon rotates continuously while a manual rescan is in flight (Sidebar toolbar, `.anim-spin`)                                                                                                 |
| Pasted-images pill bump | 300ms        | `--ease`    | Scale 1 → 1.16 → 1 + accent fill/border cross-fade at the peak (`.anim-pill-bump`). One pass, no overshoot; fires only when a new screenshot lands for the session already on screen                      |
| Lightbox image swap     | `--dur`      | `--ease`    | Opacity cross-fade on the shown image (`.anim-fade-in`, keyed by filename) — no slide, no parallax                                                                                                        |
| Jump flash              | `--dur-slow` | `--ease`    | `--accent-soft` background decaying to transparent, one pass, on the sidebar row a jump-palette jump landed on (`.anim-jump-flash`). Says WHICH of the rows now on screen you asked for                   |
| PR focus ring           | `--dur-slow` | `--ease`    | `--accent` 2px ring on the PR Stack card a transcript link focused: held 2s, then `box-shadow` fades out (`.pr-focus-ring`, a transition not a keyframe). Reduced motion: appears/disappears with no fade |

¹ `cubic-bezier(0.22, 0.61, 0.36, 1)` — a touch snappier than the default
`--ease`, since this is a list-insertion cue that must read as immediate, not
a decorative overlay entrance.

### Fleet state ring (Fleet rail)

Each session in the [Fleet rail](#inbox-rail-fleet-rail--4th-column)
carries a **16px ring badge** on the left of its card — the ring IS the state.
It also renders alone, with no card body around it, as the
[minimized rail's minicards](#inbox-rail-fleet-rail--4th-column), and
that is the whole reason it exists in this form: a badge that needs no title,
branch or timestamp to be read is a **complete** signal, so it survives at
28px where a card body cannot.

**Anatomy** — three stacked circles, the classic CSS-spinner construction,
defined once in `main.css` as `fleet-ring` + `fleet-ring--<state>` and never
rebuilt ad-hoc:

| Layer               | What it is                                                       |
| ------------------- | ---------------------------------------------------------------- |
| `.fleet-ring-track` | Faint full-border circle — the state hue at low opacity          |
| `.fleet-ring-arc`   | Same box, `border-color` transparent EXCEPT the accented edge(s) |
| `.fleet-ring-dot`   | 6px solid centre, the state hue                                  |

One hue per state at three intensities, so the badge reads as a single colour.

| State         | Ring behavior                                              | Reads as                         |
| ------------- | ---------------------------------------------------------- | -------------------------------- |
| `working`     | One bright edge orbits a faint track (1.6s, `spin`)        | Alive, moving, healthy           |
| `needs-input` | A solid amber ring that breathes (2.2s, `ring-breathe`)    | "I'm waiting on YOU"             |
| `stuck`       | Two opposite red quarter-arcs, gaps top/bottom — **still** | Was running, stopped mid-flight  |
| `errored`     | A still, solid red ring                                    | Dead until you act               |
| `done`        | A still green ring at reduced opacity                      | Finished, calm, ready to collect |

`errored`, `done` and `stuck` are deliberately still: stillness is itself the
signal, the mirror of `working`'s motion. `stuck` and `errored` are both red
but not the same ring — `stuck`'s **broken** line ("interrupted") is the
contrast to `errored`'s unbroken one ("ended"), so they stay distinguishable
from the ring alone.

`1.6s` for the orbit is deliberately slower than a UI spinner's ~0.7–1s: this
is a state, not a wait. It sits inside the unhurried loop family (pulse 1.8s,
breathe 2.2s).

**Geometry invariant — integers only.** `(--ring-size − --ring-dot) / 2` and
the border width must both be **integers**. At 16/6 the dot insets by 5px. A
5px dot would inset by 5.5px, straddle a pixel boundary, antialias
asymmetrically and **read** as off-centre while being exactly centred. Any
future size must preserve this. 6px is also the reference proportion: the
inner diameter is `16 − 2×2 = 12`, so the dot is exactly half of it.

**Why a rotated border**, and not the two mechanisms that came before it:

- A `conic-gradient` (the original) has an **un-anti-aliased** angular
  boundary — at a 2px band on a 16px box it stair-steps at every angle — and
  needs a mask plus an inner fill disc, which has to hardcode one background
  colour and therefore breaks on hover, when selected, and in other themes.
- The **SVG `stroke-dashoffset`** ring that replaced it solved a
  problem that only exists on a **rectangle**: a conic gradient sweeps at
  constant _angular_ velocity, which along a rectangle's perimeter becomes
  wildly non-constant _linear_ velocity — measured ~22× faster at a corner
  than mid-edge on a 284×62px card. **On a circle those are the same
  quantity**, so a plain `rotate()` is uniform by construction. The simplest
  mechanism is also the correct one here.
- A bordered box with `border-radius: 50%` is anti-aliased by the normal box
  rasterizer, and with no mask and no inner disc the badge is
  **background-agnostic** — identical on rest, hover, selected, and in every
  theme.

`stuck` is where this technique earns its place: at r≈7 the ring's perimeter
is only ~45px, so a `stroke-dasharray` fine enough to read as "dashed"
renders at ~1px per dash and collapses into a solid circle. Two big
quarter-gaps survive at any size.

A newly-arriving card still fades + slides as one unit (`.card-enter`); the
ring is a **child** of the card now, so it travels with it and there is
nothing to suppress during the slide.

```css
.fleet-ring--working .fleet-ring-track {
  border-color: var(--color-green);
  opacity: 0.22;
}
.fleet-ring--working .fleet-ring-arc {
  border-left-color: var(--color-green);
  animation: spin 1.6s linear infinite; /* the shared keyframe — never a new one */
}
.fleet-ring--stuck .fleet-ring-arc {
  border-left-color: var(--color-red);
  border-right-color: var(--color-red); /* two opposite arcs = a broken circle */
  opacity: 0.75;
}
```

### General rule

- Everything **< 250ms** except infinite loops (pulse, cursor, typing)
- Infinite animations animate only `transform`/`opacity` (compositor-only); never `box-shadow`, `width` or colors.
- Default easing: `cubic-bezier(0.16, 1, 0.3, 1)` or simply `ease-out`
- **Zero** bouncing, overshoot springs, or dramatic easings
- Reduce/disable motion when `prefers-reduced-motion: reduce`

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 8. Voice & copy

Direct, technical, lowercase where it makes sense. **Talk to a senior dev as an
equal.** No artificial enthusiasm, no emoji, no exclamation marks.

### ✅ Do

- "3 idle sessions in this worktree"
- "Add folder"
- "Detected 4 worktrees via `git worktree list`"
- "Delete session? This action cannot be undone."
- "Failed to read `.git/worktrees` — insufficient permissions."
- **"Hide inactive (>7d)"** — a window suffix in parentheses when the parameter
  is informative, not user-configurable at this point.
- **"{count} hidden — show"** — an inline affordance to revert a filter
  action, with no dedicated button. The trailing verb is the invitation to click.
- **"Fork of {summary}"** — the placeholder prefix for a synthetic session born
  from a fork. Same pattern as "+ New session": direct verb + object. "Fork"
  stays untranslated (technical noun, same rule as worktree/branch).
- **Footer / status bar** — very short labels, no trailing period; `5h` / `7d` /
  `tabs` lowercase; technical nouns (`branch`, `Opus`, `effort`) untranslated.
  Numbers always `tabular-nums`. The footer informs, it doesn't converse.
- **Fleet status board** — short state labels, no trailing period: `Needs input`
  / `Errored` / `Working` / `Idle` / `Done` (kept in English — technical state
  nouns, same rule as `branch`/`worktree`). The `errored` bucket shows
  the **reason when there is one** (`rate limit · resets in 3m` / `overloaded` / `billing`),
  reusing the failure Badge; with no reason, just the red dot. `blocked {time}` for
  the blocked time of `needs-input`.
- **Mission progress** — say where the work is, as a position: "Step 8 of 9",
  "Steps 4–7 of 9", and "Step 9 of 9 ✓" only when every step is done. Counts of
  finished work are details beside it ("6 done · 6 verified · 1 left behind"),
  never the headline. There is no draft: no copy asks the operator to approve a
  mission, and none promises a guarantee the code does not enforce. Ending a
  mission is a choice, "Close as delivered" or "Discard", and its warnings say
  what is still open without refusing ("Checks not ticked").
- **Harnu mod** — the user-facing name is "Harnu mod" ("the Harnu mod", "mods"), never
  "companion". State lines are short and lowercase-led, with no trailing period:
  "Harnu mod: live", "Harnu mod: legacy — turned off by a setting or by your
  organization's policy". `live`, `legacy` and `off` stay in English (state nouns, like
  the fleet board's). A cause is named **only when it was observed**: "blocked by your
  organization's policy" needs the CLI's own refusal text, a probe that only shows mods are
  off reads the neutral "turned off by a setting or by your organization's policy", and
  anything else reads "the mod did not load". Never promise protection, and never imply
  the user did something wrong.
- **Mods audit chips** — facts in the form "can …": "can run processes", "can read every
  prompt". Never a verdict: no "safe", "verified", "trusted", "secure", "malicious" or
  "approved", in any language, and never a colour that grades a mod.
- **Non-affiliation line** — "Harnu is an independent project, not affiliated with
  or endorsed by Anthropic." One complete sentence, so it ends with a period. It sits
  at the bottom of the Onboarding hero (`text-text-4`, 11px, 24px above it), the one
  surface every new user reads. "Claude" stays a descriptor everywhere else.

### ❌ Avoid

- "🎉 Welcome back!"
- "Want to add your first folder?"
- "Wow, we found your worktrees automatically!"
- "Oops! Something went wrong :("
- "Hold on while we get everything ready for you"

### Principles

1. **Infinitive verbs** in buttons: "Add folder", not "Adding" or "Added"
2. **No trailing period** on short labels (buttons, menu items, badges)
3. **Trailing period** on complete sentences and error messages
4. **Technical terms left untranslated**: worktree, commit, branch, tool call, PR, diff,
   MCP, token, port, permission mode, audit log, Allow/Deny (confirm buttons)
5. **Backticks for technical values**: file names, commands, environment variables
6. **Cardinal numbers**: "3 sessions", not "three sessions"

---

## 9. Tokens (CSS)

Copy-paste ready for `:root`. **Source of truth** — any inline color in the
codebase is a bug to fix.

```css
:root {
  /* core surfaces — Ink ramp */
  --bg: #17120e;
  --sidebar: #211c18;
  --surface: #251f1b;
  --surface-2: #29231f;
  --border: #302a25;
  --border-2: #38312c;

  /* text scale — Ink ramp */
  --text: #faf8f6;
  --text-2: #ada59d;
  --text-3: #948b80;
  --text-4: #8e867e;
  --text-disabled: #4a423c;

  /* accent + semantic — Dusk accent, desaturated status hues */
  --accent: #8090b4;
  --accent-soft: rgba(128, 144, 180, 0.12);
  --accent-line: rgba(128, 144, 180, 0.35);
  --accent-ink: #17120e;
  --green: #7a9455;
  --green-soft: rgba(122, 148, 85, 0.18);
  --red: #d1717c;
  --red-soft: rgba(209, 113, 124, 0.1);
  --warning: #c08a3e;

  /* diff surfaces — Review pane (§6). The LINE backgrounds are the semantic
     soft tokens above; only the WORD-level marks are their own tokens. */
  --diff-add-word: rgba(122, 148, 85, 0.34);
  --diff-del-word: rgba(209, 113, 124, 0.26);

  /* type */
  --sans: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --mono:
    'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  /* shape */
  --radius-sm: 5px;
  --radius: 7px;
  --radius-lg: 10px;

  /* Folder View scroll caps (§6 "Folder View → Height caps") */
  --fv-fanout-max-h: 380px;
  --fv-rail-list-max-h: 280px;

  /* Cleanup layout dimensions (§4, §6 "Workspace GC — unified Cleanup") */
  --gc-panel-w: 320px;
  --gc-dialog-w: min(720px, 90vw);

  /* motion */
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 100ms;
  --dur: 140ms;
  --dur-slow: 220ms;

  /* shadow (popovers only) */
  --shadow-pop:
    0 1px 0 rgba(255, 255, 255, 0.02) inset, 0 12px 32px rgba(0, 0, 0, 0.45),
    0 2px 8px rgba(0, 0, 0, 0.3);
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: 'cv11', 'ss01', 'ss03';
}

::selection {
  background: var(--accent-soft);
  color: var(--text);
}
```

### Font imports

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
  rel="stylesheet"
/>
```

For offline Electron, download the WOFF2 files and serve them locally — don't depend on a CDN.

**Terminal (Nerd Font):** the terminal font is bundled as WOFF2 in
`src/renderer/src/assets/fonts/` and declared via `@font-face` in
`src/renderer/src/styles/fonts.css` (Regular / Bold / Italic / BoldItalic of
`JetBrainsMono Nerd Font Mono`). `font-display: block` avoids the fallback flash
that would also poison xterm's cell-width measurement — that's why
`TerminalPane`/`HelperPane` await `document.fonts.load(...)` before measuring.

Only weights **400 and 700** are bundled (the terminal only uses regular + bold).
The UI's mono scale (400/500/600 above) only renders at 400 today — no
`font-mono` consumer uses 500/600. If a `font-mono` at weight 500/600 is
introduced in the UI, bundle the corresponding Nerd Font face (otherwise matching
falls back to the nearest 400/700).

### Themes (data-theme)

The tokens above are the **`default-dark`** theme — internally still `default-dark`
(the id is persisted to `localStorage` and never renamed), user-facing label **Harnu**
(the base `@theme`, using the Toffee/Ink/Dusk palette from §2). Each alternate theme
overrides **the complete set** of 20 color tokens via `:root[data-theme='<id>']` in
`src/renderer/src/styles/themes.css` — **no theme-specific token, no gap**. The switch
happens at runtime (`stores/theme.ts` writes `data-theme` on `<html>`, persisted to
`localStorage['om2tab.theme']`) and the picker lives in **Settings → Appearance**
(a grid of mini-previews; `THEME_META` in `theme.ts` holds the swatch colors,
since `data-theme` only applies the active theme).

| `data-theme`       | Name (i18n)      | Base  | Accent       |
| ------------------ | ---------------- | ----- | ------------ |
| `default-dark`     | Harnu            | dark  | dusk-blue    |
| `light`            | Light            | light | burnt-orange |
| `tokyo-night`      | Tokyo Night      | dark  | blue         |
| `dracula`          | Dracula          | dark  | pink         |
| `catppuccin-mocha` | Catppuccin Mocha | dark  | peach        |
| `catppuccin-latte` | Catppuccin Latte | light | peach        |
| `one-dark`         | One Dark         | dark  | warm-orange  |
| `github-dark`      | GitHub Dark      | dark  | blue         |
| `github-light`     | GitHub Light     | light | blue         |
| `gruvbox-dark`     | Gruvbox Dark     | dark  | orange       |
| `gruvbox-light`    | Gruvbox Light    | light | orange       |
| `nord`             | Nord             | dark  | frost        |
| `monospace`        | Monospace        | dark  | grayscale    |

Adding a theme = (1) a complete `:root[data-theme='<id>']` block in
`themes.css`, (2) an entry in `THEMES` + `THEME_META` in `theme.ts`, (3) a label in
`theme.<id>` in **both** locales, (4) a row in this table. Alternate theme accents
can stray from terracotta — the "single warm accent" rule applies to the
default theme; each theme keeps its own identity.

### Extension themes (Extension SDK Phase 1)

A theme can also arrive from an installed extension —
`~/.claude/capy-extensions/<id>/manifest.json`'s `contributes.themes` — with
**zero code execution**: the main-process loader (`src/main/extensions/`)
validates the full 36-token contract per entry (stricter than the in-repo
`themes.css` convention — a missing token drops the theme, it never silently
inherits a default) and the renderer injects one
`:root[data-theme='ext-<extensionId>-<themeId>']` `<style>` block per validated
theme (`stores/theme.ts`, `lib/extension-themes.ts`) — recoloring the terminal
for free, same as a builtin (`themeFromCss` reads the same `--color-*`/
`--term-ansi-*` names regardless of where the block came from).

The picker (Settings → Appearance) renders extension themes in the SAME grid as
builtins, with two differences: the label is a **plain string** from the
manifest (extension content self-localizes — it never gets an i18n key), and a
small **`puzzle`** origin badge (10px, `text-text-3`, top-right corner of the
swatch preview) marks it as extension-installed — `title`/`aria-label` reads
"Installed by `<extension label>`". Uninstalling the extension (deleting its
folder) falls the active selection back to `default-dark` if it was the
selected theme; no new token.

### Terminal ANSI (xterm)

Each theme also defines the terminal's **16-color ANSI palette** via
`--term-ansi-*` tokens (16 per theme). They **are not** Tailwind-namespaced (they
generate no utilities) — they're read at runtime by `lib/terminalTheme.ts` (`themeFromCss`) and
pushed into xterm's `ITheme` in `TerminalPane`/`HelperPane`, recoloring
Claude/bash output right along with the theme switch (T-3.5). The 16 tokens, in
xterm's order:

```css
/* normal */
--term-ansi-black   --term-ansi-red     --term-ansi-green   --term-ansi-yellow
--term-ansi-blue    --term-ansi-magenta --term-ansi-cyan    --term-ansi-white
/* bright */
--term-ansi-bright-black   --term-ansi-bright-red    --term-ansi-bright-green
--term-ansi-bright-yellow  --term-ansi-bright-blue   --term-ansi-bright-magenta
--term-ansi-bright-cyan    --term-ansi-bright-white
```

xterm's `background`/`foreground`/`cursor`/`selection` still derive from
`--color-bg`/`--color-text`/`--color-accent`/`--color-accent-soft`.

### Diff surfaces (Review pane)

Two extra tokens per theme, defined next to the ANSI palette in
`themes.css` — **every theme block must carry both** (the file's contract is
20 UI colours + 16 ANSI + 2 diff-word, no gaps):

| Token             | Meaning                               | Default value               |
| ----------------- | ------------------------------------- | --------------------------- |
| `--diff-add-word` | intra-line mark on an **added** span  | `rgba(122, 148, 85, 0.34)`  |
| `--diff-del-word` | intra-line mark on a **removed** span | `rgba(209, 113, 124, 0.26)` |

Per theme they are that theme's own `--color-green` / `--color-red` at alpha
**0.34 / 0.26** on dark themes and **0.30 / 0.22** on the four light ones
(`light`, `catppuccin-latte`, `github-light`, `gruvbox-light`), where a mark
sits on a bright background and needs less weight to read.

**Why these two and no more.** The diff's _line_ backgrounds reuse
`--green-soft` / `--red-soft` unchanged. The word-level marks cannot: anything
soft enough to be a line background disappears when painted **on top of** one,
and anything strong enough to survive that becomes a line background in its own
right. There is deliberately **no** `--diff-add-line` / `--diff-del-line` —
they would be aliases, and an alias is a second name for the same value that
rots the first time someone edits only one of them.

Removed lines therefore read slightly lighter than added ones, because
`--red-soft` is alpha `.10` against `--green-soft`'s `.18` (those alphas were
tuned for badges and toasts, where red is an alarm that should stay quiet).
That asymmetry is the **approved** rendering, not an oversight — the word mark
and the `+`/`−` gutter glyph carry the signal, so the line tint never has to.

They are **not** Tailwind-namespaced (no `bg-diff-add-word` utility exists) and
are consumed only through the `.diff-*` helper classes in `main.css`, the same
way `--term-ansi-*` is consumed only by `themeFromCss`.

### Syntax highlighting is the ANSI palette (ADR-0011)

Code shown inside Harnu's UI — today the Review pane's diff — is coloured by
mapping the highlighter's token classes onto the **`--term-ansi-*` tokens each
theme already defines for the terminal**. There is no highlight theme, and
adding a theme adds **zero** highlighting work: a theme that can colour the
terminal can colour a diff.

Seven buckets, declared once in `main.css`. Each has a name from the approved
spec (`.t-*`) and the highlight.js scope names that alias onto it:

| Bucket   | Token                      | Covers                                               |
| -------- | -------------------------- | ---------------------------------------------------- |
| `.t-key` | `--term-ansi-magenta`      | keywords, literals, tag + selector names             |
| `.t-fn`  | `--term-ansi-blue`         | callables, declared names, headings                  |
| `.t-str` | `--term-ansi-green`        | strings, regexps, links, inline code                 |
| `.t-num` | `--term-ansi-yellow`       | numerics, bullets, CSS id/class selectors            |
| `.t-com` | `--term-ansi-bright-black` | comments and blockquotes (**+ italic**)              |
| `.t-typ` | `--term-ansi-cyan`         | types, built-ins, object keys, attributes, variables |
| `.t-pun` | `--text-3`                 | punctuation and operators                            |

`.t-pun` is the one deliberate exception to "every code colour is an ANSI
token": punctuation is scaffolding, and giving it a hue of its own makes every
line noisier without making any token easier to find. It is still an existing
token — no new colour enters the system.

**A component never writes a highlight colour.** It emits the classes and the
mapping does the rest; a per-theme highlight rule anywhere is a contract
violation (`scripts/dev/t164-highlight-demo.mjs` fails the build if one appears
in that block).
