// @vitest-environment jsdom
/**
 * Mission dropdown · S-2 · AC-6 and AC-8 — the head: the mission title and one progress row, and the
 * one-line switch that shows only when the session leads several missions (design.md §6 "Mission
 * dropdown" → "What it draws" 1; mockup `docs/design/mission-dropdown/`, states `mid`, `multi`, `chooser`).
 *
 * jsdom has no layout engine, so the contract is read off the elements: the Tailwind classes that carry
 * the 6px bar and the wrapping title, the ARIA numbers the server gave, and which nodes exist at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '../src/renderer/src/i18n'
import MissionDropdownHead from '../src/renderer/src/components/MissionDropdownHead.vue'
import { ledMissionRows, type LedMissionRow } from '../src/renderer/src/lib/mission-pane-view'
import { sampleOf } from '../src/renderer/src/lib/mission-sample'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

type Detail = Extract<MissionV4ViewReply, { state: 'mission' }>['detail']

const detailOf = (state: 'default' | 'done' = 'default'): Detail =>
  (structuredClone(sampleOf(state).reply) as Extract<MissionV4ViewReply, { state: 'mission' }>)
    .detail

let wrapper: VueWrapper | null = null

function mountHead(props: {
  detail: Detail
  led?: LedMissionRow[]
  currentId?: string
}): VueWrapper {
  i18n.global.locale.value = 'en'
  wrapper = mount(MissionDropdownHead, {
    props,
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]

const THREE: LedMissionRow[] = [
  {
    id: 'mnt-a',
    title: 'Measure the spec skill, then fix what the numbers show',
    done: 1,
    total: 3,
    unit: 'milestones',
    forYou: 3
  },
  {
    id: 'mnt-b',
    title: 'Collect partner listings every day',
    done: 0,
    total: 2,
    unit: 'milestones',
    forYou: 1
  },
  {
    id: 'mnt-c',
    title: 'Tidy the release notes',
    done: 4,
    total: 10,
    unit: 'milestones',
    forYou: 0
  }
]

describe('AC-6 — the head draws the title and one progress row, nothing else', () => {
  it('head has title and progress only', () => {
    const detail = detailOf()
    mountHead({ detail })

    // The title wraps and is never cut.
    const title = q('[data-test="mission-title"]') as HTMLElement
    expect(title.tagName).toBe('H2')
    expect(title.textContent?.trim()).toBe(detail.title)
    expect(title.className).not.toMatch(/\btruncate\b|\btext-ellipsis\b|\bline-clamp/)
    expect(title.className).toMatch(/break-words|\[overflow-wrap:anywhere\]/)

    // One progress row: a 6px bar with the server's numbers and the count text beside it.
    const bar = q('[role="progressbar"]') as HTMLElement
    expect(qa('[role="progressbar"]')).toHaveLength(1)
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe(String(detail.progress.total))
    expect(bar.getAttribute('aria-valuenow')).toBe(String(detail.progress.done))
    expect(bar.className).toMatch(/\bh-1\.5\b/) // 6px
    expect(bar.className).toMatch(/\brounded-sm\b/)
    expect(bar.className).toMatch(/\bborder-border\b/)
    expect(bar.className).toMatch(/\bbg-surface-2\b/)
    const fill = bar.querySelector<HTMLElement>('[data-test="mission-bar-fill"]') as HTMLElement
    expect(fill.className).toMatch(/\bbg-green\b/)
    const pct = (detail.progress.done / detail.progress.total) * 100
    expect(fill.style.width).toBe(`${pct}%`)

    const count = q('[data-test="mission-count"]') as HTMLElement
    expect(count.textContent?.trim()).toBe(
      `${detail.progress.done} of ${detail.progress.total} ${detail.progress.unit} done`
    )
    expect(count.className).toMatch(/\btabular-nums\b/)
    expect(count.className).toMatch(/\btext-text-3\b/)
    // The bar and the count are the two children of ONE row.
    const row = q('[data-test="mission-progress-row"]') as HTMLElement
    expect(row.contains(bar)).toBe(true)
    expect(row.contains(count)).toBe(true)
    expect(row.className).toMatch(/\bflex\b/)

    // It draws no "Mission" title, no state tag and no "Ready to close" badge.
    expect(qa('h1, h2, h3')).toHaveLength(1)
    expect(q('[data-test="mission-state"]')).toBeNull()
    expect(q('[data-test="mission-ready"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/ready to close/i)
    expect(document.body.textContent).not.toMatch(/^\s*Mission\s*$/m)
  })

  it('a finished mission draws no state tag or "Ready to close" badge either', () => {
    const detail = detailOf('done')
    expect(detail.state).toBe('ready-to-close')
    mountHead({ detail })
    expect(q('[data-test="mission-state"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/ready to close/i)
    expect(q('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      String(detail.progress.done)
    )
  })

  it('counts steps when the mission has no milestones', () => {
    const detail = detailOf()
    detail.progress = { ...detail.progress, unit: 'steps', done: 4, total: 21 }
    mountHead({ detail })
    expect(q('[data-test="mission-count"]')?.textContent?.trim()).toBe('4 of 21 steps done')
  })
})

describe('AC-8 — the switch shows only when the session leads several missions', () => {
  it('switch only when several missions', async () => {
    const detail = detailOf()

    // No missions listed, or exactly one: no switch and no line.
    for (const led of [[], [THREE[0]]]) {
      mountHead({ detail, led, currentId: 'mnt-a' })
      expect(q('[data-test="mission-switch"]')).toBeNull()
      expect(document.body.textContent).not.toMatch(/Change/)
      expect(q('[role="radiogroup"]')).toBeNull()
      wrapper?.unmount()
    }

    // Several: one line, "Mission 1 of 3 · Change", with a chevron-down.
    const w = mountHead({ detail, led: THREE, currentId: 'mnt-a' })
    const sw = q('[data-test="mission-switch"]') as HTMLElement
    expect(sw.tagName).toBe('BUTTON')
    expect(sw.textContent).toContain('Mission 1 of 3')
    expect(sw.textContent).toContain('Change')
    expect(sw.getAttribute('aria-label')).toBe('Mission 1 of 3 · Change')
    expect(sw.getAttribute('aria-expanded')).toBe('false')
    expect(sw.querySelector('svg.lucide-chevron-down')).not.toBeNull()
    expect(q('[role="radiogroup"]')).toBeNull()
    // The switch sits above the title.
    const title = q('[data-test="mission-title"]') as HTMLElement
    expect(sw.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // It opens a radiogroup of the missions: title, "{done} of {total} milestones · {n} for you", a check on the current one.
    sw.click()
    await nextTick()
    await nextTick()
    // As in the mockup's `chooser` state, the list takes the head's place (the title is in the list).
    expect(q('[data-test="mission-switch"]')).toBeNull()
    expect(q('[data-test="mission-title"]')).toBeNull()
    expect(q('[data-test="mission-leads-label"]')?.textContent?.trim()).toBe(
      'This session leads 3 missions'
    )
    const group = q('[role="radiogroup"]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.getAttribute('aria-label')).toBe('Choose the mission to show')
    const rows = qa('[role="radio"]')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(rows[0].textContent).toContain(THREE[0].title)
    expect(rows[0].textContent).toContain('1 of 3 milestones · 3 for you')
    expect(rows[1].textContent).toContain('0 of 2 milestones · 1 for you')
    // Nothing owed: no "· 0 for you".
    expect(rows[2].textContent).toContain('4 of 10 milestones')
    expect(rows[2].textContent).not.toContain('for you')
    // The check is on the current one only.
    expect(rows[0].querySelector('svg.lucide-check')).not.toBeNull()
    expect(rows[1].querySelector('svg.lucide-check')).toBeNull()

    // Focus is on the current one; Down walks the list.
    expect(document.activeElement).toBe(rows[0])
    rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(rows[1])

    // Choosing another one emits its id, closes the list and puts focus back on the switch.
    rows[1].click()
    await nextTick()
    await nextTick()
    expect(w.emitted('choose')).toEqual([['mnt-b']])
    // The parent heard the list open and close, so it can hide the rest while the list is up.
    expect(w.emitted('chooser')?.slice(0, 2)).toEqual([[true], [false]])
    expect(q('[role="radiogroup"]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-test="mission-switch"]'))

    // Esc closes the list first (and so not the dropdown).
    q('[data-test="mission-switch"]')?.click()
    await nextTick()
    await nextTick()
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ;(q('[role="radio"]') as HTMLElement).dispatchEvent(esc)
    await nextTick()
    expect(esc.defaultPrevented).toBe(true)
    expect(q('[role="radiogroup"]')).toBeNull()
  })

  it('the list closes, and the parent is told, when the switch goes away under it', async () => {
    const w = mountHead({ detail: detailOf(), led: THREE, currentId: 'mnt-a' })
    q('[data-test="mission-switch"]')?.click()
    await nextTick()
    expect(q('[role="radiogroup"]')).not.toBeNull()
    await w.setProps({ led: [] })
    await nextTick()
    expect(q('[role="radiogroup"]')).toBeNull()
    expect(q('[data-test="mission-title"]')).not.toBeNull()
    expect(w.emitted('chooser')?.at(-1)).toEqual([false])
  })

  it('the switch counts the current mission’s place in the list', () => {
    mountHead({ detail: detailOf(), led: THREE, currentId: 'mnt-c' })
    expect(q('[data-test="mission-switch"]')?.getAttribute('aria-label')).toBe(
      'Mission 3 of 3 · Change'
    )
  })

  it('speaks Portuguese when the app does', () => {
    i18n.global.locale.value = 'pt-BR'
    wrapper = mount(MissionDropdownHead, {
      props: { detail: detailOf(), led: THREE, currentId: 'mnt-a' },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    const label = q('[data-test="mission-switch"]')?.getAttribute('aria-label')
    // The expected text comes from the pt-BR catalog, so no Portuguese literal lives in this file.
    expect(label).toBe(
      i18n.global.t('missionDropdown.head.switchLabel', { n: 1, m: 3 }, { locale: 'pt-BR' })
    )
    expect(label).not.toBe('Mission 1 of 3 · Change')
    i18n.global.locale.value = 'en'
  })
})

describe('ledMissionRows — what the switch lists, from the readers', () => {
  const reader = (id: string, title: string, leads: string, done: number, forYou: number) =>
    ({
      title,
      mission: { id },
      detail: {
        leads,
        progress: { done, total: 3, unit: 'milestones' },
        waiting: { items: Array.from({ length: forYou }, (_, i) => ({ id: `w${i}` })) }
      }
    }) as never

  it('lists only the missions this session leads, with the server’s numbers', () => {
    const rows = ledMissionRows(
      [
        reader('mnt-1', 'One', 's1', 1, 2),
        reader('mnt-2', 'Two', 's2', 0, 0),
        reader('mnt-3', 'Three', 's1', 3, 0)
      ],
      's1'
    )
    expect(rows).toEqual([
      { id: 'mnt-1', title: 'One', done: 1, total: 3, unit: 'milestones', forYou: 2 },
      { id: 'mnt-3', title: 'Three', done: 3, total: 3, unit: 'milestones', forYou: 0 }
    ])
  })

  it('is empty without readers or a session', () => {
    expect(ledMissionRows(null, 's1')).toEqual([])
    expect(ledMissionRows([reader('mnt-1', 'One', 's1', 1, 0)], null)).toEqual([])
  })
})
