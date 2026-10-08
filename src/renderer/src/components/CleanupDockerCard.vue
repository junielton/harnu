<script setup lang="ts">
import { computed } from 'vue'
import { I18nT, useI18n } from 'vue-i18n'
import { Container, EyeOff } from 'lucide-vue-next'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import { formatBytes } from './system-monitor-format'
import type { GcPrefs } from '../../../main/gc/gc-prefs'
import type { CycleRecord, GcDockerCard, OrphanVolumeItem } from '../../../main/gc/gc-wire'

/**
 * Docker region of the Cleanup screen (design.md "Workspace GC — unified Cleanup / Docker card").
 * The engine reports what the LAST cycle reclaimed of build cache and dangling images but no
 * pending size, so those two blocks say "size unavailable" rather than invent a number. Orphan
 * volumes are real: count, bytes, and the projects they came from.
 */
const props = defineProps<{
  orphanVolumes: { count: number; bytes: number }
  /** What Docker could reclaim now; each figure is null when Docker did not answer for it. */
  docker: GcDockerCard
  volumes: OrphanVolumeItem[]
  lastCycle: CycleRecord | null
  prefs: GcPrefs
}>()
const emit = defineEmits<{
  toggle: [category: 'dockerCache', value: boolean]
  inspect: []
}>()
const { t } = useI18n()

const housekeeping = computed(() => props.lastCycle?.housekeeping ?? null)

/** What the last automatic cycle reclaimed; empty before the first cycle has run. */
function reclaimed(bytes: number | undefined): string {
  return bytes === undefined ? '' : t('cleanup.gc.docker.reclaimed', { size: formatBytes(bytes) })
}

/** Build cache a prune could reclaim now; null means Docker did not answer, never a confident zero. */
const cacheNow = computed(() =>
  props.docker.buildCacheReclaimableBytes === null
    ? t('cleanup.gc.docker.unavailable')
    : t('cleanup.gc.docker.reclaimable', {
        size: formatBytes(props.docker.buildCacheReclaimableBytes)
      })
)

const imagesNow = computed(() => {
  const d = props.docker.danglingImages
  return d === null
    ? t('cleanup.gc.docker.unavailable')
    : t('cleanup.gc.docker.imagesCount', d.count, {
        named: { n: d.count, size: formatBytes(d.bytes) }
      })
})

/**
 * Why the orphan list is empty when it is empty by construction (an unresolved compose project name, or a
 * compose scan cut short); null when nothing is hidden. The folders are shown as basenames.
 */
const hidden = computed(() => {
  const h = props.docker.orphanVolumesHidden
  if (!h) return null
  return {
    key: h.reason === 'scan-limit' ? 'scanLimit' : 'unresolvedCompose',
    folders: h.folders.map((path) => ({
      path,
      name:
        path
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() || path
    }))
  }
})

const MAX_PROJECTS = 3
const projects = computed(() => [
  ...new Set(props.volumes.map((v) => v.project).filter((p): p is string => !!p))
])
const shownProjects = computed(() => projects.value.slice(0, MAX_PROJECTS).join(', '))
const moreProjects = computed(() => Math.max(0, projects.value.length - MAX_PROJECTS))

/** Ready green for what the autopilot takes (cache, images); the review (warning) triple for orphan volumes. */
const TONE: Record<'ready' | 'review', string> = {
  ready: 'border-green-line bg-green-soft',
  review: 'border-warning-line bg-warning-soft'
}
const blockClass = (on: boolean, tone: 'ready' | 'review' = 'ready'): string =>
  `flex min-w-50 flex-1 flex-col gap-1 rounded-xs border px-3 py-2 ${TONE[tone]} ${on ? '' : 'opacity-60'}`

/** What the next cycle could reclaim from Docker (cache + dangling images), when the autopilot cleans it. */
const nextCycleBytes = computed(
  () => (props.docker.buildCacheReclaimableBytes ?? 0) + (props.docker.danglingImages?.bytes ?? 0)
)
const subtitle = computed(() => {
  if (!props.prefs.categories.dockerCache) return t('cleanup.gc.docker.sub.off')
  return nextCycleBytes.value > 0
    ? t('cleanup.gc.docker.sub.size', { size: formatBytes(nextCycleBytes.value) })
    : t('cleanup.gc.docker.sub.plain')
})

/** The three Docker figures by bytes: cache and images are what a cycle takes, volumes what you review. */
const splitSegments = computed(() =>
  [
    { key: 'cache', bytes: props.docker.buildCacheReclaimableBytes ?? 0, tone: 'bg-green' },
    { key: 'images', bytes: props.docker.danglingImages?.bytes ?? 0, tone: 'bg-green' },
    { key: 'volumes', bytes: props.orphanVolumes.bytes, tone: 'bg-warning' }
  ].filter((x) => x.bytes > 0)
)
</script>

<template>
  <section class="rounded border border-border bg-surface" data-testid="docker-card">
    <header class="flex items-center gap-2 px-3 py-2 text-text-2">
      <Container :size="14" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
      <span class="text-ui font-medium text-text">{{ t('cleanup.gc.docker.title') }}</span>
      <span class="text-caption text-text-4" data-testid="docker-sub">{{ subtitle }}</span>
      <!-- The Containers takeover stays the inspector (per-stack start/stop); this is its door. -->
      <button
        type="button"
        class="ml-auto text-caption font-medium text-text-2 transition hover:text-text"
        data-testid="docker-inspect"
        @click="emit('inspect')"
      >
        {{ t('cleanup.gc.docker.inspect') }}
      </button>
    </header>
    <div
      v-if="splitSegments.length > 0"
      class="mx-3 mb-2 flex h-1 gap-0.5"
      role="img"
      :aria-label="t('cleanup.gc.docker.splitLabel')"
      data-testid="docker-split"
    >
      <span
        v-for="seg in splitSegments"
        :key="seg.key"
        class="rounded-full"
        :class="seg.tone"
        :style="{ flex: String(seg.bytes) }"
        :data-seg="seg.key"
      />
    </div>
    <div class="flex flex-wrap gap-2 px-3 pb-3">
      <div :class="blockClass(prefs.categories.dockerCache)" data-testid="docker-cache">
        <div class="flex items-center gap-2">
          <span class="text-ui font-medium text-text">{{ t('cleanup.gc.docker.buildCache') }}</span>
          <ToggleSwitch
            class="ml-auto"
            :model-value="prefs.categories.dockerCache"
            :aria-label="t('cleanup.gc.docker.toggleCache')"
            data-testid="docker-toggle-cache"
            @update:model-value="emit('toggle', 'dockerCache', $event)"
          />
        </div>
        <div
          class="text-ui"
          :class="docker.buildCacheReclaimableBytes === null ? 'text-text-3' : 'text-green'"
          data-testid="docker-cache-size"
        >
          {{ cacheNow }}
        </div>
        <div
          v-if="housekeeping"
          class="text-caption leading-4 text-text-3"
          data-testid="docker-cache-last"
        >
          {{ reclaimed(housekeeping.buildCacheBytes) }}
        </div>
        <div class="text-caption leading-4 text-text-3">
          {{
            t('cleanup.gc.docker.olderThan', prefs.cacheMaxAgeDays, {
              named: { n: prefs.cacheMaxAgeDays }
            })
          }}
        </div>
      </div>

      <div :class="blockClass(prefs.categories.dockerCache)" data-testid="docker-images">
        <div class="flex items-center gap-2">
          <span class="text-ui font-medium text-text">{{
            t('cleanup.gc.docker.danglingImages')
          }}</span>
          <ToggleSwitch
            class="ml-auto"
            :model-value="prefs.categories.dockerCache"
            :aria-label="t('cleanup.gc.docker.toggleImages')"
            data-testid="docker-toggle-images"
            @update:model-value="emit('toggle', 'dockerCache', $event)"
          />
        </div>
        <div
          class="text-ui"
          :class="docker.danglingImages === null ? 'text-text-3' : 'text-green'"
          data-testid="docker-images-size"
        >
          {{ imagesNow }}
        </div>
        <div
          v-if="housekeeping"
          class="text-caption leading-4 text-text-3"
          data-testid="docker-images-last"
        >
          {{ reclaimed(housekeeping.imageBytes) }}
        </div>
        <div class="text-caption leading-4 text-text-3">
          {{ t('cleanup.gc.docker.danglingSub') }}
        </div>
      </div>

      <div :class="blockClass(true, 'review')" data-testid="docker-volumes">
        <div class="flex items-center gap-2">
          <span class="text-ui font-medium text-text">{{
            t('cleanup.gc.docker.orphanVolumes')
          }}</span>
        </div>
        <div
          class="text-ui"
          :class="hidden || orphanVolumes.count > 0 ? 'text-warning' : 'text-text-3'"
          data-testid="docker-volumes-size"
        >
          {{
            hidden
              ? t('cleanup.gc.docker.hidden.size')
              : t('cleanup.gc.docker.volumesCount', orphanVolumes.count, {
                  named: { n: orphanVolumes.count, size: formatBytes(orphanVolumes.bytes) }
                })
          }}
        </div>
        <div
          v-if="hidden"
          class="flex items-start gap-1.5 text-caption text-warning"
          role="note"
          data-testid="docker-hidden"
        >
          <EyeOff :size="12" :stroke-width="1.7" class="mt-0.5 shrink-0" aria-hidden="true" />
          <I18nT :keypath="`cleanup.gc.docker.hidden.${hidden.key}`" tag="span" scope="global">
            <template #folders>
              <span v-for="(f, i) in hidden.folders" :key="f.path">
                <span :title="f.path" class="font-mono" data-testid="docker-hidden-folder">{{
                  f.name
                }}</span
                ><template v-if="i < hidden.folders.length - 1">, </template>
              </span>
            </template>
          </I18nT>
        </div>
        <div v-if="projects.length > 0" class="truncate text-caption text-text-3">
          {{ t('cleanup.gc.docker.projects', { names: shownProjects }) }}
          <template v-if="moreProjects > 0">
            {{ t('cleanup.gc.docker.more', { n: moreProjects }) }}
          </template>
        </div>
        <span
          class="mt-1 inline-flex w-fit items-center rounded-full border border-warning-line bg-warning-soft px-2 py-0.5 text-caption text-warning"
        >
          {{ t('cleanup.gc.docker.cantRestore') }}
        </span>
        <div class="text-caption leading-4 text-text-3" data-testid="docker-volumes-note">
          {{ t('cleanup.gc.docker.volumesNote') }}
        </div>
      </div>
    </div>
  </section>
</template>
