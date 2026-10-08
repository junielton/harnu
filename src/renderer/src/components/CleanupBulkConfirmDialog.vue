<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import { useFocusTrap } from '../composables/useFocusTrap'
import type { GcOpinion } from '../../../main/gc/gc-wire'
import type { DialogRow, RemovalChip } from '../lib/gc-model'
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
const props = defineProps<{
  rows: DialogRow[]
  mode: 'ready' | 'review'
  /** The advisor's verdict on a row, when it was asked. Shown with its evidence; never decides. */
  opinionOf?: (id: string) => GcOpinion | null
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const { t, te } = useI18n()

const count = computed(() => props.rows.length)
const totalBytes = computed(() => props.rows.reduce((a, r) => a + r.bytes, 0))
const hasVolumeRow = computed(() => props.rows.some((r) => r.kind === 'volume'))
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
  return row.branch ?? ''
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
      class="anim-overlay-fade fixed inset-0 flex items-start justify-center overflow-y-auto pt-[72px]"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale mb-6 flex w-[min(720px,90vw)] flex-col rounded-lg border border-border-2 bg-surface text-text shadow-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-bulk-dialog-title"
        data-testid="bulk-dialog"
        :data-mode="mode"
        @mousedown.stop
      >
        <div class="px-5 pb-2 pt-4">
          <div
            id="cleanup-bulk-dialog-title"
            class="text-[15px] font-medium leading-[22px] text-text"
          >
            {{ title }}
          </div>
          <p class="m-0 mt-0.5 text-[12.5px] leading-[18px] text-text-2">
            {{
              mode === 'ready'
                ? t('cleanup.gc.confirm.subtitleReady')
                : t('cleanup.gc.confirm.subtitleReview')
            }}
          </p>
        </div>
        <div class="px-5 pb-3 text-[11px] leading-4 text-text-3" data-testid="bulk-summary">
          {{
            t('cleanup.gc.confirm.summary', count, {
              named: { n: count, size: formatBytes(totalBytes) }
            })
          }}
        </div>

        <div
          class="scrollable mx-5 flex max-h-[var(--fv-rail-list-max-h)] flex-col gap-1.5 overflow-y-auto pr-1"
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
              <span class="truncate text-[12.5px] leading-4 text-text">{{ rowTitle(row) }}</span>
              <span
                v-if="rowSub(row)"
                class="truncate font-mono text-[11px] leading-4 text-text-4"
                >{{ rowSub(row) }}</span
              >
              <template v-if="mode === 'review' && row.reasonCode">
                <span class="text-[11px] leading-4 text-text-3" data-testid="bulk-reason">{{
                  reasonText(row)
                }}</span>
                <span
                  v-if="row.reasonDetail && row.reasonDetail !== reasonText(row)"
                  class="truncate font-mono text-[11px] leading-4 text-text-4"
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
                  class="inline-flex items-center gap-[3px] rounded-[3px] border px-1.5 py-px text-[10.5px] leading-[14px]"
                  :class="CHIP_CLASS[chip]"
                  :data-chip="chip"
                  :title="t(`cleanup.gc.chip.title.${chip}`)"
                  >{{ t(`cleanup.gc.chip.${chip}`) }}</span
                >
              </span>
            </span>
            <span class="text-right text-[12.5px] leading-4 tabular-nums text-text">{{
              formatBytes(row.bytes)
            }}</span>
          </div>
        </div>

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
          <div class="min-w-0 text-[12px] leading-[18px] text-text-2">
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
              <span v-if="hasWorktreeRow" data-testid="bulk-volumes-kept">{{
                t('cleanup.gc.confirm.warnVolumesKept')
              }}</span>
              <template v-if="hasWorktreeRow">{{ t('cleanup.gc.confirm.warnRecover') }}</template>
            </p>
          </div>
        </div>

        <div class="mt-3 flex items-center gap-2 border-t border-border px-5 py-3">
          <span v-if="totalBytes > 0" class="mr-auto text-[12.5px] font-medium text-text">{{
            t('cleanup.gc.confirm.total', { size: formatBytes(totalBytes) })
          }}</span>
          <span v-else class="mr-auto" />
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
            data-testid="bulk-confirm"
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
