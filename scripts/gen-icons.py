#!/usr/bin/env python3
"""
Generate the Harnu app icon set from the BrandMark / Prompt Tile design.

Design source (design.md §1, §9 Harnu palette):
- Rounded square tile, background #17120e (Ink 900 — the app's own dark bg).
- Centered chevron `>` glyph stroked in #8090b4 (Dusk 400 — the accent).
- Below 32px the chevron loses definition: render the solid dark tile alone
  (no glyph), per design.md §1 "Minimum size: 16px ...".
- Note: this is the inverse pairing from `BrandMark.vue` (which renders
  `bg-accent text-accent-ink` — a Dusk-blue tile with an Ink-dark chevron).
  The taskbar/window icon intentionally reads as "a dark window with an
  accent mark" rather than a solid accent square; both pairings pass
  contrast (same two colors, swapped foreground/background).

Outputs:
  resources/icon.png         (1024 master — Linux primary, electron-builder source)
  build/icon.png             (512 fallback used by some packaging paths)
  build/icon.ico             (Windows multi-resolution: 16/24/32/48/64/128/256)
  build/icon.icns            (macOS multi-resolution, written via Pillow)
  build/icon.iconset/        (Apple iconset folder — used by `iconutil` on macOS CI)

Run from the repo root:
  python3 scripts/gen-icons.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    sys.stderr.write(
        "error: Pillow is required. Install with: pip install --user pillow\n"
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# Design constants — keep in sync with design.md §2/§9 (Harnu palette).
# ---------------------------------------------------------------------------

TILE_BG = (23, 18, 14, 255)     # #17120e — Ink 900 (app bg)
CHEVRON = (128, 144, 180, 255)  # #8090b4 — Dusk 400 (accent)
TRANSPARENT = (0, 0, 0, 0)

# Below this size the chevron disappears (per design.md §1).
CHEVRON_MIN_SIZE = 32

# Supersample factor for crisp anti-aliased rounded corners and stroke.
SS = 4

# macOS icon grid (Apple HIG, Big Sur+): the rounded-square artwork occupies
# 824x824 of the 1024x1024 canvas — ~100px transparent margin per side. macOS
# adds its own drop shadow and does NOT inset full-bleed icons, so without
# this margin the app renders visibly larger than every other Dock icon.
# Linux and Windows icons stay full-bleed (that's their convention).
MAC_TILE_RATIO = 824 / 1024

# Apple's icon template also bakes a drop shadow into the asset (macOS does
# not add one at render time). Without it the tile stops hard at the 824 box
# and reads slightly smaller/flatter than neighboring Dock icons, whose soft
# halo extends ~2% beyond the squircle. Parameters measured from the 1024
# frames of Claude.app and VS Code (both match Apple's template): black at
# ~30% opacity, Gaussian sigma 9/1024 of the canvas, offset y +10/1024.
MAC_SHADOW_ALPHA = 78  # ~30% of 255
MAC_SHADOW_SIGMA = 9 / 1024
MAC_SHADOW_OFFSET_Y = 10 / 1024

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = REPO_ROOT / "build"
RESOURCES_DIR = REPO_ROOT / "resources"
ICONSET_DIR = BUILD_DIR / "icon.iconset"


def _draw_tile(size: int) -> Image.Image:
    """Render one square Prompt Tile at the requested pixel size."""
    # Supersample for smoother edges, then downscale with LANCZOS.
    big = size * SS
    img = Image.new("RGBA", (big, big), TRANSPARENT)
    draw = ImageDraw.Draw(img)

    # Corner radius scales with the tile. Reference: design.md §4 (raio ~22%
    # at the tile sizes BrandMark targets — at 1024 that's ~220px).
    radius = round(big * 0.215)
    draw.rounded_rectangle([(0, 0), (big - 1, big - 1)], radius=radius, fill=TILE_BG)

    # Chevron only when the glyph stays legible (>= 32px final size).
    if size >= CHEVRON_MIN_SIZE:
        # BrandMark uses a 24-unit viewBox with path "M9 6 L15 12 L9 18".
        # That's 9..15 horizontally (centered on 12) and 6..18 vertically
        # (centered on 12). The chevron occupies ~50% of the tile (matches
        # BrandMark which renders svg at size * 0.5).
        scale = big / 24.0
        # Center the 50%-wide chevron in the tile.
        chevron_cx = big / 2.0
        chevron_cy = big / 2.0
        # Width 6 units, height 12 units in viewBox terms, but we scale the
        # whole 24-unit path. To match BrandMark's `width=size*0.5` we render
        # the viewBox into a 50% region. That means a coordinate `x` in the
        # 0..24 viewBox maps to `chevron_cx + (x - 12) * scale * 0.5`.
        glyph_scale = scale * 0.5

        def vb(x: float, y: float) -> tuple[float, float]:
            return (
                chevron_cx + (x - 12) * glyph_scale,
                chevron_cy + (y - 12) * glyph_scale,
            )

        # Stroke width — BrandMark uses `max(1.5, size * 0.07)`. At 1024 that
        # would be ~71px; we scale to the supersampled canvas.
        stroke = max(1.5 * SS, size * 0.07 * SS)

        # Three points of the chevron.
        p1 = vb(9, 6)
        p2 = vb(15, 12)
        p3 = vb(9, 18)
        # Draw two strokes (a polyline) with round caps + round join. Pillow
        # supports `joint="curve"` on `line()`.
        draw.line([p1, p2, p3], fill=CHEVRON, width=int(round(stroke)), joint="curve")
        # Pillow's line() doesn't round-cap the endpoints — patch with circles.
        cap_r = stroke / 2.0
        for cx, cy in (p1, p2, p3):
            draw.ellipse(
                [(cx - cap_r, cy - cap_r), (cx + cap_r, cy + cap_r)],
                fill=CHEVRON,
            )

    # Downscale back to the requested size.
    return img.resize((size, size), Image.LANCZOS)


def _mac_tile_size(size: int) -> int:
    """Tile size for a mac canvas: nearest to size*MAC_TILE_RATIO whose
    leftover (canvas - tile) is even, so the paste centers exactly.

    A plain round() leaves an odd leftover at some sizes (16→13, 128→103),
    which puts the artwork 1px off-center. Snap to the closest even-leftover
    neighbor instead, preferring the smaller tile on ties so we never drift
    back toward the oversized look this margin exists to fix.
    """
    target = size * MAC_TILE_RATIO
    best = min(max(1, round(target)), size)
    if (size - best) % 2 == 0:
        return best
    candidates = [t for t in (best - 1, best + 1) if 1 <= t <= size]
    return min(candidates, key=lambda t: (abs(t - target), t))


def _draw_mac_tile(size: int) -> Image.Image:
    """Render the tile inset per the Apple icon grid (824/1024 of the canvas).

    The chevron-visibility threshold is checked against the *tile* size, not
    the canvas, so small mac frames drop the glyph at the same physical size
    as the other platforms.
    """
    tile_size = _mac_tile_size(size)
    tile = _draw_tile(tile_size)
    offset = (size - tile_size) // 2

    # Baked drop shadow (see MAC_SHADOW_* above): the tile's own silhouette,
    # black at ~30% alpha, blurred and nudged down, composited under the tile.
    shadow_mask = tile.getchannel("A").point(
        lambda v: v * MAC_SHADOW_ALPHA // 255
    )
    silhouette = Image.new("RGBA", tile.size, (0, 0, 0, 0))
    silhouette.putalpha(shadow_mask)
    shadow_layer = Image.new("RGBA", (size, size), TRANSPARENT)
    shadow_layer.paste(silhouette, (offset, offset + round(size * MAC_SHADOW_OFFSET_Y)))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(size * MAC_SHADOW_SIGMA))

    tile_layer = Image.new("RGBA", (size, size), TRANSPARENT)
    tile_layer.paste(tile, (offset, offset))
    return Image.alpha_composite(shadow_layer, tile_layer)


def write_png(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = _draw_tile(size)
    # `optimize=True` keeps the file small for a simple shape.
    img.save(path, format="PNG", optimize=True)
    print(f"  wrote {path.relative_to(REPO_ROOT)}  ({size}x{size}, {path.stat().st_size} B)")


def write_ico(path: Path) -> None:
    """Multi-resolution Windows icon."""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    # Build the largest tile, let Pillow downscale per size — the chevron will
    # only appear in 32+ frames; the 16/24 frames will get the solid tile.
    frames = [_draw_tile(s) for s in sizes]
    path.parent.mkdir(parents=True, exist_ok=True)
    # Pillow's ICO encoder picks `sizes` from the explicit list; supply our
    # already-rendered frames via `append_images`.
    frames[-1].save(
        path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[:-1],
    )
    print(f"  wrote {path.relative_to(REPO_ROOT)}  ({len(sizes)} frames, {path.stat().st_size} B)")


def write_icns(path: Path) -> None:
    """Multi-resolution macOS icon (Pillow ICNS plugin)."""
    # ICNS expects power-of-two sizes 16..1024.
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    frames = [_draw_mac_tile(s) for s in sizes]
    path.parent.mkdir(parents=True, exist_ok=True)
    # Pillow needs the master image at the largest size, plus `append_images`
    # for the other resolutions. The ICNS plugin will pick the appropriate
    # types (`ic07`, `ic08`, `ic09`, `ic10`, etc.) from the sizes provided.
    frames[-1].save(
        path,
        format="ICNS",
        sizes=[(s, s) for s in sizes],
        append_images=frames[:-1],
    )
    print(f"  wrote {path.relative_to(REPO_ROOT)}  ({len(sizes)} frames, {path.stat().st_size} B)")


def write_iconset(folder: Path) -> None:
    """Apple's expected `.iconset/` folder structure.

    `iconutil --convert icns icon.iconset` (macOS) produces the .icns from
    these PNGs. We ship this as a fallback for CI when Pillow's ICNS output
    isn't sufficient.
    """
    folder.mkdir(parents=True, exist_ok=True)
    # The canonical Apple file naming (no, this isn't redundant — Apple's
    # `iconutil` is picky about the exact names).
    entries = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    # Cache renderings by size — many sizes repeat (32 used twice, etc).
    cache: dict[int, Image.Image] = {}
    for size, name in entries:
        if size not in cache:
            cache[size] = _draw_mac_tile(size)
        out = folder / name
        cache[size].save(out, format="PNG", optimize=True)
    print(f"  wrote {folder.relative_to(REPO_ROOT)}/  ({len(entries)} PNGs)")


def main() -> int:
    print("Generating Prompt Tile icon set…")

    # 1. Linux primary (electron-builder reads `resources/icon.png` first).
    write_png(RESOURCES_DIR / "icon.png", 1024)

    # 2. 512px fallback in build/ — some packaging paths look here.
    write_png(BUILD_DIR / "icon.png", 512)

    # 3. Windows multi-res .ico.
    write_ico(BUILD_DIR / "icon.ico")

    # 4. macOS .icns — Pillow can write it directly.
    write_icns(BUILD_DIR / "icon.icns")

    # 5. Iconset folder — used by `iconutil --convert icns` on macOS CI as a
    #    canonical fallback if anything goes wrong with the Pillow output.
    write_iconset(ICONSET_DIR)

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
