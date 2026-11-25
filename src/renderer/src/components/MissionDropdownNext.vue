<script setup lang="ts">
/**
 * Mission dropdown — the one card that holds what the operator owes next (Missions v4; design.md §6 "Mission
 * dropdown" → "What it draws" 2; mockup `docs/design/mission-dropdown/`, states `mid`, `owed`, `done-when`,
 * `attach-request` and `ready`).
 *
 * ONE card, three looks of the same thing: the next step (`you`, `ok` when it is the close, `calm` when nothing
 * is owed); a staged Done when (accent, Approve and Decline); a request to join (accent, Allow and Deny). A
 * staged Done when is never also an ask with a "Review it" hop: it REPLACES the re-scope item of the waiting list
 * (`nextCardOf`). Buttons are the compact size (`h-5`, `px-2`, `11px`). For a step the button sits at the RIGHT of
 * the text when the dropdown body is 380px wide or more and UNDER it below that: a container query on the shell's
 * `@container` body (`@min-[380px]:`), never the window's width. "{n} more waiting on you" is a link under the
 * why that opens the rest in place, a row each, with the same rule.
 *
 * It computes nothing about the mission: the ranking and the numbers are the server's, the words are
 * `waitingText` (worded from the kind and the record, in the reader's language, a blocker's own text as written),
 * and the doors go through the store, which reads the view again after every reply. The first button of the card
 * carries `data-autofocus`: the shell gives it focus when the dropdown opens.
 */
import { computed, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, Flag, X } from 'lucide-vue-next'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import {
  nextCardOf,
  nextEntryLook,
  sessionNameOf,
  waitingStepId,
  waitingText,
  type MissionV4Reply,
  type NextCardLook,
  type NextEntry
} from '../lib/mission-pane-view'

const props = defineProps<{ mission: MissionV4Reply }>()
const emit = defineEmits<{
  /** Open this step in the tree (S-4 owns the open step). */
  openStep: [stepId: string]
  /** Close the mission (S-5 owns the dialog). */
  close: []
}>()

const { t } = useI18n()
const missions = useMissionsStore()
const sessions = useSessionsStore()

const card = computed(() => nextCardOf(props.mission))
const look = computed<NextCardLook>(() => nextEntryLook(card.value.primary))
const detail = computed(() => props.mission.detail)
/** Which card it is: a step (or nothing owed), a staged Done when, or a request to join. */
const cardKind = computed<'step' | 'staged' | 'request'>(() => {
  const p = card.value.primary
  if (p === null) return 'step'
  if (p.kind === 'staged') return 'staged'
  return p.item.kind === 'attach' ? 'request' : 'step'
})

const moreOpen = ref(false)
const busy = ref(false)
const note = ref<{ kind: 'info' | 'error'; text: string } | null>(null)

// ---- what each entry says -------------------------------------------------------------------------------

interface Words {
  ask: string
  why: string | null
}

function wordsOf(entry: NextEntry): Words {
  if (entry.kind === 'staged')
    return { ask: entry.text, why: t('missionDropdown.next.doneWhenHint') }
  const item = entry.item
  if (item.kind === 'attach') {
    const asker = sessionNameOf(item.sessionId, sessions.allSessions, t)
    return {
      ask: t('missionDropdown.next.requestText', { session: asker, mission: detail.value.title }),
      why: null
    }
  }
  const w = waitingText(t, detail.value, item)
  return { ask: w.ask, why: w.why || null }
}

const eyebrowOf = (entry: NextEntry): string =>
  entry.kind === 'staged'
    ? t('missionDropdown.next.doneWhenEyebrow')
    : entry.item.kind === 'attach'
      ? t('missionDropdown.next.requestEyebrow')
      : t('missionDropdown.next.you')

/** The kind word of a row of "more waiting": a staged Done when reads as the re-scope it replaced. */
const kindOf = (entry: NextEntry): string => (entry.kind === 'staged' ? 'rescope' : entry.item.kind)

// ---- the buttons ------------------------------------------------------------------------------------------

interface Action {
  testId: string
  label: string
  icon: Component
  primary: boolean
  run: () => void
}

/** The compact buttons an entry offers: a step opens, a close closes, a Done when and a request decide. */
function actionsOf(entry: NextEntry): Action[] {
  if (entry.kind === 'staged') {
    return [
      {
        testId: 'next-staged-approve',
        label: t('missionDropdown.next.approve'),
        icon: Check,
        primary: true,
        run: () => void decideDoneWhen('approveDoneWhen')
      },
      {
        testId: 'next-staged-decline',
        label: t('missionDropdown.next.decline'),
        icon: X,
        primary: false,
        run: () => void decideDoneWhen('declineDoneWhen')
      }
    ]
  }
  const item = entry.item
  if (item.kind === 'attach') {
    return [
      {
        testId: 'next-request-allow',
        label: t('missionDropdown.next.allow'),
        icon: Check,
        primary: true,
        run: () => void decideAttach(item.requestId, 'allowed')
      },
      {
        testId: 'next-request-deny',
        label: t('missionDropdown.next.deny'),
        icon: X,
        primary: false,
        run: () => void decideAttach(item.requestId, 'denied')
      }
    ]
  }
  if (item.kind === 'close') {
    return [
      {
        testId: 'next-button',
        label: t('missionDropdown.next.close'),
        icon: Flag,
        primary: true,
        run: () => emit('close')
      }
    ]
  }
  const stepId = waitingStepId(item)
  // An item with no single step to open (a review of several) draws no button.
  return stepId
    ? [
        {
          testId: 'next-button',
          label: t('missionDropdown.next.openStep'),
          icon: ArrowRight,
          primary: true,
          run: () => emit('openStep', stepId)
        }
      ]
    : []
}

const primaryActions = computed(() => (card.value.primary ? actionsOf(card.value.primary) : []))

async function decide(run: () => Promise<{ ok: boolean; changed?: boolean }>): Promise<void> {
  if (busy.value) return
  busy.value = true
  note.value = null
  try {
    const res = await run()
    if (!res.ok) note.value = { kind: 'error', text: t('missionDropdown.next.error') }
    else if (res.changed === false) {
      note.value = { kind: 'info', text: t('missionDropdown.next.already') }
    }
  } finally {
    busy.value = false
  }
}
const decideDoneWhen = (door: 'approveDoneWhen' | 'declineDoneWhen'): Promise<void> =>
  decide(() => missions.runV4Door({ door }))
const decideAttach = (requestId: string, decision: 'allowed' | 'denied'): Promise<void> =>
  decide(() =>
    missions.runV4DoorOn(props.mission.missionId, { door: 'decideAttach', requestId, decision })
  )

/** Nothing waits on the operator: say what runs, counted from the server's numbers. */
const calmLine = computed(() => {
  const running = detail.value.progress.counts.running
  return running > 0
    ? t('missionDropdown.next.running', { n: running }, running)
    : t('missionDropdown.next.idle')
})

// ---- classes ----------------------------------------------------------------------------------------------

/** The compact button (design.md §6 "Mission dropdown"): `h-5`, `px-2`, `11px`; never the large one. */
const BTN =
  'inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border px-2 text-[11px] font-medium leading-none transition disabled:cursor-not-allowed disabled:opacity-40'
const BTN_PRIMARY = 'border-accent bg-accent text-accent-ink hover:brightness-110'
const BTN_SOFT = 'border-border-2 bg-surface-2 text-text hover:border-text-4'

const BOX: Record<NextCardLook, string> = {
  you: 'border-warning-line bg-warning-soft',
  ok: 'border-green-line bg-green-soft',
  accent: 'border-accent-line bg-accent-soft',
  calm: 'border-border-2 bg-surface-2'
}
const EYEBROW: Record<NextCardLook, string> = {
  you: 'text-warning',
  ok: 'text-green',
  accent: 'text-accent',
  calm: 'text-text-4'
}
/** The kind's colour in a row of "more waiting on you". */
const KIND: Record<string, string> = {
  'main-failing': 'text-red',
  unblock: 'text-red',
  rescope: 'text-warning',
  settle: 'text-warning',
  review: 'text-text-3',
  close: 'text-green',
  attach: 'text-accent'
}

/** The wide rule, once: button at the right of the text from 380px of body, under the text below. */
const WIDE_COLS = '@min-[380px]:grid-cols-[minmax(0,1fr)_auto]'
</script>

<template>
  <section
    class="rounded border"
    :class="BOX[look]"
    style="margin: 0 14px 12px; padding: 10px 12px"
    :aria-label="$t('missionDropdown.next.label')"
    :data-look="look"
    :data-card="cardKind"
    data-dsqa-part="next"
    data-test="next-card"
  >
    <!-- A step: eyebrow and text, with the button centred at their right (wide) or under the text (narrow). -->
    <div
      v-if="cardKind === 'step'"
      class="grid grid-cols-[minmax(0,1fr)]"
      :class="WIDE_COLS"
      style="gap: 4px 12px"
      data-test="next-layout"
    >
      <span
        class="uppercase @min-[380px]:col-start-1 @min-[380px]:row-start-1 @min-[380px]:self-baseline"
        :class="EYEBROW[look]"
        style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
        >{{
          look === 'calm' ? $t('missionDropdown.next.calm') : $t('missionDropdown.next.you')
        }}</span
      >
      <div class="min-w-0 @min-[380px]:col-start-1 @min-[380px]:row-start-2" data-test="next-body">
        <template v-if="card.primary">
          <div class="text-text [overflow-wrap:anywhere]" style="font-size: 13px; line-height: 1.4">
            {{ wordsOf(card.primary).ask }}
          </div>
          <div
            v-if="wordsOf(card.primary).why"
            class="text-text-3 [overflow-wrap:anywhere]"
            style="font-size: 11.5px; margin-top: 4px"
          >
            {{ wordsOf(card.primary).why }}
          </div>
        </template>
        <div
          v-else
          class="text-text [overflow-wrap:anywhere]"
          style="font-size: 13px; line-height: 1.4"
          data-test="next-calm"
        >
          {{ calmLine }}
        </div>
        <button
          v-if="card.more.length > 0"
          type="button"
          class="inline-flex items-center text-text-3 transition hover:text-text"
          style="margin-top: 6px; gap: 4px; font-size: 11.5px"
          :aria-expanded="moreOpen"
          data-test="next-more"
          @click="moreOpen = !moreOpen"
        >
          {{
            moreOpen
              ? $t('missionDropdown.next.less')
              : $t('missionDropdown.next.more', { n: card.more.length }, card.more.length)
          }}
        </button>
      </div>
      <div
        v-if="primaryActions.length > 0"
        class="mt-1 flex flex-wrap items-start rounded-sm @min-[380px]:col-start-2 @min-[380px]:row-span-2 @min-[380px]:row-start-1 @min-[380px]:mt-0 @min-[380px]:self-center"
        style="gap: 6px"
        data-test="next-actions"
      >
        <button
          v-for="(a, i) in primaryActions"
          :key="a.testId"
          type="button"
          :class="[BTN, a.primary ? BTN_PRIMARY : BTN_SOFT]"
          :disabled="busy"
          :data-test="a.testId"
          :data-autofocus="i === 0 ? '' : undefined"
          @click="a.run()"
        >
          <component :is="a.icon" :size="10" :stroke-width="2" aria-hidden="true" />{{ a.label }}
        </button>
      </div>
    </div>

    <!-- A staged Done when or a request to join: the text, then its two buttons under it. -->
    <template v-else-if="card.primary">
      <span
        class="block uppercase"
        :class="EYEBROW[look]"
        style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
        >{{ eyebrowOf(card.primary) }}</span
      >
      <div
        class="grid grid-cols-[minmax(0,1fr)]"
        style="gap: 8px; margin-top: 4px"
        data-test="next-body"
      >
        <div
          class="text-text [overflow-wrap:anywhere]"
          :style="{
            fontSize: card.primary.kind === 'staged' ? '13px' : '12px',
            lineHeight: '1.4'
          }"
        >
          {{ wordsOf(card.primary).ask }}
        </div>
        <div
          v-if="wordsOf(card.primary).why"
          class="mt-1 text-text-3 [overflow-wrap:anywhere]"
          style="font-size: 11.5px"
        >
          {{ wordsOf(card.primary).why }}
        </div>
        <div
          class="flex flex-wrap items-start rounded-sm"
          style="gap: 6px"
          data-test="next-actions"
        >
          <button
            v-for="(a, i) in primaryActions"
            :key="a.testId"
            type="button"
            :class="[BTN, a.primary ? BTN_PRIMARY : BTN_SOFT]"
            :disabled="busy"
            :data-test="a.testId"
            :data-autofocus="i === 0 ? '' : undefined"
            @click="a.run()"
          >
            <component :is="a.icon" :size="10" :stroke-width="2" aria-hidden="true" />{{ a.label }}
          </button>
        </div>
      </div>
      <button
        v-if="card.more.length > 0"
        type="button"
        class="inline-flex items-center text-text-3 transition hover:text-text"
        style="margin-top: 6px; gap: 4px; font-size: 11.5px"
        :aria-expanded="moreOpen"
        data-test="next-more"
        @click="moreOpen = !moreOpen"
      >
        {{
          moreOpen
            ? $t('missionDropdown.next.less')
            : $t('missionDropdown.next.more', { n: card.more.length }, card.more.length)
        }}
      </button>
    </template>

    <span
      v-if="note"
      class="block break-words"
      :class="note.kind === 'error' ? 'text-red' : 'text-text-3'"
      style="margin-top: 6px; font-size: 11.5px; line-height: 1.4"
      :role="note.kind === 'error' ? 'alert' : 'status'"
      data-test="next-note"
      >{{ note.text }}</span
    >

    <!-- The rest, in place: one row per other item, in the server's order; the same right-or-below rule. -->
    <div
      v-if="moreOpen && card.more.length > 0"
      class="border-t border-border"
      style="margin-top: 8px"
      data-dsqa-part="waiting-rest"
    >
      <div
        v-for="(entry, i) in card.more"
        :key="entry.kind === 'staged' ? 'staged' : entry.item.id"
        class="grid grid-cols-[minmax(0,1fr)] border-border"
        :class="[WIDE_COLS, i > 0 ? 'border-t' : '']"
        style="padding: 8px 0; gap: 4px 12px"
        data-test="next-rest-row"
        :data-kind="kindOf(entry)"
      >
        <div class="min-w-0 text-text [overflow-wrap:anywhere]" style="font-size: 12px">
          <span
            class="uppercase"
            :class="KIND[kindOf(entry)]"
            style="font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; margin-right: 6px"
            >{{ $t(`missionDropdown.next.kind.${kindOf(entry)}`) }}</span
          >{{ wordsOf(entry).ask }}
        </div>
        <div
          v-if="actionsOf(entry).length > 0"
          class="mt-0.5 flex flex-wrap items-start rounded-sm @min-[380px]:col-start-2 @min-[380px]:row-span-2 @min-[380px]:row-start-1 @min-[380px]:mt-0 @min-[380px]:self-center"
          style="gap: 6px"
        >
          <button
            v-for="a in actionsOf(entry)"
            :key="a.testId"
            type="button"
            :class="[BTN, BTN_SOFT]"
            :disabled="busy"
            :data-test="`${a.testId}-rest`"
            @click="a.run()"
          >
            <component :is="a.icon" :size="10" :stroke-width="2" aria-hidden="true" />{{ a.label }}
          </button>
        </div>
        <div
          v-if="wordsOf(entry).why"
          class="min-w-0 text-text-4 [overflow-wrap:anywhere]"
          style="font-size: 10.5px"
          data-test="next-rest-why"
        >
          {{ wordsOf(entry).why }}
        </div>
      </div>
    </div>
  </section>
</template>
