<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2 } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import type { GcTrashCard } from '../../../main/gc/gc-wire'

/**
 * The in-the-trash strip of the Cleanup screen (design.md "In-the-trash card"). A clean moves a
 * checkout to the OS trash, so its disk space only returns when the trash is emptied. This says how
 * much of the trash is Harnu's (only entries it can still verify, exactly) and offers to empty those,
 * behind a confirm that lists them. What it can no longer check is said apart and never counted as
 * space in the trash. Where the OS gives Harnu no safe way to empty only its own entries, it says
 * where the trash is instead.
 */
const props = defineProps<{ trash: GcTrashCard }>()
const emit = defineEmits<{ empty: [] }>()
const { t } = useI18n()

const size = computed(() => formatBytes(props.trash.inTrashBytes))
/** The Recycle Bin has no path: its name is copy, so it comes from i18n. */
const location = computed(() => props.trash.location ?? t('cleanup.gc.trash.recycleBin'))
</script>

<template>
  <section
    class="flex flex-col gap-1.5 rounded border border-border bg-surface px-3 py-2"
    data-testid="trash-card"
  >
    <div v-if="trash.inTrashCount > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Trash2 :size="14" :stroke-width="1.6" class="shrink-0 text-text-2" aria-hidden="true" />
      <span class="text-ui text-text" data-testid="trash-strip">{{
        t('cleanup.gc.trash.strip', trash.inTrashCount, {
          named: { n: trash.inTrashCount, size }
        })
      }}</span>
      <Button
        v-if="trash.canEmpty"
        class="ml-auto"
        variant="soft"
        data-testid="trash-empty"
        @click="emit('empty')"
      >
        {{ t('cleanup.gc.trash.empty', { size }) }}
      </Button>
    </div>
    <div v-if="trash.unverifiedCount > 0" class="flex items-center gap-3">
      <Trash2
        v-if="trash.inTrashCount === 0"
        :size="14"
        :stroke-width="1.6"
        class="shrink-0 text-text-3"
        aria-hidden="true"
      />
      <span class="text-caption text-text-3" data-testid="trash-unverified">{{
        t('cleanup.gc.trash.unverified', { size: formatBytes(trash.unverifiedBytes) })
      }}</span>
    </div>
    <p v-if="!trash.canEmpty" class="m-0 text-caption text-text-3" data-testid="trash-cant-empty">
      {{ t('cleanup.gc.trash.cantEmpty', { location }) }}
    </p>
  </section>
</template>
