// Units A and C meet here, against a REAL repository. A removes a detached worktree by archiving it
// under `refs/archive/detached/<folder>-<sha12>/{tip,wip,wip-<stamp>,reflog/<sha12>}` (it has no
// branch to name the refs after); C's Archives category lists `refs/archive/**` generically. This pins
// the promise between them: every ref A writes is listed, none is hidden or silently skipped, none
// is ever expired on its own (the name carries no sweep stamp, so its age is unknown), and each can
// be deleted by hand with the same guarded call as any other archive.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { planArchive } from '../src/main/reaper/archive-core'
import { archiveTip, archiveWip, createReflogArchiver } from '../src/main/reaper/archive-shell'
import { deleteArchiveEntries, execGit, listRepoArchives } from '../src/main/gc/archives-shell'
import { expiredArchives } from '../src/main/gc/archives-core'

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

let root: string
let repo: string
let wt: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-nde-ac-'))
  repo = path.join(root, 'org', 'proj', 'www')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, ...ID, 'commit', '-q', '--allow-empty', '-m', 'init')
  wt = path.join(root, 'trees', 'bisect-1')
  git(repo, 'worktree', 'add', '-q', '--detach', wt)
  // A commit only this worktree's reflog will reach once HEAD moves on, then uncommitted work.
  writeFileSync(path.join(wt, 'a.txt'), 'orphan work\n')
  git(wt, 'add', 'a.txt')
  git(wt, ...ID, 'commit', '-q', '-m', 'orphan work')
  writeFileSync(path.join(wt, 'a.txt'), 'orphan work\nedited\n')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/** What a real removal of the detached worktree writes: tip, wip, an earlier wip kept as a sibling, reflog refs. */
async function archiveTheWayARemovalDoes(): Promise<string> {
  const head = git(wt, 'rev-parse', 'HEAD')
  const plan = planArchive(
    { kind: 'detached-worktree', branch: undefined, path: wt, headSha: head },
    Date.parse('2026-10-12T10:00:00Z')
  )
  // The reflog step runs first, as in the forced ops: a commit only HEAD's own history reaches.
  git(wt, ...ID, 'commit', '-q', '--allow-empty', '-m', 'reachable only by reflog')
  git(wt, 'checkout', '-q', '--detach', head)
  await createReflogArchiver().archive(repo, `${plan.namespace}/reflog`, wt)
  await archiveTip(repo, plan.tip!.ref, head)
  await archiveWip(repo, plan.wip!.ref, wt)
  // The same folder at the same commit again, with different files: the earlier wip moves to a sibling.
  writeFileSync(path.join(wt, 'b.txt'), 'later work\n')
  await archiveWip(repo, plan.wip!.ref, wt)
  return plan.namespace!
}

const allRefs = (): string[] =>
  git(repo, 'for-each-ref', '--format=%(refname)', 'refs/archive')
    .split('\n')
    .filter(Boolean)
    .sort()

describe('the Archives category lists what a detached removal wrote (A × C)', () => {
  it('lists every ref A wrote: tip, wip, the wip-<stamp> sibling and each reflog ref', async () => {
    const ns = await archiveTheWayARemovalDoes()
    const written = allRefs()
    // Guard the premise: all four kinds of ref really exist, or this test would prove nothing.
    expect(written).toContain(`${ns}/tip`)
    expect(written).toContain(`${ns}/wip`)
    expect(written.some((r) => /\/wip-\d{14}$/.test(r))).toBe(true)
    expect(written.some((r) => r.startsWith(`${ns}/reflog/`))).toBe(true)

    const entries = await listRepoArchives(execGit, repo)
    const listed = entries.flatMap((e) => e.refs).sort()
    expect(listed).toEqual(written)
    // Nothing of A's is read as a branch: it has none.
    expect(entries.every((e) => e.branch === null)).toBe(true)
  })

  it('never expires them on its own: the name carries no sweep stamp, so the age is unknown', async () => {
    await archiveTheWayARemovalDoes()
    const entries = await listRepoArchives(execGit, repo)
    expect(entries.every((e) => !e.ageKnown)).toBe(true)
    expect(expiredArchives(entries, 1, Date.parse('2100-01-01T00:00:00Z'))).toEqual([])
  })

  it('deletes each by hand, and only under refs/archive/', async () => {
    await archiveTheWayARemovalDoes()
    const entries = await listRepoArchives(execGit, repo)
    const res = await deleteArchiveEntries(execGit, repo, entries)
    expect(res.failed).toEqual([])
    expect(allRefs()).toEqual([])
    // The repo's own branches are untouched.
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main')
  })
})
