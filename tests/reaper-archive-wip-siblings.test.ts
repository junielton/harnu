// AC-E2 delta 1, item 1: an earlier working state is kept under a sibling ref, and a sibling is NEVER
// overwritten. Three writes of different working states within the same second used to land on the
// same `wip-<stamp>` name, so the first working state lost its only ref.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { archiveWip } from '../src/main/reaper/archive-shell'
import { groupArchiveRefs } from '../src/main/gc/archives-core'
import { listArchiveRefs } from '../src/main/gc/archives-shell'
import { execGit } from '../src/main/gc/archives-shell'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

let root: string
let repo: string
let wt: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-wip-sib-'))
  repo = path.join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(path.join(repo, 'f.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'A')
  wt = path.join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '--detach', wt)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const REF = 'refs/archive/detached/20261012T100000Z/wt-aaaaaaaaaaaa/wip'

describe('sibling wip refs are never overwritten', () => {
  it('three different working states in the same second all stay reachable', async () => {
    const wips: string[] = []
    for (const n of ['one', 'two', 'three']) {
      writeFileSync(path.join(wt, 'work.txt'), `${n}\n`)
      wips.push(await archiveWip(repo, REF, wt))
    }
    const reachable = new Set(
      git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/archive').split('\n')
    )
    for (const sha of wips) expect(reachable.has(sha), sha).toBe(true)
    // The newest is the plain ref, the two earlier ones are distinct siblings.
    expect(git(repo, 'rev-parse', REF)).toBe(wips[2])
    const siblings = git(repo, 'for-each-ref', '--format=%(refname)', `${REF}-*`).split('\n')
    expect(siblings).toHaveLength(2)
    expect(new Set(siblings).size).toBe(2)
  })

  it('the siblings are listed as members of the same archive', async () => {
    for (const n of ['one', 'two', 'three']) {
      writeFileSync(path.join(wt, 'work.txt'), `${n}\n`)
      await archiveWip(repo, REF, wt)
    }
    git(
      repo,
      'update-ref',
      'refs/archive/detached/20261012T100000Z/wt-aaaaaaaaaaaa/tip',
      git(repo, 'rev-parse', 'HEAD')
    )
    const entries = groupArchiveRefs(repo, await listArchiveRefs(execGit, repo))
    // Not a Harnu group (the folder segment's hex is not the tip's): see item 2. Every ref is listed.
    expect(entries.flatMap((e) => e.refs)).toHaveLength(4)
  })

  it('never moves an existing ref: a name that is taken is skipped, not overwritten', async () => {
    writeFileSync(path.join(wt, 'work.txt'), 'one\n')
    const first = await archiveWip(repo, REF, wt)
    writeFileSync(path.join(wt, 'work.txt'), 'two\n')
    await archiveWip(repo, REF, wt)
    const takenName = git(repo, 'for-each-ref', '--format=%(refname)', `${REF}-*`)
    expect(git(repo, 'rev-parse', takenName)).toBe(first)
    writeFileSync(path.join(wt, 'work.txt'), 'three\n')
    await archiveWip(repo, REF, wt)
    // The first sibling still points at the first working state.
    expect(git(repo, 'rev-parse', takenName)).toBe(first)
  })
})
