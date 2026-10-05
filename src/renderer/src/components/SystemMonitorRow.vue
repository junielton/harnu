<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, TriangleAlert, Pause, X } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import type { HeapSample } from '../../../preload'
import {
  formatBytes,
  formatPct,
  formatIdle,
  heapPercent,
  heapBarClass,
  isNoteworthyLiveReason
} from './system-monitor-format'

/**
 * One row of the System Monitor takeover (design.md "System Monitor
 * (takeover)") — a Harnu process, a session, or one of a live session's `/proc`
 * children. A single component covers all three because they share the exact
 * same 4-column grid (Name / RAM / CPU / State-detail); only the 4th column's
 * content differs, gated by `rowKind`.
 *
 * A parked session (`state === 'parked'`) renders a SECOND `<tr>` right below
 * the main one — the "explain" row (design.md, mockup `.explain`). Vue 3
 * supports multi-root (fragment) components, so this is a plain two-`<tr>`
 * template; the parent `<tbody>` sees both as siblings.
 */
type RowKind = 'harnu' | 'session' | 'child'

const props = withDefaults(
  defineProps<{
    rowKind: RowKind
    name: string
    /** Session rows only — the folder's git branch, shown as "· main" next to the name. */
    path?: string | null
    cpuPct: number | null
    rssBytes: number | null
    /** Harnu group's 'main' row only — feeds the inline heap gauge (the 2026-07-14 OOM signal). */
    heap?: HeapSample | null
    /** Session rows only. */
    state?: 'live' | 'parked'
    /** Session rows only — `FleetExplanation['reason']` or `'parked'`. */
    reason?: string
    idleMs?: number
    sweepRank?: number | null
    savedBytes?: number | null
    hasChildren?: boolean
    expanded?: boolean
    /** Session rows only — from `explainFleet`. Gates whether "Park now" renders at all. */
    parkable?: boolean
    /** `child` rows only — the session root's own cost (system-monitor-format.ts#selfSample),
     *  not a real `/proc` pid. Gets a distinct marker + muted italic label so it doesn't
     *  read as just another process in the list. */
    isSelf?: boolean
  }>(),
  {
    path: null,
    heap: null,
    state: undefined,
    reason: undefined,
    idleMs: 0,
    sweepRank: null,
    savedBytes: null,
    hasChildren: false,
    expanded: false,
    parkable: false,
    isSelf: false
  }
)

const emit = defineEmits<{ toggle: []; park: []; close: [] }>()

const { t } = useI18n()

const heapPct = computed(() => heapPercent(props.heap))
const heapFillClass = computed(() => heapBarClass(props.heap?.status))

/** Live rows only: a chip worth surfacing next to the state pip — see `isNoteworthyLiveReason`. */
const showLiveReasonChip = computed(
  () => props.state === 'live' && !!props.reason && isNoteworthyLiveReason(props.reason)
)
const showNextSweepNote = computed(() => props.state === 'live' && props.sweepRank === 1)

/** Park now (T127 S4) only makes sense for a live, resumable session — a parked
 *  row has no PTY left to kill, and a non-parkable kind (synthetic/shell)
 *  can't be resumed by `--resume` on wake. */
const showParkAction = computed(
  () => props.rowKind === 'session' && props.state === 'live' && props.parkable
)
const showCloseAction = computed(() => props.rowKind === 'session')
</script>

<template>
  <tr class="group border-b border-border" @click="hasChildren ? emit('toggle') : undefined">
    <td class="px-4 py-2">
      <span class="flex items-center gap-2">
        <button
          v-if="rowKind === 'session' && hasChildren"
          type="button"
          class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-text-3 hover:text-text"
          :aria-label="expanded ? t('systemMonitor.collapse') : t('systemMonitor.expand')"
          @click.stop="emit('toggle')"
        >
          <ChevronDown v-if="expanded" :size="13" :stroke-width="2" />
          <ChevronRight v-else :size="13" :stroke-width="2" />
        </button>
        <span
          v-else-if="rowKind === 'session'"
          class="inline-block w-3.5 shrink-0"
          aria-hidden="true"
        />
        <span
          v-if="rowKind === 'child'"
          class="w-4 shrink-0 text-center text-text-4"
          aria-hidden="true"
          >{{ isSelf ? '•' : '└' }}</span
        >
        <span
          v-if="rowKind === 'harnu'"
          class="w-3 shrink-0 text-center text-text-4"
          aria-hidden="true"
          >▪</span
        >
        <span
          class="truncate text-[13px]"
          :class="[
            rowKind === 'child' && isSelf
              ? 'italic text-text-3'
              : rowKind === 'child'
                ? 'text-text-2'
                : 'text-text'
          ]"
          :title="isSelf ? t('systemMonitor.ownMemoryHint') : undefined"
          >{{ name }}</span
        >
        <span v-if="path" class="truncate text-[11.5px] text-text-3">· {{ path }}</span>
      </span>
    </td>
    <td
      class="px-4 py-2 text-right font-mono text-[12px]"
      :class="rssBytes === null ? 'text-text-4' : 'text-text'"
    >
      {{ formatBytes(rssBytes) }}
    </td>
    <td
      class="px-4 py-2 text-right font-mono text-[12px]"
      :class="cpuPct === null ? 'text-text-4' : 'text-text'"
    >
      {{ formatPct(cpuPct) }}
    </td>
    <td class="px-4 py-2">
      <div
        v-if="rowKind === 'harnu' && heap"
        class="flex items-center justify-end gap-1.5 font-mono text-[11px] text-text-2"
      >
        <span>{{ t('systemMonitor.heapLabel') }}</span>
        <span class="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
          <span
            class="block h-full rounded-full"
            :class="heapFillClass"
            :style="{ width: `${heapPct}%` }"
          />
        </span>
        <span>{{ formatPct(heapPct) }}</span>
        <TriangleAlert v-if="heap.status !== 'ok'" :size="12" class="text-warning" />
      </div>

      <div v-else-if="rowKind === 'session'" class="flex items-center justify-end gap-2">
        <span
          class="inline-flex items-center gap-1.5 text-[11.5px]"
          :class="state === 'live' ? 'text-green' : 'text-text-3'"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="state === 'live' ? 'bg-green' : 'bg-text-4'"
          />
          {{ state === 'live' ? t('systemMonitor.stateLive') : t('systemMonitor.stateParked') }}
        </span>
        <span v-if="showLiveReasonChip" class="flex items-center gap-1 text-[11px] text-text-3">
          <span class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-2">{{
            reason
          }}</span>
          <span v-if="idleMs > 0">{{
            t('systemMonitor.idleFor', { duration: formatIdle(idleMs) })
          }}</span>
        </span>
        <span v-if="showNextSweepNote" class="text-[11px] text-warning">{{
          t('systemMonitor.nextSweep')
        }}</span>
        <!-- Per-row actions (T127 S4) — hidden until the row is hovered so the
             table reads clean at rest (design.md "System Monitor"). The Park
             slot always reserves its 22px even when absent, so the state pip
             lands at the same x for every session row regardless of parkable. -->
        <div
          v-if="showParkAction || showCloseAction"
          class="flex items-center gap-1 opacity-0 transition group-hover:opacity-100"
        >
          <Button
            v-if="showParkAction"
            variant="ghost"
            size="icon"
            :title="t('systemMonitor.actions.park')"
            :aria-label="t('systemMonitor.actions.park')"
            @click.stop="emit('park')"
          >
            <Pause :size="12" :stroke-width="2" class="text-warning" />
          </Button>
          <span v-else style="width: 22px; height: 22px" aria-hidden="true" />
          <Button
            v-if="showCloseAction"
            variant="ghost"
            size="icon"
            :title="t('systemMonitor.actions.close')"
            :aria-label="t('systemMonitor.actions.close')"
            @click.stop="emit('close')"
          >
            <X :size="12" :stroke-width="2" class="text-red" />
          </Button>
        </div>
      </div>
    </td>
  </tr>
  <tr v-if="rowKind === 'session' && state === 'parked'" class="border-b border-border">
    <td colspan="4" class="px-4 py-1.5 pl-9 text-[11px] text-text-3">
      <span
        class="mr-1.5 inline-block rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-2"
        >{{ reason }}</span
      >
      <template v-if="savedBytes !== null">
        ·
        <span class="text-green">{{
          t('systemMonitor.savedRam', { size: formatBytes(savedBytes) })
        }}</span>
      </template>
      · {{ t('systemMonitor.wakeHint') }}
    </td>
  </tr>
</template>
