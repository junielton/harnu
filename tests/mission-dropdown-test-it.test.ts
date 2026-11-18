// @vitest-environment jsdom
/**
 * Mission dropdown · S-6 · AC-18 and AC-19 — the "Test it" controls and the seam they call
 * (`lib/walk-entry.ts`; design.md §6 "Mission dropdown" → "Test it (the entry for guided walks)"; mockup screen
 * `entry`, states `step-open`, `milestone`, `mission`, `closed`).
 *
 * The shipped provider answers false, so the controls are invisible in the product; every test that wants them
 * installs a provider that answers true, the way the mockup's captures do. The walk milestone installs the real
 * one and changes nothing in the dropdown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionDropdown from '../src/renderer/src/components/MissionDropdown.vue'
import {
  setWalkEntryProvider,
  startWalk,
  walkEntryAvailable,
  type WalkEntryProvider,
  type WalkSource
} from '../src/renderer/src/lib/walk-entry'
import type { SampleState } from '../src/renderer/src/lib/mission-sample'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useUiStore } from '../src/renderer/src/stores/ui'

let wrapper: VueWrapper | null = null

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>(sel))
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

/** The dropdown open over one state of the sample. */
async function openSample(state: SampleState): Promise<void> {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  ;(window as unknown as { api: unknown }).api = {
    requestAttention: vi.fn(),
    missionV4View: vi.fn(async () => null),
    missionPathKinds: vi.fn(async () => ({}))
  }
  useMissionsStore().showSample(state)
  wrapper = mount(MissionDropdown, { global: { plugins: [i18n] }, attachTo: document.body })
  const ui = useUiStore()
  ui.setPopoverAnchor('missionProgress', true)
  ui.openPopover('missionProgress')
  await settle()
}

/** A provider that answers true for every source, and records what it was asked and told. */
function yesProvider(): WalkEntryProvider & {
  available: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
} {
  return { available: vi.fn(() => true), start: vi.fn() }
}

const MISSION = 'mnt-sample01'

beforeEach(() => {
  i18n.global.locale.value = 'en'
  setActivePinia(createPinia())
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    { x: 0, y: 0, width: 10, height: 10 }
  ] as unknown as DOMRectList)
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  setWalkEntryProvider(null)
  vi.restoreAllMocks()
})

describe('AC-19 — the seam', () => {
  const sources: WalkSource[] = [
    { kind: 'step', missionId: 'mnt-a', stepId: 'stp-1' },
    { kind: 'milestone', missionId: 'mnt-a', milestoneId: 'mls-1' },
    { kind: 'mission', missionId: 'mnt-a' }
  ]

  it('the shipped provider answers false and does nothing', () => {
    for (const s of sources) {
      expect(walkEntryAvailable(s)).toBe(false)
      expect(() => startWalk(s)).not.toThrow()
    }
  })

  it('the two functions delegate to the installed provider, and null brings the shipped one back', () => {
    const p = yesProvider()
    setWalkEntryProvider(p)
    for (const s of sources) {
      expect(walkEntryAvailable(s)).toBe(true)
      startWalk(s)
    }
    expect(p.available.mock.calls.map((c) => c[0])).toEqual(sources)
    expect(p.start.mock.calls.map((c) => c[0])).toEqual(sources)
    // The very object, never a copy: the provider reads what the control built.
    expect(p.start.mock.calls[0][0]).toBe(sources[0])

    setWalkEntryProvider(null)
    expect(walkEntryAvailable(sources[0])).toBe(false)
    startWalk(sources[0])
    expect(p.start).toHaveBeenCalledTimes(3)
  })

  it('controls call the seam with the exact source', async () => {
    const p = yesProvider()
    setWalkEntryProvider(p)
    const ui = useUiStore()

    // The Criteria row of an open step.
    await openSample('step-open')
    const stepBtn = q('[data-test="step-body"][data-step="stp-11"] [data-test="test-it-step"]')
    expect(stepBtn, 'a step control on the open step').not.toBeNull()
    let openAtCall: boolean | null = null
    p.start.mockImplementation(() => {
      openAtCall = ui.popovers.missionProgress
    })
    stepBtn!.click()
    await settle()
    expect(p.start).toHaveBeenCalledTimes(1)
    expect(p.start).toHaveBeenLastCalledWith({
      kind: 'step',
      missionId: MISSION,
      stepId: 'stp-11'
    })
    // `startWalk` first, then the dropdown closes itself.
    expect(openAtCall).toBe(true)
    expect(ui.popovers.missionProgress).toBe(false)

    // The open milestone's summary line.
    p.start.mockClear()
    await openSample('default')
    const msBtn = q('[data-test="milestone-summary"] [data-test="test-it-milestone"]')
    expect(msBtn, 'a milestone control on the open milestone').not.toBeNull()
    msBtn!.click()
    await settle()
    expect(p.start).toHaveBeenCalledTimes(1)
    expect(p.start).toHaveBeenLastCalledWith({
      kind: 'milestone',
      missionId: MISSION,
      milestoneId: 'mls-2'
    })
    expect(ui.popovers.missionProgress).toBe(false)

    // The footer, at the end of a mission.
    p.start.mockClear()
    await openSample('done')
    const allBtn = q('[data-test="mission-dropdown-footer"] [data-test="test-it-mission"]')
    expect(allBtn, 'the whole-mission control in the footer').not.toBeNull()
    allBtn!.click()
    await settle()
    expect(p.start).toHaveBeenCalledTimes(1)
    expect(p.start).toHaveBeenLastCalledWith({ kind: 'mission', missionId: MISSION })
    expect(ui.popovers.missionProgress).toBe(false)
  })
})

describe('AC-18 — where the controls are drawn', () => {
  it('draws nothing under the shipped provider', async () => {
    for (const state of ['step-open', 'default', 'done'] as const) {
      await openSample(state)
      expect(qa('[data-test^="test-it-"]'), state).toHaveLength(0)
    }
  })

  it('draws each control only where the provider says yes: the dropdown holds no other rule', async () => {
    const only = (kind: WalkSource['kind']): WalkEntryProvider => ({
      available: (s) => s.kind === kind,
      start: vi.fn()
    })
    setWalkEntryProvider(only('step'))
    await openSample('step-open')
    expect(qa('[data-test="test-it-step"]')).toHaveLength(1)
    expect(qa('[data-test="test-it-milestone"]')).toHaveLength(0)

    setWalkEntryProvider(only('milestone'))
    await openSample('step-open')
    expect(qa('[data-test="test-it-step"]')).toHaveLength(0)
    expect(qa('[data-test="test-it-milestone"]')).toHaveLength(1)

    // The footer control is for a mission that is ready to close, and only when the provider offers it.
    setWalkEntryProvider(only('mission'))
    await openSample('default')
    expect(qa('[data-test="test-it-mission"]')).toHaveLength(0)
    await openSample('done')
    expect(qa('[data-test="test-it-mission"]')).toHaveLength(1)
    setWalkEntryProvider(only('step'))
    await openSample('done')
    expect(qa('[data-test="test-it-mission"]')).toHaveLength(0)
    // …and with nothing else to hold, the footer is not drawn as an empty bar.
    expect(q('[data-test="mission-dropdown-footer"]')?.className ?? '').not.toMatch(/border-t/)
  })

  it('is a compact button with the list-checks glyph and an aria-label that says what it walks', async () => {
    setWalkEntryProvider(yesProvider())
    await openSample('step-open')
    const step = q('[data-test="test-it-step"]') as HTMLElement
    const ms = q('[data-test="test-it-milestone"]') as HTMLElement
    for (const b of [step, ms]) {
      expect(b.tagName).toBe('BUTTON')
      expect(b.getAttribute('type')).toBe('button')
      expect(b.className).toMatch(/\bh-5\b/)
      expect(b.className).toMatch(/\bpx-2\b/)
      expect(b.className).toMatch(/text-\[11px\]/)
      expect(text(b)).toBe('Test it')
      const glyph = b.querySelector('svg.lucide-list-checks') as SVGElement
      expect(glyph, 'the list-checks glyph').not.toBeNull()
      expect(glyph.getAttribute('width')).toBe('10')
      // A wrapper with a radius, so the focus ring is not flattened.
      expect(b.parentElement?.className).toMatch(/\brounded-sm\b/)
    }
    expect(step.getAttribute('aria-label')).toBe('Test it · Walk through this step by hand')
    expect(step.getAttribute('title')).toBe('Walk through this step by hand')
    expect(ms.getAttribute('aria-label')).toBe('Test it · Walk through this milestone by hand')
    expect(ms.getAttribute('title')).toBe('Walk through this milestone by hand')

    // The step control sits on the Criteria heading line, at its right end.
    const heading = q('[data-test="criteria-heading"]') as HTMLElement
    expect(heading.parentElement?.contains(step)).toBe(true)
    // The milestone control sits on the summary line, after Ask.
    const summary = q('[data-test="milestone-summary"]') as HTMLElement
    const ask = summary.querySelector('[data-test="ask-open"]') as HTMLElement
    expect(ask).not.toBeNull()
    expect(ask.compareDocumentPosition(ms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await openSample('done')
    const all = q('[data-test="test-it-mission"]') as HTMLElement
    expect(text(all)).toBe('Test the whole mission')
    expect(all.className).toMatch(/\bh-5\b/)
    expect(all.className).toMatch(/\bpx-2\b/)
    expect(all.querySelector('svg.lucide-list-checks')?.getAttribute('width')).toBe('10')
    expect(all.getAttribute('title')).toBe('Walk through the whole mission by hand')
    // Its visible text already names it: an aria-label that began "Test it" would not contain it.
    expect(all.getAttribute('aria-label')).toBeNull()
    expect((all.closest('[data-dsqa-part="footer"]') as HTMLElement).className).toMatch(
      /\bborder-t\b/
    )
  })

  it('does not draw the whole-mission control before the mission is ready to close', async () => {
    setWalkEntryProvider(yesProvider())
    await openSample('clear')
    // Not ready: the footer holds Close and not the whole-mission control.
    expect(q('[data-test="footer-close"]')).not.toBeNull()
    expect(q('[data-test="test-it-mission"]')).toBeNull()
  })

  it('is not an interactive child of a tree row', async () => {
    setWalkEntryProvider(yesProvider())
    await openSample('step-open')
    for (const sel of ['test-it-step', 'test-it-milestone']) {
      const b = q(`[data-test="${sel}"]`) as HTMLElement
      expect(b.closest('[role="treeitem"]'), sel).toBeNull()
    }
  })
})
