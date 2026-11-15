// @vitest-environment jsdom
/**
 * Missions v4 · S-17 · AC-42 — the Mission pane is a pane in the helper stack. It follows the selected
 * session and shows only that session's mission; it reads the view channel as chapter 3 built it
 * (reply `{state: mission | none | refused}`, the answered `missionId` sent back and never `detail.id`,
 * no push event so it polls). Mounted against the real stores with `window.api` faked.
 *
 * The "v3 keeps its popover and v4 code never writes it" clause lives in `mission-pill-v4.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import { paneRegistry } from '../src/renderer/src/lib/pane-registry'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

const FOLDER = '/repo'

interface ReplyOver {
  /** The id the view answers (what a later call sends back). */
  missionId: string
  /** `detail.id` — deliberately different: the pane must never send it back. */
  detailId?: string
  title: string
  source?: 'v4' | 'v3-mission' | 'v3-campaign'
  status?: 'open' | 'closed'
  state?: 'open' | 'ready-to-close' | 'closed'
  stateLabel?: string
  progress?: { unit: 'milestones' | 'steps'; total: number; done: number }
  waiting?: number
  /** The sessions the record holds; the pane's own session is listed open unless `detached`. */
  sessionIds?: string[]
  detached?: boolean
}

function mission(over: ReplyOver): MissionV4ViewReply {
  const progress = over.progress ?? { unit: 'steps', total: 21, done: 4 }
  const sessionIds = over.sessionIds ?? []
  return {
    state: 'mission',
    missionId: over.missionId,
    source: over.source ?? 'v4',
    detail: {
      ok: true,
      id: over.detailId ?? over.missionId,
      title: over.title,
      doneWhen: 'Never shown by the pane',
      status: over.status ?? 'open',
      state: over.state ?? 'open',
      stateLabel: over.stateLabel ?? 'Open',
      standing: 'operator',
      leads: null,
      source: over.source ?? 'v4',
      progress: {
        ...progress,
        headline: `${progress.done} of ${progress.total} ${progress.unit} done (server words)`,
        current: null,
        allDone: false,
        counts: { todo: 0, running: 0, waitingReview: 0, done: 0, blocked: 0 }
      },
      milestones: [],
      steps: [],
      next: null,
      waiting: {
        items: Array.from({ length: over.waiting ?? 0 }, (_, i) => ({ id: `w${i}` })),
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
    sessions: sessionIds.map((id) => ({
      id,
      role: 'leads' as const,
      from: '2026-11-14T10:00:00.000Z',
      to: over.detached ? '2026-11-14T11:00:00.000Z' : null,
      stoppedAt: null,
      open: !over.detached
    })),
    handoff: { offer: false }
  } as unknown as MissionV4ViewReply
}

const NONE: MissionV4ViewReply = { state: 'none', missions: [] }

let replies: Record<string, MissionV4ViewReply[]> = {}
let viewCalls: Array<{ folder: string; sessionId: string; missionId?: string }> = []

/** The next reply queued for a session; the last one repeats. */
function answer(args: { sessionId: string }): MissionV4ViewReply {
  const queue = replies[args.sessionId] ?? []
  return queue.length > 1 ? queue.shift()! : (queue[0] ?? NONE)
}

function install(): void {
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    missionV4View: vi.fn(
      async (args: { folder: string; sessionId: string; missionId?: string }) => {
        viewCalls.push({ ...args })
        return answer(args)
      }
    ),
    missionV4Door: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
}

function seed(ids: string[], selected: string): void {
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: ids.map((sessionId) => ({ sessionId, projectPath: FOLDER })) }
  ] as never
  sessions.select(selected)
}

let wrapper: VueWrapper | null = null

async function mountPane(): Promise<VueWrapper> {
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
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
  replies = {}
  viewCalls = []
  install()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('AC-42 — the Mission pane follows the selected session', () => {
  it('the pane follows the selected session', async () => {
    replies = {
      A: [
        mission({
          missionId: 'mnt-a-lookup',
          detailId: 'mnt-a-detail',
          title: 'Measure the spec',
          sessionIds: ['A']
        })
      ],
      B: [mission({ missionId: 'mnt-b', title: 'Make WebGL the default', sessionIds: ['B'] })],
      C: [NONE]
    }
    seed(['A', 'B', 'C'], 'A')
    const w = await mountPane()

    expect(w.text()).toContain('Measure the spec')
    expect(viewCalls[0]).toEqual({ folder: FOLDER, sessionId: 'A' })

    // Another session: only ITS mission shows, and nothing of A's id rides on the call.
    useSessionsStore().select('B')
    await flushPromises()
    expect(w.text()).toContain('Make WebGL the default')
    expect(w.text()).not.toContain('Measure the spec')
    expect(viewCalls.at(-1)).toEqual({ folder: FOLDER, sessionId: 'B' })

    // A session with no mission: the pane shows the no-mission state, never the previous mission.
    useSessionsStore().select('C')
    await flushPromises()
    expect(w.attributes('data-state')).toBe('none')
    expect(w.text()).toContain('This session has no mission.')
    expect(w.text()).not.toContain('Make WebGL the default')

    // Back on A: the id the view ANSWERED goes back, never `detail.id`.
    useSessionsStore().select('A')
    await flushPromises()
    expect(viewCalls.at(-1)).toEqual({ folder: FOLDER, sessionId: 'A', missionId: 'mnt-a-lookup' })
    expect(viewCalls.some((c) => c.missionId === 'mnt-a-detail')).toBe(false)
  })

  it('shows nothing of a mission the session is no longer attached to', async () => {
    replies = {
      A: [
        mission({ missionId: 'mnt-a', title: 'Measure the spec', sessionIds: ['A'] }),
        // The id read back still exists, but the hand-off closed this session's row.
        mission({
          missionId: 'mnt-a',
          title: 'Measure the spec',
          sessionIds: ['A'],
          detached: true
        }),
        NONE
      ]
    }
    seed(['A'], 'A')
    const w = await mountPane()
    expect(w.text()).toContain('Measure the spec')

    await useMissionsRefresh()
    expect(w.text()).not.toContain('Measure the spec')
    expect(w.attributes('data-state')).toBe('none')
    // The stale id was dropped: the follow-up call is the unnamed lookup again.
    expect(viewCalls.at(-1)).toEqual({ folder: FOLDER, sessionId: 'A' })
  })

  it('a mission the operator closed leaves the pane: the session shows the no-mission state', async () => {
    replies = {
      A: [
        mission({ missionId: 'mnt-a', title: 'Measure the spec', sessionIds: ['A'] }),
        mission({
          missionId: 'mnt-a',
          title: 'Measure the spec',
          status: 'closed',
          state: 'closed',
          sessionIds: ['A']
        }),
        NONE
      ]
    }
    seed(['A'], 'A')
    const w = await mountPane()
    await useMissionsRefresh()
    expect(w.attributes('data-state')).toBe('none')
    expect(w.text()).not.toContain('Measure the spec')
  })

  it('polls the view on the 20 second cadence: there is no push event', async () => {
    vi.useFakeTimers()
    replies = { A: [mission({ missionId: 'mnt-a', title: 'Measure the spec', sessionIds: ['A'] })] }
    seed(['A'], 'A')
    await mountPane()
    const before = viewCalls.length
    await vi.advanceTimersByTimeAsync(19_000)
    expect(viewCalls.length).toBe(before)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(viewCalls.length).toBeGreaterThan(before)
  })

  it('never calls a door by being shown: the pane only reads', async () => {
    replies = { A: [mission({ missionId: 'mnt-a', title: 'Measure the spec', sessionIds: ['A'] })] }
    seed(['A'], 'A')
    await mountPane()
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    expect(api.missionV4Door).not.toHaveBeenCalled()
    expect(api.missionOperatorDoor).not.toHaveBeenCalled()
  })
})

describe('the shell reads the server and translates the identifiers it gets', () => {
  it('prints the server’s numbers and the state by its identifier, never the English words', async () => {
    replies = {
      A: [
        mission({
          missionId: 'mnt-a',
          title: 'Measure the spec',
          state: 'ready-to-close',
          stateLabel: 'ZZZ English words',
          progress: { unit: 'milestones', total: 10, done: 10 },
          sessionIds: ['A']
        })
      ]
    }
    seed(['A'], 'A')
    const w = await mountPane()
    expect(w.text()).toContain('10 of 10 milestones done')
    expect(w.text()).toContain('Ready to close')
    expect(w.text()).not.toContain('ZZZ English words')
    expect(w.text()).not.toContain('server words')
  })

  it('a refused reply says it could not be read and names the reason', async () => {
    replies = {
      A: [{ state: 'refused', code: 'UNREADABLE', error: 'UNREADABLE: the file is broken' }]
    }
    seed(['A'], 'A')
    const w = await mountPane()
    expect(w.attributes('data-state')).toBe('refused')
    expect(w.text()).toContain('This mission cannot be read right now.')
    expect(w.text()).toContain('UNREADABLE: the file is broken')
  })

  it('a v3 record is drawn by the pane like any other (the cut-over, S-35)', async () => {
    replies = {
      A: [
        mission({
          missionId: 'mnt-v3',
          title: 'An old mission',
          source: 'v3-mission',
          sessionIds: ['A']
        })
      ]
    }
    seed(['A'], 'A')
    const w = await mountPane()
    expect(w.attributes('data-state')).toBe('mission')
    expect(w.text()).toContain('An old mission')
  })
})

describe('the pane type persists like the other helper panes', () => {
  it('is registered as persistable, one per worktree', () => {
    expect(paneRegistry.mission.persistable).toBe(true)
    const dedup = paneRegistry.mission.dedupKey!
    expect(dedup({ id: 'a', type: 'mission', cwd: FOLDER, ratio: 1 })).toBe(
      dedup({ id: 'b', type: 'mission', cwd: FOLDER, ratio: 1 })
    )
  })

  it('is written to helpers.json with the other panes and opens once', async () => {
    seed(['A'], 'A')
    const helpers = useHelpersStore()
    const id = helpers.addMissionHelper(FOLDER)
    expect(helpers.addMissionHelper(FOLDER)).toBe(id)
    await helpers.flushNow()
    const set = (window.api as unknown as { helpersSet: ReturnType<typeof vi.fn> }).helpersSet
    const written = set.mock.calls.at(-1)![0] as { state: { panes: Array<{ type: string }> } }
    expect(written.state.panes.map((p) => p.type)).toEqual(['mission'])
  })
})

describe('the count line agrees with its number', () => {
  const lineFor = async (
    unit: 'steps' | 'milestones',
    total: number,
    done: number
  ): Promise<string> => {
    replies = {
      A: [
        mission({
          missionId: 'mnt-a',
          title: 'Measure the spec',
          progress: { unit, total, done },
          sessionIds: ['A']
        })
      ]
    }
    seed(['A'], 'A')
    const w = await mountPane()
    return w.get('[data-test="mission-count"]').text()
  }

  it('says "1 step" and "1 milestone", not "1 steps"', async () => {
    expect(await lineFor('steps', 1, 0)).toBe('0 of 1 step done')
  })

  it('keeps the plural for every other number', async () => {
    expect(await lineFor('steps', 21, 4)).toBe('4 of 21 steps done')
  })

  it('agrees in Portuguese too', async () => {
    i18n.global.locale.value = 'pt-BR'
    expect(await lineFor('milestones', 1, 1)).toBe('1 de 1 marco concluído')
  })
})

/** Run the store's refresh once more, as the poll would. */
async function useMissionsRefresh(): Promise<void> {
  const { useMissionsStore } = await import('../src/renderer/src/stores/missions')
  await useMissionsStore().refreshV4()
  await flushPromises()
}
