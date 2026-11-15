// @vitest-environment jsdom
/**
 * Missions v4 · stp-21 (T751) — the pane reads at a glance in a small space.
 *
 * AC-1  no clipping at 213 px: the glance loses no text and no control; long text wraps or truncates
 *       with its full text in a title.
 * AC-2  the bar's marker never cuts the count, at any fill.
 * AC-8  a narrow pane (about 110 px) is usable: the pane has NO minimum width; below 240 px it switches
 *       to a narrow layout (tighter padding, wrapping everywhere, no sideways scroll).
 * AC-9  the "this session leads N missions" selector never hides its text.
 * AC-12 the first screenful is: title and bar, the next step, what waits on the operator. The tree, the
 *       sessions row and the rest of the waiting list are one click away, collapsed by default, and
 *       keep their state across a refresh.
 *
 * jsdom has no layout engine: the geometry rules are pure functions of the view model (asserted here) and
 * the component is asserted to use them; the real pixels are captured in an isolated second instance
 * (see `.harnu/evidence/mnt-64333b9c/stp-21/executor/README.md`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import {
  GLANCE_SECTIONS,
  PANE_ORDER,
  PANE_SECTIONS_KEY,
  PANE_SECTION_DEFAULTS,
  barGeometry,
  loadPaneSections,
  paneLayout
} from '../src/renderer/src/lib/mission-pane-view'
import { sampleOf, type SampleState } from '../src/renderer/src/lib/mission-sample'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'
const SESSION = '99999999-9999-4999-8999-999999999999'

// ---- A ResizeObserver the test can drive ------------------------------------------------------------------

class FakeResizeObserver {
  static all: FakeResizeObserver[] = []
  constructor(private cb: (entries: unknown[], ro: unknown) => void) {
    FakeResizeObserver.all.push(this)
  }
  observe(): void {
    // the test drives the size by hand
  }
  unobserve(): void {
    // nothing to stop
  }
  disconnect(): void {
    FakeResizeObserver.all = FakeResizeObserver.all.filter((x) => x !== this)
  }
  fire(width: number): void {
    this.cb([{ contentRect: { width, height: 600 }, target: document.body }], this)
  }
}
async function setPaneWidth(px: number): Promise<void> {
  for (const ro of [...FakeResizeObserver.all]) ro.fire(px)
  await flushPromises()
}

// ---- Mounting ------------------------------------------------------------------------------------------------

/** The sample reply of a state, made the reply of a REAL session (the pane follows `SESSION`). */
function realReply(
  state: SampleState,
  edit?: (r: { detail: Record<string, unknown> } & Record<string, unknown>) => void
): MissionV4ViewReply {
  const r = structuredClone(sampleOf(state).reply) as unknown as {
    sessions: Array<{ id: string }>
    detail: Record<string, unknown>
  } & Record<string, unknown>
  r.sessions = r.sessions.map((s, i) => (i === 0 ? { ...s, id: SESSION } : s))
  edit?.(r)
  return r as unknown as MissionV4ViewReply
}

let wrapper: VueWrapper | null = null

async function mountPane(reply: MissionV4ViewReply): Promise<VueWrapper> {
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    missionV4View: vi.fn(async () => reply),
    missionV4Door: vi.fn(),
    missionHandOff: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    sessionLinksList: vi.fn(async () => []),
    shellOpenExternal: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: [{ sessionId: SESSION, projectPath: FOLDER, summary: 'Leader' }] }
  ] as never
  sessions.select(SESSION)
  const w = mount(MissionPane, {
    props: {
      pane: { id: 'h-mission', type: 'mission', cwd: FOLDER, ratio: 1 },
      worktreePath: FOLDER
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  wrapper = w
  await flushPromises()
  await new Promise((r) => setTimeout(r, 30))
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
  FakeResizeObserver.all = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]

// ---- AC-8 · the width rule ---------------------------------------------------------------------------------

describe('AC-8 — a narrow pane stays usable: no minimum width, a narrow layout below 240 px', () => {
  it('states the rule: narrow below 240 px, regular from 240 px, tighter padding when narrow', () => {
    for (const w of [96, 110, 160, 213, 239]) {
      expect(paneLayout(w), `${w}px`).toMatchObject({ mode: 'narrow', padX: 10 })
    }
    for (const w of [240, 290, 296, 420, 900]) {
      expect(paneLayout(w), `${w}px`).toMatchObject({ mode: 'regular', padX: 16 })
    }
  })

  it('has no minimum width: any width, even zero before the first measure, gets a layout', () => {
    for (const w of [0, 1, 50, 110]) expect(paneLayout(w).mode).toBe('narrow')
    expect(paneLayout(Number.NaN).mode).toBe('regular')
  })

  it('the mounted pane follows its own width: 110 px is narrow, 296 and 420 px are regular', async () => {
    await mountPane(realReply('default'))
    const root = q('[data-dsqa="mission-pane"]') as HTMLElement
    await setPaneWidth(110)
    expect(root.getAttribute('data-width-mode')).toBe('narrow')
    await setPaneWidth(296)
    expect(root.getAttribute('data-width-mode')).toBe('regular')
    await setPaneWidth(420)
    expect(root.getAttribute('data-width-mode')).toBe('regular')
    await setPaneWidth(110)
    expect(root.getAttribute('data-width-mode')).toBe('narrow')
  })

  it('the disclosure lines wrap instead of holding a fixed-width label (found in the 110 px capture)', async () => {
    await mountPane(realReply('default'))
    await setPaneWidth(110)
    for (const sel of ['[data-test="tree-toggle"]', '[data-test="sessions-toggle"]']) {
      const toggle = q(sel) as HTMLElement
      expect(toggle.className, sel).toContain('flex-wrap')
      for (const label of [...toggle.querySelectorAll<HTMLElement>('span')]) {
        if (!label.textContent?.trim()) continue // the chevron keeps its size
        expect(label.className, `${sel}: ${label.textContent}`).not.toContain('shrink-0')
      }
    }
  })

  it('at 110 px the body never scrolls sideways and the glance keeps its title, bar and next step', async () => {
    await mountPane(realReply('default'))
    await setPaneWidth(110)
    const body = q('[data-dsqa="mission-pane"] .scrollable') as HTMLElement
    expect(body.className).toContain('overflow-x-hidden')
    expect(q('[data-test="mission-title"]')?.textContent?.trim()).not.toBe('')
    expect(q('[data-test="mission-progress"]')).not.toBeNull()
    expect(q('[data-test="next-step"]')).not.toBeNull()
  })
})

// ---- AC-1 · nothing clipped at 213 px ----------------------------------------------------------------------

describe('AC-1 — the glance loses no text and no control at 213 px', () => {
  it('the count truncates whole with its full text in a title, never clipped silently', async () => {
    await mountPane(realReply('default'))
    await setPaneWidth(213)
    const count = q('[data-test="mission-count"]') as HTMLElement
    expect(count.className).toContain('truncate')
    expect(count.getAttribute('title')).toBe(count.textContent?.trim())
    expect((count.getAttribute('title') ?? '').length).toBeGreaterThan(0)
  })

  it('the padding is the narrow one, so the text has the room the rule gave it', async () => {
    await mountPane(realReply('default'))
    await setPaneWidth(213)
    const head = q('[data-pane-section="head"]') as HTMLElement
    expect(head.style.paddingLeft).toBe('10px')
    expect(head.style.paddingRight).toBe('10px')
    await setPaneWidth(296)
    expect(head.style.paddingLeft).toBe('16px')
  })

  it('every text of the next-step box wraps (break-words, min-w-0) and its controls wrap onto new rows', async () => {
    await mountPane(realReply('default'))
    await setPaneWidth(213)
    const box = q('[data-test="next-step"]') as HTMLElement
    for (const el of [...box.querySelectorAll<HTMLElement>('span')]) {
      if (!el.textContent?.trim() || el.children.length > 0) continue
      if (el.classList.contains('uppercase')) continue // the eyebrow is one short word
      expect(el.className, el.textContent).toMatch(/break-words|min-w-0|truncate/)
    }
    const controls = box.querySelector('[data-test="next-controls"]') as HTMLElement
    expect(controls.className).toContain('flex-wrap')
    // A control never refuses to shrink: no nowrap on a button of the glance when narrow.
    for (const b of [...box.querySelectorAll<HTMLElement>('button')]) {
      expect(b.className, b.textContent ?? '').not.toContain('whitespace-nowrap')
    }
  })

  it('nothing of the glance is hidden to fit: the same controls exist at 213 px as at 420 px', async () => {
    await mountPane(realReply('default'))
    const controls = (): string[] =>
      qa(
        '[data-pane-section="head"] button, [data-pane-section="next"] button, [data-pane-section="waiting"] button'
      ).map((b) => b.getAttribute('data-test') ?? b.textContent?.trim() ?? '')
    await setPaneWidth(420)
    const wide = controls()
    await setPaneWidth(213)
    expect(controls()).toEqual(wide)
    expect(wide.length).toBeGreaterThan(0)
  })
})

// ---- AC-2 · the bar's marker ---------------------------------------------------------------------------------

describe('AC-2 — the progress bar’s marker never draws through the count', () => {
  it('places the count and the marker in different rows for fills 0, 1, 50, 99 and 100', () => {
    for (const fill of [0, 1, 50, 99, 100]) {
      const g = barGeometry(fill)
      expect(g.count.row, `fill ${fill}`).toBe(1)
      if (g.marker !== null) {
        expect(g.marker.row, `fill ${fill}`).not.toBe(g.count.row)
        expect(g.marker.widthPct).toBe(fill)
      }
      // The marker draws only where there is a fill edge to mark: not at 0, not once the bar is full.
      expect(g.marker === null, `fill ${fill}`).toBe(fill <= 0 || fill >= 100)
    }
  })

  /** One milestone-less mission with `done` of `total` steps done, as the server counts them. */
  const withProgress = (done: number, total: number): MissionV4ViewReply =>
    realReply('default', (r) => {
      const d = r.detail as { progress: { done: number; total: number } }
      d.progress = { ...d.progress, done, total }
    })

  it.each([
    [0, 21, 0],
    [1, 100, 1],
    [1, 2, 50],
    [99, 100, 99],
    [21, 21, 100]
  ])(
    'mounted at %i of %i (%i%%): the count and the marker sit in separate grid rows',
    async (done, total, fill) => {
      await mountPane(withProgress(done, total))
      const bar = q('[data-test="mission-progress"]') as HTMLElement
      const count = bar.querySelector('[data-test="mission-count"]') as HTMLElement
      const marker = bar.querySelector('[data-test="mission-bar-marker"]') as HTMLElement | null
      expect(count.className).toContain('row-start-1')
      if (fill <= 0 || fill >= 100) {
        expect(marker, `fill ${fill}`).toBeNull()
      } else {
        expect(marker, `fill ${fill}`).not.toBeNull()
        expect(marker!.className).toContain('row-start-2')
        expect(marker!.style.width).toBe(`${fill}%`)
      }
      // The fill's edge is not a vertical line that can run through the text any more.
      const fillEl = bar.querySelector('[data-test="mission-bar-fill"]') as HTMLElement
      expect(fillEl.className).not.toContain('border-r')
    }
  )
})

// ---- AC-9 · the selector ---------------------------------------------------------------------------------------

describe('AC-9 — the selector of the missions a session leads never hides its text', () => {
  it('stacks its label above the control, which takes the full width and names the mission in a title', async () => {
    const w = await mountPane(realReply('default'))
    const store = useMissionsStore()
    ;(store as unknown as { readers: unknown }).readers = [
      {
        detail: { leads: SESSION },
        mission: { id: 'mnt-a' },
        lookupId: 'mnt-a',
        title: 'A long mission title that does not fit in a narrow select control at all'
      },
      { detail: { leads: SESSION }, mission: { id: 'mnt-b' }, lookupId: 'mnt-b', title: 'Second' }
    ]
    await flushPromises()
    await setPaneWidth(290)
    const label = q('[data-test="mission-leads"]') as HTMLElement
    expect(label, 'two led missions show the selector').not.toBeNull()
    expect(label.className).toContain('flex-col')
    const select = q('[data-test="mission-leads-select"]') as HTMLSelectElement
    expect(select.className).toContain('w-full')
    expect(select.getAttribute('title')).toBeTruthy()
    for (const o of [...select.options])
      expect(o.getAttribute('title') ?? o.textContent).toBeTruthy()
    void w
  })
})

// ---- AC-12 · density: the order, the collapsed defaults, the state kept ---------------------------------------

describe('AC-12 — the glance first; everything else one click away, and it stays where you left it', () => {
  it('fixes the section order and which sections start collapsed', () => {
    expect([...PANE_ORDER]).toEqual(['head', 'next', 'waiting', 'tree', 'sessions'])
    expect([...GLANCE_SECTIONS]).toEqual(['head', 'next', 'waiting'])
    expect(PANE_SECTION_DEFAULTS).toEqual({ tree: false, sessions: false, more: false })
  })

  it('draws the sections in that order, the tree and the sessions collapsed', async () => {
    await mountPane(realReply('default'))
    const order = qa('[data-pane-section]').map((el) => el.getAttribute('data-pane-section'))
    const wanted = PANE_ORDER.filter((id) => order.includes(id))
    expect(order).toEqual(wanted)
    expect(order.slice(0, 2)).toEqual(['head', 'next'])
    expect(order).toContain('tree')
    expect(order).toContain('sessions')

    const treeToggle = q('[data-test="tree-toggle"]') as HTMLElement
    expect(treeToggle.getAttribute('aria-expanded')).toBe('false')
    expect(q('[data-test="tree"]'), 'the full tree is one click away').toBeNull()
    expect(q('[data-test="sessions-toggle"]')?.getAttribute('aria-expanded')).toBe('false')
    expect(q('[data-test="session-row"]')).toBeNull()
    expect(q('[data-test="next-more"]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('names where the mission is on the collapsed tree line, so it needs no click to read', async () => {
    await mountPane(realReply('default'))
    const meta = q('[data-test="tree-meta"]')
    expect(meta?.textContent?.trim()).toBeTruthy()
    expect(meta?.textContent).toContain('A tool that scores a spec')
  })

  it('one click opens the tree, and the choice survives a refresh (the pane mounted again)', async () => {
    await mountPane(realReply('default'))
    await (q('[data-test="tree-toggle"]') as HTMLElement).click()
    await flushPromises()
    expect(q('[data-test="tree"]')).not.toBeNull()
    expect(loadPaneSections(localStorage).tree).toBe(true)

    wrapper?.unmount()
    document.body.innerHTML = ''
    await mountPane(realReply('default'))
    expect(q('[data-test="tree"]'), 'the tree stays open after a refresh').not.toBeNull()
    expect(q('[data-test="tree-toggle"]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('the sessions row and the rest of the waiting list keep their state the same way', async () => {
    await mountPane(realReply('default'))
    await (q('[data-test="sessions-toggle"]') as HTMLElement).click()
    await (q('[data-test="next-more"]') as HTMLElement).click()
    await flushPromises()
    expect(JSON.parse(localStorage.getItem(PANE_SECTIONS_KEY) ?? '{}')).toMatchObject({
      sessions: true,
      more: true
    })
    wrapper?.unmount()
    document.body.innerHTML = ''
    await mountPane(realReply('default'))
    expect(q('[data-test="sessions-toggle"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(q('[data-test="next-more"]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('"Open step" opens the collapsed tree and brings the step into it: nothing is unreachable', async () => {
    await mountPane(realReply('default'))
    expect(q('[data-test="tree"]')).toBeNull()
    await (q('[data-test="next-open-step"]') as HTMLElement).click()
    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))
    expect(q('[data-test="tree"]')).not.toBeNull()
    expect(q('[data-test="step-open"]'), 'the step it named is open').not.toBeNull()
  })

  it('a stored value that is not a state is ignored: the defaults apply', () => {
    localStorage.setItem(PANE_SECTIONS_KEY, '{"tree":"yes","sessions":1}')
    expect(loadPaneSections(localStorage)).toEqual(PANE_SECTION_DEFAULTS)
    localStorage.setItem(PANE_SECTIONS_KEY, 'not json')
    expect(loadPaneSections(localStorage)).toEqual(PANE_SECTION_DEFAULTS)
    expect(loadPaneSections(null)).toEqual(PANE_SECTION_DEFAULTS)
  })
})
