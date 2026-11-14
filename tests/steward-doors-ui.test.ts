// @vitest-environment jsdom
/**
 * Campaign ch.5b (T609, AC-5b.2) — the operator's steward door in the UI:
 *  - the Pause steward dialog: a MANDATORY reason (confirm disabled while blank) → the pause door.
 * Plus the popover wiring: the steward line (Pause… / Resume) and the paused You row's Resume.
 * T701: open green PRs add no merge row, button or dialog.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import StewardPauseDialog from '../src/renderer/src/components/StewardPauseDialog.vue'
import MissionPopover from '../src/renderer/src/components/MissionPopover.vue'
import { useSchedulerStore } from '../src/renderer/src/stores/scheduler'
import { buildMissionModel } from '../src/renderer/src/lib/mission-view'
import type { Worker } from '../src/preload'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

const calls = {
  door: [] as unknown[]
}

beforeEach(() => {
  setActivePinia(createPinia())
  calls.door.length = 0
  ;(window as unknown as { api: unknown }).api = {
    missionList: async () => ({ views: [], unreadable: [], shadowed: [] }),
    campaignList: async () => ({ views: [], unreadable: [] }),
    missionOperatorDoor: async (d: unknown) => {
      calls.door.push(d)
      return { ok: true, view: null }
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

  it('open green PRs add no merge row, button or dialog to the popover (T701)', async () => {
    const w = await popover(mergeView())
    expect(w.text()).toContain('Nothing — you’re clear.')
    expect(w.text()).not.toMatch(/in order|ready to merge/i)
    w.unmount()
  })
})

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: () => {} }))
