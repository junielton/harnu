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
      new RegExp(`reflog-limit.*600.*${REFLOG_REF_LIMIT}`, 's')
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

describe('archiveReflog — a handful of git calls, not one per entry (delta-2, item 3)', () => {
  it('reads the reflog, checks the objects and the reachability in bulk', async () => {
    const { wt, moveTo } = worktree()
    for (let i = 0; i < 80; i++) moveTo(leaf(i))
    moveTo(git(repo, 'rev-parse', 'HEAD'))
    const { io, calls } = counting()
    const prefix = `refs/archive/detached/scale-d-${n}/reflog`
    await createReflogArchiver({ io }).archive(repo, prefix, wt)
    const reads = calls.filter((a) => a[0] !== 'update-ref')
    expect(reads.map((a) => a[0])).toEqual(['reflog', 'cat-file', 'rev-list'])
    expect(calls.filter((a) => a[0] === 'update-ref')).toHaveLength(80)
  })

  it('skips the whole second pass when the same reflog was just archived', async () => {
    const { wt, moveTo } = worktree()
    for (let i = 0; i < 5; i++) moveTo(leaf(i))
    moveTo(git(repo, 'rev-parse', 'HEAD'))
    const { io, calls } = counting()
    const archiver = createReflogArchiver({ io })
    const prefix = `refs/archive/detached/scale-e-${n}/reflog`
    const first = await archiver.archive(repo, prefix, wt)
    calls.length = 0
    const second = await archiver.archive(repo, prefix, wt)
    expect(second).toEqual(first)
    // the reflog is read (that is the fingerprint) and the refs confirmed; nothing is recomputed
    expect(calls.map((a) => a[0]).sort()).toEqual(['for-each-ref', 'reflog'])
  })

  it('does the full pass again when the reflog grew, even to the same HEAD', async () => {
    const { wt, moveTo } = worktree()
    const home = git(wt, 'rev-parse', 'HEAD')
    moveTo(leaf(1))
    moveTo(home)
    const { io, calls } = counting()
    const archiver = createReflogArchiver({ io })
    const prefix = `refs/archive/detached/scale-f-${n}/reflog`
    await archiver.archive(repo, prefix, wt)
    // out to a new commit and back to where HEAD was: same HEAD, a longer history
    const other = leaf(2)
    moveTo(other)
    moveTo(home)
    calls.length = 0
    const again = await archiver.archive(repo, prefix, wt)
    expect(calls.map((a) => a[0])).toContain('rev-list')
    expect(again).toContain(`${prefix}/${other.slice(0, 12)}`)
  })

  it('does the full pass again when an archived ref was deleted in between', async () => {
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
})
