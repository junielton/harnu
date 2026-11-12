<script setup lang="ts">
/**
 * One Your move card in the Return here zone (design.md §6 "RETURN HERE in Your move mode Live").
 *
 * Collapsed it is a single header row (kind, `folder · session`, running clock) over a two-line
 * ask; expanded it adds the context, what it blocks, the buttons and the two exits.
 *
 * Everything the judge or a session wrote (`ask`, `context`, `blocks`, option labels) is shown with
 * text interpolation only, never `v-html`. There is deliberately no × here: a card leaves when the
 * operator deals with it (a button, Not for me, Already handled) or when its source resolves, and
 * opening the session leaves it where it is.
 */
import { computed, defineComponent, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CardView } from '../../../main/your-move/core'
import {
  buttonsFor,
  formatClock,
  safeHttpUrl,
  type CardAction,
  type CardButton
} from '../lib/your-move-view'
import { sessionTitle } from '../lib/session-label'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { useYourMoveStore } from '../stores/your-move'

const props = defineProps<{ card: CardView; expanded: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const { t, te } = useI18n()
const sessions = useSessionsStore()
const yourMove = useYourMoveStore()

// One lookup by id into the store's index: naming a card never scans the folders (BUG-261).
const known = computed(() => sessions.sessionIndex.get(props.card.sessionId))

const folderLabel = computed(
  () =>
    known.value?.folderAlias ||
    props.card.folder.split('/').filter(Boolean).pop() ||
    props.card.folder
)

const sessionLabel = computed(() => {
  const s = known.value?.session
  return (s && sessionTitle(s, sessions.allSessions, t)) || props.card.sessionId.slice(0, 8)
})

/** A system card renders its own key; the English `ask` stays the fallback for an unknown one. */
const askText = computed(() => {
  const k = props.card.askKey
  return k && te(k.key) ? t(k.key, k.params) : props.card.ask
})

/**
 * The running clock is its own component: the queue's 1 s timer re-renders this span and nothing
 * else, so a card whose content did not change is not rendered again (BUG-261).
 */
const CardClock = defineComponent({
  props: { openedAt: { type: Number, required: true } },
  setup(p) {
    const clock = computed(() => formatClock(yourMove.now - p.openedAt))
    return () =>
      h(
        'span',
        {
          class: 'shrink-0 text-text-4 tabular-nums',
          style: 'font-size: 10.5px',
          title: t('yourMove.card.clock', { time: clock.value }),
          'data-testid': 'your-move-clock'
        },
        clock.value
      )
  }
})
const buttons = computed(() => buttonsFor(props.card))

const deliveryFailure = computed(() => {
  const d = props.card.delivery
  if (d?.state !== 'failed') return ''
  const keys = {
    'wake-timeout': 'wakeTimeout',
    'process-gone': 'processGone',
    'not-confirmed': 'notConfirmed',
    refused: 'refused'
  } as const
  return t(`yourMove.delivery.${keys[d.failure ?? 'refused']}`)
})

/** Not for me / Already handled could not be saved: say so and keep the card for a retry. */
const exitFailed = ref(false)
const exiting = ref(false)
async function leave(label: 'not-for-me' | 'already-handled'): Promise<void> {
  if (exiting.value) return
  exiting.value = true
  exitFailed.value = false
  try {
    exitFailed.value = !(await yourMove.exit(props.card.id, label))
  } finally {
    exiting.value = false
  }
}

const buttonLabel = (b: CardButton): string => b.label ?? t(b.labelKey ?? '')

async function run(action: CardAction): Promise<void> {
  switch (action.type) {
    case 'answer':
      await yourMove.answer(props.card, action.request)
      return
    case 'open-session':
    case 'looks-wrong':
      // Something's wrong needs detail, so it is the session that takes it.
      sessions.activateSession(props.card.sessionId)
      return
    case 'open-link': {
      const url = safeHttpUrl(action.url)
      if (url) void window.api.shellOpenExternal(url)
      return
    }
    case 'open-mission':
      sessions.activateSession(props.card.sessionId)
      useMissionsStore().requestPopover(action.missionId)
      return
  }
}
</script>

<template>
  <div
    class="border border-warning-line bg-warning-soft"
    style="border-radius: var(--radius); margin: 0 8px 6px 8px"
    data-testid="your-move-card"
  >
    <button
      type="button"
      class="flex w-full cursor-pointer flex-col text-left"
      style="padding: 8px 10px; gap: 4px; border-radius: var(--radius)"
      :aria-expanded="expanded"
      data-testid="your-move-card-toggle"
      @click="emit('toggle')"
    >
      <span class="flex w-full items-center" style="gap: 6px">
        <span
          class="shrink-0 bg-surface text-warning"
          style="font-size: 10.5px; border-radius: var(--radius-sm); padding: 1px 6px"
        >
          {{ $t(`yourMove.kind.${card.kind}`) }}
        </span>
        <span class="min-w-0 flex-1 truncate text-text-3" style="font-size: 11.5px">
          {{ folderLabel }} · {{ sessionLabel }}
        </span>
        <CardClock :opened-at="card.openedAt" />
      </span>
      <span
        class="w-full text-text"
        :class="expanded ? 'break-words' : 'line-clamp-2'"
        style="font-size: 12.5px; line-height: 1.4"
        data-testid="your-move-ask"
      >
        {{ askText }}
      </span>
    </button>

    <div v-if="expanded" class="flex flex-col" style="padding: 0 10px 8px 10px; gap: 8px">
      <p
        v-if="card.context"
        class="text-text-2"
        style="font-size: 12px; line-height: 1.45; white-space: pre-wrap"
        data-testid="your-move-context"
      >
        {{ card.context }}
      </p>
      <p v-if="card.blocks" class="text-text-3" style="font-size: 11.5px; line-height: 1.4">
        {{ $t('yourMove.card.blocks', { what: card.blocks }) }}
      </p>

      <div class="flex flex-wrap" style="gap: 6px">
        <button
          v-for="b in buttons"
          :key="b.id"
          type="button"
          class="cursor-pointer border bg-surface text-left text-text-2 transition hover:bg-surface-2 hover:text-text"
          :class="b.recommended ? 'border-accent' : 'border-border'"
          style="font-size: 11.5px; border-radius: var(--radius-sm); padding: 3px 8px"
          @click="run(b.action)"
        >
          {{ buttonLabel(b) }}
          <span v-if="b.recommended" class="text-accent" style="font-size: 10.5px">
            · {{ $t('yourMove.buttons.recommended') }}
          </span>
        </button>
      </div>

      <p
        v-if="deliveryFailure"
        class="text-red"
        style="font-size: 11.5px; line-height: 1.4"
        data-testid="your-move-delivery"
      >
        {{ deliveryFailure }}
      </p>

      <div class="flex" style="gap: 12px">
        <button
          type="button"
          class="cursor-pointer text-text-3 transition hover:text-text"
          style="font-size: 11px"
          @click="leave('not-for-me')"
        >
          {{ $t('yourMove.exits.notForMe') }}
        </button>
        <button
          type="button"
          class="cursor-pointer text-text-3 transition hover:text-text"
          style="font-size: 11px"
          @click="leave('already-handled')"
        >
          {{ $t('yourMove.exits.alreadyHandled') }}
        </button>
      </div>
      <p
        v-if="exitFailed"
        class="text-red"
        style="font-size: 11.5px; line-height: 1.4"
        role="alert"
        data-testid="your-move-exit-error"
      >
        {{ $t('yourMove.exits.failed') }}
      </p>
    </div>
  </div>
</template>
