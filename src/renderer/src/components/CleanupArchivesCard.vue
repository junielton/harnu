<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranch,
  Folder,
  Trash2
} from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import { relativeTime } from '../composables/useRelativeTime'
import { coveredBy, expiredArchives } from '../../../main/gc/archives-core'
import type { ArchiveEntry, ArchiveRepoGroup, GcArchivesCard } from '../../../main/gc/gc-wire'

/**
 * Archives card of the Cleanup screen (design.md "Archives card"). Every removal Harnu makes writes
 * `refs/archive/**`; this lists them per repo (estimated size, source, date, tip, whether a working
 * state was kept, a copyable restore command) and offers to delete the ones past the retention. It
 * deletes nothing itself: it asks the screen to open the confirm dialog that lists them.
 */
const props = defineProps<{
  archives: GcArchivesCard
  /** The clock, so the "expired" word and the relative dates are testable. */
  now?: number
  /** The never-clean paths: archives under them are not offered for deletion (main re-checks). */
  neverClean?: readonly string[]
}>()
const emit = defineEmits<{
  /** Open the delete confirm for these entries of one repo. */
  delete: [group: ArchiveRepoGroup, entries: ArchiveEntry[]]
  /** Open the "Run git gc" confirm for one repo. */
  gc: [group: ArchiveRepoGroup]
}>()
const { t } = useI18n()

const clock = computed(() => props.now ?? Date.now())
const open = ref<ReadonlySet<string>>(new Set())
const copied = ref<string | null>(null)

const sub = computed(() => {
  const a = props.archives
  return a.bytes === null
    ? t('cleanup.gc.archives.subNoSize', a.count, { named: { n: a.count } })
    : t('cleanup.gc.archives.sub', a.count, { named: { n: a.count, size: formatBytes(a.bytes) } })
})

function groupSub(g: ArchiveRepoGroup): string {
  return g.bytes === null
    ? t('cleanup.gc.archives.subNoSize', g.count, { named: { n: g.count } })
    : t('cleanup.gc.archives.sub', g.count, { named: { n: g.count, size: formatBytes(g.bytes) } })
}

/** The repo, or the folder the archive came from, is on (or under) the never-clean list. */
const isProtected = (g: ArchiveRepoGroup, e: ArchiveEntry): boolean =>
  coveredBy(g.repoPath, props.neverClean ?? []) ||
  (e.folder !== null && coveredBy(e.folder, props.neverClean ?? []))

const expiredOf = (g: ArchiveRepoGroup): ArchiveEntry[] =>
  expiredArchives(g.entries, props.archives.keepDays, clock.value).filter((e) => !isProtected(g, e))

function toggle(g: ArchiveRepoGroup): void {
  const next = new Set(open.value)
  if (!next.delete(g.repoPath)) next.add(g.repoPath)
  open.value = next
}

/** The folder's name when the journal remembers it, else the branch, else the word "detached". */
function sourceOf(e: ArchiveEntry): {
  kind: 'folder' | 'branch' | 'detached' | 'unknown'
  text: string
} {
  if (e.folder)
    return { kind: 'folder', text: e.folder.split(/[\\/]/).filter(Boolean).pop() ?? e.folder }
  if (e.branch) return { kind: 'branch', text: e.branch }
  if (e.detached) return { kind: 'detached', text: t('cleanup.gc.archives.detached') }
  return { kind: 'unknown', text: t('cleanup.gc.archives.unknownSource') }
}

const dateOf = (e: ArchiveEntry): string =>
  e.ageKnown && Number.isFinite(e.at)
    ? relativeTime(new Date(e.at).toISOString())
    : t('cleanup.gc.archives.ageUnknown')
const absoluteDate = (e: ArchiveEntry): string =>
  e.ageKnown && Number.isFinite(e.at) ? new Date(e.at).toLocaleString() : ''

async function copy(id: string, text: string | null): Promise<void> {
  if (!text) return
  await navigator.clipboard.writeText(text)
  copied.value = id
  setTimeout(() => {
    if (copied.value === id) copied.value = null
  }, 1500)
}
</script>

<template>
  <section class="rounded border border-border bg-surface" data-testid="archives-card">
    <header class="flex items-center gap-2 px-3 py-2 text-text-2">
      <Archive :size="14" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
      <span class="text-ui font-medium text-text">{{ t('cleanup.gc.archives.title') }}</span>
      <span class="text-caption text-text-4" data-testid="archives-sub">{{ sub }}</span>
    </header>
    <p class="px-3 pb-2 text-caption leading-4 text-text-4" data-testid="archives-note">
      {{ t('cleanup.gc.archives.note') }}
      {{
        t('cleanup.gc.archives.retention', archives.keepDays, {
          named: { n: archives.keepDays, k: archives.expiredCount }
        })
      }}
    </p>

    <div class="flex flex-col gap-1.5 px-3 pb-3">
      <div
        v-for="g in archives.repos"
        :key="g.repoPath"
        class="rounded-sm border border-border bg-bg"
        data-testid="archives-repo"
      >
        <div class="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
          <button
            type="button"
            class="inline-flex min-w-0 items-center gap-1.5 text-left text-ui text-text transition hover:text-accent"
            :aria-expanded="open.has(g.repoPath)"
            :aria-label="t('cleanup.gc.archives.toggleRepo', { repo: g.repoAlias })"
            data-testid="archives-repo-toggle"
            @click="toggle(g)"
          >
            <ChevronDown v-if="open.has(g.repoPath)" :size="12" :stroke-width="1.7" />
            <ChevronRight v-else :size="12" :stroke-width="1.7" />
            <span class="truncate font-mono">{{ g.repoAlias }}</span>
          </button>
          <span class="text-caption text-text-4" data-testid="archives-repo-sub">{{
            groupSub(g)
          }}</span>
          <span class="ml-auto flex items-center gap-2">
            <Button
              v-if="expiredOf(g).length > 0"
              variant="soft"
              data-testid="archives-delete-older"
              @click="emit('delete', g, expiredOf(g))"
            >
              {{
                t('cleanup.gc.archives.deleteOlder', archives.keepDays, {
                  named: { k: expiredOf(g).length, n: archives.keepDays }
                })
              }}
            </Button>
            <button
              type="button"
              class="text-caption font-medium text-text-2 transition hover:text-text"
              data-testid="archives-gc"
              @click="emit('gc', g)"
            >
              {{ t('cleanup.gc.archives.gcNow') }}
            </button>
          </span>
        </div>

        <ul
          v-if="open.has(g.repoPath)"
          class="scrollable m-0 flex max-h-64 list-none flex-col gap-1 overflow-y-auto border-t border-border p-2"
          :aria-label="t('cleanup.gc.archives.listLabel', { repo: g.repoAlias })"
          data-testid="archives-list"
        >
          <li
            v-for="e in g.entries"
            :key="e.namespace"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border bg-surface px-2.5 py-1.5"
            data-testid="archive-row"
          >
            <span
              class="inline-flex min-w-0 items-center gap-1.5 font-mono text-ui text-text"
              :data-source="sourceOf(e).kind"
              data-testid="archive-source"
            >
              <Folder v-if="sourceOf(e).kind === 'folder'" :size="12" :stroke-width="1.6" />
              <GitBranch v-else :size="12" :stroke-width="1.6" />
              <span class="truncate">{{ sourceOf(e).text }}</span>
            </span>
            <span
              v-if="sourceOf(e).kind === 'folder' && e.branch"
              class="truncate font-mono text-caption text-text-3"
              >{{ e.branch }}</span
            >
            <span
              class="text-caption text-text-3"
              :title="absoluteDate(e)"
              data-testid="archive-date"
              >{{ dateOf(e) }}</span
            >
            <span
              class="font-mono text-caption text-text-3"
              :title="e.tipSha ?? ''"
              data-testid="archive-tip"
              >{{
                e.tipSha ? t('cleanup.gc.archives.tip', { sha: e.tipSha.slice(0, 7) }) : '—'
              }}</span
            >
            <span
              v-if="e.hasWip"
              class="inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 text-eyebrow text-text-3"
              :title="t('cleanup.gc.archives.wipTitle')"
              data-testid="archive-wip"
              >{{ t('cleanup.gc.archives.wip') }}</span
            >
            <span
              v-if="expiredArchives([e], archives.keepDays, clock).length > 0"
              class="text-caption text-warning"
              data-testid="archive-expired"
              >{{ t('cleanup.gc.archives.expired') }}</span
            >
            <span class="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg px-2 py-0.75 text-eyebrow text-text-3 transition hover:border-red-line hover:text-red"
                :disabled="isProtected(g, e)"
                :title="isProtected(g, e) ? t('cleanup.gc.archives.protected') : undefined"
                data-testid="archive-delete"
                @click="!isProtected(g, e) && emit('delete', g, [e])"
              >
                <Trash2 :size="10" :stroke-width="1.7" />
                {{ t('cleanup.gc.archives.deleteOne') }}
              </button>
              <button
                v-if="e.restoreCommand"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg px-2 py-0.75 text-eyebrow text-text-3 transition hover:border-border-2 hover:text-text-2"
                :title="e.restoreCommand"
                data-testid="archive-copy"
                @click="copy(e.namespace, e.restoreCommand)"
              >
                <Copy :size="10" :stroke-width="1.7" />
                {{
                  copied === e.namespace
                    ? t('cleanup.gc.archives.copied')
                    : t('cleanup.gc.archives.copyRestore')
                }}
              </button>
              <button
                v-if="e.wipRestoreCommand"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg px-2 py-0.75 text-eyebrow text-text-3 transition hover:border-border-2 hover:text-text-2"
                :title="e.wipRestoreCommand"
                data-testid="archive-copy-wip"
                @click="copy(`${e.namespace}#wip`, e.wipRestoreCommand)"
              >
                <Copy :size="10" :stroke-width="1.7" />
                {{
                  copied === `${e.namespace}#wip`
                    ? t('cleanup.gc.archives.copied')
                    : t('cleanup.gc.archives.copyWip')
                }}
              </button>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
