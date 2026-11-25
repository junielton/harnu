import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * BUG-269 — layout containment for the sidebar and the Fleet rail, pinned as source.
 *
 * Why it exists: the sidebar keeps every session row in the DOM (rows of collapsed
 * folders sit behind a zero-height clip, not `display: none`) and the Fleet rail one
 * card per live session, so a large workspace is ~15k elements. With no containment a
 * style/layout pass walked all of them and cost 100–240 ms, which stalled key delivery
 * to the terminal.
 *
 * What these tests can and cannot prove: they pin that the rules are WRITTEN and wired
 * to the right elements, and the invariants the rules depend on. They cannot see that
 * Chromium honours them — the rendered proof is the A/B in an isolated second instance
 * (pixel-identical screenshots in 8 sidebar states, identical scroll height and row
 * geometry, and the layout-object count dropping from 14,964 to 3,709), reported in
 * `.harnu/REPORT.md`. Same idiom and same caveat as `tests/markdown-prose-css.test.ts`.
 */
const css = readFileSync('src/renderer/src/styles/main.css', 'utf8')
const sidebar = readFileSync('src/renderer/src/components/Sidebar.vue', 'utf8')
const folder = readFileSync('src/renderer/src/components/SidebarFolder.vue', 'utf8')
const card = readFileSync('src/renderer/src/components/FleetBoardCard.vue', 'utf8')
const repoHeader = readFileSync('src/renderer/src/components/RepoGroupHeader.vue', 'utf8')

/** The declaration block of the first `selector { … }` in the stylesheet. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  expect(m, `${selector} must be defined in main.css`).not.toBeNull()
  return m![1]
}

/** The opening tag (attributes included) of the first element carrying `marker`. */
function openingTag(source: string, marker: string): string {
  const at = source.indexOf(marker)
  expect(at, `${marker} must exist`).toBeGreaterThan(-1)
  const start = source.lastIndexOf('<', at)
  const end = source.indexOf('>', at)
  return source.slice(start, end + 1)
}

describe('BUG-269 containment helpers (main.css)', () => {
  it('session rows are skipped when off-screen', () => {
    expect(block('.sidebar-row-cv')).toMatch(/content-visibility:\s*auto/)
  })

  it('session rows declare NO intrinsic size — their height is fixed inline, so scroll cannot shift', () => {
    expect(block('.sidebar-row-cv')).not.toMatch(/contain-intrinsic/)
  })

  it('fleet cards are skipped off-screen and remember their real height once rendered', () => {
    const b = block('.fleet-card-cv')
    expect(b).toMatch(/content-visibility:\s*auto/)
    // `auto <fallback>`: the fallback only stands in until the card has rendered once.
    expect(b).toMatch(/contain-intrinsic-block-size:\s*auto\s+\d+px/)
  })

  it('the sidebar column is a layout + style containment root, and does NOT clip (no paint/size)', () => {
    const b = block('.sidebar-contain')
    expect(b).toMatch(/contain:\s*layout style\s*;/)
    // paint would clip the jump palette and focus rings; size would collapse the column.
    expect(b).not.toMatch(/paint|size|strict|content\b/)
  })
})

describe('BUG-269 containment wiring', () => {
  it('the sidebar <aside> carries .sidebar-contain', () => {
    expect(openingTag(sidebar, 'data-sidebar\n')).toMatch(/class="[^"]*\bsidebar-contain\b/)
  })

  it('every session row carries .sidebar-row-cv and keeps its fixed inline height', () => {
    const tag = openingTag(folder, 'data-session-row')
    // The marker class is in the opening tag of the row, which is the element whose
    // height the template pins: the two must travel together.
    const row = folder.slice(
      folder.indexOf('data-session-row'),
      folder.indexOf('data-session-row') + 2500
    )
    expect(tag).toBeTruthy()
    expect(row).toMatch(/class="sidebar-row sidebar-row-cv /)
    expect(row).toMatch(/height: `\$\{metrics\.sessionRowHeight\}px`/)
  })

  it('every Fleet card carries .fleet-card-cv', () => {
    expect(openingTag(card, 'data-dsqa="fleet-card"')).toMatch(/class="fleet-card-cv /)
  })
})

describe('BUG-269 invariant: layout containment is safe only while nothing in the column is position: fixed', () => {
  // `contain: layout` makes the sidebar the containing block of fixed descendants. Menus
  // and popovers are therefore teleported to <body>; this guards a new in-column
  // `fixed` element from silently anchoring to the sidebar instead of the viewport.
  const withoutTeleports = (source: string): string =>
    source.replace(/<Teleport[\s\S]*?<\/Teleport>/g, '')
  const fixedClass = /class="[^"]*(?:^|\s)fixed(?:\s|")/

  for (const [name, source] of [
    ['Sidebar.vue', sidebar],
    ['SidebarFolder.vue', folder],
    ['RepoGroupHeader.vue', repoHeader]
  ] as const) {
    it(`${name}: no fixed-position element outside a <Teleport>`, () => {
      const template = withoutTeleports(source.slice(source.indexOf('<template>')))
      expect(template).not.toMatch(fixedClass)
    })
  }
})
