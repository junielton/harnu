// @vitest-environment jsdom
/**
 * Carried fix from Mission dropdown S-7 (pill squeeze): at the app's 800px minimum width the Topbar squeezed the
 * Mission pill and it lost its label. The approved mockup draws the pill `flex-shrink: 0` ("the pill keeps its
 * count; the breadcrumb truncates first"): the pill never shrinks below its label, and the Topbar reserves its
 * width the way it reserves the provider and orchestrator badges, so the breadcrumb, the title and the action
 * cluster (into the `…` menu) give way instead. jsdom has no layout, so the contract is the class on the element,
 * the reservation in the title region's `min-width`, and a re-plan when the pill's label changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import {
  TOPBAR_MIN_TITLE_PX,
  TOPBAR_TITLE_YIELD_PX,
  clusterBudget,
  regionMin,
  titleFloor
} from '../src/renderer/src/lib/topbar-overflow'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'
const SESSION = 'sess-1'
let pillPx = 188
let headerPx = 800

function reply(done: number): MissionV4ViewReply {
  return {
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
        done,
        headline: 'unused',
        current: null,
        allDone: false,
        counts: { todo: 0, running: 0, waitingReview: 0, done: 0, blocked: 0 }
      },
      milestones: [],
      steps: [],
      next: null,
      waiting: {
        items: [{ id: 'w0' }],
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
}

let view: MissionV4ViewReply
let wrapper: VueWrapper | null = null
const observers: Array<() => void> = []

class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    observers.push(() => cb([], this as unknown as ResizeObserver))
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
  view = reply(4)
  pillPx = 188
  headerPx = 800
  observers.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  // The header is 800px wide (the app's minimum) and the pill, once drawn, is PILL_PX wide.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === 'HEADER' ? headerPx : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.v4 === 'true' ? pillPx : 0
    }
  })
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    missionV4View: vi.fn(async () => view),
    missionV4Door: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined),
    openPath: vi.fn(),
    githubPullsUrl: vi.fn().mockResolvedValue(null)
  }
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: [{ sessionId: SESSION, projectPath: FOLDER, summary: 'Leader' }] }
  ] as never
  sessions.select(SESSION)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  // @ts-expect-error restore the jsdom defaults
  delete HTMLElement.prototype.clientWidth
  // @ts-expect-error restore the jsdom defaults
  delete HTMLElement.prototype.offsetWidth
})

async function settle(): Promise<void> {
  await flushPromises()
  await new Promise((r) => setTimeout(r, 30))
  await flushPromises()
}

describe('the Mission pill never shrinks below its label', () => {
  it('the pill and its button may shrink, but only after the title has (it carries a huge shrink factor)', async () => {
    wrapper = mount(MissionPill, {
      props: { sessionId: SESSION },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await settle()
    const root = wrapper.get('[data-v4="true"]')
    const button = wrapper.get('button')
    // the title (`shrink-[1000]`, down to its stub) gives way long before the pill (shrink 1) does
    for (const el of [root, button]) {
      expect(el.classes(), el.element.tagName).toContain('shrink')
      expect(el.classes(), el.element.tagName).not.toContain('shrink-0')
    }
    // the last resort when the header cannot hold the pill: the label truncates, its text stays in the title
    expect(wrapper.get('[data-test="mission-pill-label"]').classes()).toContain('truncate')
    expect(button.attributes('title')).toContain('Measure the spec')
    // the Topbar reserves what it cannot shrink, as it does for the provider and orchestrator badges
    expect(root.attributes('data-topbar-extra')).toBeDefined()
  })

  it('the Topbar reserves the pill in the title region, so the other parts give way first', async () => {
    wrapper = mount(Topbar, { attachTo: document.body, global: { plugins: [i18n] } })
    await settle()
    const region = wrapper.get('[data-test="topbar-title"]').element.parentElement as HTMLElement
    expect(wrapper.get('[data-test="topbar-title"]').classes()).toContain('shrink-[1000]')
    // title floor + the pill's width + the `gap-2` before it
    expect(region.style.minWidth).toBe(`${TOPBAR_MIN_TITLE_PX + 188 + 8}px`)
  })

  it('the reservation follows the pill: a new label measures again', async () => {
    wrapper = mount(Topbar, { attachTo: document.body, global: { plugins: [i18n] } })
    await settle()
    const region = wrapper.get('[data-test="topbar-title"]').element.parentElement as HTMLElement
    expect(region.style.minWidth).toBe(`${TOPBAR_MIN_TITLE_PX + 188 + 8}px`)
    // the label changes ("4/21 · 1 for you" becomes "5/21 · 1 for you") and the pill is now narrower
    pillPx = 140
    view = reply(5)
    const { useMissionsStore } = await import('../src/renderer/src/stores/missions')
    await useMissionsStore().refreshV4()
    await settle()
    expect(wrapper.get('[data-test="mission-pill-label"]').text()).toBe('5/21 · 1 for you')
    expect(region.style.minWidth).toBe(`${TOPBAR_MIN_TITLE_PX + 140 + 8}px`)
  })

  it('in a header too narrow for the title floor and the pill, the title yields to its stub and the region never pushes the cluster out', async () => {
    // the app's 800px minimum with the sidebar and the Fleet rail open leaves the Topbar about 220px
    headerPx = 220
    wrapper = mount(Topbar, { attachTo: document.body, global: { plugins: [i18n] } })
    await settle()
    const title = wrapper.get('[data-test="topbar-title"]').element as HTMLElement
    const region = title.parentElement as HTMLElement
    expect(title.style.minWidth).toBe(`${TOPBAR_TITLE_YIELD_PX}px`)
    // capped at what the header can give the region: 220 − padding − toggle − bell − gaps − crumb − `…`
    const style = getComputedStyle(region.closest('header') as HTMLElement)
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    expect(region.style.minWidth).toBe(`${220 - padding - 22 - 26 - 36 - 32 - 28}px`)
    // every action is in the `…` menu, and nothing else gave way before the title did
    expect(wrapper.find('[data-test="topbar-more"]').exists()).toBe(true)
  })
})

describe('titleFloor', () => {
  const input = (headerWidth: number, extrasWidth: number) => ({
    headerWidth,
    paddingX: 0,
    hasCrumb: true,
    extrasWidth
  })

  it('keeps the title its full floor while there is room, so a wide bar is unchanged', () => {
    expect(titleFloor(input(1400, 196))).toBe(TOPBAR_MIN_TITLE_PX)
    expect(titleFloor(input(800, 0))).toBe(TOPBAR_MIN_TITLE_PX)
  })

  it('lets the title yield, never below its stub, when the badges and the pill need the room', () => {
    expect(titleFloor(input(220, 196))).toBe(TOPBAR_TITLE_YIELD_PX)
    const mid = titleFloor(input(380, 196))
    expect(mid).toBeGreaterThan(TOPBAR_TITLE_YIELD_PX)
    expect(mid).toBeLessThan(TOPBAR_MIN_TITLE_PX)
  })

  it('the action budget is what is left after the floor it uses, never negative room for the `…`', () => {
    for (const w of [220, 300, 380, 500, 800]) {
      expect(clusterBudget(input(w, 196))).toBeGreaterThanOrEqual(w >= 380 ? 0 : -200)
    }
    expect(clusterBudget(input(1400, 0))).toBe(1400 - 22 - 26 - 36 - 32 - 0 - TOPBAR_MIN_TITLE_PX)
  })
})

describe('regionMin', () => {
  const input = (headerWidth: number, extrasWidth: number) => ({
    headerWidth,
    paddingX: 0,
    hasCrumb: true,
    extrasWidth
  })

  it('is the title floor plus the badges while the header has room', () => {
    expect(regionMin(input(1400, 196))).toBe(TOPBAR_MIN_TITLE_PX + 196)
  })

  it('never asks more than the header can give once the fixed controls are paid for', () => {
    const w = 220
    expect(regionMin(input(w, 196))).toBe(w - 22 - 26 - 36 - 32 - 28)
    expect(regionMin(input(100, 196))).toBe(TOPBAR_TITLE_YIELD_PX)
  })
})
