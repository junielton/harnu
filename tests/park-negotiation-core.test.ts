import { describe, expect, test } from 'vitest'
import {
  DEFAULT_NEGOTIATION as S,
  NEG_RETRY_DEFAULT_MS,
  NEG_RETRY_MAX_MS,
  NEG_RETRY_MIN_MS,
  applyAnswer,
  decide,
  resetEpisode,
  revalidate,
  type Answer,
  type Episode,
  type NegotiationSettings,
  type ParkSnapshot,
  type ResetEdge
} from '../src/main/park-negotiation-core'

const MIN = 60_000
const H = 60 * MIN
const busy = (retryAfterMs?: number): Answer => ({
  kind: 'busy',
  reasons: ['background-task'],
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
})

/**
 * Drives the core the way the coordinator would: the sweep every 60 s over a session that is a
 * candidate whenever `eligible(t)` says so, answered by `answer(t)`, with `edges(t)` as the reset
 * edges seen at minute t. Returns when it was parked and how many questions it took.
 */
function drive(opts: {
  settings?: NegotiationSettings
  answer: (t: number) => Answer
  eligible?: (t: number) => boolean
  edges?: (t: number) => ResetEdge[]
  memAvailableMb?: number | null
  hours?: number
}) {
  const s = opts.settings ?? S
  let ep: Episode | null = null
  let questions = 0
  let firstDeclineAt: number | null = null
  for (let t = 0; t <= (opts.hours ?? 12) * H; t += MIN) {
    for (const e of opts.edges?.(t) ?? []) ep = resetEpisode(ep, e)
    if (opts.eligible && !opts.eligible(t)) continue
    const d = decide({
      now: t,
      cause: 'sweep',
      episode: ep,
      settings: s,
      memAvailableMb: opts.memAvailableMb ?? null
    })
    if (d.action === 'park') return { parkedAt: t, why: d.why, questions, firstDeclineAt }
    if (d.action === 'ask') {
      questions++
      ep = applyAnswer(ep, opts.answer(t), [], t, s)
      if (ep === null) return { parkedAt: t, why: 'free', questions, firstDeclineAt }
      firstDeclineAt ??= ep.firstDeclineAt
    }
  }
  return { parkedAt: null, why: null, questions, firstDeclineAt }
}

describe('the bound: a mod that never stops saying busy is parked anyway', () => {
  test('after maxDeclines questions when it asks to be asked again soon', () => {
    const r = drive({ answer: () => busy(1) })
    expect(r).toMatchObject({ why: 'limit', questions: S.maxDeclines })
    expect(r.parkedAt).toBe(S.maxDeclines * NEG_RETRY_MIN_MS)
  })

  test('after maxDeferMs when declines alone would never run out', () => {
    const r = drive({ settings: { ...S, maxDeclines: 1_000 }, answer: () => busy(H) })
    expect(r.why).toBe('limit')
    expect(r.parkedAt).toBe(S.maxDeferMs)
  })

  test('the hold past the first decline never exceeds maxDeferMs, whatever the hint', () => {
    for (const hint of [undefined, 1, 59_000, 10 * MIN, 29 * MIN, H, 10 * H]) {
      const r = drive({ settings: { ...S, maxDeclines: 1_000 }, answer: () => busy(hint) })
      expect(r.parkedAt).not.toBeNull()
      expect((r.parkedAt ?? 0) - (r.firstDeclineAt ?? 0)).toBeLessThanOrEqual(S.maxDeferMs)
    }
  })

  test('memory under the floor parks at once and asks nothing', () => {
    const r = drive({ answer: () => busy(), memAvailableMb: S.pressureFloorMb - 1 })
    expect(r).toMatchObject({ parkedAt: 0, why: 'memory-pressure', questions: 0 })
  })

  test('memory at the floor is not pressure', () => {
    const r = drive({ answer: () => busy(), memAvailableMb: S.pressureFloorMb })
    expect(r.why).toBe('limit')
  })

  test('memory pressure overrides an episode inside its granted delay', () => {
    const ep = applyAnswer(null, busy(NEG_RETRY_MAX_MS), [], 0, S)
    const d = decide({ now: MIN, cause: 'sweep', episode: ep, settings: S, memAvailableMb: 1 })
    expect(d).toEqual({ action: 'park', why: 'memory-pressure' })
  })
})

describe('decide', () => {
  test('Park now parks without a question', () => {
    const ep = applyAnswer(null, busy(), [], 0, S)
    expect(
      decide({ now: 0, cause: 'manual', episode: ep, settings: S, memAvailableMb: null })
    ).toEqual({ action: 'park', why: 'operator' })
  })

  test('the switch off is today’s behaviour', () => {
    const off = { ...S, enabled: false }
    expect(
      decide({ now: 0, cause: 'sweep', episode: null, settings: off, memAvailableMb: null })
    ).toEqual({ action: 'park', why: 'disabled' })
  })

  test('inside a granted delay there is no question and no park', () => {
    const ep = applyAnswer(null, busy(), [], 0, S)
    expect(
      decide({ now: MIN, cause: 'sweep', episode: ep, settings: S, memAvailableMb: null })
    ).toEqual({ action: 'defer', why: 'deferred' })
  })
})

describe('applyAnswer', () => {
  test('free and silent-with-no-facts both park', () => {
    expect(applyAnswer(null, { kind: 'free' }, [], 0, S)).toBeNull()
    expect(applyAnswer(null, { kind: 'silent' }, [], 0, S)).toBeNull()
  })

  test('silent falls back to the legacy Stop facts', () => {
    expect(applyAnswer(null, { kind: 'silent' }, ['scheduled-wakeup'], 0, S)).toMatchObject({
      declines: 1,
      until: NEG_RETRY_DEFAULT_MS,
      reasons: ['scheduled-wakeup']
    })
  })

  test('a granted delay never ends past the episode ceiling (the tooltip reads `until`)', () => {
    const late = applyAnswer(null, busy(), [], 0, S) as Episode
    const next = applyAnswer(late, busy(NEG_RETRY_MAX_MS), [], S.maxDeferMs - MIN, S)
    expect(next?.until).toBe(S.maxDeferMs)
  })

  test('a hint is clamped to [NEG_RETRY_MIN_MS, NEG_RETRY_MAX_MS]', () => {
    expect(applyAnswer(null, busy(1), [], 0, S)?.until).toBe(NEG_RETRY_MIN_MS)
    expect(applyAnswer(null, busy(10 * H), [], 0, S)?.until).toBe(NEG_RETRY_MAX_MS)
    expect(applyAnswer(null, busy(), [], 0, S)?.until).toBe(NEG_RETRY_DEFAULT_MS)
  })
})

describe('the episode reset', () => {
  const ep = applyAnswer(null, busy(), [], 0, S)

  test('the operator selecting the session ends it', () => {
    expect(resetEpisode(ep, { kind: 'focus' })).toBeNull()
  })

  test('a prompt typed by a person ends it', () => {
    expect(resetEpisode(ep, { kind: 'prompt', source: 'user' })).toBeNull()
  })

  test('a wakeup, a notification or an unlabelled prompt does not', () => {
    for (const source of ['schedule_wakeup', 'loop_wakeup', 'system', 'sdk', undefined] as const) {
      expect(resetEpisode(ep, { kind: 'prompt', source })).toBe(ep)
    }
  })

  // A recurring cron: each fire runs a turn (2 min of work), then the session is cold again and,
  // under `cap` pressure, a candidate after `lruIdleMs` (15 min). It answers busy (a scheduled
  // wakeup) every time it is asked. `source` is what the legacy `UserPromptSubmit` of each fire says.
  const cron = (source: 'schedule_wakeup' | 'user', everyMin: number) => {
    const every = everyMin * MIN
    const lastFire = (t: number) => Math.floor(t / every) * every
    return drive({
      answer: () => busy(),
      eligible: (t) => t - (lastFire(t) + 2 * MIN) > 15 * MIN,
      edges: (t) => (t > 0 && t % every === 0 ? [{ kind: 'prompt', source }] : []),
      hours: 12
    })
  }

  test.each([60, 90, 150])(
    'a recurring cron every %i min cannot renew the hold under cap pressure',
    (everyMin) => {
      const r = cron('schedule_wakeup', everyMin)
      expect(r.why).toBe('limit')
      expect((r.parkedAt ?? Infinity) - (r.firstDeclineAt ?? 0)).toBeLessThanOrEqual(S.maxDeferMs)
    }
  )

  test('a person typing every hour keeps the same session live', () => {
    expect(cron('user', 60).parkedAt).toBeNull()
  })
})

describe('revalidate, right before the kill', () => {
  const t0 = 1_000 * MIN
  const before: ParkSnapshot = {
    ptyId: 'p1',
    isSelected: false,
    lastFocusedAt: t0 - H,
    lastActivityAt: t0 - H,
    lastPromptAt: t0 - H
  }

  test('nothing happened in the gap: park', () => {
    expect(revalidate('sweep', t0, before, { ...before })).toEqual({ ok: true })
  })

  test.each([
    ['prompted', { lastPromptAt: t0 + 1_000 }],
    ['selected', { isSelected: true }],
    ['focused', { lastFocusedAt: t0 + 1_000 }],
    ['active', { lastActivityAt: t0 + 1_000 }],
    ['respawned', { ptyId: 'p2' }]
  ] as const)('%s in the gap cancels a sweep park', (why, change) => {
    expect(revalidate('sweep', t0, before, { ...before, ...change })).toEqual({ ok: false, why })
  })

  test('a session already gone is not killed twice', () => {
    expect(revalidate('cap', t0, before, null)).toEqual({ ok: false, why: 'gone' })
  })

  test('Park now only checks it is the same process', () => {
    expect(revalidate('manual', t0, before, { ...before, isSelected: true })).toEqual({ ok: true })
    expect(revalidate('manual', t0, before, { ...before, ptyId: 'p2' })).toEqual({
      ok: false,
      why: 'respawned'
    })
  })
})
