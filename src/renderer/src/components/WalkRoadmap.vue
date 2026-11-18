<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import type { RoadmapView } from '../lib/walk-view'
import WalkValue from './WalkValue.vue'

/**
 * The roadmap (design.md §6 "Guided test walk" → States): every check as a row with its glyph, the evidence of
 * the ones verified before the walk, how each open one will be checked, and the folded "left out" line. Opened
 * mid-walk (the list icon, `L`) it is read-only: the same rows with their current state. The primary action
 * (Start with 1) lives in the pane's action bar, not here.
 */
defineProps<{ roadmap: RoadmapView }>()
defineEmits<{ rerun: [walkId: string] }>()

const glyphClass: Record<string, string> = {
  '✓': 'gl-ok',
  '✗': 'gl-bad',
  '!': 'gl-warn',
  '-': 'gl-off',
  '⚑': 'gl-you',
  '?': 'gl-ask'
}
</script>

<template>
  <div class="wk-head">
    <h2 class="wk-title">{{ roadmap.title }}</h2>
    <div class="sub">{{ roadmap.sub }}</div>
  </div>

  <div
    v-if="roadmap.rerunOffer"
    class="rerun-offer"
    data-dsqa-part="rerun-offer"
    data-test="walk-rerun-offer"
  >
    <span>{{ roadmap.rerunOffer.text }}</span>
    <button
      type="button"
      class="btn"
      data-test="walk-rerun-accept"
      @click="$emit('rerun', roadmap.rerunOffer.walkId)"
    >
      {{ $t('testWalk.roadmap.rerunAction') }}
    </button>
  </div>

  <ol class="rm" data-dsqa-part="roadmap">
    <li v-for="r in roadmap.rows" :key="r.id" class="rm-row" data-dsqa-part="roadmap-row">
      <span class="g1"
        ><span class="gl" :class="glyphClass[r.glyph]" aria-hidden="true">{{ r.glyph }}</span></span
      >
      <span class="n num">{{ r.n ?? '' }}</span>
      <span class="t"
        >{{ r.title
        }}<span v-if="r.added" class="added">{{ $t('testWalk.roadmap.added') }}</span></span
      >
      <span class="m">
        <template v-if="r.how.kind === 'eyes'"
          ><span class="m-k">{{ $t('testWalk.roadmap.eyes') }}</span></template
        >
        <template v-else-if="r.how.kind === 'check'">
          <span class="m-k">{{ $t('testWalk.roadmap.icheck') }}</span>
          <WalkValue :text="r.how.value" />
        </template>
        <template v-else>
          <span class="m-k">{{ $t('testWalk.roadmap.earlier') }}</span>
          <WalkValue v-if="r.how.evidence" :text="r.how.evidence" />
        </template>
      </span>
    </li>
  </ol>

  <details v-if="roadmap.leftOut" class="left" data-dsqa-part="left-out">
    <summary><ChevronRight class="i i10 chev" :size="10" />{{ roadmap.leftOut.summary }}</summary>
    <p v-for="(o, i) in roadmap.leftOut.rows" :key="i">{{ o.text }}</p>
  </details>
</template>
