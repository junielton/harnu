import { describe, it, expect } from 'vitest'
import {
  formatCountdown,
  formatCost,
  formatDuration,
  workerState
} from '../src/renderer/src/components/scheduler-format'
import type { Worker } from '../src/main/scheduler-core'

const W = {
  id: 'w1',
  name: 'w',
  enabled: true,
  prompt: 'p',
  folder: '/repo',
  everyMinutes: 5,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 300,
  carryLastResult: false,
  failureStreak: 0
} as Worker

describe('workerState — the five states the mockup draws', () => {
  it('running wins over everything', () => {
    expect(workerState(W, { running: true, nextAt: 0, lastStatus: 'error' })).toBe('running')
  })
  it('a disabled worker with a streak reads as disabled, not off', () => {
    expect(workerState({ ...W, enabled: false, failureStreak: 3 }, { running: false })).toBe(
      'disabled'
    )
  })
  it('a worker the operator switched off reads as off', () => {
    expect(workerState({ ...W, enabled: false }, { running: false })).toBe('off')
  })
  it('a failing but still-armed worker reads as failed', () => {
    expect(workerState({ ...W, failureStreak: 2 }, { running: false, lastStatus: 'error' })).toBe(
      'failed'
    )
  })
  it('otherwise it is waiting', () => {
    expect(workerState(W, { running: false, lastStatus: 'ok' })).toBe('waiting')
  })
})

describe('formatCountdown', () => {
  it('reads in minutes under an hour', () => {
    expect(formatCountdown(4 * 60_000)).toBe('4m')
  })
  it('reads in hours past one', () => {
    expect(formatCountdown(7 * 3_600_000)).toBe('7h')
  })
  it('shows "now" rather than a negative', () => {
    expect(formatCountdown(-5000)).toBe('now')
  })
  it('shows seconds under a minute so a 30s cadence is legible', () => {
    expect(formatCountdown(21_000)).toBe('21s')
  })
})

describe('formatCost / formatDuration', () => {
  it('costs read to three decimals, the scale a single tick lives at', () => {
    expect(formatCost(0.0213)).toBe('$0.021')
  })
  it('an unknown cost is an em-dash, never a false $0.000', () => {
    expect(formatCost(undefined)).toBe('—')
  })
  it('durations read as seconds, then minutes and seconds', () => {
    expect(formatDuration(18_000)).toBe('18s')
    expect(formatDuration(300_000)).toBe('5m 0s')
  })
})
