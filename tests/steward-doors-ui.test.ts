// @vitest-environment jsdom
/**
 * Campaign ch.5b (T609, AC-5b.2 / AC-5b.3) — the operator's two steward doors in the UI:
 *  - the Pause steward dialog: a MANDATORY reason (confirm disabled while blank) → the pause door;
 *  - the Merge batch dialog: lists the PRs in order, runs the door, and on a STOP shows why and asks
 *    again for the rest instead of merging on.
 * Plus the popover wiring: the steward line (Pause… / Resume), the paused You row's Resume, and the
 * merge-batch row's action.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import StewardPauseDialog from '../src/renderer/src/components/StewardPauseDialog.vue'
import MergeBatchDialog from '../src/renderer/src/components/MergeBatchDialog.vue'
import MissionPopover from '../src/renderer/src/components/MissionPopover.vue'
import { useSchedulerStore } from '../src/renderer/src/stores/scheduler'
import { buildMissionModel } from '../src/renderer/src/lib/mission-view'
import type { MergeBatchResult } from '../src/main/merge-batch-ipc'
import type { Worker } from '../src/preload'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

const calls = {
  door: [] as unknown[],
  batch: [] as unknown[]
}
let batchAnswers: MergeBatchResult[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  calls.door.length = 0
  calls.batch.length = 0
  batchAnswers = []
  ;(window as unknown as { api: unknown }).api = {
    missionList: async () => ({ views: [], unreadable: [], shadowed: [] }),
    campaignList: async () => ({ views: [], unreadable: [] }),
    missionOperatorDoor: async (d: unknown) => {
      calls.door.push(d)
      return { ok: true, view: null }
    },
    missionMergeBatch: async (a: unknown) => {
      calls.batch.push(a)
      return (
        batchAnswers.shift() ?? {
          ok: true,
          outcome: { merged: [], remaining: [], stop: null, steward: [] }
        }
      )
    },
    schedulerList: async () => [],
    onSchedulerChanged: () => () => {},
    schedulerRuns: async () => [],
    requestAttention: () => {}
  }
})

const READY = { pr: 'running', ci: 'green', main: 'off', verifier: 'off', checks: 'na' } as const
const mergeView = () =>
  fixtureView('faq-like', {
    derivedStep: {
      'stp-5': { prNumber: 305, gates: READY },
      'stp-6': { prNumber: 306, gates: READY },
      'stp-7': { prNumber: 308, gates: READY }
    }
  })

/** Type into a teleported field the way a user does: set the value, fire `input`, let Vue re-render. */
async function typeInto(sel: string, value: string): Promise<void> {
  const el = document.querySelector<HTMLTextAreaElement>(sel)!
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

describe('StewardPauseDialog — a mandatory reason', () => {
  const open = () =>
    mount(StewardPauseDialog, {
      props: { busy: false },
      global: { plugins: [i18n] },
      attachTo: document.body
    })

  it('the Pause button is disabled while the reason is blank, and enabled once there is one', async () => {
    const w = open()
    const go = () => document.querySelector<HTMLButtonElement>('[data-test="steward-pause-go"]')!
    expect(go().disabled).toBe(true)
    await typeInto('[data-test="steward-pause-reason"]', '   ')
    expect(go().disabled).toBe(true)
    await typeInto('[data-test="steward-pause-reason"]', 'CI is flaky today')
    expect(go().disabled).toBe(false)
    w.unmount()
  })

  it('confirm emits the trimmed reason; Cancel emits cancel and no reason', async () => {
    const w = open()
    await typeInto('[data-test="steward-pause-reason"]', '  CI is flaky today  ')
    document.querySelector<HTMLButtonElement>('[data-test="steward-pause-go"]')!.click()
    expect(w.emitted('confirm')?.[0]).toEqual(['CI is flaky today'])
    document.querySelector<HTMLButtonElement>('[data-test="steward-pause-cancel"]')!.click()
    expect(w.emitted('cancel')).toHaveLength(1)
    w.unmount()
  })
})

describe('MergeBatchDialog — in order, stop on red, ask again', () => {
  const prs = [
    { number: 305, stepId: 'stp-5', title: 'Partners' },
    { number: 306, stepId: 'stp-6', title: 'images' },
    { number: 308, stepId: 'stp-7', title: 'fixes' }
  ]
  const open = () =>
    mount(MergeBatchDialog, {
      props: { root: '/repo', missionId: 'mnt-0000000a', prs },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
  const q = (sel: string) => document.querySelector<HTMLElement>(sel)

  it('lists the PRs in order with the between-merges chips, and the confirm names the count', () => {
    const w = open()
    expect(q('[data-test="merge-batch-title"]')!.textContent).toContain('Merge 3 PRs in order')
    expect(
      [...document.querySelectorAll('[data-test="merge-batch-pr"]')].map((e) =>
        e.getAttribute('data-pr')
      )
    ).toEqual(['305', '306', '308'])
    const between = [...document.querySelectorAll('[data-test="merge-batch-between"]')]
    expect(between).toHaveLength(2)
    expect(between[0].textContent).toContain('rebase --onto #306')
    expect(between[0].textContent).toContain('re-check gates')
    expect(between[0].textContent).toContain('stop on red')
    expect(q('[data-test="merge-batch-go"]')!.textContent).toContain('Merge 3 in order')
    w.unmount()
  })

  it('confirm runs the door with the PRs in the confirmed order; a clean run closes the dialog', async () => {
    const w = open()
    batchAnswers = [
      {
        ok: true,
        outcome: { merged: [305, 306, 308], remaining: [], stop: null, steward: ['ran', 'ran'] }
      }
    ]
    q('[data-test="merge-batch-go"]')!.click()
    await flushPromises()
    expect(calls.batch).toEqual([
      { root: '/repo', missionId: 'mnt-0000000a', prs: [305, 306, 308] }
    ])
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('Cancel merges nothing', async () => {
    const w = open()
    q('[data-test="merge-batch-cancel"]')!.click()
    expect(calls.batch).toEqual([])
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('a stop shows why and what is left, does not close, and asks again for the rest', async () => {
    const w = open()
    batchAnswers = [
      {
        ok: true,
        outcome: {
          merged: [305],
          remaining: [306, 308],
          stop: { at: 306, reason: 'red', detail: '#306 has failing checks after #305 merged.' },
          steward: ['ran']
        }
      },
      { ok: true, outcome: { merged: [306, 308], remaining: [], stop: null, steward: ['ran'] } }
    ]
    q('[data-test="merge-batch-go"]')!.click()
    await flushPromises()
    expect(w.emitted('close')).toBeUndefined()
    const stop = q('[data-test="merge-batch-stop"]')!
    expect(stop.textContent).toContain('Stopped at #306')
    expect(stop.textContent).toContain('#306 has failing checks.')
    expect(stop.textContent).toContain('Merged: #305')
    expect(stop.textContent).toContain('Still to merge: #306 → #308')
    // Nothing was merged on its own: still exactly one door call.
    expect(calls.batch).toHaveLength(1)
    expect(q('[data-test="merge-batch-go"]')!.textContent).toContain('Merge the rest')
    q('[data-test="merge-batch-go"]')!.click()
    await flushPromises()
    expect(calls.batch[1]).toEqual({ root: '/repo', missionId: 'mnt-0000000a', prs: [306, 308] })
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('a refusal (not ok) keeps the dialog open, with the confirm available again', async () => {
    const w = open()
    batchAnswers = [{ ok: false, error: 'NOT_A_MISSION_PR: #999' }]
    q('[data-test="merge-batch-go"]')!.click()
    await flushPromises()
    expect(w.emitted('close')).toBeUndefined()
    expect((q('[data-test="merge-batch-go"]') as HTMLButtonElement).disabled).toBe(false)
    w.unmount()
  })
})

describe('MissionPopover — the steward line and the doors', () => {
  const stewardWorker = (): Worker =>
    ({
      id: 'w1',
      name: 'Steward · x',
      enabled: true,
      prompt: '',
      folder: '/repo',
      everyMinutes: 20,
      runOnBoot: false,
      model: 'sonnet',
      effort: 'low',
      mode: 'steward',
      category: 'steward',
      missionId: 'MID',
      timeoutSeconds: 600,
      carryLastResult: false,
      notifyOn: 'silent',
      allowNetwork: false,
      failureStreak: 0
    }) as Worker

  async function popover(view = fixtureView('faq-like'), withSteward = true) {
    const sched = useSchedulerStore()
    if (withSteward) sched.workers = [{ ...stewardWorker(), missionId: view.mission.id }]
    sched.runsByWorker = withSteward
      ? {
          w1: [
            {
              workerId: 'w1',
              startedAt: FIXTURE_NOW - 4 * 60_000,
              endedAt: FIXTURE_NOW - 3 * 60_000,
              durationMs: 1,
              status: 'ok',
              result: 'Rebased #317 onto main.',
              terminalReason: '',
              numTurns: 1,
              costUsd: 0,
              tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
              denials: []
            }
          ]
        }
      : {}
    sched.loaded = true
    const w = mount(MissionPopover, {
      props: { view, model: buildMissionModel(view, FIXTURE_NOW) },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await flushPromises()
    return w
  }

  it('shows the steward line with its last action, and "Pause steward…" opens the reason dialog', async () => {
    const w = await popover()
    expect(w.get('[data-test="mission-steward"]').text()).toContain('Rebased #317 onto main.')
    await w.get('[data-test="mission-steward-pause"]').trigger('click')
    expect(document.querySelector('[data-test="steward-pause-reason"]')).not.toBeNull()
    expect(calls.door).toEqual([]) // opening the dialog pauses nothing
    w.unmount()
  })

  it('confirming the dialog fires the pauseSteward door with the reason', async () => {
    const view = fixtureView('faq-like')
    const w = await popover(view)
    await w.get('[data-test="mission-steward-pause"]').trigger('click')
    await typeInto('[data-test="steward-pause-reason"]', 'CI is flaky today')
    document.querySelector<HTMLButtonElement>('[data-test="steward-pause-go"]')!.click()
    await flushPromises()
    expect(calls.door).toEqual([
      {
        door: 'pauseSteward',
        reason: 'CI is flaky today',
        root: view.root,
        missionId: view.mission.id
      }
    ])
    w.unmount()
  })

  it('no steward, no line', async () => {
    const w = await popover(fixtureView('faq-like'), false)
    expect(w.find('[data-test="mission-steward"]').exists()).toBe(false)
    w.unmount()
  })

  it('paused: the You row reads "Steward paused {age}: {reason}" with a Resume door that fires resumeSteward', async () => {
    const at = new Date(FIXTURE_NOW - 2 * 3_600_000).toISOString()
    const view = fixtureView('faq-like', {
      mission: { stewardPause: { at, reason: 'CI is flaky today' } },
      view: { you: [{ kind: 'steward-paused', reason: 'CI is flaky today', at }] }
    })
    const w = await popover(view)
    expect(w.get('[data-test="mission-you-first"]').text()).toBe(
      'Steward paused 2h 0m: CI is flaky today'
    )
    await w.get('[data-test="mission-resume-steward"]').trigger('click')
    await flushPromises()
    expect(calls.door).toEqual([
      { door: 'resumeSteward', root: view.root, missionId: view.mission.id }
    ])
    // The steward line offers Resume, not Pause, while paused.
    expect(w.find('[data-test="mission-steward-pause"]').exists()).toBe(false)
    w.unmount()
  })

  it('the open Merge batch dialog keeps its PRs when the refresh makes the merge row disappear (the "Stopped at…" panel survives)', async () => {
    const view = mergeView()
    const w = await popover(view)
    await w.get('[data-test="mission-merge-batch"]').trigger('click')
    batchAnswers = [
      {
        ok: true,
        outcome: {
          merged: [305],
          remaining: [306, 308],
          stop: { at: 306, reason: 'red', detail: '#306 has failing checks after #305 merged.' },
          steward: ['ran']
        }
      }
    ]
    document.querySelector<HTMLButtonElement>('[data-test="merge-batch-go"]')!.click()
    await flushPromises()
    expect(document.querySelector('[data-test="merge-batch-stop"]')).not.toBeNull()
    // The store's refresh lands: #305 merged, so the view no longer lists three ready PRs.
    const after = fixtureView('faq-like')
    await w.setProps({ view: after, model: buildMissionModel(after, FIXTURE_NOW) })
    await flushPromises()
    expect(document.querySelector('[data-test="merge-batch-dialog"]')).not.toBeNull()
    const stop = document.querySelector('[data-test="merge-batch-stop"]')!
    expect(stop.textContent).toContain('Stopped at #306')
    expect(stop.textContent).toContain('Still to merge: #306 → #308')
    expect(
      [...document.querySelectorAll('[data-test="merge-batch-pr"]')].map((e) =>
        e.getAttribute('data-pr')
      )
    ).toEqual(['305', '306', '308'])
    w.unmount()
  })

  it('a merge-batch You row carries "Merge 3 in order…", which opens the dialog (merging nothing yet)', async () => {
    const w = await popover(mergeView())
    expect(w.text()).toContain('3 PRs ready to merge in order: #305 → #306 → #308')
    await w.get('[data-test="mission-merge-batch"]').trigger('click')
    expect(document.querySelector('[data-test="merge-batch-title"]')).not.toBeNull()
    expect(calls.batch).toEqual([])
    w.unmount()
  })
})

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: () => {} }))
