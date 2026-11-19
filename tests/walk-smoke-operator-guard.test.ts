/**
 * BUG-298 (AC-4): W-12 must not fail because another session wrote to the operator's real `.harnu/` during the run,
 * and must still fail when the instance under test did. Planted faults (each turns the named test red): treat every
 * change as a leak (the old behaviour); treat every change as foreign; ignore a vanished file.
 */
import { describe, expect, it } from 'vitest'
import { attributeChanges } from '../scripts/verify/guided-test-walk/operator-guard.mjs'

const RUN = ['/tmp/hv-walk-ab12', 'hv-walk-ab12']
const texts: Record<string, string> = {}
const read = (f: string) => {
  if (!(f in texts)) throw new Error('ENOENT')
  return texts[f]
}

describe('attributeChanges', () => {
  it('a file nobody touched is not reported', () => {
    expect(attributeChanges({ a: 'h1' }, { a: 'h1' }, read, RUN)).toEqual({
      leaked: [],
      foreign: []
    })
  })

  it("another session's write (a changed mission, a new one) is foreign, not a leak", () => {
    texts.m1 = 'goal: ship the missions redesign'
    texts.m2 = 'goal: notification sounds'
    const r = attributeChanges({ m1: 'old' }, { m1: 'new', m2: 'x' }, read, RUN)
    expect(r.leaked).toEqual([])
    expect(r.foreign.sort()).toEqual(['m1', 'm2'])
  })

  it('a file that mentions this run directory or its id is a leak', () => {
    texts.w1 = 'folder: /tmp/hv-walk-ab12/example-web'
    texts.w2 = 'owner session of hv-walk-ab12'
    const r = attributeChanges({}, { w1: 'x', w2: 'y' }, read, RUN)
    expect(r.leaked.sort()).toEqual(['w1', 'w2'])
    expect(r.foreign).toEqual([])
  })

  it('a changed real file that now mentions this run is a leak even if it also held older content', () => {
    texts.m3 = 'old goal\nfolder: /tmp/hv-walk-ab12/example-web'
    expect(attributeChanges({ m3: 'old' }, { m3: 'new' }, read, RUN).leaked).toEqual(['m3'])
  })

  it('a vanished file is always a leak: nobody else removes these records', () => {
    const r = attributeChanges({ gone: 'h' }, {}, read, RUN)
    expect(r.leaked).toEqual(['gone'])
  })
})
