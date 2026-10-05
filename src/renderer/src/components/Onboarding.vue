<script setup lang="ts">
import BrandMark from './BrandMark.vue'
import FolderDropOverlay from './ui/FolderDropOverlay.vue'
import { Plus } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useFolderDrop } from '../composables/useFolderDrop'

const ui = useUiStore()

// The CTA opens the same Add-folder dialog the menu/shortcut use
// (`ui.openDialog('addFolder')`), so first run is no longer a dead end.
function onAddFolder(): void {
  ui.openDialog('addFolder')
}

// Drag & drop: dropping a directory onto the hero pins it as a folder — the
// same `useFolderDrop` behavior the sidebar binds, so the two can't drift.
const { dragOver, onDragOver, onDragLeave, onDrop } = useFolderDrop()
</script>

<template>
  <div
    class="relative flex h-full w-full items-center justify-center"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="anim-fade-in flex flex-col items-center text-center" style="width: min(460px, 90%)">
      <BrandMark :size="56" />

      <h1
        class="text-text"
        style="margin-top: 20px; font-size: 22px; font-weight: 500; letter-spacing: -0.02em"
      >
        {{ $t('onboarding.title') }}
      </h1>

      <p class="text-text-3" style="margin-top: 8px; font-size: 13px; line-height: 1.6">
        {{ $t('onboarding.subtitleA') }}<br />{{ $t('onboarding.subtitleB') }}
      </p>

      <button
        class="flex items-center justify-center gap-2 bg-accent text-accent-ink transition active:scale-[0.99]"
        style="
          margin-top: 22px;
          height: 40px;
          padding: 0 18px;
          font-size: 13px;
          font-weight: 600;
          border-radius: 7px;
        "
        @click="onAddFolder"
      >
        <Plus :size="14" :stroke-width="2" />
        <span>{{ $t('onboarding.cta') }}</span>
      </button>

      <p class="text-text-3" style="margin-top: 12px; font-size: 11px">
        {{ $t('onboarding.hint') }}
      </p>

      <!-- Trademark hygiene (design.md §8, "Non-affiliation line"). -->
      <p class="text-text-4" style="margin-top: 24px; font-size: 11px">
        {{ $t('onboarding.disclaimer') }}
      </p>
    </div>

    <!-- Drop-to-pin affordance (design.md — "Dropping a folder onto the
         sidebar"), dimmed against `--color-bg`: the hero sits on the main
         content area, not the sidebar surface. -->
    <FolderDropOverlay v-if="dragOver" scrim="bg" />
  </div>
</template>
