<script setup lang="ts">
// Floating properties panel for the canvas pane (T536 U3, design.md §6 "Diagram
// pane → Properties panel"). Presentational only: the pane resolves which keys the
// selection shares and what value each has (canvas/canvas-style.ts `panelValues`),
// and this component reports the user's pick as a `change` patch. It never reads
// the graph and never writes the file. Placement is the parent's job. The Layers
// group (T536 U4) is the same deal: it reports a `layer` move, the pane restacks.
import { useI18n } from 'vue-i18n'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Palette,
  Square,
  SquareRoundCorner
} from 'lucide-vue-next'
import {
  CANVAS_STYLE_VALUES,
  MIXED,
  type CanvasStyleKey,
  type CanvasStylePatch,
  type CanvasStyleValue
} from './canvas/canvas-style'
import { LAYER_MOVES, type LayerMove } from './canvas/canvas-layers'

const props = defineProps<{
  /** The keys to offer, in `CANVAS_STYLE_KEYS` order. */
  keys: readonly CanvasStyleKey[]
  /** The value per key, or `'mixed'` where the selected nodes disagree. */
  values: Partial<Record<CanvasStyleKey, CanvasStyleValue | typeof MIXED>>
  /** Narrow pane: the panel folds into a single button. */
  collapsed: boolean
  /** While collapsed, whether the button has opened the panel. */
  open: boolean
  /** The selection holds a node: offer the Layers group. */
  layers: boolean
}>()

const emit = defineEmits<{
  change: [patch: CanvasStylePatch]
  layer: [move: LayerMove]
  toggle: []
}>()

const { t } = useI18n()

// Tailwind only sees whole class names, so each tone spells its swatch out. These are
// the same fill/stroke tokens `toneColors` resolves for the node itself.
const TONE_SWATCH: Readonly<Record<string, string>> = {
  default: 'bg-surface border-border-2',
  accent: 'bg-accent-soft border-accent',
  green: 'bg-green-soft border-green',
  amber: 'bg-warning-soft border-warning',
  red: 'bg-red-soft border-red',
  muted: 'bg-bg border-border'
}

// Line glyphs borrow the canvas's own dasharray and widths (canvas-cells.ts).
const DASH: Readonly<Record<string, string | undefined>> = {
  solid: undefined,
  dashed: '6 4',
  dotted: '2 3'
}
const WIDTH: Readonly<Record<string, number>> = { thin: 1, regular: 1.5, bold: 2.5 }
const SIZE_TEXT: Readonly<Record<string, string>> = { s: 'S', m: 'M', l: 'L', xl: 'XL' }

const ALIGN_ICON = { left: AlignLeft, center: AlignCenter, right: AlignRight } as const

const LAYER_ICON = {
  back: ArrowDownToLine,
  backward: ArrowDown,
  forward: ArrowUp,
  front: ArrowUpToLine
} as const

const showGroups = (): boolean =>
  (!props.collapsed || props.open) && (props.keys.length > 0 || props.layers)

function label(key: CanvasStyleKey, value: CanvasStyleValue): string {
  return t(`diagramPane.style.value.${key}.${value}`)
}

function isChecked(key: CanvasStyleKey, value: CanvasStyleValue): boolean {
  return props.values[key] === value
}

function pick(key: CanvasStyleKey, value: CanvasStyleValue): void {
  if (isChecked(key, value)) return
  emit('change', { [key]: value })
}

const BTN = 'grid h-6 min-w-6 place-items-center rounded-sm px-1 transition-colors'
const ACTIVE = 'bg-accent-soft text-accent'
const IDLE = 'text-text-3 hover:bg-surface-2 hover:text-text'
</script>

<template>
  <div
    data-testid="canvas-properties"
    data-canvas-chrome
    class="inline-flex flex-col items-start gap-1"
    @pointerdown.stop
    @mousedown.stop
  >
    <button
      v-if="collapsed"
      data-testid="canvas-properties-toggle"
      type="button"
      :class="[
        'grid h-7 w-7 place-items-center rounded border border-border bg-surface shadow-pop transition-colors',
        open ? 'text-accent' : 'text-text-3 hover:bg-surface-2 hover:text-text'
      ]"
      :title="$t('diagramPane.style.show')"
      :aria-label="$t('diagramPane.style.show')"
      :aria-expanded="open"
      @mousedown.stop
      @pointerdown.stop
      @click="emit('toggle')"
    >
      <Palette :size="16" />
    </button>
    <div
      v-if="showGroups()"
      role="group"
      :aria-label="$t('diagramPane.style.panel')"
      class="flex w-[184px] flex-col gap-2 rounded border border-border bg-surface p-2 shadow-pop"
    >
      <div v-for="key in keys" :key="key" class="flex flex-col gap-1">
        <span class="eyebrow text-text-4">{{ $t(`diagramPane.style.group.${key}`) }}</span>
        <div
          role="radiogroup"
          :data-testid="`canvas-prop-group-${key}`"
          :aria-label="$t(`diagramPane.style.group.${key}`)"
          class="flex flex-wrap gap-0.5"
        >
          <button
            v-for="value in CANVAS_STYLE_VALUES[key]"
            :key="value"
            :data-testid="`canvas-prop-${key}-${value}`"
            type="button"
            role="radio"
            :class="[BTN, isChecked(key, value) ? ACTIVE : IDLE]"
            :title="label(key, value)"
            :aria-label="label(key, value)"
            :aria-checked="isChecked(key, value)"
            @mousedown.stop
            @pointerdown.stop
            @click="pick(key, value)"
          >
            <span
              v-if="key === 'tone'"
              data-testid="canvas-prop-swatch"
              :class="['block h-4 w-4 rounded-sm border', TONE_SWATCH[value]]"
            />
            <svg
              v-else-if="key === 'stroke' || key === 'strokeWidth'"
              data-testid="canvas-prop-glyph"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              :stroke-width="key === 'strokeWidth' ? WIDTH[value] : WIDTH.regular"
              :stroke-dasharray="key === 'stroke' ? DASH[value] : undefined"
              aria-hidden="true"
            >
              <line x1="1" y1="8" x2="15" y2="8" />
            </svg>
            <Square v-else-if="key === 'corners' && value === 'sharp'" :size="16" />
            <SquareRoundCorner v-else-if="key === 'corners'" :size="16" />
            <component
              :is="ALIGN_ICON[value as keyof typeof ALIGN_ICON]"
              v-else-if="key === 'align'"
              :size="16"
            />
            <span v-else-if="key === 'fontSize'" class="text-caption leading-none">{{
              SIZE_TEXT[value]
            }}</span>
            <span v-else class="text-caption leading-none">{{ value }}%</span>
          </button>
        </div>
      </div>
      <!-- Layers (T536 U4): actions, not radios — nothing is ever checked. -->
      <div v-if="layers" class="flex flex-col gap-1">
        <span class="eyebrow text-text-4">{{ $t('diagramPane.layers.group') }}</span>
        <div
          role="group"
          data-testid="canvas-layers"
          :aria-label="$t('diagramPane.layers.group')"
          class="flex flex-wrap gap-0.5"
        >
          <button
            v-for="move in LAYER_MOVES"
            :key="move"
            :data-testid="`canvas-layer-${move}`"
            type="button"
            :class="[BTN, IDLE]"
            :title="$t(`diagramPane.layers.${move}`)"
            :aria-label="$t(`diagramPane.layers.${move}`)"
            @mousedown.stop
            @pointerdown.stop
            @click="emit('layer', move)"
          >
            <component :is="LAYER_ICON[move]" :size="16" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
