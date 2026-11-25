/**
 * Mission dropdown · T810 — the time lines under each title and the segmented progress bar
 * (design.md §6 "Mission dropdown" → "The timeline and the time lines"). Pure rules over the view's
 * reply: only timestamps the record already has, and no line when there is none.
 */
import { describe, expect, it } from 'vitest'
import {
  criterionTimes,
  formatAge,
  formatStamp,
  milestoneSegments,
  milestoneTime,
  stepTime,
  timeText
} from '../src/renderer/src/lib/mission-dropdown-tree'
import type { MissionV4Reply } from '../src/renderer/src/lib/mission-pane-view'
import { i18n } from '../src/renderer/src/i18n'

type Detail = MissionV4Reply['detail']
type Step = Detail['steps'][number]

const NOW = Date.parse('2026-11-19T12:00:00Z')

const step = (over: Partial<Step> = {}): Step =>
  ({
    id: 'stp-1',
    title: 't',
    milestone: 'mls-1',
    optional: false,
    state: 'todo',
    blocked: false,
    startedAt: null,
    criteria: [],
    blockers: [],
    links: [],
    ...over
  }) as Step

const criterion = (id: string, settled: boolean): Step['criteria'][number] => ({
  id,
  text: id,
  by: 'session',
  settled,
  via: settled ? 'session' : null
})

const detail = (
  steps: Step[],
  milestones: Array<{ id: string; state: string; optional?: boolean }> = [
    { id: 'mls-1', state: 'in-progress' }
  ],
  current: string | null = 'mls-1'
): Detail =>
  ({
    steps,
    milestones: milestones.map((m) => ({ title: m.id, optional: false, ...m })),
    progress: { current: current === null ? null : { id: current, ordinal: 1 } }
  }) as unknown as Detail

describe('milestone time', () => {
  it('says "Done" with the last settle of its steps', () => {
    const d = detail(
      [
        step({ id: 'stp-1', criteria: [criterion('ac-1', true)] }),
        step({ id: 'stp-2', criteria: [criterion('ac-1', true)] })
      ],
      [{ id: 'mls-1', state: 'done' }]
    )
    const settled = {
      'stp-1': { 'ac-1': '2026-11-12T10:00:00Z' },
      'stp-2': { 'ac-1': '2026-11-13T09:00:00Z' }
    }
    expect(milestoneTime(d, 'mls-1', settled, NOW)).toEqual({
      kind: 'done',
      at: '2026-11-13T09:00:00Z'
    })
  })

  it('says nothing for a done milestone whose record holds no settle time', () => {
    const d = detail(
      [step({ criteria: [criterion('ac-1', true)] })],
      [{ id: 'mls-1', state: 'done' }]
    )
    expect(milestoneTime(d, 'mls-1', {}, NOW)).toBeNull()
  })

  it('says "Started" from the first step that started, with its age', () => {
    const d = detail([
      step({ id: 'stp-1', startedAt: '2026-11-15T12:00:00Z' }),
      step({ id: 'stp-2', startedAt: '2026-11-13T12:00:00Z' })
    ])
    expect(milestoneTime(d, 'mls-1', {}, NOW)).toEqual({
      kind: 'started',
      at: '2026-11-13T12:00:00Z',
      ageMs: 6 * 86_400_000
    })
  })

  it('says nothing for a started milestone with no startedAt, and "Not started" for one not started', () => {
    expect(milestoneTime(detail([step()]), 'mls-1', {}, NOW)).toBeNull()
    expect(
      milestoneTime(detail([step()], [{ id: 'mls-1', state: 'not-started' }]), 'mls-1', {}, NOW)
    ).toEqual({ kind: 'notStarted' })
  })
})

describe('step time', () => {
  it('counts how long a running step has run', () => {
    expect(stepTime(step({ state: 'running', startedAt: '2026-11-19T10:50:00Z' }), NOW)).toEqual({
      kind: 'running',
      ageMs: 70 * 60_000
    })
  })

  it('a blocked step reads its oldest blocker, over "running"', () => {
    const s = step({
      state: 'running',
      blocked: true,
      startedAt: '2026-11-18T00:00:00Z',
      blockers: [
        { id: 'b2', reason: 'r', owner: 'agent', raisedAt: '2026-11-19T11:50:00Z' },
        { id: 'b1', reason: 'r', owner: 'operator', raisedAt: '2026-11-19T11:20:00Z' }
      ]
    })
    expect(stepTime(s, NOW)).toEqual({
      kind: 'blocked',
      at: '2026-11-19T11:20:00Z',
      ageMs: 40 * 60_000
    })
  })

  it('says nothing without a timestamp, and nothing for review, to do and done steps', () => {
    expect(stepTime(step({ state: 'running' }), NOW)).toBeNull()
    expect(
      stepTime(step({ blocked: true, blockers: [{ id: 'b', reason: 'r', owner: 'agent' }] }), NOW)
    ).toBeNull()
    for (const state of ['waiting-review', 'todo', 'done']) {
      expect(stepTime(step({ state, startedAt: '2026-11-18T00:00:00Z' }), NOW), state).toBeNull()
    }
  })
})

describe('criterion times', () => {
  it('dates the open ones from the step start and the folded line from the latest settle', () => {
    const s = step({
      startedAt: '2026-11-18T14:02:00Z',
      criteria: [criterion('ac-1', true), criterion('ac-2', true), criterion('ac-3', false)]
    })
    const settled = {
      'stp-1': { 'ac-1': '2026-11-18T15:20:00Z', 'ac-2': '2026-11-18T14:30:00Z' }
    }
    expect(criterionTimes(s, settled)).toEqual({
      openSince: { kind: 'openSince', at: '2026-11-18T14:02:00Z' },
      lastVerified: { kind: 'lastVerified', at: '2026-11-18T15:20:00Z' }
    })
  })

  it('says nothing without timestamps', () => {
    expect(criterionTimes(step({ criteria: [criterion('ac-1', true)] }), {})).toEqual({
      openSince: null,
      lastVerified: null
    })
  })
})

describe('progress segments', () => {
  it('is one per required milestone: done, current, or not started', () => {
    const d = detail(
      [],
      [
        { id: 'mls-1', state: 'done' },
        { id: 'mls-2', state: 'in-progress' },
        { id: 'mls-3', state: 'not-started' },
        { id: 'mls-4', state: 'in-progress' },
        { id: 'mls-5', state: 'done', optional: true }
      ],
      'mls-2'
    )
    expect(milestoneSegments(d)).toEqual([
      { id: 'mls-1', state: 'done' },
      { id: 'mls-2', state: 'current' },
      { id: 'mls-3', state: 'todo' },
      { id: 'mls-4', state: 'todo' }
    ])
  })

  it('is empty for a mission with no milestones', () => {
    expect(milestoneSegments(detail([], [], null))).toEqual([])
  })
})

describe('wording', () => {
  const t = (key: string, values?: Record<string, unknown>, plural?: number): string =>
    plural === undefined
      ? i18n.global.t(key, values ?? {})
      : i18n.global.t(key, values ?? {}, { plural })

  it('words an age', () => {
    expect(formatAge(t, 20_000)).toBe('<1 min')
    expect(formatAge(t, 25 * 60_000)).toBe('25 min')
    expect(formatAge(t, 60 * 60_000)).toBe('1 h')
    expect(formatAge(t, 70 * 60_000)).toBe('1 h 10 min')
    expect(formatAge(t, 86_400_000)).toBe('1 day')
    expect(formatAge(t, 6 * 86_400_000 + 3600_000)).toBe('6 days')
  })

  it('words a date as day, month and 24h time in the reader’s locale', () => {
    // No zone in the input: read and printed in the machine's own, so the test holds anywhere.
    expect(formatStamp('2026-11-12T16:40:00', 'en')).toBe('12 Nov, 16:40')
    expect(formatStamp('not a date', 'en')).toBeNull()
  })

  it('writes each line, and none for an unreadable date', () => {
    const at = '2026-11-12T16:40:00'
    expect(timeText(t, 'en', { kind: 'done', at })).toBe('Done · 12 Nov, 16:40')
    expect(timeText(t, 'en', { kind: 'started', at, ageMs: 6 * 86_400_000 })).toBe(
      'Started 12 Nov, 16:40 · 6 days'
    )
    expect(timeText(t, 'en', { kind: 'notStarted' })).toBe('Not started')
    expect(timeText(t, 'en', { kind: 'running', ageMs: 25 * 60_000 })).toBe('Running for 25 min')
    expect(timeText(t, 'en', { kind: 'blocked', at, ageMs: 40 * 60_000 })).toBe(
      'Blocked for 40 min · since 12 Nov, 16:40'
    )
    expect(timeText(t, 'en', { kind: 'openSince', at })).toBe('Open since 12 Nov, 16:40')
    expect(timeText(t, 'en', { kind: 'lastVerified', at })).toBe('Last one verified 12 Nov, 16:40')
    expect(timeText(t, 'en', { kind: 'done', at: 'nope' })).toBeNull()
    expect(timeText(t, 'en', null)).toBeNull()
  })
})
