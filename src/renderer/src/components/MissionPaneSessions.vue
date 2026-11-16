<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeftRight, ChevronDown, ChevronRight } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import {
  buildSessionRows,
  foldSessionRows,
  sessionNameOf,
  sessionWhen,
  sessionsLeader,
  type MissionV4Reply,
  type SessionRowView
} from '../lib/mission-pane-view'

/**
 * The Sessions row of the Mission pane (Missions v4 S-20, design.md §6 "Mission pane" → Sessions and the
 * hand-off). The mission is durable and a session is disposable: the mission keeps the list of the sessions
 * that worked on it. One line, folded: how many and who leads. Opened, one row per session with its role,
 * when it worked and, for one that has stopped, where it stopped. Under the rows, "Continue in a new
 * session…", which only asks the pane to show the confirmation: this component starts nothing and decides
 * nothing about who leads. The rows are the server's history; the names are the ones every surface shows.
 * A session a hand-off started is named after the mission, plainly (stp-21). The fold is the pane's to keep
 * (`open`, so it survives a refresh); a standalone row keeps its own.
 */
const props = defineProps<{
  mission: MissionV4Reply
  /** The session the pane follows. */
  selectedId: string | null
  /** A hand-off is waiting for the door: the button is disabled so a second press starts nothing. */
  pending?: boolean
  /** The kept state of the fold; absent, the row keeps its own. */
  open?: boolean
  /** The pane's side padding in px. */
  padX?: number
}>()
const emit = defineEmits<{ continue: []; toggle: [] }>()

const { t, locale } = useI18n()
const sessions = useSessionsStore()

const localOpen = ref(false)
const open = computed(() => props.open ?? localOpen.value)
function toggleOpen(): void {
  if (props.open === undefined) localOpen.value = !localOpen.value
  emit('toggle')
}
const expanded = ref(false)

const rows = computed(() =>
  buildSessionRows(props.mission.sessions, {
    steps: props.mission.detail.steps,
    selectedId: props.selectedId
  })
)
const folded = computed(() => foldSessionRows(rows.value, expanded.value))
const leader = computed(() => sessionsLeader(rows.value))

const nameOf = (id: string): string =>
  sessionNameOf(id, sessions.allSessions, t, props.mission.detail.title)

const meta = computed(() => {
  const count = rows.value.length
  const l = leader.value
  if (l.kind === 'this') return t('missionPane.sessions.meta.this', { count })
  if (l.kind === 'other') return t('missionPane.sessions.meta.other', { count, name: nameOf(l.id) })
  return t('missionPane.sessions.meta.none', { count })
})

/** What a session was in the mission, in the tense of whether it still is. */
function roleLine(r: SessionRowView): string {
  const key = r.open
    ? r.role === 'leads'
      ? 'leads'
      : 'works'
    : r.role === 'leads'
      ? 'leadsPast'
      : 'worked'
  return t(`missionPane.sessions.role.${key}`)
}

function whenLine(r: SessionRowView): string {
  const w = sessionWhen(r.from, r.to, String(locale.value))
  if (w.kind === 'since') return t('missionPane.sessions.since', { day: w.day })
  if (w.kind === 'span') return t('missionPane.sessions.span', { from: w.from, to: w.to })
  if (w.kind === 'sameDay') {
    return t('missionPane.sessions.sameDay', { day: w.day, from: w.from, to: w.to })
  }
  return ''
}

/** Where a session that stopped stopped, and what it waited for; empty for one that is still attached. */
function stopLine(r: SessionRowView): string {
  if (r.open) return ''
  const parts: string[] = []
  if (r.stoppedStep) parts.push(t('missionPane.sessions.stoppedAt', { step: r.stoppedStep }))
  if (r.waitingFor) parts.push(t('missionPane.sessions.waitingFor', { what: r.waitingFor }))
  return parts.length > 0 ? parts.join(' · ') : t('missionPane.sessions.stoppedUnknown')
}
</script>

<template>
  <section
    class="border-t border-border"
    :style="{ padding: `12px ${padX ?? 16}px` }"
    data-pane-section="sessions"
    data-dsqa-part="sessions"
    data-test="sessions"
  >
    <button
      type="button"
      class="flex w-full flex-wrap items-center text-left text-text-3 transition hover:text-text"
      style="gap: 4px 8px; font-size: 12px"
      :aria-expanded="open"
      data-test="sessions-toggle"
      @click="toggleOpen"
    >
      <span class="flex text-text-4">
        <ChevronDown v-if="open" :size="10" :stroke-width="1.8" />
        <ChevronRight v-else :size="10" :stroke-width="1.8" />
      </span>
      <span
        class="min-w-0 break-words uppercase text-text-4"
        style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em"
        >{{ $t('missionPane.sessions.label') }}</span
      >
      <span
        class="ml-auto min-w-0 max-w-full truncate text-text-4"
        style="font-size: 11px"
        :title="meta"
        data-test="sessions-meta"
        >{{ meta }}</span
      >
    </button>

    <div v-if="open" class="flex flex-col" style="margin-top: 10px; gap: 8px">
      <div
        v-for="r in folded.shown"
        :key="`${r.id}:${r.from}`"
        class="grid text-text-2"
        style="grid-template-columns: 8px 1fr; gap: 0 9px; font-size: 12px"
        data-test="session-row"
        :data-session="r.id"
        :data-role="r.role"
        :data-open="r.open"
        :data-leads="r.leads"
      >
        <span
          class="rounded-full"
          :class="r.open ? 'bg-green' : 'border-[1.5px] border-text-4'"
          style="width: 7px; height: 7px; margin-top: 5px"
          aria-hidden="true"
        />
        <span class="min-w-0 break-words">
          <b class="text-text" style="font-weight: 500" data-test="session-name">{{
            nameOf(r.id)
          }}</b>
          · {{ roleLine(r)
          }}<template v-if="r.current"> · {{ $t('missionPane.sessions.thisSession') }}</template>
        </span>
        <span
          class="break-words text-text-4"
          style="grid-column: 2; font-size: 10.5px"
          data-test="session-when"
          >{{ whenLine(r) }}</span
        >
        <span
          v-if="!r.open"
          class="break-words text-text-4"
          style="grid-column: 2; font-size: 10.5px"
          data-test="session-stop"
          >{{ stopLine(r) }}</span
        >
      </div>

      <button
        v-if="folded.hidden > 0 || expanded"
        type="button"
        class="self-start text-text-3 transition hover:text-text"
        style="font-size: 11.5px"
        data-test="sessions-more"
        @click="expanded = !expanded"
      >
        {{
          expanded
            ? $t('missionPane.sessions.less')
            : $t('missionPane.sessions.more', { n: folded.hidden }, folded.hidden)
        }}
      </button>

      <button
        type="button"
        class="inline-flex items-center self-start whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 text-text transition hover:border-text-4 disabled:cursor-not-allowed disabled:opacity-40"
        style="
          height: 20px;
          padding: 0 7px;
          gap: 4px;
          font-size: 11px;
          font-weight: 500;
          margin-top: 2px;
        "
        :disabled="pending"
        data-test="handoff-open"
        @click="emit('continue')"
      >
        <ArrowLeftRight :size="10" :stroke-width="1.8" />{{ $t('missionPane.sessions.continue') }}
      </button>
    </div>
  </section>
</template>
