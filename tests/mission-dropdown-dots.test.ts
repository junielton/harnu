// @vitest-environment jsdom
/**
 * Mission dropdown · S-3 · AC-12 (card BUG-285) — every state glyph of the mission UI has a label: a
 * `role="img"` with an `aria-label`, and the same words in a teleported tooltip on hover and on focus
 * (design.md §6 "Mission dropdown" → "Dots and glyphs"; mockup state `dots`). The pill's glyph and the
 * sidebar mission chip already carry a `title` and an `aria-label`: the same test pins them, so no dot of
 * the mission UI is without a label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import MissionDot from '../src/renderer/src/components/MissionDot.vue'
import MissionDropdownTree from '../src/renderer/src/components/MissionDropdownTree.vue'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'
import { sampleOf } from '../src/renderer/src/lib/mission-sample'

type Locale = 'en' | 'pt-BR'
const MESSAGES = { en: enMessages, 'pt-BR': ptMessages } as const

/** Every glyph the mission UI draws, with the words each one must carry (design.md §6). */
const GLYPHS: Array<{
  kind: 'milestone' | 'step' | 'criterion'
  state: string
  blocked?: boolean
  en: string
}> = [
  { kind: 'milestone', state: 'not-started', en: 'Not started' },
  { kind: 'milestone', state: 'in-progress', en: 'In progress' },
  { kind: 'milestone', state: 'done', en: 'Done' },
  { kind: 'step', state: 'todo', en: 'To do' },
  { kind: 'step', state: 'running', en: 'Running' },
  { kind: 'step', state: 'waiting-review', en: 'Waiting for review' },
  { kind: 'step', state: 'done', en: 'Done' },
  { kind: 'step', state: 'running', blocked: true, en: 'Blocked' },
  { kind: 'criterion', state: 'open', en: 'Not settled yet' },
  { kind: 'criterion', state: 'settled', en: 'Settled' }
]

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

let wrapper: VueWrapper | null = null

function mountDot(props: Record<string, unknown>, locale: Locale = 'en'): VueWrapper {
  i18n.global.locale.value = locale
  wrapper = mount(MissionDot, {
    props: props as never,
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  i18n.global.locale.value = 'en'
})

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]

describe('AC-12 — every glyph has a label', () => {
  it('every glyph has a label in en and pt-BR', async () => {
    for (const locale of ['en', 'pt-BR'] as const) {
      for (const g of GLYPHS) {
        const w = mountDot({ kind: g.kind, state: g.state, blocked: g.blocked }, locale)
        const dot = q('[role="img"]') as HTMLElement
        expect(dot, `${g.kind}/${g.state} draws a role="img"`).not.toBeNull()
        const label = dot.getAttribute('aria-label') ?? ''
        expect(label.trim(), `${locale} ${g.kind}/${g.state}`).not.toBe('')
        if (locale === 'en') expect(label).toBe(g.en)
        // The label is the app's translation of the English words: a key in each file, no key left raw.
        const key = g.blocked ? 'blocked' : g.state
        const table = (
          MESSAGES[locale].missionDropdown.state as Record<string, Record<string, string>>
        )[g.kind]
        expect(label).toBe(table[key])
        expect(label).not.toMatch(/missionDropdown\./)

        // Hover shows the same words in a tooltip that is not inside the glyph (it is teleported).
        dot.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
        await nextTick()
        const tip = q('[role="tooltip"]') as HTMLElement
        expect(tip, `${locale} ${g.kind}/${g.state} tooltip`).not.toBeNull()
        expect(tip.textContent?.trim()).toBe(label)
        expect(dot.contains(tip)).toBe(false)
        dot.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
        await nextTick()
        expect(q('[role="tooltip"]')).toBeNull()
        w.unmount()
        wrapper = null
      }
    }
    // The two locales really differ: a pt-BR label that is the English word would be a missing translation.
    const en = MESSAGES.en.missionDropdown.state
    const pt = MESSAGES['pt-BR'].missionDropdown.state
    expect(pt.step.todo).not.toBe(en.step.todo)
    expect(pt.criterion.open).not.toBe(en.criterion.open)
    expect(pt.milestone['not-started']).not.toBe(en.milestone['not-started'])
  })

  it('the tooltip is the design.md one: 11px, bg-surface-2, border-border-2, shadow-pop', async () => {
    mountDot({ kind: 'step', state: 'running' })
    ;(q('[role="img"]') as HTMLElement).dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    const tip = q('[role="tooltip"]') as HTMLElement
    expect(tip.parentElement).toBe(document.body)
    expect(tip.className).toMatch(/bg-surface-2/)
    expect(tip.className).toMatch(/border-border-2/)
    expect(tip.className).toMatch(/shadow-pop/)
    expect(tip.style.fontSize).toBe('11px')
    expect(tip.className).toMatch(/fixed/)
    // The glyph is described by it while it shows.
    expect(q('[role="img"]')?.getAttribute('aria-describedby')).toBe(tip.id)
  })

  it('shows on focus of the row that holds it, and goes on blur', async () => {
    i18n.global.locale.value = 'en'
    const Host = defineComponent({
      render: () =>
        h('div', { role: 'treeitem', tabindex: 0, 'data-test': 'row' }, [
          h(MissionDot, { kind: 'step', state: 'waiting-review' })
        ])
    })
    wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body })
    const row = q('[data-test="row"]') as HTMLElement
    row.focus()
    row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await nextTick()
    expect(q('[role="tooltip"]')?.textContent?.trim()).toBe('Waiting for review')
    row.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await nextTick()
    expect(q('[role="tooltip"]')).toBeNull()
  })

  it('sits above the glyph, and below it when there is no room above', async () => {
    const rectOf = (top: number): DOMRect =>
      ({
        top,
        bottom: top + 12,
        left: 100,
        right: 112,
        width: 12,
        height: 12,
        x: 100,
        y: top,
        toJSON: () => ({})
      }) as DOMRect
    let dotTop = 100
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.getAttribute('role') === 'tooltip')
        return { ...rectOf(0), width: 64, height: 20, right: 64, bottom: 20 } as DOMRect
      return rectOf(dotTop)
    })
    mountDot({ kind: 'step', state: 'running' })
    const dot = q('[role="img"]') as HTMLElement

    dot.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    const above = q('[role="tooltip"]') as HTMLElement
    expect(above.dataset.placement).toBe('above')
    expect(parseFloat(above.style.top)).toBeLessThan(100)
    dot.dispatchEvent(new MouseEvent('mouseleave'))
    await nextTick()

    dotTop = 4
    dot.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    const below = q('[role="tooltip"]') as HTMLElement
    expect(below.dataset.placement).toBe('below')
    expect(parseFloat(below.style.top)).toBeGreaterThan(4 + 12 - 1)
  })

  it('the tree draws a labelled glyph for every milestone, step and criterion', async () => {
    i18n.global.locale.value = 'en'
    const reply = structuredClone(sampleOf('step-open').reply) as Extract<
      MissionV4ViewReply,
      { state: 'mission' }
    >
    // The sample's milestone steps carry no criteria: give one step two, one settled and one not.
    const target = reply.detail.steps[0]
    target.criteria = [
      {
        id: 'ac-1',
        text: 'The test set is written down',
        by: 'session',
        settled: true,
        via: 'session'
      },
      {
        id: 'ac-2',
        text: 'Every spec in it has an owner',
        by: 'session',
        settled: false,
        via: null
      }
    ] as never
    wrapper = mount(MissionDropdownTree, {
      props: { detail: reply.detail, askLeader: null },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await (wrapper.vm as unknown as { openStep: (id: string) => Promise<void> }).openStep(target.id)
    const glyphs = qa('[role="img"]')
    expect(glyphs.length).toBeGreaterThan(5)
    for (const g of glyphs) expect((g.getAttribute('aria-label') ?? '').trim()).not.toBe('')
    // A glyph of each level is there, and none is a bare circle without its words.
    expect(qa('[data-dot="milestone"]').length).toBeGreaterThan(0)
    expect(qa('[data-dot="step"]').length).toBeGreaterThan(0)
    expect(qa('[data-dot="criterion"]').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Settled',
      'Not settled yet'
    ])
  })
})

describe('AC-12 — the pill and the sidebar chip carry a title and an aria-label too', () => {
  it('the pill button has a title and an aria-label in both languages', async () => {
    const SESSION = 'sess-1'
    const reply = {
      state: 'mission',
      missionId: 'mnt-v4',
      source: 'v4',
      detail: {
        ok: true,
        id: 'mnt-v4',
        title: 'Measure the spec',
        doneWhen: '',
        status: 'open',
        state: 'open',
        stateLabel: 'Open',
        standing: 'operator',
        leads: SESSION,
        source: 'v4',
        progress: {
          unit: 'steps',
          total: 21,
          done: 4,
          headline: 'x',
          current: null,
          allDone: false,
          counts: { todo: 0, running: 0, waitingReview: 0, done: 0, blocked: 0 }
        },
        milestones: [],
        steps: [],
        next: null,
        waiting: {
          items: [{ id: 'w1' }],
          next: null,
          more: [],
          moreLine: null,
          people: [],
          peopleLine: null,
          peopleLines: []
        },
        summary: '',
        links: [],
        blockers: [],
        sessions: []
      },
      closeWarnings: [],
      pendingDoneWhen: null,
      sessions: [
        {
          id: SESSION,
          role: 'leads',
          from: '2026-11-14T10:00:00.000Z',
          to: null,
          stoppedAt: null,
          open: true
        }
      ],
      handoff: { offer: false }
    } as unknown as MissionV4ViewReply
    ;(window as unknown as { api: unknown }).api = {
      missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
      missionV4View: vi.fn(async () => reply),
      missionV4Door: vi.fn(),
      missionOperatorDoor: vi.fn(),
      requestAttention: vi.fn(),
      foldersLoad: vi.fn(async () => []),
      helpersGet: vi.fn(async () => null),
      helpersSet: vi.fn(async () => undefined)
    }
    const sessions = useSessionsStore()
    sessions.folders = [
      { path: '/repo', sessions: [{ sessionId: SESSION, projectPath: '/repo' }] }
    ] as never
    sessions.select(SESSION)
    for (const locale of ['en', 'pt-BR'] as const) {
      i18n.global.locale.value = locale
      const w = mount(MissionPill, {
        props: { sessionId: SESSION },
        global: { plugins: [i18n] },
        attachTo: document.body
      })
      await flushPromises()
      const button = w.find('button')
      expect(button.exists(), locale).toBe(true)
      const title = button.attributes('title') ?? ''
      const label = button.attributes('aria-label') ?? ''
      expect(title.trim(), `${locale} pill title`).not.toBe('')
      expect(label.trim(), `${locale} pill aria-label`).not.toBe('')
      expect(label).toContain('Measure the spec')
      expect(title).toContain(label)
      expect(label).not.toMatch(/missionPane\./)
      w.unmount()
    }
  })

  it('the sidebar mission chip carries the same words as title and aria-label', () => {
    const src = read('src/renderer/src/components/SidebarFolder.vue')
    const at = src.indexOf('data-dsqa="sidebar-mission-chip"')
    expect(at).toBeGreaterThan(0)
    // The element's own attributes: from its opening tag to the tag's closing `>`.
    const open = src.lastIndexOf('<span', at)
    const tag = src.slice(open, src.indexOf('>', at))
    expect(tag).toMatch(/:title="missionChipLabel\(mission\)"/)
    expect(tag).toMatch(/:aria-label="missionChipLabel\(mission\)"/)
    // And the words exist in both languages, with the headline in them.
    for (const locale of ['en', 'pt-BR'] as const) {
      const m = (MESSAGES[locale] as unknown as { mission: Record<string, string> }).mission
      expect(m.sidebarChip, locale).toContain('{headline}')
      expect(m.sidebarChipNeedsYou, locale).toContain('{headline}')
    }
  })
})
