// @vitest-environment jsdom
/**
 * Mission dropdown · S-5 · AC-15 — the empty state: a session with no mission draws the `target` glyph, "This
 * session has no mission.", the picker of the folder's open missions (each with Attach and its in-place
 * confirmation), "Start a new mission" and, under the picker, "See a sample mission". The sample opens in place
 * with its "made up" label, its state chooser and a control to leave it. The loading line and the refused read
 * (with Retry) appear inside the dropdown (design.md §6 "Mission dropdown" → "Empty state"; mockup
 * `docs/design/mission-dropdown/`, states `empty`, `chooser`, `multi`).
 *
 * The session's own answer comes through the real store: `window.api.missionV4View` is stubbed, the Sessions store
 * holds one selected session, and the dropdown reads what the store read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionDropdown from '../src/renderer/src/components/MissionDropdown.vue'
import { SAMPLE_STATES } from '../src/renderer/src/lib/mission-sample'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'

const SESSION = 'sess-empty-1'
let wrapper: VueWrapper | null = null

const NONE = {
  state: 'none',
  missions: [
    {
      id: 'mnt-a',
      title: 'Measure the spec skill, then fix what the numbers show',
      headline: '4 of 21 steps done',
      leads: null
    },
    {
      id: 'mnt-b',
      title: 'Collect partner listings every day',
      headline: '1 of 10 milestones done',
      leads: null
    }
  ]
}

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

/** Mount the dropdown, open, and let the store read `reply` for the one selected session (`null` = no answer yet). */
async function openWith(reply: unknown | null): Promise<void> {
  const missionV4View = vi.fn(async () => reply)
  ;(window as unknown as { api: unknown }).api = {
    missionV4View,
    requestAttention: vi.fn(),
    missionV4Door: vi.fn(async () => ({ ok: true, changed: true })),
    missionPathKinds: vi.fn(async () => ({}))
  }
  const sessions = useSessionsStore()
  sessions.folders = [
    {
      path: '/sample',
      pinned: true,
      sessions: [{ sessionId: SESSION, projectPath: '/sample', summary: 'Leader' }]
    }
  ] as never
  sessions.select(SESSION)
  if (reply !== null) await useMissionsStore().refreshV4()
  wrapper = mount(MissionDropdown, { global: { plugins: [i18n] }, attachTo: document.body })
  const ui = useUiStore()
  ui.setPopoverAnchor('missionProgress', true)
  ui.openPopover('missionProgress')
  await settle()
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  setActivePinia(createPinia())
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    { x: 0, y: 0, width: 10, height: 10 }
  ] as unknown as DOMRectList)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AC-15 — the empty state', () => {
  it('empty state, picker, sample link and leaving the sample', async () => {
    await openWith(NONE)

    // The glyph, the sentence, the picker, "Start a new mission" and, UNDER the picker, the sample link.
    const empty = q('[data-test="mission-none"]') as HTMLElement
    expect(empty).not.toBeNull()
    expect(empty.querySelector('[data-glyph="target"]')).not.toBeNull()
    expect(text(empty)).toContain('This session has no mission.')
    const rows = qa('[data-test="attach-row"]')
    expect(rows.map((r) => r.getAttribute('data-mission'))).toEqual(['mnt-a', 'mnt-b'])
    expect(text(rows[0])).toContain('4 of 21 steps done')
    expect(rows.every((r) => text(r.querySelector('[data-test="attach-open"]')) === 'Attach')).toBe(
      true
    )
    const start = q('[data-test="attach-start"]') as HTMLElement
    expect(text(start)).toBe('Start a new mission')
    const link = q('[data-test="mission-sample-open"]') as HTMLElement
    expect(text(link)).toBe('See a sample mission')
    const picker = q('[data-test="attach-picker"]') as HTMLElement
    expect(
      picker.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the link follows the picker'
    ).toBeTruthy()
    // The empty state has no footer control and no sample strip yet.
    expect(q('[data-test="footer-close"]')).toBeNull()
    expect(q('[data-test="mission-sample"]')).toBeNull()

    // Attach confirms in place, and Cancel puts the row back.
    ;(rows[0].querySelector('[data-test="attach-open"]') as HTMLElement).click()
    await settle()
    expect(q('[data-test="attach-confirm"]')).not.toBeNull()
    expect(rows[0].contains(q('[data-test="attach-confirm"]'))).toBe(true)
    ;(q('[data-test="attach-cancel"]') as HTMLElement).click()
    await settle()
    expect(q('[data-test="attach-confirm"]')).toBeNull()

    // The sample opens in place: the made-up label, the state chooser, a control to leave it, a mission under it.
    link.click()
    await settle()
    const strip = q('[data-test="mission-sample"]') as HTMLElement
    expect(strip).not.toBeNull()
    expect(text(strip)).toMatch(/Sample mission/i)
    expect(text(q('[data-test="mission-sample-note"]'))).toMatch(/Made-up data/)
    const select = q('[data-test="mission-sample-state"]') as HTMLSelectElement
    const shown = [...select.options].map((o) => o.value)
    // Every state the dropdown can show, and none of the three the dropdown no longer has (sessions, hand-off).
    expect(shown).toEqual(
      SAMPLE_STATES.filter((s) => !['sessions', 'handoff-suggest', 'handoff-confirm'].includes(s))
    )
    expect(q('[data-test="mission-title"]')).not.toBeNull()
    expect(q('[data-test="mission-none"]')).toBeNull()

    // Choosing another state redraws; leaving the sample brings the empty state back.
    select.value = 'done'
    select.dispatchEvent(new Event('change'))
    await settle()
    expect(useMissionsStore().sampleState).toBe('done')
    ;(q('[data-test="mission-sample-leave"]') as HTMLElement).click()
    await settle()
    expect(useMissionsStore().sampleState).toBeNull()
    expect(q('[data-test="mission-sample"]')).toBeNull()
    expect(q('[data-test="mission-none"]')).not.toBeNull()
    expect(q('[data-test="mission-sample-open"]')).not.toBeNull()
  })

  it('a folder with no open mission says so and keeps Start a new mission and the sample link', async () => {
    await openWith({ state: 'none', missions: [] })
    expect(qa('[data-test="attach-row"]')).toHaveLength(0)
    expect(q('[data-test="attach-empty"]')).not.toBeNull()
    expect(q('[data-test="attach-start"]')).not.toBeNull()
    expect(q('[data-test="mission-sample-open"]')).not.toBeNull()
  })

  it('the loading line shows inside the dropdown until the first answer', async () => {
    await openWith(null)
    const dd = q('[data-test="mission-dropdown"]') as HTMLElement
    expect(dd.contains(q('[data-test="mission-loading"]'))).toBe(true)
    expect(text(q('[data-test="mission-loading"]'))).toBe('Reading the mission…')
    expect(q('[data-test="attach-picker"]')).toBeNull()
  })

  it('a refused read says why, with Retry, and Retry reads again', async () => {
    await openWith({ state: 'refused', error: 'READ_FAILED: the record is locked' })
    const dd = q('[data-test="mission-dropdown"]') as HTMLElement
    const refused = q('[data-test="mission-refused"]') as HTMLElement
    expect(dd.contains(refused)).toBe(true)
    expect(text(refused)).toContain('This mission cannot be read right now.')
    expect(text(refused)).toContain('READ_FAILED: the record is locked')
    const api = (window as unknown as { api: { missionV4View: ReturnType<typeof vi.fn> } }).api
    const before = api.missionV4View.mock.calls.length
    ;(q('[data-test="refused-retry"]') as HTMLElement).click()
    await settle()
    expect(api.missionV4View.mock.calls.length).toBeGreaterThan(before)
  })
})
