# Floating layout mockup

The approved visual contract for `docs/specs/2026-11-05-floating-layout/spec.md`. This is not a
static picture. It is the REAL renderer (`src/renderer`) served by Vite with a fake `window.api`, so
every panel renders with sample data, plus a CSS and JS overlay that draws the proposed layout.

## Run it

```bash
node_modules/.bin/vite --config docs/design/floating-layout/vite.config.mjs
# open http://127.0.0.1:5199/ (a desktop-sized window, 1920x1080)
```

Nothing is functional. Buttons that need the main process do nothing.

## Files

| file              | what it is                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.mjs` | Serves `src/renderer` and injects `stub.js` before the app boots (CSP removed).                                                                                                       |
| `stub.js`         | Fake `window.api`: sample folders, 47 worktrees in the `harnu` group (drill-in scroll), forgotten needs-input sessions (Return here), pending approvals (Needs you), fake PTY output. |
| `floating.css`    | The layout overlay. Every rule is scoped to a class on `<html>`; the final "Grid alignment" block is the authoritative island grid.                                                   |
| `fullscreen.js`   | Expand-to-window button on each helper pane, motion toggle, and the drill Back row anchor.                                                                                            |

## Toggles (chips at the bottom of the window)

| key | toggle                                 | `<html>` class |
| --- | -------------------------------------- | -------------- |
| F8  | Floating panels on/off                 | `floating`     |
| F9  | Footer flush (approved) / floating     | `footer-flat`  |
| F10 | Split side by side / stacked           | `vertical`     |
| F7  | Expand hides everything / session only | `full-zen`     |
| F4  | Layout motion on/off                   | `anim`         |

## Reading the CSS as a spec

The overlay targets today's DOM with structural selectors, so it is a VISUAL reference, not code to
copy. Implement with Tailwind utilities and tokens per `design.md`. The values that ARE the contract:
6px gap everywhere, `--radius` (7px) islands, `--radius-sm` (5px) small surfaces, the canvas at
`color-mix(in oklab, var(--color-bg) 62%, black)` on dark themes (light themes need a hand-picked
token), a 2px × 36px `--color-accent-line` divider grip on hover, `--dur-slow` + `--ease` motion.
