<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Container } from 'lucide-vue-next'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import { formatBytes } from './system-monitor-format'
import type { GcPrefs } from '../../../main/gc/gc-prefs'
import type { CycleRecord, OrphanVolumeItem } from '../../../main/gc/gc-wire'

/**
 * Docker region of the Cleanup screen (design.md "Workspace GC — unified Cleanup / Docker card").
 * The engine reports what the LAST cycle reclaimed of build cache and dangling images but no
 * pending size, so those two blocks say "size unavailable" rather than invent a number. Orphan
 * volumes are real: count, bytes, and the projects they came from.
 */
const props = defineProps<{
  orphanVolumes: { count: number; bytes: number }
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

function reclaimed(bytes: number | undefined): string {
  return bytes === undefined
    ? t('cleanup.gc.docker.unavailable')
    : t('cleanup.gc.docker.reclaimed', { size: formatBytes(bytes) })
}

const MAX_PROJECTS = 3
const projects = computed(() => [
  ...new Set(props.volumes.map((v) => v.project).filter((p): p is string => !!p))
])
const shownProjects = computed(() => projects.value.slice(0, MAX_PROJECTS).join(', '))
const moreProjects = computed(() => Math.max(0, projects.value.length - MAX_PROJECTS))

const blockClass = (on: boolean): string =>
  `flex min-w-[200px] flex-1 flex-col gap-1 rounded-[3px] border border-green-line bg-green-soft px-3 py-2 ${on ? '' : 'opacity-60'}`
</script>

<template>
  <section class="rounded border border-border bg-surface" data-testid="docker-card">
    <header class="flex items-center gap-2 px-3 py-2 text-text-2">
      <Container :size="14" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
      <span class="text-[12.5px] font-medium text-text">{{ t('cleanup.gc.docker.title') }}</span>
      <!-- The Containers takeover stays the inspector (per-stack start/stop); this is its door. -->
      <button
        type="button"
        class="ml-auto text-[11px] font-medium text-text-2 transition hover:text-text"
        data-testid="docker-inspect"
        @click="emit('inspect')"
      >
        {{ t('cleanup.gc.docker.inspect') }}
      </button>
    </header>
    <div class="flex flex-wrap gap-2 px-3 pb-3">
      <div :class="blockClass(prefs.categories.dockerCache)" data-testid="docker-cache">
        <div class="flex items-center gap-2">
          <span class="text-[12.5px] font-medium text-text">{{
            t('cleanup.gc.docker.buildCache')
          }}</span>
          <ToggleSwitch
            class="ml-auto"
            :model-value="prefs.categories.dockerCache"
            :aria-label="t('cleanup.gc.docker.toggleCache')"
            data-testid="docker-toggle-cache"
            @update:model-value="emit('toggle', 'dockerCache', $event)"
          />
        </div>
        <div class="text-[12.5px] text-green" data-testid="docker-cache-size">
          {{ reclaimed(housekeeping?.buildCacheBytes) }}
        </div>
        <div class="text-[11px] leading-4 text-text-3">
          {{
            t('cleanup.gc.docker.olderThan', prefs.cacheMaxAgeDays, {
              named: { n: prefs.cacheMaxAgeDays }
            })
          }}
        </div>
      </div>

      <div :class="blockClass(prefs.categories.dockerCache)" data-testid="docker-images">
        <div class="flex items-center gap-2">
          <span class="text-[12.5px] font-medium text-text">{{
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
        <div class="text-[12.5px] text-green" data-testid="docker-images-size">
          {{ reclaimed(housekeeping?.imageBytes) }}
        </div>
        <div class="text-[11px] leading-4 text-text-3">
          {{ t('cleanup.gc.docker.danglingSub') }}
        </div>
      </div>

      <div :class="blockClass(true)" data-testid="docker-volumes">
        <div class="flex items-center gap-2">
          <span class="text-[12.5px] font-medium text-text">{{
            t('cleanup.gc.docker.orphanVolumes')
          }}</span>
        </div>
        <div
          class="text-[12.5px]"
          :class="orphanVolumes.count === 0 ? 'text-text-3' : 'text-green'"
          data-testid="docker-volumes-size"
        >
          {{
            t('cleanup.gc.docker.volumesCount', orphanVolumes.count, {
              named: { n: orphanVolumes.count, size: formatBytes(orphanVolumes.bytes) }
            })
          }}
        </div>
        <div v-if="projects.length > 0" class="truncate text-[11px] leading-4 text-text-3">
          {{ t('cleanup.gc.docker.projects', { names: shownProjects }) }}
          <template v-if="moreProjects > 0">
            {{ t('cleanup.gc.docker.more', { n: moreProjects }) }}
          </template>
        </div>
        <span
          class="mt-1 inline-flex w-fit items-center rounded-full border border-warning-line bg-warning-soft px-2 py-0.5 text-[11px] leading-4 text-warning"
        >
          {{ t('cleanup.gc.docker.cantRestore') }}
        </span>
        <div class="text-[11px] leading-4 text-text-3" data-testid="docker-volumes-note">
          {{ t('cleanup.gc.docker.volumesNote') }}
        </div>
      </div>
    </div>
  </section>
</template>
