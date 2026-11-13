// @vitest-environment jsdom
/**
 * BUG-261 (renderer half): a Your move card must not cost a scan of every folder and session to
 * name itself, and the queue's 1 s clock must not re-render a card whose content did not change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { i18n } from '@renderer/i18n'
import type { CardView } from '../../src/main/your-move/core'
import YourMoveCard from '../../src/renderer/src/components/YourMoveCard.vue'
import { useSessionsStore } from '../../src/renderer/src/stores/sessions'
import { useYourMoveStore } from '../../src/renderer/src/stores/your-move'

const FOLDERS = 40
const PER_FOLDER = 20
const CARDS = 20

const card = (sessionId: string): CardView => ({
  id: `card-${sessionId}`,
  sessionId,
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Pick A or B',
  source: 'judge',
  lane: 'live',
  openedAt: 1_000,
  updatedAt: 1_000,
  answerable: false,
  optionDeliverable: []
})

/** Seed folders whose `sessions` list counts every read: a scan reads it once per folder visited. */
function seed(): { reads: () => number } {
  let reads = 0
  const sessions = useSessionsStore()
  sessions.folders = Array.from({ length: FOLDERS }, (_, f) => {
    const list = Array.from({ length: PER_FOLDER }, (_, s) => ({
      sessionId: `sess-${f}-${s}`,
      summary: `Session ${f}/${s}`
    }))
    return {
      path: `/work/f${f}`,
      alias: `folder-${f}`,
      get sessions() {
        reads++
        return list
      }
    }
  }) as unknown as typeof sessions.folders
  return { reads: () => reads }
}

const mounted: VueWrapper[] = []
const mountCard = (c: CardView, onRender?: () => void): VueWrapper => {
  const w = mount(YourMoveCard, {
    props: { card: c, expanded: false },
    global: {
      plugins: [i18n],
      mixins: [
        {
          renderTriggered(this: { $options: { __name?: string } }) {
            if (this.$options.__name === 'YourMoveCard') onRender?.()
          }
        }
      ]
    }
  })
  mounted.push(w)
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
})

describe('Your move card rendering', () => {
  it('names the folder and the session without scanning every folder per card (AC-8)', () => {
    const { reads } = seed()
    const wrappers = Array.from({ length: CARDS }, (_, i) =>
      mountCard(card(`sess-${FOLDERS - 1 - (i % FOLDERS)}-${i % PER_FOLDER}`))
    )
    // The labels are right...
    const first = wrappers[0].text()
    expect(first).toContain(`folder-${FOLDERS - 1}`)
    expect(first).toContain(`Session ${FOLDERS - 1}/0`)
    // ...and cost a few passes over the folders in total, not a pass per card.
    expect(reads()).toBeLessThanOrEqual(4 * FOLDERS)
  })

  it('the 1 s clock re-renders the clock, not the card (AC-8)', async () => {
    seed()
    let renders = 0
    const yourMove = useYourMoveStore()
    // Opened a minute ago, so the clock shows seconds and changes on every tick.
    const w = mountCard({ ...card('sess-3-3'), openedAt: yourMove.now - 60_000 }, () => renders++)
    await nextTick()
    const before = w.get('[data-testid="your-move-clock"]').text()
    yourMove.now += 1_000
    await nextTick()
    yourMove.now += 1_000
    await nextTick()
    expect(w.get('[data-testid="your-move-clock"]').text()).not.toBe(before)
    expect(renders).toBe(0)
  })
})
