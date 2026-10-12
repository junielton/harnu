// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupSelectionBar from '../src/renderer/src/components/CleanupSelectionBar.vue'
import { i18n } from '@renderer/i18n'

const mountBar = (count: number, bytes = 3_466_000_000, canKeep = true, asking = false) =>
  mount(CleanupSelectionBar, {
    props: { count, bytes, canKeep, asking },
    global: { plugins: [i18n] }
  })

describe('CleanupSelectionBar', () => {
  it('renders nothing with an empty selection', () => {
    const w = mountBar(0)
    expect(w.find('[data-testid="selection-bar"]').exists()).toBe(false)
  })

  it('states how many are selected and how much disk they hold', () => {
    const w = mountBar(4)
    expect(w.get('[data-testid="sel-count"]').text()).toBe('4 selected · 3.47 GB')
  })

  it('emits remove, dehydrate, keep and clear', async () => {
    const w = mountBar(2)
    await w.get('[data-testid="sel-remove"]').trigger('click')
    await w.get('[data-testid="sel-dehydrate"]').trigger('click')
    await w.get('[data-testid="sel-keep"]').trigger('click')
    await w.get('[data-testid="sel-clear"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
    expect(w.emitted('dehydrate')).toHaveLength(1)
    expect(w.emitted('keep')).toHaveLength(1)
    expect(w.emitted('clear')).toHaveLength(1)
  })

  it('gives Remove selected, Dehydrate and Keep an icon each — the same icons the side panel uses', () => {
    const w = mountBar(2)
    for (const id of ['sel-remove', 'sel-dehydrate', 'sel-keep', 'sel-ask'])
      expect(w.get(`[data-testid="${id}"] svg`).exists(), id).toBe(true)
    const icon = (id: string) => w.get(`[data-testid="${id}"] svg`).attributes('class')
    expect(icon('sel-remove')).toContain('trash')
    expect(icon('sel-dehydrate')).toContain('package-minus')
    expect(icon('sel-keep')).toContain('bookmark')
  })

  it('Remove selected is the Danger button', () => {
    const w = mountBar(2)
    expect(w.get('[data-testid="sel-remove"]').classes()).toContain('text-red')
  })

  it('Ask for an opinion is enabled, says it uses tokens, and emits ask', async () => {
    const w = mountBar(2)
    const ask = w.get('[data-testid="sel-ask"]')
    expect(ask.text()).toBe('Ask for an opinion')
    expect((ask.element as HTMLButtonElement).disabled).toBe(false)
    expect(ask.element.parentElement?.getAttribute('title')).toBe(
      'Asks a read-only model session. Uses tokens.'
    )
    await ask.trigger('click')
    expect(w.emitted('ask')).toHaveLength(1)
    expect(w.emitted('remove')).toBeUndefined()
  })

  it('Ask for an opinion is disabled while the whole selection is already being asked about', async () => {
    const w = mountBar(2, 1, true, true)
    const ask = w.get('[data-testid="sel-ask"]')
    expect((ask.element as HTMLButtonElement).disabled).toBe(true)
    await ask.trigger('click')
    expect(w.emitted('ask')).toBeUndefined()
  })

  it('hints at Shift+click for adding more', () => {
    expect(mountBar(1).get('kbd').text()).toBe('⇧')
  })
})

describe('CleanupSelectionBar — Keep only when something can be kept', () => {
  it('hides Keep when the selection holds no worktree (orphan volumes have no Keep)', () => {
    const w = mountBar(2, 3_000_000, false)
    expect(w.find('[data-testid="sel-keep"]').exists()).toBe(false)
    expect(w.find('[data-testid="sel-remove"]').exists()).toBe(true)
  })
  it('shows Keep by default', () => {
    expect(mountBar(1).find('[data-testid="sel-keep"]').exists()).toBe(true)
  })
})

// "No dead ends" (unit B, AC-B1 / AC-B2): the reason Remove is unavailable is inline text, grouped by
// cause with counts, each group is the door to its guided action, and Dehydrate shows what it frees.
describe('CleanupSelectionBar — says why Remove is unavailable', () => {
  const group = (reason: string, count: number, action = 'dehydrate') => ({
    reason,
    causes: [reason],
    count,
    ids: Array.from({ length: count }, (_, i) => `id-${reason}-${i}`),
    action
  })
  const mountWith = (summary: unknown, canRemove: boolean) =>
    mount(CleanupSelectionBar, {
      props: { count: 11, bytes: 12_000_000_000, canRemove, summary: summary as never },
      global: { plugins: [i18n] }
    })

  it('nothing removable: states the count and the cause inline, not only in a tooltip', () => {
    const w = mountWith(
      { removable: [], refused: [group('unsupported-kind', 11)], dehydrate: null },
      false
    )
    expect(w.get('[data-testid="sel-why"]').text()).toBe(
      "11 can't be removed: 11 detached (no branch)"
    )
  })

  it('a partial selection says what goes and what does not, with every cause counted', () => {
    const w = mountWith(
      {
        removable: ['a', 'b', 'c'],
        refused: [group('unsupported-kind', 6), group('locked', 2, 'unlock-remove')],
        dehydrate: null
      },
      true
    )
    expect(w.get('[data-testid="sel-why"]').text()).toBe(
      "Removes 3 · 8 can't: 6 detached (no branch) · 2 locked in git"
    )
  })

  it('each group is a door to its guided action', async () => {
    const w = mountWith(
      { removable: [], refused: [group('locked', 2, 'unlock-remove')], dehydrate: null },
      false
    )
    await w.get('[data-testid="sel-guide-locked"]').trigger('click')
    expect(w.emitted('guide')).toEqual([[expect.objectContaining({ reason: 'locked', count: 2 })]])
  })

  it('shows nothing when the whole selection can be removed', () => {
    const w = mountWith({ removable: ['a'], refused: [], dehydrate: null }, true)
    expect(w.find('[data-testid="sel-why"]').exists()).toBe(false)
  })

  it('promotes Dehydrate with the real bytes the refused items carry', () => {
    const w = mountWith(
      {
        removable: [],
        refused: [group('unsupported-kind', 11)],
        dehydrate: { count: 11, bytes: 11_700_000_000, ids: [] }
      },
      false
    )
    expect(w.get('[data-testid="sel-dehydrate"]').text()).toBe(
      'Dehydrate frees 11.70 GB and keeps the code'
    )
  })

  it('keeps the plain Dehydrate label when there is nothing to promote', () => {
    const w = mountWith({ removable: ['a'], refused: [], dehydrate: null }, true)
    expect(w.get('[data-testid="sel-dehydrate"]').text()).toBe('Dehydrate')
  })
})

describe('CleanupSelectionBar — a group is busy while its action runs (delta 2)', () => {
  it('disables every group and marks the line busy', () => {
    const w = mount(CleanupSelectionBar, {
      props: {
        count: 2,
        bytes: 1,
        busy: true,
        summary: {
          removable: [],
          refused: [
            { reason: 'kept', causes: ['kept'], count: 2, ids: ['a', 'b'], action: 'unkeep' }
          ],
          dehydrate: null
        } as never
      },
      global: { plugins: [i18n] }
    })
    const g = w.get('[data-testid="sel-guide-kept"]')
    expect((g.element as HTMLButtonElement).disabled).toBe(true)
    expect(w.get('[data-testid="sel-why"]').attributes('aria-busy')).toBe('true')
  })
})

describe('CleanupSelectionBar — groups are keyed by their cause set (delta 3)', () => {
  it('a plain lock next to a lock + shared stack renders both, with no duplicate-key warning', async () => {
    const { vi } = await import('vitest')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const w = mount(CleanupSelectionBar, {
      props: {
        count: 3,
        bytes: 1,
        summary: {
          removable: [],
          refused: [
            {
              reason: 'locked',
              causes: ['locked', 'shared-stack'],
              count: 2,
              ids: ['a', 'b'],
              action: 'combined'
            },
            { reason: 'locked', causes: ['locked'], count: 1, ids: ['c'], action: 'unlock-remove' }
          ],
          dehydrate: null
        } as never
      },
      global: { plugins: [i18n] }
    })
    expect(w.find('[data-testid="sel-guide-combined"]').exists()).toBe(true)
    expect(w.find('[data-testid="sel-guide-locked"]').exists()).toBe(true)
    const keys = warn.mock.calls.filter((c) => String(c[0]).includes('Duplicate keys'))
    warn.mockRestore()
    expect(keys).toEqual([])
  })
})
