import { describe, it, expect } from 'vitest'
import { planArchive, archiveNamespace, formatArchiveStamp } from '../src/main/reaper/archive-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'

const AT = Date.UTC(2026, 7, 28, 18, 22, 33, 456)

function item(over: Partial<ReapItem> = {}): Pick<ReapItem, 'kind' | 'branch' | 'path'> {
  return { kind: 'worktree', branch: 'feat/x', path: '/repo/wt-x', ...over }
}

describe('formatArchiveStamp', () => {
  it('produces a ref-safe compact UTC stamp (no colons — git forbids them)', () => {
    expect(formatArchiveStamp(AT)).toBe('20260828T182233Z')
    expect(formatArchiveStamp(AT)).not.toContain(':')
  })
})

describe('archiveNamespace', () => {
  it('nests the sweep stamp under the branch name', () => {
    expect(archiveNamespace('feat/x', AT)).toBe('refs/archive/feat/x/20260828T182233Z')
  })

  it('gives two sweeps of the same branch name distinct namespaces', () => {
    const first = archiveNamespace('card/T254', AT)
    const second = archiveNamespace('card/T254', AT + 60_000)
    expect(first).not.toBe(second)
  })
})

describe('planArchive', () => {
  it('plans a tip and a wip ref for a worktree item, in that order', () => {
    const plan = planArchive(item(), AT)
    expect(plan.refs.map((r) => r.role)).toEqual(['tip', 'wip'])
    expect(plan.tip).toEqual({
      role: 'tip',
      ref: 'refs/archive/feat/x/20260828T182233Z/tip',
      rev: 'feat/x'
    })
    expect(plan.wip).toEqual({
      role: 'wip',
      ref: 'refs/archive/feat/x/20260828T182233Z/wip',
      worktreePath: '/repo/wt-x'
    })
  })

  it('plans both refs for a hidden folder too — hidden is a worktree that is out of sight', () => {
    const plan = planArchive(item({ kind: 'hidden-folder' }), AT)
    expect(plan.tip).not.toBeNull()
    expect(plan.wip).not.toBeNull()
  })

  it('plans no working state for a branch with no checkout', () => {
    const plan = planArchive(item({ kind: 'local-branch', path: undefined }), AT)
    expect(plan.tip).not.toBeNull()
    expect(plan.wip).toBeNull()
    expect(plan.refs).toHaveLength(1)
  })

  it('resolves a remote-branch tip from the remote-tracking ref', () => {
    const plan = planArchive(item({ kind: 'remote-branch', path: undefined }), AT)
    expect(plan.tip!.rev).toBe('refs/remotes/origin/feat/x')
    expect(plan.wip).toBeNull()
  })

  it('plans nothing when the item carries no branch', () => {
    const plan = planArchive({ kind: 'worktree', branch: undefined, path: '/x' }, AT)
    expect(plan).toEqual({ namespace: null, tip: null, wip: null, refs: [] })
  })

  it('never makes one ref a path prefix of the other (git refuses that pair)', () => {
    const plan = planArchive(item(), AT)
    const [tip, wip] = plan.refs.map((r) => r.ref)
    expect(wip.startsWith(`${tip}/`)).toBe(false)
    expect(tip.startsWith(`${wip}/`)).toBe(false)
  })

  it('keeps a branch whose name prefixes another branch in its own namespace', () => {
    const outer = planArchive(item({ branch: 'feat/x' }), AT)
    const inner = planArchive(item({ branch: 'feat/x/y' }), AT)
    expect(inner.tip!.ref.startsWith(`${outer.tip!.ref}/`)).toBe(false)
    expect(outer.tip!.ref).toBe('refs/archive/feat/x/20260828T182233Z/tip')
    expect(inner.tip!.ref).toBe('refs/archive/feat/x/y/20260828T182233Z/tip')
  })
})
