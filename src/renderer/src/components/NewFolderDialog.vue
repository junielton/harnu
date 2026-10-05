<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { X, FolderPlus } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useFocusTrap } from '../composables/useFocusTrap'

/**
 * "New folder" dialog (T69). Creates a subfolder INSIDE the folder the
 * FolderMenu targeted (`ui.folderActionPath`) via `foldersCreateSubfolder`, then
 * pins it through `sessions.pinFolder` (which probes git, T70A → the new folder
 * groups under its repo). A non-destructive `Dialog` variant — see design.md §6
 * "New folder". Peer of the other dialogs via `ui.dialog === 'newFolder'`.
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'newFolder')
const parentPath = computed(() => ui.folderActionPath ?? '')

/** Cross-platform basename (renderer may run on any OS). */
function basename(p: string): string {
  if (!p) return ''
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  )
}

const parentName = computed(() => basename(parentPath.value))

const name = ref('')
const submitting = ref(false)

/** A name is valid iff non-empty and a single segment (no separators, no `..`). */
const nameValid = computed<boolean>(() => {
  const n = name.value.trim()
  if (!n) return false
  if (/[/\\]/.test(n)) return false
  if (n === '.' || n === '..' || n.includes('..')) return false
  return true
})

/** Only surface the "invalid" hint once the user has typed something. */
const showInvalid = computed(() => name.value.trim().length > 0 && !nameValid.value)

const pathPreview = computed(() => {
  const n = name.value.trim()
  const parent = parentPath.value.replace(/[/\\]+$/, '')
  return n ? `${parent}/${n}` : parent
})

const canSubmit = computed(() => nameValid.value && !submitting.value)

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const created = await window.api.foldersCreateSubfolder(parentPath.value, name.value.trim())
    await sessions.pinFolder(created)
    ui.closeDialog()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({ kind: 'danger', title: t('newFolder.createFailed'), description: message })
  } finally {
    submitting.value = false
  }
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
    name.value = ''
    submitting.value = false
    window.addEventListener('keydown', onKeydown, true)
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
          width: min(520px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-folder-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div class="flex items-baseline" style="gap: 8px; min-width: 0">
            <h2
              id="new-folder-dialog-title"
              class="text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ $t('newFolder.title') }}
            </h2>
            <span class="truncate font-mono text-text-4" style="font-size: 11.5px">{{
              parentName
            }}</span>
          </div>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('newFolder.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto" style="padding: 14px 18px">
          <!-- Invalid-name banner -->
          <div
            v-if="showInvalid"
            class="border border-red-soft bg-red-soft text-red"
            style="border-radius: 5px; padding: 7px 10px; font-size: 11.5px; margin-bottom: 10px"
          >
            {{ $t('newFolder.invalidName') }}
          </div>

          <label
            for="new-folder-name"
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
            {{ $t('newFolder.nameLabel') }}
          </label>
          <input
            id="new-folder-name"
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
            :placeholder="$t('newFolder.namePlaceholder')"
            @keydown.enter.prevent="submit()"
          />

          <!-- Path preview -->
          <div class="flex items-baseline" style="gap: 6px; margin-top: 10px; min-width: 0">
            <span class="shrink-0 text-text-4" style="font-size: 11px">{{
              $t('newFolder.pathPreview')
            }}</span>
            <span class="truncate font-mono text-text-4" style="font-size: 11.5px">{{
              pathPreview
            }}</span>
          </div>
        </div>

        <!-- Footer -->
        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
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
            class="flex items-center bg-accent text-accent-ink transition"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              border: none;
              height: 28px;
              gap: 7px;
            "
            :style="{
              opacity: canSubmit ? 1 : 0.4,
              cursor: canSubmit ? 'pointer' : 'not-allowed'
            }"
            :disabled="!canSubmit"
            @click="submit()"
          >
            <FolderPlus :size="13" :stroke-width="1.7" />
            {{ $t('newFolder.create') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
