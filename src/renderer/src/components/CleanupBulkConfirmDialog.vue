<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CircleCheck,
  CircleHelp,
  Container,
  Database,
  Folder,
  GitBranch,
  PackageMinus,
  Recycle,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon
} from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import { useFocusTrap } from '../composables/useFocusTrap'
import type { GcOpinion } from '../../../main/gc/gc-wire'
import { dialogBreakdown, type DialogRow, type RefusedRow, type RemovalChip } from '../lib/gc-model'
import { removalKey } from './cleanup-gc-copy'
import CleanupOpinionChip from './CleanupOpinionChip.vue'

/**
 * The one confirm of the Cleanup screen (design.md "Workspace GC — unified Cleanup / Bulk-clean and
 * remove-selected dialog"). `ready` is the hero's bulk clean over proven ready; `review` is
 * Remove selected over Needs review items, which can include code that exists nowhere else but an archive
 * ref — so its confirm is Danger and its warning is stronger.
 *
 * It lists what the operator is about to remove and nothing else: the parent builds `rows` once,
 * at open, from the same model it later builds the `gc:clean` payload from, so what is read is what
 * is sent. Focus starts on Cancel — never on the confirm — and Enter only activates what has focus.
 */
const props = withDefaults(
  defineProps<{
    rows: DialogRow[]
    /** Items main would refuse, left out of `rows`, the count and the request: listed apart, with why. */
    refused?: RefusedRow[]
    mode: 'ready' | 'review'
    /** The facts behind the open dialog moved since it opened: confirm stays disabled until it is reopened. */
    stale?: boolean
    /** The advisor's verdict on a row, when it was asked. Shown with its evidence; never decides. */
    opinionOf?: (id: string) => GcOpinion | null
  }>(),
  { stale: false, refused: () => [] }
)
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const { t, te } = useI18n()

const count = computed(() => props.rows.length)
const totalBytes = computed(() => props.rows.reduce((a, r) => a + r.bytes, 0))
const hasVolumeRow = computed(() => props.rows.some((r) => r.kind === 'volume'))
/** One line saying what the whole clean does; a part that is zero is left out (volumes only for orphan rows). */
const breakdown = computed(() => {
  const b = dialogBreakdown(props.rows)
  const parts: string[] = []
  if (b.stacks > 0)
    parts.push(t('cleanup.gc.confirm.breakdown.stacks', b.stacks, { named: { n: b.stacks } }))
  if (b.deps > 0)
    parts.push(t('cleanup.gc.confirm.breakdown.deps', b.deps, { named: { n: b.deps } }))
  if (b.worktrees > 0)
    parts.push(
      t('cleanup.gc.confirm.breakdown.worktrees', b.worktrees, { named: { n: b.worktrees } })
    )
  if (b.volumes > 0)
    parts.push(t('cleanup.gc.confirm.breakdown.volumes', b.volumes, { named: { n: b.volumes } }))
  return parts.join(' · ')
})
const totalText = computed(() =>
  t(props.mode === 'ready' ? 'cleanup.gc.confirm.totalReady' : 'cleanup.gc.confirm.totalSelected', {
    n: count.value,
    size: formatBytes(totalBytes.value)
  })
)
const riskCount = computed(() => props.rows.filter((r) => r.risk).length)
/** A worktree's volumes are never removed with it (they become orphan volumes, reviewed one by one). */
const hasWorktreeRow = computed(() => props.rows.some((r) => r.kind === 'worktree'))

const title = computed(() => {
  if (props.mode === 'ready') {
    return t('cleanup.gc.confirm.titleReady', count.value, { named: { n: count.value } })
  }
  const key = hasVolumeRow.value ? 'titleItems' : 'titleWorktrees'
  return t(`cleanup.gc.confirm.${key}`, count.value, { named: { n: count.value } })
})
const confirmLabel = computed(() => {
  if (props.mode === 'ready') {
    return t('cleanup.gc.confirm.confirmReady', count.value, { named: { n: count.value } })
  }
  const key = hasVolumeRow.value ? 'confirmItems' : 'confirmWorktrees'
  return t(`cleanup.gc.confirm.${key}`, count.value, { named: { n: count.value } })
})

/** The engine's reason code, translated; its English sentence is the fallback for a code we lack. */
function reasonText(row: DialogRow): string {
  if (!row.reasonCode) return ''
  const key = `cleanup.gc.reason.${row.reasonCode}`
  return te(key) ? t(key) : (row.reasonDetail ?? '')
}

function refusedTitle(row: RefusedRow): string {
  return row.kind === 'volume'
    ? t('cleanup.gc.confirm.volumeRow', { name: row.name })
    : row.repo
      ? t('cleanup.gc.confirm.worktreeRow', { repo: row.repo, name: row.name })
      : row.name
}

function rowTitle(row: DialogRow): string {
  return row.kind === 'volume'
    ? t('cleanup.gc.confirm.volumeRow', { name: row.name })
    : row.repo
      ? t('cleanup.gc.confirm.worktreeRow', { repo: row.repo, name: row.name })
      : row.name
}

function rowSub(row: DialogRow): string {
  if (row.kind === 'volume') {
    return row.project
      ? t('cleanup.gc.confirm.volumeProject', { project: row.project })
      : t('cleanup.gc.confirm.noWorktree')
  }
  return row.branch ? t('cleanup.gc.confirm.branchSub', { branch: row.branch }) : ''
}

const CHIP_ICON: Record<RemovalChip, LucideIcon> = {
  stack: Container,
  volume: Database,
  deps: PackageMinus,
  checkout: Folder,
  branch: GitBranch
}

const CHIP_CLASS: Record<RemovalChip, string> = {
  stack: 'border-border bg-surface text-text-3',
  volume: 'border-warning-line bg-warning-soft text-warning',
  deps: 'border-border bg-surface text-text-3',
  checkout: 'border-border bg-surface text-text-3',
  branch: 'border-border bg-surface text-text-3'
}

// ---- focus, keyboard ---------------------------------------------------------------------------
const dialogRef = ref<HTMLElement | null>(null)
const cancelEl = ref<HTMLElement | null>(null)
function setCancel(c: Element | ComponentPublicInstance | null): void {
  cancelEl.value = c ? ((c as ComponentPublicInstance).$el ?? (c as Element)) : null
}
useFocusTrap({ active: computed(() => true), containerRef: dialogRef, initialFocusRef: cancelEl })

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // Esc closes the dialog only, never the takeover behind it.
    e.stopPropagation()
    emit('cancel')
  }
}
window.addEventListener('keydown', onKeydown, true)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) emit('cancel')
}
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 flex items-start justify-center overflow-y-auto pt-18"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale mb-6 flex w-(--gc-dialog-w) flex-col rounded-lg border border-border-2 bg-surface text-text shadow-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-bulk-dialog-title"
        data-testid="bulk-dialog"
        :data-mode="mode"
        @mousedown.stop
      >
        <div class="flex items-start gap-3 px-5 pb-2 pt-4">
          <div class="min-w-0 flex-1">
            <div id="cleanup-bulk-dialog-title" class="text-subtitle font-medium text-text">
              {{ title }}
            </div>
            <p class="m-0 mt-0.5 text-ui text-text-2">
              {{
                mode === 'ready'
                  ? t('cleanup.gc.confirm.subtitleReady')
                  : t('cleanup.gc.confirm.subtitleReview')
              }}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            :aria-label="t('cleanup.gc.confirm.close')"
            :title="t('cleanup.gc.confirm.close')"
            data-testid="bulk-close"
            @click="emit('cancel')"
          >
            <X :size="14" :stroke-width="1.7" />
          </Button>
        </div>
        <div class="px-5 pb-3 text-caption tabular-nums text-text-3" data-testid="bulk-breakdown">
          {{ breakdown }}
        </div>

        <div
          class="scrollable mx-5 flex max-h-(--fv-rail-list-max-h) flex-col gap-1.5 overflow-y-auto pr-1"
          tabindex="0"
          role="list"
          :aria-label="t('cleanup.gc.confirm.listLabel')"
          data-testid="bulk-list"
        >
          <div
            v-for="row in rows"
            :key="row.id"
            role="listitem"
            class="grid shrink-0 grid-cols-[20px_1fr_64px] items-start gap-3 rounded-sm border bg-surface-2 px-2.5 py-2"
            :class="row.risk ? 'border-warning-line' : 'border-border'"
            data-testid="bulk-row"
            :data-risk="row.risk ? 'true' : 'false'"
          >
            <span
              class="mt-px inline-flex"
              :class="row.risk || mode === 'review' ? 'text-warning' : 'text-green'"
            >
              <TriangleAlert
                v-if="row.risk"
                :size="14"
                :stroke-width="1.6"
                :aria-label="t('cleanup.gc.confirm.riskMarker')"
                role="img"
              />
              <CircleHelp
                v-else-if="mode === 'review'"
                :size="14"
                :stroke-width="1.6"
                aria-hidden="true"
              />
              <CircleCheck v-else :size="14" :stroke-width="1.6" aria-hidden="true" />
            </span>
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate font-mono text-ui text-text" data-testid="bulk-row-title">{{
                rowTitle(row)
              }}</span>
              <span
                v-if="rowSub(row)"
                class="truncate font-mono text-caption text-text-4"
                data-testid="bulk-row-sub"
                >{{ rowSub(row) }}</span
              >
              <template v-if="mode === 'review' && row.reasonCode">
                <span class="text-caption leading-4 text-text-3" data-testid="bulk-reason">{{
                  reasonText(row)
                }}</span>
                <span
                  v-if="row.reasonDetail && row.reasonDetail !== reasonText(row)"
                  class="truncate font-mono text-caption text-text-4"
                  >{{ row.reasonDetail }}</span
                >
              </template>
              <CleanupOpinionChip
                v-if="mode === 'review' && opinionOf?.(row.id)"
                :opinion="opinionOf(row.id)"
                :pending="false"
                show-evidence
              />
              <span class="mt-1 flex flex-wrap gap-1">
                <span
                  v-for="chip in row.chips"
                  :key="chip"
                  class="inline-flex items-center gap-0.75 rounded-xs border px-1.5 py-px text-eyebrow"
                  :class="CHIP_CLASS[chip]"
                  :data-chip="chip"
                  :title="t(`cleanup.gc.chip.title.${chip}`)"
                  ><component
                    :is="CHIP_ICON[chip]"
                    :size="10"
                    :stroke-width="1.8"
                    aria-hidden="true"
                  />{{ t(`cleanup.gc.chip.${chip}`) }}</span
                >
              </span>
            </span>
            <span class="text-right text-ui leading-4 tabular-nums text-text">{{
              formatBytes(row.bytes)
            }}</span>
          </div>
        </div>

        <section
          v-if="refused.length > 0"
          class="mx-5 mt-3 flex flex-col gap-1.5 rounded-sm border border-border bg-bg px-3 py-2.5"
          data-testid="bulk-refused"
        >
          <div class="flex items-baseline gap-2">
            <span class="eyebrow text-text-3" data-testid="bulk-refused-title">{{
              t('cleanup.gc.confirm.refusedTitle', { n: refused.length })
            }}</span>
            <span class="text-caption text-text-4">{{ t('cleanup.gc.confirm.refusedSub') }}</span>
          </div>
          <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
            <li
              v-for="row in refused"
              :key="row.id"
              class="flex flex-col gap-0.5"
              data-testid="bulk-refused-row"
              :data-refusal="row.refusal"
            >
              <span class="truncate font-mono text-ui text-text-2">{{ refusedTitle(row) }}</span>
              <span class="text-caption leading-4 text-text-3" data-testid="bulk-refused-reason">{{
                t(removalKey(row.refusal))
              }}</span>
              <code
                v-if="row.hint"
                class="select-all break-all font-mono text-caption text-text-2"
                data-testid="bulk-refused-hint"
                >{{ row.hint }}</code
              >
            </li>
          </ul>
        </section>

        <div
          class="mx-5 mt-3 flex items-start gap-2.5 rounded-sm border border-warning-line bg-warning-soft px-3 py-2.5"
          data-testid="bulk-warning"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0 text-warning"
            aria-hidden="true"
          />
          <div class="min-w-0 text-ui text-text-2">
            <p v-if="mode === 'review' && riskCount > 0" class="m-0 mb-1" data-testid="bulk-risk">
              <b class="font-semibold text-warning">{{
                t('cleanup.gc.confirm.warnRisk', riskCount, { named: { n: riskCount } })
              }}</b>
            </p>
            <p class="m-0">
              <b
                v-if="hasVolumeRow"
                class="font-semibold text-warning"
                data-testid="bulk-volumes-lost"
                >{{ t('cleanup.gc.confirm.warnVolumesLost') }}</b
              >
              <template v-if="hasVolumeRow">{{ ' ' }}</template>
              <span v-if="hasWorktreeRow" data-testid="bulk-volumes-kept">{{
                t('cleanup.gc.confirm.warnVolumesKept')
              }}</span>
              <template v-if="hasWorktreeRow"
                >{{ ' ' }}{{ t('cleanup.gc.confirm.warnRecover') }}</template
              >
            </p>
          </div>
        </div>

        <p
          v-if="stale"
          class="mx-5 mt-3 flex items-start gap-2 text-ui text-warning"
          role="alert"
          data-testid="bulk-stale"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          {{ t('cleanup.gc.confirm.changed') }}
        </p>

        <div class="mt-3 flex items-center gap-2 border-t border-border px-5 py-3">
          <span
            class="mr-auto text-ui font-medium tabular-nums text-text"
            data-testid="bulk-total"
            >{{ totalText }}</span
          >
          <Button
            :ref="setCancel"
            variant="ghost"
            data-testid="bulk-cancel"
            @click="emit('cancel')"
          >
            {{ t('cleanup.gc.confirm.cancel') }}
          </Button>
          <Button
            :variant="mode === 'ready' ? 'success' : 'danger'"
            :disabled="stale"
            data-testid="bulk-confirm"
            @click="!stale && emit('confirm')"
          >
            <Recycle v-if="mode === 'ready'" :size="14" :stroke-width="1.6" class="shrink-0" />
            <Trash2 v-else :size="14" :stroke-width="1.6" class="shrink-0" />
            {{ confirmLabel }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
