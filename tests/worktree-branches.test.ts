import { describe, it, expect } from 'vitest'
import {
  parseBranchRefs,
  slugFromBranch,
  findExistingWorkForSlug,
  type BranchRef,
  type WorktreeListEntry
} from '../src/main/worktree-core'

/**
 * `parseBranchRefs` backs the New-worktree dialog's base-ref select (T48). The
 * shell issues one `git for-each-ref --format='%(refname:short)\t%(objectname:short)'`
 * per refspec (`refs/heads` vs `refs/remotes`) and passes the `remote` origin
 * explicitly, so the parser never guesses remote-ness from the name.
 */
describe('parseBranchRefs', () => {
  it('parses `name<TAB>head` lines and preserves git order', () => {
    const stdout = ['main\t1111111', 'feat/login\t2222222', 'release/1.2.0\t3333333'].join('\n')
    expect(parseBranchRefs(stdout, { remote: false })).toEqual<BranchRef[]>([
      { name: 'main', remote: false, head: '1111111' },
      { name: 'feat/login', remote: false, head: '2222222' },
      { name: 'release/1.2.0', remote: false, head: '3333333' }
    ])
  })

  it('propagates the `remote` flag from the caller', () => {
    const stdout = 'origin/main\taaaaaaa\norigin/feat/login\tbbbbbbb'
    expect(parseBranchRefs(stdout, { remote: true })).toEqual<BranchRef[]>([
      { name: 'origin/main', remote: true, head: 'aaaaaaa' },
      { name: 'origin/feat/login', remote: true, head: 'bbbbbbb' }
    ])
  })

  it('drops the `origin/HEAD` symbolic pointer from the remote group', () => {
    const stdout = ['origin/HEAD\tccccccc', 'origin/main\tddddddd'].join('\n')
    expect(parseBranchRefs(stdout, { remote: true })).toEqual<BranchRef[]>([
      { name: 'origin/main', remote: true, head: 'ddddddd' }
    ])
  })

  it('ignores blank lines and tolerates CRLF', () => {
    const stdout = 'main\t1111111\r\n\r\nfeat/x\t2222222\r\n'
    expect(parseBranchRefs(stdout, { remote: false })).toEqual<BranchRef[]>([
      { name: 'main', remote: false, head: '1111111' },
      { name: 'feat/x', remote: false, head: '2222222' }
    ])
  })

  it('tolerates a missing head column (empty SHA)', () => {
    expect(parseBranchRefs('main', { remote: false })).toEqual<BranchRef[]>([
      { name: 'main', remote: false, head: '' }
    ])
  })

  it('returns an empty list for empty output (commit-less / non-repo)', () => {
    expect(parseBranchRefs('', { remote: false })).toEqual([])
    expect(parseBranchRefs('\n\n', { remote: true })).toEqual([])
  })
})

/**
 * `slugFromBranch` + `findExistingWorkForSlug` back the `create_worktree` ACK's
 * `existingWork` warning (BUG-40 §3.5 / BUG-50 absorbed). `deriveWorktreePath`
 * and `dispatch-substrate.ts`'s `worktreeDispatchBranch` both key a card's
 * worktree by its slug, so any other branch/worktree whose name embeds that
 * slug is cheap, deterministic evidence of prior or duplicate work.
 */
describe('slugFromBranch', () => {
  it('strips the `card/` prefix for a card-dispatched branch', () => {
    expect(slugFromBranch('card/BUG-40-dispatch-race')).toBe('BUG-40-dispatch-race')
  })

  it('returns the branch name unchanged when it has no `card/` prefix', () => {
    expect(slugFromBranch('feat/login')).toBe('feat/login')
  })
})

describe('findExistingWorkForSlug', () => {
  const branches = (names: string[]): BranchRef[] =>
    names.map((name) => ({ name, remote: false, head: 'abc1234' }))

  const worktree = (over: Partial<WorktreeListEntry>): WorktreeListEntry => ({
    path: '/home/u/repo/.claude/worktrees/other',
    head: 'abc1234',
    branch: '',
    detached: false,
    bare: false,
    ...over
  })

  it('warns when a branch embeds the same card slug', () => {
    const matches = findExistingWorkForSlug(
      'BUG-40-dispatch-race',
      branches(['card/BUG-40-dispatch-race-old', 'main']),
      []
    )
    expect(matches).toEqual([{ kind: 'branch', name: 'card/BUG-40-dispatch-race-old' }])
  })

  it('warns when a worktree path embeds the slug even if its branch name does not', () => {
    const matches = findExistingWorkForSlug(
      'BUG-40',
      [],
      [worktree({ path: '/home/u/repo/.claude/worktrees/card-BUG-40-old', branch: 'renamed' })]
    )
    expect(matches).toEqual([
      { kind: 'worktree', name: '/home/u/repo/.claude/worktrees/card-BUG-40-old' }
    ])
  })

  it('excludes the literal branch about to be created — a first-time create never warns about itself', () => {
    const matches = findExistingWorkForSlug(
      'BUG-40',
      branches(['card/BUG-40']),
      [worktree({ path: '/r/.claude/worktrees/card-BUG-40', branch: 'card/BUG-40' })],
      'card/BUG-40'
    )
    expect(matches).toEqual([])
  })

  it('ignores bare (non-worktree) entries', () => {
    const matches = findExistingWorkForSlug(
      'BUG-40',
      [],
      [worktree({ path: '/r/.bare', branch: '', bare: true })]
    )
    expect(matches).toEqual([])
  })

  it('returns an empty array for an empty slug', () => {
    expect(findExistingWorkForSlug('', branches(['card/BUG-40']), [])).toEqual([])
  })

  it('returns an empty array when nothing embeds the slug', () => {
    expect(findExistingWorkForSlug('BUG-99', branches(['main', 'card/BUG-40']), [])).toEqual([])
  })
})
