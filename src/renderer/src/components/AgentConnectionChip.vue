<script setup lang="ts">
/**
 * Agent connection chip (T474 U1, design.md §6 — "Agent connection chip"): the compact agent icon the browser and
 * terminal pane headers share (browser-tabs S-7, decision D-4). One 18px round accent icon with the `pulse-ring`
 * halo; hover or keyboard focus shows a tip naming the session and what the agent is doing ("Typing", "Reading",
 * "Driving this tab · host"); Disconnect is an `unplug` button beside it and ends the agent's access for good (no
 * confirm — revoking is the safe direction).
 *
 * Two ways to feed it. In a terminal header it derives everything from `terminalId` (the agent-terminals store,
 * `lib/agent-chip.ts`). In the browser header the pane builds an `IconModel` and passes it as `model`, and listens
 * for `disconnect`. All decisions live in `lib/agent-chip.ts`; this renders the answer. Clicking the icon selects
 * the owner session when one is known — an explicit operator gesture, unlike an agent, which never moves the view.
 */
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, Unplug } from 'lucide-vue-next'
import {
  chipView,
  iconAriaLabel,
  sentenceCase,
  type ChipOwner,
  type ChipTerminal,
  type IconModel
} from '../lib/agent-chip'
import { sessionTitle } from '../lib/session-label'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import { useAgentTerminalsStore } from '../stores/agent-terminals'
import { useSessionsStore } from '../stores/sessions'

interface Props {
  /** The pane id — the terminal's identity (spec §3.1). Unused when `model` is given. */
  terminalId?: string
  /** `'agent'` for a pane main spawned for an agent; anything else is operator-opened. */
  origin?: 'agent'
  /** The pane's own owner id (kept current across a synthetic→real migration by the store). */
  ownerSessionId?: string | null
  /** The shell already ended (an early exit keeps the pane). */
  exited?: boolean
  /** The browser header's own words for the icon; replaces the terminal derivation. */
  model?: IconModel | null
}
const props = withDefaults(defineProps<Props>(), {
  terminalId: '',
  origin: undefined,
  ownerSessionId: null,
  exited: false,
  model: undefined
})
const emit = defineEmits<{ disconnect: [] }>()

const { t } = useI18n()
const sessions = useSessionsStore()
const agentTerminals = useAgentTerminalsStore()
const external = computed(() => props.model !== undefined)

onMounted(() => {
  if (external.value) return
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

const terminalView = computed(() => chipView(terminal.value, owner.value, word.value))

/** What the icon says, whichever header feeds it. */
const icon = computed<IconModel | null>(() => {
  if (props.model !== undefined) return props.model
  const v = terminalView.value
  if (!v) return null
  const label = t(`agentTerminal.${v.labelKey}`, v.params ?? {})
  // "An agent is reading" already says it: a second "Reading" under it would only repeat the head.
  const live = word.value && v.labelKey !== 'readingAnon' ? t(`agentTerminal.${word.value}`) : ''
  return {
    head: v.parked ? `${label} (${t('agentTerminal.parked')})` : label,
    detail: sentenceCase(live),
    live,
    clickSessionId: v.clickSessionId,
    disconnectable: v.disconnectable
  }
})

const aria = computed(() => (icon.value ? iconAriaLabel(icon.value) : ''))

/* The tip: hover or keyboard focus. It is an in-app layer over a browser pane, so it registers with the
   native-overlay freeze while it shows (design.md "Compact agent icon"). */
const hovered = ref(false)
const focused = ref(false)
const tipOpen = computed(() => hovered.value || focused.value)
const tipEl = ref<HTMLElement | null>(null)
useNativeOverlay(`agent-icon-tip-${useId()}`, tipEl)

function onIconClick(): void {
  const id = icon.value?.clickSessionId
  if (id) sessions.select(id)
}

function onDisconnect(): void {
  if (external.value) emit('disconnect')
  else void agentTerminals.disconnect(props.terminalId)
}
</script>

<template>
  <span v-if="icon" class="flex shrink-0 items-center gap-1" data-testid="agent-connection-chip">
    <span class="relative flex shrink-0 items-center" style="margin-left: 4px">
      <component
        :is="icon.clickSessionId ? 'button' : 'span'"
        class="anim-pulse-dot anim-pulse-dot--accent grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-accent-soft text-accent"
        :class="icon.clickSessionId ? 'cursor-pointer' : 'cursor-default'"
        :style="{ '--pulse-from': '0.69' }"
        :aria-label="aria"
        data-testid="agent-icon"
        data-dsqa-part="connection-chip"
        v-bind="icon.clickSessionId ? { type: 'button' } : { tabindex: 0, role: 'img' }"
        @mousedown.stop
        @mouseenter="hovered = true"
        @mouseleave="hovered = false"
        @focus="focused = true"
        @blur="focused = false"
        @click="onIconClick"
      >
        <Bot :size="10" :stroke-width="1.6" aria-hidden="true" />
      </component>
      <span
        v-if="tipOpen"
        ref="tipEl"
        role="tooltip"
        class="absolute top-full right-0 z-30 mt-[5px] border border-border-2 bg-surface text-[11px] whitespace-nowrap text-text-2"
        style="
          padding: 6px 9px;
          box-shadow: var(--shadow-pop);
          border-radius: var(--radius);
          line-height: normal;
        "
        data-testid="agent-icon-tip"
        data-dsqa-part="connection-tip"
      >
        <span class="flex items-center gap-[5px] text-accent" data-testid="agent-icon-tip-head">
          <Bot :size="10" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />{{ icon.head }}
        </span>
        <span
          v-if="icon.detail"
          class="mt-0.5 block text-text-3"
          data-testid="agent-icon-tip-detail"
          >{{ icon.detail }}</span
        >
      </span>
    </span>
    <!-- Outside the button on purpose: inside it the word would join the button's accessible name
         and be read twice ("… typing typing"). -->
    <span class="sr-only" aria-live="polite" data-testid="agent-chip-live">{{ icon.live }}</span>
    <button
      v-if="icon.disconnectable"
      type="button"
      class="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-sm text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
      :title="external ? $t('browserPane.chip.disconnectHint') : t('agentTerminal.disconnectHint')"
      :aria-label="external ? $t('browserPane.chip.disconnect') : t('agentTerminal.disconnect')"
      data-testid="agent-disconnect"
      @mousedown.stop
      @click="onDisconnect"
    >
      <Unplug :size="12" :stroke-width="1.6" />
    </button>
  </span>
</template>
