// @vitest-environment jsdom
/**
 * Missions v4 · S-17 · AC-43 (what the pill reads), and Mission dropdown · S-7 · AC-20 (the pill opens the
 * dropdown: a caret, `aria-haspopup` and `aria-expanded`, the chord, and the quiet no-mission pill).
 * Mounted against the real stores with `window.api` faked.
 *
 * Every number is the SERVER's: the fixtures below carry a `steps` list that disagrees with
 * `progress`, so a renderer that recounted would print something else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import { missionPillText } from '../src/renderer/src/lib/mission-pane-view'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'
import { fixtureView } from './helpers/mission-v3-view'

const FOLDER = '/repo'
const SESSION = 'sess-1'

interface PillOver {
  source?: 'v4' | 'v3-mission' | 'v3-campaign'
  unit?: 'milestones' | 'steps'
  total?: number
  done?: number
  waiting?: number
  state?: 'open' | 'ready-to-close' | 'closed'
}

function reply(over: PillOver = {}): MissionV4ViewReply {
  const total = over.total ?? 21
  const done = over.done ?? 4
  return {
    state: 'mission',
    missionId: 'mnt-v4',
    source: over.source ?? 'v4',
    detail: {
      ok: true,
      id: 'mnt-v4',
      title: 'Measure the spec',
      doneWhen: '',
      status: over.state === 'closed' ? 'closed' : 'open',
      state: over.state ?? 'open',
      stateLabel: 'Open',
      standing: 'operator',
      leads: SESSION,
      source: over.source ?? 'v4',
      progress: {
        unit: over.unit ?? 'steps',
        total,
        done,
        headline: 'unused',
        current: null,
        allDone: done === total,
        counts: { todo: 0, running: 0, waitingReview: 0, done: 0, blocked: 0 }
      },
      milestones: [],
      // Two steps and one waiting row more than the server says: a recount would not give 4/21.
      steps: [
        {
          id: 'stp-1',
          title: 'First',
          state: 'todo',
          milestone: null,
          links: [],
          criteria: [],
          blockers: []
        },
        {
          id: 'stp-2',
          title: 'Second',
          state: 'done',
          milestone: null,
          links: [],
          criteria: [],
          blockers: []
        }
      ],
      next: null,
      waiting: {
        items: Array.from({ length: over.waiting ?? 3 }, (_, i) => ({ id: `w${i}` })),
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

let viewReply: MissionV4ViewReply = { state: 'none', missions: [] }
let v3Views: unknown[] = []

function install(): void {
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: v3Views, unreadable: [], shadowed: [] })),
    missionV4View: vi.fn(async () => viewReply),
    missionV4Door: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
}

let wrapper: VueWrapper | null = null

async function mountPill(): Promise<VueWrapper> {
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: [{ sessionId: SESSION, projectPath: FOLDER }] }
  ] as never
  sessions.select(SESSION)
  const w = mount(MissionPill, {
    props: { sessionId: SESSION },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  wrapper = w
  await flushPromises()
  await flushPromises()
  return w
}

const api = (): Record<string, ReturnType<typeof vi.fn>> =>
  window.api as unknown as Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
  viewReply = { state: 'none', missions: [] }
  v3Views = []
  install()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('AC-43 — the pill reads the derived numbers', () => {
  it('the pill reads the derived numbers', async () => {
    viewReply = reply({ unit: 'steps', total: 21, done: 4, waiting: 3 })
    const w = await mountPill()
    expect(w.get('[data-test="mission-pill-label"]').text()).toBe('4/21 · 3 for you')
  })

  it('counts milestones when the mission has them', async () => {
    viewReply = reply({ unit: 'milestones', total: 10, done: 1, waiting: 5 })
    const w = await mountPill()
    expect(w.get('[data-test="mission-pill-label"]').text()).toBe('1/10 · 5 for you')
  })

  it('says only the count when nothing waits on the operator', async () => {
    viewReply = reply({ total: 21, done: 4, waiting: 0 })
    const w = await mountPill()
    expect(w.get('[data-test="mission-pill-label"]').text()).toBe('4/21')
  })

  it('says it is ready to close when every step is done', async () => {
    viewReply = reply({ total: 21, done: 21, waiting: 1, state: 'ready-to-close' })
    const w = await mountPill()
    expect(w.get('[data-test="mission-pill-label"]').text()).toBe('21/21 · ready to close')
  })

  it('has no campaign or chapter wording and no tick rail', async () => {
    viewReply = reply()
    const w = await mountPill()
    expect(w.text()).not.toMatch(/ch\.|chapter|campaign|step \d/i)
    expect(w.find('[data-test="campaign-ticks"]').exists()).toBe(false)
    expect(w.find('[data-test="campaign-pill-radiant"]').exists()).toBe(false)
    expect(w.attributes('data-campaign')).toBeUndefined()
  })

  it('reads in the app language', async () => {
    i18n.global.locale.value = 'pt-BR'
    viewReply = reply({ total: 21, done: 4, waiting: 3 })
    const w = await mountPill()
    expect(w.get('[data-test="mission-pill-label"]').text()).toBe('4/21 · 3 para você')
  })

  it('the pure text builder gives the same line', () => {
    const t = i18n.global.t as unknown as (k: string, v?: Record<string, unknown>) => string
    const detail = (reply({ total: 21, done: 4, waiting: 3 }) as { detail: never }).detail
    expect(missionPillText(t, detail)).toBe('4/21 · 3 for you')
  })

  it('draws the quiet no-mission pill, not nothing, for a session with no mission', async () => {
    const w = await mountPill()
    expect(w.find('button').exists()).toBe(true)
    expect(w.find('[data-test="mission-pill-label"]').exists()).toBe(false)
  })
})

describe('AC-20 — the pill opens the dropdown', () => {
  const dropdown = (): Element | null =>
    document.body.querySelector('[data-test="mission-dropdown"]')

  it('caret, aria, chord and the no-mission pill', async () => {
    viewReply = reply()
    const w = await mountPill()
    const ui = useUiStore()
    const button = w.get('button')

    // A trailing 10px caret; `aria-haspopup="dialog"` and `aria-expanded` replace `aria-pressed`.
    const caret = button.get('[data-test="mission-pill-caret"]')
    expect(caret.attributes('width')).toBe('10')
    expect(button.attributes('aria-haspopup')).toBe('dialog')
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(button.attributes('aria-pressed')).toBeUndefined()
    expect(button.classes()).not.toContain('ring-2')
    expect(dropdown()).toBeNull()

    // Click opens the dropdown and shows the ring; a second click closes it. (Enter and Space on a
    // native button are a click.)
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('type')).toBe('button')
    await button.trigger('click')
    expect(ui.popovers.missionProgress).toBe(true)
    expect(button.attributes('aria-expanded')).toBe('true')
    expect(button.classes()).toContain('ring-2')
    expect(dropdown()).not.toBeNull()
    await button.trigger('click')
    expect(ui.popovers.missionProgress).toBe(false)
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(dropdown()).toBeNull()

    // The chord is enabled while the pill is drawn, and toggles the same dropdown.
    expect(ui.popoverAnchors.missionProgress).toBe(true)
    ui.togglePopover('missionProgress')
    await flushPromises()
    expect(dropdown()).not.toBeNull()
    expect(button.attributes('aria-expanded')).toBe('true')
    ui.togglePopover('missionProgress')
    await flushPromises()
    expect(dropdown()).toBeNull()

    // No mission: a muted, icon-only pill named "No mission", with the chord's anchor registered too.
    w.unmount()
    wrapper = null
    setActivePinia(createPinia())
    viewReply = { state: 'none', missions: [] }
    install()
    const none = await mountPill()
    const quiet = none.get('button')
    expect(quiet.attributes('aria-label')).toBe('No mission')
    expect(quiet.attributes('title')).toContain('No mission')
    expect(quiet.classes()).toEqual(expect.arrayContaining(['border-border-2', 'text-text-3']))
    expect(quiet.text()).toBe('')
    expect(quiet.attributes('aria-haspopup')).toBe('dialog')
    const noneUi = useUiStore()
    expect(noneUi.popoverAnchors.missionProgress).toBe(true)
    await quiet.trigger('click')
    expect(quiet.attributes('aria-expanded')).toBe('true')
    expect(dropdown()?.textContent).toContain('This session has no mission.')
  })

  it('never opens or toggles a pane in the helper stack', async () => {
    viewReply = reply()
    const w = await mountPill()
    await w.get('button').trigger('click')
    expect(api().helpersSet).not.toHaveBeenCalled()
    expect(JSON.stringify(api().helpersSet.mock.calls)).not.toContain('mission')
  })

  it('a v3 record is read as v4 by the view and opens the dropdown; nothing is written', async () => {
    v3Views = [
      fixtureView('faq-like', { mission: { owner: { sessionId: SESSION, folder: FOLDER } } })
    ]
    // The view channel converts a v3 file in memory and says where it came from.
    viewReply = reply({ source: 'v3-mission' })
    const w = await mountPill()
    expect(w.get('[data-test="mission-pill-label"]').text()).toBe('4/21 · 3 for you')
    await w.get('button').trigger('click')
    expect(useUiStore().popovers.missionProgress).toBe(true)
    expect(api().missionV4Door).not.toHaveBeenCalled()
    expect(api().missionOperatorDoor).not.toHaveBeenCalled()
  })

  it('a session whose view says there is no mission draws the quiet pill', async () => {
    v3Views = [
      fixtureView('faq-like', { mission: { owner: { sessionId: SESSION, folder: FOLDER } } })
    ]
    viewReply = { state: 'none', missions: [] }
    const w = await mountPill()
    expect(w.get('button').attributes('aria-label')).toBe('No mission')
    expect(useUiStore().popovers.missionProgress).toBe(false)
  })
})
