# 001-partial-font-weight-coverage: bundle every weight a consumer uses

**Category:** frontend (font matching)
**Discovered in:** Nerd Font bundling change (May 2026)
**Status:** active

## The bug

When you prepend a custom `@font-face` family to a font stack but only ship
**some** weights, requests for the unbundled weights do **not** fall through
to the next family in the stack — CSS resolves them to the nearest bundled
face of the **same** family.

We bundle only 400 + 700 of `JetBrainsMono Nerd Font Mono` and prepend it:

```css
--font-mono: 'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', monospace;
```

A hypothetical `class="font-mono font-semibold"` (600) would therefore render
as the bundled **700** face, not as system `JetBrains Mono` 600. (No consumer
uses mono 500/600 today — verified — so this is latent, not live.)

## Root cause

CSS font matching picks the nearest weight **within the matched family**
before it ever falls through to the next family in the stack. Prepending a
partial family silently changes the rendered weight of any text at an
unbundled weight.

## The fix (and why)

Audit consumers before shipping a partial family, and document the bundled
weight set so the constraint is explicit:

```bash
# Find mono consumers, then check which combine with a weight utility
git grep -n "font-mono" src/renderer/src
```

`design.md` §3 now records that only 400/700 are bundled and that a future
mono 500/600 consumer must ship the matching Nerd Font face. Either bundle
the weight or keep the constraint documented — never assume the stack
fallback will supply it.

## How to detect in reviews

1. A new `@font-face` family added to a stack — does it cover every weight any
   consumer requests?
2. A new `font-mono` usage combined with `font-medium`/`font-semibold`
   (500/600) — does a bundled face exist for that weight?
   ```bash
   git grep -nE "font-mono.*(font-medium|font-semibold)" src/renderer/src
   ```

## Related

- `src/renderer/src/styles/fonts.css` — the `@font-face` set (400/700 × normal/italic)
- `design.md` §3 — bundled-weight constraint
- `framework/001-font-load-before-cell-measure` — sibling lesson on the same change
