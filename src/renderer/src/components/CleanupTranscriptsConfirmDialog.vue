<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, TriangleAlert, X } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import { useFocusTrap } from '../composables/useFocusTrap'
import type { OrphanTranscriptItem } from '../../../main/gc/gc-wire'

/**
 * Confirm for moving orphaned transcript folders to the trash (design.md "Workspace GC — unified
 * Cleanup / Other leftovers — transcripts of folders that are gone"). It lists exactly what the
 * request will name; focus starts on Cancel, never on the confirm, and Esc closes only this dialog.
 */
const props = defineProps<{ items: OrphanTranscriptItem[] }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const { t } = useI18n()

const count = computed(() => props.items.length)
const totalBytes = computed(() => props.items.reduce((a, i) => a + i.bytes, 0))
const withMemory = computed(() => props.items.filter((i) => i.hasMemory).length)

const nameOf = (folder: string): string =>
  folder
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || folder

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
        aria-labelledby="cleanup-orphan-dialog-title"
        data-testid="orphan-dialog"
        @mousedown.stop
      >
        <div class="flex items-start gap-3 px-5 pb-2 pt-4">
          <div class="min-w-0 flex-1">
            <div id="cleanup-orphan-dialog-title" class="text-subtitle font-medium text-text">
              {{ t('cleanup.gc.orphans.confirm.title', count, { named: { n: count } }) }}
            </div>
            <p class="m-0 mt-0.5 text-ui text-text-2">
              {{ t('cleanup.gc.orphans.confirm.subtitle') }}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            :aria-label="t('cleanup.gc.confirm.close')"
            :title="t('cleanup.gc.confirm.close')"
            @click="emit('cancel')"
          >
            <X :size="14" :stroke-width="1.7" />
          </Button>
        </div>

        <div
          class="scrollable mx-5 mt-2 flex max-h-(--fv-rail-list-max-h) flex-col gap-1.5 overflow-y-auto pr-1"
          tabindex="0"
          role="list"
          :aria-label="t('cleanup.gc.orphans.confirm.listLabel')"
        >
          <div
            v-for="i in items"
            :key="i.id"
            role="listitem"
            class="grid shrink-0 grid-cols-[1fr_64px] items-start gap-3 rounded-sm border border-border bg-surface-2 px-2.5 py-2"
            data-testid="orphan-dialog-row"
          >
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate font-mono text-ui text-text" :title="i.folder">{{
                nameOf(i.folder)
              }}</span>
              <span class="truncate text-caption text-text-4"
                >{{ i.repoLabel }} ·
                {{ t('cleanup.gc.orphans.sessions', { n: i.sessionCount }, i.sessionCount) }}</span
              >
            </span>
            <span class="text-right text-ui leading-4 tabular-nums text-text">{{
              formatBytes(i.bytes)
            }}</span>
          </div>
        </div>

        <div
          class="mx-5 mt-3 flex items-start gap-2.5 rounded-sm border border-warning-line bg-warning-soft px-3 py-2.5"
          data-testid="orphan-dialog-recoverable"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0 text-warning"
            aria-hidden="true"
          />
          <div class="min-w-0 text-ui text-text-2">
            <p class="m-0">{{ t('cleanup.gc.orphans.confirm.recoverable') }}</p>
            <p v-if="withMemory > 0" class="m-0 mt-1" data-testid="orphan-dialog-memory">
              {{ t('cleanup.gc.orphans.confirm.memory', withMemory, { named: { n: withMemory } }) }}
            </p>
          </div>
        </div>

        <div class="mt-3 flex items-center gap-2 border-t border-border px-5 py-3">
          <span
            class="mr-auto text-ui font-medium tabular-nums text-text"
            data-testid="orphan-dialog-total"
            >{{
              t(
                'cleanup.gc.orphans.confirm.total',
                { n: count, size: formatBytes(totalBytes) },
                count
              )
            }}</span
          >
          <Button
            :ref="setCancel"
            variant="ghost"
            data-testid="orphan-dialog-cancel"
            @click="emit('cancel')"
          >
            {{ t('cleanup.gc.confirm.cancel') }}
          </Button>
          <Button variant="danger" data-testid="orphan-dialog-confirm" @click="emit('confirm')">
            <Trash2 :size="14" :stroke-width="1.6" class="shrink-0" />
            {{ t('cleanup.gc.orphans.confirm.confirm') }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
