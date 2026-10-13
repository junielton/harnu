<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { Archive, Trash2, TriangleAlert, X } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import { relativeTime } from '../composables/useRelativeTime'
import { useFocusTrap } from '../composables/useFocusTrap'
import type { ArchiveEntry, TrashListEntry } from '../../../main/gc/gc-wire'

/**
 * The confirm of what Cleanup deletes from its own exhaust (design.md "Archives card"): the archives
 * the operator picked, "Run git gc", or "Empty what Harnu moved to the trash". The archive mode LISTS
 * what will go, so what is read is what is sent. Same rules as every Cleanup dialog: Esc and Cancel
 * close, focus starts on Cancel (never the confirm), Tab stays inside.
 */
const props = defineProps<{
  mode: 'delete' | 'gc' | 'trash'
  /** `delete`: the archives listed. */
  entries?: ArchiveEntry[]
  /** `delete` and `gc`: the repo's short name. */
  repo?: string
  /** `trash`: the entries listed, which are exactly the ones deleted. */
  trashEntries?: TrashListEntry[]
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const { t } = useI18n()

const n = computed(() =>
  props.mode === 'delete' ? (props.entries?.length ?? 0) : (props.trashEntries?.length ?? 0)
)
const size = computed(() =>
  formatBytes((props.trashEntries ?? []).reduce((sum, e) => sum + (e.bytes ?? 0), 0))
)

const title = computed(() => {
  if (props.mode === 'delete') {
    return t('cleanup.gc.archives.dialog.deleteTitle', n.value, { named: { n: n.value } })
  }
  if (props.mode === 'gc')
    return t('cleanup.gc.archives.dialog.gcTitle', { repo: props.repo ?? '' })
  return t('cleanup.gc.archives.dialog.trashTitle')
})
const body = computed(() => {
  if (props.mode === 'delete') return t('cleanup.gc.archives.dialog.deleteWarn')
  if (props.mode === 'gc') return t('cleanup.gc.archives.dialog.gcBody')
  return t('cleanup.gc.archives.dialog.trashBody', n.value, {
    named: { n: n.value, size: size.value }
  })
})
const confirmLabel = computed(() => {
  if (props.mode === 'delete') {
    return t('cleanup.gc.archives.dialog.deleteConfirm', n.value, { named: { n: n.value } })
  }
  if (props.mode === 'gc') return t('cleanup.gc.archives.dialog.gcConfirm')
  return t('cleanup.gc.archives.dialog.trashConfirm', { size: size.value })
})

function sourceOf(e: ArchiveEntry): string {
  if (e.folder) return e.folder.split(/[\\/]/).filter(Boolean).pop() ?? e.folder
  return e.branch ?? t('cleanup.gc.archives.detached')
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
        aria-labelledby="cleanup-exhaust-dialog-title"
        data-testid="exhaust-dialog"
        :data-mode="mode"
        @mousedown.stop
      >
        <div class="flex items-start gap-3 px-5 pb-2 pt-4">
          <div
            id="cleanup-exhaust-dialog-title"
            class="min-w-0 flex-1 text-subtitle font-medium text-text"
          >
            {{ title }}
          </div>
          <Button
            variant="ghost"
            size="icon"
            :aria-label="t('cleanup.gc.archives.dialog.close')"
            :title="t('cleanup.gc.archives.dialog.close')"
            data-testid="exhaust-close"
            @click="emit('cancel')"
          >
            <X :size="14" :stroke-width="1.7" />
          </Button>
        </div>

        <div
          class="mx-5 flex items-start gap-2.5 rounded-sm border border-warning-line bg-warning-soft px-3 py-2.5"
          data-testid="exhaust-warning"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0 text-warning"
            aria-hidden="true"
          />
          <p class="m-0 min-w-0 text-ui text-text-2">{{ body }}</p>
        </div>

        <ul
          v-if="mode === 'delete'"
          class="scrollable m-0 mx-5 mt-3 flex max-h-(--fv-rail-list-max-h) list-none flex-col gap-1.5 overflow-y-auto p-0 pr-1"
          tabindex="0"
          :aria-label="t('cleanup.gc.archives.dialog.listLabel')"
          data-testid="exhaust-list"
        >
          <li
            v-for="e in entries"
            :key="e.namespace"
            class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-sm border border-border bg-surface-2 px-2.5 py-2"
            data-testid="exhaust-row"
          >
            <Archive
              :size="12"
              :stroke-width="1.6"
              class="shrink-0 text-text-3"
              aria-hidden="true"
            />
            <span class="truncate font-mono text-ui text-text">{{ sourceOf(e) }}</span>
            <span class="text-caption text-text-3">{{
              e.ageKnown && Number.isFinite(e.at)
                ? relativeTime(new Date(e.at).toISOString())
                : t('cleanup.gc.archives.ageUnknown')
            }}</span>
            <span class="font-mono text-caption text-text-3">{{
              e.tipSha ? t('cleanup.gc.archives.tip', { sha: e.tipSha.slice(0, 7) }) : '—'
            }}</span>
            <span
              v-if="e.hasWip"
              class="inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-eyebrow text-text-3"
              >{{ t('cleanup.gc.archives.wip') }}</span
            >
            <span
              v-if="e.reflogCount > 0"
              class="inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-eyebrow text-text-3"
              >{{
                t('cleanup.gc.archives.reflog', e.reflogCount, { named: { n: e.reflogCount } })
              }}</span
            >
          </li>
        </ul>

        <ul
          v-if="mode === 'trash'"
          class="scrollable m-0 mx-5 mt-3 flex max-h-(--fv-rail-list-max-h) list-none flex-col gap-1.5 overflow-y-auto p-0 pr-1"
          tabindex="0"
          :aria-label="t('cleanup.gc.archives.dialog.trashListLabel')"
          data-testid="exhaust-trash-list"
        >
          <li
            v-for="e in trashEntries"
            :key="e.id"
            class="flex shrink-0 items-center gap-3 rounded-sm border border-border bg-surface-2 px-2.5 py-2"
            data-testid="exhaust-row"
          >
            <Trash2
              :size="12"
              :stroke-width="1.6"
              class="shrink-0 text-text-3"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate font-mono text-ui text-text">{{ e.name }}</span>
            <span class="text-caption tabular-nums text-text-3">{{
              e.bytes === null ? '—' : formatBytes(e.bytes)
            }}</span>
          </li>
        </ul>

        <div class="mt-3 flex items-center gap-2 border-t border-border px-5 py-3">
          <Button
            :ref="setCancel"
            class="ml-auto"
            variant="ghost"
            data-testid="exhaust-cancel"
            @click="emit('cancel')"
          >
            {{ t('cleanup.gc.archives.dialog.cancel') }}
          </Button>
          <Button
            :variant="mode === 'gc' ? 'primary' : 'danger'"
            data-testid="exhaust-confirm"
            @click="emit('confirm')"
          >
            <Trash2 v-if="mode !== 'gc'" :size="14" :stroke-width="1.6" class="shrink-0" />
            {{ confirmLabel }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
