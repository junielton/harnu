// @vitest-environment jsdom
/**
 * Missions v4 · stp-21 · delta 1 — two things the operator would see were wrong in the verified pane.
 *
 * 1. The opened "N more waiting on you" rows kept a fixed two-column grid at every width. At 110 px the
 *    text column shrank to about 10 px and "CHECK Mark done: …" stacked one letter per line. When the pane
 *    is narrow the row is one column and the button sits on its own row under the text.
 * 2. An older (version 3) mission with a staged re-scope read "Nothing for you right now" in Your next
 *    step while the Approve / Decline box sat right below it. The next step now names the staged Done when
 *    and its button brings the box into view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { PANE_SECTIONS_KEY, nextLook, restRowGrid } from '../src/renderer/src/lib/mission-pane-view'
import { sampleOf, type SampleState } from '../src/renderer/src/lib/mission-sample'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'
const SESSION = '99999999-9999-4999-8999-999999999999'

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

type Editable = { detail: Record<string, unknown> } & Record<string, unknown>

function realReply(state: SampleState, edit?: (r: Editable) => void): MissionV4ViewReply {
  const r = structuredClone(sampleOf(state).reply) as unknown as {
    sessions: Array<{ id: string }>
  } & Editable
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

// ---- 1 · the opened "more" rows -----------------------------------------------------------------------------

/** Two rows that carry a button: a criterion to mark done and a close. */
function withRestRows(r: Editable): void {
  const w = r.detail.waiting as { items: unknown[]; next: unknown; more: unknown[] }
  const settle = {
    kind: 'settle',
    id: 'settle:stp-1:crt-1',
    stepId: 'stp-1',
    criterionId: 'crt-1',
    ask: 'Mark done: The plan names the test files',
    why: 'It is the last thing open on this step'
  }
  const close = { kind: 'close', id: 'close', requested: false, ask: 'Close', why: 'Done' }
  w.items.push(settle, close)
  w.more.push(settle, close)
}

describe('the opened "more waiting on you" rows keep their text readable', () => {
  it('the rule: one column and the button on its own row when narrow, two columns otherwise', () => {
    expect(restRowGrid('narrow')).toEqual({ columns: 'minmax(0, 1fr)', buttonBeside: false })
    expect(restRowGrid('regular')).toEqual({ columns: '1fr auto', buttonBeside: true })
  })

  it('at 110 px a row is one column and its button is not pinned beside the text', async () => {
    localStorage.setItem(PANE_SECTIONS_KEY, '{"more":true}')
    await mountPane(realReply('default', withRestRows))
    await setPaneWidth(110)
    const rows = qa('[data-test="next-rest-row"]')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      // With a single track the text column is the whole row: about 74 px at 110 px, never 10 px.
      expect(row.style.gridTemplateColumns).toBe('minmax(0, 1fr)')
      for (const button of [...row.querySelectorAll<HTMLElement>('button')]) {
        expect(button.style.gridColumn, button.textContent ?? '').not.toBe('2')
        expect(button.className).not.toContain('row-span-2')
        expect(button.style.gridRow).not.toContain('span')
      }
    }
    expect(rows.some((row) => row.querySelector('[data-test="next-rest-open"]'))).toBe(true)
    expect(rows.some((row) => row.querySelector('[data-test="next-close"]'))).toBe(true)
  })

  it('at the default width the rows keep today’s two columns with the button beside the text', async () => {
    localStorage.setItem(PANE_SECTIONS_KEY, '{"more":true}')
    await mountPane(realReply('default', withRestRows))
    await setPaneWidth(296)
    const rows = qa('[data-test="next-rest-row"]')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      expect(row.style.gridTemplateColumns).toBe('1fr auto')
      const button = row.querySelector<HTMLElement>('button')
      expect(button?.style.gridColumn).toBe('2')
    }
  })

  it('the layout follows the width back and forth', async () => {
    localStorage.setItem(PANE_SECTIONS_KEY, '{"more":true}')
    await mountPane(realReply('default', withRestRows))
    await setPaneWidth(110)
    expect(qa('[data-test="next-rest-row"]')[0].style.gridTemplateColumns).toBe('minmax(0, 1fr)')
    await setPaneWidth(420)
    expect(qa('[data-test="next-rest-row"]')[0].style.gridTemplateColumns).toBe('1fr auto')
  })
})

// ---- 2 · a staged re-scope is a next step --------------------------------------------------------------------

/** What an older mission with a staged re-scope looks like to the pane: nothing in the waiting list, a staged Done when. */
function stagedOnly(r: Editable): void {
  const empty = {
    items: [],
    next: null,
    more: [],
    moreLine: null,
    people: [],
    peopleLine: null,
    peopleLines: []
  }
  r.detail.waiting = empty
  ;(r.detail as { next?: unknown }).next = null
  r.pendingDoneWhen = {
    text: 'Every spec is scored and the scores are in a report. Proof: the report.'
  }
}

describe('Your next step names a staged re-scope instead of "Nothing for you right now"', () => {
  it('the look is "you" when a staged Done when is the only thing waiting', async () => {
    const reply = realReply('default', stagedOnly)
    const detail = (reply as unknown as { detail: Parameters<typeof nextLook>[0] }).detail
    expect(nextLook(detail)).toBe('calm')
    expect(nextLook(detail, true)).toBe('you')
  })

  it('the box says so and offers a button; the old "Nothing for you" line is gone', async () => {
    await mountPane(realReply('default', stagedOnly))
    const box = q('[data-test="next-step"]') as HTMLElement
    expect(box.getAttribute('data-look')).toBe('you')
    expect(box.textContent).not.toContain('Nothing for you right now')
    expect(q('[data-test="next-calm"]')).toBeNull()
    expect(box.textContent).toContain('Your next step')
    expect(box.textContent).toContain('new Done when')
    expect(box.querySelector('[data-test="next-open-staged"]')).not.toBeNull()
    // The Approve / Decline box is still there.
    expect(q('[data-test="done-when-staged"]')).not.toBeNull()
  })

  it('the button brings the Approve / Decline box into view', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    await mountPane(realReply('default', stagedOnly))
    ;(q('[data-test="next-open-staged"]') as HTMLElement).click()
    await flushPromises()
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.instances[0]).toBe(q('[data-test="done-when-staged"]'))
  })

  it('a Done when that is not staged leaves the calm line as it was', async () => {
    await mountPane(
      realReply('default', (r) => {
        stagedOnly(r)
        r.pendingDoneWhen = null
      })
    )
    const box = q('[data-test="next-step"]') as HTMLElement
    expect(box.getAttribute('data-look')).toBe('calm')
    expect(box.textContent).toContain('Nothing for you right now')
    expect(box.querySelector('[data-test="next-open-staged"]')).toBeNull()
  })

  it('under pt-BR the staged line is Portuguese', async () => {
    i18n.global.locale.value = 'pt-BR'
    await mountPane(realReply('default', stagedOnly))
    const box = q('[data-test="next-step"]') as HTMLElement
    expect(box.textContent).not.toContain('Nothing for you')
    expect(box.textContent).not.toMatch(/new Done when|Approve|waiting/i)
    const button = box.querySelector('[data-test="next-open-staged"]')
    expect(button).not.toBeNull()
    expect(button?.textContent?.trim()).toBeTruthy()
    expect(box.textContent).toContain('Pronto quando')
  })
})
