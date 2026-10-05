import { describe, it, expect } from 'vitest'
import { parseUsageOutput, parseResetText, buildSnapshot } from '../src/main/usage-parse'

// Real `claude -p "/usage"` output captured on Claude Code 2.1.172 (Max 20x).
const FULL = `You are currently using your subscription to power your Claude Code usage

Current session: 39% used · resets Jun 10, 8:40pm (America/Sao_Paulo)
Current week (all models): 11% used · resets Jun 15, 4pm (America/Sao_Paulo)
Current week (Sonnet only): 5% used · resets Jun 15, 4pm (America/Sao_Paulo)`

// Real, frequent `-p` outcome: exit 0 with the subscription preamble but the
// async usage table never printed. Parses to zero buckets despite being a
// subscription user — must NOT be read as a downgrade (the flicker bug).
const PREAMBLE_ONLY = 'You are currently using your subscription to power your Claude Code usage'

// A fixed "now" so reset-countdown math is deterministic regardless of machine TZ:
// both NOW and the parsed reset are built via the local-time Date constructor.
const NOW = new Date(2026, 5, 10, 20, 0, 0).getTime() // Jun 10 2026, 8:00pm local

describe('parseUsageOutput', () => {
  it('parses the full subscription panel into session, weekAll and per-model buckets', () => {
    const u = parseUsageOutput(FULL, NOW)
    expect(u.available).toBe(true)
    expect(u.session?.usedPercent).toBe(39)
    expect(u.weekAll?.usedPercent).toBe(11)
    expect(u.perModel).toHaveLength(1)
    expect(u.perModel[0].key).toBe('Sonnet')
    expect(u.perModel[0].usedPercent).toBe(5)
    expect(u.session?.resetsAtText).toContain('Jun 10, 8:40pm')
  })

  it('marks unavailable when the command reports no subscription usage', () => {
    const u = parseUsageOutput("/usage isn't available in this environment.", NOW)
    expect(u.available).toBe(false)
    expect(u.session).toBeNull()
    expect(u.weekAll).toBeNull()
    expect(u.perModel).toEqual([])
  })

  it('marks unavailable for empty output', () => {
    expect(parseUsageOutput('', NOW).available).toBe(false)
  })

  it('parses a fractional percentage', () => {
    const out = 'Current session: 23.5% used · resets Jun 10, 8:40pm (America/Sao_Paulo)'
    expect(parseUsageOutput(out, NOW).session?.usedPercent).toBe(23.5)
  })

  it('handles a missing weekly line (only session present)', () => {
    const out = 'Current session: 39% used · resets Jun 10, 8:40pm (America/Sao_Paulo)'
    const u = parseUsageOutput(out, NOW)
    expect(u.session?.usedPercent).toBe(39)
    expect(u.weekAll).toBeNull()
    expect(u.perModel).toEqual([])
  })

  it('captures any per-model bucket generically (e.g. Opus)', () => {
    const out = 'Current week (Opus only): 12% used · resets Jun 15, 4pm (America/Sao_Paulo)'
    const u = parseUsageOutput(out, NOW)
    expect(u.perModel.map((b) => b.key)).toEqual(['Opus'])
    expect(u.perModel[0].usedPercent).toBe(12)
  })

  it('computes resetsAtMs for the session bucket', () => {
    const u = parseUsageOutput(FULL, NOW)
    // Jun 10 8:40pm is 40 minutes after NOW (Jun 10 8:00pm).
    expect(u.session?.resetsAtMs).toBe(NOW + 40 * 60 * 1000)
  })

  it('flags the subscription preamble even when no data lines parsed', () => {
    expect(parseUsageOutput(FULL, NOW).subscription).toBe(true)
    expect(parseUsageOutput(PREAMBLE_ONLY, NOW).subscription).toBe(true)
    expect(parseUsageOutput(PREAMBLE_ONLY, NOW).available).toBe(false)
  })

  it('does not flag subscription for a genuine unavailable output', () => {
    expect(parseUsageOutput("/usage isn't available in this environment.", NOW).subscription).toBe(
      false
    )
    expect(parseUsageOutput('', NOW).subscription).toBe(false)
  })
})

describe('parseResetText', () => {
  it('parses an absolute reset into epoch ms (local time)', () => {
    expect(parseResetText('Jun 10, 8:40pm (America/Sao_Paulo)', NOW)).toBe(NOW + 40 * 60 * 1000)
  })

  it('handles hour-only times like "4pm"', () => {
    expect(parseResetText('Jun 15, 4pm (America/Sao_Paulo)', NOW)).toBe(
      new Date(2026, 5, 15, 16, 0, 0).getTime()
    )
  })

  it('rolls to next year across the Dec→Jan boundary', () => {
    const now = new Date(2026, 11, 31, 23, 0, 0).getTime()
    expect(parseResetText('Jan 1, 4pm', now)).toBe(new Date(2027, 0, 1, 16, 0, 0).getTime())
  })

  it('returns null for an unparseable string', () => {
    expect(parseResetText('whenever it feels like it', NOW)).toBeNull()
  })
})

describe('buildSnapshot', () => {
  it('builds a fresh snapshot from a successful /usage run', () => {
    const s = buildSnapshot(null, { ok: true, stdout: FULL }, NOW)
    expect(s.available).toBe(true)
    expect(s.stale).toBe(false)
    expect(s.status).toBe('ready')
    expect(s.fetchedAtMs).toBe(NOW)
    expect(s.session?.usedPercent).toBe(39)
  })

  it('keeps last-good data and marks stale when a refresh fails', () => {
    const good = buildSnapshot(null, { ok: true, stdout: FULL }, NOW)
    const later = buildSnapshot(good, { ok: false }, NOW + 90_000)
    expect(later.available).toBe(true) // still shows the prior data
    expect(later.session?.usedPercent).toBe(39)
    expect(later.stale).toBe(true)
    expect(later.status).toBe('ready')
    expect(later.fetchedAtMs).toBe(NOW) // timestamp of the good data, not the failed attempt
  })

  it('reports unavailable (not stale) when a failure has no prior good data', () => {
    const s = buildSnapshot(null, { ok: false }, NOW)
    expect(s.available).toBe(false)
    expect(s.stale).toBe(false)
    expect(s.status).toBe('unavailable')
  })

  it('treats a successful-but-unavailable run as authoritative (API-key user)', () => {
    const good = buildSnapshot(null, { ok: true, stdout: FULL }, NOW)
    const s = buildSnapshot(good, { ok: true, stdout: "isn't available" }, NOW + 90_000)
    expect(s.available).toBe(false)
    expect(s.stale).toBe(false)
    expect(s.status).toBe('unavailable')
  })

  // The flicker bug: `claude -p "/usage"` returns exit 0 with only the preamble.
  it('keeps last-good data when an incomplete (preamble-only) poll follows good data', () => {
    const good = buildSnapshot(null, { ok: true, stdout: FULL }, NOW)
    const later = buildSnapshot(good, { ok: true, stdout: PREAMBLE_ONLY }, NOW + 90_000)
    expect(later.available).toBe(true) // does NOT vanish
    expect(later.session?.usedPercent).toBe(39)
    expect(later.stale).toBe(true)
    expect(later.status).toBe('ready')
    expect(later.fetchedAtMs).toBe(NOW)
  })

  // No prior data + incomplete poll must NOT pin a sticky skeleton: it resolves
  // to `unavailable` (panel hides) and a later complete poll fills it in. The
  // initial-fetch skeleton is the renderer's null-snapshot window, not a status.
  it('reports unavailable (not sticky loading) for an incomplete poll with no prior data', () => {
    const s = buildSnapshot(null, { ok: true, stdout: PREAMBLE_ONLY }, NOW)
    expect(s.available).toBe(false)
    expect(s.stale).toBe(false)
    expect(s.status).toBe('unavailable')
  })
})
