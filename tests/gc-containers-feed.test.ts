import { describe, it, expect, beforeEach } from 'vitest'
import { buildSnapshot } from '../src/main/containers/containers-core'
import {
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
    setInheritedBuckets(new Map([[WT, 'corpse']]))
    expect(inheritedBucketFor(WT)).toBe('corpse')
    expect(inheritedBucketFor(`${WT}/`)).toBe('corpse')
    expect(inheritedBucketFor(WT2)).toBeUndefined()
  })

  it('replaces the previous snapshot instead of merging', () => {
    setInheritedBuckets(new Map([[WT, 'corpse']]))
    setInheritedBuckets(new Map([[WT2, 'alive']]))
    expect(inheritedBucketFor(WT)).toBeUndefined()
    expect(inheritedBucketFor(WT2)).toBe('alive')
  })
})

describe('Containers snapshot inherits the worktree bucket (AC-9)', () => {
  // A stack used 12 hours ago is far below zombieAfterDays (2): only the bucket can make it a zombie.
  const recent = composeContainer('proj-231', WT, { startedAt: NOW - 12 * 3_600_000 })
  const folders = [knownFolder(MAIN), knownFolder(WT, { lastActivityAt: NOW - 12 * 3_600_000 })]

  it('reads zombie immediately for a stack in a corpse worktree', () => {
    const snap = buildSnapshot(
      scanInput({ containers: [recent], folders, inheritedBucketOf: inheritedBucketFor })
    )
    setInheritedBuckets(new Map([[WT, 'corpse']]))
    const withFeed = buildSnapshot(
      scanInput({ containers: [recent], folders, inheritedBucketOf: inheritedBucketFor })
    )
    expect(snap.stacks[0]!.verdict).toBe('pending')
    expect(withFeed.stacks[0]!.verdict).toBe('zombie')
  })

  it('reads active for an alive worktree and pending for a decide one', () => {
    for (const [bucket, verdict] of [
      ['alive', 'active'],
      ['decide', 'pending']
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
    setInheritedBuckets(new Map([[MAIN, 'corpse']]))
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
