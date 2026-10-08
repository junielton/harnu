import { describe, it, expect, beforeEach } from 'vitest'
import { buildSnapshot } from '../src/main/containers/containers-core'
import {
  bucketFeed,
  bucketLookup,
  clearInheritedBuckets,
  inheritedBucketFor,
  setInheritedBuckets
} from '../src/main/gc/gc-buckets'
import {
  DAY,
  MAIN,
  NOW,
  WT,
  WT2,
  composeContainer,
  knownFolder,
  scanInput
} from './containers-fixtures'

beforeEach(() => clearInheritedBuckets())

describe('gc-buckets: the last GC snapshot, keyed by worktree path', () => {
  it('returns nothing before a snapshot was recorded', () => {
    expect(inheritedBucketFor(WT)).toBeUndefined()
  })

  it('answers for a recorded path, ignoring a trailing slash', () => {
    setInheritedBuckets(new Map([[WT, 'ready']]))
    expect(inheritedBucketFor(WT)).toBe('ready')
    expect(inheritedBucketFor(`${WT}/`)).toBe('ready')
    expect(inheritedBucketFor(WT2)).toBeUndefined()
  })

  it('replaces the previous snapshot instead of merging', () => {
    setInheritedBuckets(new Map([[WT, 'ready']]))
    setInheritedBuckets(new Map([[WT2, 'in-use']]))
    expect(inheritedBucketFor(WT)).toBeUndefined()
    expect(inheritedBucketFor(WT2)).toBe('in-use')
  })
})

describe('Containers snapshot inherits the worktree bucket (AC-9)', () => {
  // A stack used 12 hours ago is far below zombieAfterDays (2): only the bucket can make it a zombie.
  const recent = composeContainer('proj-231', WT, { startedAt: NOW - 12 * 3_600_000 })
  const folders = [knownFolder(MAIN), knownFolder(WT, { lastActivityAt: NOW - 12 * 3_600_000 })]

  it('reads zombie immediately for a stack in a ready item worktree', () => {
    const snap = buildSnapshot(
      scanInput({ containers: [recent], folders, inheritedBucketOf: inheritedBucketFor })
    )
    setInheritedBuckets(new Map([[WT, 'ready']]))
    const withFeed = buildSnapshot(
      scanInput({ containers: [recent], folders, inheritedBucketOf: inheritedBucketFor })
    )
    expect(snap.stacks[0]!.verdict).toBe('pending')
    expect(withFeed.stacks[0]!.verdict).toBe('zombie')
  })

  it('reads active for an in-use worktree and pending for a review one', () => {
    for (const [bucket, verdict] of [
      ['in-use', 'active'],
      ['review', 'pending']
    ] as const) {
      setInheritedBuckets(new Map([[WT, bucket]]))
      const snap = buildSnapshot(
        scanInput({
          containers: [composeContainer('proj-231', WT, { startedAt: NOW - 10 * DAY })],
          folders,
          inheritedBucketOf: inheritedBucketFor
        })
      )
      expect(snap.stacks[0]!.verdict).toBe(verdict)
    }
  })

  it('keeps the idle clock for a stack whose worktree has no recorded bucket', () => {
    const old = composeContainer('proj-231', WT, { startedAt: NOW - 10 * DAY })
    const snap = buildSnapshot(
      scanInput({
        containers: [old],
        folders: [knownFolder(MAIN), knownFolder(WT, { lastActivityAt: NOW - 10 * DAY })],
        inheritedBucketOf: inheritedBucketFor
      })
    )
    expect(snap.stacks[0]!.verdict).toBe('zombie')
  })

  it('ignores the bucket for a stack in the main checkout', () => {
    setInheritedBuckets(new Map([[MAIN, 'ready']]))
    const snap = buildSnapshot(
      scanInput({
        containers: [composeContainer('proj', MAIN, { startedAt: NOW - 10 * DAY })],
        folders,
        inheritedBucketOf: inheritedBucketFor
      })
    )
    expect(snap.stacks[0]!.verdict).toBe('protected')
  })

  it('does not change a snapshot built without the feed', () => {
    const snap = buildSnapshot(scanInput({ containers: [recent], folders }))
    expect(snap.stacks[0]!.verdict).toBe('pending')
  })
})

describe('bucketFeed: the path → bucket map built from a gather', () => {
  it('maps each bundle with a path to its bucket', () => {
    const feed = bucketFeed([
      { item: { path: '/ws/a' }, bucket: 'ready' },
      { item: { path: '/ws/b' }, bucket: 'in-use' },
      { item: {}, bucket: 'review' }
    ] as never)
    expect([...feed]).toEqual([
      ['/ws/a', 'ready'],
      ['/ws/b', 'in-use']
    ])
  })
})

describe('a stack run from a subfolder of the worktree inherits the worktree bucket', () => {
  it('walks up to the deepest recorded ancestor', () => {
    setInheritedBuckets(new Map([[WT, 'ready']]))
    expect(inheritedBucketFor(`${WT}/api/docker`)).toBe('ready')
  })

  it('does not match a sibling that merely shares a name prefix', () => {
    setInheritedBuckets(new Map([[WT, 'ready']]))
    expect(inheritedBucketFor(`${WT}-2/api`)).toBeUndefined()
  })

  it('prefers the deepest recorded folder', () => {
    setInheritedBuckets(
      new Map([
        [WT, 'ready'],
        [`${WT}/nested`, 'in-use']
      ])
    )
    expect(inheritedBucketFor(`${WT}/nested/x`)).toBe('in-use')
  })

  it('makes the stack a zombie when only a subfolder is attributed', () => {
    setInheritedBuckets(new Map([[WT, 'ready']]))
    const sub = composeContainer('proj-231', `${WT}/api`, { startedAt: NOW - 12 * 3_600_000 })
    const snap = buildSnapshot(
      scanInput({
        containers: [sub],
        folders: [knownFolder(MAIN), knownFolder(WT)],
        inheritedBucketOf: inheritedBucketFor
      })
    )
    expect(snap.stacks[0]!.verdict).toBe('zombie')
  })
})

describe('the feed is keyed on real paths (delta 3b, item 12)', () => {
  const canonical = (p: string) => ({
    path: p.startsWith('/link/') ? `/real/${p.slice('/link/'.length)}` : p,
    resolved: true
  })
  const entry = (path: string, bucket: 'ready' | 'review' | 'in-use') =>
    ({ item: { path }, bucket }) as never

  it('records a worktree under its real location when a resolver is given', () => {
    const feed = bucketFeed([entry('/link/wt', 'ready')], canonical)
    expect([...feed]).toEqual([['/real/wt', 'ready']])
  })

  it('finds the stack of a worktree spelled through the symlink', () => {
    setInheritedBuckets(bucketFeed([entry('/link/wt', 'ready')], canonical))
    expect(inheritedBucketFor('/real/wt/api')).toBe('ready')
  })

  it('looks a stack up by the real path of its attributed folder', () => {
    setInheritedBuckets(bucketFeed([entry('/real/wt', 'ready')], canonical))
    const realOf = new Map([['/link/wt/api', '/real/wt/api']])
    expect(bucketLookup(realOf)('/link/wt/api')).toBe('ready')
  })

  it('falls back to the spelling when the real path is unknown', () => {
    setInheritedBuckets(new Map([['/ws/wt', 'in-use']]))
    expect(bucketLookup(new Map())('/ws/wt/api')).toBe('in-use')
  })

  it('without a resolver the keys are the spellings, as before', () => {
    expect([...bucketFeed([entry('/ws/a', 'ready')])]).toEqual([['/ws/a', 'ready']])
  })
})
