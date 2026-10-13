// Units A, C and E meet here, against a REAL repository. A removes a detached worktree by archiving it
// under `refs/archive/detached/<stamp>/<folder>-<sha12>/{tip,wip,wip-<stamp>,reflog/<sha12>}` (it has
// no branch to name the refs after); C's Archives category lists `refs/archive/**`. Unit E pins the
// promise between them: the refs of ONE removal are ONE archive entry, dated from the stamp in the
// path, so it expires like any other archive, is deleted as a whole, and still restores. Refs an
// older Harnu wrote without a stamp are grouped the same way and keep an unknown age.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { planArchive } from '../src/main/reaper/archive-core'
import { archiveTip, archiveWip, createReflogArchiver } from '../src/main/reaper/archive-shell'
import { deleteArchiveEntries, execGit, listRepoArchives } from '../src/main/gc/archives-shell'
import { confirmedArchives, expiredArchives } from '../src/main/gc/archives-core'

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

const REMOVED_AT = Date.parse('2026-10-12T10:00:00Z')
const DAY = 86_400_000

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
async function archiveTheWayARemovalDoes(at = REMOVED_AT): Promise<string> {
  const head = git(wt, 'rev-parse', 'HEAD')
  const plan = planArchive(
    { kind: 'detached-worktree', branch: undefined, path: wt, headSha: head },
    at
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

describe('a detached removal is one archive in the Archives category (A × C × E)', () => {
  it('stamps the namespace with the archive time and groups every ref A wrote into ONE entry', async () => {
    const ns = await archiveTheWayARemovalDoes()
    expect(ns).toMatch(/^refs\/archive\/detached\/20261012T100000Z\/bisect-1-[0-9a-f]{12}$/)
    const written = allRefs()
    // Guard the premise: all four kinds of ref really exist, or this test would prove nothing.
    expect(written).toContain(`${ns}/tip`)
    expect(written).toContain(`${ns}/wip`)
    expect(written.some((r) => /\/wip-\d{14}$/.test(r))).toBe(true)
    expect(written.some((r) => r.startsWith(`${ns}/reflog/`))).toBe(true)

    const entries = await listRepoArchives(execGit, repo)
    expect(entries).toHaveLength(1)
    const [e] = entries
    expect(e).toMatchObject({
      namespace: ns,
      detached: true,
      branch: null,
      hasWip: true,
      ageKnown: true,
      at: REMOVED_AT
    })
    // Nothing of A's is hidden or skipped: every ref is a member of the one entry.
    expect([...e!.refs].sort()).toEqual(written)
    expect(e!.reflogCount).toBe(written.filter((r) => r.startsWith(`${ns}/reflog/`)).length)
    expect(e!.reflogCount).toBeGreaterThan(0)
    expect(e!.tipSha).toBe(git(repo, 'rev-parse', `${ns}/tip`))
  })

  it('applies the retention to the group as a whole: it expires once, as one archive', async () => {
    await archiveTheWayARemovalDoes()
    const entries = await listRepoArchives(execGit, repo)
    expect(expiredArchives(entries, 30, REMOVED_AT + 10 * DAY)).toEqual([])
    const expired = expiredArchives(entries, 30, REMOVED_AT + 31 * DAY)
    expect(expired).toHaveLength(1)
    expect(expired[0]!.refs.length).toBe(allRefs().length)
  })

  it('deleting the group deletes all of its refs, and only under refs/archive/', async () => {
    await archiveTheWayARemovalDoes()
    const entries = await listRepoArchives(execGit, repo)
    const total = allRefs().length
    const res = await deleteArchiveEntries(execGit, repo, entries)
    expect(res.failed).toEqual([])
    expect(res.deleted).toHaveLength(total)
    // One archive was deleted, not one per ref.
    expect(res.archives).toBe(1)
    expect(allRefs()).toEqual([])
    // The repo's own branches are untouched.
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main')
  })

  it('leaves the whole group alone when the confirm no longer matches what is in the repo', async () => {
    const ns = await archiveTheWayARemovalDoes()
    const [shown] = await listRepoArchives(execGit, repo)
    const confirm = {
      namespace: ns,
      tipSha: shown!.tipSha,
      wipSha: shown!.wipSha,
      memberCount: shown!.refs.length
    }
    // A ref is added to the group after the operator was shown it.
    git(repo, 'update-ref', `${ns}/reflog/ffffffffffff`, shown!.tipSha!)
    const fresh = await listRepoArchives(execGit, repo)
    expect(confirmedArchives(fresh, [confirm])).toEqual({ entries: [], changed: [ns] })
    expect(allRefs().length).toBe(shown!.refs.length + 1)
  })

  it('restores with the copied commands: the tip as a branch, the working state as a worktree', async () => {
    const ns = await archiveTheWayARemovalDoes()
    const [e] = await listRepoArchives(execGit, repo)
    expect(e!.restoreCommand).toBeTruthy()
    expect(e!.wipRestoreCommand).toBeTruthy()

    // Run them exactly as the operator would paste them, from inside the repo.
    const run = (cmd: string): void => {
      execFileSync('sh', ['-c', cmd], { cwd: repo, stdio: 'pipe' })
    }
    run(e!.restoreCommand!)
    const branch = git(repo, 'branch', '--list', 'restored-*', '--format=%(refname:short)')
    expect(branch).toMatch(/^restored-[0-9a-f]{7}$/)
    expect(git(repo, 'rev-parse', branch)).toBe(git(repo, 'rev-parse', `${ns}/tip`))

    run(e!.wipRestoreCommand!)
    const back = path.join(repo, '..', `restored-${e!.wipSha!.slice(0, 7)}`)
    expect(readFileSync(path.join(back, 'a.txt'), 'utf8')).toBe('orphan work\nedited\n')
  })

  it('two removals of the same folder at the same commit are two archives, each with its own date', async () => {
    const first = await archiveTheWayARemovalDoes(REMOVED_AT)
    const second = await archiveTheWayARemovalDoes(REMOVED_AT + 40 * DAY)
    expect(second).not.toBe(first)
    const entries = await listRepoArchives(execGit, repo)
    expect(entries.map((e) => e.namespace)).toEqual([second, first])
    // Only the older one is past a 30-day retention at the second's date.
    expect(expiredArchives(entries, 30, REMOVED_AT + 41 * DAY).map((e) => e.namespace)).toEqual([
      first
    ])
  })
})

describe('refs an older Harnu wrote without a stamp (A × C)', () => {
  /** The layout before unit E: `refs/archive/detached/<folder>-<sha12>/…`, no time in it. */
  async function legacyRemoval(): Promise<string> {
    const head = git(wt, 'rev-parse', 'HEAD')
    const ns = `refs/archive/detached/bisect-1-${head.slice(0, 12)}`
    git(wt, ...ID, 'commit', '-q', '--allow-empty', '-m', 'reachable only by reflog')
    git(wt, 'checkout', '-q', '--detach', head)
    await createReflogArchiver().archive(repo, `${ns}/reflog`, wt)
    await archiveTip(repo, `${ns}/tip`, head)
    await archiveWip(repo, `${ns}/wip`, wt)
    return ns
  }

  it('are one entry as well, listed with an unknown age that never expires on its own', async () => {
    const ns = await legacyRemoval()
    const entries = await listRepoArchives(execGit, repo)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ namespace: ns, ageKnown: false, hasWip: true })
    expect(entries[0]!.reflogCount).toBeGreaterThan(0)
    expect(expiredArchives(entries, 1, Date.parse('2100-01-01T00:00:00Z'))).toEqual([])
  })

  it('can still be deleted by hand, as a whole', async () => {
    await legacyRemoval()
    const entries = await listRepoArchives(execGit, repo)
    const res = await deleteArchiveEntries(execGit, repo, entries)
    expect(res.failed).toEqual([])
    expect(res.archives).toBe(1)
    expect(allRefs()).toEqual([])
  })
})
