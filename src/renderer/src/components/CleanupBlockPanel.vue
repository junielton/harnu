<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bookmark,
  Copy,
  PackageMinus,
  PackagePlus,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-vue-next'
import type { GcOpinion } from '../../../main/gc/gc-wire'
import type { GcBlock } from '../lib/gc-model'
import { haltOf, type BlockJobState, type ItemFailure } from '../lib/gc-jobs'
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
import { reasonKey, refusalKey, stepKey } from './cleanup-gc-copy'
import { resumeHint } from '../lib/gc-resume'
import type { GcStep } from '../../../main/gc/pipeline-core'
import Button from './ui/Button.vue'
import CleanupOpinionChip from './CleanupOpinionChip.vue'

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
    /** `ReaperPrefs.dehydrateIdleDays`: an In use worktree offers Dehydrate only once idle this long. */
    dehydrateIdleDays?: number
    /** A dehydrate/rehydrate in flight for this worktree; it disables those two buttons. */
    hydrationBusy?: HydrationOp | null
    /** The advisor's verdict on this item, when it was asked. */
    opinion?: GcOpinion | null
    /** A request for this item's opinion is in flight. */
    asking?: boolean
  }>(),
  { dehydrateIdleDays: 7, hydrationBusy: null, opinion: null, asking: false }
)

const emit = defineEmits<{
  close: []
  remove: [id: string]
  dehydrate: [id: string]
  rehydrate: [id: string]
  keep: [id: string]
  ask: [id: string]
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
  if ((b.depsBytes ?? 0) > 0) out.push(t('cleanup.gc.panel.takes.deps'))
  out.push(t('cleanup.gc.panel.takes.checkout'))
  if (b.branch) out.push(t('cleanup.gc.panel.takes.branch', { branch: b.branch }))
  return out
})
/** Only an orphan volume's own removal loses data; a worktree's volumes are kept, never removed with it. */
const takesVolumes = computed(() => isVolume.value)
const keptVolumes = computed(() => !isVolume.value && props.block.ownedVolumes.length > 0)

// ---- legal actions ------------------------------------------------------------------------------

const review = computed(() => props.block.bucket === 'review')
const ready = computed(() => props.block.bucket === 'ready')
const inUse = computed(() => props.block.bucket === 'in-use')
const hasFailure = computed(() => props.failure !== null)

/**
 * Main always refuses a worktree that holds another one (removing it would trash the inner one too), one it
 * could not look inside, and one git has locked. `locked` is compared by string: its main-side type has not reached this branch yet.
 */
const REMOVE_REFUSED: Readonly<Record<string, string>> = {
  'nested-worktree': 'cleanup.gc.panel.removeBlocked',
  'check-failed': 'cleanup.gc.panel.removeUnchecked',
  locked: 'cleanup.gc.panel.removeLocked'
}
const removeBlockedKey = computed(() =>
  review.value ? (REMOVE_REFUSED[props.block.reasonCode ?? ''] ?? null) : null
)
const removeBlocked = computed(() => removeBlockedKey.value !== null)
/**
 * A halted clean whose folder is already gone: Retry and Remove cannot finish the git steps (the engine
 * refuses a folder that is not there), so the panel says which step stopped and the commands instead.
 */
const resume = computed(() => resumeHint(props.block))
const showRemove = computed(() => review.value && !removeBlocked.value && !resume.value)
const showKeep = computed(() => review.value && !isVolume.value)
const showAsk = computed(() => review.value)
const showOpinion = computed(() => review.value && (props.asking || props.opinion !== null))
const showCleanNow = computed(() => ready.value && !hasFailure.value)
/** Retry re-opens the confirm for the item's CURRENT bucket, so an in-use item has nothing to retry. */
const showRetry = computed(() => hasFailure.value && !inUse.value && !resume.value)
const showDehydrate = computed(() => {
  const it = item.value
  if (!it || isVolume.value || ready.value) return false
  if (inUse.value) return isIdleDehydratable(it, props.dehydrateIdleDays)
  return canDehydrate(it)
})
const showRehydrate = computed(() => {
  const it = item.value
  return !!it && !isVolume.value && canRehydrate(it)
})
const hydrationDisabled = computed(() => locked.value || props.hydrationBusy !== null)

// ---- shortcuts: R remove · D dehydrate · K keep · A ask ---------------------------------------------

/** Typing in a field, a held modifier or an open dialog owns the keyboard, not the panel. */
function shortcutsBlocked(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true
  const el = e.target as HTMLElement | null
  if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return true
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

/** Each letter acts only when its button is shown AND enabled. */
function onShortcut(e: KeyboardEvent): void {
  if (shortcutsBlocked(e)) return
  const id = props.block.id
  switch (e.key.toLowerCase()) {
    case 'r':
      if (showRemove.value && !locked.value) emit('remove', id)
      break
    case 'k':
      if (showKeep.value && !locked.value) emit('keep', id)
      break
    case 'd':
      if (showDehydrate.value && !hydrationDisabled.value) emit('dehydrate', id)
      break
    case 'a':
      if (showAsk.value && !locked.value && !props.asking) emit('ask', id)
      break
  }
}
onMounted(() => window.addEventListener('keydown', onShortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', onShortcut))

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

// ---- failure: what happened, the raw error ------------------------------------------------------------

/** Where it stopped, from what the engine reported — never a reconstructed step history. */
const halt = computed(() => (props.failure ? haltOf(props.failure) : null))
const nothingChanged = computed(
  () => halt.value?.kind === 'refused' || halt.value?.kind === 'unchanged'
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

const reasonText = computed(() => t(reasonKey(props.block.reasonCode, ready.value)))
const showDetail = computed(() => !ready.value && !!props.block.reasonDetail)
</script>

<template>
  <aside
    class="flex w-(--gc-panel-w) max-w-full flex-col gap-3 rounded-lg border border-border-2 bg-surface p-4"
    :aria-label="block.name"
    data-testid="block-panel"
  >
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="break-all font-mono text-body text-text" data-testid="panel-name">
          {{ block.name }}
        </div>
        <div class="text-caption text-text-4" data-testid="panel-repo">
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
        class="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
        :aria-label="t('cleanup.gc.panel.close')"
        :title="t('cleanup.gc.panel.close')"
        data-testid="panel-close"
        @click="emit('close')"
      >
        <X :size="14" :stroke-width="1.7" />
      </button>
    </div>

    <div class="text-title font-medium leading-7 tracking-title" data-testid="panel-size">
      {{ sizeText }}
    </div>

    <p
      v-if="marker"
      class="-mt-1 text-caption"
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
      <ul class="mt-2 flex flex-col gap-1 text-caption text-text-3">
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
      <div class="eyebrow text-text-4">
        {{ t('cleanup.gc.panel.whyTitle') }}
      </div>
      <p class="text-body leading-5 text-text-2" data-testid="panel-reason">{{ reasonText }}</p>
      <p
        v-if="showDetail"
        class="break-words font-mono text-caption text-text-4"
        data-testid="panel-reason-detail"
      >
        {{ block.reasonDetail }}
      </p>
      <div
        v-if="resume"
        class="flex flex-col gap-1.5 rounded-sm border border-border-2 bg-surface-2 p-2"
        data-testid="panel-resume"
      >
        <p class="text-caption leading-4 text-text-2">
          {{ t('cleanup.gc.panel.resumeBody', { step: t(stepKey(resume.step as GcStep)) }) }}
        </p>
        <code
          v-for="cmd in resume.commands"
          :key="cmd"
          class="select-all break-all font-mono text-caption text-text"
          data-testid="panel-resume-command"
          >{{ cmd }}</code
        >
        <p v-if="resume.archived" class="text-caption leading-4 text-text-3">
          {{ t('cleanup.gc.panel.resumeArchive') }}
        </p>
      </div>
      <p v-if="inUse" class="text-caption leading-4 text-text-3" data-testid="panel-in-use-note">
        {{ t('cleanup.gc.panel.inUseNote') }}
      </p>
      <p v-if="ready" class="text-caption leading-4 text-text-3" data-testid="panel-ready-note">
        {{ t('cleanup.gc.panel.readyNote') }}
      </p>
    </section>

    <section
      v-if="showOpinion"
      class="flex flex-col gap-1.5 border-t border-border pt-3"
      data-testid="panel-opinion"
    >
      <div class="eyebrow text-text-4">
        {{ t('cleanup.gc.panel.opinionTitle') }}
      </div>
      <CleanupOpinionChip :opinion="opinion" :pending="asking" />
      <template v-if="opinion && !asking">
        <p class="text-body text-text-2" data-testid="panel-opinion-reason">
          {{ opinion.reason }}
        </p>
        <p class="text-caption text-text-3" data-testid="panel-opinion-evidence">
          {{ t('cleanup.gc.opinion.evidence') }}: {{ opinion.evidence }}
        </p>
      </template>
    </section>

    <section v-if="!inUse" class="flex flex-col gap-1 border-t border-border pt-3">
      <div class="eyebrow text-text-4">
        {{ t('cleanup.gc.panel.takesTitle') }}
      </div>
      <ul class="flex flex-col gap-0.5 text-ui text-text-2" data-testid="panel-takes">
        <li v-for="line in takes" :key="line">{{ line }}</li>
      </ul>
      <p
        v-if="takesVolumes"
        class="flex items-start gap-1.5 text-caption text-warning"
        data-testid="panel-volume-warning"
      >
        <TriangleAlert :size="12" :stroke-width="1.8" class="mt-px shrink-0" />
        {{ t('cleanup.gc.panel.volumesCannotRestore') }}
      </p>
      <p
        v-if="keptVolumes"
        class="text-caption leading-4 text-text-3"
        data-testid="panel-volumes-kept"
      >
        {{ t('cleanup.gc.panel.volumesKept', { names: block.ownedVolumes.join(', ') }) }}
      </p>
    </section>

    <!-- failure: what happened — the step it stopped at and why; never a reconstructed history -->
    <section
      v-if="failure"
      class="flex flex-col gap-2 border-t border-red-line pt-3"
      data-testid="panel-failure"
    >
      <p
        v-if="failure.refusal"
        class="flex items-start gap-1.5 text-ui text-warning"
        data-testid="panel-refusal"
        :data-refusal="failure.refusal"
      >
        <TriangleAlert :size="13" :stroke-width="1.8" class="mt-0.5 shrink-0" />
        {{ t(refusalKey(failure.refusal)) }}
      </p>
      <div class="eyebrow text-text-4">{{ t('cleanup.gc.panel.happenedTitle') }}</div>
      <p
        v-if="halt?.kind === 'stopped'"
        class="text-body text-text-2"
        data-testid="panel-halt"
        :data-step="halt.step"
      >
        {{ t('cleanup.gc.panel.stoppedAt', { step: t(stepKey(halt.step)) }) }}
      </p>
      <p v-if="nothingChanged" class="text-caption text-text-3" data-testid="panel-nothing-changed">
        {{ t('cleanup.gc.panel.nothingChanged') }}
      </p>
      <!-- An error that is not a known refusal never shows as text: a plain sentence says what happened, and
           the raw text travels only with "Copy error". -->
      <div v-if="failure.error && !failure.refusal" class="flex items-start gap-2">
        <p class="min-w-0 flex-1 text-ui text-text-2" data-testid="panel-generic">
          {{ t('cleanup.gc.panel.genericStop') }}
        </p>
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border bg-bg px-2 py-0.75 text-eyebrow text-text-3 transition hover:border-border-2 hover:text-text-2"
          :aria-label="t('cleanup.gc.panel.copyError')"
          data-testid="panel-copy-error"
          @click="copyError"
        >
          <Copy :size="10" :stroke-width="1.7" />
          {{ copied ? t('cleanup.gc.panel.copied') : t('cleanup.gc.panel.copyError') }}
        </button>
      </div>
    </section>

    <p v-if="busy" class="text-ui text-accent" data-testid="panel-busy">
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

      <p v-if="removeBlocked" class="text-caption text-text-3" data-testid="panel-remove-blocked">
        {{ removeBlockedKey ? t(removeBlockedKey, { scanNow: t('cleanup.scanNow') }) : '' }}
      </p>

      <Button
        v-if="showRemove"
        variant="danger"
        class="!justify-start"
        :disabled="locked"
        data-testid="panel-remove"
        @click="emit('remove', block.id)"
      >
        <Trash2 :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.remove') }}
        <kbd class="ml-auto font-mono text-eyebrow text-text-3">R</kbd>
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
        <kbd class="ml-auto font-mono text-eyebrow text-text-3">D</kbd>
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
        <kbd class="ml-auto font-mono text-eyebrow text-text-3">K</kbd>
      </Button>

      <Button
        v-if="showAsk"
        variant="soft"
        class="!justify-start"
        :disabled="locked || asking"
        :title="t('cleanup.gc.opinion.hint')"
        data-testid="panel-ask"
        @click="emit('ask', block.id)"
      >
        <Sparkles :size="13" :stroke-width="1.7" />{{ t('cleanup.gc.panel.ask') }}
        <kbd class="ml-auto font-mono text-eyebrow text-text-3">A</kbd>
      </Button>
    </div>
  </aside>
</template>
