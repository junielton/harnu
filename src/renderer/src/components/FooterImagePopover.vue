<script setup lang="ts">
/**
 * Pasted-images popover content (design.md §6 — "Pasted-images pill + popover").
 * Read-only grid of the PNGs Claude Code cached for the active session, newest
 * first. Each tile offers Open / Reveal / Copy / Re-attach on hover. Rendered
 * inside the positioned popover container in `StatusFooter.vue` (like `UsagePanel`).
 *
 * Clicking a tile BODY emits `open-lightbox` with its index — the lightbox itself
 * is owned by `StatusFooter.vue`, since it has to render above this popover's own
 * stacking context (design.md §6 — "Floating surfaces (z-order)").
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, Folder, Copy, Reply } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import type { SessionImage } from '../composables/useSessionImages'

const props = defineProps<{
  entries: SessionImage[]
  uuid: string
  folderAlias: string
  count: number
  /** Re-attach needs a live PTY; false → the action is disabled. */
  canReattach: boolean
}>()

const emit = defineEmits<{
  /** Tile body clicked — payload is its index into `entries`. */
  'open-lightbox': [number]
}>()

const { t } = useI18n()
const sessions = useSessionsStore()
const ui = useUiStore()

// Natural pixel dimensions, read from each <img> on load — no PNG parse in main.
const dims = ref<Record<string, { w: number; h: number }>>({})
function onImgLoad(name: string, ev: Event): void {
  const img = ev.target as HTMLImageElement
  dims.value = { ...dims.value, [name]: { w: img.naturalWidth, h: img.naturalHeight } }
}

function open(e: SessionImage): void {
  void window.api.openPath(e.path)
}
function reveal(e: SessionImage): void {
  // T46: reveal the IMAGE file in its cache folder — not settings.json (the old
  // `settingsReveal` ignored its arg and revealed Harnu's settings path).
  void window.api.showItemInFolder(e.path)
}
async function copy(e: SessionImage): Promise<void> {
  const { ok } = await window.api.imageCacheCopy(props.uuid, e.name)
  if (ok) ui.pushToast({ kind: 'success', title: t('images.copied'), persist: false })
}
function reattach(e: SessionImage): void {
  sessions.reattachImage(e.path)
}
</script>

<template>
  <div class="flex flex-col gap-2 p-2">
    <!-- Header: title + folder alias · count -->
    <div class="flex items-baseline justify-between gap-2 px-0.5">
      <span class="text-[11px] font-medium text-text">{{ t('images.title') }}</span>
      <span class="truncate text-[11px] text-text-3">{{ folderAlias }} · {{ count }}</span>
    </div>

    <!-- Grade — newest first -->
    <div class="scrollable grid max-h-64 grid-cols-3 gap-2 overflow-y-auto">
      <!-- The tile BODY opens the lightbox. The 4 hover actions sit in a child
           and keep their own `@click`, which fires first and does its thing —
           the tile's listener would still run afterwards, so they stop the
           bubble explicitly rather than opening the lightbox on every action. -->
      <div
        v-for="(e, i) in entries"
        :key="e.name"
        class="group relative cursor-pointer overflow-hidden rounded border border-border bg-surface"
        @click="emit('open-lightbox', i)"
      >
        <div class="aspect-square w-full">
          <img
            v-if="e.dataUrl"
            :src="e.dataUrl"
            :alt="e.name"
            class="h-full w-full object-cover"
            @load="onImgLoad(e.name, $event)"
          />
          <div v-else class="anim-shimmer-dot h-full w-full bg-surface-2" />
        </div>

        <!-- Tile footer: name · W×H (technical, untranslated) -->
        <div class="flex items-center justify-between gap-1 px-1 py-0.5 text-[11px] text-text-3">
          <span class="truncate font-mono">{{ e.name }}</span>
          <span v-if="dims[e.name]" class="shrink-0 tabular-nums"
            >{{ dims[e.name].w }}×{{ dims[e.name].h }}</span
          >
        </div>

        <!-- Hover actions -->
        <div
          class="absolute inset-x-0 top-0 flex items-center justify-center gap-1 bg-bg/70 p-1 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <button
            type="button"
            class="rounded p-1 text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
            :aria-label="t('images.openAria', { name: e.name })"
            :title="t('images.open')"
            @click.stop="open(e)"
          >
            <ExternalLink :size="13" :stroke-width="1.6" />
          </button>
          <button
            type="button"
            class="rounded p-1 text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
            :aria-label="t('images.revealAria', { name: e.name })"
            :title="t('images.reveal')"
            @click.stop="reveal(e)"
          >
            <Folder :size="13" :stroke-width="1.6" />
          </button>
          <button
            type="button"
            class="rounded p-1 text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
            :aria-label="t('images.copyAria', { name: e.name })"
            :title="t('images.copy')"
            @click.stop="copy(e)"
          >
            <Copy :size="13" :stroke-width="1.6" />
          </button>
          <button
            type="button"
            class="rounded p-1 text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-2"
            :disabled="!canReattach"
            :aria-label="t('images.reattachAria', { name: e.name })"
            :title="canReattach ? t('images.reattach') : t('images.reattachDisabled')"
            @click.stop="reattach(e)"
          >
            <Reply :size="13" :stroke-width="1.6" />
          </button>
        </div>
      </div>
    </div>

    <!-- Ephemeral note — full sentence, with period (§8) -->
    <p class="px-0.5 text-[11px] text-text-4">{{ t('images.ephemeral') }}</p>
  </div>
</template>
