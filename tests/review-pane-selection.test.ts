// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useReviewStore } from '../src/renderer/src/stores/review'
import { useReviewSelectionStore } from '../src/renderer/src/stores/review-selection'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import {
  MOVED_SHA,
  mountSelectionPane,
  selectionSnapshot,
  stubReviewApi
} from './helpers/review-selection-fixture'

/**
 * T257 U1 — the diff's selection, driven through the real pane.
 *
 * speech.ts is the first article: hunk 0 has six rows (gutter indices 0–5), hunk 1
 * five (6–10). Rows of hunk 0: 0 ctx · 1 del · 2 add · 3 add · 4 ctx · 5 ctx.
 */

let wrapper: VueWrapper
const selection = () => useReviewSelectionStore()

const article = (i: number) => wrapper.findAll('article')[i]
const gutters = (i = 0) => article(i).findAll('[data-diff-select]')
const press = async (g: ReturnType<typeof gutters>[number], opts: object = {}) => {
  await g.trigger('mousedown', { button: 0, ...opts })
  window.dispatchEvent(new MouseEvent('mouseup'))
  await nextTick()
}

beforeEach(async () => {
  setActivePinia(createPinia())
  stubReviewApi()
  wrapper = await mountSelectionPane()
})

afterEach(() => {
  wrapper.unmount()
  document.body.innerHTML = ''
})

describe('U1-AC-2 — gestures', () => {
  it('a click selects a row; clicking the only selected row again clears it', async () => {
    await press(gutters()[2])
    expect(selection().live).toMatchObject({ hunkIndex: 0, rowFrom: 2, rowTo: 2, line: 11 })
    await press(gutters()[2])
    expect(selection().live).toBeNull()
  })

  it('a drag and a shift-click produce the same range', async () => {
    await press(gutters()[1])
    await press(gutters()[3], { shiftKey: true })
    const viaShift = { ...selection().live!, id: '' }

    selection().clear('user')
    await gutters()[1].trigger('mousedown', { button: 0 })
    await gutters()[2].trigger('mouseenter')
    await gutters()[3].trigger('mouseenter')
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect({ ...selection().live!, id: '' }).toEqual(viaShift)
    expect(viaShift).toMatchObject({ startLine: 11, startSide: 'LEFT', line: 12, side: 'RIGHT' })
  })

  it('a drag that ends past the hunk clamps to its edge and the bar says why', async () => {
    await gutters()[2].trigger('mousedown', { button: 0 })
    await gutters()[7].trigger('mouseenter') // a row of hunk 1
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(selection().live).toMatchObject({ hunkIndex: 0, rowFrom: 2, rowTo: 5 })
    expect(wrapper.get('[data-test="selection-hint"]').text()).toBe(en.review.selection.hint.clamp)
  })

  it('Esc mid-drag cancels back to the previous selection', async () => {
    await press(gutters()[4])
    const prev = selection().live
    await gutters()[1].trigger('mousedown', { button: 0 })
    await gutters()[3].trigger('mouseenter')
    expect(selection().live).not.toBe(prev)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(selection().live).toBe(prev)
  })

  it('a mouse-enter without a pressed button does nothing', async () => {
    await gutters()[3].trigger('mouseenter')
    expect(selection().live).toBeNull()
  })

  it('the unchanged-lines marker and the @@ label are never targets', async () => {
    const all = article(0).findAll('[data-diff-gutter]')
    const markers = all.filter((g) => g.attributes('data-diff-select') === undefined)
    expect(markers.length).toBeGreaterThanOrEqual(3) // a gap + two @@ labels
    for (const m of markers) {
      expect(m.attributes('role')).toBeUndefined()
      expect(m.attributes('tabindex')).toBeUndefined()
      await m.trigger('mousedown', { button: 0 })
      window.dispatchEvent(new MouseEvent('mouseup'))
    }
    expect(selection().live).toBeNull()
  })

  it('only the primary button starts a selection', async () => {
    await gutters()[1].trigger('mousedown', { button: 2 })
    expect(selection().live).toBeNull()
  })
})

describe('U1-AC-3 — whole file', () => {
  const selectBtn = (i: number) => article(i).get('[data-select-file]')

  it('selects, then clears, from the file header — without toggling the file', async () => {
    await selectBtn(0).trigger('click')
    expect(selection().live).toMatchObject({ subjectType: 'FILE', path: 'src/main/speech.ts' })
    expect(article(0).get('header').classes()).toContain('diff-file-selected')
    expect(article(0).get('header').attributes('aria-expanded')).toBe('true')
    await selectBtn(0).trigger('click')
    expect(selection().live).toBeNull()
  })

  it('works on the deleted file and on the binary, whose body has no rows', async () => {
    await selectBtn(2).trigger('click')
    expect(selection().live).toMatchObject({ subjectType: 'FILE', path: 'src/gone.ts' })
    await selectBtn(3).trigger('click')
    expect(selection().live).toMatchObject({ subjectType: 'FILE', path: 'brand/logo.png' })
    expect(gutters(3).length).toBe(0)
  })

  it('gives the rows no per-row tint — the header is the subject', async () => {
    await selectBtn(0).trigger('click')
    expect(article(0).findAll('.diff-row-selected').length).toBe(0)
  })
})

describe('U1-AC-5 — the pane-owned triggers', () => {
  it('row 5 — a folder, card or PR change clears it', async () => {
    const ui = useUiStore()
    for (const change of [
      () => ui.openReview('/repos/other'),
      () => ui.openReview('/repos/harnu', { prNumber: 12 }),
      () => ui.openReview('/repos/harnu', { cardSlug: 'T1-x' })
    ]) {
      await press(gutters()[1])
      expect(selection().live).not.toBeNull()
      change()
      await flushPromises()
      expect(selection().live).toBeNull()
    }
  })

  it('row 6 — closing the takeover resets the selection and its notice', async () => {
    await press(gutters()[2])
    selection().extend('src/main/speech.ts', 1, 1)
    expect(selection().notice).not.toBeNull()
    wrapper.unmount()
    expect(selection().live).toBeNull()
    expect(selection().notice).toBeNull()
    wrapper = await mountSelectionPane()
  })

  it('the head-moved notice shows in the bar with both short SHAs', async () => {
    await press(gutters()[2])
    const review = useReviewStore()
    const snap = selectionSnapshot() as unknown as { head: object }
    review.snapshot = selectionSnapshot({ head: { ...snap.head, sha: MOVED_SHA } })
    await nextTick()
    expect(selection().live).toBeNull()
    expect(wrapper.get('[data-test="selection-hint"]').text()).toBe(
      'The head moved (9f8e7d6 → e4f5a6b). Selection cleared.'
    )
    await wrapper.get('[data-test="selection-dismiss"]').trigger('click')
    expect(wrapper.find('[data-test="review-selection-bar"]').exists()).toBe(false)
  })
})

describe('U1-AC-6 — the selected state', () => {
  it('keeps the add/del tint under the overlay, and marks the gutter beyond colour', async () => {
    await press(gutters()[1])
    await press(gutters()[3], { shiftKey: true })
    const rows = article(0).findAll('[data-diff-row]')
    const selected = rows.filter((r) => r.classes().includes('diff-row-selected'))
    expect(selected.length).toBe(3) // del, add, add
    expect(selected[0].classes()).toContain('diff-line-del')
    expect(selected[1].classes()).toContain('diff-line-add')
    const g = selected[1].get('[data-diff-gutter]')
    expect(g.attributes('aria-pressed')).toBe('true')
    expect(g.classes()).toContain('bg-surface-2') // the opaque base survives (BUG-92)
    expect(rows[0].get('[data-diff-gutter]').attributes('aria-pressed')).toBe('false')
  })

  it('is a gradient over the existing background, with an inset accent bar on the gutter', () => {
    const css = readFileSync('src/renderer/src/styles/main.css', 'utf8')
    const rule = (sel: string): string => {
      const at = css.indexOf(sel)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    const overlay = rule('.diff-row-selected,')
    expect(overlay).toContain('background-image: linear-gradient(var(--color-accent-soft)')
    expect(overlay).not.toMatch(/\bbackground:/) // a replacing `background` would drop the tint
    expect(
      rule('.diff-row-selected > [data-diff-gutter],\n.diff-file-selected {\n  box-shadow')
    ).toContain('inset 2px 0 0 var(--color-accent)')
  })
})

describe('U1-AC-7 — the keyboard', () => {
  const key = (g: ReturnType<typeof gutters>[number], k: string, opts: object = {}) =>
    g.trigger('keydown', { key: k, ...opts })

  it('is a roving tabindex: exactly one tab stop per file', () => {
    for (let i = 0; i < 3; i++) {
      const stops = gutters(i).filter((g) => g.attributes('tabindex') === '0')
      expect(stops.length).toBe(1)
    }
    expect(gutters(0)[0].attributes('tabindex')).toBe('0')
    expect(gutters(0).every((g) => g.attributes('role') === 'button')).toBe(true)
  })

  it('Arrow moves focus (across hunks), and the focused row becomes the tab stop', async () => {
    gutters()[5].element.focus()
    await key(gutters()[5], 'ArrowDown')
    await flushPromises()
    expect(document.activeElement).toBe(gutters()[6].element)
    expect(gutters()[6].attributes('tabindex')).toBe('0')
    expect(gutters()[5].attributes('tabindex')).toBe('-1')
    await key(gutters()[6], 'ArrowUp')
    await flushPromises()
    expect(document.activeElement).toBe(gutters()[5].element)
    expect(selection().live).toBeNull() // moving is not selecting
  })

  it('Enter and Space select the focused row and toggle it off again', async () => {
    await key(gutters()[2], 'Enter')
    expect(selection().live).toMatchObject({ rowFrom: 2, rowTo: 2 })
    await key(gutters()[2], ' ')
    expect(selection().live).toBeNull()
    await key(gutters()[2], ' ')
    expect(gutters()[2].attributes('aria-pressed')).toBe('true')
  })

  it('Shift+Arrow extends from the focused row, clamping at the hunk edge', async () => {
    gutters()[3].element.focus()
    await key(gutters()[3], 'ArrowDown', { shiftKey: true })
    await flushPromises()
    expect(selection().live).toMatchObject({ rowFrom: 3, rowTo: 4 })
    await key(gutters()[4], 'ArrowDown', { shiftKey: true })
    await key(gutters()[5], 'ArrowDown', { shiftKey: true }) // into hunk 1
    await flushPromises()
    expect(selection().live).toMatchObject({ hunkIndex: 0, rowFrom: 3, rowTo: 5 })
    expect(selection().notice).toEqual({ kind: 'clamp' })
  })

  it('Esc clears — and is left alone when there is nothing to clear', async () => {
    let bubbled = false
    wrapper.element.parentElement!.addEventListener('keydown', () => (bubbled = true))
    await key(gutters()[0], 'Escape')
    expect(bubbled).toBe(true) // nothing selected: Esc still reaches the takeover
    await key(gutters()[2], 'Enter')
    bubbled = false
    await key(gutters()[2], 'Escape')
    expect(selection().live).toBeNull()
    expect(bubbled).toBe(false)
  })

  it('the file button is a real <button> with the path in its name, after the viewed mark', () => {
    const btn = article(0).get('[data-select-file]')
    expect(btn.element.tagName).toBe('BUTTON')
    expect(btn.attributes('aria-label')).toContain('src/main/speech.ts')
    const viewed = article(0).get('[data-viewed-toggle]').element
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(viewed, btn.element)).toBe(true)
    expect(follows(btn.element, gutters()[0].element)).toBe(true)
    expect(btn.attributes('aria-pressed')).toBe('false')
  })
})

describe('U1-AC-8 — native text selection', () => {
  it('only the gutter is select-none; the code column starts no diff selection', async () => {
    const row = article(0).get('[data-diff-row]')
    expect(row.get('[data-diff-gutter]').classes()).toContain('select-none')
    const code = row.findAll('span').find((s) => s.classes().includes('whitespace-pre'))!
    expect(code.classes()).not.toContain('select-none')
    await code.trigger('mousedown', { button: 0 })
    await code.trigger('mouseenter')
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(selection().live).toBeNull()
  })
})

describe('U1-AC-9 — the bar is not a receipt and shows no count', () => {
  const bar = () => wrapper.find('[data-test="review-selection-bar"]')

  it('lives outside the evidence header and the discrepancy strip', async () => {
    await press(gutters()[2])
    expect(bar().exists()).toBe(true)
    const evidenceHeader = wrapper.get('section')
    expect(evidenceHeader.element.contains(bar().element)).toBe(false)
    // Its host is the review body, which sits inside no <section> at all — in particular
    // not the evidence header, whose own <section> must not be its ancestor.
    expect(bar().element.parentElement?.closest('section')).toBeNull()
    expect(bar().element.closest('section')).toBe(bar().element)
  })

  it('the Clear selection button clears it and takes the bar away', async () => {
    await press(gutters()[2])
    await wrapper.get('[data-test="selection-clear"]').trigger('click')
    expect(selection().live).toBeNull()
    expect(selection().lastCleared).toBe('user')
    expect(bar().exists()).toBe(false)
  })

  it('renders nothing at all with no selection and no notice', () => {
    expect(bar().exists()).toBe(false)
  })

  it('renders no count, ratio or percentage across {none, line, range, file} × {none, clamp, moved}', async () => {
    const review = useReviewStore()
    const states: Array<() => void> = [
      () => selection().clear('user'),
      () => selection().select('src/main/speech.ts', 0, 2),
      () => {
        selection().select('src/main/speech.ts', 0, 1)
        selection().extend('src/main/speech.ts', 0, 3)
      },
      () => selection().selectFile('src/main/speech.ts')
    ]
    const notices: Array<() => void> = [
      () => {},
      () => {
        selection().select('src/main/speech.ts', 0, 2)
        selection().extend('src/main/speech.ts', 1, 1)
      },
      () => {
        const snap = selectionSnapshot() as unknown as { head: object }
        review.snapshot = selectionSnapshot({ head: { ...snap.head, sha: MOVED_SHA } })
      }
    ]
    for (const s of states) {
      for (const n of notices) {
        review.snapshot = selectionSnapshot()
        review.expanded = Object.fromEntries(review.snapshot!.files.map((f) => [f.path, true]))
        selection().clear('user')
        s()
        n()
        await nextTick()
        const text = bar().exists() ? bar().text() : ''
        const live = selection().live
        const own = new Set<number>(
          live && live.subjectType === 'LINE' ? [live.line!, live.startLine ?? live.line!] : []
        )
        expect(text).not.toMatch(/\d\s*\/\s*\d/)
        expect(text).not.toContain('%')
        for (const m of text.match(/\b\d+\b/g) ?? []) expect(own.has(Number(m))).toBe(true)
      }
    }
  })
})

describe('U1-AC-10 — wrapping', () => {
  it('stacks the subject over the actions below the breakpoint, and hides no action', async () => {
    await press(gutters()[2])
    // jsdom measures every box as 0px wide, which is "narrow".
    const bar = wrapper.get('[data-test="review-selection-bar"]')
    expect(bar.classes()).toContain('flex-col')
    expect(bar.classes()).toContain('flex-wrap')
    const clear = bar.get('[data-test="selection-clear"]')
    expect(clear.classes().join(' ')).not.toMatch(/\bhidden\b|sr-only/)
  })
})

describe('U1-AC-12 — strings', () => {
  const leaves = (o: unknown, p = ''): string[] =>
    typeof o === 'string'
      ? [p]
      : Object.entries(o as object).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k))

  it('both locales hold the same review.selection keys', () => {
    expect(leaves(ptBR.review.selection).sort()).toEqual(leaves(en.review.selection).sort())
  })

  it('every key the new code names exists in en.json', () => {
    const src = ['ReviewSelectionBar.vue', 'ReviewPane.vue']
      .map((f) => readFileSync(`src/renderer/src/components/${f}`, 'utf8'))
      .join('\n')
    const have = new Set(leaves(en.review.selection).map((k) => `review.selection.${k}`))
    const used = [...src.matchAll(/'(review\.selection\.[\w.]+)'/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(8)
    for (const k of used) expect(have.has(k)).toBe(true)
  })

  it('the bar template holds no bare literal', () => {
    const tpl = readFileSync('src/renderer/src/components/ReviewSelectionBar.vue', 'utf8').split(
      '<template>'
    )[1]
    const text = [...tpl.matchAll(/>([^<>]+)</g)]
      .map((m) => m[1].replace(/\{\{[\s\S]*?\}\}/g, '').trim())
      .filter((s) => /[A-Za-z]{2,}/.test(s))
    expect(text).toEqual([])
    expect(tpl).not.toMatch(/\s(?:title|aria-label)="[A-Za-z]/)
  })

  it('the keys carry no client identifier shapes', () => {
    const all = JSON.stringify(en.review.selection)
    expect(all).not.toMatch(/\b[A-Z]{2,6}-\d{3,}\b/)
  })
})
