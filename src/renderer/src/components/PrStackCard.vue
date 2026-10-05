<script setup lang="ts">
/**
 * T198 — one node of the PR Stack Canvas.
 *
 * Fixed 272px so the layout pass can pack columns deterministically. Collapsed
 * it carries only what decides in one second; the drawer answers the
 * follow-ups. What it renders is governed by the world's zoom level (`lod`) —
 * zoom sheds DETAIL, not pixels. design.md §6 "PR Stack Canvas".
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  GitBranch,
  GitMerge,
  Zap,
  Check,
  X,
  Clock,
  Timer,
  ArrowDown,
  CheckSquare,
  ChevronDown,
  ExternalLink,
  House,
  TriangleAlert,
  Copy,
  MessageSquare
} from 'lucide-vue-next'
import type { Lod, PrNode } from '../../../main/pr-stack-core'
import {
  shortAgo,
  roleBarClass,
  prStatusInput,
  prStatusSlot,
  prStatusChipClass,
  prStatusLabelKey,
  prWaitingOn,
  PR_WAITING_CHIP_CLASS,
  formatDiffSize,
  DIFF_SIZE_CHIP_CLASS,
  type DiffSizeLabels,
  autoMergeDetail,
  prThreadChip,
  prThreadsDrawer,
  labelChips,
  prBehindState,
  prBehindChipLabel,
  prBehindDrawerLabel,
  prMergeStateNoteKey,
  type PrLabel
} from './pr-stack-format'
import { usePrStackStore } from '../stores/pr-stack'

const props = defineProps<{
  node: PrNode
  /**
   * Commits this PR's branch is behind its base, as counted by the LOCAL
   * checkout: `0` = measured and current, `undefined` = git could not measure
   * it here. Only enriches the chip — GitHub's verdict decides it (T274).
   */
  behind?: number
  lod: Lod
  expanded: boolean
  /** Sitting at an operator-chosen position rather than a computed one. */
  moved: boolean
  /** Wall clock, passed in so every card ticks together and none owns a timer. */
  now: number
  /** Linked Harnu worktree, when one exists for this PR's branch. */
  worktree?: { path: string; sessionLive: boolean } | null
  /**
   * A folder of THIS repo to review from when no worktree holds the branch
   * (T246). The review fetches `refs/pull/<n>/head` and diffs it read-only, so
   * a PR nobody checked out is still reviewable — which is the common case for
   * someone else's PR.
   */
  repoFolder?: string | null
  /** Wearing the focus ring — a transcript link just brought the canvas here. */
  highlighted?: boolean
}>()

const emit = defineEmits<{
  toggle: [id: string]
  openGithub: [url: string]
  openWorktree: [path: string]
  openReview: [target: { folder: string; prNumber: number | null }]
  copyRetarget: [command: string]
  copyBranch: [branch: string]
}>()

const { t } = useI18n()

const id = computed(() => String(props.node.pr.number))
const baseMerged = computed(() => props.node.baseKind === 'merged')
/** GitHub's raw fields translated once, so `DIRTY` reads as conflicts everywhere. */
const statusInput = computed(() => prStatusInput(props.node.pr, baseMerged.value))
const blocked = computed(
  () => props.node.pr.ci === 'failing' || statusInput.value.mergeable === false
)
const failingCount = computed(
  () => props.node.pr.checks.filter((c) => c.state === 'failing').length
)
const runningCount = computed(
  () => props.node.pr.checks.filter((c) => c.state === 'pending').length
)
/**
 * T273 — the status slot: ONE chip, chosen by a pure precedence function rather
 * than a template ladder, so T274..T279 change `prStatusSlot()` instead of
 * adding a seventh `v-else-if` here. Precedence is documented on the function.
 */
const statusSlot = computed(() => prStatusSlot(statusInput.value))
const statusChipClass = computed(() => prStatusChipClass(statusSlot.value))
const statusLabel = computed(() => t(prStatusLabelKey(statusSlot.value)))
/**
 * T277 — who the neutral `review` is waiting on. Gated by passing the slot the
 * card already resolved, so a verdict silences it without a second ladder here;
 * `null` whenever there is nothing to name, so the chip is never empty.
 */
const waitingOn = computed(() => prWaitingOn(statusSlot.value, props.node.pr.reviewRequests))
const waitingList = computed(() => waitingOn.value?.all.join(', ') ?? '')

/**
 * T276 — diff size, the cheapest honest proxy for review cost. `''` when any
 * count is missing, which draws no chip: never `+0 −0 · 0 files`. The chip
 * abbreviates thousands; the drawer row carries the exact counts.
 */
const diffLabels = computed<DiffSizeLabels>(() => ({
  files: (n, count) => t('prStack.diffFiles', n, { named: { n: count } }),
  empty: t('prStack.emptyDiff')
}))
const diffSize = computed(() => formatDiffSize(props.node.pr, diffLabels.value))
const diffSizeExact = computed(() =>
  formatDiffSize(props.node.pr, diffLabels.value, { exact: true })
)

/**
 * T279 — auto-merge armed: the PR lands by itself once its requirements clear,
 * so it is not waiting on the operator. A state of the CARD, not a verdict, so
 * it never enters `prStatusSlot()`.
 */
const autoMerge = computed(() => props.node.pr.autoMergeRequest ?? null)
const autoMergeText = computed(() => {
  if (!autoMerge.value) return null
  const detail = autoMergeDetail(autoMerge.value)
  return t(detail.key, detail.params)
})

/**
 * T275 — unresolved review threads. An additive chip after the status slot,
 * never a replacement for it; `null` (no chip) both when the count is zero and
 * when the threads could not be read, because absence is not zero.
 */
const threadChip = computed(() => prThreadChip(props.node.pr))
const threadsTitle = computed(() =>
  threadChip.value
    ? t('prStack.threadsTitle', props.node.pr.unresolvedThreads ?? 0, {
        named: { n: threadChip.value.count }
      })
    : ''
)
/** The drawer row — the one place outdated threads are shown. Absent when unread. */
const threadsRow = computed(() => {
  const row = prThreadsDrawer(props.node.pr)
  if (!row) return null
  return row.outdated
    ? t('prStack.threadsBreakdown', { n: row.unresolved, outdated: row.outdated })
    : t('prStack.unresolved', { n: row.unresolved })
})

/**
 * T278 — label chips, opt-in (Settings → PR Stack, off by default). The toggle
 * is read from the store's prefs rather than passed down, since the Settings
 * pane already re-reads them there after every write. Cap, LOD gating and the
 * drawer split are `labelChips()`'s job, not the template's.
 */
const prStack = usePrStackStore()
const labels = computed(() =>
  labelChips(props.node.pr.labels, props.lod, prStack.prefs?.showLabels === true)
)

/**
 * T274 — behind its base. GitHub's `mergeStateStatus` decides whether the chip
 * shows (so it survives a branch never fetched here); the local count only adds
 * the number. The drawer always says which of the three states the card is in.
 */
const behindState = computed(() => prBehindState(props.node.pr.mergeStateStatus, props.behind))
const label = (l: PrLabel): string => (l.n === undefined ? t(l.key) : t(l.key, { n: l.n }))
const behindChip = computed(() => {
  const l = prBehindChipLabel(behindState.value)
  return l ? label(l) : null
})
const behindDrawer = computed(() => label(prBehindDrawerLabel(behindState.value)))
const mergeNoteKey = computed(() => prMergeStateNoteKey(props.node.pr))

/** The marker strip is NOT reserved space — a roleless PR stays quiet. */
const hasMarker = computed(
  () => props.node.isStagingTip || props.node.isMergeNext || baseMerged.value
)

const barClass = computed(() =>
  roleBarClass({
    isStagingTip: props.node.isStagingTip,
    isMergeNext: props.node.isMergeNext,
    baseMerged: baseMerged.value,
    blocked: blocked.value
  })
)

/** Role tint on the card's own border — never on a wrapper element. */
const borderClass = computed(() => {
  if (blocked.value) return 'border-red/45'
  if (baseMerged.value) return 'border-warning/45'
  if (props.node.isStagingTip) return 'border-accent-line'
  return 'border-border'
})

const retargetCommand = computed(
  () => `gh pr edit ${props.node.pr.number} --base ${props.node.pr.base}`
)

/**
 * The card's one link goes to the PULL REQUEST, not to the branch tree. The
 * branch name is what identifies the card to the eye, but a card IS a PR: the
 * page anyone wants after reading one is the PR's own. The raw ref is still one
 * click away through the copy button beside it.
 */
const prUrl = computed(() => props.node.pr.url)

/**
 * Where the review runs, and whether it reads a local branch or the PR's own
 * head.
 *
 * A worktree WINS when one exists: that checkout is the operator's own copy,
 * its uncommitted files are real evidence about it, and swapping it for a
 * fetched `refs/pull` ref would quietly review something else. With no
 * worktree, the repo folder plus the PR number is enough — the head is fetched
 * and diffed without a working tree.
 */
const reviewTarget = computed<{ folder: string; prNumber: number | null } | null>(() => {
  if (props.worktree) return { folder: props.worktree.path, prNumber: null }
  if (props.repoFolder) return { folder: props.repoFolder, prNumber: props.node.pr.number }
  return null
})
</script>

<template>
  <!-- LOD: far — a 32px pill. Only the role bar, the number and the carry
       count survive; everything else is unreadable at this scale anyway. -->
  <article
    v-if="lod === 'far'"
    class="pr-focus-ring flex h-8 w-[272px] items-center gap-2 overflow-hidden rounded-lg border bg-surface pr-2.5"
    :class="[borderClass, highlighted ? 'pr-focus-ring--on' : '']"
  >
    <span class="h-full w-[3px] flex-none" :class="barClass" />
    <span class="font-mono text-xs font-semibold tabular-nums text-text-2">
      #{{ node.pr.number }}
    </span>
    <span v-if="node.carries > 1" class="ml-auto text-[10.5px] tabular-nums text-text-4">
      {{ t('prStack.carries', { n: node.carries }) }}
    </span>
  </article>

  <article
    v-else
    class="pr-focus-ring relative w-[272px] overflow-hidden rounded-lg border bg-surface"
    :class="[borderClass, moved ? 'pl-[3px]' : '', highlighted ? 'pr-focus-ring--on' : '']"
  >
    <!-- A card at an operator-chosen position. Deliberately quiet: provenance,
         not a state to act on. -->
    <span
      v-if="moved"
      class="absolute bottom-2 left-0 top-2 w-0.5 border-l-2 border-dotted border-text-4"
    />

    <!-- Marker strip — 0-2 role chips plus the carry count. Shed below 0.70. -->
    <div
      v-if="hasMarker && lod === 'full'"
      class="flex h-6 items-center gap-1.5 border-b border-border bg-surface-2 pl-[9px] pr-2"
    >
      <span
        v-if="node.isStagingTip"
        class="inline-flex h-4 items-center gap-1 rounded-sm bg-accent-soft px-[5px] text-[9.5px] font-bold uppercase tracking-[0.07em] text-accent"
      >
        <Zap :size="9" :stroke-width="2.4" />
        {{ t('prStack.stagingTip') }}
      </span>
      <span
        v-if="node.isMergeNext"
        class="inline-flex h-4 items-center gap-1 rounded-sm bg-green-soft px-[5px] text-[9.5px] font-bold uppercase tracking-[0.07em] text-green"
      >
        <GitMerge :size="9" :stroke-width="2.4" />
        {{ t('prStack.mergeNext') }}
      </span>
      <span
        v-if="baseMerged"
        class="inline-flex h-4 items-center gap-1 rounded-sm bg-warning/12 px-[5px] text-[9.5px] font-bold uppercase tracking-[0.07em] text-warning"
      >
        <TriangleAlert :size="9" :stroke-width="2.4" />
        {{ t('prStack.baseMerged') }}
      </span>
      <!-- Omitted at N = 1: a one-PR chain carries only itself. -->
      <span
        v-if="node.carries > 1"
        class="ml-auto text-[9.5px] font-semibold tabular-nums text-text-4"
      >
        {{ t('prStack.carries', { n: node.carries }) }}
      </span>
    </div>

    <div class="px-2.5 pb-2 pt-[9px]">
      <div class="flex h-3.5 items-center gap-1.5">
        <span class="font-mono text-[11px] font-semibold tabular-nums text-text-3">
          #{{ node.pr.number }}
        </span>
        <!-- Draft is a CARD-level state, not a verdict, so it sits on the
             identity row rather than in the status slot: a draft's review state
             is not meaningful, and burying `changes requested` behind "not
             finished yet" would lose the more actionable of the two. The row
             survives `compact`, which is the only place the badge could live and
             still be visible below 0.70. Neutral tokens — spec §4.3 reserves red
             and green for verdicts. -->
        <span
          v-if="node.pr.isDraft"
          class="inline-flex h-3.5 flex-none items-center rounded-sm bg-surface-2 px-[5px] text-[9px] font-bold uppercase tracking-[0.07em] text-text-3"
        >
          {{ t('prStack.draft') }}
        </span>
        <!-- T275 — at `compact` the readiness row is shed, so the thread count
             moves up here: spec §4.2 budgets it for both levels, and "is this
             waiting on the author?" is still worth answering on a crowded
             canvas. The draft badge's 14px recipe, warn-toned like the full
             chip; the sentence lives in the title. -->
        <span
          v-if="lod === 'compact' && threadChip"
          class="inline-flex h-3.5 flex-none items-center gap-[3px] rounded-sm bg-warning/10 px-[5px] text-[9px] font-bold tabular-nums text-warning"
          role="img"
          :title="threadsTitle"
          :aria-label="threadsTitle"
          data-test="pr-card-threads"
        >
          <MessageSquare :size="9" :stroke-width="2.4" />
          {{ threadChip.count }}
        </span>
        <!-- T279 — auto-merge armed, beside the age. A state of the card, not a
             verdict, so it stays out of the status slot; on the identity row it
             survives `compact`, where a PR that lands by itself still has to
             read differently from one waiting on a human. Neutral tone: spec
             §4.3 spends red and green on verdicts, and `--accent` already marks
             the staging tip. `Timer`, not `Zap`: a lone PR off main is both
             staging tip and merge next, and a second lightning bolt beside the
             staging-tip chip's would read as the same signal twice. -->
        <span class="ml-auto flex flex-none items-center gap-1">
          <span
            v-if="autoMerge"
            role="img"
            class="inline-flex text-text-3"
            :title="t('prStack.autoMergeTitle')"
            :aria-label="t('prStack.autoMergeTitle')"
            data-test="pr-card-automerge"
          >
            <Timer :size="11" />
          </span>
          <span class="text-[10.5px] tabular-nums text-text-4">
            {{ shortAgo(node.pr.updatedAt, now) }}
          </span>
        </span>
      </div>

      <h3
        class="mt-1 overflow-hidden text-[13px] font-semibold leading-[1.32] text-text"
        :class="lod === 'compact' ? 'line-clamp-1' : 'line-clamp-2'"
        :title="node.pr.title"
      >
        {{ node.pr.title }}
      </h3>

      <template v-if="lod === 'full'">
        <!-- The branch line is the card's one link: the name opens the PULL
             REQUEST on GitHub, and a copy button surfaces on hover for a local
             checkout. At rest it looks exactly like the inert line it
             replaced. -->
        <div class="group/branch mt-[5px] flex min-w-0 items-center gap-[5px] text-text-4">
          <GitBranch :size="11" class="flex-none" />
          <button
            v-if="prUrl"
            class="min-w-0 truncate font-mono text-[10.5px] transition-colors hover:text-accent hover:underline"
            :title="t('prStack.openPr', { n: node.pr.number })"
            @click.stop="emit('openGithub', prUrl)"
          >
            {{ node.pr.branch }}
          </button>
          <span v-else class="truncate font-mono text-[10.5px]">{{ node.pr.branch }}</span>
          <div class="ml-auto flex flex-none items-center gap-1">
            <!-- Unlike the copy button, the worktree jump stays visible at rest:
                 "this PR is checked out locally" is information, not just an
                 action, and it is rare enough that showing it is a signal
                 rather than ink on every card. -->
            <button
              v-if="worktree"
              class="inline-flex h-4 items-center gap-1 rounded-sm px-[3px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
              :title="t('prStack.openWorktree')"
              :aria-label="t('prStack.openWorktree')"
              @click.stop="emit('openWorktree', worktree.path)"
            >
              <span
                v-if="worktree.sessionLive"
                class="anim-pulse-dot h-1.5 w-1.5 rounded-full bg-green"
              />
              <House :size="10" />
            </button>
            <button
              class="grid h-4 w-4 place-items-center rounded-sm opacity-0 transition-opacity hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover/branch:opacity-100"
              :title="t('prStack.copyBranch')"
              :aria-label="t('prStack.copyBranch')"
              @click.stop="emit('copyBranch', node.pr.branch)"
            >
              <Copy :size="10" />
            </button>
          </div>
        </div>

        <div class="mt-2 flex items-center gap-1">
          <!-- The chips live in their own clipped track: the expand chevron is
               the card's only always-reachable control, and an overflowing chip
               row must never push it off a 272px card. The track clips from the
               trailing edge, so DOM order is clip order: the CI chip, then the
               status slot, then additive chips. Only the additive chips may
               overflow, and each must also be in the drawer (spec §4.2 —
               `behind` is, as the vs-base row; labels are, as the labels row,
               and sit last because they are the lowest signal on the card).
               The CI chip and the status slot are NOT repeated in the drawer,
               so a unit that adds a chip ahead of them, or lengthens their
               labels, must keep them inside the track or add them to the
               drawer. -->
          <div class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <span
              v-if="failingCount > 0"
              class="inline-flex h-[18px] flex-none items-center gap-[3px] rounded-sm bg-red-soft px-[5px] text-[10px] font-semibold text-red"
            >
              <X :size="10" />
              {{ t('prStack.failing', { n: failingCount }) }}
            </span>
            <span
              v-else-if="runningCount > 0"
              class="inline-flex h-[18px] flex-none items-center gap-[3px] rounded-sm bg-surface-2 px-[5px] text-[10px] font-semibold text-text-3"
            >
              <Clock :size="10" />
              {{ t('prStack.running', { n: runningCount }) }}
            </span>
            <span
              v-else-if="node.pr.ci === 'passing'"
              class="inline-flex h-[18px] flex-none items-center gap-[3px] rounded-sm bg-green-soft px-[5px] text-[10px] font-semibold text-green"
            >
              <Check :size="10" />
              {{ t('prStack.ci') }}
            </span>

            <!-- The status slot: exactly one chip, picked by `prStatusSlot()`. -->
            <span
              class="inline-flex h-[18px] flex-none items-center rounded-sm px-[5px] text-[10px] font-semibold"
              :class="statusChipClass"
              :data-status="statusSlot"
            >
              {{ statusLabel }}
            </span>

            <!-- T275 — the first additive chip, so it is the last one to clip;
                 the drawer's threads row repeats it. -->
            <span
              v-if="threadChip"
              class="inline-flex h-[18px] flex-none items-center gap-[3px] rounded-sm bg-warning/10 px-[5px] text-[10px] font-semibold tabular-nums text-warning"
              :title="threadsTitle"
              data-test="pr-card-threads"
            >
              <MessageSquare :size="10" />
              {{ t('prStack.unresolved', { n: threadChip.count }) }}
            </span>

            <!-- `5 behind` when git counted it here, bare `behind` when only
                 GitHub knows (T274). Never a chip for "not measured": that
                 lives in the drawer's vs-base row, which is always present. -->
            <span
              v-if="behindChip"
              class="inline-flex h-[18px] flex-none items-center gap-[3px] rounded-sm bg-warning/10 px-[5px] text-[10px] font-semibold text-warning"
              data-test="pr-card-behind"
            >
              <ArrowDown :size="10" />
              {{ behindChip }}
            </span>

            <!-- T277 — additive and informational, so it sits AFTER `behind`:
                 the spec §4.2 budget ranks `behind` higher (it survives
                 `compact`), and a long login must clip this chip, never the
                 warning. The drawer's waiting-on row repeats the full list. The
                 login is capped so a long one cannot push `+N` out of the chip. -->
            <span
              v-if="waitingOn"
              class="inline-flex h-[18px] flex-none items-center gap-[3px] rounded-sm px-[5px] text-[10px] font-semibold"
              :class="PR_WAITING_CHIP_CLASS"
              :title="waitingList"
              data-chip="waiting"
            >
              <span class="max-w-32 truncate">{{
                t('prStack.waiting', { who: waitingOn.lead })
              }}</span>
              <span v-if="waitingOn.more" class="tabular-nums">{{ waitingOn.more }}</span>
            </span>

            <!-- T276 — diff size, right before the labels track (spec §4.2 —
                 labels are the lowest-priority signal, so they clip first).
                 Repeated exactly in the drawer's `diff` row. Muted on purpose:
                 size is not a verdict, and spec §4.3 reserves red and green
                 for verdicts — GitHub's +green −red convention is deliberately
                 not followed. Only reachable at `lod === 'full'`, like the
                 rest of this row.
                 It goes WHOLE, never half: the track clips at the pixel edge,
                 and a half-shown `+412 −3` would misreport the size. So the
                 chip sits in its own one-line wrapping slot that takes the
                 room left in the track; the zero-width spacer holds line one,
                 and a chip that does not fit beside it wraps to line two,
                 which the slot's fixed height hides. -->
            <span
              v-if="diffSize"
              class="flex h-[18px] min-w-0 flex-1 flex-wrap overflow-hidden"
              data-test="pr-card-diff-size-slot"
            >
              <span class="h-[18px] w-0" aria-hidden="true" />
              <span
                class="inline-flex h-[18px] flex-none items-center rounded-sm px-[5px] text-[10px] font-semibold tabular-nums"
                :class="DIFF_SIZE_CHIP_CLASS"
                data-test="pr-card-diff-size"
              >
                {{ diffSize }}
              </span>
            </span>

            <!-- Labels: neutral tokens only — the label's text is the signal,
                 and GitHub's hex never reaches the renderer (spec §4.3). Last
                 in the track, so it is the first thing to clip — labels are
                 the lowest-priority signal on the card. Unlike every chip
                 before them they SHRINK (to an ellipsis, floored at min-w-8)
                 before the track clips, so the `+N` count after them survives
                 a crowded row instead of being the first thing cut off. -->
            <span
              v-for="labelName in labels.chips"
              :key="labelName"
              class="inline-flex h-[18px] min-w-8 max-w-24 items-center rounded-sm bg-surface-2 px-[5px] text-[10px] font-medium text-text-3"
              :title="labelName"
              data-test="pr-card-label"
            >
              <span class="min-w-0 truncate">{{ labelName }}</span>
            </span>
            <span
              v-if="labels.hidden > 0"
              class="inline-flex h-[18px] flex-none items-center text-[10px] font-semibold tabular-nums text-text-4"
              :title="t('prStack.labelsMoreHint', { n: labels.hidden })"
              data-test="pr-card-label-more"
            >
              {{ t('prStack.labelsMore', { n: labels.hidden }) }}
            </span>
          </div>

          <button
            class="grid h-5 w-5 flex-none place-items-center rounded-sm text-text-4 transition-colors hover:bg-surface-2 hover:text-text"
            :aria-label="expanded ? t('prStack.collapse') : t('prStack.expand')"
            @click.stop="emit('toggle', id)"
          >
            <ChevronDown
              :size="13"
              :class="expanded ? 'rotate-180' : ''"
              class="transition-transform"
            />
          </button>
        </div>
      </template>
    </div>

    <div
      v-if="expanded && lod === 'full'"
      class="border-t border-border bg-bg px-2.5 pb-[9px] pt-2"
    >
      <dl class="grid grid-cols-[64px_1fr] gap-x-2 gap-y-[3px] text-[10.5px]">
        <dt class="text-text-4">{{ t('prStack.base') }}</dt>
        <dd class="truncate font-mono text-text-2">{{ node.pr.base }}</dd>
        <dt class="text-text-4">{{ t('prStack.author') }}</dt>
        <dd class="truncate text-text-2">{{ node.pr.author }}</dd>
        <dt v-if="waitingOn" class="text-text-4">{{ t('prStack.waitingOn') }}</dt>
        <dd v-if="waitingOn" class="truncate text-text-2" :title="waitingList">
          {{ waitingList }}
        </dd>
        <dt v-if="autoMergeText" class="text-text-4">{{ t('prStack.autoMerge') }}</dt>
        <dd v-if="autoMergeText" class="truncate text-text-2" data-test="pr-card-automerge-detail">
          {{ autoMergeText }}
        </dd>
        <!-- Always rendered (T274): an absent row used to mean both "up to
             date" and "never fetched here". `unmeasured` is an absence of
             data, not a finding, so it takes the quieter tone. -->
        <dt class="text-text-4">{{ t('prStack.vsBase') }}</dt>
        <dd
          class="truncate"
          :class="behindState.kind === 'unmeasured' ? 'text-text-3' : 'text-text-2'"
          :title="behindDrawer"
          :data-behind="behindState.kind"
          data-test="pr-card-vs-base"
        >
          {{ behindDrawer }}
        </dd>
        <dt v-if="mergeNoteKey" class="text-text-4">{{ t('prStack.mergeState') }}</dt>
        <dd
          v-if="mergeNoteKey"
          class="truncate text-text-2"
          :title="t(mergeNoteKey)"
          data-test="pr-card-merge-state"
        >
          {{ t(mergeNoteKey) }}
        </dd>
        <dt v-if="diffSizeExact" class="text-text-4">{{ t('prStack.diff') }}</dt>
        <dd v-if="diffSizeExact" class="truncate tabular-nums text-text-2">
          {{ diffSizeExact }}
        </dd>
        <dt v-if="threadsRow" class="text-text-4">{{ t('prStack.threads') }}</dt>
        <dd v-if="threadsRow" class="truncate text-text-2" data-test="pr-card-threads-row">
          {{ threadsRow }}
        </dd>
        <dt v-if="labels.drawer.length > 0" class="text-text-4">{{ t('prStack.labels') }}</dt>
        <dd
          v-if="labels.drawer.length > 0"
          class="break-words text-text-2"
          data-test="pr-card-label-list"
        >
          {{ labels.drawer.join(', ') }}
        </dd>
        <dt v-if="worktree" class="text-text-4">{{ t('prStack.worktree') }}</dt>
        <dd v-if="worktree" class="flex items-center gap-1.5 truncate text-text-2">
          <span
            v-if="worktree.sessionLive"
            class="anim-pulse-dot h-1.5 w-1.5 flex-none rounded-full bg-green"
          />
          <span class="truncate">{{ worktree.path.split('/').pop() }}</span>
        </dd>
      </dl>

      <div
        v-if="node.pr.checks.length > 0"
        class="mt-2 flex flex-col gap-1 border-t border-border pt-2"
      >
        <div
          v-for="check in node.pr.checks"
          :key="check.name"
          class="flex items-center gap-1.5 text-[10.5px]"
          :class="{
            'text-green': check.state === 'passing',
            'text-red': check.state === 'failing',
            'text-text-4': check.state !== 'passing' && check.state !== 'failing'
          }"
        >
          <Check v-if="check.state === 'passing'" :size="11" />
          <X v-else-if="check.state === 'failing'" :size="11" />
          <Clock v-else :size="11" />
          <span class="truncate">{{ check.name }}</span>
        </div>
      </div>

      <!-- Read-only by design: the canvas is a read model, and a write to
           GitHub is a different risk class. The one repair it can diagnose but
           will not perform is handed over as a copyable command. -->
      <div class="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
        <button
          class="inline-flex h-[22px] items-center gap-[5px] rounded-sm border border-border-2 px-2 text-[10.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          @click.stop="emit('openGithub', node.pr.url)"
        >
          <ExternalLink :size="11" />
          {{ t('prStack.github') }}
        </button>
        <!-- T164 / PRD §9 Q3 — the review takeover for THIS PR's branch, not for
             whatever folder happens to be active. A PR node is where "it says
             it is done, is it?" actually gets asked, which is why this is the
             better of the two entry points the operator asked for.

             T246 moved the gate from *has a worktree* to *can resolve a folder
             for this repo*: the review now fetches `refs/pull/<n>/head` and
             diffs it read-only, so a PR nobody checked out here — the common
             shape of someone else's PR — is reviewable too. The gate stays a
             gate, though: with neither a worktree nor a repo folder there is no
             head to resolve, and a button that opens an empty or wrong diff is
             the exact failure this whole card exists to avoid. -->
        <button
          v-if="reviewTarget"
          class="inline-flex h-[22px] items-center gap-[5px] rounded-sm border border-border-2 px-2 text-[10.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          data-test="pr-card-review"
          @click.stop="emit('openReview', reviewTarget)"
        >
          <CheckSquare :size="11" />
          {{ t('prStack.reviewBranch') }}
        </button>
        <button
          v-if="worktree"
          class="inline-flex h-[22px] items-center gap-[5px] rounded-sm border border-border-2 px-2 text-[10.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          @click.stop="emit('openWorktree', worktree.path)"
        >
          <House :size="11" />
          {{ t('prStack.openWorktree') }}
        </button>
        <button
          v-if="baseMerged"
          class="inline-flex h-[22px] basis-full items-center gap-[5px] overflow-hidden whitespace-nowrap rounded-sm border border-border-2 bg-bg px-2 font-mono text-[10.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          @click.stop="emit('copyRetarget', retargetCommand)"
        >
          <Copy :size="11" />
          {{ retargetCommand }}
        </button>
      </div>
    </div>
  </article>
</template>
