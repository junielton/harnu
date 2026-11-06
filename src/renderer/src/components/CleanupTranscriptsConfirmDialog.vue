<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, TriangleAlert, X } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import { useFocusTrap } from '../composables/useFocusTrap'
import { orphanDigestState, undigestedItems } from '../lib/gc-orphans'
import type { OrphanTranscriptItem } from '../../../main/gc/gc-wire'

/**
 * Confirm for moving orphaned transcript folders to the trash (design.md "Workspace GC — unified
 * Cleanup / Other leftovers — transcripts of folders that are gone"). It lists exactly what the
 * request will name; focus starts on Cancel, never on the confirm, and Esc closes only this dialog.
 */
const props = defineProps<{ items: OrphanTranscriptItem[] }>()
const emit = defineEmits<{
  confirm: [opts: { notFoundAck: boolean; undigestedAck: boolean }]
  cancel: []
}>()
const { t } = useI18n()

const count = computed(() => props.items.length)
const totalBytes = computed(() => props.items.reduce((a, i) => a + i.bytes, 0))
/** Some folder is only missing, not proven gone: the full path shows and the stronger confirm applies. */
const hasNotFound = computed(() => props.items.some((i) => i.proof === 'not-found'))
const ack = ref(false)
/** Some sessions have no digest in the owning repo's memory: trashing them loses what they did. */
const undigested = computed(() => undigestedItems(props.items))
const hasUndigested = computed(() => undigested.value.length > 0)
const undigestedSessions = computed(() =>
  undigested.value.reduce((a, i) => a + orphanDigestState(i).missing, 0)
)
/** Harnu can retry a digest only where a repo was found to hold it. */
const canRetryDigest = computed(() => undigested.value.some((i) => i.digest?.home))
const undigestedAck = ref(false)
const canConfirm = computed(
  () => (!hasNotFound.value || ack.value) && (!hasUndigested.value || undigestedAck.value)
)
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
              <span
                v-if="i.proof === 'not-found'"
                class="break-all font-mono text-ui text-text"
                data-testid="orphan-dialog-fullpath"
                >{{ i.folder }}</span
              >
              <span v-else class="truncate font-mono text-ui text-text" :title="i.folder">{{
                nameOf(i.folder)
              }}</span>
              <span class="truncate text-caption text-text-4"
                >{{ i.repoLabel }} ·
                {{ t('cleanup.gc.orphans.sessions', { n: i.sessionCount }, i.sessionCount) }}</span
              >
              <span
                v-if="orphanDigestState(i).kind === 'partial'"
                class="break-all text-caption text-text-4"
                :title="i.digest?.home ?? undefined"
                data-testid="orphan-dialog-digest"
                >{{
                  i.digest?.home
                    ? t(
                        'cleanup.gc.orphans.confirm.undigested.row',
                        { n: orphanDigestState(i).missing, home: i.digest.home },
                        orphanDigestState(i).missing
                      )
                    : t('cleanup.gc.orphans.confirm.undigested.noHome')
                }}</span
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

        <div
          v-if="hasUndigested"
          class="mx-5 mt-3 flex items-start gap-2.5 rounded-sm border border-warning-line bg-warning-soft px-3 py-2.5"
          data-testid="orphan-dialog-undigested"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0 text-warning"
            aria-hidden="true"
          />
          <div class="min-w-0 text-ui text-text-2">
            <p class="m-0">
              {{
                t(
                  'cleanup.gc.orphans.confirm.undigested.summary',
                  { n: undigestedSessions },
                  undigestedSessions
                )
              }}
            </p>
            <p v-if="canRetryDigest" class="m-0 mt-1">
              {{ t('cleanup.gc.orphans.confirm.undigested.retry') }}
            </p>
          </div>
        </div>

        <label
          v-if="hasUndigested"
          class="mx-5 mt-3 flex cursor-pointer items-start gap-2.5"
          data-testid="orphan-dialog-undigested-label"
        >
          <input
            v-model="undigestedAck"
            type="checkbox"
            class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
            data-testid="orphan-dialog-undigested-ack"
          />
          <span class="text-ui text-text">{{
            t('cleanup.gc.orphans.confirm.undigested.ack')
          }}</span>
        </label>

        <label
          v-if="hasNotFound"
          class="mx-5 mt-3 flex cursor-pointer items-start gap-2.5"
          data-testid="orphan-dialog-ack-label"
        >
          <input
            v-model="ack"
            type="checkbox"
            class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
            data-testid="orphan-dialog-ack"
          />
          <span class="text-ui text-text">{{ t('cleanup.gc.orphans.notFound.ack') }}</span>
        </label>

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
          <Button
            variant="danger"
            :disabled="!canConfirm"
            data-testid="orphan-dialog-confirm"
            @click="
              canConfirm &&
              emit('confirm', {
                notFoundAck: hasNotFound && ack,
                undigestedAck: hasUndigested && undigestedAck
              })
            "
          >
            <Trash2 :size="14" :stroke-width="1.6" class="shrink-0" />
            {{ t('cleanup.gc.orphans.confirm.confirm') }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
