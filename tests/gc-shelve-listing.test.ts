// A shelved worktree as an agent sees it in `list_cleanup` (U2.2 AC-5, AC-8): listed apart from the
// bundles, path-free, counted, and the shelving switch disclosed. Pure: no electron.

import { describe, expect, it } from 'vitest'
import { cleanupListing } from '../src/main/mcp/cleanup-listing'
import type { ShelvedEntry } from '../src/main/gc/shelve-store'
import { MAIN, NOW, OTHER_MAIN, absolutePathsIn, bundle, snapshot } from './gc-snapshot-fixtures'

const opts = { denyFolders: [], home: '/home/nobody' }

const entry = (over: Partial<ShelvedEntry> = {}): ShelvedEntry => ({
  id: `${MAIN}::worktree::${MAIN}/.claude/worktrees/PROJ-231-wave-9`,
  repoPath: MAIN,
  worktreePath: `${MAIN}/.claude/worktrees/PROJ-231-wave-9`,
  branch: 'feat/PROJ-231-wave-9',
  headSha: 'a'.repeat(40),
  namespace: 'refs/archive/feat/PROJ-231-wave-9/20261105T100000Z',
  shelvedAt: NOW - 3_600_000,
  idleDays: 9,
  reason: 'Shelved `feat/PROJ-231-wave-9` — idle 9 d, branch kept',
  freedBytes: 2_000_000,
  ...over
})

describe('list_cleanup — shelved worktrees', () => {
  it('lists a shelved worktree apart from the bundles, with no absolute path anywhere', () => {
    const listing = cleanupListing(
      snapshot([bundle(`${MAIN}/.claude/worktrees/PROJ-231-wave-1`)], { shelved: [entry()] }),
      opts
    )
    expect(listing.shelved).toEqual([
      {
        id: expect.stringMatching(/^www::worktree::feat\/PROJ-231-wave-9::[0-9a-f]{8}$/),
        folderAlias: 'PROJ-231-wave-9',
        branch: 'feat/PROJ-231-wave-9',
        shelvedAt: NOW - 3_600_000,
        idleDays: 9,
        reason: 'Shelved `feat/PROJ-231-wave-9` — idle 9 d, branch kept'
      }
    ])
    expect(listing.bundles).toHaveLength(1)
    expect(absolutePathsIn(JSON.stringify(listing))).toEqual([])
  })

  it('counts them in the totals and says nothing else changed there', () => {
    const listing = cleanupListing(
      snapshot([], {
        shelved: [entry(), entry({ id: 'other', worktreePath: `${MAIN}/w2`, branch: null })]
      }),
      opts
    )
    expect(listing.totals.shelved).toBe(2)
    expect(listing.totals.ready).toBe(0)
  })

  it('a snapshot from before shelving existed lists none', () => {
    const listing = cleanupListing(snapshot([]), opts)
    expect(listing.shelved).toEqual([])
    expect(listing.totals.shelved).toBe(0)
  })

  it('a detached shelve has no branch', () => {
    const listing = cleanupListing(snapshot([], { shelved: [entry({ branch: null })] }), opts)
    expect(listing.shelved[0]!.branch).toBeNull()
    expect(listing.shelved[0]!.folderAlias).toBe('PROJ-231-wave-9')
  })

  it('a scoped listing keeps the shelved worktrees of that repo only', () => {
    const other = entry({
      id: `${OTHER_MAIN}::worktree::${OTHER_MAIN}/w`,
      repoPath: OTHER_MAIN,
      worktreePath: `${OTHER_MAIN}/w`,
      branch: 'feat/other'
    })
    const listing = cleanupListing(
      snapshot([bundle(`${MAIN}/.claude/worktrees/PROJ-231-wave-1`)], {
        shelved: [entry(), other]
      }),
      { ...opts, scope: MAIN }
    )
    expect(listing.shelved.map((s) => s.branch)).toEqual(['feat/PROJ-231-wave-9'])
    expect(listing.totals.shelved).toBe(1)
  })

  it('discloses the shelving switch: off and report-only by default', () => {
    expect(cleanupListing(snapshot([]), opts).shelving).toEqual({
      enabled: false,
      reportOnly: true,
      thresholdDays: 3
    })
  })

  it('shelving on and acknowledged is no longer report-only; the autopilot block is untouched', () => {
    const listing = cleanupListing(
      snapshot([], {
        prefs: {
          autopilot: false,
          shelve: {
            enabled: true,
            firstReportAcknowledged: true,
            thresholdDays: 5,
            maxPerCycle: 3,
            failureLimit: 3
          }
        }
      }),
      opts
    )
    expect(listing.shelving).toEqual({ enabled: true, reportOnly: false, thresholdDays: 5 })
    expect(listing.autopilot).toEqual({ enabled: false, reportOnly: true, graceDays: 2 })
  })

  it('an old prefs object with no shelve block reads as off', () => {
    const snap = snapshot([])
    delete (snap.prefs as { shelve?: unknown }).shelve
    expect(cleanupListing(snap, opts).shelving).toEqual({
      enabled: false,
      reportOnly: true,
      thresholdDays: 3
    })
  })
})
