<script setup lang="ts">
/**
 * Mission dropdown — the tree (Missions v4 mission dropdown S-3; design.md §6 "Mission dropdown" → "What it
 * draws" 3 and "Keyboard and focus"; mockup `docs/design/mission-dropdown/`, states `mid`, `ask`, `dots`).
 *
 * Milestone ▸ step ▸ criteria as a keyboard `role="tree"`. Only the current milestone is open; the others are
 * one row. There is no "Steps and timeline" disclosure, so the dropdown reads and writes no
 * `om2tab.missionPane.sections` value.
 *
 * The timeline (T810) is CSS only (`.mission-tl*` in `main.css`): each item draws a line from under its own
 * toggle to just above the next one's, so it follows any height; a done item's line is green and the last
 * item of a level has none. Under each title sits the record's own time (`lib/mission-dropdown-tree.ts`),
 * or nothing. Inside an open milestone the owed steps come first, then at most
 * three running steps, the rest behind "{n} more steps". A step row has the glyph, the title (it wraps), the
 * PR number as a link and the "Yours" chip when the operator owes it, and no "Blocked" chip: the flag glyph and
 * its label say it. A mission with no milestones draws its steps as one list; optional milestones stay under
 * their one collapsed line.
 *
 * Keys (`lib/mission-dropdown-tree.ts`, `treeKeyAction`): one tab stop for the whole tree (the row last
 * focused, the current milestone to begin with); Up and Down move between visible rows, Right and Left open
 * or close a milestone or step and move into or out of it, Home and End jump to the first and last, Enter or
 * Space toggles. The PR number is a link and its own tab stop, and never toggles the step.
 *
 * It READS the server's view and computes no state. "Ask" sits at the right end of the open
 * milestone's summary line and opens its box (`MissionDropdownAsk.vue`) under it.
 *
 * An open step draws `MissionDropdownStep.vue` (S-4): its blocker, its criteria with who settles them, and its
 * links, under the step's row.
 *
 * "Test it" (S-6) sits on the open milestone's summary line, after Ask, and is drawn only when
 * `walkEntryAvailable(source)` says a walk can start from that milestone. A click, here or on an open step,
 * emits `walk` with the source; the shell calls `startWalk` and closes the dropdown.
 */
import { computed, nextTick, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, ListChecks, MessageSquare } from 'lucide-vue-next'
import MissionDot from './MissionDot.vue'
import MissionDropdownAsk from './MissionDropdownAsk.vue'
import MissionDropdownStep from './MissionDropdownStep.vue'
import {
  buildPaneTree,
  milestoneOfStep,
  milestoneSummary,
  type MissionV4Reply,
  type PaneMilestoneRow,
  type PaneStepRow,
  type SessionLinkLike,
  type SummaryPart
} from '../lib/mission-pane-view'
import {
  capRunning,
  criterionTimes,
  milestoneTime,
  stepTime,
  timeText,
  treeKeyAction,
  type SettleTimes,
  type TreeRow
} from '../lib/mission-dropdown-tree'
import type { RawLink } from '../lib/mission-dropdown-links'
import { walkEntryAvailable, type WalkSource } from '../lib/walk-entry'

const props = defineProps<{
  detail: MissionV4Reply['detail']
  /** The session that leads the mission, where Ask goes; `null` and Ask is not drawn. */
  askLeader: string | null
  /** The links the session wrote, which give a step's PR number its address. */
  sessionLinks?: readonly SessionLinkLike[]
  /** When each settled criterion was settled (the view's `settledAt`): the time lines read it. */
  settledAt?: SettleTimes
  now?: number
}>()

const emit = defineEmits<{
  /** "Test it" on a milestone or an open step: the shell starts the walk and closes the dropdown. */
  walk: [source: WalkSource]
}>()

const { t, locale } = useI18n()

const tree = computed(() =>
  capRunning(
    // The dropdown does not pass a clock: a blocker's age is read against now, each time the view changes.
    buildPaneTree(props.detail, { sessionLinks: props.sessionLinks, now: props.now ?? Date.now() }),
    props.detail.steps.map((s) => s.id)
  )
)

/** The time under each title: worded once per view, and `null` where the record holds no stamp. */
const times = computed(() => {
  const now = props.now ?? Date.now()
  const settled = props.settledAt ?? {}
  const word = (line: Parameters<typeof timeText>[2]): string | null =>
    timeText(t, locale.value, line)
  const milestones = new Map(
    props.detail.milestones.map((m) => [
      m.id,
      word(milestoneTime(props.detail, m.id, settled, now))
    ])
  )
  const steps = new Map(
    props.detail.steps.map((s) => {
      const c = criterionTimes(s, settled)
      return [
        s.id,
        {
          line: word(stepTime(s, now)),
          openSince: word(c.openSince),
          lastVerified: word(c.lastVerified)
        }
      ]
    })
  )
  return { milestones, steps }
})

/** The operator's choices. An absent key means "as the server's current milestone says". */
const milestoneOpen = reactive<Record<string, boolean>>({})
const stepOpen = reactive<Record<string, boolean>>({})
const foldOpen = reactive<Record<string, boolean>>({})
const optionalOpen = ref(false)
/** The milestone whose Ask box is open. */
const askFor = ref<string | null>(null)

const LOOSE = '__loose'

/** The links the record holds for a step: the open step reads its paths from them. */
const rawLinksOf = (stepId: string): readonly RawLink[] =>
  props.detail.steps.find((x) => x.id === stepId)?.links ?? []

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
const toggleAsk = (id: string): void => {
  askFor.value = askFor.value === id ? null : id
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
}

const blocks = computed<Block[]>(() => {
  const { milestones, optional, loose } = tree.value
  if (loose) return [{ key: LOOSE, milestone: null, groups: loose }]
  const row = (m: PaneMilestoneRow): Block => ({ key: m.id, milestone: m, groups: m })
  if (optional.length === 0) return milestones.map(row)
  // Required milestones, then the one collapsed line, then the optional ones once it is opened.
  return [
    ...milestones.map(row),
    { key: '__optional', toggle: true, milestone: null, groups: { shown: [], folded: [] } },
    ...(optionalOpen.value ? optional.map(row) : [])
  ]
})

function summaryText(part: SummaryPart): string {
  switch (part.kind) {
    case 'running':
      return t('missionDropdown.tree.running', { n: part.n }, part.n)
    case 'waitingReview':
      return t('missionDropdown.tree.waitingReview', { n: part.n }, part.n)
    case 'blocked':
      return t('missionDropdown.tree.blocked', { n: part.n }, part.n)
    case 'nothingRunning':
      return t('missionDropdown.tree.nothingRunning')
    case 'allDone':
      return t('missionDropdown.tree.allDone')
  }
}
const summaryLength = (m: PaneMilestoneRow): number => milestoneSummary(m).length

/** A milestone draws its line only when another milestone row follows it. */
function milestoneLine(index: number): boolean {
  const next = blocks.value[index + 1]
  return next !== undefined && !next.toggle
}

// ---- Test it ----------------------------------------------------------------------------------------------

/** The ghost, compact "Ask" button. Alone at the right end, its padding and border hang past the edge. */
const ASK_BTN =
  'inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent bg-transparent px-2 text-[11px] font-medium leading-none text-text-3 transition hover:bg-surface-2 hover:text-text'

const milestoneWalk = (m: PaneMilestoneRow): WalkSource => ({
  kind: 'milestone',
  missionId: props.detail.id,
  milestoneId: m.id
})

// ---- the keyboard --------------------------------------------------------------------------------------

const root = ref<HTMLElement | null>(null)
/** The row last focused: the tree's one tab stop. */
const activeId = ref<string | null>(null)

/** The rows the operator can see, in the order they are drawn: what a key moves between. */
const visibleRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = []
  for (const b of blocks.value) {
    if (b.toggle) continue
    const parent = b.milestone
    if (parent) {
      const open = isOpen(parent)
      rows.push({ id: parent.id, parentId: null, open })
      if (!open) continue
    }
    for (const s of visibleSteps(b.key, b.groups)) {
      rows.push({ id: s.id, parentId: parent?.id ?? null, open: !!stepOpen[s.id] })
    }
  }
  return rows
})

/** The tab stop: the row last focused while it is still drawn, else the current milestone, else the first row. */
const tabStop = computed<string | null>(() => {
  const rows = visibleRows.value
  if (activeId.value && rows.some((r) => r.id === activeId.value)) return activeId.value
  const current = tree.value.milestones.find((m) => m.current)?.id
  if (current && rows.some((r) => r.id === current)) return current
  return rows[0]?.id ?? null
})

async function focusRow(id: string): Promise<void> {
  activeId.value = id
  await nextTick()
  root.value?.querySelector<HTMLElement>(`[data-row="${id}"]`)?.focus()
}

function toggleRow(id: string): void {
  const m = [...tree.value.milestones, ...tree.value.optional].find((x) => x.id === id)
  if (m) toggleMilestone(m)
  else toggleStep(id)
}

function onKeydown(e: KeyboardEvent): void {
  const target = e.target
  if (!(target instanceof HTMLElement)) return
  const row = target.closest<HTMLElement>('[role="treeitem"]')
  // Only the row's own keys: the PR link inside it (and Ask, and the fold) keep theirs.
  if (!row || row !== target || e.ctrlKey || e.metaKey || e.altKey) return
  const id = row.dataset.row
  if (!id) return
  const action = treeKeyAction(visibleRows.value, id, e.key)
  if (!action) return
  e.preventDefault()
  if ('focus' in action) void focusRow(action.focus)
  else toggleRow(action.toggle)
}

// ---- the pull request link --------------------------------------------------------------------------------

/** The pull request number is a link: it opens the pull request and never folds or unfolds the step. */
function openPr(ev: Event, s: PaneStepRow): void {
  ev.stopPropagation()
  ev.preventDefault()
  if (!s.prUrl) return
  void Promise.resolve(window.api.shellOpenExternal(s.prUrl)).catch(() => undefined)
}

// ---- "Open step" ------------------------------------------------------------------------------------------

/** "Open step": unfold the milestone and the step, then bring the step into view. */
async function openStep(stepId: string): Promise<void> {
  const mid = milestoneOfStep(tree.value, stepId)
  if (mid !== null) {
    milestoneOpen[mid] = true
    if (tree.value.optional.some((m) => m.id === mid)) optionalOpen.value = true
    const m = [...tree.value.milestones, ...tree.value.optional].find((x) => x.id === mid)
    if (m?.folded.some((s) => s.id === stepId)) foldOpen[mid] = true
  } else if (tree.value.loose?.folded.some((s) => s.id === stepId)) {
    foldOpen[LOOSE] = true
  }
  stepOpen[stepId] = true
  await nextTick()
  root.value?.querySelector(`[data-row="${stepId}"]`)?.scrollIntoView?.({ block: 'nearest' })
}

/** The Ask box of a milestone, for a state the dropdown opens for you (the sample's `ask`). */
function openAsk(milestoneId: string): void {
  askFor.value = milestoneId
}
defineExpose({ openStep, openAsk })
</script>

<template>
  <!-- Every row sits in a wrapper with a radius: a focus ring borrows its parent's (`:focus-visible` has
       `border-radius: inherit`), and a flat parent would flatten it. -->
  <div
    ref="root"
    role="tree"
    class="flex flex-col rounded-sm border-t border-border"
    style="padding: 8px 14px 10px"
    :aria-label="$t('missionDropdown.tree.label')"
    data-test="tree"
    @keydown="onKeydown"
  >
    <template v-for="(block, bi) in blocks" :key="block.key">
      <!-- Optional milestones sit under one collapsed line (outside the count). -->
      <button
        v-if="block.toggle"
        type="button"
        class="self-start text-text-4 transition hover:text-text"
        style="font-size: 11px; margin-top: 8px"
        :aria-expanded="optionalOpen"
        data-test="optional-toggle"
        @click="optionalOpen = !optionalOpen"
      >
        {{ $t('missionDropdown.tree.optional', { n: tree.optional.length }, tree.optional.length) }}
      </button>

      <div
        v-else
        class="flex flex-col rounded-sm"
        :class="
          block.milestone
            ? [
                'mission-tl mission-tl--milestone',
                {
                  'mission-tl--line': milestoneLine(bi),
                  'mission-tl--done': block.milestone.state === 'done'
                }
              ]
            : ''
        "
        :data-test="block.milestone ? 'milestone' : 'loose'"
        :data-milestone="block.milestone?.id"
      >
        <div v-if="block.milestone" class="rounded-sm" style="margin: 0 -6px">
          <div
            role="treeitem"
            :tabindex="tabStop === block.milestone.id ? 0 : -1"
            :aria-expanded="isOpen(block.milestone)"
            aria-level="1"
            class="mission-row grid cursor-pointer items-start rounded-sm text-text-3"
            style="
              grid-template-columns: 10px 12px minmax(0, 1fr) auto;
              column-gap: 8px;
              padding: 7px 6px;
              font-size: 12.5px;
              line-height: 16px;
            "
            data-test="milestone-row"
            :data-row="block.milestone.id"
            :data-milestone="block.milestone.id"
            :data-state="block.milestone.state"
            @focus="activeId = block.milestone.id"
            @click="toggleMilestone(block.milestone)"
          >
            <span class="flex h-4 items-center text-text-4" data-test="chevron">
              <ChevronDown v-if="isOpen(block.milestone)" :size="10" :stroke-width="1.5" />
              <ChevronRight v-else :size="10" :stroke-width="1.5" />
            </span>
            <MissionDot
              kind="milestone"
              :state="block.milestone.state"
              :current="block.milestone.current"
              class="mt-0.5"
              data-test="milestone-glyph"
            />
            <span class="flex min-w-0 flex-col gap-px [overflow-wrap:anywhere]">
              <span :class="block.milestone.current ? 'font-medium text-text' : ''">{{
                block.milestone.title
              }}</span>
              <span
                v-if="times.milestones.get(block.milestone.id)"
                class="tabular-nums text-text-4"
                style="font-size: 10.5px; font-weight: 400; line-height: 14px"
                data-test="milestone-time"
                >{{ times.milestones.get(block.milestone.id) }}</span
              >
              <span
                v-if="block.milestone.waitsFor"
                class="block text-text-4"
                style="font-size: 11px; line-height: 14px"
                data-test="waits-for"
                >{{
                  block.milestone.waitsForMore.length === 0
                    ? $t('missionDropdown.tree.waitsFor', { title: block.milestone.waitsFor.title })
                    : $t('missionDropdown.tree.waitsForMany', {
                        titles: [block.milestone.waitsFor, ...block.milestone.waitsForMore]
                          .map((w) => `“${w.title}”`)
                          .join(', ')
                      })
                }}</span
              >
            </span>
            <span class="tabular-nums text-text-4" style="font-size: 10.5px">{{
              `${block.milestone.done}/${block.milestone.total}`
            }}</span>
          </div>
        </div>

        <!-- The milestone's body (or the loose list): the rows sit under the glyph. -->
        <div
          v-if="!block.milestone || isOpen(block.milestone)"
          class="flex min-w-0 flex-col rounded-sm"
          :style="block.milestone ? 'margin-left: 30px; padding-bottom: 6px' : undefined"
          :role="block.milestone ? 'group' : undefined"
          data-test="milestone-body"
          :data-milestone="block.milestone?.id"
        >
          <!-- The summary line: the counts, then Ask at the right end with its own gap. It wraps rather than
               let the button touch the count (card BUG-287). -->
          <div
            v-if="block.milestone"
            class="flex flex-wrap items-center justify-between rounded-sm"
            style="gap: 4px 14px; padding: 2px 0 6px"
            data-test="milestone-summary"
          >
            <div
              class="min-w-0 text-text-4"
              style="font-size: 11px"
              data-test="milestone-summary-text"
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
            <!-- Ask keeps its own place when no walk is offered; with one, the pair sits together at the right end. -->
            <button
              v-if="askLeader && !walkEntryAvailable(milestoneWalk(block.milestone))"
              type="button"
              :class="[ASK_BTN, '-mr-[9px]']"
              :title="$t('missionDropdown.ask.openTitle')"
              :aria-expanded="askFor === block.milestone.id"
              data-test="ask-open"
              @click="toggleAsk(block.milestone.id)"
            >
              <MessageSquare :size="10" :stroke-width="1.6" aria-hidden="true" />{{
                $t('missionDropdown.ask.open')
              }}
            </button>
            <span
              v-else-if="walkEntryAvailable(milestoneWalk(block.milestone))"
              class="flex items-center rounded-sm"
              style="gap: 4px"
              data-test="milestone-acts"
            >
              <button
                v-if="askLeader"
                type="button"
                :class="ASK_BTN"
                :title="$t('missionDropdown.ask.openTitle')"
                :aria-expanded="askFor === block.milestone.id"
                data-test="ask-open"
                @click="toggleAsk(block.milestone.id)"
              >
                <MessageSquare :size="10" :stroke-width="1.6" aria-hidden="true" />{{
                  $t('missionDropdown.ask.open')
                }}
              </button>
              <span class="inline-flex rounded-sm">
                <button
                  type="button"
                  class="inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 px-2 text-[11px] font-medium leading-none text-text transition hover:border-text-4"
                  :title="$t('missionDropdown.testIt.milestone.tip')"
                  :aria-label="
                    $t('missionDropdown.testIt.aria', {
                      what: $t('missionDropdown.testIt.milestone.tip')
                    })
                  "
                  data-test="test-it-milestone"
                  @click="emit('walk', milestoneWalk(block.milestone))"
                >
                  <ListChecks :size="10" :stroke-width="2" aria-hidden="true" />{{
                    $t('missionDropdown.testIt.label')
                  }}
                </button>
              </span>
            </span>
          </div>
          <MissionDropdownAsk
            v-if="block.milestone && askLeader && askFor === block.milestone.id"
            :milestone-title="block.milestone.title"
            :leader-id="askLeader"
            @close="askFor = null"
          />

          <div
            v-for="(s, si) in visibleSteps(block.key, block.groups)"
            :key="s.id"
            class="mission-tl mission-tl--step rounded-sm"
            :class="{
              'mission-tl--line': si < visibleSteps(block.key, block.groups).length - 1,
              'mission-tl--done': s.state === 'done'
            }"
            data-test="step"
          >
            <div class="rounded-sm" style="margin: 0 -6px">
              <div
                role="treeitem"
                :tabindex="tabStop === s.id ? 0 : -1"
                :aria-expanded="!!stepOpen[s.id]"
                aria-level="2"
                class="mission-row grid w-full cursor-pointer items-start rounded-sm text-left text-text-2"
                style="
                  grid-template-columns: 10px 12px minmax(0, 1fr) auto;
                  column-gap: 7px;
                  padding: 6px 6px;
                  font-size: 12px;
                  line-height: 16px;
                "
                data-test="step-row"
                :data-row="s.id"
                :data-step="s.id"
                :data-parent="block.milestone?.id"
                :data-state="s.state"
                @focus="activeId = s.id"
                @click="toggleStep(s.id)"
              >
                <span class="flex h-4 items-center text-text-4" data-test="chevron">
                  <ChevronDown v-if="stepOpen[s.id]" :size="10" :stroke-width="1.5" />
                  <ChevronRight v-else :size="10" :stroke-width="1.5" />
                </span>
                <MissionDot kind="step" :state="s.state" :blocked="s.blocked" class="mt-0.5" />
                <span class="flex min-w-0 flex-col gap-px [overflow-wrap:anywhere]">
                  <span data-test="step-title">{{ s.title }}</span>
                  <span
                    v-if="times.steps.get(s.id)?.line"
                    class="tabular-nums text-text-4"
                    style="font-size: 10.5px; line-height: 14px"
                    data-test="step-time"
                    >{{ times.steps.get(s.id)?.line }}</span
                  >
                </span>
                <span
                  class="flex h-4 flex-wrap items-center rounded-sm"
                  style="gap: 6px; font-size: 10.5px"
                  data-test="step-meta"
                >
                  <!-- A link, not a button: the row is the tree item, and interactive content does not nest.
                       Its own tab stop; it never toggles the step. It comes before the Yours chip (`#21 Yours`). -->
                  <span
                    v-if="s.pr"
                    class="rounded-sm font-mono text-accent"
                    :class="s.prUrl ? 'cursor-pointer hover:underline' : ''"
                    :role="s.prUrl ? 'link' : undefined"
                    :tabindex="s.prUrl ? 0 : undefined"
                    :title="
                      s.prUrl
                        ? $t('missionDropdown.tree.openLink', { label: `#${s.pr}` })
                        : undefined
                    "
                    data-test="step-pr"
                    @click="openPr($event, s)"
                    @keydown.enter="openPr($event, s)"
                    @keydown.space="openPr($event, s)"
                    >#{{ s.pr }}</span
                  >
                  <span
                    v-if="s.needsYou"
                    class="rounded-sm border border-warning-line bg-warning-soft text-warning"
                    style="padding: 0 5px; line-height: 14px"
                    data-test="chip-yours"
                    >{{ $t('missionDropdown.tree.chipYours') }}</span
                  >
                </span>
              </div>
            </div>
            <MissionDropdownStep
              v-if="stepOpen[s.id]"
              :mission-id="detail.id"
              :step="s"
              :raw-links="rawLinksOf(s.id)"
              :open-since="times.steps.get(s.id)?.openSince ?? null"
              :last-verified="times.steps.get(s.id)?.lastVerified ?? null"
              @walk="emit('walk', $event)"
            />
          </div>

          <button
            v-if="block.groups.folded.length > 0"
            type="button"
            class="self-start text-text-4 transition hover:text-text"
            style="font-size: 11px; margin: 2px 0 0 29px"
            :aria-expanded="!!foldOpen[block.key]"
            data-test="fold-more"
            @click="toggleFold(block.key)"
          >
            {{
              foldOpen[block.key]
                ? $t('missionDropdown.tree.less')
                : $t(
                    'missionDropdown.tree.more',
                    { n: block.groups.folded.length },
                    block.groups.folded.length
                  )
            }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
