// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RoadmapFilterBar from '../src/renderer/src/components/RoadmapFilterBar.vue'
import { i18n } from '@renderer/i18n'

/**
 * BUG-109: the Group `SegmentedControl` (`epic | kind | none`) rendered one
 * button per row instead of side by side, bleeding into the board header
 * above and the board below. Root cause: `SegmentedControl`'s root is itself
 * a `flex flex-wrap` container, and a `flex-wrap` container's *automatic*
 * minimum width is only its single widest child, not the sum of all of them
 * — so as a shrinkable flex item of the filter bar's row it could be squeezed
 * down to one button's width, and every button wrapped onto its own line.
 *
 * jsdom doesn't run real flexbox layout, so this can't assert pixel
 * positions (that's what the live-app CDP capture in the PR is for) — it
 * asserts the structural fix instead: the Group label + control live in a
 * `shrink-0` wrapper, so they can never again be shrunk to nothing.
 */
function mountBar() {
  return mount(RoadmapFilterBar, {
    global: { plugins: [i18n] },
    props: {
      search: '',
      activeKinds: [],
      group: 'epic',
      hideDone: true,
      worktreeOptions: [],
      worktreeScope: null
    }
  })
}

describe('RoadmapFilterBar — Group control layout (BUG-109)', () => {
  it('wraps the Group label + SegmentedControl in their own shrink-0 container, distinct from the bar', () => {
    const wrapper = mountBar()
    const radiogroup = wrapper.find('[role="radiogroup"]')
    expect(radiogroup.exists()).toBe(true)

    // The outer bar row itself also carries `shrink-0` (pre-existing, unrelated to this
    // fix) — `closest('.shrink-0')` would match it too and pass even without the fix, so
    // the guard must reject that coincidence explicitly, not just check non-null.
    const bar = radiogroup.element.closest('.h-\\[38px\\]')
    const groupContainer = radiogroup.element.closest('.shrink-0')
    expect(groupContainer).not.toBeNull()
    expect(groupContainer).not.toBe(bar)
    expect(groupContainer?.textContent).toContain('epic')
    expect(groupContainer?.textContent).toContain('none')
  })

  it('renders all three group options as siblings inside the radiogroup', () => {
    const wrapper = mountBar()
    const buttons = wrapper.findAll('[role="radiogroup"] button')
    expect(buttons.map((b) => b.text())).toEqual(['epic', 'kind', 'none'])
  })

  it('the filter bar itself allows horizontal overflow instead of squeezing children, using the app-themed scrollbar', () => {
    const wrapper = mountBar()
    const bar = wrapper.find('[role="radiogroup"]').element.closest('.h-\\[38px\\]')
    expect(bar).not.toBeNull()
    expect(bar?.className).toContain('overflow-x-auto')
    // Matches the sibling RoadmapBoard.vue columns row: `scrollable` (main.css) swaps the
    // native OS scrollbar for the app's thin, hover-revealed one — without it this row
    // would be the only horizontally-scrollable surface in the app with a bare browser bar.
    expect(bar?.className).toContain('scrollable')
  })
})
