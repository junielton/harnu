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
    expect(provenGone('/Users/U/Work/Repo/.claude/worktrees/feat-a/api', ev, 'linux')).toBeNull()
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

// ---- delta-3: the root of the removed worktree must itself be missing ---------------------------------

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { proofRoots, proveGone } from '../src/main/gc/gc-orphan-proof'

describe('proof holds only while the worktree root itself is missing (delta-3 items 1 and 3)', () => {
  let root: string
  let parent: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-proofroot-'))
    parent = path.join(root, 'repo', '.claude', 'worktrees')
    mkdirSync(parent, { recursive: true })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const evidence = (over: Partial<RemovalEvidence> = {}): RemovalEvidence => ({
    removed: [],
    prunable: [],
    worktreeParents: [{ parent, readable: true }],
    ...over
  })

  it('proofRoots names the segment directly under the parent, the prunable entry, the ledger entry', () => {
    const ev = evidence({ removed: ['/x/removed'], prunable: ['/x/pruned'] })
    expect(proofRoots(path.join(parent, 'wt', 'api', 'src'), ev)).toEqual([
      { proof: 'under-worktrees-parent', root: path.join(parent, 'wt') }
    ])
    expect(proofRoots('/x/pruned/sub', ev)).toEqual([{ proof: 'git-prunable', root: '/x/pruned' }])
    expect(proofRoots('/x/removed/sub', ev)).toEqual([
      { proof: 'removed-by-harnu', root: '/x/removed' }
    ])
  })

  it('a worktree that is really gone proves its subfolders', async () => {
    expect(await proveGone(path.join(parent, 'wt', 'api'), evidence(), fsPathExistence)).toBe(true)
  })

  it('a dangling symlink where the worktree was (its drive is unmounted) proves nothing', async () => {
    symlinkSync('/nonexistent/unmounted/drive/wt', path.join(parent, 'wt'))
    expect(await proveGone(path.join(parent, 'wt', 'api'), evidence(), fsPathExistence)).toBe(false)
  })

  it('an empty mount point where the worktree was proves nothing', async () => {
    mkdirSync(path.join(parent, 'wt'))
    expect(await proveGone(path.join(parent, 'wt', 'api'), evidence(), fsPathExistence)).toBe(false)
  })

  it('a worktree directory that exists is not gone, whatever is missing inside it', async () => {
    mkdirSync(path.join(parent, 'wt'))
    writeFileSync(path.join(parent, 'wt', 'f.txt'), 'x')
    expect(await proveGone(path.join(parent, 'wt', 'api'), evidence(), fsPathExistence)).toBe(false)
  })

  it('a folder git lists as prunable proves nothing once its root is back (even as an empty mount point)', async () => {
    const wt = path.join(root, 'trees', 'wt-9')
    const ev = evidence({ prunable: [wt] })
    expect(await proveGone(path.join(wt, 'sub'), ev, fsPathExistence)).toBe(true)
    mkdirSync(wt, { recursive: true })
    expect(await proveGone(path.join(wt, 'sub'), ev, fsPathExistence)).toBe(false)
  })

  it('a ledger entry stops proving anything under it once that folder exists again (item 3)', async () => {
    const removed = path.join(root, 'work', 'feat-a')
    const ev = evidence({ removed: [removed] })
    expect(await proveGone(path.join(removed, 'api'), ev, fsPathExistence)).toBe(true)
    mkdirSync(removed, { recursive: true })
    expect(await proveGone(path.join(removed, 'api'), ev, fsPathExistence)).toBe(false)
  })

  it('any one proof that holds is enough', async () => {
    const removed = path.join(parent, 'wt')
    mkdirSync(removed) // the ledger entry is back...
    const ev = evidence({ removed: [removed], prunable: [path.join(parent, 'wt', 'api')] })
    // ...but git still lists the subfolder's own registration as prunable and it is missing.
    expect(await proveGone(path.join(parent, 'wt', 'api', 'x'), ev, fsPathExistence)).toBe(true)
  })
})

describe('git’s prunable reason (delta-3 item 1, proof b)', () => {
  const block = (reason: string): string =>
    [
      'worktree /w/repo',
      'HEAD a',
      'branch refs/heads/main',
      '',
      'worktree /w/wt',
      'HEAD b',
      'branch refs/heads/x',
      reason,
      ''
    ].join('\n')

  it('only "gitdir file points to non-existent location" counts', async () => {
    const mk = async (reason: string) =>
      (
        await evidenceFromGit({
          repoPaths: ['/w/repo'],
          repoExists: async () => true,
          worktreeList: async () => block(reason),
          readable: async () => true,
          removed: []
        })
      ).prunable
    expect(await mk('prunable gitdir file points to non-existent location')).toEqual(['/w/wt'])
    expect(await mk('prunable gitdir file does not exist')).toEqual([])
    expect(await mk('prunable invalid gitdir file')).toEqual([])
    expect(await mk('prunable')).toEqual([])
  })
})

// ---- delta-4: Windows paths ------------------------------------------------------------------------------

describe('the worktree root on Windows (delta-4)', () => {
  const parent = 'C:\\Users\\u\\repo\\.claude\\worktrees'
  const ev = (p = parent): RemovalEvidence => ({
    removed: [],
    prunable: [],
    worktreeParents: [{ parent: p, readable: true }]
  })
  const missing = async (): Promise<'missing'> => 'missing'
  const present = async (): Promise<'exists'> => 'exists'

  it('a drive path: the root is the folder directly under the parent, in drive-letter form', () => {
    expect(proofRoots(`${parent}\\wt\\api\\src`, ev(), 'win32')).toEqual([
      { proof: 'under-worktrees-parent', root: 'C:\\Users\\u\\repo\\.claude\\worktrees\\wt' }
    ])
  })

  it('a UNC path keeps its server and share', () => {
    const unc = '\\\\srv\\share\\repo\\.claude\\worktrees'
    expect(proofRoots(`${unc}\\wt\\api`, ev(unc), 'win32')).toEqual([
      { proof: 'under-worktrees-parent', root: '\\\\srv\\share\\repo\\.claude\\worktrees\\wt' }
    ])
    // a different share is a different place
    expect(
      proofRoots('\\\\srv\\other\\repo\\.claude\\worktrees\\wt\\api', ev(unc), 'win32')
    ).toEqual([])
  })

  it('compares without case and across slash styles, and keeps the folder’s own spelling', () => {
    expect(proofRoots('c:/USERS/U/Repo/.claude/Worktrees/WT/api', ev(), 'win32')).toEqual([
      { proof: 'under-worktrees-parent', root: 'c:\\USERS\\U\\Repo\\.claude\\Worktrees\\WT' }
    ])
    // another drive is another place
    expect(proofRoots('D:\\Users\\u\\repo\\.claude\\worktrees\\wt\\api', ev(), 'win32')).toEqual([])
  })

  it('never builds a posix-looking nonsense root (the old split of a drive path)', () => {
    for (const { root } of proofRoots(`${parent}\\wt\\api`, ev(), 'win32')) {
      expect(root).not.toMatch(/^\/|\/\//)
      expect(root.startsWith('C:\\')).toBe(true)
    }
  })

  it('a relative or drive-relative folder cannot be rooted reliably: no proof', () => {
    expect(proofRoots('worktrees\\wt\\api', ev('worktrees'), 'win32')).toEqual([])
    expect(proofRoots('C:wt\\api', ev(), 'win32')).toEqual([])
  })

  it('the parent itself and a sibling that shares its prefix are not under it', () => {
    expect(proofRoots(parent, ev(), 'win32')).toEqual([])
    expect(proofRoots(`${parent}-x\\wt\\api`, ev(), 'win32')).toEqual([])
  })

  it('a really gone root is proven; a junction or an empty mount point there is not', async () => {
    const folder = `${parent}\\wt\\api`
    expect(await proveGone(folder, ev(), missing, 'win32')).toBe(true)
    // a junction or an empty mount point still lstats as something
    expect(await proveGone(folder, ev(), present, 'win32')).toBe(false)
    expect(await proveGone(folder, ev(), async () => 'unknown', 'win32')).toBe(false)
  })

  it('the root handed to the existence check is the Windows one', async () => {
    const asked: string[] = []
    await proveGone(`${parent}\\wt\\api`, ev(), async (p) => (asked.push(p), 'missing'), 'win32')
    expect(asked).toEqual(['C:\\Users\\u\\repo\\.claude\\worktrees\\wt'])
  })

  it('worktree parents of a Windows repo use Windows separators', () => {
    expect(worktreeParentsOf(['C:\\w\\repo'], 'win32').sort()).toEqual(
      ['C:\\w\\repo-worktrees', 'C:\\w\\repo\\.claude\\worktrees'].sort()
    )
  })
})
