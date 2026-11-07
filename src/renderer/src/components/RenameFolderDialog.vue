<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { RotateCcw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import Dialog from './ui/Dialog.vue'
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

watch(isOpen, (open) => {
  if (open) {
    // Prefill with the current label and select it for type-over.
    name.value = folder.value?.alias ?? base.value
    submitting.value = false
    void nextTick(() => nameInputRef.value?.select())
  }
})
</script>

<template>
  <Dialog
    :open="isOpen"
    size="sm"
    :title="$t('renameFolder.title')"
    :subtitle="base"
    initial-focus="#rename-folder-name"
    @close="close()"
  >
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
      style="border-radius: 5px; padding: 8px 10px; font-size: 13px; outline: none; height: 32px"
      type="text"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter.prevent="save()"
    />
    <p class="text-text-3" style="font-size: 11px; margin-top: 6px">
      {{ $t('renameFolder.resetHint') }}
    </p>

    <template #meta>
      <button
        v-if="hasCustomAlias"
        class="flex items-center border border-border bg-transparent text-text-2 transition hover:text-text"
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
    </template>
    <template #footer>
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
    </template>
  </Dialog>
</template>
