// shelveWorktree against real git (U2.2 AC-3): the folder really goes, the branch and every archive
// ref stay, the same path can be a worktree again, and only THIS worktree's registration is touched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { restoreWorktree } from '../src/main/gc/shelve-shell'
import { probeShelve } from '../src/main/gc/shelve-probe-shell'
import {
  defaultShelveExecDeps,
  shelveWorktree,
  type ShelveDecision,
  type ShelveExecDeps
} from '../src/main/gc/shelve-exec-shell'
import { readShelved } from '../src/main/gc/shelve-store'
import {
  ENV_BODY,
  archiveRefs,
  digestTree,
  git,
  makeFixture,
  refNames,
  type Fixture
} from './gc-shelve-fixture'

let fx: Fixture
let storeFile: string
beforeEach(() => {
  fx = makeFixture()
  storeFile = path.join(fx.root, 'gc-shelved.json')
})
afterEach(() => fx.cleanup())

const deps = (over: Partial<ShelveExecDeps> = {}): ShelveExecDeps =>
  defaultShelveExecDeps(storeFile, {
    // electron-bound in the app; a throwaway repo has no sessions
    inUse: async () => false,
    ...over
  })

async function decide(wt = fx.wt, branch: string | null = 'feat/x'): Promise<ShelveDecision> {
  const probe = await probeShelve({ item: { repoPath: fx.repo, path: wt } })
  return {
    id: `${fx.repo}::worktree::${wt}`,
    repoPath: fx.repo,
    worktreePath: wt,
    branch,
    binding: { headSha: probe.headSha, workStamp: probe.workStamp, newestMtime: probe.newestMtime },
    since: 0,
    idleDays: 9,
    diskBytes: null
  }
}

const listed = (): string => git(fx.repo, 'worktree', 'list', '--porcelain')

describe('shelveWorktree against real git (AC-3)', () => {
  it('frees the folder for real and keeps the branch and every archive ref', async () => {
    const branchTip = git(fx.repo, 'rev-parse', 'feat/x')
    const out = await shelveWorktree(await decide(), deps())
    expect(out.ok).toBe(true)
    if (!out.ok) return

    expect(existsSync(fx.wt)).toBe(false)
    expect(listed()).not.toContain(fx.wt)
    expect(git(fx.repo, 'rev-parse', 'feat/x')).toBe(branchTip)
    expect(git(fx.repo, 'branch', '--list', 'feat/x')).toContain('feat/x')
    const refs = archiveRefs(fx.repo)
    for (const r of [
      out.record.tipRef,
      out.record.wipRef,
      `${out.record.namespace}/shelve/record`
    ]) {
      expect(refs).toContain(r)
    }
    expect((await readShelved(storeFile)).entries.map((e) => e.worktreePath)).toEqual([fx.wt])
  })

  it('leaves the same path free to be a worktree again', async () => {
    const out = await shelveWorktree(await decide(), deps())
    expect(out.ok).toBe(true)
    git(fx.repo, 'worktree', 'add', '-q', fx.wt, 'feat/x')
    expect(existsSync(path.join(fx.wt, 'tracked.txt'))).toBe(true)
  })

  it('what it shelved comes back byte-for-byte', async () => {
    const before = digestTree(fx.wt, ['node_modules'])
    const out = await shelveWorktree(await decide(), deps())
    if (!out.ok) throw new Error(out.message)
    const back = await restoreWorktree(out.record)
    expect(back.ok).toBe(true)
    expect(digestTree(fx.wt, ['node_modules'])).toEqual(before)
    expect(readFileSync(path.join(fx.wt, '.env'), 'utf8')).toBe(ENV_BODY)
  })

  it('touches only its own registration: another worktree whose folder is missing keeps its entry', async () => {
    const other = path.join(fx.root, 'trees', 'other')
    git(fx.repo, 'worktree', 'add', '-q', '-b', 'feat/other', other)
    rmSync(other, { recursive: true, force: true })
    expect(listed()).toContain(other)

    const out = await shelveWorktree(await decide(), deps())
    expect(out.ok).toBe(true)
    expect(listed()).toContain(other)
    expect(listed()).not.toContain(fx.wt)
  })

  it('a locked worktree is refused before anything is preserved or deleted', async () => {
    git(fx.repo, 'worktree', 'lock', '--reason', 'mine', fx.wt)
    const refsBefore = refNames(fx.repo)
    const out = await shelveWorktree(await decide(), deps())
    expect(out).toMatchObject({ ok: false, step: 'unregister', folderRemoved: false })
    expect(existsSync(path.join(fx.wt, 'tracked.txt'))).toBe(true)
    expect(refNames(fx.repo)).toEqual(refsBefore)
    expect((await readShelved(storeFile)).entries).toEqual([])
  })

  it('a file edited after the decision refuses it, folder and refs untouched', async () => {
    const d = await decide()
    rmSync(path.join(fx.wt, 'notes', 'u.txt'))
    mkdirSync(path.join(fx.wt, 'notes'), { recursive: true })
    const refsBefore = refNames(fx.repo)
    const out = await shelveWorktree(d, deps())
    expect(out).toMatchObject({ ok: false, step: 'reprobe', reason: 'changed-since-decided' })
    expect(existsSync(path.join(fx.wt, 'tracked.txt'))).toBe(true)
    expect(refNames(fx.repo)).toEqual(refsBefore)
  })

  it('a detached worktree is shelved by its HEAD and its archive restores it', async () => {
    const det = path.join(fx.root, 'trees', 'detached')
    git(fx.repo, 'worktree', 'add', '-q', '--detach', det)
    const out = await shelveWorktree(await decide(det, null), deps())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(existsSync(det)).toBe(false)
    expect(out.record.branch).toBeNull()
    expect((await restoreWorktree(out.record)).ok).toBe(true)
  })

  it('the executor never pushes, fetches, collects garbage or touches the stash', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'gc', 'shelve-exec-shell.ts'),
      'utf8'
    )
    for (const forbidden of [
      "'push'",
      "'fetch'",
      "'gc'",
      "'prune'",
      "'stash'",
      'detachFromSidebar',
      'recordRemovedFolder',
      'removeGhostFoldersUnder'
    ]) {
      expect(src).not.toContain(forbidden)
    }
  })
})
