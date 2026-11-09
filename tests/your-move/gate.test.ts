import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ENRICH_V1_SHA256,
  GATE_V1_SHA256,
  buildJudgeArgs,
  judgeConcurrency,
  parseEnrichment,
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
        update: ['c1'],
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
        update: [{ id: 'c1' }],
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

  it('rejects an unknown kind, a missing ask, and update entries that are not ids', () => {
    const bad = (v: unknown) => parseVerdict(envelope(v))
    expect(bad({ new: [{ kind: 'nope', ask: 'x' }], update: [], close: [] }).ok).toBe(false)
    expect(bad({ new: [{ kind: 'decide' }], update: [], close: [] }).ok).toBe(false)
    expect(bad({ new: [{ kind: 'decide', ask: '' }], update: [], close: [] }).ok).toBe(false)
    expect(bad({ new: [], update: [7], close: [] }).ok).toBe(false)
    expect(bad({ new: [], update: [{ ask: 'no id' }], close: [] }).ok).toBe(false)
  })

  it("accepts v1's bare-id update and an {id, ask} object alike; a bare id carries no ask", () => {
    const out = parseVerdict(
      envelope({ new: [], update: ['c1', { id: 'c2', ask: 'x' }], close: [] })
    )
    expect(out.ok && out.verdict.update).toEqual([{ id: 'c1' }, { id: 'c2', ask: 'x' }])
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

describe('parseEnrichment', () => {
  it('reads the enriched cards from the envelope, with the extra fields', () => {
    const out = parseEnrichment(
      envelope({
        new: [
          {
            kind: 'do',
            ask: 'Merge PR #1',
            context: 'it unblocks the deploy',
            blocks: 'the deploy',
            link: 'https://example.com/pr/1',
            confidence: 'high'
          }
        ]
      })
    )
    expect(out).toMatchObject({ ok: true, costUsd: 0.0004 })
    expect(out.ok && out.cards[0]).toMatchObject({ kind: 'do', context: 'it unblocks the deploy' })
  })

  it('an empty list parses (the caller decides it is not enough); junk does not', () => {
    expect(parseEnrichment(envelope({ new: [] }))).toMatchObject({ ok: true, cards: [] })
    expect(parseEnrichment(envelope('no json here')).ok).toBe(false)
    expect(parseEnrichment(envelope({ new: [{ kind: 'nope', ask: 'x' }] })).ok).toBe(false)
    expect(parseEnrichment('boom').ok).toBe(false)
  })
})

describe('prompt resources', () => {
  const read = (name: string) =>
    readFileSync(path.join(__dirname, '../../resources/your-move', name), 'utf8')
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  it('gate-v1.md hash equals GATE_V1_SHA256, and that is the frozen gate v1', () => {
    expect(sha(read('gate-v1.md'))).toBe(GATE_V1_SHA256)
    // the bytes the 2026-11-08/09 eval was measured on
    expect(GATE_V1_SHA256).toBe('873be6bd858a8e8fe71712ad2744ddaf4c4dda423af077dec9cb18b265d4e310')
    expect(read('gate-v1.md')).toContain('"update":["card-id"]')
  })

  it('enrich-v1.md hash equals ENRICH_V1_SHA256; a wording change must re-run the eval', () => {
    expect(sha(read('enrich-v1.md'))).toBe(ENRICH_V1_SHA256)
    expect(read('enrich-v1.md')).toContain('CANDIDATES')
  })

  it('gate v2 is gone', () => {
    expect(existsSync(path.join(__dirname, '../../resources/your-move/gate-v2.md'))).toBe(false)
  })
})
