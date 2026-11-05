// Real-git coverage of restoreWorktree (U2.1 AC-5 / design AC-U2a): preserve → the folder is removed
// (the test does it; U2.2 will) → restore recreates it at the same path, byte for byte.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { preserveWorktree, restoreWorktree, verifyPreservation } from '../src/main/gc/shelve-shell'
import type { ShelveRecord } from '../src/main/gc/shelve-core'
import { digestTree, git, makeFixture, type Fixture } from './gc-shelve-fixture'

const NOW = Date.parse('2026-11-05T10:00:00Z')

let fx: Fixture
beforeEach(() => {
  fx = makeFixture()
})
afterEach(() => fx.cleanup())

async function preserve(wt = fx.wt, branch: string | null = 'feat/x'): Promise<ShelveRecord> {
  const r = await preserveWorktree({ repoPath: fx.repo, worktreePath: wt, branch, now: NOW })
  if (!r.ok) throw new Error(r.message)
  return r.record
}

/** A record whose (valid, verifiable) snapshot holds `tracked.txt`, which the wip state restores first. */
function collidingSnapshot(record: ShelveRecord): ShelveRecord {
  const blob = git(fx.repo, 'rev-parse', `${record.wipRef}:tracked.txt`)
  const tree = execFileSync('git', ['-C', fx.repo, 'mktree'], {
    input: `100644 blob ${blob}\ttracked.txt\n`,
    encoding: 'utf8'
  }).trim()
  const commit = execFileSync(
    'git',
    [
      '-C',
      fx.repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e.com',
      'commit-tree',
      tree,
      '-m',
      'x'
    ],
    { encoding: 'utf8' }
  ).trim()
  const ref = `${record.namespace}/shelve/ignored`
  git(fx.repo, 'update-ref', ref, commit)
  return { ...record, ignored: { ref, commit, tree, fileCount: 1, bytes: 1 } }
}

/** What the folder holds that survives a shelve: everything but `.git` and the dependency dirs. */
const digest = (wt: string): Record<string, string> => digestTree(wt, ['node_modules'])

describe('restoreWorktree — the round trip (AC-5)', () => {
  it('recreates the worktree at its path with every file byte-identical', async () => {
    const before = digest(fx.wt)
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true }) // the registration in git goes stale, as after rm -rf

    const r = await restoreWorktree(record)
    expect(r).toMatchObject({ ok: true, path: fx.wt, attached: true, reason: null })
    expect(digest(fx.wt)).toEqual(before)
    // Spot checks the digest covers: the deleted tracked file stays deleted, the executable keeps its
    // bit, the symlink stays a symlink, the ignored files are back, the dependencies are not.
    expect(existsSync(path.join(fx.wt, 'deleted.txt'))).toBe(false)
    expect(before['run.sh']!.startsWith('x:')).toBe(true)
    expect(before['link']!.startsWith('link:')).toBe(true)
    expect(existsSync(path.join(fx.wt, '.env'))).toBe(true)
    expect(existsSync(path.join(fx.wt, '.harnu', 'out', 'shot.txt'))).toBe(true)
    expect(existsSync(path.join(fx.wt, 'node_modules'))).toBe(false)
  })

  it('lands on the branch, with the work uncommitted exactly as it was', async () => {
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    await restoreWorktree(record)
    expect(git(fx.wt, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/x')
    expect(git(fx.wt, 'rev-parse', 'HEAD')).toBe(record.headSha)
    const status = git(fx.wt, 'status', '--porcelain').split('\n')
    expect(status).toContain('M tracked.txt'.padStart(' M tracked.txt'.length))
    expect(status).toContain(' D deleted.txt')
    expect(status).toContain('?? notes/')
    expect(status).toContain('?? staged.txt')
  })

  it('works after the stale registration was pruned as well', async () => {
    const before = digest(fx.wt)
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    git(fx.repo, 'worktree', 'prune')
    const r = await restoreWorktree(record)
    expect(r.ok).toBe(true)
    expect(digest(fx.wt)).toEqual(before)
  })

  it('restores a detached worktree at its archived commit', async () => {
    const det = path.join(fx.root, 'trees', 'det')
    git(fx.repo, 'worktree', 'add', '-q', '--detach', det)
    writeFileSync(path.join(det, 'tracked.txt'), 'detached edit\n')
    writeFileSync(path.join(det, 'loose.txt'), 'untracked\n')
    const before = digest(det)
    const record = await preserve(det, null)
    rmSync(det, { recursive: true, force: true })
    const r = await restoreWorktree(record)
    expect(r).toMatchObject({ ok: true, attached: false, reason: 'no-branch' })
    expect(git(det, 'rev-parse', 'HEAD')).toBe(record.headSha)
    expect(digest(det)).toEqual(before)
  })

  it('hands back the stash copies the record keeps (restore never re-creates stash entries)', async () => {
    writeFileSync(path.join(fx.wt, 'tracked.txt'), 'stashed\n')
    git(fx.wt, 'stash', 'push', '-m', 'keep me')
    const { dirty } = await import('./gc-shelve-fixture')
    dirty(fx.wt)
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    const r = await restoreWorktree(record)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.stashes.map((s) => s.subject)).toEqual(['On feat/x: keep me'])
  })
})

describe('restoreWorktree — when the branch cannot be re-attached', () => {
  it('restores detached at the archived HEAD when the branch moved, never putting old bytes on new commits', async () => {
    const before = digest(fx.wt)
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    git(fx.repo, 'worktree', 'prune')
    writeFileSync(path.join(fx.repo, 'later.txt'), 'later\n')
    git(fx.repo, 'add', 'later.txt')
    git(fx.repo, 'commit', '-q', '-m', 'later')
    git(fx.repo, 'branch', '-f', 'feat/x', 'main')

    const r = await restoreWorktree(record)
    expect(r).toMatchObject({ ok: true, attached: false, reason: 'branch-moved' })
    expect(git(fx.wt, 'rev-parse', 'HEAD')).toBe(record.headSha)
    expect(digest(fx.wt)).toEqual(before)
    expect(git(fx.repo, 'rev-parse', 'feat/x')).toBe(git(fx.repo, 'rev-parse', 'main'))
  })

  it('restores detached when another worktree has the branch checked out', async () => {
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    git(fx.repo, 'worktree', 'prune')
    const other = path.join(fx.root, 'trees', 'other')
    git(fx.repo, 'worktree', 'add', '-q', other, 'feat/x')

    const r = await restoreWorktree(record)
    expect(r).toMatchObject({ ok: true, attached: false, reason: 'branch-checked-out-elsewhere' })
    expect(git(fx.wt, 'rev-parse', 'HEAD')).toBe(record.headSha)
  })

  it('restores detached when the branch no longer exists', async () => {
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    git(fx.repo, 'worktree', 'prune')
    git(fx.repo, 'branch', '-D', 'feat/x')
    const r = await restoreWorktree(record)
    expect(r).toMatchObject({ ok: true, attached: false, reason: 'branch-missing' })
  })
})

describe('restoreWorktree — refusals', () => {
  it('never overwrites a folder that is already there', async () => {
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    mkdirSync(fx.wt, { recursive: true })
    writeFileSync(path.join(fx.wt, 'precious.txt'), 'do not touch\n')
    const before = digestTree(fx.wt)
    const r = await restoreWorktree(record)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('path-exists')
    expect(digestTree(fx.wt)).toEqual(before)
  })

  it('refuses, creating nothing, when the archive cannot be verified', async () => {
    const record = await preserve()
    const oid = git(fx.repo, 'rev-parse', `${record.ignored!.ref}:.env`)
    rmSync(path.join(fx.repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true })
    rmSync(fx.wt, { recursive: true, force: true })
    const r = await restoreWorktree(record)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('archive-unverified')
    expect(existsSync(fx.wt)).toBe(false)
  })

  it('leaves no half-restored folder behind when the unpack fails, and the archive still restores', async () => {
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    // A sound snapshot (it verifies) that collides with a file the wip state has already put back:
    // the worktree is added and the wip applied, then the unpack fails.
    const colliding = collidingSnapshot(record)
    const r = await restoreWorktree(colliding)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('snapshot-failed')
    expect(existsSync(fx.wt)).toBe(false)
    const again = await restoreWorktree(record)
    expect(again.ok).toBe(true)
  })

  it('a restored worktree verifies against its record', async () => {
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    await restoreWorktree(record)
    expect(await verifyPreservation(record)).toEqual({ ok: true, mode: 'live' })
  })
})
