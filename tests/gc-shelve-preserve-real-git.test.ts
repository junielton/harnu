// Real-git coverage of preserveWorktree (U2.1 AC-1, AC-2, AC-3): what a shelve keeps of a worktree
// that git does not already hold, where it keeps it, and when it refuses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { listShelveRecords, preserveWorktree, readShelveRecord } from '../src/main/gc/shelve-shell'
import {
  IGNORED_BYTES,
  archiveRefs,
  dirty,
  git,
  makeFixture,
  refNames,
  type Fixture
} from './gc-shelve-fixture'

const NOW = Date.parse('2026-11-05T10:00:00Z')

let fx: Fixture
beforeEach(() => {
  fx = makeFixture()
})
afterEach(() => fx.cleanup())

const input = (over: Record<string, unknown> = {}) => ({
  repoPath: fx.repo,
  worktreePath: fx.wt,
  branch: 'feat/x' as string | null,
  now: NOW,
  ...over
})

const files = (repo: string, ref: string): string[] =>
  git(repo, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean).sort()

describe('preserveWorktree — what it keeps (AC-1)', () => {
  it('keeps uncommitted + untracked state in the wip archive and the tip', async () => {
    const r = await preserveWorktree(input())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rec = r.record
    expect(rec.branch).toBe('feat/x')
    expect(rec.headSha).toBe(git(fx.repo, 'rev-parse', 'feat/x'))
    expect(git(fx.repo, 'rev-parse', rec.tipRef)).toBe(rec.headSha)
    expect(git(fx.repo, 'rev-parse', rec.wipRef)).toBe(rec.wipCommit)
    const wip = files(fx.repo, rec.wipRef)
    expect(wip).toContain('tracked.txt')
    expect(wip).toContain('staged.txt')
    expect(wip).toContain('notes/u.txt')
    expect(wip).toContain('link')
    expect(wip).not.toContain('deleted.txt')
    expect(wip).not.toContain('.env')
    expect(git(fx.repo, 'show', `${rec.wipRef}:tracked.txt`)).toBe('original\nlocal edit')
  })

  it('snapshots gitignored files outside dependency dirs, and leaves the dependency dirs out', async () => {
    const r = await preserveWorktree(input())
    expect(r.ok).toBe(true)
    if (!r.ok || !r.record.ignored) throw new Error('expected a snapshot')
    expect(files(fx.repo, r.record.ignored.ref)).toEqual(['.env', '.harnu/out/shot.txt'])
    expect(r.record.ignored.fileCount).toBe(2)
    expect(r.record.ignored.bytes).toBe(IGNORED_BYTES)
    expect(r.record.dependencyDirs).toContain('node_modules')
    expect(git(fx.repo, 'show', `${r.record.ignored.ref}:.env`)).toBe('SECRET=1')
  })

  it('takes the dependency dirs from the caller: with none listed, node_modules is snapshotted too', async () => {
    const r = await preserveWorktree(input({ dependencyDirs: [] }))
    expect(r.ok).toBe(true)
    if (!r.ok || !r.record.ignored) throw new Error('expected a snapshot')
    expect(files(fx.repo, r.record.ignored.ref)).toContain('node_modules/pkg/index.js')
  })

  it('records no snapshot when nothing ignored lies outside the dependency dirs', async () => {
    const { rmSync } = await import('node:fs')
    rmSync(path.join(fx.wt, '.env'))
    rmSync(path.join(fx.wt, '.harnu'), { recursive: true })
    const r = await preserveWorktree(input())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.record.ignored).toBeNull()
    expect(archiveRefs(fx.repo).some((n) => n.endsWith('/shelve/ignored'))).toBe(false)
  })

  it('refuses above the cap — with the numbers, and without writing a single ref', async () => {
    const before = refNames(fx.repo)
    const r = await preserveWorktree(input({ capBytes: IGNORED_BYTES - 1 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('snapshot-too-large')
    expect(r.capBytes).toBe(IGNORED_BYTES - 1)
    expect(r.bytes).toBeGreaterThan(IGNORED_BYTES - 1)
    expect(refNames(fx.repo)).toEqual(before)
  })

  it('accepts a snapshot exactly at the cap', async () => {
    const r = await preserveWorktree(input({ capBytes: IGNORED_BYTES }))
    expect(r.ok).toBe(true)
  })

  it('persists a record that reads back identical, and lists it', async () => {
    const r = await preserveWorktree(input())
    if (!r.ok) throw new Error(r.message)
    expect(await readShelveRecord(fx.repo, r.record.namespace)).toEqual(r.record)
    expect(await listShelveRecords(fx.repo)).toEqual([r.record])
  })
})

describe('preserveWorktree — stashes (AC-2)', () => {
  it('copies the stash entries that name the branch under its archive refs and never touches the stack', async () => {
    // Two stashes from feat/x, one from a branch whose name merely starts the same way.
    writeFileSync(path.join(fx.wt, 'tracked.txt'), 'stash one\n')
    git(fx.wt, 'stash', 'push', '-m', 'first')
    writeFileSync(path.join(fx.wt, 'tracked.txt'), 'stash two\n')
    git(fx.wt, 'stash', 'push')
    const other = path.join(fx.root, 'trees', 'feat-x-2')
    git(fx.repo, 'worktree', 'add', '-q', '-b', 'feat/x-2', other)
    writeFileSync(path.join(other, 'tracked.txt'), 'other branch\n')
    git(other, 'stash', 'push', '-m', 'elsewhere')
    dirty(fx.wt)

    const stackBefore = git(fx.repo, 'stash', 'list', '--format=%H %gs')
    const stashRefBefore = git(fx.repo, 'rev-parse', 'refs/stash')
    const r = await preserveWorktree(input())
    if (!r.ok) throw new Error(r.message)

    expect(r.record.stashes).toHaveLength(2)
    expect(r.record.stashes.map((s) => s.subject).sort()).toEqual(
      ['On feat/x: first', expect.stringMatching(/^WIP on feat\/x: /)].sort()
    )
    for (const s of r.record.stashes) {
      expect(s.ref.startsWith(`${r.record.namespace}/shelve/stash/`)).toBe(true)
      expect(git(fx.repo, 'rev-parse', s.ref)).toBe(s.sha)
    }
    expect(git(fx.repo, 'stash', 'list', '--format=%H %gs')).toBe(stackBefore)
    expect(git(fx.repo, 'rev-parse', 'refs/stash')).toBe(stashRefBefore)
  })
})

describe('preserveWorktree — detached HEAD (AC-3)', () => {
  it('archives the commit a detached worktree stands on', async () => {
    const det = path.join(fx.root, 'trees', 'det')
    git(fx.repo, 'worktree', 'add', '-q', '--detach', det)
    writeFileSync(path.join(det, 'tracked.txt'), 'detached edit\n')
    const head = git(det, 'rev-parse', 'HEAD')
    const r = await preserveWorktree(input({ worktreePath: det, branch: null }))
    if (!r.ok) throw new Error(r.message)
    expect(r.record.branch).toBeNull()
    expect(r.record.headSha).toBe(head)
    expect(r.record.tipRef.startsWith('refs/archive/detached/')).toBe(true)
    expect(git(fx.repo, 'rev-parse', r.record.tipRef)).toBe(head)
    expect(git(fx.repo, 'show', `${r.record.wipRef}:tracked.txt`)).toBe('detached edit')
    expect(r.record.stashes).toEqual([])
  })
})

describe('preserveWorktree — refusals leave nothing behind', () => {
  it('refuses a nested git repository: add -A would record an empty pointer, not its files', async () => {
    const nested = path.join(fx.wt, 'vendored-clone')
    mkdirSync(nested)
    git(nested, 'init', '-q', '-b', 'main')
    git(
      nested,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x'
    )
    writeFileSync(path.join(nested, 'work.txt'), 'only here\n')
    const before = refNames(fx.repo)
    const r = await preserveWorktree(input())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('nested-repository')
    expect(refNames(fx.repo)).toEqual(before)
  })

  it('refuses a worktree that is not on disk', async () => {
    const r = await preserveWorktree(input({ worktreePath: path.join(fx.root, 'nope') }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('worktree-missing')
  })

  it('refuses a second preservation of the same branch in the same second without touching the first', async () => {
    const first = await preserveWorktree(input())
    if (!first.ok) throw new Error(first.message)
    const before = refNames(fx.repo)
    const second = await preserveWorktree(input())
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('ref-exists')
    expect(refNames(fx.repo)).toEqual(before)
    expect(git(fx.repo, 'rev-parse', first.record.wipRef)).toBe(first.record.wipCommit)
  })
})

describe('preserveWorktree — only refs/archive/** is written', () => {
  it('adds refs under refs/archive/ and nothing else', async () => {
    const before = refNames(fx.repo).filter((n) => !n.startsWith('refs/archive/'))
    const r = await preserveWorktree(input())
    expect(r.ok).toBe(true)
    expect(refNames(fx.repo).filter((n) => !n.startsWith('refs/archive/'))).toEqual(before)
    expect(archiveRefs(fx.repo).length).toBeGreaterThanOrEqual(4)
  })
})
