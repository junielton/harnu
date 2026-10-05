import { describe, it, expect } from 'vitest'
import {
  deriveStagnation,
  STAGNATION_WINDOW_MS,
  STAGNATION_MIN_CALLS,
  MUTATION_TOOLS,
  type TranscriptEntry
} from '../src/main/stall-detect'

/**
 * T175 — stagnation detector core. Fixtures mirror the real on-disk shape: an
 * `assistant` entry with a top-level ISO `timestamp` and a `tool_use` block in
 * `message.content[]` (see docs/specs/T175-session-stagnation-detector.md).
 */

let uid = 0
const nextUuid = (): string => `uuid-${++uid}`

const entry = (name: string, input: Record<string, unknown>, tsMs: number): TranscriptEntry => ({
  type: 'assistant',
  uuid: nextUuid(),
  timestamp: new Date(tsMs).toISOString(),
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', name, input }]
  }
})

describe('deriveStagnation', () => {
  it('flags a busy session repeating one command with no mutations', () => {
    const t0 = Date.parse('2026-07-22T12:00:00Z')
    const entries = [
      entry('Bash', { command: 'npm test' }, t0), // prior — establishes the target, outside the window
      ...Array.from({ length: 10 }, (_, i) =>
        entry('Bash', { command: 'npm test' }, t0 + 400_000 + i * 10_000)
      )
    ]
    const v = deriveStagnation(entries)
    expect(v.stagnant).toBe(true)
    expect(v.topTarget).toBe('Bash: npm test')
    expect(v.topCount).toBe(10)
    expect(v.calls).toBe(10)
    expect(v.distinct).toBe(1)
  })

  it('does not flag novel targets at the same call volume (research reading many distinct files)', () => {
    const t0 = Date.parse('2026-07-22T12:00:00Z')
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry('Read', { file_path: `/repo/src/file-${i}.ts` }, t0 + i * 10_000)
    )
    const v = deriveStagnation(entries)
    expect(v.stagnant).toBe(false)
    expect(v.calls).toBe(8)
    expect(v.distinct).toBe(8)
  })

  it('does not flag repeats with a mutation among them, even when both fingerprints are already established', () => {
    const t0 = Date.parse('2026-07-22T12:00:00Z')
    const entries = [
      entry('Bash', { command: 'npm test' }, t0), // prior — establishes the Bash target
      entry('Edit', { file_path: '/repo/src/fix.ts' }, t0 + 1_000), // prior — establishes the Edit target
      ...Array.from({ length: 7 }, (_, i) =>
        entry('Bash', { command: 'npm test' }, t0 + 400_000 + i * 10_000)
      ),
      entry('Edit', { file_path: '/repo/src/fix.ts' }, t0 + 470_000) // mutation inside the window
    ]
    const v = deriveStagnation(entries)
    expect(v.stagnant).toBe(false)
    expect(v.calls).toBe(8)
  })

  it('does not flag below the call floor', () => {
    const t0 = Date.parse('2026-07-22T12:00:00Z')
    const entries = [
      entry('Bash', { command: 'npm test' }, t0), // prior — establishes the target
      ...Array.from({ length: 7 }, (_, i) =>
        entry('Bash', { command: 'npm test' }, t0 + 400_000 + i * 10_000)
      )
    ]
    const v = deriveStagnation(entries)
    expect(v.calls).toBe(7)
    expect(v.stagnant).toBe(false)
  })

  it('returns a non-stagnant zero verdict for an empty transcript, without throwing', () => {
    expect(() => deriveStagnation([])).not.toThrow()
    const v = deriveStagnation([])
    expect(v).toEqual({ stagnant: false, calls: 0, distinct: 0, topTarget: '', topCount: 0 })
  })

  it('excludes entries older than the window from calls', () => {
    const t0 = Date.parse('2026-07-22T12:00:00Z')
    const entries = [
      // 20 distinct, stale calls well outside the 5-minute window
      ...Array.from({ length: 20 }, (_, i) =>
        entry('Read', { file_path: `/repo/stale-${i}.ts` }, t0 + i * 1_000)
      ),
      // only 3 calls inside the window — below the floor
      ...Array.from({ length: 3 }, (_, i) =>
        entry('Bash', { command: 'npm test' }, t0 + 400_000 + i * 10_000)
      )
    ]
    const v = deriveStagnation(entries)
    expect(v.calls).toBe(3)
    expect(v.stagnant).toBe(false)
  })
})

describe('constants', () => {
  it('the busy-ness floor and mutation tools match the design spec', () => {
    expect(STAGNATION_WINDOW_MS).toBe(5 * 60_000)
    expect(STAGNATION_MIN_CALLS).toBe(8)
    expect(MUTATION_TOOLS.has('Edit')).toBe(true)
    expect(MUTATION_TOOLS.has('Write')).toBe(true)
    expect(MUTATION_TOOLS.has('NotebookEdit')).toBe(true)
    expect(MUTATION_TOOLS.has('MultiEdit')).toBe(true)
    expect(MUTATION_TOOLS.has('Bash')).toBe(false)
  })
})
