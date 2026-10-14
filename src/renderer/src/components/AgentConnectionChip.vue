<script setup lang="ts">
/**
 * Agent connection chip (T474 U1, design.md §6 — "Agent connection chip"): in a terminal pane's
 * header, who is connected to this terminal, a live `reading` / `typing` word, and a Disconnect
 * button that ends the agent's access for good (no confirm — revoking is the safe direction).
 *
 * All decisions live in `lib/agent-chip.ts`; this renders the answer. Clicking the chip selects
 * the owner session — an explicit operator gesture, unlike an agent, which never moves the view.
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, Unplug } from 'lucide-vue-next'
import { chipView, type ChipOwner, type ChipTerminal } from '../lib/agent-chip'
import { sessionTitle } from '../lib/session-label'
import { useAgentTerminalsStore } from '../stores/agent-terminals'
import { useSessionsStore } from '../stores/sessions'

interface Props {
  /** The pane id — the terminal's identity (spec §3.1). */
  terminalId: string
  /** `'agent'` for a pane main spawned for an agent; anything else is operator-opened. */
  origin?: 'agent'
  /** The pane's own owner id (kept current across a synthetic→real migration by the store). */
  ownerSessionId?: string | null
  /** The shell already ended (an early exit keeps the pane). */
  exited?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  origin: undefined,
  ownerSessionId: null,
  exited: false
})

const { t } = useI18n()
const sessions = useSessionsStore()
const agentTerminals = useAgentTerminalsStore()

onMounted(() => {
  agentTerminals.start()
  void agentTerminals.refreshChip(props.terminalId)
})

const state = computed(() => agentTerminals.chips[props.terminalId])
const word = computed(() => agentTerminals.wordOf(props.terminalId))

const terminal = computed<ChipTerminal>(() => {
  const isAgent = props.origin === 'agent'
  return {
    origin: isAgent ? 'agent' : (state.value?.origin ?? 'operator'),
    // An agent pane's own id is rekeyed with the synthetic→real migration; main's copy is for the
    // operator-opened terminals the pane knows nothing about.
    ownerSessionId: isAgent ? props.ownerSessionId : (state.value?.ownerSessionId ?? null),
    disconnected:
      agentTerminals.disconnectedIds[props.terminalId] === true || !!state.value?.disconnected,
    exited: props.exited || !!state.value?.exited,
    leaseActive: !!state.value?.leaseActive
  }
})

const owner = computed<ChipOwner | null>(() => {
  const id = terminal.value.ownerSessionId
  if (!id) return null
  const s = sessions.findSessionById(id)
  if (!s) return null
  const title = sessionTitle(s, sessions.allSessions, t) || id.slice(0, 8)
  return { title, parked: s.hibernated === true }
})

const view = computed(() => chipView(terminal.value, owner.value, word.value))

const label = computed(() =>
  view.value ? t(`agentTerminal.${view.value.labelKey}`, view.value.params ?? {}) : ''
)
// "An agent is reading" already says it: a second `· reading` would only repeat the label.
const wordText = computed(() =>
  word.value && view.value?.labelKey !== 'readingAnon' ? t(`agentTerminal.${word.value}`) : ''
)

function onChipClick(): void {
  const id = view.value?.clickSessionId
  if (id) sessions.select(id)
}

function onDisconnect(): void {
  void agentTerminals.disconnect(props.terminalId)
}
</script>

<template>
  <span
    v-if="view"
    class="flex min-w-0 shrink items-center gap-1"
    data-testid="agent-connection-chip"
  >
    <component
      :is="view.clickSessionId ? 'button' : 'span'"
      class="flex min-w-0 shrink items-center gap-1 rounded-full border border-accent-line bg-accent-soft text-accent"
      :class="view.clickSessionId ? 'cursor-pointer transition-colors hover:border-accent' : ''"
      style="padding: 1px 7px; font-size: 10px"
      :title="view.clickSessionId ? t('agentTerminal.goToSession') : label"
      data-testid="agent-chip"
      v-bind="view.clickSessionId ? { type: 'button' } : {}"
      @mousedown.stop
      @click="onChipClick"
    >
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        :class="word ? 'anim-pulse-dot anim-pulse-dot--accent' : ''"
        data-testid="agent-chip-dot"
        aria-hidden="true"
      />
      <Bot :size="10" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 truncate" data-testid="agent-chip-label">{{ label }}</span>
      <span v-if="view.parked" class="shrink-0 text-text-3" data-testid="agent-chip-parked"
        >({{ t('agentTerminal.parked') }})</span
      >
      <span v-if="wordText" class="shrink-0 text-text-3" data-testid="agent-chip-word"
        >· {{ wordText }}</span
      >
      <span class="sr-only" aria-live="polite" data-testid="agent-chip-live">{{ wordText }}</span>
    </component>
    <button
      v-if="view.disconnectable"
      type="button"
      class="grid h-[18px] w-[18px] shrink-0 place-items-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
      :title="t('agentTerminal.disconnectHint')"
      :aria-label="t('agentTerminal.disconnect')"
      data-testid="agent-disconnect"
      @mousedown.stop
      @click="onDisconnect"
    >
      <Unplug :size="12" :stroke-width="1.6" />
    </button>
  </span>
</template>
