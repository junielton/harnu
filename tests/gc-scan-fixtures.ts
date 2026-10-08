// Scan-level fixtures shared by the Workspace GC tests: a repo with one merged feature
// worktree, built through the real buildRepoItems + buildBundles so the fate inputs are real.

import { buildRepoItems, type RepoScanInput } from '../src/main/reaper/scan-core'
import { AS_GIVEN, buildBundles, type BuildBundlesInput } from '../src/main/gc/bundle-core'
import type { BranchFacts, PrFacts } from '../src/main/reaper/reaper-core'

export const DAY = 86_400_000
export const NOW = Date.parse('2026-10-07T12:00:00Z')
export const REPO = '/ws/org/proj/www'
export const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'
export const HEAD = 'a'.repeat(40)
export const OTHER = 'b'.repeat(40)
export const MERGED_AT = new Date(NOW - 10 * DAY).toISOString()

export const pr = (headRefOid: string | null): PrFacts => ({
  number: 92,
  state: 'MERGED',
  reviewDecision: 'APPROVED',
  ci: 'passing',
  mergedAt: MERGED_AT,
  headRefOid
})

export function scanInput(over: Partial<RepoScanInput> = {}): RepoScanInput {
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

export function collect(input: RepoScanInput) {
  const fateInputs = new Map<string, { facts: BranchFacts; localTip: string | null }>()
  const items = buildRepoItems({
    ...input,
    collectFateInput: (id, fi) => fateInputs.set(id, fi)
  })
  return { items, fateInputs }
}

export function bundlesOf(input: RepoScanInput) {
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
    volumes: new Map(),
    knownFolders: [],
    protectedProjects: new Set(),
    canonical: AS_GIVEN,
    foreignCheckouts: new Map(items.map((i) => [i.id, []]))
  }
  return buildBundles(args)
}
