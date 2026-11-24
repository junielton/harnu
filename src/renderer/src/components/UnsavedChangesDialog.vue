<script setup lang="ts">
import { useId } from 'vue'
import Dialog from './ui/Dialog.vue'

/**
 * "Unsaved changes" dialog (design.md §6 "Unsaved changes dialog"). The question a
 * markdown pane asks when the operator closes it while it holds unsaved edits: Save,
 * Don't save, or Cancel. A `Confirm` variant of the shared `Dialog` shell.
 *
 * Purely presentational and controlled: it never closes itself and never touches the
 * draft. `MarkdownPane` owns the save and the close. Esc, the scrim and the ✕ all mean
 * Cancel; Save is the initial focus (and so the Enter action), "Don't save" is never
 * the default.
 */
defineProps<{
  open: boolean
  /** Basename of the file whose edits are at stake. */
  fileName: string
}>()
const emit = defineEmits<{
  save: []
  discard: []
  cancel: []
}>()

const bodyId = `unsaved-changes-body-${useId()}`
</script>

<template>
  <Dialog
    :open="open"
    size="sm"
    :title="$t('markdownPane.unsavedDialog.title')"
    :describedby="bodyId"
    initial-focus="[data-test='unsaved-save']"
    data-test="unsaved-changes-dialog"
    @close="emit('cancel')"
  >
    <i18n-t
      :id="bodyId"
      keypath="markdownPane.unsavedDialog.body"
      tag="p"
      scope="global"
      class="text-text-2"
      style="font-size: 12.5px; line-height: 19px"
    >
      <template #name>
        <b class="font-semibold text-text">{{ fileName }}</b>
      </template>
    </i18n-t>

    <template #meta>
      <button
        type="button"
        class="border border-border bg-transparent text-red transition hover:bg-surface-2"
        style="
          padding: 7px 14px;
          font-size: 12.5px;
          font-weight: 500;
          border-radius: 5px;
          height: 28px;
        "
        data-test="unsaved-discard"
        @click="emit('discard')"
      >
        {{ $t('markdownPane.unsavedDialog.discard') }}
      </button>
    </template>
    <template #footer>
      <button
        type="button"
        class="border border-border bg-transparent text-text-2 transition hover:text-text"
        style="
          padding: 7px 14px;
          font-size: 12.5px;
          font-weight: 500;
          border-radius: 5px;
          height: 28px;
        "
        data-test="unsaved-cancel"
        @click="emit('cancel')"
      >
        {{ $t('markdownPane.unsavedDialog.cancel') }}
      </button>
      <button
        type="button"
        class="bg-accent text-accent-ink transition"
        style="
          padding: 7px 14px;
          font-size: 12.5px;
          font-weight: 500;
          border-radius: 5px;
          border: none;
          height: 28px;
        "
        data-test="unsaved-save"
        @click="emit('save')"
      >
        {{ $t('markdownPane.unsavedDialog.save') }}
      </button>
    </template>
  </Dialog>
</template>
