<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GcOpinion } from '../../../main/gc/gc-wire'

/**
 * The verdict of "Ask for an opinion" on one Needs review item (design.md "Workspace GC — unified
 * Cleanup / Opinion chip"): a Badge in words — safe (Success), keep (Accent), unsure (Default) —
 * whose tooltip is the reason and the evidence. While a request is in flight it reads "Asking…".
 * Nothing is drawn for an item nobody asked about. Advisory only: the chip never acts.
 */
const props = defineProps<{
  opinion: GcOpinion | null
  pending: boolean
  /** The evidence as a visible line under the chip (the remove dialog), not only in the tooltip. */
  showEvidence?: boolean
}>()

const { t } = useI18n()

const VARIANT = {
  safe: 'border-green-line bg-green-soft text-green',
  keep: 'border-accent-line bg-accent-soft text-accent',
  unsure: 'border-border bg-surface text-text-3'
} as const

const verdictWord = computed(() =>
  props.opinion ? t(`cleanup.gc.opinion.${props.opinion.verdict}`) : ''
)
const tooltip = computed(() =>
  props.opinion
    ? `${props.opinion.reason}\n${t('cleanup.gc.opinion.evidence')}: ${props.opinion.evidence}`
    : ''
)
</script>

<template>
  <span
    v-if="pending"
    class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 text-caption text-text-3"
    role="status"
    data-testid="opinion-chip"
    data-state="pending"
  >
    <span class="anim-shimmer-dot size-1.5 rounded-full bg-accent" aria-hidden="true" />
    {{ t('cleanup.gc.opinion.pending') }}
  </span>
  <span v-else-if="opinion" class="inline-flex min-w-0 flex-col items-start gap-0.5">
    <span
      class="inline-flex items-center rounded-full border px-2 text-caption"
      :class="VARIANT[opinion.verdict]"
      :title="tooltip"
      :aria-label="t('cleanup.gc.opinion.aria', { verdict: verdictWord, reason: opinion.reason })"
      data-testid="opinion-chip"
      :data-state="opinion.verdict"
    >
      {{ verdictWord }}
    </span>
    <span
      v-if="showEvidence"
      class="max-w-full truncate text-caption text-text-4"
      :title="opinion.evidence"
      data-testid="opinion-evidence"
    >
      {{ opinion.evidence }}
    </span>
  </span>
</template>
