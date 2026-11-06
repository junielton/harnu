// Guardrails of the shelve engine (U2.1 AC-6, spec §5, risk 3): preservation data stays local and
// durable — refs only under refs/archive/**, nothing pushed or fetched, no git gc by the engine, and
// a shelve record is never expired while its branch exists.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { expiredArchives } from '../src/main/gc/archives-core'
import { execGit, listRepoArchives } from '../src/main/gc/archives-shell'
import { preserveWorktree, restoreWorktree, verifyPreservation } from '../src/main/gc/shelve-shell'
import type { ShelveRecord } from '../src/main/gc/shelve-core'
import { digestTree, git, makeFixture, refNames, type Fixture } from './gc-shelve-fixture'

const NOW = Date.parse('2026-11-05T10:00:00Z')
const DAY = 86_400_000
const FAR = NOW + 3650 * DAY

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

describe('local only', () => {
  it('preserve, verify and restore work with an unreachable remote and never touch remote state', async () => {
    git(fx.repo, 'remote', 'add', 'origin', path.join(fx.root, 'no-such-remote.git'))
    const remoteConfig = git(fx.repo, 'config', '--get-regexp', '^remote\\.')
    const before = digestTree(fx.wt, ['node_modules'])
    const record = await preserve()
    expect((await verifyPreservation(record)).ok).toBe(true)
    rmSync(fx.wt, { recursive: true, force: true })
    expect((await restoreWorktree(record)).ok).toBe(true)
    expect(digestTree(fx.wt)).toEqual(before)
    expect(refNames(fx.repo).filter((r) => r.startsWith('refs/remotes/'))).toEqual([])
    expect(git(fx.repo, 'config', '--get-regexp', '^remote\\.')).toBe(remoteConfig)
  })

  it('restore adds no ref and no stash entry', async () => {
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    const refs = refNames(fx.repo)
    const stash = git(fx.repo, 'stash', 'list')
    expect((await restoreWorktree(record)).ok).toBe(true)
    expect(refNames(fx.repo)).toEqual(refs)
    expect(git(fx.repo, 'stash', 'list')).toBe(stash)
  })

  it('the engine source never pushes, fetches, pulls, clones or runs gc, and never mutates the stash stack', () => {
    const src = readFileSync(path.join(__dirname, '../src/main/gc/shelve-shell.ts'), 'utf8')
    expect(src).not.toMatch(/'(push|fetch|pull|clone|gc|filter-branch|reflog)'/)
    expect(src).not.toMatch(/'stash',\s*'(push|pop|drop|clear|apply|save|branch|store|create)'/)
  })
})

describe('durable', () => {
  it('survives the reflogs expiring and a gc that prunes everything unreachable', async () => {
    const before = digestTree(fx.wt, ['node_modules'])
    const record = await preserve()
    rmSync(fx.wt, { recursive: true, force: true })
    git(fx.repo, 'worktree', 'prune')
    // Test-only, in a throwaway repo: the engine itself never runs gc.
    git(fx.repo, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all')
    git(fx.repo, 'gc', '-q', '--prune=now')

    expect(await verifyPreservation(record, { mode: 'archive' })).toEqual({
      ok: true,
      mode: 'archive'
    })
    expect((await restoreWorktree(record)).ok).toBe(true)
    expect(digestTree(fx.wt)).toEqual(before)
  })

  it('keeps an uncommitted file that no ref but the archive reaches, through the same gc', async () => {
    writeFileSync(path.join(fx.wt, 'only-here.txt'), 'exists nowhere else\n')
    const record = await preserve()
    const blob = git(fx.repo, 'rev-parse', `${record.wipRef}:only-here.txt`)
    rmSync(fx.wt, { recursive: true, force: true })
    git(fx.repo, 'worktree', 'prune')
    git(fx.repo, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all')
    git(fx.repo, 'gc', '-q', '--prune=now')
    expect(git(fx.repo, 'cat-file', '-t', blob)).toBe('blob')
  })
})

describe('never expired while the branch exists', () => {
  it('a shelved branch archive is not expired by any retention, however old', async () => {
    await preserve()
    const entries = await listRepoArchives(execGit, fx.repo)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.shelved).toBe(true)
    expect(expiredArchives(entries, 1, FAR)).toEqual([])
    expect(expiredArchives(entries, 1, FAR, new Set(['some-other-branch']))).toEqual([])
  })

  it('the same archive does expire once the caller proves the branch is gone', async () => {
    await preserve()
    const entries = await listRepoArchives(execGit, fx.repo)
    expect(expiredArchives(entries, 1, FAR, new Set(['feat/x']))).toHaveLength(1)
  })

  it('a detached shelve has no branch to be gone and is never expired', async () => {
    const det = path.join(fx.root, 'trees', 'det')
    git(fx.repo, 'worktree', 'add', '-q', '--detach', det)
    await preserve(det, null)
    const entries = await listRepoArchives(execGit, fx.repo)
    expect(entries.every((e) => e.shelved)).toBe(true)
    expect(expiredArchives(entries, 1, FAR, new Set(['feat/x', 'main']))).toEqual([])
  })
})
