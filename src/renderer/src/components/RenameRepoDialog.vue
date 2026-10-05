<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X, RotateCcw } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useFocusTrap } from '../composables/useFocusTrap'

/**
 * "Rename repo" dialog (T88). Renames a repo-GROUP's header label by persisting a
 * per-group alias (`sessions.setGroupAlias` → localStorage `om2tab.repoAliases`).
 * Clearing the field (or "Reset name") reverts the label to the derived basename. A
 * non-destructive `Dialog` variant — see design.md §6 "Rename repo". Twin of
 * `RenameFolderDialog`, but keyed by the namespaced group key (renderer-only, no `projects.json`).
 */

const ui = useUiStore()
const sessions = useSessionsStore()

const isOpen = computed(() => ui.dialog === 'renameRepo')
const groupKey = computed(() => ui.renameRepoTarget?.groupKey ?? '')
const derivedLabel = computed(() => ui.renameRepoTarget?.derivedLabel ?? '')
/** The current custom alias for this repo, if any (empty = derived label in use). */
const currentAlias = computed<string>(() =>
  groupKey.value ? (sessions.groupAliases[groupKey.value] ?? '') : ''
)
const hasCustomAlias = computed(() => !!currentAlias.value)

const name = ref('')

function save(): void {
  sessions.setGroupAlias(groupKey.value, name.value)
  ui.closeDialog()
}

function reset(): void {
  name.value = ''
  save()
}

function close(): void {
  ui.closeDialog()
}

const nameInputRef = ref<HTMLInputElement | null>(null)
const dialogRef = ref<HTMLElement | null>(null)

useFocusTrap({ active: isOpen, containerRef: dialogRef, initialFocusRef: nameInputRef })

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

watch(isOpen, (open) => {
  if (open) {
    // Prefill with the current label and select it for type-over.
    name.value = currentAlias.value || derivedLabel.value
    window.addEventListener('keydown', onKeydown, true)
    void nextTick(() => nameInputRef.value?.select())
  } else {
    window.removeEventListener('keydown', onKeydown, true)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(480px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-repo-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div class="flex items-baseline" style="gap: 8px; min-width: 0">
            <h2
              id="rename-repo-dialog-title"
              class="text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ $t('renameRepo.title') }}
            </h2>
            <span class="truncate font-mono text-text-4" style="font-size: 11.5px">{{
              derivedLabel
            }}</span>
          </div>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('renameRepo.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto" style="padding: 14px 18px">
          <label
            for="rename-repo-name"
            class="text-text-3"
            style="
              display: block;
              font-size: 11px;
              font-weight: 500;
              letter-spacing: 0.06em;
              text-transform: uppercase;
              margin-bottom: 6px;
            "
          >
            {{ $t('renameRepo.nameLabel') }}
          </label>
          <input
            id="rename-repo-name"
            ref="nameInputRef"
            v-model="name"
            class="w-full border border-border bg-bg text-text transition focus:border-accent-line"
            style="
              border-radius: 5px;
              padding: 8px 10px;
              font-size: 13px;
              outline: none;
              height: 32px;
            "
            type="text"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.prevent="save()"
          />
          <p class="text-text-3" style="font-size: 11px; margin-top: 6px">
            {{ $t('renameRepo.resetHint') }}
          </p>
        </div>

        <!-- Footer -->
        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <button
            v-if="hasCustomAlias"
            class="mr-auto flex items-center border border-border bg-transparent text-text-2 transition hover:text-text"
            style="
              padding: 7px 12px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
              gap: 6px;
            "
            @click="reset()"
          >
            <RotateCcw :size="12" :stroke-width="1.7" />
            {{ $t('renameRepo.reset') }}
          </button>
          <button
            class="border border-border bg-transparent text-text-2 transition hover:text-text"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
            "
            @click="close()"
          >
            {{ $t('actions.cancel') }}
          </button>
          <button
            class="bg-accent text-accent-ink transition"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              border: none;
              height: 28px;
            "
            @click="save()"
          >
            {{ $t('renameRepo.save') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
