// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CardView } from '../../src/main/your-move/core'
import { useYourMoveStore } from '../../src/renderer/src/stores/your-move'

const view = (id: string, over: Partial<CardView> = {}): CardView => ({
  id,
  sessionId: `sess-${id}`,
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Pick A or B',
  source: 'judge',
  lane: 'live',
  openedAt: 1_000,
  updatedAt: 1_000,
  answerable: true,
  optionDeliverable: [],
  ...over
})

let listed: CardView[]
beforeEach(() => {
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    yourMoveList: vi.fn(async () => structuredClone(listed)),
    yourMovePrefsGet: vi.fn(async () => ({ mode: 'live' })),
    onYourMoveChanged: vi.fn()
  }
})
afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('Your move queue store', () => {
  it('a re-list keeps the card objects whose content did not change (AC-8)', async () => {
    listed = [view('a'), view('b')]
    const store = useYourMoveStore()
    await store.refresh()
    const [a, b] = store.cards
    listed = [view('a'), view('b', { ask: 'Changed', updatedAt: 2_000 })]
    await store.refresh()
    expect(store.cards[0]).toBe(a)
    expect(store.cards[1]).not.toBe(b)
    expect(store.cards[1].ask).toBe('Changed')
  })
})
