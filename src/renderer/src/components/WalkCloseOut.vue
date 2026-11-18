<script setup lang="ts">
import { ArrowUpRight, Library, Target } from 'lucide-vue-next'
import type { CloseoutView } from '../lib/walk-view'
import WalkCode from './WalkCode.vue'
import { useI18n } from 'vue-i18n'

/**
 * The close-out (design.md §6 "Guided test walk" → Close-out): the pane IS the report. One row per check with
 * how it was verified, the extra checks that were not ticked, the `⚑ Still yours` card only when something is
 * owed, the Saved in Walks card, and the summary the session received as its `closed` turn. There is no footer
 * button and no control that settles a criterion: with a mission source the card shows each criterion's state
 * and a link to the Mission, where the operator ticks it themself.
 */
defineProps<{ closeout: CloseoutView }>()
defineEmits<{ 'open-mission': []; 'open-walks': []; export: [] }>()
const { t } = useI18n()

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
    <h2 class="wk-title">{{ closeout.title }}</h2>
    <div class="sub" data-test="walk-closeout-sub">{{ closeout.sub }}</div>
  </div>

  <ol class="rm" data-dsqa-part="closeout-list">
    <li v-for="r in closeout.rows" :key="r.id" class="rm-row" data-dsqa-part="closeout-row">
      <span class="g1"
        ><span class="gl" :class="glyphClass[r.glyph]" aria-hidden="true">{{ r.glyph }}</span></span
      >
      <span class="n num">{{ r.n ?? '' }}</span>
      <span class="t">{{ r.title }}</span>
      <span class="m">
        <span :class="{ warnt: r.tone === 'warn', redt: r.tone === 'bad' }">{{ r.how }}</span>
      </span>
    </li>
  </ol>

  <section
    v-if="closeout.unticked.length"
    class="sec"
    data-dsqa-part="unticked"
    data-test="walk-unticked"
  >
    <div class="eyebrow">{{ $t('testWalk.closeout.unticked') }}</div>
    <ul class="xl plain">
      <li v-for="u in closeout.unticked" :key="u.checkId">
        <span class="num">{{ u.n ?? '' }}</span> {{ u.title }}
        <ul class="xl">
          <li v-for="(it, i) in u.items" :key="i">{{ it }}</li>
        </ul>
      </li>
    </ul>
  </section>

  <section
    v-if="closeout.owed"
    class="card you owed"
    data-dsqa-part="still-yours"
    data-test="walk-owed"
  >
    <div class="eb">
      <span class="gl gl-you" aria-hidden="true">⚑</span
      ><span>{{ $t('testWalk.closeout.owed') }}</span>
    </div>
    <p v-if="closeout.owed.parts" class="ask sm">{{ closeout.owed.parts }}</p>
    <p v-for="(r, i) in closeout.owed.recheck" :key="i" class="ask sm">{{ r }}</p>
    <ul v-if="closeout.owed.criteria.length" class="crit-list">
      <li v-for="c in closeout.owed.criteria" :key="c.id">
        <span class="ask sm">{{ c.text }}</span>
        <span class="why">{{ c.state }}</span>
      </li>
    </ul>
    <p v-if="closeout.owed.note" class="why">{{ closeout.owed.note }}</p>
    <div v-if="closeout.owed.link" class="acts">
      <span class="lk split wl" data-dsqa-part="link" data-walk-link>
        <button
          type="button"
          class="open"
          data-walk-chip
          data-test="walk-open-mission"
          @click="$emit('open-mission')"
        >
          <Target class="i i10" :size="10" />
          <span class="x">{{ $t('testWalk.closeout.openMission') }}</span>
          <ArrowUpRight class="i i10 ext" :size="10" />
        </button>
      </span>
    </div>
  </section>
  <p v-else-if="closeout.nothingOwed" class="why quiet-owed" data-test="walk-nothing-owed">
    {{ $t('testWalk.closeout.nothingOwed') }}
  </p>

  <section class="card saved" data-dsqa-part="saved" data-test="walk-saved">
    <div class="eb">
      <Library class="i i10" :size="10" /><span>{{ $t('testWalk.closeout.saved') }}</span>
    </div>
    <p class="ask sm">{{ $t('testWalk.closeout.savedBody') }}</p>
    <div v-if="closeout.saved.actions.length" class="acts">
      <button
        v-if="closeout.saved.actions.includes('open-walks')"
        type="button"
        class="btn"
        @click="$emit('open-walks')"
      >
        <Library class="i i10" :size="10" />{{ $t('testWalk.closeout.openWalks') }}
      </button>
      <button
        v-if="closeout.saved.actions.includes('export')"
        type="button"
        class="btn"
        @click="$emit('export')"
      >
        {{ $t('testWalk.closeout.export') }}
      </button>
    </div>
  </section>

  <section class="sec" data-dsqa-part="summary" data-test="walk-summary">
    <WalkCode :text="closeout.summary" :what="t('testWalk.copy.summary')" />
  </section>
</template>
