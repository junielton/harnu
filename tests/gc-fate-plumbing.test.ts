import { describe, it, expect } from 'vitest'
import { buildRepoItems } from '../src/main/reaper/scan-core'
import { HEAD, OTHER, REPO, WT, bundlesOf, collect, pr, scanInput } from './gc-scan-fixtures'

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

describe('a PR head that is not the worktree HEAD is not a ready item (AC-5, Review Focus 1)', () => {
  it('is a ready item when the PR head equals the worktree HEAD', () => {
    const [b] = bundlesOf(scanInput())
    expect(b!.fate).toMatchObject({ fate: 'merged', signal: 'gh-merged', strong: true })
    expect(b!.bucket).toBe('ready')
    expect(b!.localTip).toBe(HEAD)
  })

  it('is weak, so Needs review, when the branch moved on after the merge', () => {
    const [b] = bundlesOf(scanInput({ prByBranch: new Map([['feat/slug', pr(OTHER)]]) }))
    expect(b!.fate.strong).toBe(false)
    expect(b!.bucket).toBe('review')
    expect(b!.reason?.code).toBe('weak-merge-signal')
  })

  it('is weak when gh reported no head OID at all', () => {
    const [b] = bundlesOf(scanInput({ prByBranch: new Map([['feat/slug', pr(null)]]) }))
    expect(b!.fate.strong).toBe(false)
    expect(b!.bucket).toBe('review')
  })
})
