<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Info } from 'lucide-vue-next'
import type { SlotsState } from '../lib/docker-card-view'

/**
 * "Docker networks" block of the Docker card (design.md "Capacity, Paused and Automatic actions",
 * U3.7): how many bridge-network slots are free, as a number and a gauge, or why they are unknown.
 */
const props = defineProps<{ state: SlotsState; mark: number }>()
const { t } = useI18n()

const level = computed(() => (props.state.kind === 'known' ? props.state.level : null))
const numberTone = computed(() =>
  level.value === 'zero' ? 'text-red' : level.value === 'low' ? 'text-warning' : 'text-green'
)
const gaugeTone = computed(() =>
  level.value === 'zero' ? 'bg-red' : level.value === 'low' ? 'bg-warning' : 'bg-green'
)

const caption = computed(() => {
  const s = props.state
  if (s.kind !== 'known') return ''
  const suffix = s.autonomy === 'off' ? 'Off' : s.autonomy === 'paused' ? 'Paused' : ''
  if (s.level === 'zero') return t(`cleanup.gc.docker.slots.zero${suffix}`)
  if (s.level === 'low') return t(`cleanup.gc.docker.slots.low${suffix}`, { mark: props.mark })
  return t(
    s.source === 'default'
      ? 'cleanup.gc.docker.slots.captionDefault'
      : 'cleanup.gc.docker.slots.captionCustom',
    { mark: props.mark }
  )
})

const freeLabel = computed(() =>
  props.state.kind === 'known'
    ? t('cleanup.gc.docker.slots.free', { free: props.state.free, total: props.state.total })
    : ''
)
</script>

<template>
  <div
    class="flex flex-col gap-1 rounded-xs border border-border bg-surface-2 px-3 py-2"
    data-testid="docker-slots"
  >
    <div class="flex items-center gap-2">
      <span class="text-ui font-medium text-text">{{ t('cleanup.gc.docker.slots.title') }}</span>
      <span
        v-if="level === 'low'"
        class="ml-auto inline-flex items-center rounded-full border border-warning-line bg-warning-soft px-2 py-0.5 text-caption text-warning"
        data-testid="docker-slots-badge"
        >{{ t('cleanup.gc.docker.slots.badgeLow') }}</span
      >
      <span
        v-else-if="level === 'zero'"
        class="ml-auto inline-flex items-center rounded-full border border-red-line bg-red-soft px-2 py-0.5 text-caption text-red"
        data-testid="docker-slots-badge"
        >{{ t('cleanup.gc.docker.slots.badgeZero') }}</span
      >
      <span
        v-else-if="state.kind === 'unknown'"
        class="ml-auto inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-caption text-text-3"
        data-testid="docker-slots-badge"
        >{{ t('cleanup.gc.docker.slots.badgeUnknown') }}</span
      >
    </div>

    <template v-if="state.kind === 'known'">
      <div class="text-ui tabular-nums" :class="numberTone" data-testid="docker-slots-free">
        {{ freeLabel }}
      </div>
      <div
        class="flex h-1 gap-0.5"
        role="img"
        :aria-label="freeLabel"
        data-testid="docker-slots-gauge"
      >
        <span
          v-if="state.free > 0"
          class="rounded-full"
          :class="gaugeTone"
          :style="{ flex: String(state.free) }"
        />
        <span
          v-if="state.total - state.free > 0"
          class="rounded-full bg-border-2"
          :style="{ flex: String(state.total - state.free) }"
        />
      </div>
      <div class="text-caption leading-4 text-text-3" data-testid="docker-slots-caption">
        {{ caption }}
      </div>
    </template>

    <template v-else>
      <div class="flex items-center gap-1.5 text-ui text-text-3" data-testid="docker-slots-unknown">
        <Info :size="12" :stroke-width="1.7" class="shrink-0" aria-hidden="true" />
        {{ t('cleanup.gc.docker.slots.unknown') }}
      </div>
      <div class="text-caption leading-4 text-text-3" data-testid="docker-slots-reason">
        {{ state.reason ?? t('cleanup.gc.docker.slots.unknownFallback') }}
      </div>
      <div class="text-caption leading-4 text-text-4">
        {{ t('cleanup.gc.docker.slots.stillCleans') }}
      </div>
    </template>
  </div>
</template>
