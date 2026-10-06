import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FleetTelemetry, SessionTelemetry } from '../src/main/statusline-parse'
import { createTelemetryStore, type TelemetryPayload } from '../src/main/telemetry-store'
import type { CompanionPart } from '../src/main/telemetry-compose-core'

// AC-P1W6-10: the companion path must never reach settings.json, so these two are spies the whole
// file long. The store imports neither; the spies prove it stays that way.
const settings = vi.hoisted(() => ({
  updateClaudeSettings: vi.fn(),
  stripStatusLine: vi.fn()
}))
vi.mock('../src/main/claude-settings', () => ({
  updateClaudeSettings: settings.updateClaudeSettings,
  claudeSettingsPath: () => '/nonexistent/settings.json'
}))
vi.mock('../src/main/statusline-install', () => ({
  stripStatusLine: settings.stripStatusLine,
  mergeStatusLine: vi.fn(),
  buildWriterScript: vi.fn(),
  isWriterStale: vi.fn()
}))

const SID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NOW = 1_790_000_000_000

const sl = (over: Partial<SessionTelemetry> = {}): SessionTelemetry => ({
  sessionId: SID,
  cwd: '/tmp/example-project',
  modelId: 'claude-sl',
  modelName: 'SL',
  costUsd: 9.99,
  linesAdded: 12,
  linesRemoved: 3,
  durationMs: 45_000,
  contextPercent: 88,
  contextWindowSize: 123_456,
  exceeds200k: false,
  effortLevel: 'high',
  thinkingEnabled: true,
  outputStyle: 'default',
  pr: null,
  rateLimits: {
    fiveHour: { usedPercent: 77, resetsAtMs: 1_000 },
    sevenDay: { usedPercent: 66, resetsAtMs: 2_000 }
  },
  updatedAtMs: NOW,
  ...over
})

const reading = (over: Partial<CompanionPart> = {}): CompanionPart => ({
  cwd: '/tmp/hello-cwd',
  cost: { usd: 0.5, atMs: NOW + 10 },
  context: { percent: 19, window: 200_000, tokens: 49_284, atMs: NOW + 10 },
  rateLimits: {
    fiveHour: { usedPercent: 21, resetsAtMs: 5_000 },
    sevenDay: { usedPercent: 54, resetsAtMs: 6_000 },
    atMs: NOW + 10
  },
  ...over
})

let clock = NOW
let captured: { fleet: FleetTelemetry; now: number }[] = []
let sent: TelemetryPayload[] = []
const dirs: string[] = []

function rig(over: { cachePath?: string | null } = {}) {
  const store = createTelemetryStore({
    now: () => clock,
    captureFleet: (fleet, now) => void captured.push({ fleet, now }),
    cachePath: () => over.cachePath ?? null,
    send: (p) => void sent.push(p)
  })
  return store
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = NOW + 1_000
  captured = []
  sent = []
  settings.updateClaudeSettings.mockClear()
  settings.stripStatusLine.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const only = (p: TelemetryPayload, sid = SID): SessionTelemetry | undefined =>
  p.perSession.find((t) => t.sessionId === sid)

describe('telemetry store', () => {
  it('a statusLine blob alone is served untouched (the legacy path is byte-equal)', () => {
    const s = rig()
    const t = sl()
    s.ingestStatusline(t)
    expect(only(s.getTelemetryPayload())).toBe(t)
    expect(s.getTelemetryPayload().fleet.fiveHour).toEqual(t.rateLimits.fiveHour)
  })

  it('history is fed from the companion path (AC-P1W6-7, R14)', () => {
    const s = rig()
    // the statusLine writer is disabled: no blob was ever ingested for this session
    s.ingestCompanion(SID, reading(), true)
    expect(captured.length).toBe(1)
    expect(captured[0]!.fleet.fiveHour).toEqual({ usedPercent: 21, resetsAtMs: 5_000 })
    expect(captured[0]!.fleet.fiveHourAtMs).toBe(NOW + 10)
    expect(captured[0]!.now).toBe(clock)
    expect(only(s.getTelemetryPayload())?.costUsd).toBe(0.5)
  })

  it('a statusLine blob is a commit too: history is fed whichever source wrote', () => {
    const s = rig()
    s.ingestStatusline(sl())
    expect(captured.length).toBe(1)
  })

  it('lease loss returns every group (AC-P1W6-9)', () => {
    const s = rig()
    const blob = sl()
    s.ingestStatusline(blob)
    s.ingestCompanion(SID, reading(), true)
    expect(only(s.getTelemetryPayload())?.costUsd).toBe(0.5)
    s.dropCompanion(SID)
    expect(only(s.getTelemetryPayload())).toEqual(blob)
    expect(s.getTelemetryPayload().fleet.fiveHour).toEqual(blob.rateLimits.fiveHour)
    // and the statusLine's next blob is written as itself
    const next = sl({ costUsd: 10.5, updatedAtMs: NOW + 99 })
    s.ingestStatusline(next)
    expect(only(s.getTelemetryPayload())).toEqual(next)
  })

  it('a session that only the companion knew disappears on lease loss', () => {
    const s = rig()
    s.ingestCompanion(SID, reading(), true)
    s.dropCompanion(SID)
    expect(only(s.getTelemetryPayload())).toBeUndefined()
  })

  it('kill switch mid-session (AC-P1W6-26, telemetry half)', () => {
    const s = rig()
    s.ingestStatusline(sl())
    s.ingestStatusline(sl({ sessionId: OTHER, costUsd: 3 }))
    s.ingestCompanion(SID, reading(), true)
    s.ingestCompanion(OTHER, reading(), true)
    // the arbiter now answers legacy for everything: the next reading arrives not owned
    s.ingestCompanion(SID, reading({ cost: { usd: 99, atMs: NOW + 50 } }), false)
    s.ingestCompanion(OTHER, reading(), false)
    const statuslineOnly = rig()
    statuslineOnly.ingestStatusline(sl())
    statuslineOnly.ingestStatusline(sl({ sessionId: OTHER, costUsd: 3 }))
    expect(s.getTelemetryPayload()).toEqual(statuslineOnly.getTelemetryPayload())
    expect(s.companionSids()).toEqual([])
  })

  it('shadow never writes: a reading that is not owned leaves the payload as it was', () => {
    const s = rig()
    s.ingestStatusline(sl())
    const before = JSON.stringify(s.getTelemetryPayload())
    s.ingestCompanion(SID, reading(), false)
    expect(JSON.stringify(s.getTelemetryPayload())).toBe(before)
  })

  it('a later statusLine blob does not re-stamp a companion window (lesson framework/005)', () => {
    const s = rig()
    s.ingestStatusline(sl())
    s.ingestCompanion(SID, reading(), true)
    clock += 600_000
    s.ingestStatusline(sl({ linesAdded: 99, updatedAtMs: clock }))
    const f = s.getTelemetryPayload().fleet
    expect(f.fiveHourAtMs).toBe(NOW + 10)
    expect(only(s.getTelemetryPayload())?.linesAdded).toBe(99)
    expect(only(s.getTelemetryPayload())?.costUsd).toBe(0.5)
  })

  it('last context tokens (AC-P1W6-28)', () => {
    const s = rig()
    expect(s.lastContextTokens(SID)).toBeNull()
    s.ingestCompanion(SID, reading(), true)
    expect(s.lastContextTokens(SID)).toBe(49_284)
    // a later reading without tokens (and without a context group at all)
    s.ingestCompanion(SID, { cwd: null, cost: { usd: 0.6, atMs: NOW + 20 } }, true)
    expect(s.lastContextTokens(SID)).toBe(49_284)
    expect(s.lastContextTokens('unknown-sid')).toBeNull()
    s.dropCompanion(SID)
    expect(s.lastContextTokens(SID)).toBeNull()
  })

  it('the companion path never touches settings.json (AC-P1W6-10)', () => {
    const s = rig()
    s.ingestCompanion(SID, reading(), true)
    s.ingestCompanion(SID, reading(), false)
    s.dropCompanion(SID)
    s.ingestCompanion(OTHER, reading(), true)
    s.dropCompanion(OTHER)
    expect(settings.updateClaudeSettings).not.toHaveBeenCalled()
    expect(settings.stripStatusLine).not.toHaveBeenCalled()
  })

  it('emits one debounced payload per burst', () => {
    const s = rig()
    s.ingestStatusline(sl())
    s.ingestCompanion(SID, reading(), true)
    s.ingestCompanion(SID, reading({ cost: { usd: 0.7, atMs: NOW + 30 } }), true)
    expect(sent.length).toBe(0)
    vi.advanceTimersByTime(200)
    expect(sent.length).toBe(1)
    expect(only(sent[0]!)?.costUsd).toBe(0.7)
  })

  it('persists the composed map and restores it, TTL-filtered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnu-ts-'))
    dirs.push(dir)
    const path = join(dir, 'telemetry-cache.json')
    const a = rig({ cachePath: path })
    a.ingestStatusline(sl())
    a.ingestCompanion(SID, reading(), true)
    a.ingestStatusline(sl({ sessionId: OTHER, updatedAtMs: NOW - 25 * 3_600_000 }))
    vi.advanceTimersByTime(1_500)
    expect(existsSync(path)).toBe(true)
    const b = rig({ cachePath: path })
    return b.hydrate().then(() => {
      const p = b.getTelemetryPayload()
      expect(only(p)?.costUsd).toBe(0.5) // the composed value, not the blob's
      expect(only(p, OTHER)).toBeUndefined() // older than the TTL
      // a restored entry is the last known statusLine-side record: a lease loss falls back to it
      b.dropCompanion(SID)
      expect(only(b.getTelemetryPayload())?.costUsd).toBe(0.5)
    })
  })

  it('flushSync writes the cache for the next launch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnu-ts-'))
    dirs.push(dir)
    const path = join(dir, 'telemetry-cache.json')
    const s = rig({ cachePath: path })
    s.ingestStatusline(sl())
    s.flushSync()
    expect(JSON.parse(readFileSync(path, 'utf8'))[0].sessionId).toBe(SID)
  })

  it('notifies statusLine listeners with the raw blob, for the parity ledger', () => {
    const s = rig()
    const seen: SessionTelemetry[] = []
    const off = s.onStatusline((t) => void seen.push(t))
    const t = sl()
    s.ingestStatusline(t)
    off()
    s.ingestStatusline(sl({ costUsd: 1 }))
    expect(seen).toEqual([t])
  })
})
