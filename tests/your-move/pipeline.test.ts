import { describe, expect, it } from 'vitest'
import type { JudgeNew, Verdict } from '../../src/main/your-move/core'
import {
  combineDetections,
  dedupeCandidates,
  normalizeAsk
} from '../../src/main/your-move/pipeline'
import { renderForEnrich } from '../../src/main/your-move/segment'

const c = (ask: string): JudgeNew => ({ kind: 'decide', ask })
const v = (over: Partial<Verdict> = {}): Verdict => ({ new: [], update: [], close: [], ...over })

describe('normalizeAsk', () => {
  it('ignores case, punctuation, accents and spacing', () => {
    expect(normalizeAsk('  Merge   PR #167 (hotfix)! ')).toBe(normalizeAsk('merge pr 167 hotfix'))
    expect(normalizeAsk('Café déjà vu?')).toBe(normalizeAsk('cafe deja vu'))
    expect(normalizeAsk('Pick A')).not.toBe(normalizeAsk('Pick B'))
  })
})

describe('dedupeCandidates', () => {
  it('keeps the first of each normalized text, in order', () => {
    const out = dedupeCandidates([c('Merge it.'), c('Send key'), c('merge IT')])
    expect(out.map((x) => x.ask)).toEqual(['Merge it.', 'Send key'])
  })
})

describe('combineDetections', () => {
  it('new and update are unions, close is the intersection', () => {
    const out = combineDetections(
      v({ new: [c('X')], update: [{ id: 'u1' }], close: ['a', 'b'] }),
      v({ new: [c('Y'), c('x')], update: [{ id: 'u2' }, { id: 'u1' }], close: ['b', 'c'] })
    )
    expect(out.new.map((x) => x.ask)).toEqual(['X', 'Y'])
    expect(out.update.map((u) => u.id)).toEqual(['u1', 'u2'])
    expect(out.close).toEqual(['b'])
  })
})

describe('renderForEnrich', () => {
  it('appends the candidates to the detector input', () => {
    const out = renderForEnrich([], [{ tag: 'ASSISTANT', text: 'hi' }], [c('X')])
    expect(out).toBe(
      'OPEN_CARDS: []\n\nSEGMENT:\n[ASSISTANT] hi\n\nCANDIDATES: [{"kind":"decide","ask":"X"}]'
    )
  })
})
