import { describe, it, expect } from 'vitest'
import {
  planArchive,
  archiveNamespace,
  detachedArchiveNamespace,
  formatArchiveStamp
} from '../src/main/reaper/archive-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'

const AT = Date.UTC(2026, 7, 28, 18, 22, 33, 456)

function item(
  over: Partial<ReapItem> = {}
): Pick<ReapItem, 'kind' | 'branch' | 'path' | 'headSha'> {
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

// ---- detached worktrees (NDE-A): no branch to name a ref after, so the HEAD sha does -------------

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'

describe('detachedArchiveNamespace', () => {
  it('puts the archive time first, then the folder name and the short HEAD sha (AC-E2)', () => {
    expect(detachedArchiveNamespace('/ws/org/proj/worktrees/bisect-1', HEAD, AT)).toBe(
      'refs/archive/detached/20260828T182233Z/bisect-1-abcdef012345'
    )
  })

  it('turns a folder name git would refuse into a legal ref component', () => {
    for (const name of ['my wt', '.hidden', 'a..b', 'x.lock', 'we~ird^name:1', '-dash', '']) {
      const ns = detachedArchiveNamespace(`/ws/${name}`, HEAD, AT)
      const leaf = ns.slice('refs/archive/detached/20260828T182233Z/'.length)
      expect(leaf, name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*-abcdef012345$/)
      expect(leaf, name).not.toContain('..')
      expect(leaf, name).not.toMatch(/\.lock-/)
    }
  })

  it('tells two folders with the same HEAD apart by name, and one folder at two commits by sha', () => {
    const a = detachedArchiveNamespace('/ws/a', HEAD, AT)
    expect(detachedArchiveNamespace('/ws/b', HEAD, AT)).not.toBe(a)
    expect(detachedArchiveNamespace('/ws/a', 'f'.repeat(40), AT)).not.toBe(a)
  })

  it('gives two removals of the same folder at the same commit their own dated namespace', () => {
    const first = detachedArchiveNamespace('/ws/a', HEAD, AT)
    const second = detachedArchiveNamespace('/ws/a', HEAD, AT + 86_400_000)
    expect(second).not.toBe(first)
    expect(second).toBe('refs/archive/detached/20260829T182233Z/a-abcdef012345')
  })
})

describe('planArchive — a detached worktree', () => {
  const detached = (over: Partial<ReapItem> = {}): ReturnType<typeof item> =>
    item({
      kind: 'detached-worktree',
      branch: undefined,
      path: '/ws/org/proj/worktrees/bisect-1',
      headSha: HEAD,
      ...over
    })

  it('plans a tip at the HEAD sha and a wip of the folder, under refs/archive/detached', () => {
    const plan = planArchive(detached(), AT)
    const NS = 'refs/archive/detached/20260828T182233Z/bisect-1-abcdef012345'
    expect(plan.namespace).toBe(NS)
    expect(plan.refs.map((r) => r.role)).toEqual(['tip', 'wip'])
    expect(plan.tip).toEqual({
      role: 'tip',
      ref: `${NS}/tip`,
      rev: HEAD
    })
    expect(plan.wip).toEqual({
      role: 'wip',
      ref: `${NS}/wip`,
      worktreePath: '/ws/org/proj/worktrees/bisect-1'
    })
  })

  it('plans nothing without a recorded HEAD: nothing could be named or resolved', () => {
    expect(planArchive(detached({ headSha: null }), AT)).toEqual({
      namespace: null,
      tip: null,
      wip: null,
      refs: []
    })
    expect(planArchive(detached({ headSha: undefined }), AT).refs).toEqual([])
  })

  it('plans nothing without a folder, and never reads the branch of a plain worktree as detached', () => {
    expect(planArchive(detached({ path: undefined }), AT).refs).toEqual([])
    expect(planArchive(item({ branch: undefined, headSha: HEAD }), AT).refs).toEqual([])
  })

  it('never makes one ref a path prefix of the other', () => {
    const [tip, wip] = planArchive(detached(), AT).refs.map((r) => r.ref)
    expect(wip.startsWith(`${tip}/`)).toBe(false)
    expect(tip.startsWith(`${wip}/`)).toBe(false)
  })
})
