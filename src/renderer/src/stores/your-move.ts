/**
 * Your move: the queue the Return here zone lists (design.md §6 "RETURN HERE in Your move
 * mode Live").
 *
 * A thin cache over the main-process store: `yourMoveList` hands over every open card (plus the
 * newest closed ones), `onYourMoveChanged` says "re-list". The mode is read from the same place
 * the Settings pane writes it, so switching to Live shows the queue at once. The store owns the
 * one clock the cards and the eyebrow read, ticking only while there is something to time.
 *
 * Nothing here answers a card yet: until the answering unit, `answer` opens the session.
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { CardView, YourMoveMode } from '../../../main/your-move/core'
import { queueCards, type AnswerRequest } from '../lib/your-move-view'
import { useSessionsStore } from './sessions'

export type CardExitLabel = 'not-for-me' | 'already-handled'

const TICK_MS = 1_000

export const useYourMoveStore = defineStore('yourMove', () => {
  const cards = ref<CardView[]>([])
  const mode = ref<YourMoveMode>('off')
  /** The clock every card reads, so one timer serves the whole queue. */
  const now = ref(Date.now())

  const queue = computed(() => (mode.value === 'live' ? queueCards(cards.value) : []))
  const count = computed(() => queue.value.length)
  const oldestAt = computed<number | null>(() => queue.value[0]?.openedAt ?? null)

  async function refresh(): Promise<void> {
    try {
      const [list, prefs] = await Promise.all([
        window.api.yourMoveList(),
        window.api.yourMovePrefsGet()
      ])
      cards.value = list
      mode.value = prefs.mode
    } catch {
      /* a transient IPC failure keeps what is on screen; the next change re-lists */
    }
  }

  let started: Promise<void> | null = null
  /** Load once and follow main's changes for the life of the window. */
  function init(): Promise<void> {
    if (started) return started
    started = (async () => {
      window.api.onYourMoveChanged(() => void refresh())
      await refresh()
    })()
    return started
  }

  let timer: ReturnType<typeof setInterval> | null = null
  watch(
    count,
    (n) => {
      if (n > 0 && timer === null) {
        now.value = Date.now()
        timer = setInterval(() => (now.value = Date.now()), TICK_MS)
      } else if (n === 0 && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    { immediate: true }
  )

  /** Not for me / Already handled: close the card and log the label. Main answers `ok:false` if it was already gone. */
  async function exit(cardId: string, label: CardExitLabel): Promise<void> {
    await window.api.yourMoveExit({ cardId, label })
    await refresh()
  }

  /** Until the answering unit, an answer button takes the operator to the session. */
  function answer(card: CardView, _req: AnswerRequest): Promise<void> {
    useSessionsStore().activateSession(card.sessionId)
    return Promise.resolve()
  }

  return { cards, mode, now, queue, count, oldestAt, init, refresh, exit, answer }
})
