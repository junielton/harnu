<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Pause, RadioTower, X } from 'lucide-vue-next'
import Button from './ui/Button.vue'

/**
 * The per-session actions of the System Monitor (design.md "System Monitor
 * (takeover)" → "Per-session actions"): Test Harnu mod channel, Park now, Close.
 * Shared by the card and the table row, so both keep the same behaviour.
 *
 * Invisible at rest and shown on hover and on keyboard focus of the owning
 * `.group` (card / row). Every slot keeps its 22×22px box — an invisible
 * placeholder where an action is absent — so nothing shifts and the pip, chip and
 * mod cell sit at the same x on every row.
 */
defineProps<{
  /** Park now renders only for a live, resumable session. */
  showPark: boolean
  /** Test Harnu mod channel renders only for a live session whose Harnu mod is live. */
  showPing: boolean
}>()
const emit = defineEmits<{ park: []; close: []; pingChannel: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="flex shrink-0 items-center gap-0.5 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100"
    data-testid="session-actions"
  >
    <Button
      v-if="showPing"
      variant="ghost"
      size="icon"
      :title="t('harnuMod.channel.test')"
      :aria-label="t('harnuMod.channel.test')"
      @click.stop="emit('pingChannel')"
    >
      <RadioTower :size="12" :stroke-width="2" class="text-text-3" />
    </Button>
    <span v-else class="h-[22px] w-[22px] shrink-0" aria-hidden="true" />
    <Button
      v-if="showPark"
      variant="ghost"
      size="icon"
      :title="t('systemMonitor.actions.park')"
      :aria-label="t('systemMonitor.actions.park')"
      @click.stop="emit('park')"
    >
      <Pause :size="12" :stroke-width="2" class="text-warning" />
    </Button>
    <span v-else class="h-[22px] w-[22px] shrink-0" aria-hidden="true" />
    <Button
      variant="ghost"
      size="icon"
      :title="t('systemMonitor.actions.close')"
      :aria-label="t('systemMonitor.actions.close')"
      @click.stop="emit('close')"
    >
      <X :size="12" :stroke-width="2" class="text-red" />
    </Button>
  </div>
</template>
