// Delta 2 item 2: `removability()` answers with the FIRST cause main would refuse for; a guided action
// also needs the WHOLE list, so two stacked causes (a shared stack and a lock) are not a dead end.

import { describe, expect, it } from 'vitest'
import { bundle, NOW, reapItem } from './gc-fixtures'
import {
  bundleRemovability,
  bundleRemovabilityAll,
  removability,
  removabilityAll
} from '../src/renderer/src/lib/gc-removability'
import { buildGcModel } from '../src/renderer/src/lib/gc-model'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { BundleFacts } from '../src/main/gc/bundle-core'

const PATH = '/ws/wt'
const review = (over: Partial<BundleFacts> = {}) => {
  const b = bundle(PATH, 'review', { reason: { code: 'dirty', detail: 'x' }, ...over })
  b.item = reapItem(PATH)
  return b
}
const reasons = (b: ReturnType<typeof review>) => bundleRemovabilityAll(b, NOW).map((r) => r.reason)

describe('bundleRemovabilityAll', () => {
  it('a removable item has no cause', () => {
    expect(reasons(review())).toEqual([])
  })

  it('one cause is a list of one', () => {
    expect(reasons(review({ locked: true }))).toEqual(['locked'])
  })

  it('a shared stack AND a lock: both, in the order main judges them', () => {
    expect(reasons(review({ sharedStackIds: ['web'], locked: true }))).toEqual([
      'shared-stack',
      'locked'
    ])
  })

  it('an idle session AND a lock', () => {
    expect(reasons(review({ session: 'open-idle', locked: true }))).toEqual([
      'session-open',
      'locked'
    ])
  })

  it('all three that a prep can fix', () => {
    expect(
      reasons(review({ sharedStackIds: ['web'], session: 'open-idle', locked: true }))
    ).toEqual(['shared-stack', 'session-open', 'locked'])
  })

  it('a cause no prep can fix is in the list too', () => {
    expect(reasons(review({ locked: true, keep: true }))).toEqual(['kept', 'locked'])
  })

  it('carries the hint of each cause', () => {
    const all = bundleRemovabilityAll(review({ locked: true }), NOW)
    expect(all[0]).toMatchObject({ reason: 'locked', hint: expect.stringContaining('unlock') })
  })

  it('the first of the list IS what removability() has always answered', () => {
    for (const b of [
      review(),
      review({ locked: true }),
      review({ sharedStackIds: ['web'], locked: true }),
      review({ keep: true, locked: true }),
      review({ session: 'open-idle', locked: true })
    ]) {
      const first = bundleRemovability(b, NOW)
      const all = bundleRemovabilityAll(b, NOW)
      expect(first.ok ? [] : [first.reason]).toEqual(all.slice(0, 1).map((r) => r.reason))
    }
  })

  it('the block-level wrapper agrees', () => {
    const m = buildGcModel({
      scannedAt: NOW,
      bundles: [review({ sharedStackIds: ['web'], locked: true })],
      orphanVolumes: [],
      docker: { buildCacheReclaimableBytes: null, danglingImages: null },
      prefs: defaultGcPrefs(),
      lastCycle: null,
      nextCycleAt: null,
      nextClean: null,
      backgroundScan: true
    })
    const block = m.blocks[0]
    expect(removabilityAll(block, NOW).map((r) => r.reason)).toEqual(['shared-stack', 'locked'])
    const first = removability(block, NOW)
    expect(first.ok ? null : first.reason).toBe('shared-stack')
  })

  it('an orphan volume has no cause (main decides at the click)', () => {
    expect(removabilityAll({ kind: 'volume', bundle: null } as never, NOW)).toEqual([])
  })
})
