import { describe, it, expect } from 'vitest'
import { mergedSignal, resolveDetachedFate, resolveFate } from '../src/main/gc/fate-core'
import type { BranchFacts, PrFacts } from '../src/main/reaper/reaper-core'

const TIP = 'tipsha'

function pr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 92,
    state: 'MERGED',
    reviewDecision: 'APPROVED',
    ci: 'passing',
    mergedAt: '2026-07-01T00:00:00Z',
    headRefOid: TIP,
    ...over
  }
}

function facts(over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    kind: 'worktree',
    repoPath: '/repo',
    branch: 'feat/x',
    path: '/repo/.claude/worktrees/feat-x',
    hidden: false,
    sessionLive: false,
    trackedDirty: false,
    untracked: [],
    unpushed: false,
    remoteExists: false,
    ancestorOfDefault: null,
    patchIdContained: null,
    lastCommitAt: null,
    pr: null,
    ghAvailable: true,
    prSetComplete: true,
    prProvenance: 'own-name',
    ...over
  }
}

describe('mergedSignal (moved from reaper-core, behavior unchanged)', () => {
  it('gh-merged for a MERGED PR credited to the branch', () => {
    expect(mergedSignal(facts({ pr: pr() }))).toBe('gh-merged')
  })

  it('does not credit a MERGED PR found through an unverified shared upstream', () => {
    expect(mergedSignal(facts({ pr: pr(), prProvenance: 'upstream-unverified' }))).toBeNull()
  })

  it('ancestor, then squash-equivalent', () => {
    expect(mergedSignal(facts({ ancestorOfDefault: true }))).toBe('ancestor')
    expect(mergedSignal(facts({ patchIdContained: true }))).toBe('squash-equivalent')
  })

  it('remote-gone-after-close only when the ancestor probe is inconclusive', () => {
    const closed = pr({ state: 'CLOSED' })
    expect(mergedSignal(facts({ pr: closed }))).toBe('remote-gone-after-close')
    expect(mergedSignal(facts({ pr: closed, ancestorOfDefault: false }))).toBeNull()
  })
})

describe('resolveFate — the 5-step order', () => {
  it('1. merged: gh-merged with the local tip on the PR head is strong', () => {
    expect(resolveFate(facts({ pr: pr() }), TIP)).toEqual({
      fate: 'merged',
      signal: 'gh-merged',
      strong: true
    })
  })

  it('1. merged: ancestor is strong', () => {
    expect(resolveFate(facts({ ancestorOfDefault: true }), TIP)).toEqual({
      fate: 'merged',
      signal: 'ancestor',
      strong: true
    })
  })

  it('1. merged: squash-equivalent is strong', () => {
    expect(resolveFate(facts({ patchIdContained: true }), TIP)).toEqual({
      fate: 'merged',
      signal: 'squash-equivalent',
      strong: true
    })
  })

  it('1. merged: remote-gone-after-close is merged but never strong', () => {
    expect(resolveFate(facts({ pr: pr({ state: 'CLOSED' }) }), TIP)).toEqual({
      fate: 'merged',
      signal: 'remote-gone-after-close',
      strong: false
    })
  })

  it('2. closed-unmerged: a CLOSED PR the ancestor probe refutes', () => {
    const f = facts({ pr: pr({ state: 'CLOSED' }), ancestorOfDefault: false })
    expect(resolveFate(f, TIP)).toEqual({ fate: 'closed-unmerged', signal: null, strong: false })
  })

  it('2. closed-unmerged: a CLOSED PR whose remote branch still exists', () => {
    const f = facts({ pr: pr({ state: 'CLOSED' }), remoteExists: true })
    expect(resolveFate(f, TIP).fate).toBe('closed-unmerged')
  })

  it('3. open: an OPEN PR', () => {
    const f = facts({ pr: pr({ state: 'OPEN' }), remoteExists: false })
    expect(resolveFate(f, TIP)).toEqual({ fate: 'open', signal: null, strong: false })
  })

  it('3. open: no PR but the remote branch is alive', () => {
    expect(resolveFate(facts({ remoteExists: true }), TIP).fate).toBe('open')
  })

  it('4. remote-gone: no PR and the branch is absent from ls-remote', () => {
    expect(resolveFate(facts({ pr: null, remoteExists: false }), TIP)).toEqual({
      fate: 'remote-gone',
      signal: null,
      strong: false
    })
  })

  it('5. unknown: a MERGED PR nobody may credit and no remote answer', () => {
    const f = facts({ pr: pr(), prProvenance: 'upstream-unverified', remoteExists: false })
    expect(resolveFate(f, TIP).fate).toBe('unknown')
  })
})

describe('resolveFate — Review Focus', () => {
  it('RF1: a branch reused after its merge (tip ≠ headRefOid) is merged but NOT strong', () => {
    const r = resolveFate(facts({ pr: pr({ headRefOid: 'oldtip' }) }), 'newtip')
    expect(r).toEqual({ fate: 'merged', signal: 'gh-merged', strong: false })
  })

  it('RF2/RF5: gh failed (remoteExists null, no PR, no git proof) is unknown, never remote-gone', () => {
    const r = resolveFate(
      facts({ pr: null, remoteExists: null, ghAvailable: false, prSetComplete: false }),
      TIP
    )
    expect(r).toEqual({ fate: 'unknown', signal: null, strong: false })
  })

  it('RF3/RF4: a null headRefOid never matches a null local tip', () => {
    const r = resolveFate(facts({ pr: pr({ headRefOid: null }) }), null)
    expect(r).toEqual({ fate: 'merged', signal: 'gh-merged', strong: false })
  })

  it('a null headRefOid is not strong even when the local tip is known', () => {
    const r = resolveFate(facts({ pr: pr({ headRefOid: null }) }), TIP)
    expect(r).toEqual({ fate: 'merged', signal: 'gh-merged', strong: false })
  })

  it('a null local tip is not strong even when the PR head is known', () => {
    const r = resolveFate(facts({ pr: pr({ headRefOid: TIP }) }), null)
    expect(r).toEqual({ fate: 'merged', signal: 'gh-merged', strong: false })
  })

  it('a merge signal beats open: a merged branch whose remote was never deleted', () => {
    const r = resolveFate(facts({ ancestorOfDefault: true, remoteExists: true }), TIP)
    expect(r).toEqual({ fate: 'merged', signal: 'ancestor', strong: true })
  })

  it('a merge signal beats an OPEN PR on the same branch', () => {
    const r = resolveFate(facts({ pr: pr({ state: 'OPEN' }), ancestorOfDefault: true }), TIP)
    expect(r).toEqual({ fate: 'merged', signal: 'ancestor', strong: true })
  })

  it('a git-local proof still wins when gh is unavailable', () => {
    const r = resolveFate(
      facts({
        ghAvailable: false,
        prSetComplete: false,
        remoteExists: null,
        ancestorOfDefault: true
      }),
      null
    )
    expect(r).toEqual({ fate: 'merged', signal: 'ancestor', strong: true })
  })
})

describe('resolveDetachedFate', () => {
  it('is always detached, signal-less and never strong', () => {
    expect(resolveDetachedFate()).toEqual({ fate: 'detached', signal: null, strong: false })
  })
})
