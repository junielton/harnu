import { describe, it, expect } from 'vitest'
import {
  parseSummary,
  buildSnapshot,
  diffStatus,
  severityOfIndicator,
  severityOfComponent,
  severityOfImpact,
  severityRank,
  type ClaudeStatusSnapshot,
  type StatusIncident
} from '../src/main/claude-status-parse'

// A realistic Atlassian Statuspage summary.json (trimmed) with one active
// incident and one degraded component.
const SUMMARY = {
  page: { id: 'abc', name: 'Anthropic', url: 'https://status.claude.com' },
  status: { indicator: 'minor', description: 'Partially Degraded Service' },
  components: [
    { id: 'grp', name: 'API', status: 'operational', group: true },
    { id: 'c1', name: 'api.anthropic.com', status: 'degraded_performance', group: false },
    { id: 'c2', name: 'console.anthropic.com', status: 'operational', group: false }
  ],
  incidents: [
    {
      id: 'inc1',
      name: 'Elevated error rates',
      status: 'investigating',
      impact: 'minor',
      shortlink: 'https://stspg.io/x',
      started_at: '2026-06-23T10:00:00Z',
      updated_at: '2026-06-23T10:30:00Z'
    }
  ],
  scheduled_maintenances: [
    {
      id: 'm1',
      name: 'Database upgrade',
      status: 'scheduled',
      scheduled_for: '2026-06-25T02:00:00Z',
      scheduled_until: '2026-06-25T04:00:00Z'
    }
  ]
}

const NOW = 1_750_000_000_000

describe('severity maps', () => {
  it('maps page indicators', () => {
    expect(severityOfIndicator('none')).toBe('operational')
    expect(severityOfIndicator('minor')).toBe('degraded')
    expect(severityOfIndicator('major')).toBe('outage')
    expect(severityOfIndicator('critical')).toBe('outage')
    expect(severityOfIndicator('maintenance')).toBe('maintenance')
    expect(severityOfIndicator('weird')).toBe('unknown')
  })

  it('maps component statuses', () => {
    expect(severityOfComponent('operational')).toBe('operational')
    expect(severityOfComponent('degraded_performance')).toBe('degraded')
    expect(severityOfComponent('partial_outage')).toBe('degraded')
    expect(severityOfComponent('major_outage')).toBe('outage')
    expect(severityOfComponent('under_maintenance')).toBe('maintenance')
  })

  it('maps incident impacts', () => {
    expect(severityOfImpact('none')).toBe('operational')
    expect(severityOfImpact('critical')).toBe('outage')
  })

  it('ranks severities for worsened/recovered comparisons', () => {
    expect(severityRank('operational')).toBeLessThan(severityRank('degraded'))
    expect(severityRank('degraded')).toBeLessThan(severityRank('outage'))
    expect(severityRank('unknown')).toBe(-1)
  })
})

describe('parseSummary', () => {
  it('parses overall severity, components (group dropped), incidents and maintenance', () => {
    const s = parseSummary(SUMMARY, NOW)
    expect(s.severity).toBe('degraded')
    expect(s.description).toBe('Partially Degraded Service')
    // The `group: true` row is dropped.
    expect(s.components.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(s.components[0].severity).toBe('degraded')
    expect(s.incidents).toHaveLength(1)
    expect(s.incidents[0].id).toBe('inc1')
    expect(s.incidents[0].severity).toBe('degraded')
    expect(s.maintenances).toHaveLength(1)
    expect(s.fetchedAtMs).toBe(NOW)
    expect(s.stale).toBe(false)
  })

  it('is defensive over garbage input (never throws)', () => {
    const s = parseSummary({ status: 42, components: 'nope' }, NOW)
    expect(s.severity).toBe('unknown')
    expect(s.components).toEqual([])
    expect(s.incidents).toEqual([])
  })

  it('drops resolved incidents from the active list', () => {
    const j = {
      ...SUMMARY,
      incidents: [{ id: 'r', name: 'old', status: 'resolved', impact: 'minor' }]
    }
    expect(parseSummary(j, NOW).incidents).toEqual([])
  })
})

describe('buildSnapshot', () => {
  it('returns the parsed snapshot on success', () => {
    const s = buildSnapshot(null, { ok: true, json: SUMMARY }, NOW)
    expect(s.severity).toBe('degraded')
    expect(s.stale).toBe(false)
  })

  it('keeps last-good but flips to unknown + stale on failure', () => {
    const prev = parseSummary(SUMMARY, NOW)
    const s = buildSnapshot(prev, { ok: false }, NOW + 1000)
    expect(s.severity).toBe('unknown')
    expect(s.stale).toBe(true)
    // last-good components/incidents survive
    expect(s.components).toHaveLength(2)
    expect(s.incidents).toHaveLength(1)
  })

  it('returns an empty unknown snapshot on a cold offline start', () => {
    const s = buildSnapshot(null, { ok: false }, NOW)
    expect(s.severity).toBe('unknown')
    expect(s.components).toEqual([])
    expect(s.incidents).toEqual([])
  })
})

// ── diffStatus ───────────────────────────────────────────────────────────────

const snap = (over: Partial<ClaudeStatusSnapshot>): ClaudeStatusSnapshot => ({
  severity: 'operational',
  indicator: 'none',
  description: 'All Systems Operational',
  components: [],
  incidents: [],
  maintenances: [],
  fetchedAtMs: NOW,
  stale: false,
  ...over
})

const inc = (id: string, name = id, status = 'investigating'): StatusIncident => ({
  id,
  name,
  status,
  severity: 'degraded' as const,
  shortlink: '',
  startedAtMs: null,
  updatedAtMs: null
})

const ON = { notify: true }

describe('diffStatus', () => {
  it('baseline (prev null) never notifies', () => {
    expect(diffStatus(null, snap({ severity: 'outage' }), ON)).toEqual([])
  })

  it('mute suppresses every notification', () => {
    const prev = snap({})
    const next = snap({ severity: 'outage', incidents: [inc('a')] })
    expect(diffStatus(prev, next, { notify: false })).toEqual([])
  })

  it('a transition into unknown (network blip) never notifies', () => {
    const prev = snap({ severity: 'operational' })
    const next = snap({ severity: 'unknown', stale: true })
    expect(diffStatus(prev, next, ON)).toEqual([])
  })

  it('fires on an incident opening', () => {
    const prev = snap({})
    const next = snap({ incidents: [inc('a', 'Elevated errors')] })
    const out = diffStatus(prev, next, ON)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('incident-open')
    expect(out[0].id).toBe('a')
    expect(out[0].body).toBe('Elevated errors')
  })

  it('fires on an incident resolving (drops off the active list)', () => {
    const prev = snap({ incidents: [inc('a')] })
    const next = snap({})
    const out = diffStatus(prev, next, ON)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('incident-resolved')
    expect(out[0].id).toBe('a')
  })

  it('does NOT re-fire when an incident only changes status (dedup by id)', () => {
    const prev = snap({ severity: 'degraded', incidents: [inc('a', 'x', 'investigating')] })
    const next = snap({ severity: 'degraded', incidents: [inc('a', 'x', 'monitoring')] })
    expect(diffStatus(prev, next, ON)).toEqual([])
  })

  it('fires worsened / recovered on a severity change with no incident change', () => {
    const worse = diffStatus(snap({ severity: 'operational' }), snap({ severity: 'outage' }), ON)
    expect(worse).toHaveLength(1)
    expect(worse[0].kind).toBe('worsened')

    const better = diffStatus(snap({ severity: 'outage' }), snap({ severity: 'operational' }), ON)
    expect(better).toHaveLength(1)
    expect(better[0].kind).toBe('recovered')
  })

  it('prefers incident notifications over a redundant whole-page severity toast', () => {
    const prev = snap({ severity: 'operational' })
    const next = snap({ severity: 'outage', incidents: [inc('a')] })
    const out = diffStatus(prev, next, ON)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('incident-open')
  })
})
