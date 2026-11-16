// @vitest-environment jsdom
/**
 * Missions v4 · S-40 merge with T751 — a staged re-scope shows exactly ONCE in "Your next step".
 *
 * An older (version 3) mission with a staged re-scope is both things at once: the pane's staged Done when
 * (`pendingDoneWhen`, which T751 made the Next line name) and a `rescope` item in the waiting list (S-40, so
 * the pill, the chip, Activity and Your move count it). The Next box must show it as ONE line with ONE button
 * that brings the Approve / Decline box into view, in English and in pt-BR: never twice, never as the server's
 * English wording, never as a row with no button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { PANE_SECTIONS_KEY } from '../src/renderer/src/lib/mission-pane-view'
import { sampleOf, type SampleState } from '../src/renderer/src/lib/mission-sample'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'
const SESSION = '99999999-9999-4999-8999-999999999999'

class FakeResizeObserver {
  constructor(private cb: (entries: unknown[], ro: unknown) => void) {}
  observe(): void {
    // the pane keeps its default width
  }
  unobserve(): void {
    // nothing to stop
  }
  disconnect(): void {
    // nothing to stop
  }
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

const STAGED_TEXT = 'Every spec is scored and the scores are in a report. Proof: the report.'
const RAW_ENGLISH = 'Approve or decline the new end:'

/** What the server's waiting list holds for a converted v3 mission with a staged re-scope. */
const rescopeItem = {
  kind: 'rescope',
  id: 'rescope:Every spec is scored',
  end: STAGED_TEXT,
  ask: `${RAW_ENGLISH} Every spec is scored`,
  why: 'The mission cannot close until you decide'
}
const settleItem = {
  kind: 'settle',
  id: 'settle:stp-1:crt-1',
  stepId: 'stp-1',
  criterionId: 'crt-1',
  ask: 'Mark done: The plan names the test files',
  why: 'It is the last thing open on this step'
}

function waitingOf(next: unknown, more: unknown[]): Record<string, unknown> {
  return {
    items: [next, ...more],
    next,
    more,
    moreLine: null,
    people: [],
    peopleLine: null,
    peopleLines: []
  }
}

/** The re-scope is the whole list: it is the Next line. */
function rescopeIsNext(r: Editable): void {
  r.detail.waiting = waitingOf(rescopeItem, [])
  r.pendingDoneWhen = { text: STAGED_TEXT }
}
/** Something else is the Next line; the re-scope is the one row of "N more waiting on you". */
function rescopeIsMore(r: Editable): void {
  r.detail.waiting = waitingOf(settleItem, [rescopeItem])
  r.pendingDoneWhen = { text: STAGED_TEXT }
}

describe('a staged re-scope that is a Next line shows exactly once, with one button', () => {
  it('en: one line, one button, no server wording, no "Open step" button', async () => {
    await mountPane(realReply('default', rescopeIsNext))
    const box = q('[data-test="next-step"]') as HTMLElement
    expect(box.getAttribute('data-look')).toBe('you')
    const mentions = box.textContent?.match(/new Done when/g) ?? []
    expect(mentions).toHaveLength(1)
    expect(box.textContent).not.toContain(RAW_ENGLISH)
    expect(box.textContent).not.toContain('Nothing for you right now')
    expect(qa('[data-test="next-open-staged"]')).toHaveLength(1)
    expect(qa('[data-test="next-open-step"]')).toHaveLength(0)
    expect(qa('[data-test="next-rest-staged"]')).toHaveLength(0)
    expect(box.querySelectorAll('button')).toHaveLength(1)
    // The Approve / Decline box is the one place that answers it.
    expect(qa('[data-test="done-when-staged"]')).toHaveLength(1)
  })

  it('en: the one button brings the Approve / Decline box into view', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    await mountPane(realReply('default', rescopeIsNext))
    ;(q('[data-test="next-open-staged"]') as HTMLElement).click()
    await flushPromises()
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.instances[0]).toBe(q('[data-test="done-when-staged"]'))
  })

  it('pt-BR: one line in Portuguese, one button', async () => {
    i18n.global.locale.value = 'pt-BR'
    await mountPane(realReply('default', rescopeIsNext))
    const box = q('[data-test="next-step"]') as HTMLElement
    expect(box.textContent?.match(/Pronto quando/g) ?? []).toHaveLength(1)
    expect(box.textContent).not.toContain(RAW_ENGLISH)
    expect(box.textContent).not.toMatch(/new Done when|Approve|decline/i)
    expect(qa('[data-test="next-open-staged"]')).toHaveLength(1)
    expect(qa('[data-test="next-open-step"]')).toHaveLength(0)
    expect(box.querySelectorAll('button')).toHaveLength(1)
    expect(qa('[data-test="next-open-staged"]')[0].textContent?.trim()).toBe('Ver proposta')
  })
})

describe('a staged re-scope that sits in "N more waiting on you" shows once there, with one button', () => {
  it('en: one row, one button, labelled; the top line stays the other item', async () => {
    localStorage.setItem(PANE_SECTIONS_KEY, '{"more":true}')
    await mountPane(realReply('default', rescopeIsMore))
    const box = q('[data-test="next-step"]') as HTMLElement
    expect(box.textContent).toContain('Mark done: The plan names the test files')
    const rows = qa('[data-test="next-rest-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute('data-kind')).toBe('rescope')
    expect(rows[0].textContent).toContain('new Done when')
    expect(rows[0].textContent).toContain('Done when')
    expect(rows[0].textContent).not.toContain(RAW_ENGLISH)
    expect(rows[0].textContent).not.toContain('missionPane.next.kind')
    expect(box.textContent?.match(/new Done when/g) ?? []).toHaveLength(1)
    expect(rows[0].querySelectorAll('button')).toHaveLength(1)
    expect(qa('[data-test="next-rest-staged"]')).toHaveLength(1)
    // It is not also drawn as the Next line.
    expect(qa('[data-test="next-open-staged"]')).toHaveLength(0)
  })

  it('en: its button brings the Approve / Decline box into view', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    localStorage.setItem(PANE_SECTIONS_KEY, '{"more":true}')
    await mountPane(realReply('default', rescopeIsMore))
    ;(q('[data-test="next-rest-staged"]') as HTMLElement).click()
    await flushPromises()
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.instances[0]).toBe(q('[data-test="done-when-staged"]'))
  })

  it('pt-BR: one row in Portuguese, one button', async () => {
    i18n.global.locale.value = 'pt-BR'
    localStorage.setItem(PANE_SECTIONS_KEY, '{"more":true}')
    await mountPane(realReply('default', rescopeIsMore))
    const rows = qa('[data-test="next-rest-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Pronto quando')
    expect(rows[0].textContent).not.toContain(RAW_ENGLISH)
    expect(rows[0].textContent).not.toMatch(/Approve|decline|missionPane\.next\.kind/i)
    expect(rows[0].querySelectorAll('button')).toHaveLength(1)
    expect(qa('[data-test="next-rest-staged"]')[0].textContent?.trim()).toBe('Ver proposta')
  })
})
