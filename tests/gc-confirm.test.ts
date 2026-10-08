import { describe, it, expect } from 'vitest'
import {
  bundleChangedSince,
  expectedOf,
  orphanExpectedOf,
  volumeChangedSince
} from '../src/main/gc/gc-confirm'
import type { OrphanVolumeItem } from '../src/main/gc/gc-housekeeping-input'
import { bundle, reapItem } from './gc-fixtures'

const withStacks = (stackIds: string[], ownedVolumes: string[] = []) =>
  bundle('/ws/wt/a', 'corpse', { stackIds, ownedVolumes })

const orphan = (over: Partial<OrphanVolumeItem> = {}): OrphanVolumeItem => ({
  id: 'volume:lost',
  name: 'lost',
  sizeBytes: 4_096,
  project: 'shop',
  reason: { code: 'no-known-worktree', detail: 'x' },
  ...over
})

describe('expectedOf: the facts the operator was shown', () => {
  it('reads bucket, reason, head, stacks, volumes and size off the bundle', () => {
    const b = bundle('/ws/wt/d', 'decide', {
      stackIds: ['s2', 's1'],
      ownedVolumes: ['v'],
      localTip: 'c'.repeat(40),
      reason: { code: 'dirty', detail: 'x' },
      item: reapItem('/ws/wt/d', { diskBytes: 77 })
    })
    expect(expectedOf(b)).toEqual({
      bucket: 'decide',
      reasonCode: 'dirty',
      headSha: 'c'.repeat(40),
      stackIds: ['s1', 's2'],
      ownedVolumes: ['v'],
      bytes: 77
    })
  })

  it('has no reason for a corpse and no head when the tip is unknown', () => {
    const b = bundle('/ws/wt/a', 'corpse', { localTip: null })
    expect(expectedOf(b)).toMatchObject({ reasonCode: null, headSha: null })
  })
})

describe('bundleChangedSince: what makes a confirmation stale (AC-8)', () => {
  it('accepts the same facts', () => {
    const b = withStacks(['s1'], ['v1'])
    expect(bundleChangedSince(b, expectedOf(b))).toBeNull()
  })

  it('ignores a size that drifted: disk use is not a change of facts', () => {
    const b = withStacks([])
    const seen = { ...expectedOf(b), bytes: 1 }
    expect(bundleChangedSince(b, seen)).toBeNull()
  })

  it('refuses a stack that started after the click', () => {
    const seen = expectedOf(withStacks(['s1']))
    expect(bundleChangedSince(withStacks(['s1', 's2']), seen)).toBe('stack')
  })

  it('refuses a volume that appeared after the click', () => {
    const seen = expectedOf(withStacks(['s1'], ['v1']))
    expect(bundleChangedSince(withStacks(['s1'], ['v1', 'v2']), seen)).toBe('volume')
  })

  it('accepts fewer stacks and volumes: less is not more at risk', () => {
    const seen = expectedOf(withStacks(['s1', 's2'], ['v1', 'v2']))
    expect(bundleChangedSince(withStacks(['s1'], ['v1']), seen)).toBeNull()
  })

  it('refuses a different bucket, even for a corpse that turned Decide', () => {
    const seen = expectedOf(bundle('/ws/wt/a', 'corpse'))
    expect(bundleChangedSince(bundle('/ws/wt/a', 'decide'), seen)).toBe('bucket')
  })

  it('refuses a different reason inside the same bucket', () => {
    const seen = expectedOf(
      bundle('/ws/wt/a', 'decide', { reason: { code: 'dirty', detail: 'x' } })
    )
    const now = bundle('/ws/wt/a', 'decide', { reason: { code: 'unpushed', detail: 'x' } })
    expect(bundleChangedSince(now, seen)).toBe('reason')
  })

  it('refuses a head that moved', () => {
    const seen = expectedOf(bundle('/ws/wt/a', 'corpse', { localTip: 'a'.repeat(40) }))
    expect(
      bundleChangedSince(bundle('/ws/wt/a', 'corpse', { localTip: 'b'.repeat(40) }), seen)
    ).toBe('head')
  })

  it('refuses when the head was unknown then and is known now, or the reverse', () => {
    const none = expectedOf(bundle('/ws/wt/a', 'corpse', { localTip: null }))
    expect(bundleChangedSince(bundle('/ws/wt/a', 'corpse'), none)).toBe('head')
  })
})

describe('volumeChangedSince', () => {
  it('accepts the same size and project', () => {
    expect(volumeChangedSince(orphan(), orphanExpectedOf(orphan()))).toBeNull()
  })

  it('refuses a volume that grew: somebody is writing to it', () => {
    expect(volumeChangedSince(orphan({ sizeBytes: 9_999 }), orphanExpectedOf(orphan()))).toBe(
      'size'
    )
  })

  it('refuses a volume that now belongs to another project', () => {
    expect(volumeChangedSince(orphan({ project: 'other' }), orphanExpectedOf(orphan()))).toBe(
      'project'
    )
  })

  it('refuses an expectation that is not for an orphan volume', () => {
    expect(volumeChangedSince(orphan(), expectedOf(bundle('/ws/wt/a', 'corpse')))).toBe('bucket')
  })
})
