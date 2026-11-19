/**
 * Your move: the queue's view model (design.md §6 "RETURN HERE in Your move mode Live").
 *
 * Pure: it decides which cards the queue lists, in what order, and which buttons each one
 * offers. It renders nothing and calls nothing; `YourMoveCard.vue` and the store act on the
 * {@link CardAction}s it returns. Every `label` that reaches a button is model-written text and
 * is only ever shown through text interpolation.
 */

import type { CardView } from '../../../main/your-move/core'

export type AnswerRequest =
  | { kind: 'option'; index: number }
  | { kind: 'go' | 'no-go'; label: string }
  | { kind: 'done' | 'looks-right' }

export type CardAction =
  | { type: 'answer'; request: AnswerRequest }
  | { type: 'open-session' }
  | { type: 'open-link'; url: string }
  | { type: 'open-mission'; missionId: string }
  | { type: 'looks-wrong' }

export interface CardButton {
  id: string
  /** Text the card carries (an option): shown as is. */
  label?: string
  /** An i18n key for a fixed button. */
  labelKey?: string
  recommended?: boolean
  action: CardAction
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * `00m 05s` in the first minute, then minutes only: `02m`, `1h 02m`, `2d 03h 04m`. A clock past
 * its first minute keeps one text for a whole minute, so a queue of old cards writes nothing to
 * the page on most seconds (BUG-271).
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  const days = Math.floor(total / DAY)
  const hours = Math.floor((total % DAY) / HOUR)
  const minutes = Math.floor((total % HOUR) / MINUTE)
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return `${pad(minutes)}m`
  return `00m ${pad(Math.floor(total / SECOND))}s`
}

/** Oldest `openedAt` first; a new array, the input is never reordered. */
export function sortOldestFirst(cards: readonly CardView[]): CardView[] {
  return cards.slice().sort((a, b) => a.openedAt - b.openedAt)
}

/** What the queue lists: open cards of the `live` lane, oldest first. */
export function queueCards(cards: readonly CardView[]): CardView[] {
  return sortOldestFirst(cards.filter((c) => c.closedAt === undefined && c.lane === 'live'))
}

/** How many cards the queue renders at a time: its cost must not grow with the open count (BUG-271). */
export const QUEUE_PAGE = 25

export interface QueuePage {
  /** The first `shown` cards of the queue, in the queue's order. */
  cards: CardView[]
  /** How many open cards are not rendered. */
  hidden: number
  /** What the next "more" click adds: a full page, or what is left; 0 when nothing is hidden. */
  next: number
}

/** The rendered part of the queue: its first `shown` cards, and what the "more" button offers. */
export function pageOfQueue(queue: readonly CardView[], shown: number): QueuePage {
  const cards = queue.slice(0, Math.max(0, shown))
  const hidden = queue.length - cards.length
  return { cards, hidden, next: Math.min(QUEUE_PAGE, hidden) }
}

/** A model-written link is only ever followed when it is a plain http(s) URL. */
export function safeHttpUrl(link: string | undefined): string | null {
  if (!link) return null
  try {
    const u = new URL(link)
    return u.protocol === 'http:' || u.protocol === 'https:' ? link : null
  } catch {
    return null
  }
}

const OPEN_SESSION: CardButton = {
  id: 'open-session',
  labelKey: 'yourMove.buttons.openSession',
  action: { type: 'open-session' }
}

const fixed = (id: string, labelKey: string, action: CardAction): CardButton => ({
  id,
  labelKey,
  action
})

/** The answer buttons of a judge or verb card, before Open session. */
function answerButtons(card: CardView): CardButton[] {
  switch (card.kind) {
    case 'decide': {
      const options = card.options ?? []
      const buttons: CardButton[] = options.map((label, index) => ({
        id: `option-${index}`,
        label,
        recommended: label === card.recommended,
        // An option the PTY must not be typed (a slash command, escape bytes) only opens the session.
        action:
          card.optionDeliverable[index] === true
            ? { type: 'answer', request: { kind: 'option', index } }
            : { type: 'open-session' }
      }))
      const at = buttons.findIndex((b) => b.recommended)
      if (at > 0) buttons.unshift(...buttons.splice(at, 1))
      return buttons
    }
    case 'go_no_go':
      return [
        fixed('go', 'yourMove.buttons.go', {
          type: 'answer',
          request: { kind: 'go', label: 'Go' }
        }),
        fixed('no-go', 'yourMove.buttons.noGo', {
          type: 'answer',
          request: { kind: 'no-go', label: 'No-go' }
        })
      ]
    case 'do':
      return [fixed('done', 'yourMove.buttons.done', { type: 'answer', request: { kind: 'done' } })]
    case 'check':
      return [
        fixed('looks-right', 'yourMove.buttons.looksRight', {
          type: 'answer',
          request: { kind: 'looks-right' }
        }),
        fixed('looks-wrong', 'yourMove.buttons.somethingWrong', { type: 'looks-wrong' })
      ]
    case 'provide':
      // A secret never passes through a card.
      return []
  }
}

/**
 * The buttons of one card, in display order. Open session is always there. A card from a
 * mission points at the mission; a death, judge-failure or human-gate card has nothing to answer.
 */
export function buttonsFor(card: CardView): CardButton[] {
  if (card.source === 'mission') {
    const buttons = [OPEN_SESSION]
    if (card.mission) {
      buttons.push(
        fixed('open-mission', 'yourMove.buttons.openMission', {
          type: 'open-mission',
          missionId: card.mission.missionId
        })
      )
    }
    return buttons
  }
  if (card.source !== 'judge' && card.source !== 'verb') return [OPEN_SESSION]

  const buttons: CardButton[] = []
  const url = card.kind === 'do' ? safeHttpUrl(card.link) : null
  if (url) buttons.push(fixed('open-link', 'yourMove.buttons.openLink', { type: 'open-link', url }))
  if (card.answerable) buttons.push(...answerButtons(card))
  buttons.push(OPEN_SESSION)
  return buttons
}
