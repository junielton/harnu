import { describe, it, expect } from 'vitest'
import { buildRepoItems, type RepoScanInput } from '../src/main/reaper/scan-core'
import { buildBundles, type BuildBundlesInput } from '../src/main/gc/bundle-core'
import type { BranchFacts, PrFacts } from '../src/main/reaper/reaper-core'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-07T12:00:00Z')
const REPO = '/ws/org/proj/www'
const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'
const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const MERGED_AT = new Date(NOW - 10 * DAY).toISOString()

const pr = (headRefOid: string | null): PrFacts => ({
  number: 92,
  state: 'MERGED',
  reviewDecision: 'APPROVED',
  ci: 'passing',
  mergedAt: MERGED_AT,
  headRefOid
})

function scanInput(over: Partial<RepoScanInput> = {}): RepoScanInput {
  return {
    repoPath: REPO,
    defaultBranch: 'main',
    protectedBranches: ['main'],
    worktrees: [
      { path: REPO, head: 'f'.repeat(40), branch: 'main', detached: false, bare: false },
      { path: WT, head: HEAD, branch: 'feat/slug', detached: false, bare: false }
    ],
    mainWorktreePath: REPO,
    localBranches: [
      { branch: 'feat/slug', sha: HEAD, committedAt: NOW - 11 * DAY, upstream: null }
    ],
    remoteHeads: new Map(),
    prByBranch: new Map([['feat/slug', pr(HEAD)]]),
    ghAvailable: true,
    prSetComplete: true,
    hiddenPaths: [],
    liveFolders: new Set(),
    statusByPath: new Map([[WT, { trackedDirty: false, untracked: [] }]]),
    unpushedByPath: new Map([[WT, false]]),
    ancestorByBranch: new Map([['feat/slug', false]]),
    patchIdContainedByBranch: new Map(),
    now: NOW,
    ...over
  }
}

function collect(input: RepoScanInput) {
  const fateInputs = new Map<string, { facts: BranchFacts; localTip: string | null }>()
  const items = buildRepoItems({
    ...input,
    collectFateInput: (id, fi) => fateInputs.set(id, fi)
  })
  return { items, fateInputs }
}

function bundlesOf(input: RepoScanInput) {
  const { items, fateInputs } = collect(input)
  const args: BuildBundlesInput = {
    items,
    fateInputs,
    stacks: [],
    stackPaths: new Map(),
    containers: [],
    sessions: new Map(),
    keep: new Set(),
    neverClean: new Set(),
    now: NOW,
    graceDays: 2,
    volumes: new Map()
  }
  return buildBundles(args)
}

describe('the scanner hands the fate inputs to the bundle builder (AC-5)', () => {
  it('collects BranchFacts and the real checked-out SHA for each worktree item', () => {
    const { items, fateInputs } = collect(scanInput())
    const item = items.find((i) => i.path === WT)!
    const got = fateInputs.get(item.id)!
    expect(got.localTip).toBe(HEAD)
    expect(got.facts.branch).toBe('feat/slug')
    expect(got.facts.pr?.headRefOid).toBe(HEAD)
  })

  it('uses the worktree HEAD, not the branch ref, as the local tip', () => {
    const moved = scanInput({
      worktrees: [
        { path: REPO, head: 'f'.repeat(40), branch: 'main', detached: false, bare: false },
        { path: WT, head: OTHER, branch: 'feat/slug', detached: false, bare: false }
      ]
    })
    const { items, fateInputs } = collect(moved)
    expect(fateInputs.get(items.find((i) => i.path === WT)!.id)!.localTip).toBe(OTHER)
  })

  it('does not collect for a detached worktree (it has no branch facts)', () => {
    const detached = scanInput({
      worktrees: [
        { path: REPO, head: 'f'.repeat(40), branch: 'main', detached: false, bare: false },
        { path: WT, head: HEAD, branch: '', detached: true, bare: false }
      ]
    })
    expect(collect(detached).fateInputs.size).toBe(0)
  })

  it('leaves buildRepoItems unchanged when no collector is given', () => {
    expect(buildRepoItems(scanInput())).toEqual(collect(scanInput()).items)
  })
})

describe('a PR head that is not the worktree HEAD is not a corpse (AC-5, Review Focus 1)', () => {
  it('is a corpse when the PR head equals the worktree HEAD', () => {
    const [b] = bundlesOf(scanInput())
    expect(b!.fate).toMatchObject({ fate: 'merged', signal: 'gh-merged', strong: true })
    expect(b!.bucket).toBe('corpse')
    expect(b!.localTip).toBe(HEAD)
  })

  it('is weak, so Decide, when the branch moved on after the merge', () => {
    const [b] = bundlesOf(scanInput({ prByBranch: new Map([['feat/slug', pr(OTHER)]]) }))
    expect(b!.fate.strong).toBe(false)
    expect(b!.bucket).toBe('decide')
    expect(b!.reason?.code).toBe('weak-merge-signal')
  })

  it('is weak when gh reported no head OID at all', () => {
    const [b] = bundlesOf(scanInput({ prByBranch: new Map([['feat/slug', pr(null)]]) }))
    expect(b!.fate.strong).toBe(false)
    expect(b!.bucket).toBe('decide')
  })
})
