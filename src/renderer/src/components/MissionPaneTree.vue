<script setup lang="ts">
import { computed, defineComponent, h, nextTick, reactive, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, ChevronRight, Flag, MessageSquare } from 'lucide-vue-next'
import MissionPaneStep from './MissionPaneStep.vue'
import {
  milestoneGlyph,
  milestoneOfStep,
  milestoneSummary,
  stepGlyph,
  type GlyphKind,
  type PaneMilestoneRow,
  type PaneStepRow,
  type PaneTree,
  type SummaryPart
} from '../lib/mission-pane-view'

/**
 * The tree of a v4 mission (Missions v4 S-18, design.md §6 "Mission pane" → The glance): milestone ▸
 * step ▸ criteria, every level behind a chevron, with a vertical timeline line joining the milestone
 * glyphs. Only the current milestone opens by itself; the operator opens any other.
 *
 * It READS the tree `buildPaneTree` made from the view and computes no state: a state, a count and the
 * current milestone are the server's. The criteria are drawn as a plain list here; who settles each, the
 * collapse of verified ones, a blocker and the links belong to the open step (S-19).
 */
const props = defineProps<{
  tree: PaneTree
  /** A session leads the mission, so a milestone can be asked about (S-21). Ask is drawn only then. */
  askable?: boolean
}>()
// "Ask" on a milestone (S-21): the pane owns the question box and the sending; the box is drawn in the
// milestone body through the `ask` slot.
const emit = defineEmits<{ ask: [milestoneId: string] }>()

const { t } = useI18n()

/** The operator's choices. An absent key means "as the server's current milestone says". */
const milestoneOpen = reactive<Record<string, boolean>>({})
const stepOpen = reactive<Record<string, boolean>>({})
const foldOpen = reactive<Record<string, boolean>>({})
const optionalOpen = ref(false)

const LOOSE = '__loose'

const isOpen = (m: PaneMilestoneRow): boolean => milestoneOpen[m.id] ?? m.openByDefault
const toggleMilestone = (m: PaneMilestoneRow): void => {
  milestoneOpen[m.id] = !isOpen(m)
}
const toggleStep = (id: string): void => {
  stepOpen[id] = !stepOpen[id]
}
const toggleFold = (key: string): void => {
  foldOpen[key] = !foldOpen[key]
}

/** The steps a block draws: the shown ones, then the folded ones once the operator unfolds them. */
function visibleSteps(
  key: string,
  g: { shown: PaneStepRow[]; folded: PaneStepRow[] }
): PaneStepRow[] {
  return foldOpen[key] ? [...g.shown, ...g.folded] : g.shown
}

interface Block {
  key: string
  /** The "N optional milestones" line: it is a row of the list, not a milestone. */
  toggle?: boolean
  milestone: PaneMilestoneRow | null
  groups: { shown: PaneStepRow[]; folded: PaneStepRow[] }
  /** Draws the timeline line: the required milestones do, the optional ones under their fold do not. */
  rail: boolean
  first: boolean
  last: boolean
}

const required = computed<Block[]>(() =>
  props.tree.milestones.map((m, i, all) => ({
    key: m.id,
    milestone: m,
    groups: m,
    rail: true,
    first: i === 0,
    last: i === all.length - 1
  }))
)
const optionalBlocks = computed<Block[]>(() =>
  props.tree.optional.map((m) => ({
    key: m.id,
    milestone: m,
    groups: m,
    rail: false,
    first: true,
    last: true
  }))
)
const loose = computed<Block | null>(() =>
  props.tree.loose
    ? {
        key: LOOSE,
        milestone: null,
        groups: props.tree.loose,
        rail: false,
        first: true,
        last: true
      }
    : null
)
/** Required milestones, then the one collapsed line, then the optional ones once it is opened. */
const blocks = computed<Block[]>(() => {
  if (loose.value) return [loose.value]
  if (optionalBlocks.value.length === 0) return required.value
  const fold: Block = {
    key: '__optional',
    toggle: true,
    milestone: null,
    groups: { shown: [], folded: [] },
    rail: false,
    first: true,
    last: true
  }
  return [...required.value, fold, ...(optionalOpen.value ? optionalBlocks.value : [])]
})

function summaryText(part: SummaryPart): string {
  switch (part.kind) {
    case 'running':
      return t('missionPane.tree.running', { n: part.n }, part.n)
    case 'waitingReview':
      return t('missionPane.tree.waitingReview', { n: part.n }, part.n)
    case 'blocked':
      return t('missionPane.tree.blocked', { n: part.n }, part.n)
    case 'nothingRunning':
      return t('missionPane.tree.nothingRunning')
    case 'allDone':
      return t('missionPane.tree.allDone')
  }
}

const summaryLength = (m: PaneMilestoneRow): number => milestoneSummary(m).length

const stepStateLabel = (s: PaneStepRow): string =>
  t(`missionPane.tree.state.${s.blocked ? 'running' : s.state}`)

/**
 * The glyph of a step or a milestone (design.md §6 "Mission pane" → Glyphs): a 12px circle. Its meaning
 * is in `label` (the translated state), never in colour alone.
 */
const Glyph = defineComponent({
  props: {
    kind: { type: String as PropType<GlyphKind>, required: true },
    current: { type: Boolean, default: false },
    label: { type: String, required: true }
  },
  setup(p) {
    return () => {
      const base =
        'relative flex shrink-0 items-center justify-center rounded-full' +
        (p.current ? ' ring-3 ring-accent-soft' : '')
      const inner =
        p.kind === 'done'
          ? h(
              'span',
              {
                class: 'flex items-center justify-center rounded-full bg-green',
                style: 'width: 12px; height: 12px'
              },
              [h(Check, { size: 8, strokeWidth: 3, class: 'text-bg' })]
            )
          : p.kind === 'running'
            ? h('span', { class: 'rounded-full bg-accent', style: 'width: 8px; height: 8px' })
            : p.kind === 'review'
              ? h('span', {
                  class: 'rounded-full border-[1.5px] border-accent',
                  style: 'width: 8px; height: 8px'
                })
              : p.kind === 'blocked'
                ? h(Flag, { size: 12, strokeWidth: 2, class: 'text-red' })
                : h('span', {
                    class: 'rounded-full border-[1.5px] border-text-4',
                    style: 'width: 8px; height: 8px'
                  })
      return h(
        'span',
        {
          class: base,
          style: 'width: 12px; height: 12px',
          role: 'img',
          title: p.label,
          'aria-label': p.label,
          'data-glyph': p.kind
        },
        [inner]
      )
    }
  }
})

/** The pull request number is a link: it opens the pull request and never folds or unfolds the step. */
function onPrClick(ev: Event, s: PaneStepRow): void {
  if (!s.prUrl) return
  ev.stopPropagation()
  ev.preventDefault()
  void Promise.resolve(window.api.shellOpenExternal(s.prUrl)).catch(() => undefined)
}

/** "Open step": unfold the milestone and the step, then bring the step into view. */
async function openStep(stepId: string): Promise<void> {
  const mid = milestoneOfStep(props.tree, stepId)
  if (mid !== null) {
    milestoneOpen[mid] = true
    const optional = props.tree.optional.some((m) => m.id === mid)
    if (optional) optionalOpen.value = true
    const m = [...props.tree.milestones, ...props.tree.optional].find((x) => x.id === mid)
    if (m?.folded.some((s) => s.id === stepId)) foldOpen[mid] = true
  } else if (props.tree.loose?.folded.some((s) => s.id === stepId)) {
    foldOpen[LOOSE] = true
  }
  stepOpen[stepId] = true
  await nextTick()
  Array.from(document.querySelectorAll('[data-test="step-row"]'))
    .find((el) => el.getAttribute('data-step') === stepId)
    ?.scrollIntoView?.({ block: 'nearest' })
}
defineExpose({ openStep })
</script>

<template>
  <div
    class="@container flex flex-col"
    style="gap: 1px"
    :aria-label="$t('missionPane.tree.label')"
    data-test="tree"
  >
    <template v-for="block in blocks" :key="block.key">
      <!-- Optional milestones sit under one collapsed line (outside the count and the timeline). -->
      <button
        v-if="block.toggle"
        type="button"
        class="self-start text-text-4 transition hover:text-text"
        style="font-size: 11px; margin-top: 8px"
        :aria-expanded="optionalOpen"
        data-test="optional-toggle"
        @click="optionalOpen = !optionalOpen"
      >
        {{ $t('missionPane.tree.optional', { n: optionalBlocks.length }, optionalBlocks.length) }}
      </button>
      <!-- The milestone's own grid: chevron, glyph, title, count. The body shares its columns, so the
           timeline line (in the glyph column) lines up with the glyph at any width. -->
      <div
        v-else
        :class="block.milestone ? 'grid' : 'flex flex-col'"
        :style="
          block.milestone
            ? 'grid-template-columns: 12px 12px minmax(0, 1fr) auto; column-gap: 8px'
            : ''
        "
        :data-test="block.milestone ? 'milestone' : 'loose'"
        :data-milestone="block.milestone?.id"
      >
        <button
          v-if="block.milestone"
          type="button"
          class="grid items-center rounded-sm text-left text-text-3 transition hover:bg-surface-2"
          style="
            grid-column: 1 / -1;
            grid-template-columns: 12px 12px minmax(0, 1fr) auto;
            column-gap: 8px;
            margin: 0 -6px;
            padding: 0 6px;
            font-size: 12.5px;
          "
          :aria-expanded="isOpen(block.milestone)"
          data-test="milestone-row"
          :data-milestone="block.milestone.id"
          @click="toggleMilestone(block.milestone)"
        >
          <span class="flex text-text-4" style="padding: 7px 0" data-test="chevron">
            <ChevronDown v-if="isOpen(block.milestone)" :size="10" :stroke-width="1.5" />
            <ChevronRight v-else :size="10" :stroke-width="1.5" />
          </span>
          <!-- The glyph column carries the line: the half above and the half below the glyph. -->
          <span class="relative flex items-center justify-center self-stretch">
            <span
              v-if="block.rail && !block.first"
              aria-hidden="true"
              class="absolute left-1/2 -translate-x-1/2"
              :class="block.milestone.state === 'done' ? 'bg-green opacity-60' : 'bg-border-2'"
              style="top: -1px; width: 1.5px; height: calc(50% - 8px)"
              data-test="line-above"
            />
            <Glyph
              :kind="milestoneGlyph(block.milestone.state)"
              :current="block.milestone.current"
              :label="$t(`missionPane.tree.state.${block.milestone.state}`)"
            />
            <span
              v-if="block.rail && !block.last"
              aria-hidden="true"
              class="absolute left-1/2 -translate-x-1/2"
              :class="block.milestone.state === 'done' ? 'bg-green opacity-60' : 'bg-border-2'"
              style="bottom: -1px; width: 1.5px; height: calc(50% - 8px)"
              data-test="line-below"
            />
          </span>
          <span class="min-w-0 break-words" style="padding: 7px 0">
            <span :class="block.milestone.current ? 'font-medium text-text' : ''">{{
              block.milestone.title
            }}</span>
            <span
              v-if="block.milestone.waitsFor"
              class="block text-text-4"
              style="font-size: 11px; margin-top: 1px"
              :data-milestone="block.milestone.id"
              data-test="waits-for"
              >{{
                $t('missionPane.tree.waitsFor', { title: block.milestone.waitsFor.title })
              }}</span
            >
          </span>
          <span class="tabular-nums text-text-4" style="font-size: 10.5px; padding: 7px 0">{{
            `${block.milestone.done}/${block.milestone.total}`
          }}</span>
        </button>

        <template v-if="!block.milestone || isOpen(block.milestone)">
          <!-- The line runs through an open milestone's steps; green behind a done one, none past the last. -->
          <div v-if="block.milestone" class="relative" style="grid-column: 2" aria-hidden="true">
            <span
              v-if="block.rail && !block.last"
              class="absolute left-1/2 -translate-x-1/2"
              :class="block.milestone.state === 'done' ? 'bg-green opacity-60' : 'bg-border-2'"
              style="top: -1px; bottom: -1px; width: 1.5px"
              data-test="line-through"
            />
          </div>
          <div
            class="flex min-w-0 flex-col"
            :style="
              block.milestone
                ? 'grid-column: 3 / span 2; gap: 1px; padding-bottom: 6px'
                : 'gap: 1px'
            "
            data-test="milestone-body"
            :data-milestone="block.milestone?.id"
          >
            <div v-if="block.milestone" class="flex items-start" style="padding: 0 0 4px; gap: 8px">
              <div
                class="min-w-0 flex-1 text-text-4"
                style="font-size: 11px"
                data-test="milestone-summary"
              >
                <template v-for="(part, pi) in milestoneSummary(block.milestone)" :key="part.kind">
                  <span v-if="pi > 0">{{ ' ' }}</span>
                  <!-- The separator trails its part and the pair never breaks: no "·" opens a wrapped line. -->
                  <span
                    class="whitespace-nowrap"
                    :class="part.kind === 'blocked' ? 'text-red' : ''"
                    >{{
                      pi < summaryLength(block.milestone) - 1
                        ? `${summaryText(part)} ·`
                        : summaryText(part)
                    }}</span
                  >
                </template>
              </div>
              <button
                v-if="askable"
                type="button"
                class="inline-flex shrink-0 items-center whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 text-text transition hover:border-text-4"
                style="height: 20px; padding: 0 7px; gap: 4px; font-size: 11px; font-weight: 500"
                :title="$t('missionPane.ask.openTitle')"
                data-test="ask-open"
                @click="emit('ask', block.milestone.id)"
              >
                <MessageSquare :size="10" :stroke-width="1.6" />{{ $t('missionPane.ask.open') }}
              </button>
            </div>
            <slot v-if="block.milestone" name="ask" :milestone="block.milestone" />

            <template v-for="s in visibleSteps(block.key, block.groups)" :key="s.id">
              <button
                type="button"
                class="grid w-full items-center rounded-sm text-left text-text-2 transition hover:bg-surface-2"
                style="
                  grid-template-columns: 10px 12px minmax(0, 1fr) auto;
                  column-gap: 7px;
                  padding: 5px 6px;
                  margin: 0 -6px;
                  width: calc(100% + 12px);
                  font-size: 12px;
                "
                :aria-expanded="!!stepOpen[s.id]"
                data-test="step-row"
                :data-step="s.id"
                :data-state="s.state"
                @click="toggleStep(s.id)"
              >
                <span class="flex text-text-4" data-test="chevron">
                  <ChevronDown v-if="stepOpen[s.id]" :size="10" :stroke-width="1.5" />
                  <ChevronRight v-else :size="10" :stroke-width="1.5" />
                </span>
                <Glyph :kind="stepGlyph(s.state, s.blocked)" :label="stepStateLabel(s)" />
                <span class="line-clamp-2 break-words">{{ s.title }}</span>
                <span
                  class="flex flex-wrap items-center @max-[340px]:col-start-3 @max-[340px]:row-start-2 @max-[340px]:justify-self-start"
                  style="gap: 6px; font-size: 10.5px"
                  data-test="step-meta"
                >
                  <span
                    v-if="s.blocked"
                    class="rounded-sm border border-red-line bg-red-soft text-red"
                    style="padding: 0 5px"
                    data-test="chip-blocked"
                    >{{ $t('missionPane.tree.chipBlocked') }}</span
                  >
                  <span
                    v-if="s.needsYou"
                    class="rounded-sm border border-warning-line bg-warning-soft text-warning"
                    style="padding: 0 5px"
                    data-test="chip-yours"
                    >{{ $t('missionPane.tree.chipYours') }}</span
                  >
                  <!-- A link, not a button: the row is the button, and a button does not nest in a button. -->
                  <span
                    v-if="s.pr"
                    class="font-mono text-accent"
                    :class="s.prUrl ? 'cursor-pointer hover:underline' : ''"
                    :role="s.prUrl ? 'link' : undefined"
                    :tabindex="s.prUrl ? 0 : undefined"
                    :title="
                      s.prUrl ? $t('missionPane.step.openLink', { label: `#${s.pr}` }) : undefined
                    "
                    data-test="step-pr"
                    @click="onPrClick($event, s)"
                    @keydown.enter="onPrClick($event, s)"
                    >#{{ s.pr }}</span
                  >
                </span>
              </button>
              <MissionPaneStep v-if="stepOpen[s.id]" :step="s" />
            </template>

            <button
              v-if="block.groups.folded.length > 0"
              type="button"
              class="self-start text-text-4 transition hover:text-text"
              style="font-size: 11px; padding: 4px 0 2px 29px"
              :aria-expanded="!!foldOpen[block.key]"
              data-test="fold-more"
              @click="toggleFold(block.key)"
            >
              {{
                foldOpen[block.key]
                  ? $t('missionPane.tree.less')
                  : $t(
                      'missionPane.tree.more',
                      { n: block.groups.folded.length },
                      block.groups.folded.length
                    )
              }}
            </button>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
