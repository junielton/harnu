<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, Sparkles, Terminal, ZoomIn } from 'lucide-vue-next'
import type { CheckView, LinkChip } from '../lib/walk-view'
import WalkCode from './WalkCode.vue'
import WalkLink from './WalkLink.vue'
import WalkSegments from './WalkSegments.vue'
import WalkValue from './WalkValue.vue'

/**
 * The served check (design.md §6 "Guided test walk" → Anatomy): its title, Do, Where, You should see and
 * I'll check, then the cards a state adds over it (the correction, the evidence, "Said more simply", the Explain
 * more card). ONE check, never a peek at the next. It decides nothing: it draws a `CheckView` and reports clicks.
 */
const props = defineProps<{
  check: CheckView
  folder: string
  /** The thumbnail resolves through the walk's own folder; main serves it as a file the pane can load. */
  imageUrl: (src: string) => string
  /** A large image: full width instead of the 300 px thumbnail. */
  bigImage: boolean
}>()
const emit = defineEmits<{
  'open-link': [link: LinkChip]
  'zoom-image': []
  tick: [checkId: string, extraId: string]
  lost: []
  ask: []
  door: []
}>()
const { t } = useI18n()

const blocksText = computed(() => {
  const b = props.check.blocksLine
  if (!b) return ''
  const one = b.from === b.to
  if (b.why)
    return t(one ? 'testWalk.blocksOneWhy' : 'testWalk.blocksWhy', {
      from: b.from,
      to: b.to,
      why: b.why
    })
  return t(one ? 'testWalk.blocksOne' : 'testWalk.blocks', { from: b.from, to: b.to })
})
const showSteps = computed(() => props.check.phase !== 'disagrees')
/** The retry state draws the same step again: the Do list and the expected text, nothing more (the mockup's failed-retry). */
const retry = computed(() => props.check.phase === 'failed')
</script>

<template>
  <h2 class="wk-title" data-dsqa-part="step-title">{{ check.title }}</h2>
  <div v-if="blocksText" class="blocks">{{ blocksText }}</div>
  <div v-if="check.undo" class="blocks undo" data-test="walk-undo">
    {{ $t('testWalk.undoLead', { undo: check.undo }) }}
  </div>

  <!-- the failed state: what the operator reported, then my one correction -->
  <div v-if="check.reported" class="reported" data-dsqa-part="reported">
    <span class="eyebrow">{{ $t('testWalk.retry.reported') }}</span>
    <p v-if="check.reported.line">{{ check.reported.line }}</p>
    <span v-if="check.reported.shot" class="att small"
      ><span class="trunc">{{ check.reported.shot }}</span></span
    >
  </div>
  <section
    v-if="check.phase === 'failed'"
    class="card acc fix"
    data-dsqa-part="correction"
    data-test="walk-correction"
  >
    <div class="eb">{{ $t('testWalk.retry.eyebrow') }}</div>
    <p v-if="check.correction" class="ask">{{ check.correction.text }}</p>
    <p v-else class="why">{{ $t('testWalk.retry.waiting') }}</p>
  </section>

  <!-- the agent disagreed after a Done: ran, expected, found -->
  <section
    v-if="check.evidence"
    class="card warn evid"
    data-dsqa-part="check-evidence"
    data-test="walk-evidence"
  >
    <div class="eb">
      <span class="gl gl-warn" aria-hidden="true">!</span
      ><span>{{ $t('testWalk.evidence.title') }}</span>
    </div>
    <dl>
      <dt>{{ $t('testWalk.evidence.ran') }}</dt>
      <dd><WalkValue :text="check.evidence.ran" :what="t('testWalk.copy.command')" /></dd>
      <dt>{{ $t('testWalk.evidence.expected') }}</dt>
      <dd><WalkSegments :parts="check.evidence.expected" /></dd>
      <dt>{{ $t('testWalk.evidence.found') }}</dt>
      <dd><WalkValue :text="check.evidence.found" :what="t('testWalk.copy.error')" /></dd>
    </dl>
    <p class="why">
      {{ check.blocking ? $t('testWalk.evidence.blocking') : $t('testWalk.evidence.nonBlocking') }}
    </p>
  </section>

  <!-- I didn't get this step: the same check, said more simply -->
  <section
    v-if="check.simpler"
    class="card acc simple"
    data-dsqa-part="simpler"
    data-test="walk-simpler"
  >
    <div class="eb">{{ $t('testWalk.simpler.eyebrow') }}</div>
    <p class="ask">{{ check.simpler.text }}</p>
  </section>

  <template v-if="showSteps && check.phase !== 'awaiting'">
    <section class="sec" data-dsqa-part="do">
      <div class="eyebrow">
        {{ check.phase === 'failed' ? $t('testWalk.retry.again') : $t('testWalk.section.do') }}
      </div>
      <ol class="do">
        <li v-for="d in check.do" :key="d.n">
          <span class="n num">{{ d.n }}.</span>
          <div class="li">
            <span><WalkSegments :parts="d.text" /></span>
            <WalkCode v-if="d.block" :text="d.block.text" :what="t('testWalk.copy.command')" />
            <span v-if="d.see.length" class="d-see"><WalkSegments :parts="d.see" /></span>
          </div>
        </li>
      </ol>
    </section>

    <section v-if="check.where && !retry" class="sec" data-dsqa-part="where">
      <div class="eyebrow">{{ $t('testWalk.section.where') }}</div>
      <div class="where-text">{{ check.where.text }}</div>
      <div class="links">
        <span v-if="check.where.path" class="path-row">
          <WalkValue :text="check.where.path" :what="t('testWalk.copy.path')" />
          <span v-if="check.where.approximate" class="approx">
            <span class="gl gl-ask" aria-hidden="true">?</span>{{ $t('testWalk.pathApprox') }}
          </span>
        </span>
        <span v-for="(l, i) in check.where.links" :key="i" class="link-row">
          <WalkLink :link="l" @open="emit('open-link', $event)" />
          <span v-if="l.note" class="approx">{{ $t(`testWalk.linkNote.${l.note}`) }}</span>
        </span>
      </div>
    </section>

    <section v-if="retry" class="sec" data-dsqa-part="see">
      <div class="see tight">
        <p><WalkSegments :parts="check.see.passes" /></p>
      </div>
    </section>
    <section v-else class="sec" data-dsqa-part="see">
      <div class="eyebrow">{{ $t('testWalk.section.see') }}</div>
      <div class="see">
        <p><WalkSegments :parts="check.see.passes" /></p>
        <p v-if="check.see.notLine" class="not">
          <span class="gl gl-bad" aria-hidden="true">✗</span>
          <span>{{ $t('testWalk.not') }}: <WalkSegments :parts="check.see.notLine" /></span>
        </p>
      </div>
      <table v-if="check.see.table.length" class="exp-table" data-dsqa-part="table">
        <thead>
          <tr>
            <th>{{ $t('testWalk.table.item') }}</th>
            <th>{{ $t('testWalk.table.shows') }}</th>
            <th>{{ $t('testWalk.table.source') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in check.see.table" :key="i">
            <td>{{ r.item }}</td>
            <td>{{ r.shows }}</td>
            <td>{{ r.source }}</td>
          </tr>
        </tbody>
      </table>
      <figure
        v-for="(im, i) in check.see.images"
        :key="i"
        class="shot"
        :class="bigImage ? 'big' : 'thumb'"
        :data-dsqa-part="bigImage ? 'image-large' : 'image-thumb'"
      >
        <button
          type="button"
          class="zoom-hit"
          data-walk-chip
          :aria-label="$t('testWalk.image.enlarge')"
          @click="emit('zoom-image')"
        >
          <img :src="imageUrl(im.src)" :alt="im.alt" />
        </button>
        <figcaption>
          <span>{{ im.caption }}</span>
          <span class="zoom"
            ><ZoomIn class="i i10" :size="10" />{{ $t('testWalk.image.enlarge') }}</span
          >
        </figcaption>
      </figure>
    </section>

    <section v-if="!retry" class="sec" data-dsqa-part="check">
      <div class="eyebrow">{{ $t('testWalk.section.check') }}</div>
      <div v-if="check.icheck.kind === 'check'" class="chk" data-dsqa-part="my-check">
        <Terminal class="i i10" :size="10" />
        <span v-if="check.icheck.precheck" class="k">{{ check.icheck.precheck }}</span>
        <WalkValue :text="check.icheck.how" :what="t('testWalk.copy.command')" />
      </div>
      <div v-else class="chk quiet" data-dsqa-part="my-check">
        <Eye class="i i10" :size="10" />
        <span>{{ $t('testWalk.nothing', { why: check.icheck.why }) }}</span>
      </div>
    </section>

    <button
      v-if="check.lost && !retry"
      type="button"
      class="lost"
      data-test="walk-lost"
      :disabled="check.asking.simpler"
      @click="emit('lost')"
    >
      {{ check.asking.simpler ? $t('testWalk.simpler.asking') : $t('testWalk.lost') }}
    </button>
  </template>

  <section
    v-if="check.phase === 'awaiting'"
    class="quietbox"
    data-dsqa-part="working"
    data-test="walk-awaiting"
  >
    <div class="busy" role="status">
      <span class="pdot" aria-hidden="true"></span>
      <div>
        <b>{{ $t('testWalk.working.checking', { n: check.n }) }}</b>
        <div v-if="check.icheck.kind === 'check'" class="vrow">
          <WalkValue :text="check.icheck.how" :what="t('testWalk.copy.command')" />
        </div>
        <div class="why">{{ $t('testWalk.working.quiet') }}</div>
      </div>
    </div>
  </section>

  <!-- Explain more: what the script prepared, folded back by a second press -->
  <template v-if="check.explain.open && check.phase !== 'awaiting'">
    <template v-for="part in check.explain.order" :key="part">
      <section
        v-if="part === 'more' && check.explain.more.length"
        class="why-box"
        data-dsqa-part="why"
        data-test="walk-more"
      >
        <div class="eyebrow">{{ $t('testWalk.explain.why') }}</div>
        <p v-for="(m, i) in check.explain.more" :key="i">{{ m }}</p>
      </section>

      <section
        v-else-if="part === 'teach' && check.explain.teach"
        class="teach"
        data-dsqa-part="teach"
        data-test="walk-teach"
      >
        <div class="eb">
          <Sparkles class="i i10" :size="10" />{{ $t('testWalk.explain.teach') }}
        </div>
        <div class="tc">
          <div class="eyebrow">{{ $t('testWalk.explain.does') }}</div>
          <p>{{ check.explain.teach.what }}</p>
        </div>
        <div v-if="check.explain.teach.where.length" class="tc">
          <div class="eyebrow">{{ $t('testWalk.explain.where') }}</div>
          <div class="links">
            <WalkLink
              v-for="(l, i) in check.explain.teach.where"
              :key="i"
              :link="l"
              @open="emit('open-link', $event)"
            />
          </div>
        </div>
        <div v-if="check.explain.teach.idea" class="tc">
          <div class="eyebrow">{{ $t('testWalk.explain.idea') }}</div>
          <p>{{ check.explain.teach.idea.text }}</p>
          <div v-if="check.explain.teach.idea.link" class="links">
            <WalkLink :link="check.explain.teach.idea.link" @open="emit('open-link', $event)" />
          </div>
        </div>
        <div v-if="check.explain.teach.why" class="tc">
          <div class="eyebrow">{{ $t('testWalk.explain.whyTeach') }}</div>
          <p>{{ check.explain.teach.why }}</p>
        </div>
      </section>

      <template v-else-if="part === 'edge' && check.explain.extras.length">
        <details
          v-if="check.explain.foldEdge"
          class="left extra-fold"
          data-dsqa-part="extra-checks"
          data-test="walk-extras"
        >
          <summary>
            <span class="chev" aria-hidden="true">›</span
            >{{ $t('testWalk.explain.extra', { n: check.explain.extras.length }) }}
          </summary>
          <ul class="xl">
            <li v-for="e in check.explain.extras" :key="e.id">
              <WalkSegments :parts="e.text" />
            </li>
          </ul>
        </details>
        <section v-else class="extra" data-dsqa-part="extra-checks" data-test="walk-extras">
          <div class="eyebrow">
            {{ $t('testWalk.explain.extra', { n: check.explain.extras.length }) }}
          </div>
          <ul>
            <li
              v-for="e in check.explain.extras"
              :key="e.id"
              class="ex"
              data-dsqa-part="extra-check"
            >
              <button
                type="button"
                class="bx"
                :class="{ on: e.ticked }"
                role="checkbox"
                :aria-checked="e.ticked"
                :aria-label="
                  $t('testWalk.explain.tick', { text: e.text.map((s) => s.text).join('') })
                "
                data-walk-chip
                @click="emit('tick', check.checkId, e.id)"
              >
                <span v-if="e.ticked" class="tick" aria-hidden="true"></span>
              </button>
              <div>
                <div class="et"><WalkSegments :parts="e.text" /></div>
                <div class="ed"><WalkSegments :parts="e.see" /></div>
              </div>
            </li>
          </ul>
          <div class="hint">{{ $t('testWalk.explain.hint') }}</div>
        </section>
      </template>
    </template>
    <button
      v-if="!check.explain.prepared"
      type="button"
      class="lost"
      :disabled="check.asking.explain"
      @click="emit('ask')"
    >
      {{ check.asking.explain ? $t('testWalk.explain.asking') : $t('testWalk.explain.ask') }}
    </button>
  </template>
  <div v-else-if="check.asking.explain" class="blocks" role="status">
    {{ $t('testWalk.explain.asking') }}
  </div>

  <!-- the escalation door: from the second failure, once, and the agent acts -->
  <button
    v-if="check.door"
    type="button"
    class="lost"
    data-dsqa-part="builder-door"
    data-test="walk-door"
    @click="emit('door')"
  >
    {{ $t(`testWalk.retry.door.${check.door.kind}`) }}
  </button>
</template>
