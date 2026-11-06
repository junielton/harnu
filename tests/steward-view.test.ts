/**
 * Campaign ch.5b (T609, AC-5b.1) — the pure view of a mission's steward for the Scheduler's Stewards
 * section and the mission popover's steward line: split system workers from user workers, read the last
 * wake and last action off the runs, never invent a number.
 */
import { describe, it, expect } from 'vitest'
import {
  firstLine,
  splitWorkers,
  stewardForMission,
  summarizeSteward
} from '../src/renderer/src/lib/steward-view'
import type { Run, Worker } from '../src/preload'

const worker = (over: Partial<Worker> = {}): Worker =>
  ({
    id: 'w1',
    name: 'Steward · Ship it',
    enabled: true,
    prompt: 'p',
    folder: '/repo',
    everyMinutes: 20,
    runOnBoot: false,
    model: 'sonnet',
    effort: 'low',
    mode: 'steward',
    category: 'steward',
    missionId: 'mnt-0000000a',
    timeoutSeconds: 600,
    carryLastResult: false,
    notifyOn: 'silent',
    allowNetwork: false,
    failureStreak: 0,
    ...over
  }) as Worker

const run = (startedAt: number, result: string, over: Partial<Run> = {}): Run => ({
  workerId: 'w1',
  startedAt,
  endedAt: startedAt + 1000,
  durationMs: 1000,
  status: 'ok',
  result,
  terminalReason: 'completed',
  numTurns: 1,
  costUsd: 0,
  tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  ...over
})

describe('splitWorkers', () => {
  it('puts category steward apart from user workers, whatever its mode or folder', () => {
    const user = worker({ id: 'u1', category: undefined, mode: 'observe', missionId: undefined })
    const s = worker({ id: 's1' })
    const { users, stewards } = splitWorkers([user, s])
    expect(users.map((w) => w.id)).toEqual(['u1'])
    expect(stewards.map((w) => w.id)).toEqual(['s1'])
  })

  it('a steward without a mission binding is not listed as one', () => {
    const odd = worker({ id: 'x', missionId: undefined })
    expect(splitWorkers([odd]).stewards).toEqual([])
  })
})

describe('summarizeSteward', () => {
  it('reads the last wake and the last action off the newest run', () => {
    const s = summarizeSteward(
      worker(),
      [run(1_000, 'old'), run(5_000, '\n\nRebased #317 onto main.\nmore detail')],
      false
    )
    expect(s).toMatchObject({
      workerId: 'w1',
      missionId: 'mnt-0000000a',
      lastWakeAt: 5_000,
      lastAction: 'Rebased #317 onto main.',
      running: false
    })
  })

  it('no run yet: no wake and no action, never a made-up number', () => {
    expect(summarizeSteward(worker(), [], false)).toMatchObject({
      lastWakeAt: null,
      lastAction: null
    })
  })

  it('a failed or empty run has no action to show', () => {
    expect(
      summarizeSteward(worker(), [run(1, '', { status: 'error' })], false).lastAction
    ).toBeNull()
  })

  it('carries the running flag', () => {
    expect(summarizeSteward(worker(), [], true).running).toBe(true)
  })
})

describe('firstLine', () => {
  it('takes the first non-empty line and truncates with an ellipsis', () => {
    expect(firstLine('  \n  hello  \nworld')).toBe('hello')
    expect(firstLine('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`)
    expect(firstLine('')).toBeNull()
  })
})

describe('stewardForMission', () => {
  it('finds the steward bound to a mission, or undefined', () => {
    const a = worker({ id: 'a', missionId: 'mnt-00000001' })
    const b = worker({ id: 'b', missionId: 'mnt-00000002' })
    expect(stewardForMission([a, b], 'mnt-00000002')?.id).toBe('b')
    expect(stewardForMission([a, b], 'mnt-00000003')).toBeUndefined()
  })
})
