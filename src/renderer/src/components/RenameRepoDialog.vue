<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { RotateCcw } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import Dialog from './ui/Dialog.vue'

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

watch(isOpen, (open) => {
  if (open) {
    // Prefill with the current label and select it for type-over.
    name.value = currentAlias.value || derivedLabel.value
    void nextTick(() => nameInputRef.value?.select())
  }
})
</script>

<template>
  <Dialog
    :open="isOpen"
    size="sm"
    :title="$t('renameRepo.title')"
    :subtitle="derivedLabel"
    initial-focus="#rename-repo-name"
    @close="close()"
  >
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
      style="border-radius: 5px; padding: 8px 10px; font-size: 13px; outline: none; height: 32px"
      type="text"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter.prevent="save()"
    />
    <p class="text-text-3" style="font-size: 11px; margin-top: 6px">
      {{ $t('renameRepo.resetHint') }}
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
        {{ $t('renameRepo.reset') }}
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
        @click="save()"
      >
        {{ $t('renameRepo.save') }}
      </button>
    </template>
  </Dialog>
</template>
