<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, GitBranch, Archive, Cloud, TriangleAlert } from 'lucide-vue-next'
import { useReaperStore } from '../stores/reaper'
import { formatBytes } from './system-monitor-format'
import { identText, identTitle } from './cleanup-ident'
import { reasonLine } from './cleanup-row'
import CleanupTimeline from './CleanupTimeline.vue'
import SweepConfirmDialog from './SweepConfirmDialog.vue'
import Button from './ui/Button.vue'
import type { ReapItem, ReapItemKind } from '../../../preload'

/**
 * "Other leftovers" (design.md "Workspace GC — unified Cleanup", entity map): the Reaper items the GC
 * bundle does not cover — local branches, remote branches and hidden folders. Worktrees live on the
 * map; these keep the row UI and `SweepConfirmDialog` they always had, so folding the screens into
 * one door loses no capability. Renders nothing when there is nothing to show.
 */
const store = useReaperStore()
const { t } = useI18n()

const OTHER_KINDS: ReadonlySet<ReapItemKind> = new Set([
  'local-branch',
  'remote-branch',
  'hidden-folder'
])

const KIND_ICON: Record<string, Component> = {
  'local-branch': GitBranch,
  'remote-branch': Cloud,
  'hidden-folder': Archive
}

const KIND_LABEL: Record<string, string> = {
  'local-branch': 'localBranch',
  'remote-branch': 'remoteBranch',
  'hidden-folder': 'hiddenFolder'
}

const rows = computed<ReapItem[]>(() =>
  store.repoGroups.flatMap((g) => g.items.filter((i) => OTHER_KINDS.has(i.kind)))
)
const harvestable = computed(() => rows.value.filter((i) => i.verdict === 'harvestable'))
const harvestableBytes = computed(() =>
  harvestable.value.reduce((a, i) => a + (i.diskBytes ?? 0), 0)
)

const sweepItems = ref<ReapItem[] | null>(null)

function openSweepAll(): void {
  if (sweepItems.value || harvestable.value.length === 0) return
  sweepItems.value = [...harvestable.value]
}
function openSweepOne(item: ReapItem): void {
  if (sweepItems.value) return
  sweepItems.value = [item]
}

function repoLabel(item: ReapItem): string {
  return item.repoPath.split('/').pop() ?? item.repoPath
}
</script>

<template>
  <section v-if="rows.length > 0" class="px-5.5 pb-2 pt-4" data-testid="cleanup-other">
    <div class="flex items-center gap-3 pb-2">
      <span class="eyebrow text-text-4">
        {{ t('cleanup.gc.other.title') }}
      </span>
      <span class="text-caption text-text-4">{{ t('cleanup.gc.other.intro') }}</span>
      <Button
        v-if="harvestable.length > 0"
        class="ml-auto"
        variant="success"
        :disabled="sweepItems !== null"
        data-testid="cleanup-other-sweep"
        @click="openSweepAll()"
      >
        {{ t('cleanup.sweep', { count: harvestable.length, size: formatBytes(harvestableBytes) }) }}
      </Button>
    </div>

    <div
      v-for="item in rows"
      :key="item.id"
      class="grid min-h-12 grid-cols-[20px_240px_1fr_150px_40px] items-center gap-3.5 rounded border border-transparent p-2 hover:border-border hover:bg-surface"
      data-testid="cleanup-other-row"
    >
      <component
        :is="KIND_ICON[item.kind]"
        :size="14"
        :stroke-width="1.6"
        class="text-text-4"
        :title="t(`cleanup.kind.${KIND_LABEL[item.kind]}`)"
      />
      <span class="flex min-w-0 flex-col gap-0.75" :title="identTitle(item)">
        <span class="truncate font-mono text-ui text-text">{{ identText(item) }}</span>
        <span class="block truncate text-eyebrow text-text-4">
          {{ repoLabel(item) }} · {{ t(`cleanup.kind.${KIND_LABEL[item.kind]}`)
          }}<template v-if="item.diskBytes !== null"> · {{ formatBytes(item.diskBytes) }}</template>
        </span>
      </span>
      <CleanupTimeline :checkpoints="item.checkpoints" />
      <span class="flex min-w-0 flex-col items-end gap-1" :title="reasonLine(item, t)?.title">
        <span
          v-if="item.verdict === 'harvestable'"
          class="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-green-soft px-2.5 py-0.75 text-eyebrow font-semibold text-green"
        >
          {{
            item.needsRemoteDelete
              ? t('cleanup.verdict.harvestableRemote')
              : t('cleanup.verdict.harvestable')
          }}
          <TriangleAlert
            v-if="item.needsRemoteDelete"
            :size="10"
            :stroke-width="2"
            class="text-warning"
          />
        </span>
        <span
          v-else-if="item.verdict === 'blocked'"
          class="whitespace-nowrap rounded-full bg-red-soft px-2.5 py-0.75 text-eyebrow font-semibold text-red"
        >
          {{ t('cleanup.verdict.blocked') }}
        </span>
        <span
          v-else
          class="whitespace-nowrap rounded-full bg-surface-2 px-2.5 py-0.75 text-eyebrow font-semibold text-text-3"
        >
          {{ t('cleanup.verdict.unknown') }}
        </span>
        <span
          v-if="reasonLine(item, t)"
          class="block max-w-full truncate text-right text-eyebrow text-text-4"
          >{{ reasonLine(item, t)!.text }}</span
        >
      </span>
      <span class="flex justify-end">
        <button
          v-if="item.verdict === 'harvestable'"
          class="flex h-6.5 w-6.5 items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:border-red hover:bg-red-soft hover:text-red disabled:cursor-not-allowed disabled:opacity-40"
          :aria-label="t('cleanup.trashTitle', { what: identText(item) })"
          :title="t('cleanup.trashTitle', { what: identText(item) })"
          :disabled="sweepItems !== null"
          data-testid="cleanup-other-trash"
          @click="openSweepOne(item)"
        >
          <Trash2 :size="13" :stroke-width="1.7" />
        </button>
      </span>
    </div>

    <SweepConfirmDialog v-if="sweepItems" :items="sweepItems" @close="sweepItems = null" />
  </section>
</template>
