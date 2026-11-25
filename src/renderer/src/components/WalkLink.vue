<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ArrowUpRight, File, Folder, GitPullRequest, Link as LinkIcon } from 'lucide-vue-next'
import type { LinkChip } from '../lib/walk-view'
import WalkCopy from './WalkCopy.vue'

/**
 * A link chip of the Where line (design.md §6 "Guided test walk" → Where): accent text, underlined, a trailing
 * arrow, and a split copy when the value has a full form. Every link opens the real thing; the pane does it.
 */
defineProps<{ link: LinkChip }>()
defineEmits<{ open: [link: LinkChip] }>()
const { t } = useI18n()
</script>

<template>
  <span class="lk split wl" data-dsqa-part="link" data-walk-link>
    <button
      type="button"
      class="open"
      data-walk-chip
      :title="link.copy ?? link.target"
      @click="$emit('open', link)"
    >
      <GitPullRequest v-if="link.kind === 'pr'" class="i i10" :size="10" />
      <File v-else-if="link.kind === 'file'" class="i i10" :size="10" />
      <Folder v-else-if="link.kind === 'folder'" class="i i10" :size="10" />
      <LinkIcon v-else class="i i10" :size="10" />
      <span class="x" :class="{ mono: link.mono }">{{
        link.kind === 'pr' ? `PR #${link.target}` : link.label
      }}</span>
      <ArrowUpRight class="i i10 ext" :size="10" />
    </button>
    <WalkCopy
      v-if="link.copy"
      :value="link.copy"
      :what="link.kind === 'file' ? t('testWalk.copy.path') : t('testWalk.copy.url')"
    />
  </span>
</template>
