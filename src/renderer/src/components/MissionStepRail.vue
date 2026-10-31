<script setup lang="ts">
/**
 * Mission step rail (T370; Mission v3 S3 — design.md §6 "Mission progress" →
 * Step rail). One row per counted step: the rail glyph (one of the seven
 * visuals the server's progress gives it), the label with its badges, captions,
 * the step's human checks, inline blocker/stale/re-scope callouts and the child
 * sessions whose row sits on this step. Campaign spec §3.2 adds the locked glyph,
 * a decision node under its step (options + Choose…) and the collapsible Side
 * bucket (`required: false` steps, each with the rail letter it was discovered
 * from). Presentation over the view model; it emits the operator's per-step doors
 * (the human-step tick, the checks, Choose) for the popover to run, and handles
 * the in-app go-to-session itself.
 */
import { nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  CircleCheck,
  Clock,
  Contrast,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Diamond,
  Lock,
  LogIn,
  TriangleAlert,
  Undo2,
  X
} from 'lucide-vue-next'
import type { MissionView } from '../../../main/mission-ipc'
import type { MissionChildState } from '../../../main/mcp/fleet-snapshot'
import {
  formatDuration,
  OPERATOR_VERIFIER_ID,
  pulseText,
  type GateDot,
  type MissionModel,
  type StepModel,
  type StepPrModel,
  type StepVisual
} from '../lib/mission-view'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { useUiStore } from '../stores/ui'

const props = defineProps<{
  view: MissionView
  model: MissionModel
  /** A door is in flight — the per-row controls are disabled until it lands. */
  busy: boolean
}>()

const emit = defineEmits<{
  tick: [stepId: string, verified: boolean]
  addCheck: [stepId: string, label: string, done: () => void]
  /** `settle(ok)` — the popover calls it once the door answered. */
  tickCheck: [stepId: string, checkId: string, ticked: boolean, settle: (ok: boolean) => void]
  deleteCheck: [stepId: string, checkId: string]
  /** Campaign spec §4 — the operator picks an option of a decision node. */
  choose: [stepId: string, index: number]
}>()

const { t } = useI18n()
const sessions = useSessionsStore()
const ui = useUiStore()

const VISUAL_KEY: Record<StepVisual, string> = {
  verified: 'verified',
  done: 'done',
  running: 'running',
  waiting: 'waiting',
  blocked: 'blocked',
  todo: 'todo',
  locked: 'locked',
  'left-behind': 'leftBehind'
}

/**
 * Gate dots (design.md §6 "Mission progress" → Gate dots; campaign spec §3.2). One
 * 7px ring per fact, tokens only: green/red fill, a half-filled accent ring that
 * pulses while it is in progress, a hollow ring when there is no signal yet, a
 * dashed faint ring when the gate does not apply.
 */
const GATE_DOT_CLASS: Record<GateDot['state'], string> = {
  green: 'border-green bg-green',
  red: 'border-red bg-red',
  running:
    'anim-tick-pulse border-accent bg-linear-to-r from-accent from-50% to-transparent to-[50%]',
  off: 'border-text-4',
  na: 'border-dashed border-text-4 opacity-50'
}

function gateTitle(s: StepModel, g: GateDot): string {
  return t(s.gatesStale ? 'mission.gates.tooltipStale' : 'mission.gates.tooltip', {
    gate: t(`mission.gates.name.${g.name}`),
    state: t(`mission.gates.state.${g.state}`)
  })
}

function labelClass(s: StepModel): string {
  if (s.current) return 'font-medium text-text'
  if (s.visual === 'verified' || s.visual === 'done') return 'text-text-3'
  if (s.visual === 'left-behind') return 'text-text-2'
  return 'text-text-4 opacity-70'
}

function childLabel(c: MissionChildState): string {
  const known = sessions.allSessions.find((s) => s.sessionId === c.sessionId)
  return (
    (known && sessionTitle(known, sessions.allSessions, t)) ||
    c.folderAlias ||
    c.sessionId.slice(0, 8)
  )
}

type ChildLook =
  'working' | 'workingHelpers' | 'needsInput' | 'idle' | 'parked' | 'failed' | 'unknown'

function childLook(c: MissionChildState): ChildLook {
  if (!c.known) return 'unknown'
  if (c.hibernated) return 'parked'
  if (c.taskState === 'working') return c.waitingOnHelpers ? 'workingHelpers' : 'working'
  if (c.taskState === 'needs-input' || c.pendingApprovals > 0) return 'needsInput'
  if (c.taskState === 'failed') return 'failed'
  return 'idle'
}

const CHILD_DOT: Record<ChildLook, string> = {
  working: 'anim-pulse-dot bg-green',
  workingHelpers: 'anim-pulse-dot bg-green',
  needsInput: 'anim-attention-dot bg-warning',
  idle: 'bg-text-4',
  parked: 'bg-text-4',
  failed: 'bg-red',
  unknown: 'bg-text-4'
}

/** Select the child session in-app; a session the sidebar has not loaded toasts instead. */
function goTo(sessionId: string): void {
  if (sessions.allSessions.some((s) => s.sessionId === sessionId)) {
    sessions.activateSession(sessionId)
    return
  }
  ui.pushToast({
    kind: 'info',
    title: t('mission.child.notLoaded'),
    description: t('mission.child.notLoadedBody'),
    persist: false
  })
}

function verifiedCaption(s: StepModel): string | null {
  const by = s.step.verifiedBy
  if (!by) return null
  const who =
    by.sessionId === OPERATOR_VERIFIER_ID ? t('mission.verifiedByYou') : by.sessionId.slice(0, 8)
  return t('mission.verifiedCaption', { who, verdict: by.verdict ?? 'met' })
}

/** The operator verified this human step themselves — only then offer Unmark. */
function operatorTicked(s: StepModel): boolean {
  return s.step.proof === 'verified' && s.step.verifiedBy?.sessionId === OPERATOR_VERIFIER_ID
}

/** "PR #7 · open" — the PR line's leading part; the CI state follows in its own tone. */
function prLine(p: StepPrModel): string {
  const state = p.state === 'MERGED' ? 'merged' : p.draft ? 'isDraft' : 'open'
  return t('mission.pr.line', { n: p.number, state: t(`mission.pr.state.${state}`) })
}

const CI_CLASS: Record<Exclude<StepPrModel['ci'], 'unknown'>, string> = {
  passing: 'text-green',
  failing: 'text-red',
  pending: 'text-text-3'
}

function staleDuration(): string {
  return formatDuration(props.model.staleForMs ?? 0)
}

/** The Side bucket starts collapsed (mockup state `default`); the header toggles it. */
const sideOpen = ref(false)

/** The option picked per decision node, before the operator commits it with Choose…. */
const picked = ref<Record<string, number>>({})

function sideMeta(): string {
  const { open, done } = props.model.side
  return done > 0 && sideOpen.value
    ? t('mission.side.metaBoth', { open, done })
    : t('mission.side.metaOpen', { open })
}

/** The step whose "+ check" input is open, and what is typed in it. */
const addingOn = ref<string | null>(null)
const draftLabel = ref('')
const inputEl = ref<HTMLInputElement[] | HTMLInputElement | null>(null)

async function startAdd(stepId: string): Promise<void> {
  addingOn.value = stepId
  draftLabel.value = ''
  await nextTick()
  const el = Array.isArray(inputEl.value) ? inputEl.value[0] : inputEl.value
  el?.focus()
}

function cancelAdd(): void {
  addingOn.value = null
  draftLabel.value = ''
}

function submitAdd(stepId: string): void {
  const label = draftLabel.value.trim()
  if (!label) return cancelAdd()
  emit('addCheck', stepId, label, cancelAdd)
}

/**
 * The checkbox flips in the DOM before the door answers. A refused door leaves
 * `c.ticked` unchanged, so the `:checked` binding never re-applies — put the box
 * back to the server's value ourselves; an accepted door re-renders it anyway.
 */
function onCheckChange(stepId: string, checkId: string, e: Event): void {
  const box = e.target as HTMLInputElement
  const requested = box.checked
  emit('tickCheck', stepId, checkId, requested, (ok) => {
    if (!ok) box.checked = !requested
  })
}
</script>

<template>
  <div class="flex flex-col" data-dsqa="mission-step-rail">
    <div
      v-for="s in model.steps"
      :key="s.step.id"
      class="group/step relative flex"
      :class="s.last ? '' : 'pb-4'"
      style="gap: 10px"
      :data-step="s.step.id"
      :data-position="s.position"
      :data-visual="s.visual"
      :aria-current="s.current ? 'step' : undefined"
    >
      <!-- Rail: the glyph, and a 2px connector down to the next row. -->
      <div class="relative flex w-4 shrink-0 justify-center">
        <span
          v-if="!s.last"
          class="absolute w-0.5 bg-border-2"
          style="top: 15px; bottom: -16px"
          aria-hidden="true"
        />
        <span
          class="relative z-[1] flex shrink-0 items-center justify-center rounded-full bg-surface"
          :class="
            s.current && (s.visual === 'todo' || s.visual === 'waiting')
              ? 'ring-3 ring-accent-soft'
              : ''
          "
          style="width: 12px; height: 12px; margin-top: 2px"
          data-glyph
          :title="$t(`mission.visual.${VISUAL_KEY[s.visual]}`)"
          role="img"
          :aria-label="$t(`mission.visual.${VISUAL_KEY[s.visual]}`)"
        >
          <span
            v-if="s.visual === 'verified'"
            class="flex items-center justify-center rounded-full bg-green"
            style="width: 12px; height: 12px"
          >
            <Check :size="8" :stroke-width="3" class="text-bg" />
          </span>
          <CircleCheck
            v-else-if="s.visual === 'done'"
            :size="12"
            :stroke-width="2"
            class="text-text-3"
          />
          <span
            v-else-if="s.visual === 'running'"
            class="anim-pulse-dot rounded-full bg-accent"
            style="width: 8px; height: 8px; --pulse-from: 0.5"
          />
          <Contrast
            v-else-if="s.visual === 'waiting'"
            :size="12"
            :stroke-width="2"
            class="text-text-3"
          />
          <TriangleAlert
            v-else-if="s.visual === 'blocked'"
            :size="12"
            :stroke-width="2"
            class="text-warning"
          />
          <Lock
            v-else-if="s.visual === 'locked'"
            :size="10"
            :stroke-width="2"
            class="text-text-4"
          />
          <Undo2
            v-else-if="s.visual === 'left-behind'"
            :size="12"
            :stroke-width="2"
            class="text-warning"
          />
          <span
            v-else
            class="rounded-full border-[1.5px] border-text-4"
            style="width: 8px; height: 8px"
          />
        </span>
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center" style="gap: 6px; row-gap: 4px">
          <span
            v-if="s.letter"
            class="shrink-0 tabular-nums text-text-4"
            style="font-size: 10.5px; font-weight: 500"
            data-letter
            >{{ s.letter }}</span
          >
          <span :class="labelClass(s)" style="font-size: 12.5px">{{ s.step.title }}</span>
          <span
            class="inline-flex items-center"
            style="gap: 4px"
            role="group"
            :aria-label="$t('mission.gates.label')"
            data-gates
          >
            <span
              v-for="g in s.gates"
              :key="g.name"
              class="shrink-0 rounded-full border-[1.5px]"
              :class="GATE_DOT_CLASS[g.state]"
              style="width: 7px; height: 7px"
              role="img"
              :title="gateTitle(s, g)"
              :aria-label="gateTitle(s, g)"
              :data-gate="g.name"
              :data-state="g.state"
            />
          </span>
          <span
            v-if="s.added"
            class="mission-badge border-accent-line bg-accent-soft text-accent"
            >{{ $t('mission.added') }}</span
          >
          <span
            v-if="s.showVerification"
            class="mission-badge border-border bg-surface text-text-3"
            >{{ $t(`mission.verification.${s.step.verification}`) }}</span
          >
          <span
            v-if="s.proofBadge === 'claimed'"
            class="mission-badge border-border bg-surface text-text-3"
            >{{ $t('mission.proof.claimed') }}</span
          >
          <span
            v-else-if="s.proofBadge === 'proven'"
            class="mission-badge border-green-line bg-green-soft text-green"
          >
            <Check :size="10" :stroke-width="2" />{{ $t('mission.proof.proven') }}
          </span>
          <span
            v-if="s.rescopePending"
            class="mission-badge border-warning-line bg-warning-soft text-warning"
            >{{ $t('mission.rescopeBadge') }}</span
          >
          <!-- The operator's tick (a `human` step) — the per-row inline pill idiom. -->
          <template v-if="s.canTick">
            <button
              v-if="!operatorTicked(s)"
              type="button"
              class="mission-badge border-accent-line bg-accent-soft text-accent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="busy"
              data-test="mission-tick"
              @click="emit('tick', s.step.id, true)"
            >
              <Check :size="10" :stroke-width="2" />{{ $t('mission.markVerified') }}
            </button>
            <button
              v-else
              type="button"
              class="text-text-4 transition hover:text-text-2 disabled:cursor-not-allowed disabled:opacity-40"
              style="font-size: 11px"
              :disabled="busy"
              data-test="mission-untick"
              @click="emit('tick', s.step.id, false)"
            >
              {{ $t('mission.unmark') }}
            </button>
          </template>
          <!-- "+ check" (Mission v3 §3.6): on the current steps, else revealed on hover/focus. -->
          <button
            v-if="addingOn !== s.step.id"
            type="button"
            class="ml-auto text-text-4 transition hover:text-text-2 focus-visible:opacity-100 disabled:cursor-not-allowed"
            :class="s.current ? '' : 'opacity-0 group-hover/step:opacity-100'"
            style="font-size: 11px"
            :disabled="busy"
            data-test="mission-check-add"
            @click="startAdd(s.step.id)"
          >
            {{ $t('mission.checks.add') }}
          </button>
        </div>

        <div v-if="s.added && s.step.addedReason" class="mission-caption">
          {{ $t('mission.addedCaption', { reason: s.step.addedReason }) }}
        </div>
        <div
          v-if="s.isEnd && s.visual === 'verified' && verifiedCaption(s)"
          class="mission-caption"
        >
          {{ verifiedCaption(s) }}
        </div>
        <div v-if="s.isEnd" class="mission-caption">
          {{
            $t('mission.endCaption', {
              kind: view.mission.declaredEnd.kind,
              target: view.mission.declaredEnd.target,
              evidence: view.mission.declaredEnd.evidence
            })
          }}
        </div>

        <!-- Step pulse (T547): movement inside the step, beside — never instead of — "Step N of M". -->
        <div
          v-if="s.pulse && pulseText($t, s.pulse)"
          class="mission-caption mission-pulse tabular-nums"
          :data-pulse="s.pulse.kind"
          data-test="mission-pulse"
        >
          {{ pulseText($t, s.pulse) }}
        </div>
        <div
          v-for="p in s.prs"
          :key="p.number"
          class="mission-caption mission-pr tabular-nums"
          data-test="mission-pr"
          :data-pr="p.number"
          :title="p.url"
        >
          {{ prLine(p) }}
          <template v-if="p.ci !== 'unknown'">
            ·
            <span :class="CI_CLASS[p.ci]" :data-ci="p.ci">{{ $t(`mission.pr.ci.${p.ci}`) }}</span>
          </template>
        </div>

        <!-- Human checks (Mission v3 §3.6) — ticked, added and deleted through the doors. -->
        <div
          v-if="s.checks.length"
          class="flex flex-col"
          style="gap: 3px; margin-top: 5px"
          data-test="mission-checks"
        >
          <div
            v-for="c in s.checks"
            :key="c.id"
            class="group/check flex items-center"
            style="gap: 6px; font-size: 11.5px; line-height: 1.5"
            data-test="mission-check"
            :data-check="c.id"
          >
            <label class="flex min-w-0 flex-1 cursor-pointer items-center" style="gap: 6px">
              <input
                type="checkbox"
                class="shrink-0 cursor-pointer disabled:cursor-not-allowed"
                style="width: 12px; height: 12px; accent-color: var(--color-accent)"
                :checked="!!c.ticked"
                :disabled="busy"
                :aria-label="$t('mission.checks.tick', { label: c.label })"
                data-test="mission-check-box"
                @change="onCheckChange(s.step.id, c.id, $event)"
              />
              <span
                class="min-w-0 truncate"
                :class="c.ticked ? 'text-text-4 line-through' : 'text-text-2'"
                :title="c.label"
                >{{ c.label }}</span
              >
              <span
                v-if="!c.ticked && s.checksDue"
                class="shrink-0 text-warning"
                style="font-size: 10.5px"
                data-test="mission-check-due"
                >{{ $t('mission.checks.due') }}</span
              >
            </label>
            <button
              type="button"
              class="flex shrink-0 text-text-4 opacity-0 transition hover:text-red focus-visible:opacity-100 group-hover/check:opacity-100 disabled:cursor-not-allowed"
              :disabled="busy"
              :title="$t('mission.checks.delete')"
              :aria-label="$t('mission.checks.delete')"
              data-test="mission-check-delete"
              @click="emit('deleteCheck', s.step.id, c.id)"
            >
              <X :size="11" :stroke-width="1.8" />
            </button>
          </div>
        </div>
        <div v-if="addingOn === s.step.id" style="margin-top: 5px">
          <input
            ref="inputEl"
            v-model="draftLabel"
            type="text"
            maxlength="200"
            class="h-6 w-full rounded-sm border border-border-2 bg-bg text-text outline-none focus:border-accent-line"
            style="padding: 0 7px; font-size: 11.5px"
            :placeholder="$t('mission.checks.placeholder')"
            :disabled="busy"
            data-test="mission-check-input"
            @keydown.enter.prevent="submitAdd(s.step.id)"
            @keydown.esc.stop.prevent="cancelAdd"
          />
        </div>

        <!-- Decision node (Campaign spec §3.2): options, what it blocks, and the operator's Choose…. -->
        <div
          v-if="s.decision && s.decision.canChoose"
          class="rounded-sm border border-border-2 bg-surface-2"
          style="margin-top: 6px; padding: 8px 10px"
          data-dsqa-part="decision-node"
          data-test="mission-decision"
        >
          <div class="flex items-center" style="gap: 6px; font-size: 12px; font-weight: 500">
            <Diamond :size="10" :stroke-width="2" class="shrink-0 fill-accent text-accent" />
            <span class="min-w-0 truncate text-text" :title="s.decision.title">{{
              s.decision.title
            }}</span>
            <span
              v-if="s.decision.blocks.length"
              class="mission-badge ml-auto border-warning-line bg-warning-soft text-warning"
              >{{ $t('mission.decision.blocks', { steps: s.decision.blocks.join(', ') }) }}</span
            >
          </div>
          <div role="radiogroup" :aria-label="$t('mission.decision.options')">
            <button
              v-for="(o, i) in s.decision.options"
              :key="i"
              type="button"
              role="radio"
              :aria-checked="picked[s.step.id] === i"
              class="mission-option flex w-full items-center text-left"
              :class="picked[s.step.id] === i ? 'is-picked' : ''"
              :disabled="busy"
              data-test="mission-decision-option"
              @click="picked[s.step.id] = i"
            >
              <i class="mission-option-dot" aria-hidden="true" />{{ o }}
            </button>
          </div>
          <div style="margin-top: 8px">
            <button
              type="button"
              class="inline-flex h-6 items-center rounded-sm bg-accent text-accent-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              style="padding: 0 10px; font-size: 11.5px; font-weight: 500"
              :disabled="busy || picked[s.step.id] === undefined"
              :title="
                picked[s.step.id] === undefined ? $t('mission.decision.pickFirst') : undefined
              "
              data-test="mission-decision-choose"
              @click="emit('choose', s.step.id, picked[s.step.id])"
            >
              {{ $t('mission.decision.choose') }}
            </button>
          </div>
        </div>
        <div
          v-else-if="s.decision"
          class="flex items-center text-accent"
          style="gap: 5px; margin-top: 3px; font-size: 11px"
          data-test="mission-decision-chosen"
        >
          <Diamond :size="10" :stroke-width="2" class="shrink-0 fill-accent" />
          <span class="min-w-0 truncate"
            >{{ s.decision.title }} ·
            {{
              $t('mission.decision.chose', { option: s.decision.options[s.decision.chosen ?? 0] })
            }}</span
          >
        </div>

        <!-- Blocked — decision 12's three fields, one line. -->
        <div
          v-for="(b, i) in s.blockers"
          :key="`b${i}`"
          class="mission-callout border-warning-line bg-warning-soft text-warning"
          data-test="mission-blocked"
        >
          <TriangleAlert :size="13" :stroke-width="1.8" class="mt-0.5 shrink-0" />
          <span
            ><b class="font-semibold">{{ $t('mission.blocked') }}</b>
            {{
              $t('mission.blockedBody', {
                reason: b.reason,
                unblocks: b.unblocks,
                owner: $t(`mission.blockerOwner.${b.owner}`)
              })
            }}</span
          >
        </div>

        <!-- Stale — derived, under the first current step. -->
        <div
          v-if="s.firstCurrent && model.stale"
          class="mission-callout border-warning-line bg-warning-soft text-warning"
          data-test="mission-stale"
        >
          <Clock :size="13" :stroke-width="1.8" class="mt-0.5 shrink-0" />
          <span
            ><b class="font-semibold">{{ $t('mission.stale') }}</b>
            {{ $t('mission.staleBody', { duration: staleDuration() }) }}</span
          >
        </div>

        <!-- Re-scope — was / now on the end step. -->
        <div
          v-if="s.rescopePending && view.mission.pendingRescope"
          class="mission-callout border-warning-line bg-warning-soft text-warning"
          data-test="mission-rescope"
        >
          <TriangleAlert :size="13" :stroke-width="1.8" class="mt-0.5 shrink-0" />
          <span class="min-w-0"
            ><b class="font-semibold">{{ $t('mission.rescopeTitle') }}</b
            ><br />{{ $t('mission.was') }}
            <code class="font-mono">{{ view.mission.declaredEnd.kind }}</code> ·
            {{ view.mission.declaredEnd.target }}<br />{{ $t('mission.now') }}
            <code class="font-mono">{{ view.mission.pendingRescope.kind }}</code> ·
            {{ view.mission.pendingRescope.target }}</span
          >
        </div>

        <!-- Child sessions whose ONE row sits on this step (Mission v3 §3.2). -->
        <div
          v-for="c in s.children"
          :key="c.sessionId"
          class="flex items-center rounded-sm bg-surface-2"
          style="gap: 6px; margin: 5px 0 0 2px; padding: 4px 8px; font-size: 11.5px"
          data-test="mission-child"
          :data-session="c.sessionId"
        >
          <CornerDownRight :size="11" :stroke-width="1.6" class="shrink-0 text-text-4" />
          <span
            class="shrink-0 rounded-full"
            :class="CHILD_DOT[childLook(c)]"
            style="width: 6px; height: 6px"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate font-mono text-text-2" style="font-size: 11px">{{
            childLabel(c)
          }}</span>
          <span class="shrink-0 text-text-4" style="font-size: 10.5px">{{
            $t(`mission.child.${childLook(c)}`)
          }}</span>
          <button
            type="button"
            class="flex shrink-0 text-text-4 transition hover:text-text-2"
            :title="$t('mission.child.goTo')"
            :aria-label="$t('mission.child.goTo')"
            data-test="mission-child-goto"
            @click="goTo(c.sessionId)"
          >
            <LogIn :size="12" :stroke-width="1.6" />
          </button>
        </div>
        <div v-if="s.elsewhere > 0" class="mission-caption" data-test="mission-child-elsewhere">
          {{ $t('mission.child.elsewhere', { n: s.elsewhere }, s.elsewhere) }}
        </div>
      </div>
    </div>

    <!-- Side bucket (Campaign spec §3.2): required: false steps, outside the headline. -->
    <div
      v-if="model.side.count > 0"
      class="border-t border-border"
      style="margin-top: 14px; padding-top: 10px"
      data-dsqa-part="side-bucket"
      data-test="mission-side"
    >
      <button
        type="button"
        class="flex w-full items-center bg-transparent text-left text-text-2"
        style="gap: 6px; font-size: 11.5px"
        :aria-expanded="sideOpen"
        :aria-label="sideOpen ? $t('mission.side.hide') : $t('mission.side.show')"
        data-test="mission-side-toggle"
        @click="sideOpen = !sideOpen"
      >
        <component
          :is="sideOpen ? ChevronDown : ChevronRight"
          :size="12"
          :stroke-width="2"
          class="shrink-0 text-text-4"
        />
        <Diamond :size="10" :stroke-width="2" class="shrink-0 text-text-4" />
        {{ $t('mission.side.title') }}
        <span class="ml-auto tabular-nums text-text-4" style="font-size: 10.5px">{{
          sideMeta()
        }}</span>
      </button>
      <div v-if="sideOpen" class="mission-sidelist relative" style="margin-top: 6px">
        <div
          v-for="sd in model.side.steps"
          :key="sd.step.id"
          class="relative flex items-center"
          style="gap: 8px; padding: 5px 0 5px 20px; min-height: 28px; font-size: 11.5px"
          :data-side-step="sd.step.id"
          :data-state="sd.state"
        >
          <span class="absolute flex items-center justify-center" style="left: 0; width: 12px">
            <CircleCheck
              v-if="sd.state === 'verified' || sd.state === 'done'"
              :size="12"
              :stroke-width="2"
              class="text-text-3"
            />
            <Diamond v-else :size="10" :stroke-width="2" class="text-text-4" />
          </span>
          <span class="min-w-0 text-text-3">
            {{ sd.step.title }}
            <small v-if="sd.origin" class="block text-text-4" style="font-size: 10.5px">{{
              $t('mission.side.discoveredFrom', { origin: sd.origin })
            }}</small>
          </span>
          <span
            v-if="sd.state !== 'verified' && sd.state !== 'done'"
            class="mission-badge ml-auto shrink-0 border-border bg-surface text-text-3"
            >{{ $t('mission.side.open') }}</span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* design.md §6 Badges — the Badge anatomy, reused as-is (no new variant). */
.mission-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  border-width: 1px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.mission-caption {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-4);
}
.mission-pulse,
.mission-pr {
  color: var(--color-text-3);
}
.mission-pulse[data-pulse='quiet'] {
  color: var(--color-warning);
}
.mission-option {
  gap: 8px;
  margin-top: 6px;
  padding: 5px 8px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font-size: 11.5px;
  color: var(--color-text-2);
}
.mission-option.is-picked {
  border-color: var(--color-accent-line);
  color: var(--color-text);
}
.mission-option-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--color-text-4);
}
.is-picked .mission-option-dot {
  border-color: var(--color-accent);
  background: var(--color-accent);
}
.mission-sidelist::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 12px;
  bottom: 12px;
  border-left: 2px dashed var(--color-border-2);
}
.mission-callout {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 5px;
  padding: 6px 8px;
  border-width: 1px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.5;
}
</style>
