import { describe, it, expect } from 'vitest'
import {
  ARTIFACT_KEYS,
  artifactRequirements,
  declaresArchitecturalDecision,
  lintCardReadiness
} from '../src/renderer/src/stores/roadmap'

/**
 * T130 S3: the renderer mirror of `roadmap-core`'s artifact model, ported
 * against the SAME cases as `tests/roadmap-core.test.ts` — the two must never
 * diverge (that's what "single predicate, never disagree" means in practice).
 */

describe('stores/roadmap declaresArchitecturalDecision (mirror)', () => {
  it('is false with neither the field nor the heading', () => {
    expect(declaresArchitecturalDecision({ body: 'just prose', adr: undefined })).toBe(false)
  })

  it('is true when the adr: field is present', () => {
    expect(declaresArchitecturalDecision({ body: 'just prose', adr: 'docs/adr/0002-x.md' })).toBe(
      true
    )
  })

  it('is true when the body has an "## Architectural decision" heading, even with no field', () => {
    expect(
      declaresArchitecturalDecision({
        body: '## Architectural decision\nWe chose X over Y.',
        adr: undefined
      })
    ).toBe(true)
  })
})

describe('stores/roadmap artifactRequirements (mirror)', () => {
  it('trivial/simple require nothing', () => {
    for (const complexity of ['trivial', 'simple'] as const) {
      const reqs = artifactRequirements({
        complexity,
        body: '',
        spec: undefined,
        prd: undefined,
        adr: undefined
      })
      expect(reqs.every((r) => !r.required)).toBe(true)
    }
  })

  it('standard requires spec only', () => {
    const reqs = artifactRequirements({
      complexity: 'standard',
      body: '',
      spec: undefined,
      prd: undefined,
      adr: undefined
    })
    expect(reqs).toEqual([
      { key: 'spec', required: true, present: false },
      { key: 'prd', required: false, present: false },
      { key: 'adr', required: false, present: false }
    ])
  })

  it('complex requires spec AND prd', () => {
    const reqs = artifactRequirements({
      complexity: 'complex',
      body: '',
      spec: 'docs/specs/x.md',
      prd: undefined,
      adr: undefined
    })
    expect(reqs).toEqual([
      { key: 'spec', required: true, present: true },
      { key: 'prd', required: true, present: false },
      { key: 'adr', required: false, present: false }
    ])
  })

  it('adr is required only when declared, independent of tier', () => {
    const reqs = artifactRequirements({
      complexity: 'trivial',
      body: '## Architectural decision\nchose X',
      spec: undefined,
      prd: undefined,
      adr: undefined
    })
    expect(reqs.find((r) => r.key === 'adr')).toEqual({
      key: 'adr',
      required: true,
      present: false
    })
  })

  it('renders in the fixed spec/prd/adr order', () => {
    expect(ARTIFACT_KEYS).toEqual(['spec', 'prd', 'adr'])
  })
})

describe('stores/roadmap lintCardReadiness (mirror, extended T130 S3)', () => {
  it('standard without spec surfaces missing-spec', () => {
    const gaps = lintCardReadiness({
      complexity: 'standard',
      body: '## Acceptance criteria\ndone',
      spec: undefined
    })
    expect(gaps).toEqual([{ code: 'missing-spec' }])
  })

  it('complex without spec or prd surfaces both gaps alongside the AC gap', () => {
    const gaps = lintCardReadiness({
      complexity: 'complex',
      body: 'no sections',
      spec: undefined,
      prd: undefined
    })
    expect(gaps.map((g) => g.code).sort()).toEqual(
      ['missing-acceptance-criteria', 'missing-prd', 'missing-spec'].sort()
    )
  })

  it('complex with spec and prd is satisfied', () => {
    const gaps = lintCardReadiness({
      complexity: 'complex',
      body: '## Acceptance criteria\ndone',
      spec: 'roadmap/tasks/prd/x.md',
      prd: 'docs/prds/x.md'
    })
    expect(gaps).toEqual([])
  })

  it('a declared-but-missing adr surfaces missing-adr regardless of tier', () => {
    const gaps = lintCardReadiness({
      complexity: 'trivial',
      body: '## Architectural decision\nchose X',
      spec: undefined,
      prd: undefined,
      adr: undefined
    })
    expect(gaps).toEqual([{ code: 'missing-adr' }])
  })

  it('trivial/simple never gate on acceptance/spec/prd', () => {
    expect(lintCardReadiness({ complexity: 'trivial', body: '', spec: undefined })).toEqual([])
    expect(lintCardReadiness({ complexity: 'simple', body: '', spec: undefined })).toEqual([])
  })
})
