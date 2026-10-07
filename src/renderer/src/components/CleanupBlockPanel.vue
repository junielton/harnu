<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bookmark,
  Check,
  Copy,
  PackageMinus,
  PackagePlus,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-vue-next'
import type { GcBlock } from '../lib/gc-model'
import { stepProgress, type BlockJobState, type ItemFailure } from '../lib/gc-jobs'
import { formatBytes } from './system-monitor-format'
import { identText } from './cleanup-ident'
import {
  canDehydrate,
  canRehydrate,
  hydrationMarker,
  isIdleDehydratable,
  SKIP_REASON_KEYS,
  type HydrationOp
} from './cleanup-row'
import { reasonKey, stepKey } from './cleanup-gc-copy'
import Button from './ui/Button.vue'

/**
 * Docked detail panel of the Cleanup map (design.md "Workspace GC — unified Cleanup / Side panel").
 * Shows one block: size, composition, the one-sentence reason, what a removal takes with it, the
 * actions that are legal for this bucket and kind, and — for an item the last run could not clean —
 * what ran and what failed. It never decides anything: every action is an emit the screen confirms.
 */

const props = withDefaults(
  defineProps<{
    block: GcBlock
    state: BlockJobState | null
    failure: ItemFailure | null
    removeVolumes: boolean
    /** `ReaperPrefs.dehydrateIdleDays`: an Alive worktree offers Dehydrate only once idle this long. */
    dehydrateIdleDays?: number
    /** A dehydrate/rehydrate in flight for this worktree; it disables those two buttons. */
    hydrationBusy?: HydrationOp | null
  }>(),
  { dehydrateIdleDays: 7, hydrationBusy: null }
)

const emit = defineEmits<{
  close: []
  remove: [id: string]
  dehydrate: [id: string]
  rehydrate: [id: string]
  keep: [id: string]
  cleanNow: [id: string]
  retry: [id: string]
}>()

const { t } = useI18n()

const item = computed(() => props.block.bundle?.item ?? null)
const isVolume = computed(() => props.block.kind === 'volume')
const busy = computed(() => props.state === 'busy')
const locked = computed(() => busy.value || props.state === 'done')
const sizeText = computed(() => (props.block.hasBytes ? formatBytes(props.block.bytes) : '—'))

// ---- meta: hydration marker + what the dehydrate guards kept ---------------------------------

const marker = computed(() =>
  item.value ? hydrationMarker(item.value, props.hydrationBusy ?? undefined, t) : null
)

/** The meta line's `title`: every file a rehydrate changed and every path the guards kept. */
const metaTitle = computed(() => {
  const it = item.value
  if (!it) return ''
  const lines: string[] = []
  if (marker.value && marker.value.files.length > 0) {
    lines.push(t('cleanup.state.rehydrateChangedTitle', { files: marker.value.files.join(', ') }))
  }
  const kept = it.hydration?.skipped ?? []
  if (kept.length > 0) {
    const items = kept
      .map((s) => `${s.path} — ${t(`cleanup.dehydrateConfirm.skip.${SKIP_REASON_KEYS[s.reason]}`)}`)
      .join('; ')
    lines.push(t('cleanup.state.kept', { items }))
  }
  return lines.join('\n')
})

// ---- composition -------------------------------------------------------------------------------

const composition = computed(() => {
  const b = props.block
  if (isVolume.value || !b.hasBytes || b.bytes <= 0) return null
  const deps = Math.min(Math.max(b.depsBytes ?? 0, 0), b.bytes)
  return { deps, checkout: b.bytes - deps, depsPct: (deps / b.bytes) * 100 }
})

// ---- takes with it -----------------------------------------------------------------------------

const takes = computed<string[]>(() => {
  const b = props.block
  if (isVolume.value) return [t('cleanup.gc.panel.takes.volume', { names: b.name })]
  const out: string[] = []
  if (b.stackIds.length > 0)
    out.push(t('cleanup.gc.panel.takes.stack', { count: b.stackIds.length }, b.stackIds.length))
  if (props.removeVolumes && b.ownedVolumes.length > 0) {
    out.push(t('cleanup.gc.panel.takes.volume', { names: b.ownedVolumes.join(', ') }))
  }
  if ((b.depsBytes ?? 0) > 0) out.push(t('cleanup.gc.panel.takes.deps'))
  out.push(t('cleanup.gc.panel.takes.checkout'))
  if (b.branch) out.push(t('cleanup.gc.panel.takes.branch', { branch: b.branch }))
  return out
})
const takesVolumes = computed(
  () => isVolume.value || (props.removeVolumes && props.block.ownedVolumes.length > 0)
)

// ---- legal actions ------------------------------------------------------------------------------

const decide = computed(() => props.block.bucket === 'decide')
const corpse = computed(() => props.block.bucket === 'corpse')
const alive = computed(() => props.block.bucket === 'alive')
const hasFailure = computed(() => props.failure !== null)

const showRemove = computed(() => decide.value)
const showKeep = computed(() => decide.value && !isVolume.value)
const showAsk = computed(() => decide.value && !isVolume.value)
const showCleanNow = computed(() => corpse.value && !hasFailure.value)
const showRetry = computed(() => hasFailure.value && !isVolume.value)
const showDehydrate = computed(() => {
  const it = item.value
  if (!it || isVolume.value || corpse.value) return false
  if (alive.value) return isIdleDehydratable(it, props.dehydrateIdleDays)
  return canDehydrate(it)
})
const showRehydrate = computed(() => {
  const it = item.value
  return !!it && !isVolume.value && canRehydrate(it)
})
const hydrationDisabled = computed(() => locked.value || props.hydrationBusy !== null)

const dehydrateLabel = computed(() => {
  const it = item.value
  if (!it) return ''
  const what = identText(it)
  const h = it.hydration
  // The no-`setup` warning wins over the size: learn that Harnu cannot bring the folders back BEFORE.
  if (h && !h.canRehydrate) return t('cleanup.a11y.dehydrateNoSetup', { what })
  if (h && h.reclaimableBytes !== null) {
    return t('cleanup.a11y.dehydrateSize', { what, size: formatBytes(h.reclaimableBytes) })
  }
  return t('cleanup.a11y.dehydrate', { what })
})
const rehydrateLabel = computed(() =>
  item.value ? t('cleanup.a11y.rehydrate', { what: identText(item.value) }) : ''
)

// ---- failure: what ran, the raw error ------------------------------------------------------------

const steps = computed(() => (props.failure ? stepProgress(props.failure.step) : []))
const nothingRan = computed(
  () => steps.value.length > 0 && steps.value.every((s) => s.state === 'todo')
)

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copyError(): Promise<void> {
  const text = props.failure?.error ?? ''
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1500)
  } catch {
    // clipboard unavailable: the text is still selectable on screen
  }
}
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})

const reasonText = computed(() => t(reasonKey(props.block.reasonCode, corpse.value)))
const showDetail = computed(() => !corpse.value && !!props.block.reasonDetail)
</script>

<template>
  <aside
    class="flex w-[320px] max-w-full flex-col gap-3 rounded-lg border border-border-2 bg-surface p-4"
    :aria-label="block.name"
    data-testid="block-panel"
  >
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="break-all font-mono text-[13px] leading-5 text-text" data-testid="panel-name">
          {{ block.name }}
        </div>
        <div class="text-[11px] text-text-4" data-testid="panel-repo">
          <template v-if="isVolume">{{
            block.project
              ? t('cleanup.gc.panel.project', { project: block.project })
              : t('cleanup.gc.panel.projectUnknown')
          }}</template>
          <template v-else>{{ block.repoLabel }}</template>
        </div>
      </div>
      <button
        type="button"
        class="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
        :aria-label="t('cleanup.gc.panel.close')"
        :title="t('cleanup.gc.panel.close')"
        data-testid="panel-close"
        @click="emit('close')"
      >
        <X :size="14" :stroke-width="1.7" />
      </button>
    </div>

    <div class="text-[20px] font-medium leading-7 tracking-[-0.015em]" data-testid="panel-size">
      {{ sizeText }}
    </div>

    <p
      v-if="marker"
      class="-mt-1 text-[11px]"
      :class="marker.tone === 'warning' ? 'text-warning' : 'text-text-4'"
      :title="metaTitle || undefined"
      data-testid="panel-hydration"
    >
      {{ marker.text }}
    </p>
    <p v-else-if="metaTitle" class="sr-only" :title="metaTitle" data-testid="panel-meta">
      {{ metaTitle }}
    </p>

    <!-- composition: dependencies vs the rest of the checkout; volume bytes are not reported -->
    <div v-if="composition" data-testid="panel-composition">
      <div class="flex h-2 gap-0.5" role="img" :aria-label="t('cleanup.gc.panel.compositionLabel')">
        <span
          v-if="composition.deps > 0"
          class="rounded-sm bg-green"
          :style="{ flex: composition.depsPct }"
        />
        <span class="rounded-sm bg-border-2" :style="{ flex: 100 - composition.depsPct }" />
      </div>
      <ul class="mt-2 flex flex-col gap-1 text-[11px] leading-4 text-text-3">
        <li v-if="composition.deps > 0" class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-sm bg-green" />{{ t('cleanup.gc.panel.deps')
          }}<b class="ml-auto font-medium text-text-2">{{ formatBytes(composition.deps) }}</b>
        </li>
        <li class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-sm bg-border-2" />{{ t('cleanup.gc.panel.checkout')
          }}<b class="ml-auto font-medium text-text-2">{{ formatBytes(composition.checkout) }}</b>
        </li>
        <li
          v-if="block.ownedVolumes.length > 0"
          class="flex items-start gap-2"
          data-testid="panel-volumes"
        >
          <span class="mt-1 h-2 w-2 shrink-0 rounded-sm bg-warning" />
          <span>{{
            t('cleanup.gc.panel.volumesNoSize', { names: block.ownedVolumes.join(', ') })
          }}</span>
        </li>
      </ul>
    </div>

    <section class="flex flex-col gap-1 border-t border-border pt-3">
      <div class="text-[10.5px] font-medium uppercase tracking-[0.07em] text-text-4">
        {{ t('cleanup.gc.panel.whyTitle') }}
      </div>
      <p class="text-[13px] leading-5 text-text-2" data-testid="panel-reason">{{ reasonText }}</p>
      <p
        v-if="showDetail"
        class="break-words font-mono text-[11px] leading-4 text-text-4"
        data-testid="panel-reason-detail"
      >
        {{ block.reasonDetail }}
      </p>
      <p v-if="alive" class="text-[11px] leading-4 text-text-3" data-testid="panel-alive-note">
        {{ t('cleanup.gc.panel.aliveNote') }}
      </p>
      <p v-if="corpse" class="text-[11px] leading-4 text-text-3" data-testid="panel-corpse-note">
        {{ t('cleanup.gc.panel.corpseNote') }}
      </p>
    </section>

    <section v-if="!alive" class="flex flex-col gap-1 border-t border-border pt-3">
      <div class="text-[10.5px] font-medium uppercase tracking-[0.07em] text-text-4">
        {{ t('cleanup.gc.panel.takesTitle') }}
      </div>
      <ul
        class="flex flex-col gap-0.5 text-[12px] leading-[18px] text-text-2"
        data-testid="panel-takes"
      >
        <li v-for="line in takes" :key="line">{{ line }}</li>
      </ul>
      <p
        v-if="takesVolumes"
        class="flex items-start gap-1.5 text-[11px] leading-4 text-warning"
        data-testid="panel-volume-warning"
      >
        <TriangleAlert :size="12" :stroke-width="1.8" class="mt-px shrink-0" />
        {{ t('cleanup.gc.panel.volumesCannotRestore') }}
      </p>
    </section>

    <!-- failure: what ran, the raw error, the refusal note -->
    <section
      v-if="failure"
      class="flex flex-col gap-2 border-t border-red-line pt-3"
      data-testid="panel-failure"
    >
      <p
        v-if="failure.changedSinceConfirm"
        class="flex items-start gap-1.5 text-[12px] leading-[18px] text-warning"
        data-testid="panel-changed-note"
      >
        <TriangleAlert :size="13" :stroke-width="1.8" class="mt-0.5 shrink-0" />
        {{ t('cleanup.gc.panel.changedSinceConfirm') }}
      </p>
      <template v-if="steps.length > 0">
        <div class="text-[10.5px] font-medium uppercase tracking-[0.07em] text-text-4">
          {{ t('cleanup.gc.panel.ranTitle') }}
        </div>
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="panel-steps">
          <li
            v-for="s in steps"
            :key="s.step"
            class="flex items-center gap-2 text-[12px] leading-[18px]"
            :class="{
              'text-text-2': s.state === 'ok',
              'text-red': s.state === 'failed',
              'text-text-3': s.state === 'todo'
            }"
            :data-step="s.step"
            :data-state="s.state"
          >
            <span
              class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px]"
              :class="{
                'border-green bg-green text-bg': s.state === 'ok',
                'border-red bg-red text-bg': s.state === 'failed',
                'border-dashed border-border-2': s.state === 'todo'
              }"
              aria-hidden="true"
            >
              <Check v-if="s.state === 'ok'" :size="9" :stroke-width="3" />
              <X v-else-if="s.state === 'failed'" :size="9" :stroke-width="3" />
            </span>
            {{ t(stepKey(s.step)) }}
            <span class="sr-only">— {{ t(`cleanup.gc.panel.stepState.${s.state}`) }}</span>
          </li>
        </ul>
        <p
          v-if="nothingRan"
          class="text-[11px] leading-4 text-text-3"
          data-testid="panel-nothing-ran"
        >
          {{ t('cleanup.gc.panel.nothingRan') }}
        </p>
      </template>
      <div v-if="failure.error && !failure.changedSinceConfirm" class="flex items-start gap-2">
        <p
          class="line-clamp-2 min-w-0 flex-1 break-words font-mono text-[11px] leading-4 text-text-3"
          :title="failure.error"
          data-testid="panel-error"
        >
          {{ failure.error }}
        </p>
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-bg px-2 py-[3px] text-[10.5px] text-text-3 transition hover:border-border-2 hover:text-text-2"
          :aria-label="t('cleanup.gc.panel.copyError')"
          data-testid="panel-copy-error"
          @click="copyError"
        >
          <Copy :size="10" :stroke-width="1.7" />
          {{ copied ? t('cleanup.gc.panel.copied') : t('cleanup.gc.panel.copyError') }}
        </button>
      </div>
    </section>

    <p v-if="busy" class="text-[12px] text-accent" data-testid="panel-busy">
      {{ t('cleanup.gc.panel.cleaning') }}
    </p>

    <div class="flex flex-col gap-2 border-t border-border pt-3" data-testid="panel-actions">
      <Button
        v-if="showCleanNow"
        variant="success"
        class="!justify-start"
        :disabled="locked"
        data-testid="panel-clean-now"
        @click="emit('cleanNow', block.id)"
      >
        <Trash2 :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.cleanNow') }}
      </Button>

      <Button
        v-if="showRetry"
        variant="soft"
        class="!justify-start"
        :disabled="locked"
        data-testid="panel-retry"
        @click="emit('retry', block.id)"
      >
        <RotateCcw :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.retry') }}
      </Button>

      <Button
        v-if="showRemove"
        variant="danger"
        class="!justify-start"
        :disabled="locked"
        data-testid="panel-remove"
        @click="emit('remove', block.id)"
      >
        <Trash2 :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.remove') }}
        <kbd class="ml-auto font-mono text-[10.5px] text-text-3">R</kbd>
      </Button>

      <Button
        v-if="showDehydrate"
        variant="soft"
        class="!justify-start"
        :disabled="hydrationDisabled"
        :aria-label="dehydrateLabel"
        :title="dehydrateLabel"
        data-testid="panel-dehydrate"
        @click="emit('dehydrate', block.id)"
      >
        <PackageMinus :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.dehydrate') }}
        <kbd class="ml-auto font-mono text-[10.5px] text-text-3">D</kbd>
      </Button>

      <Button
        v-if="showRehydrate"
        variant="soft"
        class="!justify-start"
        :disabled="hydrationDisabled"
        :aria-label="rehydrateLabel"
        :title="rehydrateLabel"
        data-testid="panel-rehydrate"
        @click="emit('rehydrate', block.id)"
      >
        <PackagePlus :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.rehydrate') }}
      </Button>

      <Button
        v-if="showKeep"
        variant="ghost"
        class="!justify-start"
        :disabled="locked"
        data-testid="panel-keep"
        @click="emit('keep', block.id)"
      >
        <Bookmark :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.keep') }}
        <kbd class="ml-auto font-mono text-[10.5px] text-text-3">K</kbd>
      </Button>

      <span v-if="showAsk" :title="t('cleanup.gc.panel.askSoon')" class="block">
        <Button
          variant="soft"
          class="w-full !justify-start"
          :disabled="true"
          :title="t('cleanup.gc.panel.askSoon')"
          data-testid="panel-ask"
        >
          <Sparkles :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.ask') }}
          <kbd class="ml-auto font-mono text-[10.5px] text-text-3">A</kbd>
        </Button>
      </span>
    </div>
  </aside>
</template>
