import { describe, expect, it } from 'vitest'
import { compose, mergePart } from '../src/main/telemetry-compose-core'
import type { SessionTelemetry } from '../src/main/statusline-parse'
import { baseModelId, prettyModelName } from '../src/shared/model-name'

const SL: SessionTelemetry = {
  sessionId: 's1',
  cwd: '/work/example-web',
  modelId: 'claude-sonnet-5-5',
  modelName: 'Sonnet 5.5',
  costUsd: 1,
  linesAdded: null,
  linesRemoved: null,
  durationMs: null,
  contextPercent: 10,
  contextWindowSize: 200_000,
  exceeds200k: false,
  effortLevel: null,
  thinkingEnabled: false,
  outputStyle: null,
  pr: null,
  rateLimits: { fiveHour: null, sevenDay: null },
  updatedAtMs: 1_000
}

describe('compose: the model name follows the companion (T577)', () => {
  it('/model fable: the statusLine still says Sonnet, the chip says Fable', () => {
    const part = mergePart(null, { cwd: null, model: { id: 'claude-fable-5-1', atMs: 5_000 } })
    const out = compose(SL, part, true, 's1')!
    expect(out.modelId).toBe('claude-fable-5-1')
    expect(out.modelName).toBe('Fable 5.1')
    expect(out.updatedAtMs).toBe(5_000)
  })

  it('the statusLine keeps its richer display name when both name the same model', () => {
    const sl = { ...SL, modelId: 'claude-opus-4-8', modelName: 'Opus 4.8 (1M context)' }
    const part = mergePart(null, { cwd: null, model: { id: 'claude-opus-4-8[1m]', atMs: 5_000 } })
    expect(compose(sl, part, true, 's1')!.modelName).toBe('Opus 4.8 (1M context)')
  })

  it('with no statusLine at all the companion alone names the model', () => {
    const part = mergePart(null, { cwd: '/w', model: { id: 'claude-haiku-4-5-20251001', atMs: 7 } })
    const out = compose(null, part, true, 's1')!
    expect(out.modelName).toBe('Haiku 4.5')
    expect(out.updatedAtMs).toBe(7)
  })

  it('not owned: the statusLine record passes through untouched', () => {
    const part = mergePart(null, { cwd: null, model: { id: 'claude-fable-5-1', atMs: 5_000 } })
    expect(compose(SL, part, false, 's1')).toBe(SL)
  })

  it('model-name helpers', () => {
    expect(prettyModelName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(baseModelId('claude-opus-4-8[1m]')).toBe('claude-opus-4-8')
    expect(baseModelId('claude-opus-4-8')).toBe('claude-opus-4-8')
  })
})
