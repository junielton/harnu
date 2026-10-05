<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNow } from '@vueuse/core'
import { LayoutDashboard } from 'lucide-vue-next'
import SegmentedControl from './ui/SegmentedControl.vue'
import Button from './ui/Button.vue'
import UsageNowStrip from './UsageNowStrip.vue'
import UsageHeatmap from './UsageHeatmap.vue'
import UsageDashboardKpiStrip from './UsageDashboardKpiStrip.vue'
import UsageDashboardStackChart from './UsageDashboardStackChart.vue'
import UsageDashboardCalendar from './UsageDashboardCalendar.vue'
import UsageDashboardRankList, { type RankRow } from './UsageDashboardRankList.vue'
import UsageDashboardAnatomy from './UsageDashboardAnatomy.vue'
import UsageDashboardExplorerTable from './UsageDashboardExplorerTable.vue'
import { formatCostUsd } from './usage-format'
import {
  distinctModels,
  filterSessions,
  modelColor,
  fmtInt,
  projectBasename,
  type ChartMetric
} from './usage-dashboard-format'
import type { UsageBiSnapshot, UsageBiRange } from '../../../preload'

/**
 * Usage Dashboard — main-pane takeover (design.md "Usage Dashboard
 * (takeover, T47 P6 S2)"). One `usageBiSnapshot({ range })` IPC call per
 * range change; model/project filters are applied client-side over the
 * already-loaded snapshot (no extra round-trip). Owns all cross-card
 * selection state (highlighted day, selected session) so cards can
 * cross-reference each other (calendar → chart highlight, rank list /
 * table / scatter → anatomy inspector).
 */
const { t } = useI18n()
const now = useNow({ interval: 60_000 })

const RANGE_OPTIONS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '60d', label: '60d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'all' }
]

const range = ref<UsageBiRange>('7d')
const snapshot = ref<UsageBiSnapshot | null>(null)
const loading = ref(true)
const loadError = ref(false)

const visibleModels = ref<Set<string>>(new Set())
const projectFilter = ref<string | null>(null)
const chartMetric = ref<ChartMetric>('cost')
const calendarMetric = ref<'rate' | 'cost' | 'sessions'>('rate')
const highlightedDay = ref<string | null>(null)
const selectedSessionId = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = false
  try {
    const result = await window.api.usageBiSnapshot({ range: range.value })
    snapshot.value = result
    // Seed the model filter with every model present the first time data
    // loads (or when a range change surfaces models we haven't seen yet) —
    // never silently drop a model the user hasn't explicitly turned off.
    const all = distinctModels(result)
    for (const m of all) {
      if (!visibleModels.value.has(m) && !seenModels.value.has(m)) visibleModels.value.add(m)
    }
    for (const m of all) seenModels.value.add(m)
    if (!selectedSessionId.value && result.sessions.length) {
      selectedSessionId.value =
        [...result.sessions].sort((a, b) => b.costUsd - a.costUsd)[0]?.sessionId ?? null
    }
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}
const seenModels = ref<Set<string>>(new Set())

onMounted(load)
watch(range, load)

function toggleModel(model: string): void {
  if (chartMetric.value === 'rate') return
  if (visibleModels.value.has(model)) {
    if (visibleModels.value.size === 1) return
    visibleModels.value.delete(model)
  } else {
    visibleModels.value.add(model)
  }
  // trigger reactivity (Set mutation isn't tracked by Vue's ref proxy)
  visibleModels.value = new Set(visibleModels.value)
}

const models = computed(() => (snapshot.value ? distinctModels(snapshot.value) : []))
const projects = computed(() => snapshot.value?.projects ?? [])

const filteredSessionsList = computed(() =>
  snapshot.value
    ? filterSessions(snapshot.value.sessions, visibleModels.value, projectFilter.value)
    : []
)

const todayDay = computed(() => {
  const d = new Date(now.value)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})

// Ranked lists are a glance surface, not a full listing — the explorer table
// below already covers every model/project/session with sorting. Capping to 5
// (matches "Top sessions" and the reference mockup) also protects the
// two-column grid's balance: an uncapped "Top projects" blew out to 90+ rows
// on real data, dwarfing the calendar/heatmap column beside it (visual bug
// caught in live CDP verification).
const TOP_RANK_CAP = 5

const topModelRows = computed<RankRow[]>(() => {
  if (!snapshot.value) return []
  return snapshot.value.models
    .slice()
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, TOP_RANK_CAP)
    .map((m) => ({
      key: m.model,
      name: m.model,
      color: modelColor(m.model),
      value: m.costUsd,
      valueLabel: formatCostUsd(m.costUsd),
      secondaryLabel: t('usageDashboard.rankList.requestsSuffix', { n: fmtInt(m.requestCount) }),
      dimmed: !visibleModels.value.has(m.model)
    }))
})
const topProjectRows = computed<RankRow[]>(() => {
  if (!snapshot.value) return []
  return snapshot.value.projects
    .slice()
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, TOP_RANK_CAP)
    .map((p) => ({
      key: p.projectPath,
      name: projectBasename(p.projectPath),
      title: p.projectPath,
      color: 'var(--color-accent)',
      value: p.costUsd,
      valueLabel: formatCostUsd(p.costUsd),
      secondaryLabel: t('usageDashboard.rankList.sessionsSuffix', { n: fmtInt(p.sessionCount) }),
      dimmed: !!projectFilter.value && projectFilter.value !== p.projectPath
    }))
})
const topSessionRows = computed<RankRow[]>(() => {
  return filteredSessionsList.value
    .slice()
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, TOP_RANK_CAP)
    .map((s) => ({
      key: s.sessionId,
      name: s.title,
      color: '#199e70',
      value: s.costUsd,
      valueLabel: formatCostUsd(s.costUsd),
      secondaryLabel: '',
      active: s.sessionId === selectedSessionId.value
    }))
})

function onSelectModelRow(model: string): void {
  toggleModel(model)
}
function onSelectProjectRow(projectPath: string): void {
  projectFilter.value = projectFilter.value === projectPath ? null : projectPath
}
function onSelectSessionRow(sessionId: string): void {
  selectedSessionId.value = sessionId
}
</script>

<template>
  <div class="scrollable min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-[1400px] px-6 pb-12 pt-5">
      <p class="mb-3.5 max-w-[900px] text-[11.5px] leading-relaxed text-text-3">
        {{ t('usageDashboard.subtitle') }}
      </p>

      <!-- Filter bar — two deliberate rows (range+models, then project+note) so a
             long model id never leaves Project stranded on its own line with a dead
             gap above it; wrapping within each row is still fine on narrow widths. -->
      <div
        class="sticky top-0 z-10 mb-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2.5 shadow-pop"
      >
        <div class="flex flex-wrap items-center gap-3.5">
          <div class="flex items-center gap-1.5">
            <span class="mr-0.5 text-[10.5px] uppercase tracking-wide text-text-3">{{
              t('usageDashboard.filterBar.range')
            }}</span>
            <SegmentedControl v-model="range" size="sm" :options="RANGE_OPTIONS" />
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="mr-0.5 text-[10.5px] uppercase tracking-wide text-text-3">{{
              t('usageDashboard.filterBar.models')
            }}</span>
            <button
              v-for="m in models"
              :key="m"
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12px] transition-colors"
              :class="[
                chartMetric === 'rate' ? 'pointer-events-none opacity-35' : '',
                visibleModels.has(m)
                  ? 'border-border-2 bg-surface-2 text-text'
                  : 'border-border bg-surface text-text-2 opacity-40'
              ]"
              @click="toggleModel(m)"
            >
              <span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: modelColor(m) }" />
              {{ m }}
            </button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3.5">
          <div class="flex items-center gap-1.5">
            <span class="mr-0.5 text-[10.5px] uppercase tracking-wide text-text-3">{{
              t('usageDashboard.filterBar.project')
            }}</span>
            <select
              class="cursor-pointer rounded border border-border bg-surface px-2.5 py-1 text-[12px] text-text"
              :value="projectFilter ?? ''"
              @change="projectFilter = ($event.target as HTMLSelectElement).value || null"
            >
              <option value="">{{ t('usageDashboard.filterBar.allProjects') }}</option>
              <option v-for="p in projects" :key="p.projectPath" :value="p.projectPath">
                {{ p.projectPath }}
              </option>
            </select>
          </div>
          <span
            v-if="chartMetric === 'rate' || range === '24h'"
            class="ml-auto max-w-[340px] text-right text-[11px] text-text-4"
          >
            <template v-if="chartMetric === 'rate'">{{
              t('usageDashboard.filterBar.noteRateDisabled')
            }}</template>
            <template v-else-if="range === '24h'">{{
              t('usageDashboard.filterBar.note24h')
            }}</template>
          </span>
        </div>
      </div>

      <template v-if="loading">
        <div class="flex h-64 items-center justify-center text-[13px] text-text-3">
          {{ t('usageDashboard.loading') }}
        </div>
      </template>
      <template v-else-if="loadError || !snapshot">
        <div class="flex h-64 flex-col items-center justify-center gap-2 text-[13px] text-text-3">
          <span>{{ t('usageDashboard.loadError') }}</span>
          <Button variant="soft" @click="load">
            {{ t('usageDashboard.retry') }}
          </Button>
        </div>
      </template>
      <template v-else>
        <!-- KPI strip -->
        <div class="mb-3.5">
          <UsageDashboardKpiStrip :snapshot="snapshot" />
        </div>

        <!-- Now strip -->
        <div
          v-if="snapshot.now?.fiveHour.usedPct != null"
          class="mb-4 rounded-lg border border-border bg-surface p-3.5"
        >
          <UsageNowStrip
            :pct="snapshot.now.fiveHour.usedPct"
            :resets-at-ms="snapshot.now.fiveHour.resetsAt"
            :projected-pct="snapshot.now.fiveHour.projectedAtResetPct"
            :now-ms="now.getTime()"
          />
        </div>

        <!-- Main grid -->
        <div
          class="mb-4 grid gap-3.5"
          style="grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr)"
        >
          <div class="flex flex-col gap-3.5">
            <div class="rounded-lg border border-border bg-surface p-3.5">
              <UsageDashboardStackChart
                v-model:metric="chartMetric"
                :days="snapshot.days"
                :visible-models="visibleModels"
                :today-day="todayDay"
                :highlighted-day="highlightedDay"
              />
            </div>
            <div class="rounded-lg border border-border bg-surface p-3.5">
              <UsageDashboardCalendar
                v-model:metric="calendarMetric"
                v-model:selected-day="highlightedDay"
                :days="snapshot.days"
                :now-ms="now.getTime()"
              />
            </div>
            <div class="rounded-lg border border-border bg-surface p-3.5">
              <div class="mb-1.5 flex items-center justify-between gap-2.5">
                <h2 class="text-[11.5px] font-bold uppercase tracking-wide text-text-2">
                  {{ t('usageDashboard.heatmap.title') }}
                </h2>
                <span class="text-[11px] text-text-4">{{
                  t('usageDashboard.heatmap.subtitle')
                }}</span>
              </div>
              <UsageHeatmap v-if="snapshot.heatmap" :heatmap="snapshot.heatmap" />
              <p v-else class="py-4 text-center text-[12px] text-text-4">
                {{ t('usageDashboard.heatmap.empty') }}
              </p>
              <p v-if="snapshot.heatmap?.heaviest" class="mt-2 text-[11px] text-text-3">
                {{
                  t('usageDashboard.heatmap.busiest', {
                    day: t(
                      'usageHistory.dow.' +
                        ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][
                          snapshot.heatmap.heaviest.dow
                        ]
                    ),
                    start: snapshot.heatmap.heaviest.hourStart,
                    end: snapshot.heatmap.heaviest.hourEnd
                  })
                }}
              </p>
            </div>
          </div>
          <div class="flex flex-col gap-3.5">
            <div class="rounded-lg border border-border bg-surface p-3.5">
              <div class="mb-2 flex items-center justify-between gap-2">
                <h2 class="text-[11.5px] font-bold uppercase tracking-wide text-text-2">
                  {{ t('usageDashboard.rankList.topModels') }}
                </h2>
                <span class="text-[11px] text-text-4">{{
                  t('usageDashboard.rankList.topModelsHint')
                }}</span>
              </div>
              <UsageDashboardRankList
                :rows="topModelRows"
                :empty-label="t('usageDashboard.rankList.empty')"
                @select="onSelectModelRow"
              />
            </div>
            <div class="rounded-lg border border-border bg-surface p-3.5">
              <div class="mb-2 flex items-center justify-between gap-2">
                <h2 class="text-[11.5px] font-bold uppercase tracking-wide text-text-2">
                  {{ t('usageDashboard.rankList.topProjects') }}
                </h2>
                <span class="text-[11px] text-text-4">{{
                  t('usageDashboard.rankList.topProjectsHint')
                }}</span>
              </div>
              <UsageDashboardRankList
                :rows="topProjectRows"
                :empty-label="t('usageDashboard.rankList.empty')"
                @select="onSelectProjectRow"
              />
            </div>
            <div class="rounded-lg border border-border bg-surface p-3.5">
              <div class="mb-2 flex items-center justify-between gap-2">
                <h2 class="text-[11.5px] font-bold uppercase tracking-wide text-text-2">
                  {{ t('usageDashboard.rankList.topSessions') }}
                </h2>
                <span class="text-[11px] text-text-4">{{
                  t('usageDashboard.rankList.topSessionsHint')
                }}</span>
              </div>
              <UsageDashboardRankList
                :rows="topSessionRows"
                :empty-label="t('usageDashboard.rankList.empty')"
                @select="onSelectSessionRow"
              />
            </div>
          </div>
        </div>

        <!-- Session anatomy -->
        <div class="mb-4 rounded-lg border border-border bg-surface p-3.5">
          <UsageDashboardAnatomy
            v-model:selected-id="selectedSessionId"
            :sessions="filteredSessionsList"
            :snapshot="snapshot"
          />
        </div>

        <!-- Explorer table -->
        <div class="rounded-lg border border-border bg-surface p-3.5">
          <UsageDashboardExplorerTable
            v-model:selected-session-id="selectedSessionId"
            :snapshot="snapshot"
            :sessions="filteredSessionsList"
          />
        </div>
      </template>
    </div>
  </div>

  <!-- T300/U3: header markup rendered into the shared TakeoverShell (design.md §6
       "TakeoverShell — shared chrome") via Teleport, since a dynamically swapped
       view can't fill a named slot of the ancestor wrapping it. Placed after the
       real body content (not first) so this stays a component whose first root
       node is a real element — Vue Test Utils resolves `wrapper.element` off the
       first root, and a Teleport placeholder there breaks every `find`/`get`. -->
  <Teleport to="#takeover-shell-icon" defer>
    <LayoutDashboard :size="15" :stroke-width="1.7" class="shrink-0 text-accent" />
  </Teleport>
</template>
