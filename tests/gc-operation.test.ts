// A rebase or a bisect in progress lives in a detached HEAD's git dir (the todo list, the bisect log),
// and goes with the folder when it is removed: the commits are archived, the unfinished operation is
// not. So a worktree mid-operation is not removable until it is finished or aborted — a guided
// refusal that says which command does that (NDE-A delta-1, item 6).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AS_GIVEN, buildBundles, type BuildBundlesInput } from '../src/main/gc/bundle-core'
import { gitOperationOf } from '../src/main/gc/gc-operation'
import { createGcOps } from '../src/main/gc/gc-shell'
import { bundleRemovability } from '../src/renderer/src/lib/gc-removability'
import { collect, scanInput } from './gc-scan-fixtures'
import { bundle, NOW, reapItem } from './gc-fixtures'
import { worldFor, WT } from './helpers/gc-world'

describe('gitOperationOf — a real repository', () => {
  let root: string
  let repo: string
  let wt: string
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_SEQUENCE_EDITOR: 'sed -i s/^pick/edit/' }
    })

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-op-'))
    repo = path.join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'user.name', 't')
    for (const n of ['1', '2', '3']) {
      writeFileSync(path.join(repo, `f${n}.txt`), n)
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', `c${n}`)
    }
    wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', '--detach', wt)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('is null for a plain detached worktree', async () => {
    expect(await gitOperationOf(wt)).toBeNull()
  })

  it('reads a bisect in progress', async () => {
    git(wt, 'bisect', 'start')
    git(wt, 'bisect', 'bad', 'HEAD')
    git(wt, 'bisect', 'good', 'HEAD~2')
    expect(await gitOperationOf(wt)).toBe('bisect')
  })

  it('reads a rebase that stopped', async () => {
    git(wt, 'rebase', '-q', '-i', 'HEAD~2')
    expect(await gitOperationOf(wt)).toBe('rebase')
  })

  it('is null again once the operation is finished or aborted', async () => {
    git(wt, 'rebase', '-q', '-i', 'HEAD~2')
    git(wt, 'rebase', '--abort')
    expect(await gitOperationOf(wt)).toBeNull()
  })

  it('is null for a folder git cannot read: the scan does not guess', async () => {
    expect(await gitOperationOf(path.join(root, 'nowhere'))).toBeNull()
  })
})

const build = (operations?: ReadonlyMap<string, 'rebase' | 'bisect'>) => {
  const { items, fateInputs } = collect(scanInput())
  const input: BuildBundlesInput = {
    items,
    fateInputs,
    stacks: [],
    stackPaths: new Map(),
    containers: [],
    sessions: new Map(),
    keep: new Set(),
    neverClean: new Set(),
    now: NOW,
    graceDays: 2,
    volumes: new Map(),
    knownFolders: [],
    protectedProjects: new Set(),
    canonical: AS_GIVEN,
    foreignCheckouts: new Map(items.map((i) => [i.id, []])),
    ...(operations ? { operations } : {})
  }
  return { items, bundles: buildBundles(input) }
}

describe('a worktree mid-operation shows in review at scan time', () => {
  it('is review with its own reason, never ready', () => {
    const id = build().items[0]!.id
    const b = build(new Map([[id, 'rebase' as const]])).bundles[0]!
    expect(b.bucket).toBe('review')
    expect(b.operation).toBe('rebase')
    expect(b.reason?.code).toBe('operation-in-progress')
    expect(b.reason?.detail).toMatch(/rebase/)
  })

  it('leaves the other worktrees alone', () => {
    expect(build(new Map([['other', 'bisect' as const]])).bundles[0]!.bucket).toBe('ready')
  })
})

describe('the reprobe refuses it, before anything is touched', () => {
  const mid = (op: 'rebase' | 'bisect') => ({
    ...bundle(WT, 'review', { reason: { code: 'operation-in-progress' as never, detail: 'x' } }),
    item: reapItem(WT, { kind: 'detached-worktree', branch: undefined, headSha: 'a'.repeat(40) }),
    operation: op
  })

  it('on the fact the scan recorded', async () => {
    const b = mid('rebase')
    const ops = createGcOps(worldFor(b))
    expect(await ops.reprobe(b)).toEqual({ ok: false, reason: 'operation-in-progress' })
  })

  it('on a fresh look, when the operation started after the scan', async () => {
    const b = { ...mid('rebase'), operation: undefined }
    const world = worldFor(b)
    world.operationOf = async () => 'bisect'
    expect(await createGcOps(world).reprobe(b)).toEqual({
      ok: false,
      reason: 'operation-in-progress'
    })
  })
})

describe('the Remove predicate says so, with the command that ends the operation', () => {
  const mid = (op: 'rebase' | 'bisect') => ({
    ...bundle(WT, 'review', { reason: { code: 'operation-in-progress' as never, detail: 'x' } }),
    item: reapItem(WT, { kind: 'detached-worktree', branch: undefined, headSha: 'a'.repeat(40) }),
    operation: op
  })

  it('a rebase', () => {
    expect(bundleRemovability(mid('rebase'), NOW)).toEqual({
      ok: false,
      reason: 'operation-in-progress',
      hint: `git -C ${WT} rebase --abort`
    })
  })

  it('a bisect', () => {
    expect(bundleRemovability(mid('bisect'), NOW)).toEqual({
      ok: false,
      reason: 'operation-in-progress',
      hint: `git -C ${WT} bisect reset`
    })
  })
})
