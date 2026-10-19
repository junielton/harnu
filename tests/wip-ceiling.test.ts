import { describe, expect, it } from 'vitest'
import {
  WIP_LIMIT,
  WIP_LIMIT_MAX,
  WIP_LIMIT_MIN,
  WIP_SPAWN_BACKSTOP_MS,
  WIP_STALE_AFTER_DAYS,
  classifyWipCard,
  clampWipLimit,
  computeWipVerdict,
  resolveWipSessionFacts,
  type WipLivenessEnv,
  type WipSessionFacts
} from '../src/main/roadmap-core'

/**
 * BUG-197 — the WIP ceiling counts LIVE work only (ADR-0021). The live/stale
 * decision is one pure function shared by the manifest drain and the board.
 */

const NOW = Date.parse('2026-10-19T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const facts = (over: Partial<WipSessionFacts> = {}): WipSessionFacts => ({
  hasProcess: false,
  parked: false,
  hasTranscript: false,
  lastActivityMs: null,
  ...over
})

describe('classifyWipCard (AC-1)', () => {
  it('counts a session with a process attached (working or idle)', () => {
    expect(classifyWipCard({ session: 'abc' }, facts({ hasProcess: true }), NOW)).toEqual({
      live: true,
      reason: 'process'
    })
  })

  it('counts a parked / hibernated session — parked is not dead', () => {
    expect(
      classifyWipCard(
        { session: 'abc' },
        facts({ parked: true, hasTranscript: true, lastActivityMs: NOW - 30 * DAY }),
        NOW
      )
    ).toEqual({ live: true, reason: 'parked' })
  })

  it('counts a real transcript with recent activity and no process', () => {
    expect(
      classifyWipCard(
        { session: 'abc' },
        facts({ hasTranscript: true, lastActivityMs: NOW - 2 * DAY }),
        NOW
      )
    ).toEqual({ live: true, reason: 'recent' })
  })

  it('flags a real transcript with no activity for N days as stale (inactive)', () => {
    const justPast = NOW - (WIP_STALE_AFTER_DAYS * DAY + 1)
    expect(
      classifyWipCard(
        { session: 'abc' },
        facts({ hasTranscript: true, lastActivityMs: justPast }),
        NOW
      )
    ).toEqual({ live: false, reason: 'inactive' })
    const justInside = NOW - (WIP_STALE_AFTER_DAYS * DAY - 1)
    expect(
      classifyWipCard(
        { session: 'abc' },
        facts({ hasTranscript: true, lastActivityMs: justInside }),
        NOW
      ).live
    ).toBe(true)
  })

  it('flags a card with no session as stale', () => {
    expect(classifyWipCard({}, facts(), NOW)).toEqual({ live: false, reason: 'no-session' })
    expect(classifyWipCard({ session: '' }, null, NOW)).toEqual({
      live: false,
      reason: 'no-session'
    })
  })

  it('keeps a synthetic id still inside the spawn backstop live (spawning)', () => {
    expect(
      classifyWipCard(
        { session: 'synthetic-1', touchedAtMs: NOW - (WIP_SPAWN_BACKSTOP_MS - 1000) },
        facts(),
        NOW
      )
    ).toEqual({ live: true, reason: 'spawning' })
  })

  it('flags a synthetic id that never materialized past the backstop as stale', () => {
    expect(
      classifyWipCard(
        { session: 'synthetic-1', touchedAtMs: NOW - (WIP_SPAWN_BACKSTOP_MS + 1000) },
        facts(),
        NOW
      )
    ).toEqual({ live: false, reason: 'unmaterialized' })
  })

  it('flags a real session id with no transcript on disk as stale', () => {
    expect(classifyWipCard({ session: 'real-uuid', touchedAtMs: NOW - DAY }, facts(), NOW)).toEqual(
      {
        live: false,
        reason: 'unknown-session'
      }
    )
  })

  it('fails toward counting when liveness facts are unavailable', () => {
    expect(
      classifyWipCard({ session: 'synthetic-1', touchedAtMs: NOW - 40 * DAY }, null, NOW)
    ).toEqual({
      live: true,
      reason: 'unknown'
    })
  })

  it('fails toward counting a synthetic id whose bind time is unknown', () => {
    expect(classifyWipCard({ session: 'synthetic-1' }, facts(), NOW)).toEqual({
      live: true,
      reason: 'unknown'
    })
  })

  it('a process beats an old transcript', () => {
    expect(
      classifyWipCard(
        { session: 'abc' },
        facts({ hasProcess: true, hasTranscript: true, lastActivityMs: NOW - 90 * DAY }),
        NOW
      ).live
    ).toBe(true)
  })
})

describe('computeWipVerdict — the 2026-10-19 incident (AC-1)', () => {
  // 4 dead cards (3 never-materialized synthetics + a shipped one) + 1 live.
  const cards = [
    {
      slug: 'BUG-128',
      id: 'BUG-128',
      status: 'in-progress',
      session: 'synthetic-a',
      touchedAtMs: NOW - 13 * DAY
    },
    {
      slug: 'BUG-149',
      id: 'BUG-149',
      status: 'in-progress',
      session: 'synthetic-b',
      touchedAtMs: NOW - 18 * DAY
    },
    {
      slug: 'BUG-171',
      id: 'BUG-171',
      status: 'in-progress',
      session: 'synthetic-c',
      touchedAtMs: NOW - 10 * DAY
    },
    {
      slug: 'T316',
      id: 'T316',
      status: 'in-progress',
      session: 'synthetic-d',
      touchedAtMs: NOW - 40 * DAY
    },
    {
      slug: 'BUG-195',
      id: 'BUG-195',
      status: 'in-progress',
      session: 'synthetic-e',
      touchedAtMs: NOW - 5000
    },
    { slug: 'T1', id: 'T1', status: 'ready' },
    { slug: 'T2', id: 'T2', status: 'review', session: 'synthetic-z', touchedAtMs: NOW - 40 * DAY }
  ]
  const factsFor = (session: string): WipSessionFacts =>
    session === 'synthetic-e' ? facts({ hasProcess: true }) : facts()

  it('counts only the live card, lists the four dead ones as stale', () => {
    const v = computeWipVerdict(cards, 5, factsFor, NOW)
    expect(v.liveCount).toBe(1)
    expect(v.staleCount).toBe(4)
    expect(v.staleSlugs.sort()).toEqual(['BUG-128', 'BUG-149', 'BUG-171', 'T316'])
    expect(v.atCeiling).toBe(false)
    expect(v.over).toBe(false)
  })

  it('only considers In Progress cards', () => {
    const v = computeWipVerdict(cards, 5, factsFor, NOW)
    expect(v.holders.map((h) => h.slug).sort()).toEqual(
      ['BUG-128', 'BUG-149', 'BUG-171', 'BUG-195', 'T316'].sort()
    )
  })

  it('reports the ceiling against the LIVE count', () => {
    const live = Array.from({ length: 5 }, (_, i) => ({
      slug: `L${i}`,
      id: `L${i}`,
      status: 'in-progress',
      session: `s${i}`
    }))
    const v = computeWipVerdict(live, 5, () => facts({ hasProcess: true }), NOW)
    expect(v.liveCount).toBe(5)
    expect(v.atCeiling).toBe(true)
    expect(v.over).toBe(false)
    expect(computeWipVerdict(live, 4, () => facts({ hasProcess: true }), NOW).over).toBe(true)
  })

  it('carries each holder with its live/stale flag and reason', () => {
    const v = computeWipVerdict(cards, 5, factsFor, NOW)
    const t316 = v.holders.find((h) => h.slug === 'T316')
    expect(t316).toMatchObject({ live: false, reason: 'unmaterialized', id: 'T316' })
    expect(v.holders.find((h) => h.slug === 'BUG-195')).toMatchObject({
      live: true,
      reason: 'process'
    })
  })

  it('passes a null fact set through as "unknown, counts"', () => {
    const v = computeWipVerdict(cards, 5, () => null, NOW)
    expect(v.liveCount).toBe(5)
    expect(v.staleCount).toBe(0)
  })
})

describe('clampWipLimit (AC-4)', () => {
  it('defaults to 5 and is bounded to a sane range', () => {
    expect(WIP_LIMIT).toBe(5)
    expect(WIP_LIMIT_MIN).toBe(1)
    expect(WIP_LIMIT_MAX).toBe(10)
    expect(clampWipLimit(undefined)).toBe(5)
    expect(clampWipLimit(null)).toBe(5)
    expect(clampWipLimit('7')).toBe(5)
    expect(clampWipLimit(Number.NaN)).toBe(5)
    expect(clampWipLimit(0)).toBe(1)
    expect(clampWipLimit(-3)).toBe(1)
    expect(clampWipLimit(500)).toBe(10)
    expect(clampWipLimit(7.6)).toBe(8)
    expect(clampWipLimit(3)).toBe(3)
  })
})

describe('resolveWipSessionFacts — follows the synthetic → real alias', () => {
  const env = (over: Partial<WipLivenessEnv> = {}): WipLivenessEnv => ({
    resolveAlias: (k) => k,
    isLive: () => false,
    isParked: () => false,
    transcriptActivityMs: () => undefined,
    ...over
  })

  it('a synthetic-bound card is live through its real key', () => {
    const f = resolveWipSessionFacts(
      'synthetic-1',
      env({
        resolveAlias: (k) => (k === 'synthetic-1' ? 'real-1' : k),
        isLive: (k) => k === 'real-1'
      })
    )
    expect(f.hasProcess).toBe(true)
  })

  it('reads parked state and transcript activity from the resolved key', () => {
    const f = resolveWipSessionFacts(
      'synthetic-1',
      env({
        resolveAlias: () => 'real-1',
        isParked: (k) => k === 'real-1',
        transcriptActivityMs: (k) => (k === 'real-1' ? 1234 : undefined)
      })
    )
    expect(f).toEqual({
      hasProcess: false,
      parked: true,
      hasTranscript: true,
      lastActivityMs: 1234
    })
  })

  it('a session nothing knows about has no process, no park, no transcript', () => {
    expect(resolveWipSessionFacts('ghost', env())).toEqual({
      hasProcess: false,
      parked: false,
      hasTranscript: false,
      lastActivityMs: null
    })
  })

  it('a transcript with unknown activity is a transcript with a null time', () => {
    const f = resolveWipSessionFacts('abc', env({ transcriptActivityMs: () => null }))
    expect(f).toMatchObject({ hasTranscript: true, lastActivityMs: null })
  })
})
