<script setup lang="ts">
/**
 * One worker row in the Scheduler takeover's list column (T295 Task 9, reshaped
 * by T590 for the folder-grouped list — design.md "Scheduler (takeover)" → "Worker
 * list"; approved mockup `docs/specs/2026-10-29-scheduler-folders/`, revision 2).
 *
 * Two lines on one right edge, in a 46px row with 12px / 10px padding:
 * - line 1: the 14px pin slot (the list's ONE pin toggle), the name (ellipsis —
 *   the only thing that ever shrinks) and the state (dot + label), right-aligned;
 * - line 2: `every · model · mode` and the run ticks in a fixed 48px box.
 * On hover the state gives its slot to Run now / Stop + Delete.
 *
 * Load-bearing per the contract:
 * - Selection is the `bg-surface` wash and nothing else — no accent rail, no
 *   border (revision 2 dropped the 2px rail for this list).
 * - An `off` row dims to 55% opacity as a WHOLE, including its state text —
 *   `opacity` on the root, not a muted color on individual children.
 *
 * The row no longer repeats its folder (the group header carries it), has no
 * last-result line and no cycle bar.
 *
 * Row actions are always in the DOM and take the state column's slot on real
 * `:hover` / focus via Tailwind's `group` variants — the mockup's static
 * `is-hovered` variant is a screenshot aid, not a distinct runtime state. They
 * are `display: none` at rest, never `opacity-0`: an invisible cluster would
 * still reserve width on line 1 and squeeze the name.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pin, Play, Square, Trash2 } from 'lucide-vue-next'
import { workerState, formatCountdown, formatDuration } from './scheduler-format'
import type { TickKind } from './scheduler-list'
import type { RunStatus, Worker } from '../../../preload'

const props = defineProps<{
  worker: Worker
  selected: boolean
  running: boolean
  lastStatus?: RunStatus
  /** Epoch-ms this worker is next due. Ignored while `running`. */
  nextAt: number
  /**
   * Epoch-ms this row's live tick was first observed running, or `undefined`
   * while idle. An estimate, not the tick's true start time — the IPC surface
   * (`SchedulerState`) exposes only `runningIds`, not a per-tick timestamp, so
   * the parent records "the moment this id first appeared in `runningIds`"
   * and that is what flows down here. At most a beat (the 30s ticker) off,
   * which never shows on screen.
   */
  runningSinceMs?: number
  /** Shared "now" clock from the parent — one ticking ref, not N per-row timers. */
  nowMs: number
  /** The last 10 runs, oldest left (`runTicks`). */
  ticks: readonly TickKind[]
}>()

const emit = defineEmits<{
  select: []
  pin: []
  'run-now': []
  stop: []
  delete: []
}>()

const { t } = useI18n()

const pinned = computed(() => typeof props.worker.pinnedAt === 'number')

const state = computed(() =>
  workerState(props.worker, {
    running: props.running,
    nextAt: props.nextAt,
    lastStatus: props.lastStatus
  })
)

const dsqa = computed(() =>
  props.selected ? 'worker-row--selected' : `worker-row--${state.value}`
)

const DOT_CLASS: Record<string, string> = {
  waiting: 'bg-text-4',
  running: 'bg-green',
  failed: 'bg-red',
  disabled: 'bg-red',
  off: 'bg-text-disabled'
}
const TEXT_CLASS: Record<string, string> = {
  waiting: 'text-text-3',
  running: 'text-green',
  failed: 'text-red',
  disabled: 'text-red',
  off: 'text-text-4'
}

const TICK_CLASS: Record<TickKind, string> = {
  ok: 'h-[7px] bg-green',
  error: 'h-[10px] bg-red',
  timeout: 'h-[10px] bg-warning',
  running: 'h-[10px] bg-green anim-tick-pulse',
  none: 'h-[10px] bg-border-2'
}

const dotClass = computed(() => DOT_CLASS[state.value])
const textClass = computed(() => TEXT_CLASS[state.value])

const everyLabel = computed(() => formatCountdown(props.worker.everyMinutes * 60_000))
const isAct = computed(() => props.worker.mode === 'act')

const stateLabel = computed(() => {
  switch (state.value) {
    case 'running':
      return t('scheduler.row.running', {
        duration: formatDuration(Math.max(0, props.nowMs - (props.runningSinceMs ?? props.nowMs)))
      })
    case 'failed':
      return t('scheduler.row.failedStreak', { n: props.worker.failureStreak })
    case 'disabled':
      return t('scheduler.row.disabledStreak', { n: props.worker.failureStreak })
    case 'off':
      return t('scheduler.row.off')
    default:
      return t('scheduler.row.nextIn', {
        countdown: formatCountdown(props.nextAt - props.nowMs)
      })
  }
})
</script>

<template>
  <div
    class="group relative flex h-[46px] shrink-0 cursor-pointer items-center border-b border-border pl-3 pr-2.5 transition-colors"
    :class="[selected ? 'bg-surface' : 'hover:bg-surface', state === 'off' ? 'opacity-[0.55]' : '']"
    :data-dsqa="dsqa"
    role="option"
    :aria-selected="selected"
    tabindex="0"
    @click="emit('select')"
    @keydown.enter="emit('select')"
  >
    <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <!-- line 1: pin slot + name | state (or, on hover, the actions) -->
      <div class="flex min-w-0 items-center gap-2">
        <div
          class="flex min-w-0 flex-1 items-center gap-[5px] overflow-hidden text-[12px] font-medium text-text"
        >
          <button
            type="button"
            class="-ml-0.5 flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-sm p-0 transition-colors hover:bg-surface-2"
            :class="
              pinned
                ? 'text-accent'
                : 'text-text-disabled hover:text-text group-hover:text-text-4 group-hover:hover:text-text'
            "
            data-action="pin"
            :aria-label="pinned ? t('scheduler.row.unpin') : t('scheduler.row.pin')"
            :title="pinned ? t('scheduler.row.unpin') : t('scheduler.row.pin')"
            :aria-pressed="pinned"
            @click.stop="emit('pin')"
          >
            <Pin :size="10" :stroke-width="1.8" aria-hidden="true" />
          </button>
          <span class="truncate" data-worker-name>
            {{ worker.name || t('scheduler.settings.namePlaceholder') }}
          </span>
        </div>

        <div
          class="flex shrink-0 items-center gap-[5px] text-[11px] group-focus-within:hidden group-hover:hidden"
          :class="textClass"
          data-row-state
        >
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full"
            :class="[dotClass, state === 'running' ? 'anim-pulse-dot' : '']"
          />
          <span class="whitespace-nowrap">{{ stateLabel }}</span>
        </div>

        <div
          class="hidden shrink-0 gap-0.5 group-focus-within:flex group-hover:flex"
          data-row-actions
        >
          <button
            v-if="!running"
            type="button"
            class="flex h-[22px] w-[22px] items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
            :aria-label="t('scheduler.row.runNow')"
            :title="t('scheduler.row.runNow')"
            @click.stop="emit('run-now')"
          >
            <Play :size="11" :stroke-width="1.6" />
          </button>
          <button
            v-else
            type="button"
            class="flex h-[22px] w-[22px] items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
            :aria-label="t('scheduler.row.stop')"
            :title="t('scheduler.row.stop')"
            @click.stop="emit('stop')"
          >
            <Square :size="11" :stroke-width="1.6" />
          </button>
          <button
            type="button"
            class="flex h-[22px] w-[22px] items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-red"
            :aria-label="t('scheduler.row.delete')"
            :title="t('scheduler.row.delete')"
            @click.stop="emit('delete')"
          >
            <Trash2 :size="11" :stroke-width="1.6" />
          </button>
        </div>
      </div>

      <!-- line 2: meta | run ticks in a fixed 48px box — neither ever shrinks -->
      <div class="flex min-w-0 items-center gap-2">
        <div
          class="flex min-w-0 flex-1 items-center gap-[5px] overflow-hidden whitespace-nowrap text-[11px] text-text-4"
        >
          <span class="shrink-0">{{ t('scheduler.row.every') }} {{ everyLabel }}</span>
          <span class="shrink-0 text-text-disabled">·</span>
          <span class="shrink-0">{{ worker.model }}</span>
          <span class="shrink-0 text-text-disabled">·</span>
          <span class="shrink-0" :class="isAct ? 'text-warning' : ''" data-worker-mode>{{
            worker.mode
          }}</span>
        </div>
        <span
          class="flex h-[10px] w-12 shrink-0 items-end justify-end gap-[2px]"
          :title="t('scheduler.list.lastRuns')"
          data-run-ticks
        >
          <i
            v-for="(kind, i) in ticks"
            :key="i"
            class="block w-[3px] shrink-0 rounded-[1px]"
            :class="TICK_CLASS[kind]"
            :data-tick="kind"
          />
        </span>
      </div>
    </div>
  </div>
</template>
