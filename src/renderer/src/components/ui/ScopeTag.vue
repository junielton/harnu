<script setup lang="ts">
import { computed } from 'vue'
import { GitFork } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { BlockScope } from '../folder-view-format'

/**
 * T285 — the chip that says whether a Folder View block describes the folder you
 * clicked or the whole repo. design.md §6 "Folder View → Scope is the organising
 * idea".
 *
 * Half the Folder View is repo-wide (`hot.md`, the roadmap counts, the worktree
 * list all collapse onto the repo's main checkout), and printed untagged it read
 * as a description of the folder. The `repo` variant is the loud one — a
 * `--border-2` edge plus a fork icon — because a repo-wide block is the one that
 * lies when you read it as local; `this folder` stays plain.
 *
 * Deliberately quieter than the `eyebrow` it sits beside: no uppercase, no
 * tracking. It qualifies the label, it does not compete with it.
 */

const props = defineProps<{ scope: BlockScope }>()

const { t } = useI18n()

const label = computed(() =>
  props.scope === 'repo' ? t('folderView.scope.repo') : t('folderView.scope.thisFolder')
)

const hint = computed(() =>
  props.scope === 'repo' ? t('folderView.scope.repoHint') : t('folderView.scope.thisFolderHint')
)
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center border text-text-4"
    :class="scope === 'repo' ? 'border-border-2' : 'border-border'"
    style="gap: 5px; border-radius: 3px; padding: 0 5px; font-size: 10px; line-height: 14px"
    :title="hint"
    data-test="folder-view-scope-tag"
    :data-scope="scope"
  >
    <GitFork v-if="scope === 'repo'" :size="9" :stroke-width="1.6" />
    {{ label }}
  </span>
</template>
