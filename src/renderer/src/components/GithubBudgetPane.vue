<script setup lang="ts">
/**
 * Settings → GitHub API (T611 U2, design.md §6 — GitHub API pane; mockup `d--settings-pane`).
 *
 * The whole picture of the shared `gh` budget — both buckets, the pace, the last hour, who spends
 * it and how often each Harnu consumer checks — plus the slow-down rules, wired to U1's prefs
 * (`window.api.githubBudgetPrefs` / `githubBudgetSetPrefs`, via the budget store). The pace, the
 * chart and the table follow the TIGHTER bucket, like the pill (D-2).
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNow } from '@vueuse/core'
import SettingHint from './ui/SettingHint.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import { useGithubBudgetStore } from '../stores/github-budget'
import { useGcStore } from '../stores/gc'
import { useMissionsStore } from '../stores/missions'
import { usePrStackStore } from '../stores/pr-stack'
import {
  cadenceFor,
  consumerKey,
  chartColumns,
  consumerRows,
  formatClock,
  formatCount,
  formatCountdown,
  intervalLabelParts,
  loginOf,
  meterFillClass,
  meterValueClass,
  minutesUntil,
  paceView,
  resourceName,
  sharePercent,
  usedPercent,
  type CadenceKind,
  type GhConsumer,
  type GhResource
} from '../lib/github-budget-view'

const { t, locale } = useI18n()
const store = useGithubBudgetStore()
const gc = useGcStore()
const missions = useMissionsStore()
const prStack = usePrStackStore()
const now = useNow({ interval: 20_000 })

onMounted(() => {
  void store.init()
  void store.loadPrefs()
  void prStack.ensurePrefs()
  missions.ensureStarted()
})

const loc = computed(() => String(locale.value))
const nowMs = computed(() => now.value.getTime())
const ready = computed(() => store.ready)
const state = computed(() => store.state)
const prefs = computed(() => store.prefs)
const login = computed(() => loginOf(store.snapshot))

// ── Banner ────────────────────────────────────────────────────────────────────
const banner = computed<{ tone: 'accent' | 'red'; title: string; body: string } | null>(() => {
  const r = ready.value
  if (!r || state.value === 'normal') return null
  const snap = r.snapshot
  if (state.value === 'exhausted') {
    return {
      tone: 'red',
      title: t('githubBudget.pane.exhaustedBanner.title', {
        resource: resourceName(r.tighter)
      }),
      body: t('githubBudget.pane.exhaustedBanner.body', {
        time: formatClock(store.resetAtMs ?? 0, loc.value)
      })
    }
  }
  return {
    tone: 'accent',
    title: t('githubBudget.pane.lowBanner.title', {
      since: formatClock(snap.throttle.since, loc.value)
    }),
    body: t('githubBudget.pane.lowBanner.body', {
      resource: resourceName(r.tighter),
      threshold: snap.throttle.threshold,
      time: formatClock(r.tighterView.bucket.reset * 1000, loc.value)
    })
  }
})

// ── Tiles ─────────────────────────────────────────────────────────────────────
function tile(resource: GhResource): {
  label: string
  left: string
  of: string
  pct: number
  fill: string
  valueClass: string
  bottom: string
} | null {
  const r = ready.value
  if (!r) return null
  const view = resource === 'rest' ? r.rest : r.graphql
  const b = view.bucket
  const pct = usedPercent(b)
  const resetMs = b.reset * 1000
  const clock = formatClock(resetMs, loc.value)
  const minutes = formatCountdown(minutesUntil(resetMs, nowMs.value))
  return {
    label: t(
      resource === 'rest' ? 'githubBudget.pane.restLabel' : 'githubBudget.pane.graphqlLabel'
    ),
    left: formatCount(b.remaining, loc.value),
    of: t('githubBudget.pane.leftOf', { limit: formatCount(b.limit, loc.value) }),
    pct,
    fill: meterFillClass(pct),
    valueClass: pct >= 80 ? meterValueClass(pct) : 'text-text',
    // The mockup shows the countdown on the tighter bucket only; the other bucket just names the time.
    bottom:
      resource === r.tighter
        ? t('githubBudget.pane.resetsAtIn', { clock, countdown: minutes })
        : t('githubBudget.pane.resetsAt', { clock })
  }
}
const restTile = computed(() => tile('rest'))
const graphqlTile = computed(() => tile('graphql'))

const pace = computed(() => {
  const r = ready.value
  if (!r) return null
  const p = paceView(r.tighterView, state.value, nowMs.value)
  const perMin = (n: number): string => formatCount(n, loc.value)
  return {
    value: p.callsPerMin === null ? '—' : perMin(p.callsPerMin),
    note:
      p.callsPerMin === null
        ? t('githubBudget.pane.paceWaiting')
        : p.emptyInMinutes !== null
          ? t('githubBudget.pane.paceEmptyIn', { countdown: formatCountdown(p.emptyInMinutes) })
          : t('githubBudget.pane.paceLasts'),
    warn: p.emptyInMinutes !== null,
    split:
      p.outsidePerMin === null
        ? null
        : p.harnuWasPerMin !== null
          ? t('githubBudget.pane.paceSplitWas', {
              harnu: perMin(p.harnuPerMin),
              was: perMin(p.harnuWasPerMin),
              outside: perMin(p.outsidePerMin)
            })
          : t('githubBudget.pane.paceSplit', {
              harnu: perMin(p.harnuPerMin),
              outside: perMin(p.outsidePerMin)
            })
  }
})

// ── Chart ─────────────────────────────────────────────────────────────────────
const columns = computed(() => {
  const r = ready.value
  return r ? chartColumns(r.tighterView.history, loc.value) : []
})
const throttled = computed(() => state.value !== 'normal')

// ── Consumers table ───────────────────────────────────────────────────────────
const deliveredCount = computed(
  () => missions.views.filter((v) => v.mission.status === 'delivered').length
)

function cadenceText(k: CadenceKind): string {
  switch (k.kind) {
    case 'every': {
      const p = intervalLabelParts(k.ms)
      return t(`githubBudget.cadence.every.${p.unit}`, { n: p.n })
    }
    case 'onOpen':
      return t('githubBudget.cadence.onOpen')
    case 'onEvent':
      return t('githubBudget.cadence.onEvent')
    case 'notChecked':
      return t('githubBudget.cadence.notChecked')
    case 'paused':
      return t('githubBudget.cadence.paused')
  }
}

interface TableRow {
  key: string
  name: string
  indent?: boolean
  calls: string
  share: string
  base: string | null
  now: string | null
  nowTone: 'accent' | 'red' | null
}

const rows = computed<TableRow[]>(() => {
  const r = ready.value
  if (!r) return []
  const view = r.tighterView
  const total = view.harnu + view.outside
  const inputs = {
    state: state.value,
    pausePrStackWhenLow: prefs.value?.pausePrStackWhenLow ?? true,
    prStackIntervalMs: prStack.prefs?.intervalMs ?? 90_000,
    prStackAutoRefresh: prStack.prefs?.autoRefresh ?? true,
    cleanupIntervalMs: gc.prefs?.intervalMs ?? 3_600_000
  }
  const out: TableRow[] = []
  const list = consumerRows(view)
  for (const row of list) {
    const c: GhConsumer = row.consumer
    const cell = cadenceFor(c, inputs)
    out.push({
      key: c,
      name: t(`githubBudget.table.${consumerKey(c)}`),
      calls: formatCount(row.calls, loc.value),
      share: `${sharePercent(row.calls, total)}%`,
      base: cadenceText(cell.base),
      now: cell.now ? cadenceText(cell.now) : null,
      nowTone: cell.now ? (cell.now.kind === 'paused' ? 'red' : 'accent') : null
    })
    // Delivered missions sit right under Missions. They cost nothing unless the operator opted back in.
    if (c === 'missions' && deliveredCount.value > 0) {
      const checked = prefs.value?.checkDelivered === true
      out.push({
        key: 'delivered',
        name: t('githubBudget.table.delivered', deliveredCount.value, {
          named: { n: deliveredCount.value }
        }),
        indent: true,
        calls: checked ? '—' : '0',
        share: checked ? '—' : '0%',
        base: cadenceText(
          checked
            ? cadenceFor('missions', { ...inputs, state: 'normal' }).base
            : { kind: 'notChecked' }
        ),
        now: checked && cell.now ? cadenceText(cell.now) : null,
        nowTone: checked && cell.now ? (cell.now.kind === 'paused' ? 'red' : 'accent') : null
      })
    }
  }
  out.push({
    key: 'outside',
    name: t('githubBudget.table.outside'),
    calls: formatCount(view.outside, loc.value),
    share: `${sharePercent(view.outside, total)}%`,
    base: null,
    now: null,
    nowTone: null
  })
  return out
})

// ── Controls ──────────────────────────────────────────────────────────────────
const thresholdOptions = [10, 15, 25].map((v) => ({ value: v, label: `${v}%` }))

function onThreshold(v: number | string | boolean | undefined): void {
  if (typeof v === 'number') void store.savePrefs({ threshold: v as 10 | 15 | 25 })
}
</script>

<template>
  <div v-if="ready && prefs" data-dsqa="d--settings-pane" :data-state="state">
    <h1 class="m-0 flex items-center gap-2 text-[14px] font-semibold text-text">
      {{ t('githubBudget.pane.title') }}
    </h1>
    <p class="mb-3.5 mt-1 max-w-[560px] text-[11.5px] leading-[1.5] text-text-3">
      {{ t(login ? 'githubBudget.pane.intro.budgetOf' : 'githubBudget.pane.intro.budgetLocal')
      }}<span v-if="login" class="font-mono text-text-2" data-testid="gh-pane-login"
        >@{{ login }}</span
      >{{ t('githubBudget.pane.intro.reads')
      }}<span class="font-mono text-text-2">gh api rate_limit</span
      >{{ t('githubBudget.pane.intro.after') }}
    </p>

    <div
      v-if="banner"
      class="mb-3 flex items-start gap-[7px] rounded-[var(--radius)] border px-[9px] py-[7px] text-[11px] leading-[1.45] text-text-2"
      :class="
        banner.tone === 'red' ? 'border-red-line bg-red-soft' : 'border-accent-line bg-accent-soft'
      "
      data-dsqa-part="throttle-banner"
      data-testid="gh-pane-banner"
    >
      <span
        ><b class="font-semibold text-text">{{ banner.title }}</b> {{ banner.body }}</span
      >
    </div>

    <div class="grid gap-2.5" style="grid-template-columns: 1fr 1fr 1.2fr" data-testid="gh-tiles">
      <div
        v-for="(tl, i) in [restTile, graphqlTile]"
        :key="i"
        class="flex flex-col gap-1.5 rounded-lg border border-border bg-sidebar px-3 py-2.5"
      >
        <template v-if="tl">
          <span class="text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-4">{{
            tl.label
          }}</span>
          <span
            class="font-mono text-[20px] font-semibold tabular-nums tracking-[-0.02em]"
            :class="tl.valueClass"
            >{{ tl.left }}
            <small class="font-sans text-[11px] font-normal tracking-normal text-text-3">{{
              tl.of
            }}</small></span
          >
          <div class="flex flex-col gap-[3px]">
            <div class="h-[3px] overflow-hidden rounded-full bg-surface-2">
              <div class="h-full rounded-full" :class="tl.fill" :style="{ width: tl.pct + '%' }" />
            </div>
            <span class="text-[11px] tabular-nums text-text-4">{{ tl.bottom }}</span>
          </div>
        </template>
      </div>
      <div class="flex flex-col gap-1.5 rounded-lg border border-border bg-sidebar px-3 py-2.5">
        <template v-if="pace">
          <span class="text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-4">{{
            t('githubBudget.pane.paceLabel')
          }}</span>
          <span
            class="font-mono text-[20px] font-semibold tabular-nums tracking-[-0.02em]"
            :class="pace.warn ? 'text-accent' : ''"
            >{{ pace.value }}
            <small class="font-sans text-[11px] font-normal tracking-normal text-text-3">{{
              pace.note
            }}</small></span
          >
          <span v-if="pace.split" class="text-[11px] tabular-nums text-text-4">{{
            pace.split
          }}</span>
        </template>
      </div>
    </div>

    <h2
      class="mb-2 mt-[18px] flex items-center gap-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-4"
    >
      {{ t('githubBudget.pane.chartTitle', { resource: resourceName(ready.tighter) }) }}
      <span
        class="ml-auto flex gap-3 text-[11px] font-normal normal-case tracking-normal text-text-3"
      >
        <span
          ><span class="mr-[5px] inline-block h-2 w-2 rounded-[2px] bg-accent align-[-1px]" />{{
            t('githubBudget.pane.legendHarnu')
          }}</span
        ><span v-if="throttled"
          ><span class="mr-[5px] inline-block h-2 w-2 rounded-[2px] bg-warning align-[-1px]" />{{
            t('githubBudget.pane.legendSlowed')
          }}</span
        ><span
          ><span class="mr-[5px] inline-block h-2 w-2 rounded-[2px] bg-text-4 align-[-1px]" />{{
            t('githubBudget.pane.legendOutside')
          }}</span
        >
      </span>
    </h2>
    <div
      class="relative grid h-[120px] items-end gap-1.5 border-b border-border px-0.5"
      style="grid-template-columns: repeat(12, 1fr)"
      data-testid="gh-chart"
    >
      <div
        v-for="c in columns"
        :key="c.start"
        class="flex h-full flex-col-reverse gap-px"
        data-testid="gh-chart-col"
      >
        <i
          v-if="c.harnuPct > 0"
          class="block rounded-[2px] bg-accent"
          :style="{ height: c.harnuPct + '%' }"
        />
        <i
          v-if="c.throttledPct > 0"
          class="block rounded-[2px] bg-warning"
          :style="{ height: c.throttledPct + '%' }"
        />
        <i
          v-if="c.outsidePct > 0"
          class="block rounded-[2px] bg-text-4"
          :style="{ height: c.outsidePct + '%' }"
        />
      </div>
    </div>
    <div
      class="mt-1 grid gap-1.5 text-[10.5px] tabular-nums text-text-4"
      style="grid-template-columns: repeat(12, 1fr)"
    >
      <span v-for="c in columns" :key="c.start">{{ c.label ?? '' }}</span>
    </div>

    <h2
      class="mb-2 mt-[18px] flex items-center gap-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-4"
    >
      {{ t('githubBudget.pane.tableTitle') }}
    </h2>
    <table class="w-full border-collapse text-[11.5px]" data-dsqa-part="consumers">
      <thead>
        <tr class="text-left text-[10.5px] font-medium text-text-4">
          <th class="pb-1.5 pr-2 text-left font-medium">{{ t('githubBudget.table.consumer') }}</th>
          <th class="pb-1.5 pr-2 text-right font-medium">{{ t('githubBudget.table.calls') }}</th>
          <th class="pb-1.5 pr-2 text-right font-medium">{{ t('githubBudget.table.share') }}</th>
          <th class="pb-1.5 pr-2 text-right font-medium">{{ t('githubBudget.table.every') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key" :data-row="row.key">
          <td
            class="border-t border-border py-1.5 pr-2 tabular-nums"
            :class="row.key === 'outside' || row.indent ? 'text-text-3' : 'text-text-2'"
          >
            <template v-if="row.indent">&nbsp;&nbsp;</template>{{ row.name }}
          </td>
          <td
            class="border-t border-border py-1.5 pr-2 text-right tabular-nums"
            :class="row.key === 'outside' ? 'text-text-3' : 'text-text-2'"
          >
            {{ row.calls }}
          </td>
          <td
            class="border-t border-border py-1.5 pr-2 text-right tabular-nums"
            :class="row.key === 'outside' ? 'text-text-3' : 'text-text-2'"
          >
            {{ row.share }}
          </td>
          <td
            class="border-t border-border py-1.5 pr-2 text-right tabular-nums"
            :class="[
              row.key === 'outside' ? 'text-text-3' : 'text-text-2',
              row.now ? (row.nowTone === 'red' ? 'text-red' : 'text-accent') : ''
            ]"
          >
            <template v-if="row.base === null">—</template>
            <template v-else-if="row.now"
              ><s class="mr-1 text-text-4">{{ row.base }}</s
              >{{ row.now }}</template
            >
            <template v-else>{{ row.base }}</template>
          </td>
        </tr>
      </tbody>
    </table>

    <h2
      class="mb-2 mt-[18px] flex items-center gap-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-4"
    >
      {{ t('githubBudget.pane.missionsTitle') }}
    </h2>
    <div class="flex items-start justify-between gap-4" data-dsqa-part="delivered-switch">
      <div>
        <div class="text-[12px] text-text-2">{{ t('githubBudget.pane.delivered.label') }}</div>
        <SettingHint class="max-w-[460px]">{{ t('githubBudget.pane.delivered.hint') }}</SettingHint>
      </div>
      <ToggleSwitch
        :model-value="prefs.checkDelivered"
        :aria-label="t('githubBudget.pane.delivered.label')"
        data-test="gh-check-delivered"
        @update:model-value="(v: boolean) => store.savePrefs({ checkDelivered: v })"
      />
    </div>

    <h2
      class="mb-2 mt-[18px] flex items-center gap-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-4"
    >
      {{ t('githubBudget.pane.lowTitle') }}
    </h2>
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="text-[12px] text-text-2">{{ t('githubBudget.pane.threshold.label') }}</div>
        <SettingHint class="max-w-[460px]">{{ t('githubBudget.pane.threshold.hint') }}</SettingHint>
      </div>
      <SegmentedControl
        :model-value="prefs.threshold"
        size="sm"
        :options="thresholdOptions"
        :aria-label="t('githubBudget.pane.threshold.label')"
        @update:model-value="onThreshold"
      />
    </div>
    <div class="mt-3.5 flex items-start justify-between gap-4">
      <div>
        <div class="text-[12px] text-text-2">{{ t('githubBudget.pane.pausePrStack.label') }}</div>
        <SettingHint class="max-w-[460px]">{{
          t('githubBudget.pane.pausePrStack.hint')
        }}</SettingHint>
      </div>
      <ToggleSwitch
        :model-value="prefs.pausePrStackWhenLow"
        :aria-label="t('githubBudget.pane.pausePrStack.label')"
        data-test="gh-pause-pr-stack"
        @update:model-value="(v: boolean) => store.savePrefs({ pausePrStackWhenLow: v })"
      />
    </div>
    <div class="mt-3.5 flex items-start justify-between gap-4">
      <div>
        <div class="text-[12px] text-text-2">{{ t('githubBudget.pane.notify.label') }}</div>
        <SettingHint class="max-w-[460px]">{{ t('githubBudget.pane.notify.hint') }}</SettingHint>
      </div>
      <ToggleSwitch
        :model-value="prefs.notify"
        :aria-label="t('githubBudget.pane.notify.label')"
        data-test="gh-notify"
        @update:model-value="(v: boolean) => store.savePrefs({ notify: v })"
      />
    </div>
    <p class="mt-4 text-[11px] text-text-4">{{ t('githubBudget.pane.fine') }}</p>
  </div>
  <p
    v-else-if="store.snapshot"
    class="text-[11.5px] leading-[1.5] text-text-3"
    data-testid="gh-pane-unavailable"
  >
    {{ t('githubBudget.pane.unavailable') }}
  </p>
</template>
