<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SegmentedControl from './ui/SegmentedControl.vue'
import { formatCostUsd } from './usage-format'
import {
  sortRows,
  buildDayTableRows,
  buildModelTableRows,
  buildProjectTableRows,
  modelColor,
  fmtInt,
  fmtTok,
  sparklinePoints,
  type SortDir
} from './usage-dashboard-format'
import type { UsageBiSnapshot, SessionAnatomy } from '../../../preload'

/**
 * Explorer table — design.md "Usage Dashboard (takeover)" § Explorer table.
 * Group-by switch (Days/Sessions/Models/Projects) swaps the ENTIRE column
 * schema (not the same columns with hidden ones); header click sorts;
 * row click selects (sessions feed the anatomy inspector via
 * `update:selectedSessionId`).
 */
const props = defineProps<{
  snapshot: UsageBiSnapshot
  sessions: readonly SessionAnatomy[]
  selectedSessionId: string | null
}>()
const emit = defineEmits<{ 'update:selectedSessionId': [string | null] }>()
const { t } = useI18n()

type GroupBy = 'days' | 'sessions' | 'models' | 'projects'
const groupBy = ref<GroupBy>('days')
const sortKey = ref('date')
const sortDir = ref<SortDir>('asc')

const GROUP_OPTIONS = computed(() => [
  { value: 'days', label: t('usageDashboard.table.groupDays') },
  { value: 'sessions', label: t('usageDashboard.table.groupSessions') },
  { value: 'models', label: t('usageDashboard.table.groupModels') },
  { value: 'projects', label: t('usageDashboard.table.groupProjects') }
])

function setGroup(v: GroupBy): void {
  groupBy.value = v
  sortKey.value = v === 'days' ? 'date' : 'cost'
  sortDir.value = v === 'days' ? 'asc' : 'desc'
}

function setSort(key: string): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value =
      key === 'date' || key === 'name' || key === 'session' || key === 'model' || key === 'project'
        ? 'asc'
        : 'desc'
  }
}
function arrow(key: string): string {
  return sortKey.value === key ? (sortDir.value === 'asc' ? '▲' : '▼') : ''
}
function thClass(key: string): string {
  return sortKey.value === key ? 'text-accent' : ''
}

// ---- Days --------------------------------------------------------------------
const dayRows = computed(() => {
  const enriched = buildDayTableRows(props.snapshot.days, props.snapshot.windows)
  const keyFn = (r: (typeof enriched)[number]): string | number => {
    if (sortKey.value === 'date') return r.day.day
    if (sortKey.value === 'weekday') return new Date(r.day.day).getDay()
    if (sortKey.value === 'peak5h') return r.day.peak5hPct ?? -1
    if (sortKey.value === 'peak7d') return r.day.peak7dPct ?? -1
    if (sortKey.value === 'cost') return r.day.costUsd
    if (sortKey.value === 'sessions') return r.day.sessionsWorked
    if (sortKey.value === 'domModel') return r.domModel ?? ''
    if (sortKey.value === 'delta') return r.deltaPct ?? -Infinity
    return 0
  }
  return sortRows(enriched, keyFn, sortDir.value)
})
const maxDayCost = computed(() => Math.max(1, ...props.snapshot.days.map((d) => d.costUsd)))

// ---- Sessions ------------------------------------------------------------------
const sessionRows = computed(() => {
  const keyFn = (s: SessionAnatomy): string | number => {
    if (sortKey.value === 'session') return s.title
    if (sortKey.value === 'cost') return s.costUsd
    if (sortKey.value === 'duration') return s.durationMs ?? 0
    if (sortKey.value === 'turns') return s.turns
    if (sortKey.value === 'tokens') return sessionTokTotal(s)
    if (sortKey.value === 'ctxPeak') return s.peakContextPct
    return 0
  }
  return sortRows(props.sessions, keyFn, sortDir.value)
})
const maxSessionCost = computed(() => Math.max(1, ...props.sessions.map((s) => s.costUsd)))
function sessionTokTotal(s: SessionAnatomy): number {
  return (
    s.tokens.inputTokens +
    s.tokens.outputTokens +
    s.tokens.cacheReadTokens +
    s.tokens.cacheWriteTokens
  )
}
function modelMixSegments(s: SessionAnatomy): { model: string; pct: number; color: string }[] {
  const total = s.costUsd || 1
  return Object.entries(s.costByModel)
    .filter(([, c]) => c > 0)
    .map(([model, c]) => ({ model, pct: (c / total) * 100, color: modelColor(model) }))
}
function dominantModelOf(s: SessionAnatomy): string | null {
  let best: string | null = null
  let bestCost = -1
  for (const [m, c] of Object.entries(s.costByModel)) {
    if (c > bestCost) {
      best = m
      bestCost = c
    }
  }
  return best
}

// ---- Models --------------------------------------------------------------------
const modelRows = computed(() => {
  const enriched = buildModelTableRows(props.snapshot.models)
  const keyFn = (r: (typeof enriched)[number]): string | number => {
    if (sortKey.value === 'model') return r.model.model
    if (sortKey.value === 'cost') return r.model.costUsd
    if (sortKey.value === 'requests') return r.model.requestCount
    if (sortKey.value === 'avg') return r.avgPerRequest
    if (sortKey.value === 'share') return r.shareOfCostPct
    return 0
  }
  return sortRows(enriched, keyFn, sortDir.value)
})
const maxModelCost = computed(() => Math.max(1, ...props.snapshot.models.map((m) => m.costUsd)))

// ---- Projects ------------------------------------------------------------------
const projectRows = computed(() => {
  const enriched = buildProjectTableRows(props.snapshot.projects)
  const keyFn = (r: (typeof enriched)[number]): string | number => {
    if (sortKey.value === 'project') return r.project.projectPath
    if (sortKey.value === 'sessions') return r.project.sessionCount
    if (sortKey.value === 'cost') return r.project.costUsd
    if (sortKey.value === 'share') return r.shareOfCostPct
    if (sortKey.value === 'avg') return r.avgPerSession
    return 0
  }
  return sortRows(enriched, keyFn, sortDir.value)
})
const maxProjectCost = computed(() => Math.max(1, ...props.snapshot.projects.map((p) => p.costUsd)))

const rowCountLabel = computed(() => {
  const n =
    groupBy.value === 'days'
      ? dayRows.value.length
      : groupBy.value === 'sessions'
        ? sessionRows.value.length
        : groupBy.value === 'models'
          ? modelRows.value.length
          : projectRows.value.length
  return n === 1 ? t('usageDashboard.table.rowCountOne') : t('usageDashboard.table.rowCount', { n })
})
</script>

<template>
  <div>
    <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
      <SegmentedControl
        :model-value="groupBy"
        size="sm"
        :options="GROUP_OPTIONS"
        @update:model-value="setGroup($event as GroupBy)"
      />
      <span class="text-[11.5px] text-text-4">{{ rowCountLabel }}</span>
    </div>

    <!-- scrollable = themed thin/hover scrollbar (main.css); overflow-y-hidden
         guards against the browser implicitly computing overflow-y: auto
         (CSS quirk when only overflow-x is set) and surfacing a native
         vertical scrollbar the table row height never actually needs. -->
    <div class="scrollable overflow-x-auto overflow-y-hidden rounded-lg border border-border">
      <table class="w-full border-collapse">
        <!-- Days -->
        <template v-if="groupBy === 'days'">
          <thead>
            <tr class="border-b border-border bg-surface-2">
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('date')"
                @click="setSort('date')"
              >
                {{ t('usageDashboard.table.colDate') }} {{ arrow('date') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('weekday')"
                @click="setSort('weekday')"
              >
                {{ t('usageDashboard.table.colWeekday') }} {{ arrow('weekday') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('peak5h')"
                @click="setSort('peak5h')"
              >
                {{ t('usageDashboard.table.colPeak5h') }} {{ arrow('peak5h') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('peak7d')"
                @click="setSort('peak7d')"
              >
                {{ t('usageDashboard.table.colPeak7d') }} {{ arrow('peak7d') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('cost')"
                @click="setSort('cost')"
              >
                {{ t('usageDashboard.table.colCost') }} {{ arrow('cost') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('sessions')"
                @click="setSort('sessions')"
              >
                {{ t('usageDashboard.table.colSessions') }} {{ arrow('sessions') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('domModel')"
                @click="setSort('domModel')"
              >
                {{ t('usageDashboard.table.colDominantModel') }} {{ arrow('domModel') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('delta')"
                @click="setSort('delta')"
              >
                {{ t('usageDashboard.table.colDelta') }} {{ arrow('delta') }}
              </th>
              <th
                class="whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
              >
                {{ t('usageDashboard.table.colWindows') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="dayRows.length === 0">
              <td colspan="9" class="p-8 text-center text-[13px] text-text-3">
                {{ t('usageDashboard.table.emptyDays') }}
              </td>
            </tr>
            <tr
              v-for="r in dayRows"
              :key="r.day.day"
              class="border-b border-border last:border-b-0"
            >
              <td class="whitespace-nowrap px-3 py-2 tabular-nums font-bold text-text">
                {{ r.day.day }}
              </td>
              <td class="px-3 py-2 text-text-2">
                {{ new Date(r.day.day).toLocaleDateString(undefined, { weekday: 'short' }) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                {{ r.day.peak5hPct != null ? Math.round(r.day.peak5hPct) + '%' : '—' }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                {{ r.day.peak7dPct != null ? Math.round(r.day.peak7dPct) + '%' : '—' }}
              </td>
              <td class="px-3 py-2">
                <div class="flex items-center justify-end gap-2">
                  <span class="h-[6px] w-[62px] shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span
                      class="block h-full rounded-full bg-accent"
                      :style="{ width: (r.day.costUsd / maxDayCost) * 100 + '%' }"
                    />
                  </span>
                  <span class="min-w-14 tabular-nums text-right text-text">{{
                    formatCostUsd(r.day.costUsd)
                  }}</span>
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-right text-text-2">
                {{ fmtInt(r.day.sessionsWorked) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2">
                <span
                  v-if="r.domModel"
                  class="inline-flex items-center gap-1.5 rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 text-[10.5px] font-bold text-text-2"
                >
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    :style="{ background: modelColor(r.domModel) }"
                  />
                  {{ r.domModel }}
                </span>
                <span v-else class="text-text-4">—</span>
              </td>
              <td class="whitespace-nowrap px-3 py-2">
                <span v-if="r.deltaPct == null" class="text-text-4">—</span>
                <span
                  v-else
                  class="inline-flex items-center gap-0.5 text-[12px] font-bold"
                  :class="r.deltaPct >= 0 ? 'text-red' : 'text-green'"
                >
                  {{ r.deltaPct >= 0 ? '▲' : '▼' }} {{ Math.abs(r.deltaPct).toFixed(0) }}%
                </span>
              </td>
              <td class="whitespace-nowrap px-3 py-2">
                <span v-if="!r.windowPeaks.length" class="text-text-4">—</span>
                <span v-else class="inline-flex items-center gap-2">
                  <svg
                    viewBox="0 0 90 22"
                    preserveAspectRatio="none"
                    class="h-[22px] w-[90px] shrink-0"
                  >
                    <polyline
                      :points="sparklinePoints(r.windowPeaks, 90, 22).points"
                      fill="none"
                      stroke="var(--color-accent)"
                      stroke-width="1.4"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                    />
                  </svg>
                  <span class="tabular-nums text-text-3">{{
                    Math.round(r.windowPeaks[r.windowPeaks.length - 1]) + '%'
                  }}</span>
                </span>
              </td>
            </tr>
          </tbody>
        </template>

        <!-- Sessions -->
        <template v-else-if="groupBy === 'sessions'">
          <thead>
            <tr class="border-b border-border bg-surface-2">
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('session')"
                @click="setSort('session')"
              >
                {{ t('usageDashboard.table.colSession') }} {{ arrow('session') }}
              </th>
              <th
                class="whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
              >
                {{ t('usageDashboard.table.colModelMix') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('cost')"
                @click="setSort('cost')"
              >
                {{ t('usageDashboard.table.colCost') }} {{ arrow('cost') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('duration')"
                @click="setSort('duration')"
              >
                {{ t('usageDashboard.table.colDuration') }} {{ arrow('duration') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('turns')"
                @click="setSort('turns')"
              >
                {{ t('usageDashboard.table.colTurns') }} {{ arrow('turns') }}
              </th>
              <th
                class="whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
              >
                {{ t('usageDashboard.table.colAgentsSub') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('tokens')"
                @click="setSort('tokens')"
              >
                {{ t('usageDashboard.table.colTokens') }} {{ arrow('tokens') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('ctxPeak')"
                @click="setSort('ctxPeak')"
              >
                {{ t('usageDashboard.table.colCtxPeak') }} {{ arrow('ctxPeak') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="sessionRows.length === 0">
              <td colspan="8" class="p-8 text-center text-[13px] text-text-3">
                {{ t('usageDashboard.table.emptySessions') }}
              </td>
            </tr>
            <tr
              v-for="s in sessionRows"
              :key="s.sessionId"
              class="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-surface-2"
              :class="
                s.sessionId === selectedSessionId
                  ? 'bg-accent-soft shadow-[inset_2px_0_0_0_var(--color-accent)]'
                  : ''
              "
              @click="
                emit(
                  'update:selectedSessionId',
                  s.sessionId === selectedSessionId ? null : s.sessionId
                )
              "
            >
              <td class="px-3 py-2 font-bold text-text">{{ s.title }}</td>
              <td class="px-3 py-2">
                <div class="flex items-center gap-2">
                  <span
                    class="flex h-2 w-16 shrink-0 overflow-hidden rounded shadow-[inset_0_0_0_1px_var(--color-border)]"
                  >
                    <span
                      v-for="seg in modelMixSegments(s)"
                      :key="seg.model"
                      :style="{ width: seg.pct + '%', background: seg.color }"
                    />
                  </span>
                  <span class="whitespace-nowrap text-[10.5px] text-text-3">{{
                    dominantModelOf(s)
                  }}</span>
                </div>
              </td>
              <td class="px-3 py-2">
                <div class="flex items-center justify-end gap-2">
                  <span class="h-[6px] w-[62px] shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span
                      class="block h-full rounded-full bg-accent"
                      :style="{ width: (s.costUsd / maxSessionCost) * 100 + '%' }"
                    />
                  </span>
                  <span class="min-w-14 tabular-nums text-right text-text">{{
                    formatCostUsd(s.costUsd)
                  }}</span>
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                {{ ((s.durationMs ?? 0) / 3600000).toFixed(1) }}h
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                {{ fmtInt(s.turns) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-text">
                1 <span class="text-text-4">+ {{ s.subagentCount }} sub</span>
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                {{ fmtTok(sessionTokTotal(s)) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                {{ s.peakContextPct }}%
              </td>
            </tr>
          </tbody>
        </template>

        <!-- Models -->
        <template v-else-if="groupBy === 'models'">
          <thead>
            <tr class="border-b border-border bg-surface-2">
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('model')"
                @click="setSort('model')"
              >
                {{ t('usageDashboard.table.colModel') }} {{ arrow('model') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('cost')"
                @click="setSort('cost')"
              >
                {{ t('usageDashboard.table.colCost') }} {{ arrow('cost') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('requests')"
                @click="setSort('requests')"
              >
                {{ t('usageDashboard.table.colRequests') }} {{ arrow('requests') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('avg')"
                @click="setSort('avg')"
              >
                {{ t('usageDashboard.table.colAvgPerRequest') }} {{ arrow('avg') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('share')"
                @click="setSort('share')"
              >
                {{ t('usageDashboard.table.colShareOfCost') }} {{ arrow('share') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="modelRows.length === 0">
              <td colspan="5" class="p-8 text-center text-[13px] text-text-3">
                {{ t('usageDashboard.table.emptyModels') }}
              </td>
            </tr>
            <tr
              v-for="r in modelRows"
              :key="r.model.model"
              class="border-b border-border last:border-b-0"
            >
              <td class="whitespace-nowrap px-3 py-2">
                <span
                  class="inline-flex items-center gap-1.5 rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 text-[10.5px] font-bold text-text-2"
                >
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    :style="{ background: modelColor(r.model.model) }"
                  />
                  {{ r.model.model }}<span v-if="r.model.estimated">*</span>
                </span>
              </td>
              <td class="px-3 py-2">
                <div class="flex items-center justify-end gap-2">
                  <span class="h-[6px] w-[62px] shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span
                      class="block h-full rounded-full bg-accent"
                      :style="{ width: (r.model.costUsd / maxModelCost) * 100 + '%' }"
                    />
                  </span>
                  <span class="min-w-14 tabular-nums text-right text-text">{{
                    formatCostUsd(r.model.costUsd)
                  }}</span>
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-right text-text-2">
                {{ fmtInt(r.model.requestCount) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-right text-text-2">
                {{ formatCostUsd(r.avgPerRequest) }}
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-right text-text-2">
                {{ r.shareOfCostPct.toFixed(1) }}%
              </td>
            </tr>
          </tbody>
        </template>

        <!-- Projects -->
        <template v-else>
          <thead>
            <tr class="border-b border-border bg-surface-2">
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('project')"
                @click="setSort('project')"
              >
                {{ t('usageDashboard.table.colProject') }} {{ arrow('project') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('sessions')"
                @click="setSort('sessions')"
              >
                {{ t('usageDashboard.table.colSessions') }} {{ arrow('sessions') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('cost')"
                @click="setSort('cost')"
              >
                {{ t('usageDashboard.table.colCost') }} {{ arrow('cost') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('share')"
                @click="setSort('share')"
              >
                {{ t('usageDashboard.table.colShareOfCost') }} {{ arrow('share') }}
              </th>
              <th
                class="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[10.5px] uppercase tracking-wide text-text-4"
                :class="thClass('avg')"
                @click="setSort('avg')"
              >
                {{ t('usageDashboard.table.colAvgPerSession') }} {{ arrow('avg') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="projectRows.length === 0">
              <td colspan="5" class="p-8 text-center text-[13px] text-text-3">
                {{ t('usageDashboard.table.emptyProjects') }}
              </td>
            </tr>
            <tr
              v-for="r in projectRows"
              :key="r.project.projectPath"
              class="border-b border-border last:border-b-0"
            >
              <td class="px-3 py-2 font-bold text-text">{{ r.project.projectPath }}</td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-right text-text-2">
                {{ fmtInt(r.project.sessionCount) }}
              </td>
              <td class="px-3 py-2">
                <div class="flex items-center justify-end gap-2">
                  <span class="h-[6px] w-[62px] shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span
                      class="block h-full rounded-full bg-accent"
                      :style="{ width: (r.project.costUsd / maxProjectCost) * 100 + '%' }"
                    />
                  </span>
                  <span class="min-w-14 tabular-nums text-right text-text">{{
                    formatCostUsd(r.project.costUsd)
                  }}</span>
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-right text-text-2">
                {{ r.shareOfCostPct.toFixed(1) }}%
              </td>
              <td class="whitespace-nowrap px-3 py-2 tabular-nums text-right text-text-2">
                {{ formatCostUsd(r.avgPerSession) }}
              </td>
            </tr>
          </tbody>
        </template>
      </table>
    </div>
  </div>
</template>
