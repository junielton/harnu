// @vitest-environment jsdom
/**
 * BUG-283 · OI-3 (G4) — every open mission of a repo gets its chip and its Activity row, however many there
 * are. The readers used to read only the first 20 rows of the list, so the 21st mission and the ones after it
 * had no chip, no cue and no Activity row even when they owed the operator something.
 *
 * Driven through the real store with the view channel faked (the list, then one named read per row, as
 * `readRepo` asks for them). Neutral names: "Acme" missions `mnt-0c0000nn`, each led by its own session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const FOLDER = '/repo'
const idOf = (n: number): string => `mnt-0c${String(n).padStart(6, '0')}`
const sessionOf = (n: number): string => `sess-${String(n).padStart(2, '0')}`

/** One mission's reply; `owes` puts one operator item on it. */
function reply(n: number, owes: boolean): MissionV4ViewReply {
  const id = idOf(n)
  const items = owes
    ? [
        {
          kind: 'settle',
          id: `settle:stp-1:ac-${n}`,
          stepId: 'stp-1',
          criterionId: `ac-${n}`,
          ask: `Mark done: Acme check ${n}`,
          why: 'It is the last thing open on this step'
        }
      ]
    : []
  return {
    state: 'mission',
    missionId: id,
    source: 'v4',
    detail: {
      ok: true,
      id,
      title: `Acme mission ${n}`,
      doneWhen: '',
      status: 'open',
      state: 'open',
      stateLabel: 'Open',
      standing: 'operator',
      leads: sessionOf(n),
      source: 'v4',
      progress: {
        unit: 'steps',
        total: 5,
        done: 2,
        headline: 'unused',
        current: null,
        allDone: false,
        counts: { todo: 0, running: 0, waitingReview: 0, done: 0, blocked: 0 }
      },
      milestones: [],
      steps: [],
      next: null,
      waiting: {
        items,
        next: items[0] ?? null,
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
    sessions: [],
    handoff: { offer: false }
  } as unknown as MissionV4ViewReply
}

/** The store, with `total` open missions in the repo and the ones in `owing` owing the operator. */
function mount(total: number, owing: number[]): ReturnType<typeof useMissionsStore> {
  setActivePinia(createPinia())
  useSessionsStore().folders = [
    {
      path: FOLDER,
      sessions: Array.from({ length: total }, (_, i) => ({ sessionId: sessionOf(i + 1) }))
    }
  ] as never
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    missionV4View: vi.fn(async (a: { missionId?: string; sessionId?: string }) => {
      if (a.missionId) {
        const n = Number(a.missionId.slice(-6))
        return reply(n, owing.includes(n))
      }
      return {
        state: 'none',
        missions: Array.from({ length: total }, (_, i) => ({
          id: idOf(i + 1),
          title: `Acme mission ${i + 1}`,
          headline: '',
          leads: sessionOf(i + 1)
        }))
      }
    }),
    missionV4Door: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  return useMissionsStore()
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  // A previous run left an empty memory: not a first run, so cues post.
  localStorage.setItem('om2tab.missionCues', JSON.stringify({ v: 1, owed: {} }))
})
afterEach(() => vi.restoreAllMocks())

describe('a repo with more than 20 open missions', () => {
  it('gives the 21st and the 25th mission their chip, saying what they owe', async () => {
    const store = mount(25, [21, 25])
    await store.refresh()
    expect(store.chipFor(sessionOf(21))?.text).toBe('2/5 · 1 for you')
    expect(store.chipFor(sessionOf(25))?.text).toBe('2/5 · 1 for you')
    expect(store.chipFor(sessionOf(25))?.needsYou).toBe(true)
  })

  it('every mission of the repo has a chip, the first ones and the last ones alike', async () => {
    const store = mount(25, [])
    await store.refresh()
    for (let n = 1; n <= 25; n++) expect(store.chipFor(sessionOf(n)), `mission ${n}`).not.toBeNull()
  })

  it('gives each mission past the 20th an Activity row when it owes the operator', async () => {
    const store = mount(25, [3, 22, 25])
    await store.refresh()
    const entry = useNotificationsStore().records.find((r) => r.group === 'mission-cue')
    const ids = (entry?.items ?? []).map((i) => i.id)
    expect(ids).toContain(idOf(3))
    expect(ids).toContain(idOf(22))
    expect(ids).toContain(idOf(25))
  })

  it('leads of a mission past the 20th are listed for the pane chooser', async () => {
    const store = mount(25, [])
    await store.refresh()
    expect(store.ledMissionsFor(sessionOf(24)).map((m) => m.id)).toEqual([idOf(24)])
  })
})
