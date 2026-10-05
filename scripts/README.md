# scripts/

One-off generators and chores not wired into `npm run` lifecycle.

## `gen-icons.py`

Regenerates the full app icon set from the **Prompt Tile** design
(`design.md` §1, mirrored in `src/renderer/src/components/BrandMark.vue`).

### What it produces

| Output                | Purpose                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources/icon.png`  | 1024×1024 master. Linux primary; electron-builder reads here.                                                                                                 |
| `build/icon.png`      | 512×512 fallback. Some packaging paths look here.                                                                                                             |
| `build/icon.ico`      | Windows multi-resolution (16/24/32/48/64/128/256).                                                                                                            |
| `build/icon.icns`     | macOS multi-resolution (16/32/64/128/256/512/1024).                                                                                                           |
| `build/icon.iconset/` | Apple-style folder of PNGs. Fallback for macOS CI to run `iconutil --convert icns build/icon.iconset` if the Pillow-emitted `.icns` ever proves insufficient. |

### Run it

```bash
# from the repo root
python3 scripts/gen-icons.py
```

Requires **Pillow ≥ 9** (`pip install --user pillow`). No other system deps —
intentionally avoids ImageMagick / Inkscape / `iconutil` / `png2icns` so the
script runs identically on Linux, macOS, and Windows CI.

### When to re-run

- The Prompt Tile design changes (`design.md` §1 or `BrandMark.vue`).
- The accent colors shift (`themes.css` `--color-accent` / `--color-accent-ink`).
- A platform packager complains about a missing icon size.

After regenerating, commit the resulting binaries together with whatever
design change triggered them — they are source of truth for the bundled app.

### Design contract (must match `BrandMark.vue`)

- Background: `#d97757` (terracotta accent).
- Corner radius: `~21.5%` of the tile (matches BrandMark's `radius = 12` at
  `size = 56`, scaled — at 1024 that's ~220px).
- Glyph: chevron `›` stroked in `#1a0f0a`, ~50% of the tile width, viewBox
  path `M9 6 L15 12 L9 18`.
- Stroke width: `max(1.5, size * 0.07)` (BrandMark formula).
- **Below 32px the chevron is dropped** — solid tile only. See `design.md`
  §1: _"Minimum size: 16px. Below that the chevron loses definition — use the
  solid square with no glyph."_
