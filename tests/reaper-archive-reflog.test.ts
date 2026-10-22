// archiveReflog at scale (NDE-A delta-2, items 1 and 3). A removal must never drop a commit that only
// the worktree's HEAD reflog reaches: not behind a cap applied before the reachable entries are
// filtered out, and not by running out of patience on a long history. And it must not spend a git call
// per entry, nor repeat the whole pass twice per removal.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  REFLOG_REF_LIMIT,
  archiveReflog,
  createReflogArchiver,
  defaultReflogIo,
  type ReflogIo
} from '../src/main/reaper/archive-shell'

vi.setConfig({ testTimeout: 180_000 })

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

let root: string
let repo: string
let tree: string

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-reflog-scale-'))
  repo = path.join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(path.join(repo, 'f.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'A')
  tree = git(repo, 'rev-parse', 'HEAD^{tree}')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
/** A fresh detached worktree at A, and a way to move its HEAD (and so its reflog) onto a commit. */
function worktree(): { wt: string; moveTo(sha: string): void } {
  const wt = path.join(root, `wt-${++n}`)
  git(repo, 'worktree', 'add', '-q', '--detach', wt)
  return { wt, moveTo: (sha) => void git(wt, 'update-ref', '-m', 'move', 'HEAD', sha) }
}

/** A commit that no ref reaches, made without touching any worktree. */
const leaf = (i: number, parent = 'HEAD'): string =>
  git(repo, 'commit-tree', tree, '-p', parent, '-m', `leaf ${i} ${n}`)

const refsUnder = (prefix: string): string[] =>
  git(repo, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean)

const counting = (): { io: ReflogIo; calls: string[][] } => {
  const calls: string[][] = []
  return {
    calls,
    io: {
      run: (cwd, args) => (calls.push(args), defaultReflogIo.run(cwd, args)),
      runIn: (cwd, args, input) => (calls.push(args), defaultReflogIo.runIn(cwd, args, input))
    }
  }
}

describe('archiveReflog — nothing is dropped silently (delta-2, item 1)', () => {
  it('keeps every reflog-only commit even when more than the cap of reachable entries came after', async () => {
    const { wt, moveTo } = worktree()
    // 150 commits only the reflog reaches, oldest ...
    const lost = Array.from({ length: 150 }, (_, i) => leaf(i))
    for (const sha of lost) moveTo(sha)
    // ... then 450 steps along a chain a branch reaches: 600 entries, newest 450 reachable
    let parent = git(repo, 'rev-parse', 'HEAD')
    const chain: string[] = []
    for (let i = 0; i < 450; i++) {
      parent = leaf(1000 + i, parent)
      chain.push(parent)
    }
    git(repo, 'branch', `keep-${n}`, chain[chain.length - 1]!)
    for (const sha of chain) moveTo(sha)

    const prefix = `refs/archive/detached/scale-a-${n}/reflog`
    const written = await createReflogArchiver().archive(repo, prefix, wt)
    expect(written).toHaveLength(150)
    for (const sha of lost) git(repo, 'cat-file', '-e', `${prefix}/${sha.slice(0, 12)}`)
  })

  it('refuses with a clear reason, writing nothing, when more commits than the cap need archiving', async () => {
    const { wt, moveTo } = worktree()
    for (let i = 0; i < 600; i++) moveTo(leaf(i))
    // HEAD ends back at A: the commit it sits on is the tip ref's business, not the reflog's
    moveTo(git(repo, 'rev-parse', 'HEAD'))

    const prefix = `refs/archive/detached/scale-b-${n}/reflog`
    await expect(createReflogArchiver().archive(repo, prefix, wt)).rejects.toThrow(
      new RegExp(`reflog-limit.*600 separate lines.*more than the ${REFLOG_REF_LIMIT} tips`, 's')
    )
    expect(refsUnder(prefix)).toEqual([])
  })

  it('archives only the tips of a chain: its ancestors are reached once the tip is kept', async () => {
    const { wt, moveTo } = worktree()
    let parent = git(repo, 'rev-parse', 'HEAD')
    for (let i = 0; i < 40; i++) {
      parent = leaf(i, parent)
      moveTo(parent)
    }
    moveTo(git(repo, 'rev-parse', 'HEAD'))
    const prefix = `refs/archive/detached/scale-c-${n}/reflog`
    const written = await createReflogArchiver().archive(repo, prefix, wt)
    expect(written).toEqual([`${prefix}/${parent.slice(0, 12)}`])
  })
})

describe('archiveReflog — a handful of git calls, not one per entry (delta-2, item 3; delta-3)', () => {
  it('reads the reflog, checks the objects and the reachability in bulk, and writes the refs in ONE call', async () => {
    const { wt, moveTo } = worktree()
    for (let i = 0; i < 80; i++) moveTo(leaf(i))
    moveTo(git(repo, 'rev-parse', 'HEAD'))
    const { io, calls } = counting()
    const prefix = `refs/archive/detached/scale-d-${n}/reflog`
    const written = await createReflogArchiver({ io }).archive(repo, prefix, wt)
    expect(written).toHaveLength(80)
    expect(calls.map((a) => a[0])).toEqual(['reflog', 'cat-file', 'rev-list', 'update-ref'])
    expect(calls.at(-1)).toEqual(['update-ref', '--stdin'])
    expect(refsUnder(prefix)).toHaveLength(80)
  })

  it('a second pass is idempotent but never cached: it asks reachability again', async () => {
    const { wt, moveTo } = worktree()
    for (let i = 0; i < 5; i++) moveTo(leaf(i))
    moveTo(git(repo, 'rev-parse', 'HEAD'))
    const { io, calls } = counting()
    const archiver = createReflogArchiver({ io })
    const prefix = `refs/archive/detached/scale-e-${n}/reflog`
    expect(await archiver.archive(repo, prefix, wt)).toHaveLength(5)
    calls.length = 0
    // our own refs now reach every commit, so there is nothing new to write ...
    expect(await archiver.archive(repo, prefix, wt)).toEqual([])
    // ... but that was ANSWERED by git, not remembered
    expect(calls.map((a) => a[0])).toEqual(['reflog', 'cat-file', 'rev-list'])
  })

  it('a commit that WAS reachable and no longer is gets its ref on the next pass (the tag-deleted repro)', async () => {
    const { wt, moveTo } = worktree()
    const home = git(repo, 'rev-parse', 'HEAD')
    const c = leaf(7)
    git(repo, 'tag', `keep-${n}`, c)
    moveTo(c)
    moveTo(home)
    const archiver = createReflogArchiver()
    const prefix = `refs/archive/detached/scale-h-${n}/reflog`
    // pass 1: the tag holds C, so there is nothing to write
    expect(await archiver.archive(repo, prefix, wt)).toEqual([])
    git(repo, 'tag', '-d', `keep-${n}`)
    // pass 2, same instance, same reflog bytes: C is now held by nothing but the reflog
    expect(await archiver.archive(repo, prefix, wt)).toEqual([`${prefix}/${c.slice(0, 12)}`])
    git(repo, 'reflog', 'expire', '--expire=now', '--all')
    git(repo, 'gc', '--prune=now', '-q')
    git(repo, 'cat-file', '-e', `${c}^{commit}`)
  })

  it('does the full pass when the reflog grew, even to the same HEAD', async () => {
    const { wt, moveTo } = worktree()
    const home = git(wt, 'rev-parse', 'HEAD')
    moveTo(leaf(1))
    moveTo(home)
    const archiver = createReflogArchiver()
    const prefix = `refs/archive/detached/scale-f-${n}/reflog`
    await archiver.archive(repo, prefix, wt)
    const other = leaf(2)
    moveTo(other)
    moveTo(home)
    expect(await archiver.archive(repo, prefix, wt)).toContain(`${prefix}/${other.slice(0, 12)}`)
  })

  it('writes the ref back when an archived ref was deleted in between', async () => {
    const { wt, moveTo } = worktree()
    moveTo(leaf(1))
    moveTo(git(repo, 'rev-parse', 'HEAD'))
    const archiver = createReflogArchiver()
    const prefix = `refs/archive/detached/scale-g-${n}/reflog`
    const [ref] = await archiver.archive(repo, prefix, wt)
    git(repo, 'update-ref', '-d', ref!)
    expect(await archiver.archive(repo, prefix, wt)).toEqual([ref])
    git(repo, 'cat-file', '-e', ref!)
  })

  it('the shared archiver keeps nothing between runs either', async () => {
    const { wt, moveTo } = worktree()
    const home = git(repo, 'rev-parse', 'HEAD')
    const c = leaf(9)
    git(repo, 'tag', `keep2-${n}`, c)
    moveTo(c)
    moveTo(home)
    const prefix = `refs/archive/detached/scale-i-${n}/reflog`
    expect(await archiveReflog(repo, prefix, wt)).toEqual([])
    git(repo, 'tag', '-d', `keep2-${n}`)
    expect(await archiveReflog(repo, prefix, wt)).toEqual([`${prefix}/${c.slice(0, 12)}`])
  })
})

describe('archiveReflog — the limit counts tips, and says so (delta-3)', () => {
  it('refuses with the number of tips, writing nothing', async () => {
    const { wt, moveTo } = worktree()
    for (let i = 0; i < 6; i++) moveTo(leaf(i))
    moveTo(git(repo, 'rev-parse', 'HEAD'))
    const prefix = `refs/archive/detached/scale-j-${n}/reflog`
    await expect(createReflogArchiver({ limit: 5 }).archive(repo, prefix, wt)).rejects.toThrow(
      /reflog-limit: .*6 separate lines of commits.*more than the 5 tips/s
    )
    expect(refsUnder(prefix)).toEqual([])
  })
})
