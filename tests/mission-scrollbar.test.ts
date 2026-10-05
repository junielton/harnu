/**
 * Every scrolling container in the Mission UI must carry `.scrollable` (main.css) so it gets the
 * design-system scrollbar (thin, hover-revealed, tokens only) instead of the OS's native bar — see
 * design.md §6. jsdom has no layout engine, so the class on the element is the observable contract.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const DIR = 'src/renderer/src/components'
const files = readdirSync(DIR).filter((f) => /^Mission.*\.vue$/.test(f))

describe('Mission components use the app scrollbar', () => {
  it('finds the Mission components', () => {
    expect(files).toContain('MissionPopover.vue')
  })

  it.each(files)('%s: every overflow-auto/scroll element is .scrollable', (file) => {
    const src = readFileSync(`${DIR}/${file}`, 'utf8')
    const tags = src.match(/<[a-zA-Z][^<>]*\boverflow-(?:[xy]-)?(?:auto|scroll)\b[^<>]*>/g) ?? []
    for (const tag of tags) expect(tag, tag).toMatch(/\bscrollable\b/)
  })

  it('the popover body scroll container is present and .scrollable', () => {
    const src = readFileSync(`${DIR}/MissionPopover.vue`, 'utf8')
    expect(src).toMatch(/class="scrollable overflow-y-auto"/)
  })
})
