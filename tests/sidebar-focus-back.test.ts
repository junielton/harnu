// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { backRowLevel, type BackRowWidths } from '../src/renderer/src/components/sidebar-focus-back'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/**
 * Sidebar redesign S-5 — the width levels of the Focus back row (design.md §6 "Sidebar tree →
 * Focus"). jsdom has no box model, so the widths are given here: the natural widths of each part at
 * its font, as the built app draws them. The drawn row is proven in
 * `tests/e2e/ci/sidebar-focus-back.spec.ts`.
 */

/** Row content width: the list (sidebar − 10px gutter) less 14px of padding each side. */
const AT_268 = 230
const AT_200 = 162

const base = { chevron: 14, gap: 6 }
// "1 needs you · " / "1 failed", with "7 others · " ahead of them.
const EN: BackRowWidths = {
  ...base,
  label: 55.6,
  others: 48.2,
  needs: 66.8,
  needsShort: 66.8,
  failed: 35.5
}
// "1 precisa de você · " / "1 falhou", short "1 precisa · ".
const PT: BackRowWidths = {
  ...base,
  label: 38,
  others: 48,
  needs: 91.4,
  needsShort: 49,
  failed: 39.8
}
// "12 precisam de você · " / "3 falharam".
const PT_WORST: BackRowWidths = { ...PT, needs: 108, needsShort: 66, failed: 50 }

describe('back row width levels', () => {
  it.each([
    ['en at 268 drops "others"', AT_268, EN, 1],
    ['en at 200 drops the label', AT_200, EN, 2],
    ['pt-BR at 268 drops "others"', AT_268, PT, 1],
    ['pt-BR at 200 drops the label', AT_200, PT, 2],
    ['the worst pt-BR case at 200 takes the short form', AT_200, PT_WORST, 3],
    ['the worst pt-BR case at 268 only drops "others"', AT_268, PT_WORST, 1],
    ['a wide sidebar shows everything', 460, PT_WORST, 0]
  ])('%s', (_name, available, widths, level) => {
    expect(backRowLevel(available, widths)).toBe(level)
  })

  it('counts a gap only between parts that are drawn', () => {
    // 14 + 6 + 55.6 + 6 + (48.2 + 66.8 + 35.5) = 232.1
    expect(backRowLevel(232.1, EN)).toBe(0)
    expect(backRowLevel(231, EN)).toBe(1)
  })

  it('brings "others" back when fewer parts leave room for it', () => {
    const noCounts = { ...EN, needs: 0, needsShort: 0, failed: 0 }
    expect(backRowLevel(AT_200, noCounts)).toBe(0)
    // Too narrow for both: "others" is the first to go.
    expect(backRowLevel(100, noCounts)).toBe(1)
    // With one count instead of two, 268px has room for "others" again.
    expect(backRowLevel(AT_268, { ...EN, needs: 0, needsShort: 0 })).toBe(0)
  })

  it('never offers a short form where there is none', () => {
    expect(backRowLevel(90, EN)).toBe(2)
  })

  it('shows everything before it has been laid out', () => {
    expect(backRowLevel(0, EN)).toBe(0)
  })

  it('has the short forms and the pt-BR label', () => {
    expect(ptBR.sidebar.focus.allFolders).toBe('Pastas')
    expect(en.sidebar.focus.allFolders).toBe('All folders')
    expect(ptBR.sidebar.focus.needsYouShort).toBe('{n} precisa | {n} precisam')
    expect(en.sidebar.focus.needsYouShort).toBe(en.sidebar.focus.needsYou)
  })

  it('draws the row with no ellipsis and no wrap', () => {
    const source = readFileSync('src/renderer/src/components/SidebarFocusBack.vue', 'utf8')
    const template = source.slice(source.indexOf('<template>'))
    expect(template).not.toMatch(/(?<![\w-])truncate(?![\w-])|text-ellipsis|flex-wrap|break-words/)
    expect(template).toContain('whitespace-nowrap')
  })
})
