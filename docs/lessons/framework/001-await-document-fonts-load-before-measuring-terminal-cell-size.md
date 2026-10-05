# 001-font-load-before-cell-measure: await `document.fonts.load` before measuring xterm cells

**Category:** framework (xterm / web fonts)
**Discovered in:** Nerd Font bundling change (May 2026)
**Status:** active

## The bug

`TerminalPane`/`HelperPane` size their PTY by measuring a hidden `<span>`
rendered in `--font-mono` (`measureCells`) and dividing the host box by the
glyph advance. When the terminal font is a **bundled web font** (the
`JetBrainsMono Nerd Font Mono` WOFF2s), that font loads asynchronously. If
the measurement runs before the face is ready, the browser measures the
**fallback** glyph advance, so the PTY spawns at the wrong `cols`/`rows` —
the same failure class the cell-width fix in `ed90503` addressed.

## Root cause

`document.fonts` loads faces lazily and asynchronously. `t.open(host)` +
`nextTick()` does not guarantee the `@font-face` src has been fetched and
parsed. Glyph metrics are only correct once the face is loaded.

## The fix (and why)

Await an idempotent, memoized font-load before the first measurement:

```ts
t.open(host)
await nextTick()
await ensureTerminalFontLoaded() // Promise.all([fonts.load('13px "<family>"'), fonts.load('bold 13px ...')])
const initial = measureCells(host) // now divides by the real glyph advance
```

`ensureTerminalFontLoaded` lives in `src/renderer/src/lib/terminalMetrics.ts`
(shared by both panes), resolves-not-rejects on failure, and memoizes the
promise so session switches don't re-await. Pair it with `font-display: block`
in `fonts.css` so xterm never paints a fallback glyph during the load gap.

## How to detect in reviews

1. Any new code path that constructs an xterm `Terminal` and then calls
   `measureCells`/`fit()` — is the bundled font awaited first?
   ```bash
   git grep -n "measureCells\|\.fit()" src/renderer/src
   ```
2. A new `@font-face` family fed to a terminal/canvas measurement without a
   corresponding `document.fonts.load` await is the bug.
3. Check `font-display` on the terminal `@font-face` is `block` (not `swap`),
   so a slow load can't flash a fallback into the measured glyph.

## Related

- `src/renderer/src/lib/terminalMetrics.ts` — `ensureTerminalFontLoaded` + `measureCells`
- `src/renderer/src/styles/fonts.css` — `@font-face`, `font-display: block`
- `ed90503` — the prior xterm cell-width measurement fix (same bug class)
- `frontend/001-bundle-every-font-weight` — sibling lesson on partial weight coverage
