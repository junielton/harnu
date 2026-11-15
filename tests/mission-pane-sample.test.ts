// @vitest-environment jsdom
/**
 * Missions v4 · S-22 · AC-61 (and the data behind AC-59) — the sample mission. A sample can be shown in
 * the Mission pane with no record on disk, so every state of the mockup is visible without a live
 * delivery. It is built in the renderer from nothing: no file, no `window.api`, no door. Pressing a
 * button on it changes nothing anywhere.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { classifyReply, buildPaneTree } from '../src/renderer/src/lib/mission-pane-view'
import { SAMPLE_STATES, sampleOf, type SampleState } from '../src/renderer/src/lib/mission-sample'

const FOLDER = '/repo'
const REAL_SESSION = '99999999-9999-4999-8999-999999999999'

const mockupStates = (): string[] => {
  const json = JSON.parse(readFileSync('docs/design/missions-v4/mockup.json', 'utf8')) as {
    screens: Array<{ id: string; states: string[] }>
  }
  return json.screens.find((s) => s.id === 'mission-pane')!.states
}

let wrapper: VueWrapper | null = null
let api: Record<string, ReturnType<typeof vi.fn>>

async function settle(): Promise<void> {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await flushPromises()
}

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]
const text = (sel: string): string => (q(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The pane, on a real session that has no mission: every call to the main process is counted. */
async function mountPane(): Promise<VueWrapper> {
  api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    campaignList: vi.fn(async () => ({ views: [], unreadable: [] })),
    missionV4View: vi.fn(async () => ({ state: 'none', missions: [] })),
    missionV4Door: vi.fn(async () => ({ ok: true, changed: true })),
    missionHandOff: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    sessionLinksList: vi.fn(async () => []),
    shellOpenExternal: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  const sessions = useSessionsStore()
  sessions.folders = [
    {
      path: FOLDER,
      sessions: [{ sessionId: REAL_SESSION, projectPath: FOLDER, summary: 'Scratch' }]
    }
  ] as never
  sessions.select(REAL_SESSION)
  const w = mount(MissionPane, {
    props: {
      pane: { id: 'h-mission', type: 'mission', cwd: FOLDER, ratio: 1 },
      worktreePath: FOLDER
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  wrapper = w
  await settle()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('the sample mission (Missions v4 S-22, AC-61)', () => {
  it('covers every state of the mockup, simple, simple-signoff, done, clear and closed included', () => {
    expect([...SAMPLE_STATES].sort()).toEqual([...mockupStates()].sort())
    for (const s of ['simple', 'simple-signoff', 'done', 'clear', 'closed'])
      expect(SAMPLE_STATES).toContain(s)
  })

  it('every state classifies the way the mockup draws it: a mission, or no mission', () => {
    const noMission = new Set<SampleState>(['no-mission', 'attach-request', 'closed'])
    for (const state of SAMPLE_STATES) {
      const sample = sampleOf(state)
      const kind = classifyReply(sample.reply, sample.sessionId)
      expect(kind, state).toBe(noMission.has(state) ? 'none' : 'mission')
    }
  })

  it('the sample needs no file: built from nothing, it reads no disk and calls no channel', () => {
    // The code, not its comments: the header says what it never uses.
    const src = readFileSync('src/renderer/src/lib/mission-sample.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/from 'node:|require\(|window\.api|fetch\(/)
    // Asking for a state twice gives equal data, and none of it is shared: one state cannot change another.
    const a = sampleOf('default')
    const b = sampleOf('default')
    expect(a).toEqual(b)
    expect(a.reply).not.toBe(b.reply)
  })

  it('the sample needs no file: the pane shows it with no record, no view call and no door call', async () => {
    await mountPane()
    const callsBefore = api.missionV4View.mock.calls.length
    const doorBefore = api.missionV4Door.mock.calls.length
    const missions = useMissionsStore()
    missions.showSample('default')
    await settle()
    expect(q('[data-test="mission-title"]')).not.toBeNull()
    expect(text('[data-test="mission-title"]')).toBe(sampleOf('default').title)
    expect(q('[data-test="mission-sample"]')).not.toBeNull()
    // Pressing "Open step" on the sample, and Mark on a criterion, change nothing anywhere.
    q('[data-test="next-open-step"]')?.click()
    await settle()
    for (const b of qa('[data-test="criterion-mark"]')) b.click()
    await settle()
    expect(api.missionV4Door.mock.calls.length).toBe(doorBefore)
    expect(api.missionV4View.mock.calls.length).toBe(callsBefore)
  })

  it('every state shows in the pane and says it is a sample, and leaving it brings the real answer back', async () => {
    await mountPane()
    const missions = useMissionsStore()
    for (const state of SAMPLE_STATES) {
      missions.showSample(state)
      await settle()
      expect(q('[data-test="mission-sample"]'), state).not.toBeNull()
      const noMission = state === 'no-mission' || state === 'attach-request' || state === 'closed'
      expect(q('[data-test="mission-title"]') !== null, state).toBe(!noMission)
      expect(q('[data-test="mission-none"]') !== null, state).toBe(noMission)
    }
    missions.showSample(null)
    await settle()
    expect(q('[data-test="mission-sample"]')).toBeNull()
    expect(q('[data-test="mission-none"]')).not.toBeNull()
  })

  it('the no-mission state offers the sample, and the chooser changes the state', async () => {
    await mountPane()
    await (async () => {
      q('[data-test="mission-sample-open"]')!.click()
      await settle()
    })()
    expect(q('[data-test="mission-sample"]')).not.toBeNull()
    const select = q('[data-test="mission-sample-state"]') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual([...SAMPLE_STATES])
    select.value = 'simple-signoff'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(text('[data-test="mission-title"]')).toBe(sampleOf('simple-signoff').title)
    q('[data-test="mission-sample-leave"]')!.click()
    await settle()
    expect(q('[data-test="mission-sample"]')).toBeNull()
  })

  it('a sample close changes nothing: the dialog confirms, no door runs, and the sample stays', async () => {
    await mountPane()
    useMissionsStore().showSample('done')
    await settle()
    q('[data-test="next-close"]')!.click()
    await settle()
    q('[data-test="mission-close-confirm-go"]')!.click()
    await settle()
    expect(api.missionV4Door).not.toHaveBeenCalled()
    expect(q('[data-test="mission-sample"]')).not.toBeNull()
  })

  it('every sample string exists in en and pt-BR', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
      )
    const en = keys((enMessages as { missionPane: { sample: unknown } }).missionPane.sample)
    const pt = keys((ptMessages as { missionPane: { sample: unknown } }).missionPane.sample)
    expect(en.length).toBeGreaterThan(SAMPLE_STATES.length)
    expect(pt).toEqual(en)
    for (const s of SAMPLE_STATES) {
      expect(en).toContain(`state.${s}`)
    }
  })
})

describe('a small task is a mission with no milestones (Missions v4 S-22, AC-59)', () => {
  it('simple: no milestones, the steps sit directly on the timeline, the task’s criteria show', () => {
    const { reply } = sampleOf('simple')
    if (reply.state !== 'mission') throw new Error('fixture')
    expect(reply.detail.milestones).toEqual([])
    const tree = buildPaneTree(reply.detail)
    expect(tree.milestones).toEqual([])
    expect(tree.loose).not.toBeNull()
    const rows = [...tree.loose!.shown, ...tree.loose!.folded]
    expect(rows.map((r) => r.title)).toEqual([
      'Build the table, desktop and mobile',
      'Get the sign-offs'
    ])
    // The criteria pulled from the task, five of them, each settled by a second session.
    const build = rows[0]
    expect(build.criteria).toHaveLength(5)
    expect(build.criteria.every((c) => c.by === 'session')).toBe(true)
  })

  it('simple-signoff: another person’s sign-offs are marks the operator ticks, and wait for the person', async () => {
    await mountPane()
    useMissionsStore().showSample('simple-signoff')
    await settle()
    expect(text('[data-test="mission-title"]')).toBe('Build the data table section')
    // The mission has no milestones: no milestone rows.
    expect(q('[data-test="milestone-row"]')).toBeNull()
    // Open the step the sign-offs belong to.
    const sign = qa('[data-test="step-row"]').find((r) =>
      r.textContent?.includes('Get the sign-offs')
    )
    expect(sign).toBeTruthy()
    sign!.click()
    await settle()
    const body = text('[data-dsqa-part="tree"]')
    expect(body).toContain('The designer signed off')
    expect(body).toContain('Waiting for the designer')
    // The operator ticks each one when the person approves: a mark on the person's sign-off, and on their own.
    const marks = qa('[data-test="criterion-mark"]').map((b) => b.textContent?.trim())
    expect(marks).toEqual(['Mark approved', 'Mark done'])
    // The QA analyst's is already marked: it folds into the count of verified criteria, as in every open step.
    expect(body).toContain('1 criterion verified')
  })
})
