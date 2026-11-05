<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArchiveRestore, Copy, Folder, GitBranch } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import { relativeTime } from '../composables/useRelativeTime'
import { failureKey, freshWorktreeCommand, offersFreshWorktree } from '../lib/gc-shelved'
import type { ShelvedEntry } from '../../../main/gc/shelve-store'

/**
 * Shelved card of the Cleanup screen (design.md "Shelved card", autonomous cleanup U2.3a). Lists the
 * worktrees Harnu shelved (folder removed, branch and work kept) with one Restore button each. It
 * restores nothing itself: it asks the screen, which calls the same function a resume uses. A failed
 * restore is shown under its row with the next step, never only in a toast.
 */
const props = defineProps<{
  shelved: readonly ShelvedEntry[]
  /** Ids whose Restore is running. */
  busyIds?: ReadonlySet<string>
  /** Why the last Restore of an id failed (`reason` and `message` from the restore service). */
  failures?: ReadonlyMap<string, { reason?: string; message?: string }>
  /** The clock, so the dates are testable. */
  now?: number
}>()
const emit = defineEmits<{ restore: [id: string] }>()
const { t } = useI18n()

const copied = ref<string | null>(null)

const freed = computed(() => {
  const known = props.shelved.filter((e) => e.freedBytes !== null)
  return known.length === 0 ? null : known.reduce((sum, e) => sum + (e.freedBytes ?? 0), 0)
})
const sub = computed(() => {
  const n = props.shelved.length
  return freed.value === null
    ? t('cleanup.gc.shelved.subNoSize', n, { named: { n } })
    : t('cleanup.gc.shelved.sub', n, { named: { n, size: formatBytes(freed.value) } })
})

const nameOf = (e: ShelvedEntry): string =>
  e.worktreePath.split(/[\\/]/).filter(Boolean).pop() ?? e.worktreePath
const dateOf = (e: ShelvedEntry): string => relativeTime(new Date(e.shelvedAt).toISOString())
const failureOf = (e: ShelvedEntry) => props.failures?.get(e.id)

async function copy(e: ShelvedEntry): Promise<void> {
  await navigator.clipboard.writeText(freshWorktreeCommand(e))
  copied.value = e.id
  setTimeout(() => {
    if (copied.value === e.id) copied.value = null
  }, 1500)
}
</script>

<template>
  <section
    v-if="shelved.length > 0"
    class="rounded border border-border bg-surface"
    data-testid="shelved-card"
  >
    <header class="flex items-center gap-2 px-3 py-2 text-text-2">
      <ArchiveRestore :size="14" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
      <span class="text-ui font-medium text-text">{{ t('cleanup.gc.shelved.title') }}</span>
      <span class="text-caption text-text-4" data-testid="shelved-sub">{{ sub }}</span>
    </header>
    <p class="px-3 pb-2 text-caption leading-4 text-text-4" data-testid="shelved-note">
      {{ t('cleanup.gc.shelved.note') }}
    </p>

    <ul
      class="m-0 flex list-none flex-col gap-1 px-3 pb-3"
      :aria-label="t('cleanup.gc.shelved.listLabel')"
    >
      <li
        v-for="e in shelved"
        :key="e.id"
        class="rounded-sm border border-border bg-surface px-2.5 py-1.5"
        data-testid="shelved-row"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="inline-flex min-w-0 items-center gap-1.5 font-mono text-ui text-text">
            <Folder :size="12" :stroke-width="1.6" />
            <span class="truncate" :title="e.worktreePath">{{ nameOf(e) }}</span>
          </span>
          <span class="inline-flex min-w-0 items-center gap-1 font-mono text-caption text-text-3">
            <GitBranch :size="11" :stroke-width="1.6" />
            <span class="truncate">{{ e.branch ?? t('cleanup.gc.shelved.detached') }}</span>
          </span>
          <span class="text-caption text-text-3">{{
            t('cleanup.gc.shelved.idle', { n: e.idleDays })
          }}</span>
          <span class="text-caption text-text-3" :title="new Date(e.shelvedAt).toLocaleString()">{{
            dateOf(e)
          }}</span>
          <span v-if="e.freedBytes !== null" class="text-caption text-text-3">{{
            formatBytes(e.freedBytes)
          }}</span>
          <span class="ml-auto">
            <Button
              variant="soft"
              :disabled="busyIds?.has(e.id) === true"
              data-testid="shelved-restore"
              @click="emit('restore', e.id)"
            >
              {{
                busyIds?.has(e.id) === true
                  ? t('cleanup.gc.shelved.restoring')
                  : t('cleanup.gc.shelved.restore')
              }}
            </Button>
          </span>
        </div>

        <div
          v-if="failureOf(e)"
          class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-warning"
          data-testid="shelved-failure"
        >
          <span>{{
            t(`cleanup.gc.shelved.failure.${failureKey(failureOf(e)?.reason)}`, {
              message: failureOf(e)?.message ?? ''
            })
          }}</span>
          <button
            v-if="offersFreshWorktree(failureOf(e)?.reason)"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg px-2 py-0.75 text-eyebrow text-text-3 transition hover:border-border-2 hover:text-text-2"
            :title="freshWorktreeCommand(e)"
            data-testid="shelved-copy-command"
            @click="copy(e)"
          >
            <Copy :size="10" :stroke-width="1.7" />
            {{
              copied === e.id ? t('cleanup.gc.shelved.copied') : t('cleanup.gc.shelved.copyCommand')
            }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
