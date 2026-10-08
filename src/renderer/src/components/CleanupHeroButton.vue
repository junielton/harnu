<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Recycle } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'
import type { HeroState } from '../lib/gc-model'

/**
 * The hero of the Cleanup screen (design.md "Workspace GC — unified Cleanup / Hero button and
 * progress chip"): the screen's single Primary button, `Clean N ready · X`, that turns into a
 * progress chip while a clean runs. It never awaits anything — the chip is fed by `gc:progress`
 * through the store, and there is no cancel because the engine has none.
 */
const props = defineProps<{ hero: HeroState }>()
const emit = defineEmits<{ click: [] }>()
const { t } = useI18n()

const cleanLabel = computed(() =>
  props.hero.kind === 'clean'
    ? t('cleanup.gc.hero.clean', props.hero.count, {
        named: { n: props.hero.count, size: formatBytes(props.hero.bytes) }
      })
    : ''
)

const chipLabel = computed(() =>
  props.hero.kind === 'running'
    ? t('cleanup.gc.hero.chip', {
        done: props.hero.done,
        total: props.hero.total,
        size: formatBytes(props.hero.freedBytes)
      })
    : ''
)

/** The bar counts items, not bytes: `3/12` can be 1.4 GB or 4 GB. */
const pct = computed(() => {
  if (props.hero.kind !== 'running' || props.hero.total <= 0) return 0
  return Math.min(100, Math.round((props.hero.done / props.hero.total) * 100))
})
</script>

<template>
  <Button
    v-if="hero.kind === 'clean'"
    :variant="hero.soft ? 'soft' : 'primary'"
    data-testid="hero-clean"
    @click="emit('click')"
  >
    <Recycle :size="14" :stroke-width="1.6" class="shrink-0" />
    {{ cleanLabel }}
  </Button>

  <!-- Nothing to clean keeps its label: the state is readable, not just dimmed. -->
  <Button v-else-if="hero.kind === 'empty'" variant="soft" disabled data-testid="hero-empty">
    <Recycle :size="14" :stroke-width="1.6" class="shrink-0" />
    {{ t('cleanup.gc.hero.empty') }}
  </Button>

  <div
    v-else
    role="status"
    aria-live="polite"
    data-testid="hero-chip"
    class="inline-flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm border border-accent-line bg-accent-soft px-3 text-[12.5px] font-medium text-accent"
  >
    <span
      class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_var(--color-accent-soft)]"
      aria-hidden="true"
    />
    <span class="text-text">{{ chipLabel }}</span>
    <span class="inline-block h-1 w-10 overflow-hidden rounded-full bg-border-2" aria-hidden="true">
      <i
        class="block h-full rounded-full bg-accent"
        :style="{ width: `${pct}%` }"
        data-testid="hero-chip-bar"
      />
    </span>
  </div>
</template>
