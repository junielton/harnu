import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  evidenceFromGit,
  provenGone,
  worktreeParentsOf,
  type RemovalEvidence
} from '../src/main/gc/gc-orphan-proof'
import { fsPathExistence } from '../src/main/gc/gc-orphan-existence'

/**
 * Delta-2 item 1: a transcript folder is "gone" only when that is positively proven, never inferred
 * from "not found". Proof is one of: Harnu's own record of removing that folder; git listing it as
 * prunable (its worktree registration outlived the folder) in a repo that still exists; or the
 * folder sitting under a known worktrees parent that exists and can be read. Everything else that
 * is missing (an sshfs share that is not mounted, a folder somebody deleted) is "not found".
 */

const none: RemovalEvidence = { removed: [], prunable: [], worktreeParents: [] }

describe('provenGone', () => {
  it('the sshfs case: a project inside an unmounted user mount is not proven', () => {
    expect(provenGone('/home/u/remote/proj', none)).toBeNull()
    expect(provenGone('/home/u/remote/proj/worktrees/x', none)).toBeNull()
  })

  it('a random deleted directory is not proven', () => {
    expect(provenGone('/home/u/old/thing', none)).toBeNull()
  })

  it('Harnu removed it: the exact folder, and anything under it, is proven', () => {
    const ev = { ...none, removed: ['/home/u/work/repo/.claude/worktrees/feat-a'] }
    expect(provenGone('/home/u/work/repo/.claude/worktrees/feat-a', ev)).toBe('removed-by-harnu')
    expect(provenGone('/home/u/work/repo/.claude/worktrees/feat-a/api', ev)).toBe(
      'removed-by-harnu'
    )
    // a sibling that merely shares the prefix is not
    expect(provenGone('/home/u/work/repo/.claude/worktrees/feat-a2', ev)).toBeNull()
  })

  it('git lists it as prunable in a repo that still exists: proven', () => {
    const ev = { ...none, prunable: ['/home/u/trees/wt-9'] }
    expect(provenGone('/home/u/trees/wt-9', ev)).toBe('git-prunable')
    expect(provenGone('/home/u/trees/wt-9/sub', ev)).toBe('git-prunable')
    expect(provenGone('/home/u/trees/other', ev)).toBeNull()
  })

  it('under a known worktrees parent that exists and can be read: proven; unreadable: not', () => {
    const parent = '/home/u/work/repo/.claude/worktrees'
    const ok = { ...none, worktreeParents: [{ parent, readable: true }] }
    expect(provenGone(`${parent}/feat-x`, ok)).toBe('under-worktrees-parent')
    expect(provenGone(`${parent}/feat-x/api/src`, ok)).toBe('under-worktrees-parent')
    expect(provenGone(parent, ok)).toBeNull()
    const unreadable = { ...none, worktreeParents: [{ parent, readable: false }] }
    expect(provenGone(`${parent}/feat-x`, unreadable)).toBeNull()
  })

  it('the same answers on macOS, where paths compare without case', () => {
    const ev: RemovalEvidence = {
      removed: ['/Users/U/Work/Repo/.claude/worktrees/Feat-A'],
      prunable: [],
      worktreeParents: [{ parent: '/Users/u/work/repo/.claude/worktrees', readable: true }]
    }
    expect(provenGone('/Users/u/work/repo/.claude/worktrees/feat-a/api', ev, 'darwin')).toBe(
      'removed-by-harnu'
    )
    expect(provenGone('/Users/U/Work/Repo/.claude/worktrees/NEW', ev, 'darwin')).toBe(
      'under-worktrees-parent'
    )
    // an unplugged external drive and an sshfs mount are not proven there either
    expect(provenGone('/Volumes/Disk/proj/wt', ev, 'darwin')).toBeNull()
    expect(provenGone('/Users/u/remote/proj', ev, 'darwin')).toBeNull()
    // and on Linux the same paths differing only in case are different folders
    expect(provenGone('/Users/u/work/repo/.claude/worktrees/feat-a/api', ev, 'linux')).toBeNull()
  })
})

describe('worktreeParentsOf', () => {
  it('names `<repo>/.claude/worktrees` and `<name>-worktrees` beside a known repo, and no other', () => {
    expect(worktreeParentsOf(['/w/org/proj/www', '/w/api'], 'linux').sort()).toEqual(
      [
        '/w/api-worktrees',
        '/w/api/.claude/worktrees',
        '/w/org/proj/www-worktrees',
        '/w/org/proj/www/.claude/worktrees'
      ].sort()
    )
  })
})

describe('evidenceFromGit (the repos that still exist and what git says)', () => {
  const porcelain = [
    'worktree /w/repo',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /w/repo/.claude/worktrees/live',
    'HEAD bbbb',
    'branch refs/heads/live',
    '',
    'worktree /w/repo/.claude/worktrees/gone',
    'HEAD cccc',
    'branch refs/heads/gone',
    'prunable gitdir file points to non-existent location',
    ''
  ].join('\n')

  it('collects the prunable worktrees of existing repos only', async () => {
    const asked: string[] = []
    const ev = await evidenceFromGit({
      repoPaths: ['/w/repo', '/w/vanished'],
      repoExists: async (p) => p === '/w/repo',
      worktreeList: async (repo) => {
        asked.push(repo)
        return porcelain
      },
      readable: async () => true,
      removed: ['/x/removed']
    })
    expect(asked).toEqual(['/w/repo'])
    expect(ev.prunable).toEqual(['/w/repo/.claude/worktrees/gone'])
    expect(ev.removed).toEqual(['/x/removed'])
    expect(ev.worktreeParents.map((p) => p.parent).sort()).toEqual([
      '/w/repo-worktrees',
      '/w/repo/.claude/worktrees'
    ])
  })

  it('a git that fails for a repo adds no proof for it', async () => {
    const ev = await evidenceFromGit({
      repoPaths: ['/w/repo'],
      repoExists: async () => true,
      worktreeList: async () => {
        throw new Error('git: not a repository')
      },
      readable: async () => false,
      removed: []
    })
    expect(ev.prunable).toEqual([])
    expect(ev.worktreeParents.every((p) => !p.readable)).toBe(true)
  })
})

describe('fsPathExistence is now only "is it there" (it proves nothing about being gone)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-exist-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  it('there, missing, and an error that is neither', async () => {
    expect(await fsPathExistence(root)).toBe('exists')
    expect(await fsPathExistence(path.join(root, 'nope'))).toBe('missing')
    vi.fn()
    expect(await fsPathExistence(`${root}/\0bad`)).toBe('unknown')
  })
})
