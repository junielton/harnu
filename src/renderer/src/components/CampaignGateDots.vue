<script setup lang="ts">
/**
 * The four gate dots of one step (PR · CI · main · verifier — design.md §6 "Gate dots"), shared by
 * the Campaign map's tiles and its chapter-focus panel. A dot's colour is the server's gate state
 * (`GATE_DOT_CLASS`); `labels` adds the gate's short name beside each dot (the focus panel).
 */
import { useI18n } from 'vue-i18n'
import { GATE_DOT_CLASS, type GateDot } from '../lib/mission-view'

const props = defineProps<{ gates: GateDot[]; stale?: boolean; labels?: boolean }>()
const { t } = useI18n()

function title(g: GateDot): string {
  return t(props.stale ? 'mission.gates.tooltipStale' : 'mission.gates.tooltip', {
    gate: t(`mission.gates.name.${g.name}`),
    state: t(`mission.gates.state.${g.state}`)
  })
}
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center"
    :style="{ gap: labels ? '8px' : '3px' }"
    role="group"
    :aria-label="$t('mission.gates.label')"
  >
    <span v-for="g in gates" :key="g.name" class="inline-flex items-center" style="gap: 3px">
      <span
        class="shrink-0 rounded-full border-[1.5px]"
        :class="GATE_DOT_CLASS[g.state]"
        style="width: 7px; height: 7px"
        role="img"
        :title="title(g)"
        :aria-label="title(g)"
        :data-gate="g.name"
        :data-state="g.state"
      />
      <span v-if="labels" class="text-text-4" style="font-size: 10px">{{
        $t(`mission.gates.short.${g.name}`)
      }}</span>
    </span>
  </span>
</template>
