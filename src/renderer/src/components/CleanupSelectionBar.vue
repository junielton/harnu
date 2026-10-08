<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { SquareCheck, Sparkles } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'

/**
 * Multi-select band of the Cleanup takeover (design.md "Workspace GC — unified Cleanup / Page
 * anatomy" #3). Shown only while at least one Needs review block is checked. "Ask for an opinion" is
 * drawn but disabled until the opinion helper (S6) exists.
 */
withDefaults(defineProps<{ count: number; bytes: number; canKeep?: boolean }>(), { canKeep: true })
const emit = defineEmits<{ remove: []; dehydrate: []; keep: []; clear: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    v-if="count > 0"
    role="region"
    :aria-label="t('cleanup.gc.selection.label')"
    class="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-5.5 py-2"
    data-testid="selection-bar"
  >
    <SquareCheck :size="14" :stroke-width="1.6" class="shrink-0 text-accent" aria-hidden="true" />
    <span class="mr-2 text-body text-text-2" data-testid="sel-count">
      <i18n-t keypath="cleanup.gc.selection.count" scope="global">
        <template #count>
          <b class="font-semibold text-text">{{ count }}</b>
        </template>
        <template #size>
          <b class="font-semibold text-text">{{ formatBytes(bytes) }}</b>
        </template>
      </i18n-t>
    </span>
    <Button variant="danger" data-testid="sel-remove" @click="emit('remove')">
      {{ t('cleanup.gc.selection.remove') }}
    </Button>
    <Button variant="soft" data-testid="sel-dehydrate" @click="emit('dehydrate')">
      {{ t('cleanup.gc.selection.dehydrate') }}
    </Button>
    <Button v-if="canKeep" variant="ghost" data-testid="sel-keep" @click="emit('keep')">
      {{ t('cleanup.gc.selection.keep') }}
    </Button>
    <!-- A disabled button swallows hover, so the tooltip rides on a wrapper. -->
    <span :title="t('cleanup.gc.selection.askSoon')" class="inline-flex">
      <Button variant="soft" disabled data-testid="sel-ask">
        <Sparkles :size="13" :stroke-width="1.6" class="shrink-0" />
        {{ t('cleanup.gc.selection.ask') }}
      </Button>
    </span>
    <span class="inline-flex items-center gap-1.5 text-caption text-text-3">
      <kbd
        class="rounded-xs border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-eyebrow text-text-3"
        >⇧</kbd
      >
      {{ t('cleanup.gc.selection.shiftHint') }}
    </span>
    <button
      type="button"
      class="ml-auto text-caption text-text-3 transition hover:text-text"
      data-testid="sel-clear"
      @click="emit('clear')"
    >
      {{ t('cleanup.gc.selection.clear') }}
    </button>
  </div>
</template>
