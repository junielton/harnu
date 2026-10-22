// AC-C1 / AC-C2 against a REAL repository: the size of what only `refs/archive/*` keeps alive,
// listing, and expiry by deleting refs (never `git gc`). A mock could not say whether
// `rev-list --objects --disk-usage` really leaves out what a branch also reaches.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { archiveTip, archiveWip } from '../src/main/reaper/archive-shell'
import {
  archiveBytes,
  deleteArchiveEntries,
  execGit,
  listRepoArchives,
  runGitGc
} from '../src/main/gc/archives-shell'
import { expiredArchives } from '../src/main/gc/archives-core'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com'
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV }).trim()

let root: string
let repo: string

function commitBlob(file: string, bytes: number, msg: string): string {
  writeFileSync(path.join(repo, file), randomBytes(bytes))
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', msg)
  return git(repo, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-archives-'))
  repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV })
  commitBlob('shared.bin', 1_000_000, 'main work')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A feature branch with its own 2 MB blob, archived the way a sweep does, then deleted. */
async function archiveFeature(branch: string, stamp: string, withWip: boolean): Promise<string> {
  git(repo, 'checkout', '-q', '-b', branch)
  const tip = commitBlob(`${branch.replace(/\W/g, '_')}.bin`, 2_000_000, `work on ${branch}`)
  const ns = `refs/archive/${branch}/${stamp}`
  await archiveTip(repo, `${ns}/tip`, tip)
  if (withWip) {
    writeFileSync(path.join(repo, 'unsaved.txt'), 'not committed\n')
    await archiveWip(repo, `${ns}/wip`, repo)
  }
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'branch', '-D', branch)
  // A real removal leaves no reflog behind (the branch's own log goes with the branch, and a
  // worktree's HEAD log with the worktree). Here the main checkout's HEAD log still names the tip.
  git(repo, 'reflog', 'expire', '--expire=now', '--all')
  return tip
}

describe('archiveBytes (AC-C1)', () => {
  it('is 0 for a repo with no archives', async () => {
    expect(await archiveBytes(execGit, repo)).toBe(0)
  })

  it('counts what ONLY the archive refs keep alive, not what a branch also reaches', async () => {
    await archiveFeature('feat/login', '20261002T101500Z', true)
    const bytes = await archiveBytes(execGit, repo)
    expect(bytes).not.toBeNull()
    // The 2 MB blob is archive-only. The 1 MB blob on main is reachable from `main`, so it is out.
    expect(bytes!).toBeGreaterThan(1_900_000)
    expect(bytes!).toBeLessThan(2_300_000)
  })

  it('a branch that still reaches the archived commit makes it not archive-only', async () => {
    const tip = await archiveFeature('feat/login', '20261002T101500Z', false)
    git(repo, 'branch', 'kept', tip)
    expect(await archiveBytes(execGit, repo)).toBe(0)
  })

  it('an archive whose commit is also reachable from the reflog estimates 0: deleting it frees nothing', async () => {
    // No reflog expiry here: HEAD's log (still holding the feature tip) keeps the objects alive.
    git(repo, 'checkout', '-q', '-b', 'feat/login')
    const tip = commitBlob('login.bin', 2_000_000, 'work on login')
    await archiveTip(repo, 'refs/archive/feat/login/20261002T101500Z/tip', tip)
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'branch', '-D', 'feat/login')
    expect(git(repo, 'reflog', '-n', '5')).toContain('login')
    expect(await archiveBytes(execGit, repo)).toBe(0)
  })

  it('an object the index holds is not archive-only either', async () => {
    const bytes = randomBytes(1_500_000)
    git(repo, 'checkout', '-q', '-b', 'feat/x')
    writeFileSync(path.join(repo, 'staged.bin'), bytes)
    git(repo, 'add', 'staged.bin')
    git(repo, 'commit', '-q', '-m', 'x')
    const tip = git(repo, 'rev-parse', 'HEAD')
    await archiveTip(repo, 'refs/archive/feat/x/20261002T101500Z/tip', tip)
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'branch', '-D', 'feat/x')
    git(repo, 'reflog', 'expire', '--expire=now', '--all')
    const before = await archiveBytes(execGit, repo)
    expect(before!).toBeGreaterThan(1_400_000)
    // The same content staged in main's index: it now lives there too, whatever happens to the archive.
    writeFileSync(path.join(repo, 'staged.bin'), bytes)
    git(repo, 'add', 'staged.bin')
    const after = await archiveBytes(execGit, repo)
    expect(after!).toBeLessThan(before! - 1_400_000)
  })

  it('is null when git cannot answer, never a made-up figure', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('git: unknown option `disk-usage`')
    }
    expect(await archiveBytes(failing, repo)).toBeNull()
  })
})

describe('listRepoArchives', () => {
  it('lists one entry per archived sweep with its tip, wip and date', async () => {
    const tip = await archiveFeature('feat/login', '20261002T101500Z', true)
    await archiveFeature('feat/other', '20261003T101500Z', false)
    const entries = await listRepoArchives(execGit, repo)
    expect(entries.map((e) => e.branch)).toEqual(['feat/other', 'feat/login'])
    const login = entries.find((e) => e.branch === 'feat/login')!
    expect(login.tipSha).toBe(tip)
    expect(login.hasWip).toBe(true)
    expect(login.at).toBe(Date.parse('2026-10-02T10:15:00Z'))
    expect(entries.find((e) => e.branch === 'feat/other')!.hasWip).toBe(false)
  })

  it('lists any other ref under refs/archive generically', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/archive/detached/20261001T000000Z/tip', head)
    git(repo, 'update-ref', 'refs/archive/hand-made', head)
    const entries = await listRepoArchives(execGit, repo)
    expect(entries).toHaveLength(2)
    expect(entries.some((e) => e.detached)).toBe(true)
  })

  it('is empty, not an error, for a repo with no archive refs', async () => {
    expect(await listRepoArchives(execGit, repo)).toEqual([])
  })
})

describe('deleteArchiveEntries + retention (AC-C2)', () => {
  it('deletes only the expired refs, and never runs git gc: their objects are still there', async () => {
    const oldTip = await archiveFeature('feat/old', '20260801T000000Z', true)
    const newTip = await archiveFeature('feat/new', '20261010T000000Z', true)
    const now = Date.parse('2026-10-12T12:00:00Z')

    const entries = await listRepoArchives(execGit, repo)
    const expired = expiredArchives(entries, 30, now)
    expect(expired.map((e) => e.branch)).toEqual(['feat/old'])

    const result = await deleteArchiveEntries(execGit, repo, expired)
    expect(result.failed).toEqual([])
    expect(result.deleted).toHaveLength(2) // the tip ref and the wip ref
    expect(result.archives).toBe(1) // ...of ONE archive

    const left = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/archive/')
    expect(left).not.toContain('feat/old')
    expect(left).toContain('feat/new')
    // Deleting refs does not reclaim objects: that waits for git's own gc.
    expect(git(repo, 'cat-file', '-t', oldTip)).toBe('commit')
    expect(git(repo, 'cat-file', '-t', newTip)).toBe('commit')
  })

  it('refuses a ref that moved since it was listed (the sha it was shown is checked)', async () => {
    await archiveFeature('feat/old', '20260801T000000Z', false)
    const [entry] = await listRepoArchives(execGit, repo)
    // Somebody re-pointed the ref after the list the operator confirmed.
    const other = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', entry!.tipRef!, other)
    const result = await deleteArchiveEntries(execGit, repo, [entry!])
    expect(result.deleted).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(git(repo, 'rev-parse', entry!.tipRef!)).toBe(other)
  })

  it('never deletes a ref outside refs/archive/', async () => {
    const result = await deleteArchiveEntries(execGit, repo, [
      {
        repoPath: repo,
        namespace: 'refs/heads/main',
        refs: ['refs/heads/main'],
        tipRef: 'refs/heads/main',
        tipSha: git(repo, 'rev-parse', 'main'),
        wipRef: null,
        wipSha: null,
        hasWip: false,
        branch: 'main',
        detached: false,
        at: 0,
        restoreCommand: null,
        wipRestoreCommand: null
      }
    ])
    expect(result.deleted).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/main')).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('hand-made refs never auto-expire (delta-1 item 7)', () => {
  it('a ref with no stamp in its name has an unknown age and is never expired', async () => {
    const head = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/archive/hand-made', head)
    git(repo, 'update-ref', 'refs/archive/detached/20260101T000000Z/tip', head)
    const entries = await listRepoArchives(execGit, repo)
    const handMade = entries.find((e) => e.namespace === 'refs/archive/hand-made')!
    expect(handMade.ageKnown).toBe(false)
    const far = Date.parse('2030-01-01T00:00:00Z')
    const expired = expiredArchives(entries, 1, far)
    expect(expired.map((e) => e.namespace)).toEqual(['refs/archive/detached/20260101T000000Z'])
  })
})

describe('runGitGc', () => {
  it('runs git gc with a one-hour prune window and keeps everything reachable', async () => {
    const oldTip = await archiveFeature('feat/old', '20260801T000000Z', false)
    const entries = await listRepoArchives(execGit, repo)
    await deleteArchiveEntries(execGit, repo, entries)
    await runGitGc(execGit, repo)
    // Reachable from main: untouched. The just-unreferenced objects are younger than the window.
    expect(git(repo, 'cat-file', '-t', 'main')).toBe('commit')
    expect(git(repo, 'cat-file', '-t', oldTip)).toBe('commit')
    expect(git(repo, 'fsck', '--connectivity-only')).toBeDefined()
  })
})
