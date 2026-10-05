<script setup lang="ts">
/**
 * Image lightbox (design.md §6 — "Image lightbox (Pasted-images gallery)"; spec
 * `docs/specs/2026-07-22-pasted-images-pop-lightbox-design.md`).
 *
 * Full-viewport viewer for one pasted screenshot, opened by clicking a tile in
 * `FooterImagePopover`. Prev/next wrap in both directions; the filmstrip jumps
 * straight to any image. Purely a consumer — it reuses the data-URLs the
 * popover already loaded and calls the exact same `window.api.*` functions the
 * grid's hover actions do, so there is no extra read and no new IPC surface.
 *
 * State (`index`) is owned by `StatusFooter.vue` and driven through
 * `update:index`, so the parent can keep the popover and the lightbox in sync
 * and close both with one `closeImageFlow()`.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onKeyStroke } from '@vueuse/core'
import { ChevronLeft, ChevronRight, X, ExternalLink, Folder, Copy, Reply } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import type { SessionImage } from '../composables/useSessionImages'

const props = defineProps<{
  entries: SessionImage[]
  index: number
  uuid: string
  folderAlias: string
  /** Re-attach needs a live PTY; false → the action is disabled. */
  canReattach: boolean
}>()

const emit = defineEmits<{
  close: []
  'update:index': [number]
  reattached: []
}>()

const { t } = useI18n()
const sessions = useSessionsStore()
const ui = useUiStore()

const current = computed<SessionImage | undefined>(() => props.entries[props.index])

// Natural pixel dimensions, read off the <img> on load — same trick the grid
// tiles use, no PNG parse in main.
const dims = ref<{ w: number; h: number } | null>(null)
function onImgLoad(ev: Event): void {
  const img = ev.target as HTMLImageElement
  dims.value = { w: img.naturalWidth, h: img.naturalHeight }
}
// Reset on a genuine image change only. Watching `current` itself would reset on
// every poll tick — `refresh()` reassigns `entries` with fresh objects, so the
// computed's identity changes even when the same file is still on screen, and
// the `<img>` never re-fires `load` for an unchanged `src` to refill it.
watch(
  () => current.value?.name,
  () => (dims.value = null)
)

function go(delta: number): void {
  const n = props.entries.length
  if (n === 0) return
  emit('update:index', (props.index + delta + n) % n) // wraps both ways
}

// The file being viewed, remembered BY NAME. `current` is derived from
// `props.entries`, so by the time the entries watcher below runs it has already
// re-pointed at whatever now sits at this index — the name has to be tracked
// separately to notice that the list shifted underneath us.
const viewedName = ref<string | null>(props.entries[props.index]?.name ?? null)
watch(
  () => props.index,
  (i) => (viewedName.value = props.entries[i]?.name ?? null)
)

// Entries change live: the 2s poll keeps running while the lightbox is open (the
// popover is only visually, not actually, out of the way). Pruning isn't
// guaranteed to remove from the END, so an index-only guard would silently swap
// the displayed image when an earlier file got pruned. If the viewed file
// disappeared, close; if it's still there but moved, re-point the index.
watch(
  () => props.entries,
  (next) => {
    const name = viewedName.value
    if (name === null) return
    const i = next.findIndex((e) => e.name === name)
    if (i === -1) emit('close')
    else if (i !== props.index) emit('update:index', i)
  },
  { deep: true }
)

onKeyStroke('Escape', () => emit('close'))
onKeyStroke('ArrowLeft', () => go(-1))
onKeyStroke('ArrowRight', () => go(1))

// Actions — identical bodies to `FooterImagePopover.vue`'s, against `current`.
function open(): void {
  if (current.value) void window.api.openPath(current.value.path)
}
function reveal(): void {
  if (current.value) void window.api.showItemInFolder(current.value.path)
}
async function copy(): Promise<void> {
  if (!current.value) return
  const { ok } = await window.api.imageCacheCopy(props.uuid, current.value.name)
  if (ok) ui.pushToast({ kind: 'success', title: t('images.copied'), persist: false })
}
function reattach(): void {
  if (!current.value) return
  sessions.reattachImage(current.value.path)
  // Re-attaching means the user wants the terminal next, not the gallery.
  emit('reattached')
}
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 flex flex-col"
      style="background: rgba(0, 0, 0, 0.82); z-index: 60"
      role="dialog"
      aria-modal="true"
      :aria-label="t('images.title')"
      @click.self="emit('close')"
    >
      <!-- Top bar: filename · W×H (left) — counter + close (right). No
           click-to-close on the dead space here: it's a toolbar, not backdrop. -->
      <div class="flex shrink-0 items-center gap-3 px-4 py-3 text-[11px]">
        <span class="truncate font-mono text-text-2">{{ current?.name }}</span>
        <span v-if="dims" class="shrink-0 tabular-nums text-text-3">{{ dims.w }}×{{ dims.h }}</span>
        <span class="truncate text-text-4">{{ folderAlias }}</span>
        <span
          class="ml-auto shrink-0 tabular-nums text-text-3"
          :aria-label="t('images.lightboxCounterAria', { index: index + 1, count: entries.length })"
          >{{ index + 1 }} / {{ entries.length }}</span
        >
        <button
          type="button"
          class="shrink-0 rounded p-1 text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          :aria-label="t('images.lightboxCloseAria')"
          :title="t('images.lightboxCloseAria')"
          @click="emit('close')"
        >
          <X :size="16" :stroke-width="1.6" />
        </button>
      </div>

      <!-- Stage: prev · image · next -->
      <div class="flex min-h-0 flex-1 items-center gap-3 px-4" @click.self="emit('close')">
        <button
          v-if="entries.length > 1"
          type="button"
          class="shrink-0 rounded-lg border border-border bg-surface-2 p-2 text-text-2 transition-colors hover:border-border-2 hover:text-text"
          :aria-label="t('images.lightboxPrevAria')"
          :title="t('images.lightboxPrevAria')"
          @click="go(-1)"
        >
          <ChevronLeft :size="18" :stroke-width="1.6" />
        </button>

        <div class="flex min-h-0 flex-1 items-center justify-center" @click.self="emit('close')">
          <img
            v-if="current?.dataUrl"
            :key="current.name"
            :src="current.dataUrl"
            :alt="current.name"
            class="anim-fade-in max-h-full max-w-full rounded-lg border-2 border-border-2 object-contain shadow-pop"
            @load="onImgLoad"
          />
          <div v-else class="anim-shimmer-dot h-40 w-64 rounded-lg bg-surface-2" />
        </div>

        <button
          v-if="entries.length > 1"
          type="button"
          class="shrink-0 rounded-lg border border-border bg-surface-2 p-2 text-text-2 transition-colors hover:border-border-2 hover:text-text"
          :aria-label="t('images.lightboxNextAria')"
          :title="t('images.lightboxNextAria')"
          @click="go(1)"
        >
          <ChevronRight :size="18" :stroke-width="1.6" />
        </button>
      </div>

      <!-- Bottom: actions · filmstrip · hint -->
      <div class="flex shrink-0 flex-col items-center gap-2 px-4 py-3">
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-2 transition-colors hover:border-border-2 hover:text-text"
            :aria-label="t('images.openAria', { name: current?.name ?? '' })"
            @click="open"
          >
            <ExternalLink :size="13" :stroke-width="1.6" />
            <span>{{ t('images.open') }}</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-2 transition-colors hover:border-border-2 hover:text-text"
            :aria-label="t('images.revealAria', { name: current?.name ?? '' })"
            @click="reveal"
          >
            <Folder :size="13" :stroke-width="1.6" />
            <span>{{ t('images.reveal') }}</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-2 transition-colors hover:border-border-2 hover:text-text"
            :aria-label="t('images.copyAria', { name: current?.name ?? '' })"
            @click="copy"
          >
            <Copy :size="13" :stroke-width="1.6" />
            <span>{{ t('images.copy') }}</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-2 transition-colors hover:border-border-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-2"
            :disabled="!canReattach"
            :aria-label="t('images.reattachAria', { name: current?.name ?? '' })"
            :title="canReattach ? t('images.reattach') : t('images.reattachDisabled')"
            @click="reattach"
          >
            <Reply :size="13" :stroke-width="1.6" />
            <span>{{ t('images.reattach') }}</span>
          </button>
        </div>

        <!-- Filmstrip — jump straight to any image -->
        <div
          v-if="entries.length > 1"
          class="scrollable flex max-w-full gap-1.5 overflow-x-auto p-1"
        >
          <button
            v-for="(e, i) in entries"
            :key="e.name"
            type="button"
            class="h-12 w-12 shrink-0 overflow-hidden rounded border transition-colors"
            :class="
              i === index
                ? 'border-accent-line bg-accent-soft'
                : 'border-border bg-surface hover:border-border-2'
            "
            :aria-label="t('images.lightboxCounterAria', { index: i + 1, count: entries.length })"
            :aria-current="i === index ? 'true' : undefined"
            @click="emit('update:index', i)"
          >
            <img
              v-if="e.dataUrl"
              :src="e.dataUrl"
              :alt="e.name"
              class="h-full w-full object-cover"
            />
            <div v-else class="anim-shimmer-dot h-full w-full bg-surface-2" />
          </button>
        </div>

        <p class="text-[11px] text-text-4">{{ t('images.lightboxHint') }}</p>
      </div>
    </div>
  </Teleport>
</template>
