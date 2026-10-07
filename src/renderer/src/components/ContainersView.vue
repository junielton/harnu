<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useNow } from '@vueuse/core'
import { Container, Loader2, Play, RefreshCw, Recycle, Square } from 'lucide-vue-next'
import { useContainersStore } from '../stores/containers'
import { useUiStore } from '../stores/ui'
import { useContainersCopy } from './containers-copy'
import Button from './ui/Button.vue'
import {
  ICON_BTN_CLASS,
  METER_TONE_CLASS,
  chipToneClass,
  formatDisk,
  formatRam,
  hasQuickStop,
  meterLegend,
  meterSegments,
  recentVerbKey,
  resolveSelection,
  stoppedByHarnu,
  sweepTargets,
  tombstoneKey,
  zombieInDays,
  type Selection
} from './containers-format'
import ContainersDetail from './ContainersDetail.vue'
import type { ContainersTombstone, StackRow } from '../../../preload'

/**
 * Containers takeover (design.md "Containers takeover"; spec
 * `docs/specs/2026-09-10-containers-view/spec.html`, approved 2026-09-11).
 * Hero reclaim numbers + a RAM meter colored by verdict + a master list /
 * detail split, over U1's snapshot (T330). The view never derives a verdict:
 * it renders `ContainersSnapshot` as the main process computed it.
 *
 * Header content rides the shared `TakeoverShell` via Teleport, like every
 * takeover (design.md "TakeoverShell — shared chrome").
 */
const store = useContainersStore()
const ui = useUiStore()
const { t, ago } = useContainersCopy()
const now = useNow({ interval: 30_000 })
const nowMs = computed(() => now.value.getTime())

onMounted(async () => {
  await store.init()
  await store.ensureScanned()
})

const snap = computed(() => store.snapshot)
const available = computed(() => store.available)
/** The first scan is running: nothing to show but placeholders (spec `--scanning`). */
const firstScan = computed(() => snap.value === null)
const unavailable = computed(() => snap.value !== null && !snap.value.dockerAvailable)
const totals = computed(() => available.value?.totals ?? null)
const nothingToStop = computed(() => (totals.value?.stoppable ?? 0) === 0)

const rootState = computed(() =>
  firstScan.value
    ? 'containers-view--scanning'
    : unavailable.value
      ? 'containers-view--docker-unavailable'
      : 'containers-view'
)

const scanMeta = computed(() => {
  if (store.scanning || !snap.value) return t('containers.readingDocker')
  return t('containers.scannedAgo', { ago: ago(nowMs.value - snap.value.scannedAt) })
})

const segments = computed(() => meterSegments(store.stacks))
const legend = computed(() => (totals.value ? meterLegend(totals.value.ramByVerdict) : []))
const recentRows = computed(() => store.recent.slice(0, 10))

// ---- selection --------------------------------------------------------------------

const selection = ref<Selection | null>(null)
watch(
  snap,
  (next) => {
    selection.value = resolveSelection(selection.value, next)
  },
  { immediate: true }
)

const selectedStack = computed<StackRow | null>(() =>
  selection.value?.kind === 'stack' ? store.stackById(selection.value.id) : null
)
const selectedTomb = computed<ContainersTombstone | null>(() => {
  const sel = selection.value
  if (sel?.kind !== 'recent') return null
  return store.recent.find((t) => tombstoneKey(t) === sel.key) ?? null
})

function selectStack(id: string): void {
  selection.value = { kind: 'stack', id }
}
function selectRecent(key: string): void {
  selection.value = { kind: 'recent', key }
}
function isStackOn(id: string): boolean {
  return selection.value?.kind === 'stack' && selection.value.id === id
}
function isRecentOn(key: string): boolean {
  return selection.value?.kind === 'recent' && selection.value.key === key
}

// ---- rows ---------------------------------------------------------------------------

function chipText(s: StackRow): string {
  if (s.verdict === 'pending')
    return t('containers.verdict.pending', { n: zombieInDays(s.zombieInMs) })
  return t(`containers.verdict.${s.verdict}`)
}

function ramCell(s: StackRow): { text: string; stopped: boolean } {
  if (s.running) return { text: formatRam(s.ramBytes), stopped: false }
  if (stoppedByHarnu(s, store.recent)) return { text: t('containers.row.stopped'), stopped: true }
  return { text: t('containers.row.noRam'), stopped: false }
}

function isActing(id: string): boolean {
  return store.pending?.stacks.includes(id) ?? false
}

function quickStop(s: StackRow): void {
  if (store.pending) return
  void store.act({ verb: 'stop', stacks: [s.id] })
}

function stopRunning(): void {
  if (store.pending) return
  // Main picks the set under `bulk` — every running zombie and orphan, nothing else.
  void store.act({ verb: 'stop', bulk: true })
}

const bulkStopping = computed(() => store.pending?.bulk === true)

// ---- the mass clean, now Cleanup's (T443) ---------------------------------------------

/**
 * The stacks a clean-up COULD take: every zombie and orphan, running or exited. Display only — the
 * count on the button. The clean-up itself moved to Cleanup (one cleanup door, spec §9), so this
 * view no longer opens a dialog or keeps a tick-list: the button just routes there.
 */
const sweepable = computed(() => sweepTargets(store.stacks))

function openCleanup(): void {
  ui.openCleanup()
}

function recentWho(tb: ContainersTombstone): string {
  return tb.stacks.length > 1
    ? t('containers.recent.bulkWho', { n: tb.stacks.length })
    : (tb.stacks[0]?.name ?? '')
}

function recentVerb(tb: ContainersTombstone): string {
  return t(`containers.recent.${recentVerbKey(tb)}`)
}

const ROW_BASE =
  "relative grid w-full cursor-pointer items-center gap-2.5 rounded-sm py-[7px] pl-2.5 pr-2 before:absolute before:bottom-[7px] before:left-0 before:top-[7px] before:w-0.5 before:rounded-[2px] before:content-['']"
/** Every stack row and the skeletons: name, verdict chip, RAM, quick-stop. */
const ROW_COLS = 'grid-cols-[1fr_auto_56px_22px]'
const RECENT_BASE =
  "relative grid w-full cursor-pointer grid-cols-[14px_1fr_auto] items-center gap-2.5 rounded-sm py-1.5 pl-2.5 pr-2 text-[11.5px] text-text-4 before:absolute before:bottom-[6px] before:left-0 before:top-[6px] before:w-0.5 before:rounded-[2px] before:content-['']"
const ON = 'bg-surface-2 before:bg-accent'
const OFF = 'hover:bg-surface before:bg-transparent'
const EYEBROW =
  'px-2 pb-1.5 pt-2.5 text-[10.5px] font-medium uppercase tracking-[0.07em] text-text-4'
const SKELETON_ROWS: Array<{ name: number; chip: number; ram: number }> = [
  { name: 96, chip: 56, ram: 40 },
  { name: 120, chip: 56, ram: 40 },
  { name: 84, chip: 60, ram: 36 }
]
const SKELETON_ROWS_2: Array<{ name: number; chip: number; ram: number }> = [
  { name: 104, chip: 52, ram: 40 },
  { name: 90, chip: 64, ram: 40 }
]
</script>

<template>
  <div :data-dsqa="rootState" class="flex min-h-0 flex-1 flex-col">
    <!-- Docker unavailable (Cleanup empty-state anatomy) -->
    <div
      v-if="unavailable && snap && !snap.dockerAvailable"
      class="flex flex-1 flex-col items-center justify-center gap-2.5 text-center text-text-4"
    >
      <Container :size="28" :stroke-width="1.4" />
      <div class="text-[13px] font-medium text-text-2">{{ t('containers.unavailable.title') }}</div>
      <p class="m-0 max-w-[420px] text-[12px] leading-[1.6] text-text-3">
        {{ t('containers.unavailable.body') }}
      </p>
      <span
        class="rounded-sm border border-border bg-surface px-2 py-[3px] font-mono text-[11px] text-text-4"
        >{{ snap.dockerError }}</span
      >
      <Button variant="soft" :disabled="store.scanning" @click="store.scanNow()">
        <Loader2
          v-if="store.scanning"
          :size="13"
          :stroke-width="1.7"
          class="shrink-0 animate-spin"
        />
        <RefreshCw v-else :size="13" :stroke-width="1.7" class="shrink-0" />
        {{ t('containers.scanAgain') }}
      </Button>
    </div>

    <template v-else>
      <div
        :data-dsqa="
          nothingToStop && !firstScan ? 'containers-hero--nothing-to-stop' : 'containers-hero'
        "
        class="shrink-0"
      >
        <!-- Hero: reclaim numbers -->
        <div class="flex flex-wrap items-end gap-x-9 gap-y-3 px-[22px] pb-3.5 pt-[18px]">
          <div class="shrink-0">
            <span v-if="firstScan" class="my-1 block h-5 w-[72px] rounded-[3px] bg-surface-2" />
            <div
              v-else
              class="text-[20px] font-medium leading-7 tracking-[-0.015em] tabular-nums"
              :class="nothingToStop ? 'text-text-2' : 'text-text'"
            >
              {{ formatRam(totals?.zombieRamBytes ?? 0) }}
            </div>
            <div class="whitespace-nowrap text-[11px] text-text-3">
              {{
                !firstScan && nothingToStop
                  ? t('containers.hero.ramHeld')
                  : t('containers.hero.ramFreed')
              }}
            </div>
          </div>
          <div class="shrink-0">
            <span v-if="firstScan" class="my-1 block h-5 w-8 rounded-[3px] bg-surface-2" />
            <div
              v-else
              class="text-[20px] font-medium leading-7 tracking-[-0.015em] tabular-nums"
              :class="nothingToStop ? 'text-text-2' : 'text-text'"
            >
              {{ totals?.zombiePorts ?? 0 }}
            </div>
            <div class="whitespace-nowrap text-[11px] text-text-3">
              {{
                !firstScan && nothingToStop
                  ? t('containers.hero.portsHeld')
                  : t('containers.hero.portsReleased')
              }}
            </div>
          </div>
          <div class="shrink-0">
            <span v-if="firstScan" class="my-1 block h-5 w-[72px] rounded-[3px] bg-surface-2" />
            <div
              v-else
              class="text-[20px] font-medium leading-7 tracking-[-0.015em] text-text-2 tabular-nums"
            >
              {{ formatDisk(totals?.volumeBytesAtStake ?? 0) }}
            </div>
            <div class="whitespace-nowrap text-[11px] text-text-3">
              {{ t('containers.hero.volumesAtStake') }}
            </div>
          </div>
          <div class="ml-auto flex items-center gap-2 self-center">
            <span class="whitespace-nowrap text-[11px] text-text-4">{{ scanMeta }}</span>
            <Button
              variant="soft"
              data-testid="containers-scan"
              :disabled="store.scanning || firstScan"
              @click="store.scanNow()"
            >
              <Loader2
                v-if="store.scanning || firstScan"
                :size="13"
                :stroke-width="1.7"
                class="shrink-0 animate-spin"
              />
              <RefreshCw v-else :size="13" :stroke-width="1.7" class="shrink-0" />
              {{ store.scanning || firstScan ? t('containers.scanning') : t('containers.scanNow') }}
            </Button>
            <Button
              v-if="!firstScan && !nothingToStop"
              variant="success"
              data-testid="containers-stop-running"
              :disabled="store.pending !== null"
              @click="stopRunning()"
            >
              <Loader2
                v-if="bulkStopping"
                :size="11"
                :stroke-width="1.8"
                class="shrink-0 animate-spin"
              />
              {{
                bulkStopping
                  ? t('containers.stoppingRunning')
                  : t('containers.stopRunning', { n: totals?.stoppable ?? 0 })
              }}
            </Button>
            <!-- One cleanup door (T443): the mass clean lives in Cleanup. This only routes there. -->
            <Button
              v-if="!firstScan && sweepable.length > 0"
              variant="soft"
              data-testid="containers-sweep"
              :title="t('containers.openCleanupTitle')"
              @click="openCleanup()"
            >
              <Recycle :size="12" :stroke-width="1.7" class="shrink-0" />
              {{
                t('containers.openCleanup', sweepable.length, { named: { n: sweepable.length } })
              }}
            </Button>
          </div>
        </div>

        <!-- Meter: RAM by running stack, colored by verdict -->
        <div class="border-b border-border px-[22px] pb-4">
          <div
            class="flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-2"
            role="img"
            :aria-label="t('containers.meter.label')"
          >
            <span
              v-for="seg in segments"
              :key="seg.id"
              class="h-full"
              :class="METER_TONE_CLASS[seg.tone]"
              :style="{ width: `${seg.pct}%` }"
            />
          </div>
          <div class="flex flex-wrap gap-4 pt-2 text-[10.5px] tabular-nums text-text-3">
            <span v-if="firstScan">{{ t('containers.meter.scanning') }}</span>
            <span
              v-for="item in legend"
              v-else
              :key="item.key"
              class="inline-flex items-center gap-1.5"
            >
              <i class="inline-block h-2 w-2 rounded-[2px]" :class="METER_TONE_CLASS[item.tone]" />
              {{ t(`containers.meter.${item.key}`, { size: formatRam(item.bytes) }) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Split: master list / detail -->
      <div
        class="scrollable grid min-h-0 flex-1 grid-cols-[minmax(240px,340px)_minmax(360px,1fr)] overflow-x-auto"
      >
        <div
          data-dsqa="containers-master"
          class="scrollable min-h-0 overflow-y-auto border-r border-border px-2.5 py-2"
        >
          <template v-if="firstScan">
            <div :class="EYEBROW">{{ t('containers.section.needsYou') }}</div>
            <div
              v-for="(row, i) in SKELETON_ROWS"
              :key="`sk1-${i}`"
              :class="[ROW_BASE, ROW_COLS, 'cursor-default']"
            >
              <span
                class="block h-3 rounded-[3px] bg-surface-2"
                :style="{ width: `${row.name}px` }"
              />
              <span
                class="block h-[18px] rounded-full bg-surface-2"
                :style="{ width: `${row.chip}px` }"
              />
              <span
                class="block h-3 justify-self-end rounded-[3px] bg-surface-2"
                :style="{ width: `${row.ram}px` }"
              />
              <span />
            </div>
            <div :class="EYEBROW">{{ t('containers.section.leaveAlone') }}</div>
            <div
              v-for="(row, i) in SKELETON_ROWS_2"
              :key="`sk2-${i}`"
              :class="[ROW_BASE, ROW_COLS, 'cursor-default']"
            >
              <span
                class="block h-3 rounded-[3px] bg-surface-2"
                :style="{ width: `${row.name}px` }"
              />
              <span
                class="block h-[18px] rounded-full bg-surface-2"
                :style="{ width: `${row.chip}px` }"
              />
              <span
                class="block h-3 justify-self-end rounded-[3px] bg-surface-2"
                :style="{ width: `${row.ram}px` }"
              />
              <span />
            </div>
          </template>

          <template v-else>
            <template v-for="section in ['needsYou', 'leaveAlone'] as const" :key="section">
              <template v-if="(section === 'needsYou' ? store.needsYou : store.leaveAlone).length">
                <div :class="EYEBROW">{{ t(`containers.section.${section}`) }}</div>
                <div
                  v-for="s in section === 'needsYou' ? store.needsYou : store.leaveAlone"
                  :key="s.id"
                  role="button"
                  tabindex="0"
                  :data-stack="s.id"
                  class="group/row"
                  :class="[ROW_BASE, ROW_COLS, isStackOn(s.id) ? ON : OFF]"
                  :aria-pressed="isStackOn(s.id)"
                  @click="selectStack(s.id)"
                  @keydown.enter.self.prevent="selectStack(s.id)"
                  @keydown.space.self.prevent="selectStack(s.id)"
                >
                  <span class="truncate font-mono text-[12px] text-text" :title="s.name">{{
                    s.name
                  }}</span>
                  <span
                    class="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-[9px] py-[3px] text-[10.5px] font-semibold"
                    :class="chipToneClass(s.verdict)"
                    >{{ chipText(s) }}</span
                  >
                  <span
                    class="text-right font-mono text-[11px] tabular-nums"
                    :class="ramCell(s).stopped ? 'text-text-4' : 'text-text-3'"
                    >{{ ramCell(s).text }}</span
                  >
                  <span
                    v-if="isActing(s.id)"
                    class="flex h-[22px] w-[22px] items-center justify-center text-text-3"
                  >
                    <Loader2 :size="11" :stroke-width="1.8" class="animate-spin" />
                  </span>
                  <button
                    v-else-if="hasQuickStop(s)"
                    type="button"
                    data-testid="containers-quick-stop"
                    class="invisible focus-visible:visible group-hover/row:visible"
                    :class="ICON_BTN_CLASS"
                    :title="
                      s.kind === 'container'
                        ? t('containers.quickStop.container')
                        : t('containers.quickStop.stack')
                    "
                    :aria-label="
                      s.kind === 'container'
                        ? t('containers.quickStop.container')
                        : t('containers.quickStop.stack')
                    "
                    :disabled="store.pending !== null"
                    @click.stop="quickStop(s)"
                  >
                    <Square :size="10" :stroke-width="1.8" />
                  </button>
                  <span v-else />
                </div>
              </template>
            </template>

            <template v-if="recentRows.length">
              <div :class="EYEBROW">{{ t('containers.section.recent') }}</div>
              <div
                v-for="tb in recentRows"
                :key="tombstoneKey(tb)"
                role="button"
                tabindex="0"
                :class="[RECENT_BASE, isRecentOn(tombstoneKey(tb)) ? ON : OFF]"
                :aria-pressed="isRecentOn(tombstoneKey(tb))"
                @click="selectRecent(tombstoneKey(tb))"
                @keydown.enter.prevent="selectRecent(tombstoneKey(tb))"
                @keydown.space.prevent="selectRecent(tombstoneKey(tb))"
              >
                <Square v-if="tb.verb === 'stop'" :size="11" :stroke-width="1.8" />
                <Play v-else-if="tb.verb === 'start'" :size="11" :stroke-width="1.8" />
                <Trash2 v-else :size="11" :stroke-width="1.7" />
                <span class="truncate"
                  ><span class="font-mono text-[11px] text-text-3">{{ recentWho(tb) }}</span>
                  {{ recentVerb(tb) }}</span
                >
                <span class="text-[10.5px] tabular-nums">{{ ago(nowMs - tb.at) }}</span>
              </div>
            </template>
          </template>
        </div>

        <div v-if="firstScan" class="min-w-0" />
        <ContainersDetail
          v-else
          :stack="selectedStack"
          :tombstone="selectedTomb"
          :zombie-after-days="snap?.zombieAfterDays ?? 2"
          @select-recent="selectRecent"
        />
      </div>
    </template>
  </div>

  <!-- The shell's icon slot and a spacer that pins its close button to the right
       edge, as the spec draws it (TakeoverShell). Last root siblings, so
       `wrapper.element` stays the real root in Vue Test Utils. -->
  <Teleport to="#takeover-shell-actions" defer>
    <span class="ml-auto" />
  </Teleport>
  <Teleport to="#takeover-shell-icon" defer>
    <Container :size="15" :stroke-width="1.6" class="shrink-0 text-accent" />
  </Teleport>
</template>
