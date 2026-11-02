<script setup lang="ts">
/**
 * The footer GitHub pill's popover (design.md §6 — GitHub budget pill; mockup `b--own-pill`).
 *
 * Plan-usage anatomy for the two buckets (REST and GraphQL, 80/95 ramp), then "Who spent it · this
 * hour" for the TIGHTER bucket: a Harnu / outside split, one row per Harnu consumer, and the note
 * that says what Harnu changed while the budget is low or spent. Presentational: reads the store.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNow } from '@vueuse/core'
import { Github } from 'lucide-vue-next'
import { useGithubBudgetStore } from '../stores/github-budget'
import {
  ageParts,
  consumerKey,
  consumerRows,
  formatClock,
  formatCount,
  formatCountdown,
  loginOf,
  meterFillClass,
  meterValueClass,
  minutesUntil,
  outsideBarPct,
  paceView,
  splitBar,
  usedPercent,
  type GhConsumer,
  type GhResource
} from '../lib/github-budget-view'

const emit = defineEmits<{ details: [] }>()

const { t, locale } = useI18n()
const store = useGithubBudgetStore()
const now = useNow({ interval: 20_000 })

const ready = computed(() => store.ready)
const state = computed(() => store.state)
const loc = computed(() => String(locale.value))
const nowMs = computed(() => now.value.getTime())

const updated = computed(() => {
  const p = ageParts(store.snapshot?.sampledAt ?? null, nowMs.value)
  return t(
    p.unit === 's' ? 'githubBudget.popover.updatedSeconds' : 'githubBudget.popover.updatedMinutes',
    {
      n: p.n
    }
  )
})

interface MeterRow {
  resource: GhResource
  label: string
  left: string
  pct: number
  fill: string
  valueClass: string
  bottom: string
}

function meter(resource: GhResource): MeterRow | null {
  const r = ready.value
  if (!r) return null
  const view = resource === 'rest' ? r.rest : r.graphql
  const b = view.bucket
  const pct = usedPercent(b)
  const resetMs = b.reset * 1000
  const minutes = minutesUntil(resetMs, nowMs.value)
  const countdown = formatCountdown(minutes)
  let bottom: string
  if (b.remaining <= 0) {
    bottom = t('githubBudget.popover.resetsAt', {
      clock: formatClock(resetMs, loc.value),
      countdown
    })
  } else {
    bottom = t('githubBudget.popover.resetsIn', { countdown })
    const empty = paceView(view, state.value, nowMs.value).emptyInMinutes
    if (empty !== null) {
      bottom += ' · ' + t('githubBudget.popover.emptyIn', { countdown: formatCountdown(empty) })
    }
  }
  return {
    resource,
    label: t(resource === 'rest' ? 'githubBudget.meter.rest' : 'githubBudget.meter.graphql', {
      limit: formatCount(b.limit, loc.value)
    }),
    left: t('githubBudget.meter.left', { n: formatCount(b.remaining, loc.value) }),
    pct,
    fill: meterFillClass(pct),
    valueClass: meterValueClass(pct),
    bottom
  }
}

/** `@login · updated 20s ago`, without the handle when U1 did not report one. */
const headerMeta = computed(() => {
  const login = loginOf(store.snapshot)
  return login ? `@${login} · ${updated.value}` : updated.value
})

const meters = computed(() => [meter('rest'), meter('graphql')].filter((m) => m !== null))

const attribution = computed(() => {
  const r = ready.value
  if (!r) return null
  const split = splitBar(r.tighterView)
  const rows = consumerRows(r.tighterView)
  return {
    split,
    rows,
    outsidePct: outsideBarPct(r.tighterView, rows),
    resetClock: formatClock(r.tighterView.bucket.reset * 1000, loc.value)
  }
})

function consumerTag(c: GhConsumer): string | null {
  if (state.value === 'exhausted') return t('githubBudget.tag.paused')
  if (state.value === 'low' && c === 'missions') return t('githubBudget.tag.slowed')
  return null
}

const note = computed<{ tone: 'accent' | 'red'; title: string; body: string } | null>(() => {
  const a = attribution.value
  if (!a || state.value === 'normal') return null
  if (state.value === 'exhausted') {
    return {
      tone: 'red',
      title: t('githubBudget.popover.exhaustedNote.title'),
      body: t('githubBudget.popover.exhaustedNote.body', {
        time: formatClock(store.resetAtMs ?? 0, loc.value)
      })
    }
  }
  const pausesPrStack = store.prefs?.pausePrStackWhenLow ?? true
  return {
    tone: 'accent',
    title: t('githubBudget.popover.lowNote.title'),
    body: t(
      pausesPrStack
        ? 'githubBudget.popover.lowNote.bodyPrStack'
        : 'githubBudget.popover.lowNote.body',
      { time: a.resetClock }
    )
  }
})
</script>

<template>
  <div v-if="ready && attribution" :data-state="state">
    <div class="flex items-center gap-1.5 px-3 pt-1 text-[12px] font-semibold text-text">
      <Github :size="13" :stroke-width="1.6" class="shrink-0" />
      {{ t('githubBudget.popover.title')
      }}<span
        class="ml-auto text-[11px] font-normal tabular-nums text-text-4"
        data-testid="gh-popover-updated"
        >{{ headerMeta }}</span
      >
    </div>

    <div class="px-3 py-2">
      <div class="flex flex-col gap-2" data-testid="gh-meters">
        <div v-for="m in meters" :key="m.resource" class="flex flex-col gap-[3px]">
          <div class="flex items-center justify-between text-[11px]">
            <span class="truncate text-text-3">{{ m.label }}</span>
            <span class="tabular-nums" :class="m.valueClass">{{ m.left }}</span>
          </div>
          <div class="h-[3px] overflow-hidden rounded-full bg-surface">
            <div class="h-full rounded-full" :class="m.fill" :style="{ width: m.pct + '%' }" />
          </div>
          <span class="text-[11px] tabular-nums text-text-4">{{ m.bottom }}</span>
        </div>
      </div>
    </div>

    <div class="border-t border-border px-3 py-2" data-dsqa-part="attribution">
      <div class="mb-[7px] text-[10.5px] font-medium uppercase tracking-[0.06em] text-text-4">
        {{ t('githubBudget.popover.whoSpent') }}
      </div>
      <div
        class="flex h-1.5 gap-0.5 overflow-hidden rounded-[3px] bg-surface"
        data-testid="gh-split"
      >
        <i class="block h-full bg-accent" :style="{ width: attribution.split.harnuPct + '%' }" />
        <i class="block h-full bg-text-4" :style="{ width: attribution.split.outsidePct + '%' }" />
      </div>
      <div class="mt-[5px] flex gap-3 text-[11px] text-text-3">
        <span
          ><span class="mr-[5px] inline-block h-2 w-2 rounded-[2px] bg-accent align-[-1px]" />{{
            t('githubBudget.popover.harnu', { n: formatCount(attribution.split.harnu, loc) })
          }}</span
        ><span
          ><span class="mr-[5px] inline-block h-2 w-2 rounded-[2px] bg-text-4 align-[-1px]" />{{
            t('githubBudget.popover.outside', { n: formatCount(attribution.split.outside, loc) })
          }}</span
        >
      </div>
      <div class="mt-2 flex flex-col gap-[5px]" data-testid="gh-consumers">
        <div
          v-for="row in attribution.rows"
          :key="row.consumer"
          class="grid items-center gap-2 text-[11px]"
          style="grid-template-columns: 1fr 52px 64px"
          :data-consumer="row.consumer"
        >
          <span
            class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap"
            :class="state === 'exhausted' ? 'text-text-4' : 'text-text-2'"
            >{{ t(`githubBudget.consumer.${consumerKey(row.consumer)}`)
            }}<span v-if="consumerTag(row.consumer)" class="text-[10px] text-text-4">{{
              consumerTag(row.consumer)
            }}</span></span
          >
          <span class="text-right tabular-nums text-text-2">{{ formatCount(row.calls, loc) }}</span>
          <span class="h-[3px] overflow-hidden rounded-full bg-surface"
            ><i class="block h-full rounded-full bg-accent" :style="{ width: row.barPct + '%' }"
          /></span>
        </div>
        <div
          class="grid items-center gap-2 text-[11px] text-text-3"
          style="grid-template-columns: 1fr 52px 64px"
          data-consumer="outside"
        >
          <span class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">{{
            t('githubBudget.consumer.outside')
          }}</span>
          <span class="text-right tabular-nums">{{
            formatCount(attribution.split.outside, loc)
          }}</span>
          <span class="h-[3px] overflow-hidden rounded-full bg-surface"
            ><i
              class="block h-full rounded-full bg-text-4"
              :style="{ width: attribution.outsidePct + '%' }"
          /></span>
        </div>
      </div>
      <div
        v-if="note"
        class="mt-2 flex items-start gap-[7px] rounded-[var(--radius)] border px-[9px] py-[7px] text-[11px] leading-[1.45] text-text-2"
        :class="
          note.tone === 'red' ? 'border-red-line bg-red-soft' : 'border-accent-line bg-accent-soft'
        "
        data-testid="gh-note"
      >
        <span
          ><b class="font-semibold text-text">{{ note.title }}</b> {{ note.body }}</span
        >
      </div>
    </div>

    <button
      type="button"
      class="flex w-full items-center justify-end gap-1 rounded-sm p-1 text-[11px] text-accent transition-colors hover:bg-surface"
      data-testid="gh-details"
      @click="emit('details')"
    >
      {{ t('githubBudget.popover.details') }}
    </button>
  </div>
</template>
