// @vitest-environment jsdom
/**
 * BUG-293 (AC-3): Back leads with the check's `undo`, and a command in it is a copy chip, drawn with the same
 * copy button as a `do` value. The real `WalkCheck` is mounted with the real i18n; an old plain-string undo
 * still renders as plain text.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WalkCheck from '../src/renderer/src/components/WalkCheck.vue'
import { segments, type CheckView } from '../src/renderer/src/lib/walk-view'
import { i18n } from '@renderer/i18n'

function view(undo: string | null): CheckView {
  return {
    checkId: 'c1',
    n: 1,
    total: 2,
    title: 'Typing narrows the list',
    phase: 'todo',
    blocking: false,
    blocksLine: null,
    undo,
    undoParts: undo ? segments(undo) : null,
    lastTime: null,
    do: [],
    where: null,
    see: { passes: segments('The list shows 2 rows.'), notLine: null, images: [], table: [] },
    icheck: { kind: 'nothing', why: 'Needs eyes.' },
    simpler: null,
    correction: null,
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

const mountIt = (undo: string | null) =>
  mount(WalkCheck, {
    props: { check: view(undo), folder: '/repo', imageUrl: (s: string) => s, bigImage: false },
    global: { plugins: [i18n] }
  })

describe('the undo line Back leads with', () => {
  it('draws a command in the undo as a copy chip with a copy button', () => {
    const w = mountIt('Run `./bin/reset --seed` to restore it.')
    const line = w.get('[data-test="walk-undo"]')
    expect(line.text()).toContain('First undo the last run:')
    const chip = line.get('.val')
    expect(chip.get('code').text()).toBe('./bin/reset --seed')
    expect(chip.find('button').exists(), 'the chip has its copy button').toBe(true)
    expect(line.text()).not.toContain('`')
  })

  it('keeps an old plain-string undo as plain text, and draws no line without one', () => {
    const plain = mountIt('Clear the search box.')
    expect(plain.get('[data-test="walk-undo"]').text()).toContain('Clear the search box.')
    expect(plain.find('[data-test="walk-undo"] .val').exists()).toBe(false)
    expect(mountIt(null).find('[data-test="walk-undo"]').exists()).toBe(false)
  })
})
