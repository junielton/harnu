import { describe, it, expect } from 'vitest'
import {
  footerSessionChips,
  nearCompact,
  nearCompactReason
} from '../src/renderer/src/components/footer-format'

/**
 * The footer's left cluster is additive: each chip renders only when its datum
 * is present, in a fixed order. These cases pin the selection + ordering so the
 * SFC can stay a dumb renderer.
 */
describe('footerSessionChips', () => {
  it('omits null fields and keeps order (model·context·branch·effort·cost·lines)', () => {
    const out = footerSessionChips(
      {
        modelName: 'Opus 4.8',
        contextPercent: 17,
        costUsd: 5.84,
        linesAdded: 603,
        linesRemoved: 0,
        effortLevel: 'high'
      } as never,
      { gitBranch: 'feat/x' } as never
    )
    expect(out.map((c) => c.key)).toEqual(['model', 'context', 'branch', 'effort', 'cost', 'lines'])
    expect(out.find((c) => c.key === 'context')?.value).toBe('17%')
    expect(out.find((c) => c.key === 'cost')?.value).toBe('$5.84')
  })

  it('drops context when null, branch when empty, and lines when both zero', () => {
    const out = footerSessionChips(
      {
        modelName: 'Sonnet',
        contextPercent: null,
        costUsd: 0.1,
        linesAdded: 0,
        linesRemoved: 0,
        effortLevel: null
      } as never,
      { gitBranch: '' } as never
    )
    expect(out.map((c) => c.key)).toEqual(['model', 'cost'])
  })

  it('returns no chips when telemetry is null', () => {
    expect(footerSessionChips(null, { gitBranch: 'main' } as never)).toEqual([])
  })
})

describe('nearCompact', () => {
  it('is true on exceeds200k or context >= 95, false otherwise', () => {
    expect(nearCompact({ exceeds200k: true, contextPercent: 10 } as never)).toBe(true)
    expect(nearCompact({ exceeds200k: false, contextPercent: 96 } as never)).toBe(true)
    expect(nearCompact({ exceeds200k: false, contextPercent: 80 } as never)).toBe(false)
    expect(nearCompact(null)).toBe(false)
  })
})

describe('nearCompactReason', () => {
  it("returns 'pct' when context >= 95 (the genuine near-ceiling case)", () => {
    expect(nearCompactReason({ exceeds200k: false, contextPercent: 95 } as never)).toBe('pct')
    expect(nearCompactReason({ exceeds200k: false, contextPercent: 96 } as never)).toBe('pct')
  })

  it("returns 'over200k' when exceeds200k fires below the 95% mark (e.g. 53%)", () => {
    expect(nearCompactReason({ exceeds200k: true, contextPercent: 53 } as never)).toBe('over200k')
    expect(nearCompactReason({ exceeds200k: true, contextPercent: null } as never)).toBe('over200k')
  })

  it("prefers 'pct' over 'over200k' when both conditions are true", () => {
    expect(nearCompactReason({ exceeds200k: true, contextPercent: 97 } as never)).toBe('pct')
  })

  it('returns null when neither condition fires, and for null telemetry', () => {
    expect(nearCompactReason({ exceeds200k: false, contextPercent: 80 } as never)).toBeNull()
    expect(nearCompactReason({ exceeds200k: false, contextPercent: null } as never)).toBeNull()
    expect(nearCompactReason(null)).toBeNull()
  })
})
