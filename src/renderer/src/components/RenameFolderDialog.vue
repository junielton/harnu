<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X, RotateCcw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useFocusTrap } from '../composables/useFocusTrap'
import { basename } from './folder-alias'

/**
 * "Rename folder" dialog (T52 Slice 1). Renames a folder's sidebar label by
 * persisting a custom alias (`sessions.renameFolder` → `userProjectsSetAlias`,
 * which creates a pinned record for an auto-discovered folder). Clearing the
 * field (or "Reset name") resets the label to the folder's basename. A
 * non-destructive `Dialog` variant — see design.md §6 "Rename folder".
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'renameFolder')
const targetPath = computed(() => ui.folderActionPath ?? '')
const folder = computed(() =>
  targetPath.value ? sessions.findFolderByPath(targetPath.value) : null
)
const base = computed(() => basename(targetPath.value))
/** Whether a custom alias is currently set (alias differs from the basename). */
const hasCustomAlias = computed(() => !!folder.value && folder.value.alias !== base.value)

const name = ref('')
const submitting = ref(false)
const canSubmit = computed(() => !submitting.value)

async function save(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    await sessions.renameFolder(targetPath.value, name.value)
    ui.closeDialog()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({ kind: 'danger', title: t('renameFolder.failed'), description: message })
  } finally {
    submitting.value = false
  }
}

async function reset(): Promise<void> {
  name.value = ''
  await save()
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
    name.value = folder.value?.alias ?? base.value
    submitting.value = false
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
        aria-labelledby="rename-folder-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div class="flex items-baseline" style="gap: 8px; min-width: 0">
            <h2
              id="rename-folder-dialog-title"
              class="text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ $t('renameFolder.title') }}
            </h2>
            <span class="truncate font-mono text-text-4" style="font-size: 11.5px">{{ base }}</span>
          </div>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('renameFolder.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto" style="padding: 14px 18px">
          <label
            for="rename-folder-name"
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
            {{ $t('renameFolder.nameLabel') }}
          </label>
          <input
            id="rename-folder-name"
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
            {{ $t('renameFolder.resetHint') }}
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
            {{ $t('renameFolder.reset') }}
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
            :style="{
              opacity: canSubmit ? 1 : 0.4,
              cursor: canSubmit ? 'pointer' : 'not-allowed'
            }"
            :disabled="!canSubmit"
            @click="save()"
          >
            {{ $t('renameFolder.save') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
