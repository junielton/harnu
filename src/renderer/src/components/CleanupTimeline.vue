<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { Checkpoint, CheckpointId, CheckpointState } from '../../../preload'

/**
 * The 7-checkpoint horizontal strip for one Reaper cleanup candidate
 * (design.md "Checkpoint timeline"). Dimensions are locked by plan T7 and the
 * approved visual contract (`docs/specs/2026-07-17-reaper-cleanup/spec.html`)
 * — dot 14px / border 1.5px / connector 1.5px / label 9px.
 */
defineProps<{ checkpoints: Checkpoint[] }>()

const { t } = useI18n()

const LABEL_KEYS: Record<CheckpointId, string> = {
  pr: 'pr',
  review: 'review',
  ci: 'ci',
  'pr-merged': 'prMerged',
  'in-main': 'inMain',
  'remote-gone': 'remoteGone',
  'local-clean': 'localClean'
}

function checkpointLabel(id: CheckpointId): string {
  return t(`cleanup.checkpoint.${LABEL_KEYS[id]}`)
}

const DOT_GLYPH: Record<CheckpointState, string> = {
  green: '✓',
  red: '✕',
  unknown: '?',
  na: ''
}

const DOT_CLASS: Record<CheckpointState, string> = {
  green: 'border-green bg-green text-bg',
  red: 'border-red bg-red text-bg',
  unknown: 'border-dashed border-border-2 bg-surface-2 text-text-3',
  na: 'border-border bg-surface-2 text-text-4 opacity-35'
}

const LABEL_CLASS: Record<CheckpointState, string> = {
  green: 'text-text-3',
  red: 'text-red',
  unknown: 'text-text-4',
  na: 'text-text-4 opacity-45'
}

const CONNECTOR_CLASS: Record<CheckpointState, string> = {
  green: 'bg-green/55',
  red: 'bg-border-2',
  unknown: 'bg-border-2',
  na: 'bg-border-2'
}

/**
 * A checkpoint reporting an uncorroborated upstream PR (`via === 'upstream'`,
 * BUG-127) describes that upstream's PR, not this branch — so a green or red is
 * drawn hollow (state colour on the border and glyph, no fill) and the connector
 * into it stays neutral: the chain never reads as this branch's own green.
 * `unknown`/`na` already claim nothing and render unchanged.
 */
const VIA_UPSTREAM_DOT_CLASS: Partial<Record<CheckpointState, string>> = {
  green: 'border-green text-green',
  red: 'border-red text-red'
}

function dotClass(cp: Checkpoint): string {
  return (cp.via === 'upstream' && VIA_UPSTREAM_DOT_CLASS[cp.state]) || DOT_CLASS[cp.state]
}

function connectorClass(cp: Checkpoint): string {
  return cp.via === 'upstream' ? 'bg-border-2' : CONNECTOR_CLASS[cp.state]
}

function dotLabel(cp: Checkpoint): string {
  return cp.id === 'pr' && cp.via === 'upstream'
    ? t('cleanup.checkpoint.prViaUpstream')
    : checkpointLabel(cp.id)
}

function dotTitle(cp: Checkpoint): string | undefined {
  if (cp.via !== 'upstream') return cp.detail
  const via = t('cleanup.checkpoint.viaUpstream')
  return cp.detail ? `${cp.detail} — ${via}` : via
}
</script>

<template>
  <div class="grid w-full grid-cols-7 items-start">
    <div
      v-for="(cp, index) in checkpoints"
      :key="cp.id"
      class="relative flex flex-col items-center gap-[5px]"
    >
      <div
        v-if="index > 0"
        class="absolute right-1/2 top-[6.5px] h-[1.5px] w-full"
        :class="connectorClass(cp)"
      />
      <!-- opaque backing plate: green/red fill solid on their own now, but `na`
           still fades the whole dot to 35% opacity, so the plate stays as a
           belt-and-suspenders guard against the connector painting through;
           tracks the row's own bg (rest vs. group/row hover) -->
      <div class="relative h-3.5 w-3.5">
        <div class="absolute inset-0 rounded-full bg-bg group-hover/row:bg-surface" />
        <div
          class="absolute inset-0 z-10 flex items-center justify-center rounded-full border-[1.5px] text-[8.5px] font-bold"
          :class="dotClass(cp)"
          :title="dotTitle(cp)"
        >
          {{ DOT_GLYPH[cp.state] }}
        </div>
      </div>
      <span class="whitespace-nowrap text-[9px]" :class="LABEL_CLASS[cp.state]">
        {{ dotLabel(cp) }}
      </span>
    </div>
  </div>
</template>
