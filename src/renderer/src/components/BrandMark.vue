<script setup lang="ts">
/**
 * design.md §1 — Prompt Tile. Terracota square + chevron `›` glyph.
 *
 * Sizes used in the app:
 * - 14px  sidebar header (close to minimum, chevron still legible)
 * - 24px  menu bar (macOS) / context badges
 * - 32-64 dock / about
 * - 56px  onboarding hero
 *
 * Per design.md §1 the chevron is the PRIMARY glyph and lives in the tile at
 * every size ≥ 16px. Below 16 the chevron loses definition and the tile
 * should render solid (no glyph). The earlier "C" fallback was a confusion
 * with the C-cursor lockup (variant C) — removed.
 */
interface Props {
  size?: number
}
const props = withDefaults(defineProps<Props>(), { size: 14 })

// Sub-favicon sizes drop the glyph (design.md §1 — "Minimum size: 16px").
const showGlyph = props.size >= 12
const radius = props.size <= 16 ? 3 : props.size <= 32 ? 6 : 12
// Stroke scales with tile size; floor at 1.5 so even the 14px sidebar mark
// renders with a crisp single-pixel-ish stroke at typical DPR.
const strokeWidth = Math.max(1.5, props.size * 0.085)
const glyphScale = props.size <= 16 ? 0.6 : 0.5
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center bg-accent text-accent-ink"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: `${radius}px`
    }"
    role="img"
    aria-label="Harnu"
  >
    <svg
      v-if="showGlyph"
      :width="size * glyphScale"
      :height="size * glyphScale"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      :stroke-width="strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6 L15 12 L9 18" />
    </svg>
  </span>
</template>
