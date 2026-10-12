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
 * much of the trash is Harnu's and offers to empty exactly that, behind a confirm. Where the OS gives
 * Harnu no way to tell its items from the user's, it says where the trash is instead.
 */
const props = defineProps<{ trash: GcTrashCard }>()
const emit = defineEmits<{ empty: [] }>()
const { t } = useI18n()

const size = computed(() => formatBytes(props.trash.inTrashBytes))
</script>

<template>
  <section
    class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border border-border bg-surface px-3 py-2"
    data-testid="trash-card"
  >
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
    <span v-else class="text-caption text-text-3" data-testid="trash-cant-empty">{{
      t('cleanup.gc.trash.cantEmpty', { location: trash.location })
    }}</span>
  </section>
</template>
