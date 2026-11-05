// The facts a shelve decision is bound to (U2.2 AC-4): HEAD, a fingerprint of the uncommitted work,
// the newest edited file, and when the last commit was made. Against real git.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { probeShelve, sameBinding } from '../src/main/gc/shelve-probe-shell'
import { git, makeFixture, type Fixture } from './gc-shelve-fixture'

let fx: Fixture
beforeEach(() => {
  fx = makeFixture()
})
afterEach(() => fx.cleanup())

/** A second worktree with nothing uncommitted and a commit dated 2026-10-01T12:00:00Z. */
function cleanWorktree(): { wt: string; commitMs: number } {
  const wt = path.join(fx.root, 'trees', 'clean')
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'feat/clean', wt)
  writeFileSync(path.join(wt, 'c.txt'), 'c\n')
  git(wt, 'add', 'c.txt')
  const when = '2026-10-01T12:00:00Z'
  execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'dated'], {
    env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }
  })
  return { wt, commitMs: Date.parse(when) }
}

const itemOf = (wt: string) => ({ item: { repoPath: fx.repo, path: wt } })

describe('probeShelve (AC-4)', () => {
  it('a clean worktree has no work stamp and no edited file; it reports its HEAD and last commit', async () => {
    const { wt, commitMs } = cleanWorktree()
    const p = await probeShelve(itemOf(wt), { readManifest: async () => ({ delegates: false }) })
    expect(p.headSha).toBe(git(wt, 'rev-parse', 'HEAD'))
    expect(p.workStamp).toBeNull()
    expect(p.newestMtime).toBeNull()
    expect(p.lastCommitAt).toBe(commitMs)
    expect(p.manifestDelegates).toBe(false)
  })

  it('uncommitted work gives a stamp and the newest mtime of the files git lists', async () => {
    const m = path.join(fx.wt, 'notes', 'u.txt')
    const when = new Date('2026-11-01T08:00:00Z')
    utimesSync(m, when, when)
    // every other dirty file is older
    for (const f of ['tracked.txt', 'staged.txt', 'run.sh', 'link']) {
      try {
        utimesSync(
          path.join(fx.wt, f),
          new Date('2026-10-20T00:00:00Z'),
          new Date('2026-10-20T00:00:00Z')
        )
      } catch {
        // the symlink: utimes follows it, fine
      }
    }
    const p = await probeShelve(itemOf(fx.wt), { readManifest: async () => ({ delegates: false }) })
    expect(p.workStamp).toMatch(/^[0-9a-f]{64}$/)
    expect(p.newestMtime).toBe(statSync(m).mtimeMs)
  })

  it('a new commit changes HEAD; an edit changes the stamp', async () => {
    const deps = { readManifest: async () => ({ delegates: false }) }
    const before = await probeShelve(itemOf(fx.wt), deps)
    writeFileSync(path.join(fx.wt, 'tracked.txt'), 'original\nanother edit\n')
    const edited = await probeShelve(itemOf(fx.wt), deps)
    expect(edited.workStamp).not.toBe(before.workStamp)
    expect(sameBinding(before, edited)).toBe(false)
    git(fx.wt, 'add', '-A')
    git(fx.wt, 'commit', '-q', '-m', 'more')
    const committed = await probeShelve(itemOf(fx.wt), deps)
    expect(committed.headSha).not.toBe(before.headSha)
    expect(sameBinding(before, committed)).toBe(false)
  })

  it('an unchanged worktree probes to the same binding twice', async () => {
    const deps = { readManifest: async () => ({ delegates: false }) }
    const a = await probeShelve(itemOf(fx.wt), deps)
    const b = await probeShelve(itemOf(fx.wt), deps)
    expect(sameBinding(a, b)).toBe(true)
  })

  it('a folder that is not a repository gives nothing: no HEAD, no commit time', async () => {
    const plain = path.join(fx.root, 'plain')
    mkdirSync(plain)
    const p = await probeShelve(itemOf(plain), { readManifest: async () => ({ delegates: false }) })
    expect(p.headSha).toBeNull()
    expect(p.lastCommitAt).toBeNull()
  })

  it('a manifest that delegates (or cannot be read) is carried through', async () => {
    const p = await probeShelve(itemOf(fx.wt), { readManifest: async () => ({ delegates: true }) })
    expect(p.manifestDelegates).toBe(true)
  })
})

describe('sameBinding', () => {
  const b = { headSha: 'a'.repeat(40), workStamp: 'w', newestMtime: 5 }
  it('is strict equality of the three facts', () => {
    expect(sameBinding(b, { ...b })).toBe(true)
    expect(sameBinding(b, { ...b, headSha: 'b'.repeat(40) })).toBe(false)
    expect(sameBinding(b, { ...b, workStamp: 'x' })).toBe(false)
    expect(sameBinding(b, { ...b, workStamp: null })).toBe(false)
    expect(sameBinding(b, { ...b, newestMtime: 6 })).toBe(false)
  })
  it('never holds when HEAD is unknown on either side: an unreadable worktree matches nothing', () => {
    const none = { headSha: null, workStamp: null, newestMtime: null }
    expect(sameBinding(none, none)).toBe(false)
    expect(sameBinding(b, none)).toBe(false)
  })
})
