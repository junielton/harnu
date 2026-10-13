<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { Recycle, Trash2, TriangleAlert, X } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import { useFocusTrap } from '../composables/useFocusTrap'
import type { StackLeftoverItem } from '../../../main/gc/gc-wire'

/**
 * The confirm of the Docker card's "Left by removed worktrees" block (design.md "Workspace GC —
 * unified Cleanup / Docker card"). `stack` cleans stopped containers and networks; `volumes` removes
 * volumes, which cannot be restored and so get their own, stronger dialog. Focus starts on Cancel,
 * never on the confirm; Esc closes only this dialog.
 */
const props = defineProps<{
  kind: 'stack' | 'volumes'
  /** The leftovers being cleaned (stack) or whose volumes are being removed (volumes). */
  items: StackLeftoverItem[]
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const { t } = useI18n()

const volumes = computed(() =>
  props.items.flatMap((i) => i.volumes.map((v) => ({ ...v, project: i.project })))
)
const count = computed(() => (props.kind === 'stack' ? props.items.length : volumes.value.length))
const volumeBytes = computed(() => volumes.value.reduce((a, v) => a + (v.sizeBytes ?? 0), 0))

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
        aria-labelledby="cleanup-docker-dialog-title"
        data-testid="docker-confirm"
        :data-kind="kind"
        @mousedown.stop
      >
        <div class="flex items-start gap-3 px-5 pb-2 pt-4">
          <div id="cleanup-docker-dialog-title" class="min-w-0 flex-1 text-subtitle font-medium">
            {{
              t(
                kind === 'stack'
                  ? 'cleanup.gc.docker.confirm.stackTitle'
                  : 'cleanup.gc.docker.confirm.volumesTitle',
                count,
                { named: { n: count } }
              )
            }}
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
          :aria-label="t('cleanup.gc.docker.confirm.listLabel')"
        >
          <template v-if="kind === 'stack'">
            <div
              v-for="i in items"
              :key="i.id"
              role="listitem"
              class="flex shrink-0 flex-col gap-0.5 rounded-sm border border-border bg-surface-2 px-2.5 py-2"
              data-testid="docker-confirm-row"
            >
              <span class="truncate font-mono text-ui text-text">{{ i.project }}</span>
              <span class="text-caption text-text-4">{{
                t('cleanup.gc.docker.leftovers.stack', {
                  c: i.containers.length,
                  n: i.networks.length
                })
              }}</span>
            </div>
          </template>
          <template v-else>
            <div
              v-for="v in volumes"
              :key="v.id"
              role="listitem"
              class="grid shrink-0 grid-cols-[1fr_72px] items-start gap-3 rounded-sm border border-warning-line bg-surface-2 px-2.5 py-2"
              data-testid="docker-confirm-row"
            >
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate font-mono text-ui text-text">{{ v.name }}</span>
                <span class="text-caption text-text-4">{{
                  t('cleanup.gc.docker.projects', { names: v.project })
                }}</span>
              </span>
              <span class="text-right text-ui tabular-nums text-text">{{
                v.sizeBytes === null ? '—' : formatBytes(v.sizeBytes)
              }}</span>
            </div>
          </template>
        </div>

        <div
          class="mx-5 mt-3 flex items-start gap-2.5 rounded-sm border border-warning-line bg-warning-soft px-3 py-2.5"
          data-testid="docker-confirm-note"
        >
          <TriangleAlert
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0 text-warning"
            aria-hidden="true"
          />
          <p
            class="m-0 min-w-0 text-ui text-text-2"
            :class="kind === 'volumes' ? 'font-semibold text-warning' : ''"
          >
            {{
              t(
                kind === 'stack'
                  ? 'cleanup.gc.docker.confirm.stackNote'
                  : 'cleanup.gc.docker.confirm.volumesNote'
              )
            }}
          </p>
        </div>

        <div class="mt-3 flex items-center gap-2 border-t border-border px-5 py-3">
          <span
            v-if="kind === 'volumes'"
            class="mr-auto text-ui font-medium tabular-nums text-text"
            data-testid="docker-confirm-total"
            >{{
              t('cleanup.gc.docker.volumesCount', count, {
                named: { n: count, size: formatBytes(volumeBytes) }
              })
            }}</span
          >
          <span v-else class="mr-auto" />
          <Button
            :ref="setCancel"
            variant="ghost"
            data-testid="docker-confirm-cancel"
            @click="emit('cancel')"
          >
            {{ t('cleanup.gc.confirm.cancel') }}
          </Button>
          <Button
            :variant="kind === 'stack' ? 'success' : 'danger'"
            data-testid="docker-confirm-confirm"
            @click="emit('confirm')"
          >
            <Recycle v-if="kind === 'stack'" :size="14" :stroke-width="1.6" class="shrink-0" />
            <Trash2 v-else :size="14" :stroke-width="1.6" class="shrink-0" />
            {{
              kind === 'stack'
                ? t('cleanup.gc.docker.confirm.stackConfirm')
                : t('cleanup.gc.docker.confirm.volumesConfirm', count, { named: { n: count } })
            }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
