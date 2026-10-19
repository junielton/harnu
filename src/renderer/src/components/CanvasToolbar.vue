<script setup lang="ts">
// Floating tool bar for the canvas pane (T536 U1, design.md §6 "Diagram pane →
// Toolbar"). Presentational only: the pane owns the tool state (canvas-tools.ts)
// and this component reports intent as events. Placement (top-centre, or the
// second row on a narrow pane) is the parent's job.
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Eraser,
  Hand,
  Lock,
  LockOpen,
  MousePointer2,
  MoveRight,
  Square,
  Type
} from 'lucide-vue-next'
import { CANVAS_TOOLS, LOCK_KEY, type CanvasTool } from './canvas/canvas-tools'

const props = defineProps<{
  tool: CanvasTool
  locked: boolean
  /** Tools already used successfully in this pane; their hint is hidden. */
  used: ReadonlySet<CanvasTool>
}>()

defineEmits<{
  select: [tool: CanvasTool]
  'toggle-lock': []
}>()

const { t } = useI18n()

const ICONS: Record<CanvasTool, Component> = {
  hand: Hand,
  select: MousePointer2,
  rectangle: Square,
  arrow: MoveRight,
  text: Type,
  eraser: Eraser
}

interface ToolButton {
  id: CanvasTool
  icon: Component
  title: string
  label: string
  cornerKey: string
  pressed: boolean
}

const buttons = computed<ToolButton[]>(() =>
  CANVAS_TOOLS.map((spec) => {
    const name = t(`diagramPane.tool.${spec.id}`)
    const key = spec.key.toUpperCase()
    return {
      id: spec.id,
      icon: ICONS[spec.id],
      title: spec.digit
        ? t('diagramPane.toolTitleDigit', { name, key, digit: spec.digit })
        : t('diagramPane.toolTitle', { name, key }),
      label: name,
      cornerKey: spec.digit ?? key,
      pressed: props.tool === spec.id
    }
  })
)

const lockLabel = computed(() => t(props.locked ? 'diagramPane.unlock' : 'diagramPane.lock'))

const showHint = computed(() => !props.used.has(props.tool))

const BTN = 'relative grid h-7 w-7 place-items-center rounded-sm transition-colors'
const ACTIVE = 'bg-accent-soft text-accent'
const IDLE = 'text-text-3 hover:bg-surface-2 hover:text-text'
</script>

<template>
  <div
    data-testid="canvas-toolbar"
    class="inline-flex max-w-full flex-col items-start gap-1"
    @pointerdown.stop
    @mousedown.stop
  >
    <div
      role="toolbar"
      :aria-label="$t('diagramPane.toolbar')"
      class="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded border border-border bg-surface p-1 shadow-pop"
    >
      <button
        data-testid="canvas-tool-lock"
        type="button"
        :class="[BTN, locked ? ACTIVE : IDLE]"
        :title="lockLabel"
        :aria-label="lockLabel"
        :aria-pressed="locked"
        @mousedown.stop
        @click="$emit('toggle-lock')"
      >
        <component :is="locked ? Lock : LockOpen" :size="16" />
        <span
          data-testid="canvas-tool-key"
          class="pointer-events-none absolute bottom-px right-[3px] text-[8px] leading-none text-text-4"
          >{{ LOCK_KEY.toUpperCase() }}</span
        >
      </button>
      <template v-for="b in buttons" :key="b.id">
        <button
          :data-testid="`canvas-tool-${b.id}`"
          type="button"
          :class="[BTN, b.pressed ? ACTIVE : IDLE]"
          :title="b.title"
          :aria-label="b.label"
          :aria-pressed="b.pressed"
          @mousedown.stop
          @click="$emit('select', b.id)"
        >
          <component :is="b.icon" :size="16" />
          <span
            data-testid="canvas-tool-key"
            class="pointer-events-none absolute bottom-px right-[3px] text-[8px] leading-none text-text-4"
            >{{ b.cornerKey }}</span
          >
        </button>
        <div v-if="b.id === 'hand'" role="separator" class="mx-0.5 h-5 w-px bg-border" />
      </template>
    </div>
    <p
      v-if="showHint"
      data-testid="canvas-tool-hint"
      class="max-w-full px-1 text-caption text-text-4"
    >
      {{ $t(`diagramPane.toolHint.${tool}`) }}
    </p>
  </div>
</template>
