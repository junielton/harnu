import { describe, it, expect, vi } from 'vitest'
import {
  cleanItem,
  matchAdminDir,
  sweep,
  type ExecutorDeps,
  type CleanResult
} from '../src/main/reaper/executor-core'
import {
  overridesAncestryCheck,
  MERGE_SIGNAL_OVERRIDES_ANCESTRY,
  type MergeSignal,
  type ReapItem
} from '../src/main/reaper/reaper-core'
import type { Tombstone } from '../src/main/reaper/journal'

function harvestableItem(over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: 'item-1',
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'feat/x',
    path: '/repo/wt-x',
    hidden: false,
    ageDays: 12,
    diskBytes: 1000,
    checkpoints: [],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    justifiedBy: 'gh-merged',
    ...over
  }
}

function fakeDeps(overrides: Partial<ExecutorDeps> = {}): {
  deps: ExecutorDeps
  journal: Tombstone[]
  archived: string[]
} {
  const journal: Tombstone[] = []
  const archived: string[] = []
  const deps: ExecutorDeps = {
    probeStatus: vi.fn(async () => ({ trackedDirty: false, untracked: [] })),
    hasUnpushed: vi.fn(async () => false),
    trash: vi.fn(async () => undefined),
    git: vi.fn(async () => ''),
    resolveSha: vi.fn(async () => 'sha123'),
    archiveTip: vi.fn(async (_repo: string, ref: string, sha: string) => {
      archived.push(ref)
      return sha
    }),
    archiveWip: vi.fn(async (_repo: string, ref: string) => {
      archived.push(ref)
      return 'wipsha1'
    }),
    detachSidebar: vi.fn(async () => undefined),
    removeWorktreeAdmin: vi.fn(async () => undefined),
    appendTombstone: vi.fn(async (t: Tombstone) => {
      journal.push(t)
    }),
    now: () => 1_800_000_000_000,
    ...overrides
  }
  return { deps, journal, archived }
}

describe('cleanItem', () => {
  it('runs the full pipeline in order and writes a tombstone with restore hint', async () => {
    const { deps, journal } = fakeDeps()
    const item = harvestableItem()
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(true)
    expect(result.steps.map((s) => s.id)).toEqual([
      'guard',
      'archive',
      'trash-folder',
      'worktree-prune',
      'branch-delete',
      'remote-delete',
      'sidebar-detach',
      'journal'
    ])
    expect(result.steps.find((s) => s.id === 'remote-delete')!.skipped).toBe(true)

    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({
      repoPath: item.repoPath,
      branch: item.branch,
      sha: 'sha123',
      justifiedBy: item.justifiedBy,
      restoreHint: `git branch ${item.branch} sha123`
    })
    expect(journal[0].deleted).toEqual([
      'archive',
      'trash-folder',
      'worktree-prune',
      'branch-delete',
      'sidebar-detach'
    ])
  })

  it('refuses via guard when verdict is not harvestable, with no further steps', async () => {
    const { deps, journal } = fakeDeps()
    const item = harvestableItem({ verdict: 'blocked' })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    expect(result.steps).toEqual([
      { id: 'guard', ok: false, skipped: false, error: expect.any(String) }
    ])
    expect(deps.trash).not.toHaveBeenCalled()
    expect(journal).toHaveLength(0)
  })

  /**
   * BUG-75 — the classifier fix delivers nothing unless the executor's re-probe
   * splits the same way. Wired to the old boolean probe, every row the
   * classifier newly frees would fail here with "dirty on re-probe" and the
   * card would ship as a visual change with zero sweepable outcome.
   */
  it('sweeps a harvestable item whose only diff is untracked files (AC-2)', async () => {
    const { deps, journal } = fakeDeps({
      probeStatus: vi.fn(async () => ({
        trackedDirty: false,
        untracked: ['docs/adr/0013-draft.md']
      }))
    })
    const result = await cleanItem(harvestableItem(), { deleteRemote: false }, deps)

    expect(result.ok).toBe(true)
    expect(result.steps.find((s) => s.id === 'guard')!.ok).toBe(true)
    // The untracked file is preserved by the archive step, not refused by the guard.
    expect(deps.archiveWip).toHaveBeenCalled()
    expect(deps.trash).toHaveBeenCalledWith('/repo/wt-x')
    expect(journal).toHaveLength(1)
  })

  it('aborts via guard when a re-probe finds TRACKED changes (TOCTOU, AC-4)', async () => {
    const { deps } = fakeDeps({
      probeStatus: vi.fn(async () => ({ trackedDirty: true, untracked: [] }))
    })
    const item = harvestableItem()
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].id).toBe('guard')
    expect(deps.trash).not.toHaveBeenCalled()
  })

  it('waives the unpushed re-probe when justifiedBy is set (merged signal)', async () => {
    const { deps } = fakeDeps()
    const item = harvestableItem({ justifiedBy: 'gh-merged' })
    await cleanItem(item, { deleteRemote: false }, deps)
    expect(deps.hasUnpushed).not.toHaveBeenCalled()
  })

  it('re-probes unpushed and aborts when justifiedBy is null and it comes back true', async () => {
    const { deps } = fakeDeps({ hasUnpushed: vi.fn(async () => true) })
    const item = harvestableItem({ justifiedBy: null })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    expect(deps.hasUnpushed).toHaveBeenCalled()
  })

  it('skips folder-only steps for a local-branch item', async () => {
    const { deps } = fakeDeps()
    const item = harvestableItem({ kind: 'local-branch', path: undefined })
    const result = await cleanItem(item, { deleteRemote: false }, deps)
    const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]))

    expect(byId['trash-folder'].skipped).toBe(true)
    expect(byId['worktree-prune'].skipped).toBe(true)
    expect(byId['sidebar-detach'].skipped).toBe(true)
    expect(byId['branch-delete'].skipped).toBe(false)
    expect(deps.trash).not.toHaveBeenCalled()
  })

  it('deletes the remote branch only when deleteRemote is true AND needsRemoteDelete is true', async () => {
    const { deps: depsA } = fakeDeps()
    const resA = await cleanItem(
      harvestableItem({ needsRemoteDelete: true }),
      { deleteRemote: false },
      depsA
    )
    expect(resA.steps.find((s) => s.id === 'remote-delete')!.skipped).toBe(true)

    const { deps: depsB } = fakeDeps()
    const resB = await cleanItem(
      harvestableItem({ needsRemoteDelete: false }),
      { deleteRemote: true },
      depsB
    )
    expect(resB.steps.find((s) => s.id === 'remote-delete')!.skipped).toBe(true)

    const { deps: depsC } = fakeDeps()
    const itemBoth = harvestableItem({ needsRemoteDelete: true, remoteSha: 'remotesha1' })
    const resC = await cleanItem(itemBoth, { deleteRemote: true }, depsC)
    expect(resC.steps.find((s) => s.id === 'remote-delete')!.skipped).toBe(false)
    expect(depsC.git).toHaveBeenCalledWith('/repo', [
      'push',
      'origin',
      '--force-with-lease=feat/x:remotesha1',
      '--delete',
      'feat/x'
    ])
  })

  it('lease-guards the remote delete with the scan-time OID, rejecting a moved branch', async () => {
    const { deps } = fakeDeps({
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args.includes('--delete') && args.some((a) => a.startsWith('--force-with-lease='))) {
          throw new Error('stale info: refs/heads/feat/x')
        }
        return ''
      })
    })
    const item = harvestableItem({ needsRemoteDelete: true, remoteSha: 'oldsha' })
    const result = await cleanItem(item, { deleteRemote: true }, deps)
    const remote = result.steps.find((s) => s.id === 'remote-delete')!
    expect(remote.ok).toBe(false)
    expect(remote.error).toContain('stale info')
  })

  it('falls back to a plain delete when the scan captured no remote OID', async () => {
    const { deps } = fakeDeps()
    const item = harvestableItem({ needsRemoteDelete: true, remoteSha: null })
    await cleanItem(item, { deleteRemote: true }, deps)
    expect(deps.git).toHaveBeenCalledWith('/repo', ['push', 'origin', '--delete', 'feat/x'])
  })

  it('never uses -D, only -d, for branch deletion', async () => {
    const { deps } = fakeDeps()
    await cleanItem(harvestableItem(), { deleteRemote: false }, deps)
    expect(deps.git).toHaveBeenCalledWith('/repo', ['branch', '-d', 'feat/x'])
    expect(deps.git).not.toHaveBeenCalledWith('/repo', ['branch', '-D', 'feat/x'])
  })

  it('propagates a branch -d refusal as a step error with the git stderr text, stopping before remote/sidebar but still journaling', async () => {
    const { deps, journal } = fakeDeps({
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args[0] === 'branch') throw new Error('error: The branch is not fully merged.')
        return ''
      })
    })
    const item = harvestableItem()
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    expect(result.steps.map((s) => s.id)).toEqual([
      'guard',
      'archive',
      'trash-folder',
      'worktree-prune',
      'branch-delete',
      'journal'
    ])
    const branchDelete = result.steps.find((s) => s.id === 'branch-delete')!
    expect(branchDelete.ok).toBe(false)
    expect(branchDelete.error).toContain('not fully merged')
    expect(journal).toHaveLength(1)
    expect(journal[0].deleted).toEqual(['archive', 'trash-folder', 'worktree-prune'])
  })

  it('contains a re-probe error as a guard failure without throwing (does not abort the sweep)', async () => {
    const { deps, journal } = fakeDeps({
      probeStatus: vi.fn(async () => {
        throw new Error('git timed out')
      })
    })
    const item = harvestableItem()
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].id).toBe('guard')
    expect(result.steps[0].error).toContain('git timed out')
    expect(deps.trash).not.toHaveBeenCalled()
    expect(journal).toHaveLength(0)
  })

  it('refuses to delete when the commit SHA cannot be resolved (never records sha:null)', async () => {
    const { deps, journal } = fakeDeps({ resolveSha: vi.fn(async () => null) })
    const item = harvestableItem({ kind: 'local-branch', path: undefined })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    const archive = result.steps.find((s) => s.id === 'archive')!
    expect(archive.ok).toBe(false)
    expect(archive.error).toContain('feat/x')
    expect(deps.git).not.toHaveBeenCalledWith('/repo', ['branch', '-d', 'feat/x'])
    // A tombstone that records a deletion must never carry sha:null.
    expect(journal.some((t) => t.deleted.length > 0 && t.sha === null)).toBe(false)
  })

  it('propagates a resolveSha throw as a failed archive step, deleting nothing', async () => {
    const { deps } = fakeDeps({
      resolveSha: vi.fn(async () => {
        throw new Error('rev-parse failed')
      })
    })
    const item = harvestableItem()
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    const archive = result.steps.find((s) => s.id === 'archive')!
    expect(archive.ok).toBe(false)
    expect(archive.error).toContain('rev-parse failed')
    expect(deps.trash).not.toHaveBeenCalled()
    expect(deps.archiveTip).not.toHaveBeenCalled()
  })

  it('retries with -D when justifiedBy is gh-merged and -d refuses as not fully merged', async () => {
    const { deps } = fakeDeps({
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args[0] === 'branch' && args[1] === '-d') {
          throw new Error("error: the branch 'feat/x' is not fully merged.")
        }
        return ''
      })
    })
    const item = harvestableItem({ justifiedBy: 'gh-merged' })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    const branchDelete = result.steps.find((s) => s.id === 'branch-delete')!
    expect(branchDelete.ok).toBe(true)
    expect(deps.git).toHaveBeenCalledWith('/repo', ['branch', '-d', 'feat/x'])
    expect(deps.git).toHaveBeenCalledWith('/repo', ['branch', '-D', 'feat/x'])
  })

  it('retries with -D when justifiedBy is remote-gone-after-close and -d refuses as not fully merged', async () => {
    const { deps } = fakeDeps({
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args[0] === 'branch' && args[1] === '-d') {
          throw new Error("error: the branch 'feat/x' is not fully merged.")
        }
        return ''
      })
    })
    const item = harvestableItem({ justifiedBy: 'remote-gone-after-close' })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    const branchDelete = result.steps.find((s) => s.id === 'branch-delete')!
    expect(branchDelete.ok).toBe(true)
    expect(deps.git).toHaveBeenCalledWith('/repo', ['branch', '-D', 'feat/x'])
  })

  it('never retries with -D when justifiedBy is ancestor, even on a not-fully-merged refusal', async () => {
    const { deps } = fakeDeps({
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args[0] === 'branch' && args[1] === '-d') {
          throw new Error("error: the branch 'feat/x' is not fully merged.")
        }
        return ''
      })
    })
    const item = harvestableItem({ justifiedBy: 'ancestor' })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    const branchDelete = result.steps.find((s) => s.id === 'branch-delete')!
    expect(branchDelete.ok).toBe(false)
    expect(branchDelete.error).toContain('not fully merged')
    expect(deps.git).not.toHaveBeenCalledWith('/repo', ['branch', '-D', 'feat/x'])
  })

  it('never retries with -D when justifiedBy is null, even on a not-fully-merged refusal', async () => {
    const { deps } = fakeDeps({
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args[0] === 'branch' && args[1] === '-d') {
          throw new Error("error: the branch 'feat/x' is not fully merged.")
        }
        return ''
      })
    })
    const item = harvestableItem({ justifiedBy: null })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    const branchDelete = result.steps.find((s) => s.id === 'branch-delete')!
    expect(branchDelete.ok).toBe(false)
    expect(deps.git).not.toHaveBeenCalledWith('/repo', ['branch', '-D', 'feat/x'])
  })

  it('does not retry with -D when the -d failure is unrelated to merge-ness', async () => {
    const { deps } = fakeDeps({
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args[0] === 'branch' && args[1] === '-d') {
          throw new Error('fatal: branch not found')
        }
        return ''
      })
    })
    const item = harvestableItem({ justifiedBy: 'gh-merged' })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    const branchDelete = result.steps.find((s) => s.id === 'branch-delete')!
    expect(branchDelete.ok).toBe(false)
    expect(branchDelete.error).toContain('branch not found')
    expect(deps.git).not.toHaveBeenCalledWith('/repo', ['branch', '-D', 'feat/x'])
  })

  it('marks the journal step and overall result failed when appendTombstone throws', async () => {
    const { deps } = fakeDeps({
      appendTombstone: vi.fn(async () => {
        throw new Error('ENOSPC: no space left on device')
      })
    })
    const result = await cleanItem(harvestableItem(), { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    const journalStep = result.steps.find((s) => s.id === 'journal')!
    expect(journalStep.ok).toBe(false)
    expect(journalStep.error).toContain('ENOSPC')
  })
})

describe('cleanItem — preserve before sweeping (T254)', () => {
  it('writes both archive refs BEFORE any destructive step runs', async () => {
    const order: string[] = []
    const { deps } = fakeDeps({
      archiveTip: vi.fn(async (_r: string, ref: string, sha: string) => {
        order.push(`tip:${ref}`)
        return sha
      }),
      archiveWip: vi.fn(async (_r: string, ref: string) => {
        order.push(`wip:${ref}`)
        return 'wipsha1'
      }),
      trash: vi.fn(async () => {
        order.push('trash')
      }),
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args[0] === 'branch') order.push('branch-delete')
        return ''
      })
    })

    const result = await cleanItem(harvestableItem(), { deleteRemote: false }, deps)

    expect(result.ok).toBe(true)
    expect(order[0]).toMatch(/^tip:refs\/archive\/feat\/x\//)
    expect(order[1]).toMatch(/^wip:refs\/archive\/feat\/x\//)
    expect(order.slice(2)).toContain('trash')
    expect(order.indexOf('trash')).toBeGreaterThan(1)
    expect(order.indexOf('branch-delete')).toBeGreaterThan(order.indexOf('trash'))
  })

  it('namespaces the two refs under one per-branch, per-sweep prefix', async () => {
    const { deps, archived } = fakeDeps()
    await cleanItem(harvestableItem(), { deleteRemote: false }, deps)

    expect(archived).toHaveLength(2)
    const [tip, wip] = archived
    expect(tip.endsWith('/tip')).toBe(true)
    expect(wip.endsWith('/wip')).toBe(true)
    expect(tip.slice(0, -4)).toBe(wip.slice(0, -4))
    expect(tip.startsWith('refs/archive/feat/x/')).toBe(true)
    // Neither ref may be a path prefix of the other — git refuses that pair.
    expect(wip.startsWith(`${tip}/`)).toBe(false)
    expect(tip.startsWith(`${wip}/`)).toBe(false)
  })

  it('aborts the item and reports why when the tip archive write fails', async () => {
    const { deps, journal } = fakeDeps({
      archiveTip: vi.fn(async () => {
        throw new Error('cannot lock ref: permission denied')
      })
    })
    const result = await cleanItem(harvestableItem(), { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    const archive = result.steps.find((s) => s.id === 'archive')!
    expect(archive.ok).toBe(false)
    expect(archive.error).toContain('permission denied')
    expect(deps.trash).not.toHaveBeenCalled()
    expect(deps.git).not.toHaveBeenCalled()
    expect(journal[0].deleted).toEqual([])
    expect(journal[0].archiveTipRef).toBeNull()
  })

  it('aborts the item when the working-state archive fails, even though the tip succeeded', async () => {
    const { deps, journal } = fakeDeps({
      archiveWip: vi.fn(async () => {
        throw new Error('add -A failed: EACCES')
      })
    })
    const result = await cleanItem(harvestableItem(), { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    expect(result.steps.find((s) => s.id === 'archive')!.error).toContain('EACCES')
    expect(deps.trash).not.toHaveBeenCalled()
    // The tip write landed; the wip one did not. The tombstone records exactly that.
    expect(journal[0].archiveTipRef).toMatch(/\/tip$/)
    expect(journal[0].archiveWipRef).toBeNull()
  })

  it('records both ref names in the tombstone beside the existing restoreHint', async () => {
    const { deps, journal } = fakeDeps()
    await cleanItem(harvestableItem(), { deleteRemote: false }, deps)

    expect(journal[0].restoreHint).toBe('git branch feat/x sha123')
    expect(journal[0].archiveTipRef).toMatch(/^refs\/archive\/feat\/x\/\d{8}T\d{6}Z\/tip$/)
    expect(journal[0].archiveWipRef).toMatch(/^refs\/archive\/feat\/x\/\d{8}T\d{6}Z\/wip$/)
  })

  it('archives a tip but no working state for a branch with no checkout', async () => {
    const { deps, journal } = fakeDeps()
    const item = harvestableItem({ kind: 'local-branch', path: undefined })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(true)
    expect(deps.archiveTip).toHaveBeenCalled()
    expect(deps.archiveWip).not.toHaveBeenCalled()
    expect(journal[0].archiveTipRef).toMatch(/\/tip$/)
    expect(journal[0].archiveWipRef).toBeNull()
  })

  it('archives a remote-branch item from its remote-tracking ref before deleting it', async () => {
    const { deps, journal } = fakeDeps()
    const item = harvestableItem({
      kind: 'remote-branch',
      path: undefined,
      needsRemoteDelete: true,
      remoteSha: null
    })
    const result = await cleanItem(item, { deleteRemote: true }, deps)

    expect(result.ok).toBe(true)
    expect(deps.resolveSha).toHaveBeenCalledWith('/repo', 'refs/remotes/origin/feat/x')
    expect(journal[0].archiveTipRef).toMatch(/\/tip$/)
    expect(journal[0].sha).toBe('sha123')
  })

  it('refuses to delete a remote branch whose objects are not present locally', async () => {
    const { deps } = fakeDeps({ resolveSha: vi.fn(async () => null) })
    const item = harvestableItem({
      kind: 'remote-branch',
      path: undefined,
      needsRemoteDelete: true
    })
    const result = await cleanItem(item, { deleteRemote: true }, deps)

    expect(result.ok).toBe(false)
    expect(result.steps.find((s) => s.id === 'archive')!.error).toContain(
      'refs/remotes/origin/feat/x'
    )
    expect(deps.git).not.toHaveBeenCalled()
  })
})

describe('sweep', () => {
  it('continues past a failing item and reports both results', async () => {
    const { deps } = fakeDeps({
      trash: vi.fn(async (p: string) => {
        if (p.includes('fail')) throw new Error('trash failed')
      })
    })
    const bad = harvestableItem({ id: 'bad', path: '/repo/wt-fail', branch: 'feat/fail' })
    const good = harvestableItem({ id: 'good', path: '/repo/wt-good', branch: 'feat/good' })
    const progress: CleanResult[] = []

    const results = await sweep([bad, good], { deleteRemote: false }, deps, (r) => progress.push(r))

    expect(results).toHaveLength(2)
    expect(results[0].ok).toBe(false)
    expect(results[0].itemId).toBe('bad')
    expect(results[1].ok).toBe(true)
    expect(results[1].itemId).toBe('good')
    expect(progress).toHaveLength(2)
  })
})

describe('cleanItem — archive backstop (T254, AC-1)', () => {
  it('refuses to trash a folder the planner cannot preserve, deleting nothing', async () => {
    const { deps, journal } = fakeDeps()
    // A branchless worktree (e.g. a detached checkout) plans no refs at all.
    const item = harvestableItem({ branch: undefined })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(false)
    const archive = result.steps.find((s) => s.id === 'archive')!
    expect(archive.ok).toBe(false)
    expect(archive.error).toContain('working state')
    expect(deps.trash).not.toHaveBeenCalled()
    expect(deps.git).not.toHaveBeenCalled()
    expect(journal[0].deleted).toEqual([])
  })
})

// ---- BUG-93 / BUG-46: the delete path must know every merge signal -----------

describe('cleanItem — squash-equivalent (BUG-93, AC-2)', () => {
  it('AC-2: a full sweep of a squash-merged branch succeeds', async () => {
    // The trap this test exists for: a squash-merged branch is BY DEFINITION the
    // case where `git branch -d` refuses "not fully merged" — that is why ancestry
    // fails for it in the first place. A classifier that hands the sweep a
    // `squash-equivalent` item the executor does not recognize offers the row to
    // the user and then throws at the delete step, with every classifier test
    // still green. That is BUG-46, and this is the sweep-level evidence a green
    // classifier does not provide.
    const { deps, journal } = fakeDeps({
      git: vi.fn(async (_repo: string, args: string[]) => {
        if (args[0] === 'branch' && args[1] === '-d') {
          throw new Error("error: the branch 'feat/x' is not fully merged.")
        }
        return ''
      })
    })
    const item = harvestableItem({ justifiedBy: 'squash-equivalent' })
    const result = await cleanItem(item, { deleteRemote: false }, deps)

    expect(result.ok).toBe(true)
    expect(result.steps.every((s) => s.ok)).toBe(true)
    expect(deps.git).toHaveBeenCalledWith('/repo', ['branch', '-d', 'feat/x'])
    expect(deps.git).toHaveBeenCalledWith('/repo', ['branch', '-D', 'feat/x'])
    expect(journal[0].justifiedBy).toBe('squash-equivalent')
  })

  it('waives the unpushed re-probe for a squash-equivalent item like any other signal', async () => {
    const { deps } = fakeDeps({ hasUnpushed: vi.fn(async () => true) })
    const item = harvestableItem({ justifiedBy: 'squash-equivalent' })
    expect((await cleanItem(item, { deleteRemote: false }, deps)).ok).toBe(true)
  })
})

describe('overridesAncestryCheck', () => {
  it('decides every member of MergeSignal — the union is the allowlist', () => {
    // A `Record<MergeSignal, boolean>` makes adding a signal without deciding
    // this a compile error. This asserts the table is also complete at runtime,
    // so a widened union cannot ship with a member nobody classified.
    const signals = Object.keys(MERGE_SIGNAL_OVERRIDES_ANCESTRY) as MergeSignal[]
    expect(signals.sort()).toEqual(
      ['ancestor', 'gh-merged', 'remote-gone-after-close', 'squash-equivalent'].sort()
    )
    for (const s of signals) expect(typeof MERGE_SIGNAL_OVERRIDES_ANCESTRY[s]).toBe('boolean')
  })

  it('is false for no signal at all', () => {
    expect(overridesAncestryCheck(null)).toBe(false)
  })

  it('forces past -d only for signals proven independently of git ancestry', () => {
    expect(overridesAncestryCheck('gh-merged')).toBe(true)
    expect(overridesAncestryCheck('squash-equivalent')).toBe(true)
    expect(overridesAncestryCheck('remote-gone-after-close')).toBe(true)
    // git's own answer: a `-d` refusal here means the facts and git disagree.
    expect(overridesAncestryCheck('ancestor')).toBe(false)
  })
})

describe('cleanItem unregisters only its own worktree (delta 3b, item 11)', () => {
  it('never runs a repo-wide git worktree prune', async () => {
    const { deps } = fakeDeps()
    const result = await cleanItem(harvestableItem(), { deleteRemote: false }, deps)
    expect(result.ok).toBe(true)
    const gitCalls = vi.mocked(deps.git).mock.calls.map(([, args]) => args.join(' '))
    expect(gitCalls.some((c) => c.startsWith('worktree'))).toBe(false)
  })

  it('removes the registration of the worktree it trashed, after the trash', async () => {
    const order: string[] = []
    const { deps } = fakeDeps({
      trash: vi.fn(async () => void order.push('trash')),
      removeWorktreeAdmin: vi.fn(async (repo: string, path: string) => {
        order.push(`admin ${repo} ${path}`)
      })
    })
    await cleanItem(harvestableItem(), { deleteRemote: false }, deps)
    expect(order).toEqual(['trash', 'admin /repo /repo/wt-x'])
  })

  it('keeps the step list and the journal the same as before', async () => {
    const { deps, journal } = fakeDeps()
    const result = await cleanItem(harvestableItem(), { deleteRemote: false }, deps)
    expect(result.steps.map((s) => s.id)).toContain('worktree-prune')
    expect(journal[0]!.deleted).toContain('worktree-prune')
  })

  it('halts at that step when the registration cannot be removed, before the branch is touched', async () => {
    const { deps } = fakeDeps({
      removeWorktreeAdmin: vi.fn(async () => {
        throw new Error('EACCES')
      })
    })
    const result = await cleanItem(harvestableItem(), { deleteRemote: false }, deps)
    expect(result.ok).toBe(false)
    expect(result.steps.find((s) => s.id === 'worktree-prune')).toMatchObject({
      ok: false,
      error: 'EACCES'
    })
    expect(result.steps.some((s) => s.id === 'branch-delete')).toBe(false)
  })
})

describe('matchAdminDir: which admin dir belongs to a worktree (delta 3b, item 11)', () => {
  const entries = [
    { dir: '/repo/.git/worktrees/a', gitdir: '/repo/wt-a/.git' },
    { dir: '/repo/.git/worktrees/b', gitdir: '/mnt/usb/wt-b/.git' },
    { dir: '/repo/.git/worktrees/c', gitdir: '/repo/wt-c/.git' }
  ]

  it('picks the entry whose gitdir points into that worktree', () => {
    expect(matchAdminDir(entries, '/repo/wt-c')).toBe('/repo/.git/worktrees/c')
  })

  it('does not pick another worktree, whose folder may simply be unmounted', () => {
    expect(matchAdminDir(entries, '/repo/wt-c')).not.toBe('/repo/.git/worktrees/b')
  })

  it('tolerates trailing slashes and backslashes', () => {
    expect(matchAdminDir(entries, '/repo/wt-a/')).toBe('/repo/.git/worktrees/a')
    expect(matchAdminDir([{ dir: 'D', gitdir: 'C:\\ws\\wt\\.git' }], 'C:/ws/wt')).toBe('D')
  })

  it('is null for a worktree that is not registered, or whose name is only a prefix', () => {
    expect(matchAdminDir(entries, '/repo/wt-z')).toBeNull()
    expect(matchAdminDir(entries, '/repo/wt')).toBeNull()
  })

  it('is null when two entries claim the same folder: ambiguous means untouched', () => {
    const twice = [...entries, { dir: '/repo/.git/worktrees/c2', gitdir: '/repo/wt-c/.git' }]
    expect(matchAdminDir(twice, '/repo/wt-c')).toBeNull()
  })
})
