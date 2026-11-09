import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GATE_V2_SHA256,
  buildJudgeArgs,
  judgeConcurrency,
  parseVerdict
} from '../../src/main/your-move/gate'

const envelope = (result: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    is_error: false,
    result: typeof result === 'string' ? result : JSON.stringify(result),
    total_cost_usd: 0.0004,
    ...extra
  })

describe('buildJudgeArgs', () => {
  it('buildJudgeArgs is exact', () => {
    expect(buildJudgeArgs('/g.md')).toEqual([
      '-p',
      '--model',
      'haiku',
      '--effort',
      'low',
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--tools',
      '',
      '--system-prompt-file',
      '/g.md',
      '--output-format',
      'json'
    ])
  })
})

describe('parseVerdict', () => {
  it('parses the CLI json envelope, reading result and total_cost_usd', () => {
    const out = parseVerdict(
      envelope({
        new: [
          {
            kind: 'decide',
            ask: 'Pick A or B',
            options: ['A', 'B'],
            recommended: 'A',
            confidence: 'high',
            context: 'why',
            blocks: 'the deploy',
            evidence: 'quote'
          }
        ],
        update: [{ id: 'c1', ask: 'refreshed' }],
        close: ['c2']
      })
    )
    expect(out).toEqual({
      ok: true,
      costUsd: 0.0004,
      verdict: {
        new: [
          {
            kind: 'decide',
            ask: 'Pick A or B',
            options: ['A', 'B'],
            recommended: 'A',
            confidence: 'high',
            context: 'why',
            blocks: 'the deploy',
            evidence: 'quote'
          }
        ],
        update: [{ id: 'c1', ask: 'refreshed' }],
        close: ['c2']
      }
    })
  })

  it('accepts a fenced reply, an empty verdict and null for omitted optional fields', () => {
    const fenced =
      '```json\n{"new":[{"kind":"do","ask":"Merge","link":null,"context":null}],"update":[],"close":[]}\n```'
    const out = parseVerdict(envelope(fenced))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.verdict.new[0]).toEqual({ kind: 'do', ask: 'Merge' })
    expect(parseVerdict(envelope({ new: [], update: [], close: [] }))).toMatchObject({ ok: true })
  })

  it('rejects an unknown kind, a missing ask, and update entries that are bare strings', () => {
    const bad = (v: unknown) => parseVerdict(envelope(v))
    expect(bad({ new: [{ kind: 'nope', ask: 'x' }], update: [], close: [] }).ok).toBe(false)
    expect(bad({ new: [{ kind: 'decide' }], update: [], close: [] }).ok).toBe(false)
    expect(bad({ new: [{ kind: 'decide', ask: '' }], update: [], close: [] }).ok).toBe(false)
    expect(bad({ new: [], update: ['c1'], close: [] }).ok).toBe(false)
  })

  it('fails on a CLI error envelope, non-JSON stdout and a reply with no object', () => {
    expect(parseVerdict(envelope('boom', { is_error: true })).ok).toBe(false)
    expect(parseVerdict('Segmentation fault').ok).toBe(false)
    expect(parseVerdict(envelope('I cannot comply')).ok).toBe(false)
  })

  it('a missing cost reads as zero', () => {
    const out = parseVerdict(
      JSON.stringify({ result: '{"new":[],"update":[],"close":[]}', is_error: false })
    )
    expect(out).toMatchObject({ ok: true, costUsd: 0 })
  })
})

describe('judgeConcurrency', () => {
  it('judgeConcurrency: 20→4, 8→4, 4→2, 3→1, 1→1, never above half the cores', () => {
    expect([20, 8, 4, 3, 1].map(judgeConcurrency)).toEqual([4, 4, 2, 1, 1])
    for (let cores = 1; cores <= 64; cores++) {
      expect(judgeConcurrency(cores)).toBeLessThanOrEqual(Math.max(1, Math.floor(cores / 2)))
    }
  })
})

describe('gate-v2.md', () => {
  const file = readFileSync(path.join(__dirname, '../../resources/your-move/gate-v2.md'), 'utf8')

  it('gate-v2.md hash equals GATE_V2_SHA256', () => {
    expect(createHash('sha256').update(file).digest('hex')).toBe(GATE_V2_SHA256)
  })

  it('carries the v2 schema: refreshed ask in update, the extra fields, the new reply shape', () => {
    expect(file).toContain(
      'put its id and a refreshed one-line `ask` in `update` and do not file it again.'
    )
    expect(file).toContain('`blocks`, what cannot move until this is answered')
    expect(file).toContain('"update":[{"id":"card-id","ask":"..."}]')
    expect(file).not.toContain('"update":["card-id"]')
  })
})
