import { describe, it, expect } from 'vitest'
import {
  parseForEachRef,
  parseGhPrList,
  parseLsRemoteHeads,
  buildRepoItems,
  isPatchIdContained,
  parsePatchId,
  parsePatchIdSet,
  resolvePrForBranch,
  squashBranchArgv,
  squashHistoryArgv,
  SQUASH_PROBE_HISTORY,
  snapshotTotals,
  newlyHarvestable,
  ghCacheFresh,
  gapFillCandidates,
  parseGhPrListResult,
  readGhCacheEntry,
  GAP_FILL_TTL_MS,
  GH_CACHE_VERSION,
  type RepoScanInput,
  type ReaperSnapshot
} from '../src/main/reaper/scan-core'
import type { WorktreeListEntry } from '../src/main/worktree-core'
import {
  classifyDetachedWorktree,
  type PrFacts,
  type ReapItem
} from '../src/main/reaper/reaper-core'

const FOR_EACH_REF = [
  'feat/x\tabc123\t1751500000\torigin/feat/x',
  'main\tdef456\t1751500001\torigin/main',
  'spike/no-upstream\t0110aa\t1749000000\t'
].join('\n')

const GH_PR_LIST = JSON.stringify([
  {
    headRefName: 'feat/x',
    number: 92,
    state: 'MERGED',
    mergedAt: '2026-07-01T00:00:00Z',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ state: 'SUCCESS' }]
  },
  {
    headRefName: 'feat/open',
    number: 118,
    state: 'OPEN',
    mergedAt: null,
    reviewDecision: '',
    statusCheckRollup: [{ state: 'FAILURE' }]
  }
])

const LS_REMOTE = ['abc123\trefs/heads/feat/x', 'def456\trefs/heads/main'].join('\n')

describe('parseForEachRef', () => {
  it('parses the happy path, converting unix seconds to ms and empty upstream to null', () => {
    const refs = parseForEachRef(FOR_EACH_REF)
    expect(refs).toEqual([
      { branch: 'feat/x', sha: 'abc123', committedAt: 1751500000_000, upstream: 'origin/feat/x' },
      { branch: 'main', sha: 'def456', committedAt: 1751500001_000, upstream: 'origin/main' },
      { branch: 'spike/no-upstream', sha: '0110aa', committedAt: 1749000000_000, upstream: null }
    ])
  })

  it('returns empty for empty input', () => {
    expect(parseForEachRef('')).toEqual([])
  })

  it('skips malformed lines (wrong field count, non-numeric timestamp)', () => {
    const stdout = ['feat/x\tabc123', 'ok/branch\tsha1\tnotanumber\t', 'good\tsha2\t100\t'].join(
      '\n'
    )
    const refs = parseForEachRef(stdout)
    expect(refs).toEqual([{ branch: 'good', sha: 'sha2', committedAt: 100_000, upstream: null }])
  })

  it('handles CRLF line endings', () => {
    const stdout = FOR_EACH_REF.split('\n').join('\r\n')
    expect(parseForEachRef(stdout)).toHaveLength(3)
  })
})

describe('parseGhPrList', () => {
  it('parses the happy path with worst-CI-state rollup', () => {
    const map = parseGhPrList(GH_PR_LIST)
    expect(map.get('feat/x')).toEqual<PrFacts>({
      number: 92,
      state: 'MERGED',
      reviewDecision: 'APPROVED',
      ci: 'passing',
      mergedAt: '2026-07-01T00:00:00Z',
      headRefOid: null
    })
    expect(map.get('feat/open')).toEqual<PrFacts>({
      number: 118,
      state: 'OPEN',
      reviewDecision: null,
      ci: 'failing',
      mergedAt: null,
      headRefOid: null
    })
  })

  it('returns an empty map for an empty array', () => {
    expect(parseGhPrList('[]').size).toBe(0)
  })

  it('returns an empty map for malformed JSON', () => {
    expect(parseGhPrList('not json').size).toBe(0)
  })

  it('takes the worst state across rollup entries', () => {
    const stdout = JSON.stringify([
      {
        headRefName: 'b',
        number: 1,
        state: 'OPEN',
        mergedAt: null,
        reviewDecision: null,
        statusCheckRollup: [{ state: 'SUCCESS' }, { state: 'PENDING' }]
      }
    ])
    expect(parseGhPrList(stdout).get('b')?.ci).toBe('pending')
  })

  it('maps an empty rollup array to unknown', () => {
    const stdout = JSON.stringify([
      {
        headRefName: 'b',
        number: 1,
        state: 'OPEN',
        mergedAt: null,
        reviewDecision: null,
        statusCheckRollup: []
      }
    ])
    expect(parseGhPrList(stdout).get('b')?.ci).toBe('unknown')
  })

  it('normalizes CheckRun status/conclusion (failure/timed_out → failing, in_progress → pending)', () => {
    const ci = (rollup: unknown[]): string | undefined => {
      const stdout = JSON.stringify([
        {
          headRefName: 'b',
          number: 1,
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: null,
          statusCheckRollup: rollup
        }
      ])
      return parseGhPrList(stdout).get('b')?.ci
    }
    expect(ci([{ status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failing')
    expect(ci([{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }])).toBe('failing')
    expect(ci([{ status: 'IN_PROGRESS' }])).toBe('pending')
    expect(ci([{ status: 'QUEUED' }])).toBe('pending')
    expect(ci([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing')
    // A failing CheckRun beats a passing StatusContext.
    expect(ci([{ state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe(
      'failing'
    )
    // Only unrecognized entries → unknown, not a false passing.
    expect(ci([{ status: 'SOMETHING_NEW' }])).toBe('unknown')
  })

  it('scopes dedup to the source repo so a fork PR cannot clobber a same-origin branch', () => {
    const stdout = JSON.stringify([
      // newest first: a fork's feat/x (open), then the same-origin feat/x (merged)
      {
        headRefName: 'feat/x',
        number: 200,
        state: 'OPEN',
        mergedAt: null,
        reviewDecision: null,
        statusCheckRollup: [],
        headRepository: { id: 'FORK_REPO' },
        isCrossRepository: true
      },
      {
        headRefName: 'feat/x',
        number: 92,
        state: 'MERGED',
        mergedAt: '2026-07-01T00:00:00Z',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [],
        headRepository: { id: 'ORIGIN_REPO' },
        isCrossRepository: false
      }
    ])
    const pr = parseGhPrList(stdout).get('feat/x')
    expect(pr?.number).toBe(92)
    expect(pr?.state).toBe('MERGED')
  })

  it('keeps the newest PR when a branch has more than one (gh returns newest first)', () => {
    const stdout = JSON.stringify([
      {
        headRefName: 'b',
        number: 2,
        state: 'OPEN',
        mergedAt: null,
        reviewDecision: null,
        statusCheckRollup: []
      },
      {
        headRefName: 'b',
        number: 1,
        state: 'MERGED',
        mergedAt: '2026-01-01T00:00:00Z',
        reviewDecision: 'APPROVED',
        statusCheckRollup: []
      }
    ])
    expect(parseGhPrList(stdout).get('b')?.number).toBe(2)
  })
})

describe('parseLsRemoteHeads', () => {
  it('parses branch name → OID from refs/heads/', () => {
    expect(parseLsRemoteHeads(LS_REMOTE)).toEqual(
      new Map([
        ['feat/x', 'abc123'],
        ['main', 'def456']
      ])
    )
  })

  it('returns an empty map for empty input', () => {
    expect(parseLsRemoteHeads('').size).toBe(0)
  })

  it('ignores non refs/heads/ lines (e.g. refs/pull/*)', () => {
    const stdout = ['abc\trefs/heads/main', 'def\trefs/pull/1/head'].join('\n')
    expect(parseLsRemoteHeads(stdout)).toEqual(new Map([['main', 'abc']]))
  })

  it('skips lines with an empty OID', () => {
    const stdout = ['\trefs/heads/main', 'abc\trefs/heads/feat/x'].join('\n')
    expect(parseLsRemoteHeads(stdout)).toEqual(new Map([['feat/x', 'abc']]))
  })
})

// ---- BUG-74: a capped PR list must announce that it was capped ---------------

function prRow(branch: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headRefName: branch,
    number: 7,
    state: 'MERGED',
    mergedAt: '2026-01-02T00:00:00Z',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ state: 'SUCCESS' }],
    ...over
  }
}

describe('parseGhPrListResult', () => {
  it('reports a short list as complete', () => {
    const res = parseGhPrListResult(JSON.stringify([prRow('feat/x')]), 100)
    expect(res.complete).toBe(true)
    expect(res.prByBranch.get('feat/x')?.state).toBe('MERGED')
  })

  it('reports an empty list as complete — a repo with no PRs is a real answer', () => {
    expect(parseGhPrListResult('[]', 100).complete).toBe(true)
  })

  it('reports a list of exactly the limit as incomplete', () => {
    const rows = Array.from({ length: 5 }, (_, i) => prRow(`feat/${i}`))
    const res = parseGhPrListResult(JSON.stringify(rows), 5)
    expect(res.complete).toBe(false)
    expect(res.prByBranch.size).toBe(5)
  })

  it('counts raw rows, not deduped branches — limit-many rows for one branch is still capped', () => {
    const rows = Array.from({ length: 5 }, (_, i) => prRow('feat/x', { number: i }))
    const res = parseGhPrListResult(JSON.stringify(rows), 5)
    expect(res.prByBranch.size).toBe(1)
    expect(res.complete).toBe(false)
  })

  it('refuses to claim completeness for output it could not count', () => {
    expect(parseGhPrListResult('not json', 100).complete).toBe(false)
    expect(parseGhPrListResult('{}', 100).complete).toBe(false)
  })
})

describe('gapFillCandidates', () => {
  const noPrs = new Map<string, PrFacts>()

  it('proposes every unanswered branch', () => {
    expect(gapFillCandidates(['a', 'b'], noPrs, new Set())).toEqual(['a', 'b'])
  })

  it('skips a branch the bulk list already answered', () => {
    const found = new Map<string, PrFacts>([
      ['a', { number: 1, state: 'MERGED', reviewDecision: null, ci: 'passing', mergedAt: null }]
    ])
    expect(gapFillCandidates(['a', 'b'], found, new Set())).toEqual(['b'])
  })

  // AC-3: this is the skip that makes a cached miss worth caching.
  it('does not re-propose a branch already probed and proven to have no PR', () => {
    expect(gapFillCandidates(['a', 'b'], noPrs, new Set(['a']))).toEqual(['b'])
  })

  it('stops at the budget and dedups repeats', () => {
    expect(gapFillCandidates(['a', 'b', 'c'], noPrs, new Set(), 2)).toEqual(['a', 'b'])
    expect(gapFillCandidates(['a', 'a', 'b'], noPrs, new Set(), 2)).toEqual(['a', 'b'])
  })
})

describe('readGhCacheEntry', () => {
  const NOW_C = 1_800_000_000_000

  it('reads a current-version complete entry as complete', () => {
    const entry = {
      version: GH_CACHE_VERSION,
      fetchedAt: NOW_C - 1000,
      prs: [prRow('feat/x')],
      complete: true
    }
    const read = readGhCacheEntry(entry, NOW_C)!
    expect(read.complete).toBe(true)
    expect(read.prByBranch.get('feat/x')?.number).toBe(7)
    expect(read.probed.size).toBe(0)
  })

  it('treats a versionless entry as incomplete, keeping the PRs it does carry', () => {
    const read = readGhCacheEntry({ fetchedAt: NOW_C - 1000, prs: [prRow('feat/x')] }, NOW_C)!
    expect(read.complete).toBe(false)
    expect(read.prByBranch.get('feat/x')).toBeDefined()
  })

  it('treats an older-version entry as incomplete and drops its gap fills', () => {
    const read = readGhCacheEntry(
      {
        version: GH_CACHE_VERSION - 1,
        fetchedAt: NOW_C - 1000,
        prs: [],
        complete: true,
        gapFills: { 'feat/old': { probedAt: NOW_C, prs: [] } }
      },
      NOW_C
    )!
    expect(read.complete).toBe(false)
    expect(read.probed.size).toBe(0)
  })

  it('remembers a proven miss, so the same branch is not re-probed next scan', () => {
    const read = readGhCacheEntry(
      {
        version: GH_CACHE_VERSION,
        fetchedAt: NOW_C - 1000,
        prs: [],
        complete: false,
        gapFills: { 'feat/no-pr': { probedAt: NOW_C - 1000, prs: [] } }
      },
      NOW_C
    )!
    expect(read.probed.has('feat/no-pr')).toBe(true)
    expect(read.prByBranch.has('feat/no-pr')).toBe(false)
    expect(read.gapFills['feat/no-pr']).toBeDefined()
  })

  it('restores a gap-filled hit into the branch map', () => {
    const read = readGhCacheEntry(
      {
        version: GH_CACHE_VERSION,
        fetchedAt: NOW_C - 1000,
        prs: [],
        complete: false,
        gapFills: { 'feat/old': { probedAt: NOW_C - 1000, prs: [prRow('feat/old')] } }
      },
      NOW_C
    )!
    expect(read.prByBranch.get('feat/old')?.state).toBe('MERGED')
    expect(read.probed.has('feat/old')).toBe(true)
  })

  it('drops an expired gap fill so it is probed again', () => {
    const read = readGhCacheEntry(
      {
        version: GH_CACHE_VERSION,
        fetchedAt: NOW_C - 1000,
        prs: [],
        complete: false,
        gapFills: { 'feat/no-pr': { probedAt: NOW_C - GAP_FILL_TTL_MS, prs: [] } }
      },
      NOW_C
    )!
    expect(read.probed.has('feat/no-pr')).toBe(false)
    expect(read.gapFills['feat/no-pr']).toBeUndefined()
  })

  it('lets the fresher bulk window win over a gap fill for the same branch', () => {
    const read = readGhCacheEntry(
      {
        version: GH_CACHE_VERSION,
        fetchedAt: NOW_C - 1000,
        prs: [prRow('feat/x', { number: 200 })],
        complete: true,
        gapFills: { 'feat/x': { probedAt: NOW_C - 1000, prs: [prRow('feat/x', { number: 7 })] } }
      },
      NOW_C
    )!
    expect(read.prByBranch.get('feat/x')?.number).toBe(200)
  })

  it('returns null for junk', () => {
    expect(readGhCacheEntry(undefined, NOW_C)).toBeNull()
    expect(readGhCacheEntry({ prs: [] }, NOW_C)).toBeNull()
    expect(readGhCacheEntry([], NOW_C)).toBeNull()
  })
})

describe('ghCacheFresh', () => {
  it('is fresh strictly under the TTL', () => {
    expect(ghCacheFresh(0, 30 * 60_000 - 1)).toBe(true)
  })

  it('is stale at or after the TTL', () => {
    expect(ghCacheFresh(0, 30 * 60_000)).toBe(false)
  })

  it('honors a custom TTL', () => {
    expect(ghCacheFresh(0, 5_000, 10_000)).toBe(true)
    expect(ghCacheFresh(0, 10_000, 10_000)).toBe(false)
  })
})

function wt(over: Partial<WorktreeListEntry> = {}): WorktreeListEntry {
  return { path: '/repo', head: 'sha', branch: '', detached: false, bare: false, ...over }
}

function baseInput(over: Partial<RepoScanInput> = {}): RepoScanInput {
  return {
    repoPath: '/repo',
    defaultBranch: 'main',
    protectedBranches: [],
    worktrees: [wt({ path: '/repo', branch: 'main' })],
    mainWorktreePath: '/repo',
    localBranches: [],
    remoteHeads: new Map(),
    prByBranch: new Map(),
    ghAvailable: true,
    prSetComplete: true,
    hiddenPaths: [],
    liveFolders: new Set(),
    statusByPath: new Map(),
    unpushedByPath: new Map(),
    ancestorByBranch: new Map(),
    patchIdContainedByBranch: new Map(),
    now: 1_800_000_000_000,
    ...over
  }
}

function findItem(items: ReapItem[], branch: string): ReapItem | undefined {
  return items.find((i) => i.branch === branch)
}

describe('buildRepoItems', () => {
  it('never emits the main worktree, the default branch, or protected branches', () => {
    const input = baseInput({
      protectedBranches: ['develop'],
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-x', branch: 'feat/x' })
      ],
      localBranches: [
        { branch: 'main', sha: 'a', committedAt: 1, upstream: null },
        { branch: 'develop', sha: 'b', committedAt: 1, upstream: null },
        { branch: 'feat/x', sha: 'c', committedAt: 1, upstream: null }
      ]
    })
    const items = buildRepoItems(input)
    expect(findItem(items, 'main')).toBeUndefined()
    expect(findItem(items, 'develop')).toBeUndefined()
    expect(findItem(items, 'feat/x')).toBeDefined()
  })

  it('emits one worktree item (not a duplicate local-branch) for a branch checked out in a worktree', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-x', branch: 'feat/x' })
      ],
      localBranches: [{ branch: 'feat/x', sha: 'c', committedAt: 1, upstream: null }]
    })
    const items = buildRepoItems(input)
    const matches = items.filter((i) => i.branch === 'feat/x')
    expect(matches).toHaveLength(1)
    expect(matches[0].kind).toBe('worktree')
  })

  it('emits kind hidden-folder with hidden:true for a worktree path in hiddenPaths', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/.hidden/x', branch: 'feat/x' })
      ],
      hiddenPaths: ['/repo/.hidden/x']
    })
    const item = findItem(buildRepoItems(input), 'feat/x')!
    expect(item.kind).toBe('hidden-folder')
    expect(item.hidden).toBe(true)
  })

  it('threads the split worktree status through to the item (BUG-75)', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-x', branch: 'feat/x' })
      ],
      localBranches: [{ branch: 'feat/x', sha: 'a', committedAt: 1, upstream: null }],
      prByBranch: new Map<string, PrFacts>([
        [
          'feat/x',
          { number: 9, state: 'MERGED', reviewDecision: 'APPROVED', ci: 'passing', mergedAt: 'x' }
        ]
      ]),
      statusByPath: new Map([
        ['/repo/wt-x', { trackedDirty: false, untracked: ['notes.md', 'scratch/'] }]
      ]),
      unpushedByPath: new Map([['/repo/wt-x', false]])
    })
    const item = findItem(buildRepoItems(input), 'feat/x')!
    expect(item.verdict).toBe('harvestable')
    expect(item.untracked).toEqual(['notes.md', 'scratch/'])
  })

  it('reads a failed status probe as unknown, not as clean (BUG-75)', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-x', branch: 'feat/x' })
      ],
      localBranches: [{ branch: 'feat/x', sha: 'a', committedAt: 1, upstream: null }],
      statusByPath: new Map([['/repo/wt-x', null]]),
      unpushedByPath: new Map([['/repo/wt-x', false]])
    })
    const item = findItem(buildRepoItems(input), 'feat/x')!
    expect(item.checkpoints.find((c) => c.id === 'local-clean')!.state).toBe('unknown')
    expect(item.untracked).toEqual([])
  })

  it('emits local-branch with null dirty/unpushed for a local branch with no worktree', () => {
    const input = baseInput({
      localBranches: [{ branch: 'feat/orphan', sha: 'c', committedAt: 1, upstream: null }]
    })
    const item = findItem(buildRepoItems(input), 'feat/orphan')!
    expect(item.kind).toBe('local-branch')
    expect(item.path).toBeUndefined()
  })

  it('emits remote-branch only when PR facts exist; pure remote orphans stay invisible', () => {
    const prByBranch = new Map<string, PrFacts>([
      [
        'feat/remote-only',
        { number: 5, state: 'MERGED', reviewDecision: 'APPROVED', ci: 'passing', mergedAt: 'x' }
      ]
    ])
    const input = baseInput({
      remoteHeads: new Map([
        ['feat/remote-only', 'remotesha1'],
        ['feat/no-pr', 'remotesha2']
      ]),
      prByBranch
    })
    const items = buildRepoItems(input)
    expect(findItem(items, 'feat/remote-only')).toBeDefined()
    expect(findItem(items, 'feat/remote-only')!.kind).toBe('remote-branch')
    expect(findItem(items, 'feat/remote-only')!.remoteSha).toBe('remotesha1')
    expect(findItem(items, 'feat/no-pr')).toBeUndefined()
  })

  it('propagates the remote OID onto worktree items whose branch still exists on origin', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-x', branch: 'feat/x' })
      ],
      remoteHeads: new Map([['feat/x', 'remotesha-x']])
    })
    expect(findItem(buildRepoItems(input), 'feat/x')!.remoteSha).toBe('remotesha-x')
  })

  it('sets remoteExists to null for every item when remoteHeads is null (probe failed)', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-x', branch: 'feat/x' })
      ],
      remoteHeads: null
    })
    const item = findItem(buildRepoItems(input), 'feat/x')!
    expect(item.checkpoints.find((c) => c.id === 'remote-gone')!.state).toBe('unknown')
  })

  it('marks a worktree in liveFolders as sessionLive', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-x', branch: 'feat/x' })
      ],
      liveFolders: new Set(['/repo/wt-x'])
    })
    const item = findItem(buildRepoItems(input), 'feat/x')!
    expect(item.verdict).toBe('active')
  })

  // --- detached worktrees (BUG-95) -------------------------------------------
  // These used to be dropped outright: 15 of 48 entries and 36% of the checkout
  // disk on the corpus measured 2026-08-28 had no row at all.

  it('emits exactly one item for a detached worktree, carrying path, HEAD sha, age and disk', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-detached', branch: '', head: 'deadbeef', detached: true })
      ],
      commitDateBySha: new Map([['deadbeef', 1_800_000_000_000 - 9 * 86_400_000]]),
      diskBytesByPath: new Map([['/repo/wt-detached', 7_340_032]])
    })
    const matches = buildRepoItems(input).filter((i) => i.path === '/repo/wt-detached')
    expect(matches).toHaveLength(1)
    expect(matches[0].kind).toBe('detached-worktree')
    expect(matches[0].headSha).toBe('deadbeef')
    expect(matches[0].ageDays).toBe(9)
    expect(matches[0].diskBytes).toBe(7_340_032)
  })

  it('reports a null age and null disk for a detached worktree when neither was probed', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-detached', branch: '', head: 'deadbeef', detached: true })
      ]
    })
    const item = buildRepoItems(input).find((i) => i.path === '/repo/wt-detached')!
    expect(item.ageDays).toBeNull()
    expect(item.diskBytes).toBeNull()
  })

  it('treats a branchless non-detached worktree entry as detached too', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-nobranch', branch: '', head: 'cafe01', detached: false })
      ]
    })
    const item = buildRepoItems(input).find((i) => i.path === '/repo/wt-nobranch')!
    expect(item.kind).toBe('detached-worktree')
  })

  it('never classifies a detached worktree as harvestable, whatever the branch-side facts say', () => {
    // Every signal that could justify a merge is present for a same-named branch:
    // a MERGED PR, a true ancestry read, a deleted remote, a clean tree. None of
    // it can reach the detached entry — there is no branch to key it on.
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-detached', branch: '', head: 'deadbeef', detached: true })
      ],
      localBranches: [{ branch: 'feat/x', sha: 'deadbeef', committedAt: 1, upstream: null }],
      prByBranch: new Map<string, PrFacts>([
        [
          'feat/x',
          { number: 9, state: 'MERGED', reviewDecision: 'APPROVED', ci: 'passing', mergedAt: 'x' }
        ]
      ]),
      ancestorByBranch: new Map([['feat/x', true]]),
      statusByPath: new Map([['/repo/wt-detached', { trackedDirty: false, untracked: [] }]]),
      unpushedByPath: new Map([['/repo/wt-detached', false]])
    })
    const item = buildRepoItems(input).find((i) => i.path === '/repo/wt-detached')!
    expect(item.verdict).not.toBe('harvestable')
    expect(item.verdict).toBe('blocked')
    expect(item.justifiedBy).toBeNull()
    expect(item.needsRemoteDelete).toBe(false)
  })

  it('emits no branch-derived facts for a detached worktree (no PR, ancestry or upstream)', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-detached', branch: '', head: 'deadbeef', detached: true })
      ],
      localBranches: [{ branch: 'feat/x', sha: 'deadbeef', committedAt: 1, upstream: 'origin/x' }],
      remoteHeads: new Map([['feat/x', 'remotesha-x']]),
      prByBranch: new Map<string, PrFacts>([
        [
          'feat/x',
          { number: 9, state: 'MERGED', reviewDecision: 'APPROVED', ci: 'passing', mergedAt: 'x' }
        ]
      ]),
      ancestorByBranch: new Map([['feat/x', true]])
    })
    const item = buildRepoItems(input).find((i) => i.path === '/repo/wt-detached')!
    expect(item.branch).toBeUndefined()
    expect(item.remoteSha).toBeNull()
    // Every branch-shaped checkpoint is 'na' — not 'green' borrowed from feat/x.
    for (const id of ['pr', 'review', 'ci', 'pr-merged', 'remote-gone'] as const) {
      expect(item.checkpoints.find((c) => c.id === id)!.state).toBe('na')
    }
    // ...and the local branch still gets its own, separate item.
    expect(findItem(buildRepoItems(input), 'feat/x')).toBeDefined()
  })

  it('marks a detached worktree with a live session as active, still never harvestable', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/wt-detached', branch: '', head: 'deadbeef', detached: true })
      ],
      liveFolders: new Set(['/repo/wt-detached'])
    })
    const item = buildRepoItems(input).find((i) => i.path === '/repo/wt-detached')!
    expect(item.verdict).toBe('active')
  })

  it('keeps the hidden flag on a detached worktree in hiddenPaths', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo', branch: 'main' }),
        wt({ path: '/repo/.hidden/d', branch: '', head: 'deadbeef', detached: true })
      ],
      hiddenPaths: ['/repo/.hidden/d']
    })
    const item = buildRepoItems(input).find((i) => i.path === '/repo/.hidden/d')!
    expect(item.kind).toBe('detached-worktree')
    expect(item.hidden).toBe(true)
  })

  it('still emits no item for the bare entry or a detached main worktree', () => {
    const input = baseInput({
      worktrees: [
        wt({ path: '/repo/.bare', branch: '', detached: false, bare: true }),
        wt({ path: '/repo', branch: '', head: 'mainsha', detached: true })
      ]
    })
    expect(buildRepoItems(input)).toEqual([])
  })
})

describe('buildRepoItems — PR-set completeness reaches the classifier (BUG-74)', () => {
  const WT = '/repo/wt-old'
  const clean = { trackedDirty: false, untracked: [] }

  function inputWithOldBranch(over: Partial<RepoScanInput> = {}): RepoScanInput {
    return baseInput({
      worktrees: [wt({ path: '/repo', branch: 'main' }), wt({ path: WT, branch: 'feat/old' })],
      localBranches: [{ branch: 'feat/old', sha: 'aa', committedAt: 1, upstream: null }],
      remoteHeads: new Map(),
      statusByPath: new Map([[WT, clean]]),
      unpushedByPath: new Map([[WT, false]]),
      ...over
    })
  }

  it('a branch missing from a capped set is unknown, never n/a', () => {
    const items = buildRepoItems(inputWithOldBranch({ prSetComplete: false }))
    const item = findItem(items, 'feat/old')!
    for (const id of ['pr', 'review', 'ci', 'pr-merged']) {
      expect(item.checkpoints.find((c) => c.id === id)?.state).toBe('unknown')
    }
    expect(item.verdict).not.toBe('harvestable')
  })

  it('an individually probed branch is authoritative even when the bulk set was capped', () => {
    const items = buildRepoItems(
      inputWithOldBranch({
        prSetComplete: false,
        prProbedBranches: new Set(['feat/old'])
      })
    )
    const item = findItem(items, 'feat/old')!
    expect(item.checkpoints.find((c) => c.id === 'pr')?.state).toBe('na')
  })

  // The whole point of the card: PR #7 in a 169-PR repo used to be invisible
  // behind `--limit 100`, so a merged, clean worktree rendered unharvestable.
  it('a merged PR recovered from beyond the old window makes a clean worktree harvestable', () => {
    const items = buildRepoItems(
      inputWithOldBranch({
        prSetComplete: false,
        prProbedBranches: new Set(['feat/old']),
        prByBranch: new Map<string, PrFacts>([
          [
            'feat/old',
            {
              number: 7,
              state: 'MERGED',
              reviewDecision: 'APPROVED',
              ci: 'passing',
              mergedAt: '2026-01-02T00:00:00Z'
            }
          ]
        ])
      })
    )
    const item = findItem(items, 'feat/old')!
    expect(item.verdict).toBe('harvestable')
    expect(item.justifiedBy).toBe('gh-merged')
  })
})

describe('snapshotTotals', () => {
  it('sums items, harvestable count, and reclaimableBytes (harvestable only)', () => {
    const snap: ReaperSnapshot = {
      scannedAt: 1,
      repos: [
        {
          repoPath: '/repo',
          items: [
            { ...blankItem(), verdict: 'harvestable', diskBytes: 1000 },
            { ...blankItem(), verdict: 'blocked', diskBytes: 500 },
            { ...blankItem(), verdict: 'harvestable', diskBytes: 2000 }
          ]
        }
      ]
    }
    expect(snapshotTotals(snap)).toEqual({ items: 3, harvestable: 2, reclaimableBytes: 3000 })
  })

  it('counts a detached worktree as an item but never toward harvestable or reclaimable', () => {
    const detachedItem = classifyDetachedWorktree(
      {
        repoPath: '/repo',
        path: '/repo/wt-detached',
        head: 'deadbeef',
        hidden: false,
        sessionLive: false,
        lastCommitAt: null,
        diskBytes: 7_340_032
      },
      1
    )
    const snap: ReaperSnapshot = {
      scannedAt: 1,
      repos: [{ repoPath: '/repo', items: [detachedItem] }]
    }
    expect(snapshotTotals(snap)).toEqual({ items: 1, harvestable: 0, reclaimableBytes: 0 })
    // The sweep set is built from newlyHarvestable / harvestable filters; a
    // detached item can never enter it.
    expect(newlyHarvestable(null, snap)).toEqual([])
  })
})

describe('newlyHarvestable', () => {
  it('includes items absent from prev, or non-harvestable in prev, that are harvestable in next', () => {
    const prev: ReaperSnapshot = {
      scannedAt: 0,
      repos: [
        {
          repoPath: '/repo',
          items: [
            { ...blankItem(), id: 'a', verdict: 'blocked' },
            { ...blankItem(), id: 'b', verdict: 'harvestable' }
          ]
        }
      ]
    }
    const next: ReaperSnapshot = {
      scannedAt: 1,
      repos: [
        {
          repoPath: '/repo',
          items: [
            { ...blankItem(), id: 'a', verdict: 'harvestable' }, // transitioned
            { ...blankItem(), id: 'b', verdict: 'harvestable' }, // unchanged, no re-alert
            { ...blankItem(), id: 'c', verdict: 'harvestable' } // new, absent from prev
          ]
        }
      ]
    }
    const alerts = newlyHarvestable(prev, next).map((i) => i.id)
    expect(alerts.sort()).toEqual(['a', 'c'])
  })

  it('treats a null prev as everything absent', () => {
    const next: ReaperSnapshot = {
      scannedAt: 1,
      repos: [{ repoPath: '/repo', items: [{ ...blankItem(), id: 'a', verdict: 'harvestable' }] }]
    }
    expect(newlyHarvestable(null, next).map((i) => i.id)).toEqual(['a'])
  })
})

function blankItem(): ReapItem {
  return {
    id: 'x',
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'x',
    path: '/repo/x',
    hidden: false,
    ageDays: null,
    diskBytes: null,
    checkpoints: [],
    verdict: 'unknown',
    blockers: [],
    needsRemoteDelete: false,
    justifiedBy: null
  }
}

// ---- BUG-93: the probe is read-only, and empty output is not containment -----

describe('squash-equivalence probe (BUG-93)', () => {
  it('AC-5: the scan writes no git objects — every probe argv is a read', () => {
    // The spec's own recipe used `git commit-tree`, which creates a real dangling
    // object; the scanner is documented inventory-only, so an hourly tick would
    // silently mutate every repo Harnu knows. This asserts over the commands
    // themselves, which is the only place the constraint can be checked without
    // an env-bound shell (ADR-0001).
    const writes = [
      'commit-tree',
      'hash-object',
      'write-tree',
      'mktree',
      'commit',
      'apply',
      'am',
      'stash',
      'replace',
      'notes',
      'update-ref',
      'update-index',
      'fast-import',
      'gc',
      'repack',
      'prune',
      'checkout',
      'switch',
      'reset',
      'merge',
      'rebase',
      'cherry-pick',
      'push',
      'fetch'
    ]
    const reads = ['log', 'diff', 'patch-id']
    const history = squashHistoryArgv('/repo', 'develop')
    const branch = squashBranchArgv('/repo', 'develop', 'feat/x')
    const argvs = [history.log, history.patchId, branch.diff, branch.patchId]

    for (const argv of argvs) {
      // `-C <repoPath>` always leads, so the verb is the third token.
      expect(argv.slice(0, 2)).toEqual(['-C', '/repo'])
      expect(reads).toContain(argv[2])
      for (const w of writes) expect(argv).not.toContain(w)
    }
  })

  it('uses the resolved default branch, never a transcribed origin/main', () => {
    expect(squashHistoryArgv('/repo', 'master').log).toContain('origin/master')
    expect(squashBranchArgv('/repo', 'master', 'feat/x').diff).toContain('origin/master...feat/x')
  })

  it('bounds the history walk so an unbounded default branch cannot stall a scan', () => {
    expect(squashHistoryArgv('/repo', 'main').log).toContain(`--max-count=${SQUASH_PROBE_HISTORY}`)
  })

  it('AC-4: empty probe output classifies as not-contained', () => {
    // A branch whose net diff against the merge-base is empty — a commit plus its
    // revert — emits nothing at all. Reading "nothing listed, therefore contained"
    // would make that a false positive.
    expect(isPatchIdContained('', new Set(['aaa']))).toBe(false)
    expect(isPatchIdContained('   \n\n', new Set(['aaa']))).toBe(false)
    // …and an empty history is not containment either.
    expect(isPatchIdContained('aaa 0000\n', new Set())).toBe(false)
  })

  it('matches a branch net diff against a squash commit on the default branch', () => {
    const history = parsePatchIdSet(['aaa c0ffee', 'bbb decafe'].join('\n'))
    expect(isPatchIdContained('bbb 0000000000000000000000000000000000000000\n', history)).toBe(true)
    expect(isPatchIdContained('ccc 0000000000000000000000000000000000000000\n', history)).toBe(
      false
    )
  })

  it('parses patch ids from the first field and ignores blank lines', () => {
    expect(parsePatchIdSet('aaa c0ffee\n\nbbb decafe\n')).toEqual(new Set(['aaa', 'bbb']))
    expect(parsePatchId('aaa c0ffee\n')).toBe('aaa')
    expect(parsePatchId('')).toBeNull()
  })
})

// ---- BUG-93: the shared-upstream fallback and its guard ----------------------

describe('resolvePrForBranch (BUG-93)', () => {
  const merged = (over: Partial<PrFacts> = {}): PrFacts => ({
    number: 59,
    state: 'MERGED',
    reviewDecision: 'APPROVED',
    ci: 'passing',
    mergedAt: '2026-07-01T00:00:00Z',
    headRefOid: 'c107c902',
    ...over
  })

  it('resolves by the branch own name and reports own-name provenance', () => {
    const map = new Map([['feat/x', merged()]])
    expect(resolvePrForBranch(map, 'feat/x', 'origin/other', 'tip')).toEqual({
      pr: merged(),
      provenance: 'own-name'
    })
  })

  it('follows the upstream when the branch own name has no PR', () => {
    const map = new Map([['feat/upstream', merged()]])
    const out = resolvePrForBranch(map, 'feat/sibling', 'origin/feat/upstream', 'c107c902')
    expect(out.pr?.number).toBe(59)
    expect(out.provenance).toBe('upstream-corroborated')
  })

  it('AC-3: reports upstream-unverified when the local tip is not the PR head', () => {
    // The verified shape: PR #59's head is c107c902, the sibling's tip is 81723195.
    const map = new Map([['feat/upstream', merged()]])
    const out = resolvePrForBranch(map, 'feat/sibling', 'origin/feat/upstream', '81723195')
    expect(out.pr?.number).toBe(59)
    expect(out.provenance).toBe('upstream-unverified')
  })

  it('cannot corroborate when gh supplied no head oid (a pre-BUG-93 cache entry)', () => {
    const map = new Map([['feat/upstream', merged({ headRefOid: null })]])
    const out = resolvePrForBranch(map, 'feat/sibling', 'origin/feat/upstream', '81723195')
    expect(out.provenance).toBe('upstream-unverified')
  })

  it('never follows an upstream on a remote other than origin', () => {
    const map = new Map([['feat/upstream', merged()]])
    expect(resolvePrForBranch(map, 'feat/sibling', 'fork/feat/upstream', 'c107c902')).toEqual({
      pr: null,
      provenance: 'own-name'
    })
  })

  it('reports own-name when there is no PR anywhere — no fallback was claimed', () => {
    expect(resolvePrForBranch(new Map(), 'feat/x', 'origin/feat/x', 'tip')).toEqual({
      pr: null,
      provenance: 'own-name'
    })
  })
})

describe('buildRepoItems — BUG-93 wiring', () => {
  it('AC-3: the sibling sharing an upstream is not merged; the PR owner is', () => {
    const pr: PrFacts = {
      number: 59,
      state: 'MERGED',
      reviewDecision: 'APPROVED',
      ci: 'passing',
      mergedAt: '2026-07-01T00:00:00Z',
      headRefOid: 'c107c902'
    }
    const input = baseInput({
      localBranches: [
        { branch: 'feat/owner', sha: 'c107c902', committedAt: 1, upstream: 'origin/feat/owner' },
        { branch: 'feat/sibling', sha: '81723195', committedAt: 1, upstream: 'origin/feat/owner' }
      ],
      prByBranch: new Map([['feat/owner', pr]]),
      ancestorByBranch: new Map([
        ['feat/owner', false],
        ['feat/sibling', false]
      ])
    })
    const items = buildRepoItems(input)
    expect(findItem(items, 'feat/owner')!.justifiedBy).toBe('gh-merged')
    expect(findItem(items, 'feat/sibling')!.justifiedBy).toBeNull()
    expect(findItem(items, 'feat/sibling')!.verdict).not.toBe('harvestable')
  })

  it('threads patch-id containment through as the squash signal', () => {
    const input = baseInput({
      localBranches: [
        { branch: 'feat/squashed', sha: 'aaa', committedAt: 1, upstream: 'origin/feat/squashed' }
      ],
      ghAvailable: false,
      prByBranch: null,
      prSetComplete: false,
      ancestorByBranch: new Map([['feat/squashed', false]]),
      patchIdContainedByBranch: new Map([['feat/squashed', true]])
    })
    const item = findItem(buildRepoItems(input), 'feat/squashed')!
    expect(item.justifiedBy).toBe('squash-equivalent')
  })
})
