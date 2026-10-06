import { describe, expect, it } from 'vitest'
import { compose, mergePart, type CompanionPart } from '../src/main/telemetry-compose-core'
import { foldFleetTelemetry, type SessionTelemetry } from '../src/main/statusline-parse'

const SID = '11111111-1111-4111-8111-111111111111'

/** A statusLine record with every field set to a value the companion would never write. */
const SL: SessionTelemetry = {
  sessionId: SID,
  cwd: '/tmp/example-project',
  modelId: 'claude-sl-model',
  modelName: 'SL Model',
  costUsd: 9.99,
  linesAdded: 12,
  linesRemoved: 3,
  durationMs: 45_000,
  contextPercent: 88,
  contextWindowSize: 123_456,
  exceeds200k: false,
  effortLevel: 'high',
  thinkingEnabled: true,
  outputStyle: 'explanatory',
  pr: { number: 7, url: 'https://example.invalid/7', reviewState: 'approved' },
  rateLimits: {
    fiveHour: { usedPercent: 77, resetsAtMs: 1_000 },
    sevenDay: { usedPercent: 66, resetsAtMs: 2_000 }
  },
  updatedAtMs: 1_790_000_000_000
}

const T = 1_790_000_100_000
const FULL_PART: CompanionPart = {
  cwd: '/tmp/hello-cwd',
  cost: { usd: 0.0185783, atMs: T },
  context: { percent: 19, window: 200_000, tokens: 37_302, atMs: T },
  rateLimits: {
    fiveHour: { usedPercent: 21, resetsAtMs: 5_000 },
    sevenDay: { usedPercent: 54, resetsAtMs: 6_000 },
    atMs: T
  }
}

describe('compose: the field partition (AC-P1W6-4)', () => {
  it('field partition', () => {
    const t = compose(SL, FULL_PART, true, SID)!
    // the eight fields with no mod source stay the statusLine's
    expect(t.linesAdded).toBe(SL.linesAdded)
    expect(t.linesRemoved).toBe(SL.linesRemoved)
    expect(t.thinkingEnabled).toBe(SL.thinkingEnabled)
    expect(t.outputStyle).toBe(SL.outputStyle)
    expect(t.pr).toEqual(SL.pr)
    expect(t.modelName).toBe(SL.modelName)
    expect(t.durationMs).toBe(SL.durationMs)
    expect(t.effortLevel).toBe(SL.effortLevel)
    // every other field is the companion's
    expect(t.costUsd).toBe(0.0185783)
    expect(t.contextPercent).toBe(19)
    expect(t.contextWindowSize).toBe(200_000)
    expect(t.exceeds200k).toBe(false)
    expect(t.rateLimits).toEqual({
      fiveHour: { usedPercent: 21, resetsAtMs: 5_000 },
      sevenDay: { usedPercent: 54, resetsAtMs: 6_000 }
    })
    expect(t.rateLimitsAtMs).toBe(T)
    expect(t.sessionId).toBe(SID)
    expect(t.cwd).toBe(SL.cwd) // the statusLine's, when it has one
    expect(t.updatedAtMs).toBe(T) // the newest stamp among the contributing writers
  })

  it('exceeds200k follows context.tokens', () => {
    const big: CompanionPart = {
      ...FULL_PART,
      context: { percent: 90, window: 1_000_000, tokens: 200_001, atMs: T }
    }
    expect(compose(SL, big, true, SID)!.exceeds200k).toBe(true)
    const edge: CompanionPart = {
      ...FULL_PART,
      context: { percent: 90, window: 1_000_000, tokens: 200_000, atMs: T }
    }
    expect(compose(SL, edge, true, SID)!.exceeds200k).toBe(false)
  })

  it('a group the companion has not read yet stays the statusLine’s (group-level proof)', () => {
    const onlyCost: CompanionPart = { cwd: null, cost: { usd: 1.5, atMs: T } }
    const t = compose(SL, onlyCost, true, SID)!
    expect(t.costUsd).toBe(1.5)
    expect(t.contextPercent).toBe(88)
    expect(t.contextWindowSize).toBe(123_456)
    expect(t.rateLimits).toEqual(SL.rateLimits)
    // the statusLine's window keeps the statusLine's own stamp, not the cost reading's
    expect(t.rateLimitsAtMs).toBe(SL.updatedAtMs)
  })

  it('the cwd falls back to the binding’s when the statusLine has none or no record exists', () => {
    expect(compose({ ...SL, cwd: null }, FULL_PART, true, SID)!.cwd).toBe('/tmp/hello-cwd')
    expect(compose(null, FULL_PART, true, SID)!.cwd).toBe('/tmp/hello-cwd')
  })

  it('no statusLine record: the statusLine fields take the parse defaults', () => {
    const t = compose(null, FULL_PART, true, SID)!
    expect(t).toMatchObject({
      sessionId: SID,
      modelId: '',
      modelName: '',
      linesAdded: null,
      linesRemoved: null,
      durationMs: null,
      effortLevel: null,
      thinkingEnabled: false,
      outputStyle: null,
      pr: null,
      costUsd: 0.0185783,
      contextPercent: 19
    })
    expect(t.updatedAtMs).toBe(T)
  })
})

describe('compose: not owned', () => {
  it('shadow never writes', () => {
    // not owned: the very same record, so the statusLine-only payload is byte-equal
    expect(compose(SL, FULL_PART, false, SID)).toBe(SL)
    expect(compose(null, FULL_PART, false, SID)).toBeNull()
  })

  it('an owned session with a part that holds no group is the statusLine record untouched', () => {
    expect(compose(SL, { cwd: '/x' }, true, SID)).toBe(SL)
    expect(compose(SL, null, true, SID)).toBe(SL)
  })
})

describe('compose: the model group waits for the turn sensor (AC-P1W6-29)', () => {
  it('model group waits for the turn sensor', () => {
    expect(compose(SL, FULL_PART, true, SID)!.modelId).toBe(SL.modelId)
  })

  it('from slice S3 the companion’s model id wins once it has one', () => {
    const withModel: CompanionPart = { ...FULL_PART, model: { id: 'claude-haiku-4-5', atMs: T } }
    const t = compose(SL, withModel, true, SID)!
    expect(t.modelId).toBe('claude-haiku-4-5')
    expect(t.modelName).toBe(SL.modelName) // never the companion's (Q13)
  })
})

describe('mergePart: absent is "no new figure" (AC-P1W6-6)', () => {
  it('empty rate limits are not a reading', () => {
    const first = mergePart(null, FULL_PART)
    // the resume handshake: cost and context arrive, the window list is empty
    const second = mergePart(first, {
      cwd: null,
      cost: { usd: 0.02, atMs: T + 1 },
      context: { percent: 20, window: 200_000, tokens: 40_000, atMs: T + 1 }
    })
    expect(second.rateLimits).toEqual(first.rateLimits)
    expect(second.cost?.usd).toBe(0.02)
    const t = compose(SL, second, true, SID)!
    expect(t.rateLimits.fiveHour).toEqual({ usedPercent: 21, resetsAtMs: 5_000 })
    expect(t.rateLimitsAtMs).toBe(T)
  })

  it('a later reading with windows replaces the group wholesale', () => {
    const first = mergePart(null, FULL_PART)
    const second = mergePart(first, {
      cwd: null,
      rateLimits: { fiveHour: { usedPercent: 30, resetsAtMs: 5_000 }, sevenDay: null, atMs: T + 9 }
    })
    expect(second.rateLimits).toEqual({
      fiveHour: { usedPercent: 30, resetsAtMs: 5_000 },
      sevenDay: null,
      atMs: T + 9
    })
  })

  it('keeps the first known cwd', () => {
    const first = mergePart(null, { cwd: '/a' })
    expect(mergePart(first, { cwd: null }).cwd).toBe('/a')
    expect(mergePart(first, { cwd: '/b' }).cwd).toBe('/b')
  })
})

describe('window freshness follows the reading (AC-P1W6-8, lesson framework/005)', () => {
  it('window freshness follows the reading', () => {
    // a companion window stamped T, then a statusLine blob that moved only linesAdded
    const composed = compose(SL, FULL_PART, true, SID)!
    const laterBlob: SessionTelemetry = { ...SL, linesAdded: 99, updatedAtMs: T + 600_000 }
    const t = compose(laterBlob, FULL_PART, true, SID)!
    expect(t.rateLimitsAtMs).toBe(T)
    expect(t.updatedAtMs).toBe(T + 600_000)
    const fleet = foldFleetTelemetry(new Map([[SID, t]]), T + 600_000)
    expect(fleet.fiveHourAtMs).toBe(T)
    expect(fleet.sevenDayAtMs).toBe(T)
    expect(composed.rateLimitsAtMs).toBe(T)
  })
})
