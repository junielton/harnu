// @vitest-environment jsdom
/**
 * The failed-retry card's "Waiting for my correction" line leads with a spinner while the correction is
 * still owed, and the spinner is gone once the correction text arrives. The real `WalkCheck` is mounted with
 * the real i18n.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WalkCheck from '../src/renderer/src/components/WalkCheck.vue'
import { segments, type CheckView } from '../src/renderer/src/lib/walk-view'
import { i18n } from '@renderer/i18n'

function view(correction: { text: string } | null): CheckView {
  return {
    checkId: 'c1',
    n: 1,
    total: 2,
    title: 'Typing narrows the list',
    phase: 'failed',
    blocking: false,
    blocksLine: null,
    undo: null,
    undoParts: null,
    lastTime: null,
    do: [],
    where: null,
    see: { passes: segments('The list shows 2 rows.'), notLine: null, images: [], table: [] },
    icheck: { kind: 'nothing', why: 'Needs eyes.' },
    simpler: null,
    correction,
    reported: null,
    evidence: null,
    explain: {
      open: false,
      prepared: false,
      asking: false,
      order: [],
      foldEdge: false,
      more: [],
      teach: null,
      extras: []
    },
    door: null,
    asking: { explain: false, simpler: false }
  } as unknown as CheckView
}

const mountIt = (correction: { text: string } | null) =>
  mount(WalkCheck, {
    props: {
      check: view(correction),
      folder: '/repo',
      imageUrl: (s: string) => s,
      bigImage: false
    },
    global: { plugins: [i18n] }
  })

describe('the correction card while the correction is owed', () => {
  it('leads the waiting line with a spinning loader', () => {
    const w = mountIt(null)
    const line = w.get('[data-test="walk-correction-waiting"]')
    expect(line.text()).toContain('Waiting for my correction')
    const icon = line.get('svg')
    expect(icon.classes()).toContain('anim-spin')
    expect(icon.attributes('aria-hidden')).toBe('true')
  })

  it('draws no spinner once the correction text has arrived', () => {
    const w = mountIt({ text: 'Reload the page, then type again.' })
    expect(w.find('[data-test="walk-correction-waiting"]').exists()).toBe(false)
    const card = w.get('[data-test="walk-correction"]')
    expect(card.text()).toContain('Reload the page, then type again.')
    expect(card.find('.anim-spin').exists()).toBe(false)
    expect(card.find('svg').exists()).toBe(false)
  })
})
