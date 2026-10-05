<script setup lang="ts">
/**
 * One worker row in the Scheduler takeover's list column (T295 Task 9).
 * Anatomy per `docs/specs/2026-09-07-scheduler-takeover/spec.html`,
 * `data-dsqa` roots `worker-row--waiting|running|failed|disabled|off|selected`.
 *
 * Two things are load-bearing per the contract, not just decoration:
 * - The selected rail is a 2px absolutely-positioned strip, never a border on
 *   the row box (a border would shift the row's content by its own width).
 * - An `off` row dims to 55% opacity as a WHOLE, including its state text —
 *   `opacity` on the root, not a muted color on individual children.
 *
 * Row actions (Run now / Stop / Delete) are always in the DOM at `opacity-0`
 * and revealed by real `:hover` via Tailwind's `group`/`group-hover` — the
 * mockup's static `is-hovered` variant is a screenshot aid, not a distinct
 * runtime state.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Play, Square, Trash2 } from 'lucide-vue-next'
import { workerState, formatCountdown, formatDuration } from './scheduler-format'
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
  folderLabel: string
  branchLabel?: string | null
}>()

const emit = defineEmits<{
  select: []
  'run-now': []
  stop: []
  delete: []
}>()

const { t } = useI18n()

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

const dotClass = computed(() => DOT_CLASS[state.value])
const textClass = computed(() => TEXT_CLASS[state.value])

const everyLabel = computed(() => formatCountdown(props.worker.everyMinutes * 60_000))

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
    class="group relative flex h-[46px] shrink-0 cursor-pointer items-center gap-2 border-b border-border pl-3 pr-2.5 transition-colors"
    :class="[selected ? 'bg-surface' : 'hover:bg-surface', state === 'off' ? 'opacity-[0.55]' : '']"
    :data-dsqa="dsqa"
    role="option"
    :aria-selected="selected"
    tabindex="0"
    @click="emit('select')"
    @keydown.enter="emit('select')"
  >
    <span v-if="selected" class="absolute inset-y-0 left-0 w-[2px] bg-accent" aria-hidden="true" />

    <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <div class="truncate text-[12px] font-medium text-text">
        {{ worker.name || t('scheduler.settings.namePlaceholder') }}
      </div>
      <div
        class="flex items-center gap-[5px] overflow-hidden whitespace-nowrap text-[11px] text-text-4"
        :title="branchLabel ? `${folderLabel} · ${branchLabel}` : folderLabel"
      >
        <!-- The alias is the informative half, the branch secondary: both can
             shrink, but the branch shrinks 3x as eagerly (`shrink-[3]` vs the
             alias's default `shrink`), so a long worktree alias only starts
             truncating once the branch has already given up all its room —
             never the other way around. `every Xm` never shrinks at all: the
             schedule is the one thing this line must never lose. -->
        <span class="min-w-0 shrink truncate">{{ folderLabel }}</span>
        <template v-if="branchLabel">
          <span class="shrink-0 text-text-disabled">·</span>
          <span class="min-w-0 shrink-[3] truncate">{{ branchLabel }}</span>
        </template>
        <span class="shrink-0 text-text-disabled">·</span>
        <span class="shrink-0">{{ t('scheduler.row.every') }} {{ everyLabel }}</span>
      </div>
    </div>

    <div class="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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

    <div class="flex shrink-0 items-center gap-[5px] text-[11px]" :class="textClass">
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :class="[dotClass, state === 'running' ? 'anim-pulse-dot' : '']"
      />
      <span>{{ stateLabel }}</span>
    </div>
  </div>
</template>
