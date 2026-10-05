<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { useNow } from '@vueuse/core'
import {
  ArrowUpRight,
  Box,
  Check,
  CircleHelp,
  Container,
  Copy,
  Ghost,
  History,
  Info,
  Loader2,
  Lock,
  Play,
  Shield,
  Square,
  TriangleAlert,
  X
} from 'lucide-vue-next'
import { useContainersStore } from '../stores/containers'
import { useSessionsStore } from '../stores/sessions'
import { useContainersCopy } from './containers-copy'
import {
  DAY_MS,
  ICON_BTN_CLASS,
  btnClass,
  chipToneClass,
  containerCount,
  displayPath,
  formatDisk,
  formatRam,
  formatStamp,
  freedPorts,
  freedRam,
  isAnonymousVolume,
  isWorktreeAttribution,
  keptVolumesOf,
  lastExitedAt,
  recentVerbKey,
  removedVolumes,
  runningSince,
  stackIcon,
  stopProgress,
  tiersFor,
  zombieInDays,
  type StackIcon,
  type Tier
} from './containers-format'
import ContainersRemoveDialog from './ContainersRemoveDialog.vue'
import type { ContainerRow, ContainersTombstone, StackRow } from '../../../preload'

/**
 * The Containers takeover's detail pane (design.md "Containers takeover" →
 * "Detail pane"; spec `containers-detail--*`). Renders either a stack — its
 * evidence, containers, volumes and exactly the actions its verdict offers
 * (PRD §3.4) — or a Recent entry (a journal tombstone) with its undo.
 *
 * Every action goes through `stores/containers.ts` → U1's `containersAct`; the
 * main process re-checks every tier, so this pane only decides what to OFFER.
 */
const props = defineProps<{
  stack: StackRow | null
  tombstone: ContainersTombstone | null
  zombieAfterDays: number
}>()
const emit = defineEmits<{ selectRecent: [key: string] }>()

const store = useContainersStore()
const sessions = useSessionsStore()
const { t, ago, agoLong, duration, failureText, failureDetail } = useContainersCopy()
const now = useNow({ interval: 30_000 })
const nowMs = computed(() => now.value.getTime())

const ICONS: Record<StackIcon, Component> = {
  box: Box,
  container: Container,
  ghost: Ghost,
  shield: Shield,
  help: CircleHelp
}

// ---- shared row shapes ----------------------------------------------------------------

interface Part {
  text: string
  mono?: boolean
  gone?: boolean
}
interface EvRow {
  key: string
  parts: Part[]
  tone?: 'ok' | 'bad' | 'live'
  num?: boolean
}

const TONE_CLASS: Record<NonNullable<EvRow['tone']>, string> = {
  ok: 'text-green',
  bad: 'text-warning',
  live: 'text-accent'
}

interface Nav {
  label: string
  run: () => void
}

function folderNav(path: string | null, worktree: boolean): Nav | null {
  if (!path || !sessions.findFolderByPath(path)) return null
  return {
    label: worktree ? t('containers.nav.openWorktree') : t('containers.nav.openFolder'),
    run: () => sessions.jumpToFolder(path)
  }
}

// ---- stack ------------------------------------------------------------------------

const pending = computed(() =>
  props.stack && store.pending?.stacks.includes(props.stack.id) ? store.pending : null
)
const failure = computed(() => (props.stack ? (store.failures[props.stack.id] ?? null) : null))

const variant = computed(() => {
  if (props.tombstone) {
    if (props.tombstone.verb === 'remove') return 'recent-removed'
    return props.tombstone.stacks.length > 1 ? 'recent-bulk' : 'recent'
  }
  const s = props.stack
  if (!s) return 'empty'
  if (pending.value?.verb === 'stop') return 'stopping'
  if (failure.value) return 'failed'
  if (s.verdict === 'zombie') return s.running ? 'zombie' : 'exited'
  return s.verdict
})

const titleIcon = computed<Component>(() =>
  props.tombstone ? History : props.stack ? ICONS[stackIcon(props.stack)] : Box
)

const chipText = computed(() => {
  const s = props.stack
  if (!s) return ''
  if (s.verdict === 'pending')
    return t('containers.verdict.pending', { n: zombieInDays(s.zombieInMs) })
  return t(`containers.verdict.${s.verdict}`)
})

const stackNavs = computed<Nav[]>(() => {
  const s = props.stack
  if (!s || s.verdict === 'unknown' || s.verdict === 'orphan') return []
  const out: Nav[] = []
  if (s.verdict === 'active' && s.liveSessionId && sessions.findSessionById(s.liveSessionId)) {
    const id = s.liveSessionId
    out.push({ label: t('containers.nav.goToSession'), run: () => sessions.activateSession(id) })
  }
  const folder = folderNav(s.attribution.folderPath, isWorktreeAttribution(s))
  if (folder) out.push(folder)
  return out
})

function attributionText(s: StackRow): string {
  if (s.attribution.rung === 'compose-label') return t('containers.attribution.compose')
  if (s.attribution.rung === 'bind-mount') {
    return isWorktreeAttribution(s)
      ? t('containers.attribution.bindWorktree')
      : t('containers.attribution.bindFolder')
  }
  return t('containers.attribution.none')
}

/** The clock row: "Unused for" on a running zombie, else State / Running (spec per verdict). */
function clockRow(s: StackRow): EvRow | null {
  if (s.verdict === 'zombie' && s.running && s.unusedForMs !== null) {
    return {
      key: t('containers.evidence.unusedFor'),
      parts: [
        {
          text: t('containers.value.unusedFor', {
            duration: duration(s.unusedForMs),
            threshold: duration(props.zombieAfterDays * DAY_MS)
          })
        }
      ],
      num: true
    }
  }
  if (s.running) {
    const since = runningSince(s)
    if (since === null) return null
    return {
      key: t('containers.evidence.running'),
      parts: [{ text: duration(nowMs.value - since) }],
      num: true
    }
  }
  const exited = lastExitedAt(s)
  const ago = exited !== null ? agoLong(nowMs.value - exited) : null
  const text =
    ago === null
      ? t('containers.value.notStarted')
      : s.verdict === 'zombie'
        ? t('containers.value.exitedHoldsNothing', { ago })
        : t('containers.value.exited', { ago })
  return { key: t('containers.evidence.state'), parts: [{ text }], num: true }
}

const evidence = computed<EvRow[]>(() => {
  const s = props.stack
  if (!s) return []
  const rows: EvRow[] = [
    { key: t('containers.evidence.attributedBy'), parts: [{ text: attributionText(s) }] }
  ]
  const path = s.attribution.path
  if (s.verdict === 'unknown') {
    rows.push({
      key: t('containers.evidence.startedBy'),
      parts: [
        {
          text:
            s.kind === 'compose'
              ? t('containers.value.dockerCompose')
              : t('containers.value.dockerRun'),
          mono: true
        }
      ]
    })
  } else if (path) {
    const gone = s.attribution.folderKind === 'gone'
    if (isWorktreeAttribution(s)) {
      rows.push({
        key: t('containers.evidence.worktree'),
        parts: [{ text: displayPath(path), mono: true, gone }]
      })
      if (s.verdict !== 'active') {
        rows.push({
          key: t('containers.evidence.worktreeExists'),
          parts: [{ text: gone ? t('containers.value.noDeleted') : t('containers.value.yes') }],
          tone: gone ? 'bad' : 'ok'
        })
      }
    } else {
      const kind =
        s.attribution.folderKind === 'main-checkout'
          ? t('containers.value.mainCheckout')
          : t('containers.value.notCheckout')
      rows.push({
        key: t('containers.evidence.folder'),
        parts: [{ text: displayPath(path), mono: true }, { text: ` · ${kind}` }]
      })
    }
  }
  if (s.verdict !== 'orphan' && s.verdict !== 'unknown') {
    if (s.verdict === 'active') {
      const at = s.lastSessionActivityAt
      rows.push({
        key: t('containers.evidence.harnuSession'),
        parts: [
          {
            text:
              at !== null
                ? t('containers.value.sessionWorking', { ago: ago(nowMs.value - at) })
                : t('containers.value.sessionWorkingNoTime')
          }
        ],
        tone: 'live'
      })
    } else {
      rows.push({
        key: t('containers.evidence.harnuSession'),
        parts: [{ text: t('containers.value.none') }]
      })
    }
  }
  const clock = clockRow(s)
  if (clock) rows.push(clock)
  return rows
})

const volumeRows = computed<EvRow[]>(() => {
  const s = props.stack
  if (!s) return []
  return s.volumes.map((v, i) => {
    const parts: Part[] = [
      { text: isAnonymousVolume(v.name) ? t('containers.value.anonymous') : v.name, mono: true },
      {
        text: ` · ${v.sizeBytes !== null ? formatDisk(v.sizeBytes) : t('containers.value.sizeUnknown')}`
      }
    ]
    if (v.shared) parts.push({ text: ` · ${t('containers.value.shared')}` })
    return { key: i === 0 ? t('containers.evidence.volume') : '', parts }
  })
})

interface NoteView {
  tone: 'warn' | 'info' | 'quiet'
  icon: Component
  text: string
}

const NOTE_CLASS: Record<NoteView['tone'] | 'error', { box: string; icon: string }> = {
  warn: { box: 'border-warning-line bg-warning-soft text-text-2', icon: 'text-warning' },
  info: { box: 'border-accent-line bg-accent-soft text-text-2', icon: 'text-accent' },
  quiet: { box: 'border-border bg-surface text-text-3', icon: 'text-text-4' },
  error: { box: 'border-red-line bg-red-soft text-text-2', icon: 'text-red' }
}

const note = computed<NoteView | null>(() => {
  const s = props.stack
  if (!s) return null
  switch (s.verdict) {
    case 'orphan':
      return { tone: 'warn', icon: TriangleAlert, text: t('containers.note.orphan') }
    case 'active':
      return { tone: 'info', icon: Info, text: t('containers.note.active') }
    case 'protected':
      return {
        tone: 'quiet',
        icon: Shield,
        text:
          s.attribution.folderKind === 'plain'
            ? t('containers.note.protectedPlain')
            : t('containers.note.protected')
      }
    case 'pending':
      return {
        tone: 'quiet',
        icon: Info,
        text:
          s.unusedForMs === null
            ? t('containers.note.pendingNoClock')
            : t('containers.note.pending', {
                unused: duration(s.unusedForMs),
                threshold: duration(props.zombieAfterDays * DAY_MS)
              })
      }
    case 'unknown':
      return { tone: 'quiet', icon: Lock, text: t('containers.note.unknown') }
    default:
      return null
  }
})

function ctrStateText(c: ContainerRow): { text: string; cls: string } {
  const p = pending.value
  if (p && p.baseline[props.stack?.id ?? '']?.includes(c.id)) {
    if (p.verb === 'stop' && c.running) {
      return { text: t('containers.ctrState.stopping'), cls: 'text-warning' }
    }
    if (p.verb === 'start' && !c.running) {
      return { text: t('containers.ctrState.starting'), cls: 'text-warning' }
    }
  }
  return {
    text: t(`containers.ctrState.${c.state}`, c.state),
    cls: c.running ? 'text-text-3' : 'text-text-4'
  }
}

const tiers = computed<Tier[]>(() => (props.stack ? tiersFor(props.stack) : []))

function tierLabel(tier: Tier): string {
  const p = pending.value
  if (tier.action === 'stop') {
    if (p?.verb === 'stop' && props.stack) {
      const { done, total } = stopProgress(p.baseline[props.stack.id] ?? [], props.stack.containers)
      return t('containers.tier.stopping', { done, total })
    }
    return failure.value?.verb === 'stop'
      ? t('containers.tier.tryAgain')
      : t('containers.tier.stopStack')
  }
  if (tier.action === 'start') {
    if (p?.verb === 'start') return t('containers.tier.starting')
    return failure.value?.verb === 'start'
      ? t('containers.tier.tryAgain')
      : t('containers.tier.startStack')
  }
  return t('containers.tier.remove')
}

function tierCaption(tier: Tier): string {
  if (tier.caption === 'reversible') {
    return t('containers.tier.caption.reversible', { size: formatRam(props.stack?.ramBytes ?? 0) })
  }
  return t(`containers.tier.caption.${tier.caption}`)
}

function tierBusy(tier: Tier): boolean {
  return pending.value?.verb === tier.action
}

/** Any action in flight disables every button: main runs one at a time. */
const anyPending = computed(() => store.pending !== null)

const removeTarget = ref<StackRow | null>(null)

function runTier(tier: Tier): void {
  const s = props.stack
  if (!s || anyPending.value) return
  if (tier.action === 'remove') {
    removeTarget.value = s
    return
  }
  if (tier.action === 'stop') {
    void store.act({ verb: 'stop', stacks: [s.id], ...(tier.force ? { force: true } : {}) })
    return
  }
  void store.act({ verb: 'start', stacks: [s.id] })
}

function onRemoveClose(key: string | null): void {
  removeTarget.value = null
  if (key) emit('selectRecent', key)
}

// ---- tombstone --------------------------------------------------------------------

const tomb = computed(() => props.tombstone)
const isBulk = computed(() => (tomb.value?.stacks.length ?? 0) > 1)
const tombKept = computed(() => (tomb.value ? keptVolumesOf(tomb.value) : []))

const tombName = computed(() => {
  const tb = tomb.value
  if (!tb) return ''
  return isBulk.value
    ? t('containers.recent.bulkWho', { n: tb.stacks.length })
    : (tb.stacks[0]?.name ?? '')
})

const tombWhen = computed(() => {
  const tb = tomb.value
  if (!tb) return ''
  const ago = agoLong(nowMs.value - tb.at)
  if (tb.verb === 'stop') return t('containers.recent.whenStopped', { ago })
  if (tb.verb === 'start') return t('containers.recent.whenStarted', { ago })
  return t('containers.recent.whenRemoved', { ago })
})

const tombNavs = computed<Nav[]>(() => {
  const tb = tomb.value
  if (!tb || isBulk.value) return []
  const path = tb.stacks[0]?.path ?? null
  const current = store.stackById(tb.stacks[0]?.stack ?? '')
  const worktree = current
    ? isWorktreeAttribution(current)
    : !sessions.findFolderByPath(path ?? '')?.isMainWorktree
  const nav = folderNav(current?.attribution.folderPath ?? path, worktree)
  return nav ? [nav] : []
})

const tombEvidence = computed<EvRow[]>(() => {
  const tb = tomb.value
  if (!tb) return []
  const n = containerCount(tb)
  const rows: EvRow[] = []
  let action: string
  if (tb.verb === 'remove') {
    const key =
      recentVerbKey(tb) === 'removedVolumeRemoved'
        ? 'actionRemovedVolume'
        : tombKept.value.length > 0
          ? 'actionRemovedKept'
          : 'actionRemoved'
    action = t(`containers.value.${key}`, n, { named: { n } })
  } else if (isBulk.value) {
    const key = tb.verb === 'stop' ? 'actionStoppedBulk' : 'actionStartedBulk'
    action = t(`containers.value.${key}`, { stacks: tb.stacks.length, n })
  } else {
    const key = tb.verb === 'stop' ? 'actionStopped' : 'actionStarted'
    action = t(`containers.value.${key}`, n, { named: { n } })
  }
  rows.push({ key: t('containers.evidence.action'), parts: [{ text: action }] })
  if (isBulk.value) {
    rows.push({
      key: t('containers.evidence.stacks'),
      parts: [{ text: tb.stacks.map((s) => s.name).join(' · '), mono: true }]
    })
  }
  rows.push({
    key: t('containers.evidence.when'),
    parts: [{ text: formatStamp(tb.at) }],
    num: true
  })
  if (tb.verb === 'stop') {
    const ports = freedPorts(tb)
    rows.push({
      key: t('containers.evidence.freed'),
      parts: [
        {
          text: t('containers.value.freed', ports, {
            named: { ram: formatRam(freedRam(tb)), n: ports }
          })
        }
      ],
      num: true
    })
  }
  const path = !isBulk.value ? (tb.stacks[0]?.path ?? null) : null
  if (path) {
    rows.push({
      key: t('containers.evidence.worktree'),
      parts: [{ text: displayPath(path), mono: true }]
    })
  }
  if (tb.verb === 'remove' && path) {
    const exists = tb.restoreHint !== null
    rows.push({
      key: t('containers.evidence.worktreeExists'),
      parts: [{ text: exists ? t('containers.value.yes') : t('containers.value.noDeleted') }],
      tone: exists ? 'ok' : 'bad'
    })
  }
  if (tb.verb === 'remove') {
    tombKept.value.forEach((v, i) => {
      rows.push({
        key: i === 0 ? t('containers.evidence.volumeKept') : '',
        parts: [
          {
            text: isAnonymousVolume(v.name) ? t('containers.value.anonymous') : v.name,
            mono: true
          },
          // Several kept volumes share one recorded sum: no per-volume size then.
          ...(v.sizeBytes !== null ? [{ text: ` · ${formatDisk(v.sizeBytes)}` }] : [])
        ]
      })
    })
  }
  return rows
})

const tombNote = computed(() => {
  const tb = tomb.value
  if (!tb || tb.verb !== 'remove') return null
  if (tb.restoreHint === null) return t('containers.note.removedGone')
  return tombKept.value.length > 0 && removedVolumes(tb).length === 0
    ? t('containers.note.removed')
    : t('containers.note.removedNoVolume')
})

const restoreEyebrow = computed(() =>
  tomb.value?.verb === 'remove'
    ? t('containers.restore.toBringBack')
    : t('containers.restore.toUndo')
)
const restoreWraps = computed(() => isBulk.value || tomb.value?.verb === 'remove')

/** Stacks a Recent stop can bring back: those still in the scan and not running. */
const startTargets = computed(() => {
  const tb = tomb.value
  if (!tb || tb.verb !== 'stop') return []
  return tb.stacks
    .map((s) => store.stackById(s.stack))
    .filter(
      (s): s is StackRow =>
        s !== null && !s.running && s.verdict !== 'unknown' && s.verdict !== 'orphan'
    )
    .map((s) => s.id)
})
const recentStarting = computed(
  () =>
    store.pending?.verb === 'start' &&
    startTargets.value.some((id) => store.pending?.stacks.includes(id))
)

function startFromRecent(): void {
  if (anyPending.value || startTargets.value.length === 0) return
  void store.act({ verb: 'start', stacks: startTargets.value })
}

async function copyHint(hint: string): Promise<void> {
  await navigator.clipboard.writeText(hint)
}
</script>

<template>
  <div
    :data-dsqa="`containers-detail--${variant}`"
    class="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden px-[22px] py-[18px]"
  >
    <!-- ── A stack ─────────────────────────────────────────────────────────── -->
    <template v-if="stack && !tombstone">
      <div class="scrollable @container flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div class="flex items-center gap-2.5">
          <component :is="titleIcon" :size="15" :stroke-width="1.6" class="shrink-0 text-text-3" />
          <span class="truncate font-mono text-[13px] text-text" :title="stack.name">{{
            stack.name
          }}</span>
          <span
            class="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-[9px] py-[3px] text-[10.5px] font-semibold"
            :class="chipToneClass(stack.verdict)"
            >{{ chipText }}</span
          >
          <span
            v-if="stack.verdict === 'active'"
            class="anim-pulse-dot h-[7px] w-[7px] shrink-0 rounded-full bg-accent [--pulse-from:0.47]"
          />
          <span v-if="stackNavs.length" class="ml-auto flex gap-1">
            <button
              v-for="nav in stackNavs"
              :key="nav.label"
              type="button"
              :class="btnClass('ghost', 'sm')"
              @click="nav.run()"
            >
              <ArrowUpRight :size="11" :stroke-width="1.8" class="shrink-0" />{{ nav.label }}
            </button>
          </span>
        </div>

        <div class="grid grid-cols-[150px_1fr] gap-x-3.5 gap-y-[7px] text-[11.5px]">
          <template v-for="(row, i) in evidence" :key="`ev-${i}`">
            <span class="text-text-4">{{ row.key }}</span>
            <span
              class="flex min-w-0 items-center gap-1.5"
              :class="[
                row.tone ? TONE_CLASS[row.tone] : 'text-text-2',
                row.num ? 'tabular-nums' : ''
              ]"
            >
              <Check v-if="row.tone === 'ok'" :size="12" :stroke-width="2.2" class="shrink-0" />
              <X v-else-if="row.tone === 'bad'" :size="12" :stroke-width="2" class="shrink-0" />
              <template v-for="(part, j) in row.parts" :key="j">
                <span
                  v-if="part.mono"
                  class="truncate font-mono text-[11px]"
                  :class="part.gone ? 'text-text-4 line-through' : ''"
                  :title="part.text"
                  >{{ part.text }}</span
                >
                <span
                  v-else-if="j > 0 && row.parts[j - 1]?.mono"
                  class="shrink-0 whitespace-nowrap"
                  >{{ part.text }}</span
                >
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
          </template>
        </div>

        <div
          v-if="failure"
          class="flex items-start gap-2.5 rounded border px-3 py-2.5 text-[12px] leading-[18px]"
          :class="NOTE_CLASS.error.box"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.8"
            class="mt-0.5 shrink-0"
            :class="NOTE_CLASS.error.icon"
          />
          <span>
            {{ failureText(failure) }}
            <span
              v-if="failureDetail(failure)"
              class="mt-1 block font-mono text-[11px] text-text-3"
              >{{ failureDetail(failure) }}</span
            >
          </span>
        </div>

        <div
          v-if="note"
          class="flex items-start gap-2.5 rounded border px-3 py-2.5 text-[12px] leading-[18px]"
          :class="NOTE_CLASS[note.tone].box"
        >
          <component
            :is="note.icon"
            :size="14"
            :stroke-width="1.8"
            class="mt-0.5 shrink-0"
            :class="NOTE_CLASS[note.tone].icon"
          />
          <span>{{ note.text }}</span>
        </div>

        <div class="overflow-hidden rounded border border-border">
          <div
            v-for="c in stack.containers"
            :key="c.id"
            class="grid grid-cols-[minmax(0,1fr)_90px_80px_150px] items-center gap-x-3 gap-y-1 border-t border-border px-3 py-[7px] text-[11.5px] first:border-t-0 @max-[540px]:grid-cols-[minmax(0,1fr)_auto_auto]"
          >
            <span class="truncate font-mono text-[11px] text-text-2" :title="c.name">{{
              c.name
            }}</span>
            <span :class="ctrStateText(c).cls">{{ ctrStateText(c).text }}</span>
            <span
              class="text-right font-mono text-[11px] tabular-nums"
              :class="c.running && c.memBytes !== null ? 'text-text-2' : 'text-text-4'"
              >{{
                c.running && c.memBytes !== null ? formatRam(c.memBytes) : t('containers.row.noRam')
              }}</span
            >
            <span
              v-if="c.ports.length"
              class="flex justify-end gap-1 @max-[540px]:col-span-full @max-[540px]:justify-start"
            >
              <span
                v-for="port in c.ports"
                :key="port"
                class="rounded-[3px] bg-surface-2 px-[5px] py-px font-mono text-[10.5px] tabular-nums text-text-3"
                >{{ port }}</span
              >
            </span>
          </div>
        </div>

        <div
          v-if="volumeRows.length"
          class="grid grid-cols-[150px_1fr] gap-x-3.5 gap-y-[7px] text-[11.5px]"
        >
          <template v-for="(row, i) in volumeRows" :key="`vol-${i}`">
            <span class="text-text-4">{{ row.key }}</span>
            <span class="flex min-w-0 items-center gap-1.5 text-text-2">
              <template v-for="(part, j) in row.parts" :key="j">
                <span v-if="part.mono" class="truncate font-mono text-[11px]" :title="part.text">{{
                  part.text
                }}</span>
                <span
                  v-else-if="j > 0 && row.parts[j - 1]?.mono"
                  class="shrink-0 whitespace-nowrap"
                  >{{ part.text }}</span
                >
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
          </template>
        </div>
      </div>

      <div v-if="tiers.length" class="flex shrink-0 gap-2.5 border-t border-border pt-3.5">
        <div v-for="tier in tiers" :key="tier.action" class="flex flex-col gap-[5px]">
          <button
            type="button"
            :data-testid="`containers-tier-${tier.action}`"
            :class="btnClass(tier.variant)"
            :disabled="tier.disabled || anyPending"
            @click="runTier(tier)"
          >
            <Loader2
              v-if="tierBusy(tier)"
              :size="11"
              :stroke-width="1.8"
              class="shrink-0 animate-spin"
            />
            <Square
              v-else-if="tier.action === 'stop'"
              :size="11"
              :stroke-width="1.8"
              class="shrink-0"
            />
            <Play
              v-else-if="tier.action === 'start'"
              :size="10"
              :stroke-width="1.8"
              class="shrink-0"
            />{{ tierLabel(tier) }}
          </button>
          <span
            class="text-[10.5px]"
            :class="tier.captionTone === 'warn' ? 'text-warning' : 'text-text-4'"
            >{{ tierCaption(tier) }}</span
          >
        </div>
      </div>
    </template>

    <!-- ── A Recent entry (a tombstone) ───────────────────────────────────── -->
    <template v-else-if="tombstone">
      <div class="scrollable @container flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div class="flex items-center gap-2.5">
          <History :size="15" :stroke-width="1.6" class="shrink-0 text-text-3" />
          <span class="truncate font-mono text-[13px] text-text">{{ tombName }}</span>
          <span class="whitespace-nowrap text-[11.5px] text-text-3">{{ tombWhen }}</span>
          <span v-if="tombNavs.length" class="ml-auto flex gap-1">
            <button
              v-for="nav in tombNavs"
              :key="nav.label"
              type="button"
              :class="btnClass('ghost', 'sm')"
              @click="nav.run()"
            >
              <ArrowUpRight :size="11" :stroke-width="1.8" class="shrink-0" />{{ nav.label }}
            </button>
          </span>
        </div>

        <div class="grid grid-cols-[150px_1fr] gap-x-3.5 gap-y-[7px] text-[11.5px]">
          <template v-for="(row, i) in tombEvidence" :key="`tev-${i}`">
            <span class="text-text-4">{{ row.key }}</span>
            <span
              class="flex min-w-0 items-center gap-1.5"
              :class="[
                row.tone ? TONE_CLASS[row.tone] : 'text-text-2',
                row.num ? 'tabular-nums' : ''
              ]"
            >
              <Check v-if="row.tone === 'ok'" :size="12" :stroke-width="2.2" class="shrink-0" />
              <X v-else-if="row.tone === 'bad'" :size="12" :stroke-width="2" class="shrink-0" />
              <template v-for="(part, j) in row.parts" :key="j">
                <span v-if="part.mono" class="truncate font-mono text-[11px]" :title="part.text">{{
                  part.text
                }}</span>
                <span
                  v-else-if="j > 0 && row.parts[j - 1]?.mono"
                  class="shrink-0 whitespace-nowrap"
                  >{{ part.text }}</span
                >
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
          </template>
        </div>

        <div
          v-if="tombNote"
          class="flex items-start gap-2.5 rounded border px-3 py-2.5 text-[12px] leading-[18px]"
          :class="NOTE_CLASS.quiet.box"
        >
          <Info
            :size="14"
            :stroke-width="1.8"
            class="mt-0.5 shrink-0"
            :class="NOTE_CLASS.quiet.icon"
          />
          <span>{{ tombNote }}</span>
        </div>

        <template v-if="tombstone.restoreHint">
          <div class="text-[10.5px] font-medium uppercase tracking-[0.07em] text-text-4">
            {{ restoreEyebrow }}
          </div>
          <div
            class="flex gap-2.5 rounded border border-border bg-surface py-[9px] pl-3 pr-2.5 font-mono text-[11.5px] text-text-2"
            :class="restoreWraps ? 'items-start break-all leading-[18px]' : 'items-center'"
          >
            {{ tombstone.restoreHint }}
            <button
              type="button"
              class="ml-auto"
              :class="ICON_BTN_CLASS"
              :title="t('containers.restore.copy')"
              :aria-label="t('containers.restore.copy')"
              @click="copyHint(tombstone.restoreHint)"
            >
              <Copy :size="11" :stroke-width="1.7" />
            </button>
          </div>
        </template>
      </div>

      <div
        v-if="tombstone.verb === 'stop'"
        class="flex shrink-0 gap-2.5 border-t border-border pt-3.5"
      >
        <div class="flex flex-col gap-[5px]">
          <button
            type="button"
            data-testid="containers-tier-start-recent"
            :class="btnClass('default')"
            :disabled="anyPending || startTargets.length === 0"
            @click="startFromRecent()"
          >
            <Loader2
              v-if="recentStarting"
              :size="10"
              :stroke-width="1.8"
              class="shrink-0 animate-spin"
            />
            <Play v-else :size="10" :stroke-width="1.8" class="shrink-0" />{{
              recentStarting
                ? t('containers.tier.starting')
                : isBulk
                  ? t('containers.tier.startAll', { n: tombstone.stacks.length })
                  : t('containers.tier.startStack')
            }}
          </button>
          <span class="text-[10.5px] text-text-4">{{
            t('containers.tier.caption.runsCommand')
          }}</span>
        </div>
      </div>
    </template>

    <ContainersRemoveDialog v-if="removeTarget" :stack="removeTarget" @close="onRemoveClose" />
  </div>
</template>
