import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { canUnregister, removeWorktreeAdmin } from '../src/main/reaper/worktree-admin-shell'
import { cleanItem, type ExecutorDeps } from '../src/main/reaper/executor-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'
import { promises as fsp } from 'node:fs'

const run = promisify(execFile)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]))
    .stdout

let root: string
let repo: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gc-admin-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'a.txt'), 'a')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-q', '-m', 'init'])
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const adminNames = (): string[] => {
  try {
    return readdirSync(join(repo, '.git', 'worktrees')).sort()
  } catch {
    return [] // git removes the folder with the last registration
  }
}

describe('a GC clean leaves unrelated worktree registrations alone (delta 3b, item 11)', () => {
  it('keeps the registration of an unrelated worktree whose folder is missing', async () => {
    const mine = join(root, 'wt-mine')
    const other = join(root, 'wt-other')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/mine', mine])
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/other', other])
    // An unmounted drive: the folder is gone, the registration is not.
    rmSync(other, { recursive: true, force: true })
    expect(adminNames()).toHaveLength(2)

    const item = {
      id: 'i',
      repoPath: repo,
      kind: 'worktree',
      branch: 'feat/mine',
      path: mine,
      hidden: false,
      ageDays: 1,
      diskBytes: 0,
      checkpoints: [],
      verdict: 'harvestable',
      blockers: [],
      needsRemoteDelete: false,
      untracked: [],
      justifiedBy: 'ancestor',
      hydration: null
    } as ReapItem
    const deps: ExecutorDeps = {
      probeStatus: async () => ({ trackedDirty: false, untracked: [] }),
      hasUnpushed: async () => false,
      trash: async (p) => fsp.rm(p, { recursive: true, force: true }),
      git: (r, args) => git(r, args),
      resolveSha: async (r, rev) =>
        (await git(r, ['rev-parse', '--verify', `${rev}^{commit}`])).trim(),
      archiveTip: async (_r, ref) => ref,
      archiveWip: async (_r, ref) => ref,
      detachSidebar: async () => undefined,
      canUnregister: (r, p) => canUnregister(r, p, git),
      removeWorktreeAdmin: (r, p) => removeWorktreeAdmin(r, p, git),
      appendTombstone: async () => undefined,
      now: () => 1
    }
    const result = await cleanItem(item, { deleteRemote: false }, deps)
    expect(result.ok, JSON.stringify(result.steps)).toBe(true)

    const listed = await git(repo, ['worktree', 'list', '--porcelain'])
    expect(listed).not.toContain(mine)
    expect(listed).toContain(other)
    expect(adminNames()).toEqual(['wt-other'])
    expect(existsSync(mine)).toBe(false)
    expect((await git(repo, ['branch', '--list', 'feat/mine'])).trim()).toBe('')
    expect((await git(repo, ['branch', '--list', 'feat/other'])).trim()).not.toBe('')
  })

  it('leaves a locked worktree registered', async () => {
    const mine = join(root, 'wt-mine')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/mine', mine])
    await git(repo, ['worktree', 'lock', mine])
    rmSync(mine, { recursive: true, force: true })
    await removeWorktreeAdmin(repo, mine, git)
    expect(adminNames()).toEqual(['wt-mine'])
  })

  it('does nothing for a worktree that is not registered', async () => {
    await removeWorktreeAdmin(repo, join(root, 'never-was'), git)
    expect(existsSync(join(repo, '.git', 'worktrees'))).toBe(false)
  })

  it('removes the registration of a worktree whose folder is already gone', async () => {
    const mine = join(root, 'wt-mine')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/mine', mine])
    rmSync(mine, { recursive: true, force: true })
    await removeWorktreeAdmin(repo, mine, git)
    expect(adminNames()).toEqual([])
  })
})

describe('real git: no silent skip, no half-cleaned worktree (delta 4, N4)', () => {
  const item = (mine: string, branch: string): ReapItem =>
    ({
      id: 'i',
      repoPath: repo,
      kind: 'worktree',
      branch,
      path: mine,
      hidden: false,
      ageDays: 1,
      diskBytes: 0,
      checkpoints: [],
      verdict: 'harvestable',
      blockers: [],
      needsRemoteDelete: false,
      untracked: [],
      justifiedBy: 'ancestor',
      hydration: null
    }) as ReapItem
  const execDeps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({
    probeStatus: async () => ({ trackedDirty: false, untracked: [] }),
    hasUnpushed: async () => false,
    trash: async (p) => fsp.rm(p, { recursive: true, force: true }),
    git: (r, args) => git(r, args),
    resolveSha: async (r, rev) =>
      (await git(r, ['rev-parse', '--verify', `${rev}^{commit}`])).trim(),
    archiveTip: async (_r, ref) => ref,
    archiveWip: async (_r, ref) => ref,
    detachSidebar: async () => undefined,
    canUnregister: (r, p) => canUnregister(r, p, git),
    removeWorktreeAdmin: (r, p) => removeWorktreeAdmin(r, p, git),
    appendTombstone: async () => undefined,
    now: () => 1,
    ...over
  })

  it('finds an admin dir whose gitdir is written relative, as git 2.48+ does with useRelativePaths', async () => {
    const mine = join(root, 'wt-mine')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/mine', mine])
    // What `worktree.useRelativePaths=true` writes: the path relative to the admin dir.
    writeFileSync(
      join(repo, '.git', 'worktrees', 'wt-mine', 'gitdir'),
      '../../../../wt-mine/.git\n'
    )
    expect(await canUnregister(repo, mine, git)).toBe(true)
    expect(await removeWorktreeAdmin(repo, mine, git)).toBe(true)
    expect(adminNames()).toEqual([])
  })

  it('says so when there is nothing to unregister, instead of returning as if it had', async () => {
    expect(await canUnregister(repo, join(root, 'never-was'), git)).toBe(false)
    expect(await removeWorktreeAdmin(repo, join(root, 'never-was'), git)).toBe(false)
  })

  it('a locked worktree cannot be unregistered by the admin dir', async () => {
    const mine = join(root, 'wt-mine')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/mine', mine])
    await git(repo, ['worktree', 'lock', mine])
    expect(await canUnregister(repo, mine, git)).toBe(false)
  })

  it('a locked worktree halts the item BEFORE the trash: folder, branch and registration intact', async () => {
    const mine = join(root, 'wt-mine')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/mine', mine])
    await git(repo, ['worktree', 'lock', mine])
    const result = await cleanItem(item(mine, 'feat/mine'), { deleteRemote: false }, execDeps())
    expect(result.ok).toBe(false)
    expect(result.steps.find((s) => !s.ok)!.id).toBe('trash-folder')
    expect(existsSync(mine)).toBe(true)
    expect(adminNames()).toEqual(['wt-mine'])
    expect((await git(repo, ['branch', '--list', 'feat/mine'])).trim()).not.toBe('')
  })

  it('an admin dir that cannot be matched halts BEFORE the trash: folder, registration and branch untouched', async () => {
    const mine = join(root, 'wt-mine')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/mine', mine])
    writeFileSync(join(repo, '.git', 'worktrees', 'wt-mine', 'gitdir'), '/somewhere/else/.git\n')
    const result = await cleanItem(item(mine, 'feat/mine'), { deleteRemote: false }, execDeps())
    expect(result.ok).toBe(false)
    const failed = result.steps.find((s) => !s.ok)!
    expect(failed.id).toBe('trash-folder')
    expect(failed.error).toContain('cannot-unregister')
    expect(existsSync(mine)).toBe(true)
    expect(adminNames()).toEqual(['wt-mine'])
    expect((await git(repo, ['branch', '--list', 'feat/mine'])).trim()).not.toBe('')
  })

  it('a symlinked spelling of the path matches, and the folder goes to the trash with its .env', async () => {
    const real = join(root, 'real')
    mkdirSync(real)
    const mine = join(real, 'wt-mine')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feat/mine', mine])
    writeFileSync(join(mine, '.env'), 'SECRET=1')
    const via = join(root, 'via')
    symlinkSync(real, via)
    const spelled = join(via, 'wt-mine')

    expect(await canUnregister(repo, spelled, git)).toBe(true)

    const trashDir = join(root, 'trash')
    mkdirSync(trashDir)
    const result = await cleanItem(
      item(spelled, 'feat/mine'),
      { deleteRemote: false },
      execDeps({ trash: async (p) => fsp.rename(p, join(trashDir, 'wt-mine')) })
    )
    expect(result.ok, JSON.stringify(result.steps)).toBe(true)
    expect(existsSync(mine)).toBe(false)
    expect(readFileSync(join(trashDir, 'wt-mine', '.env'), 'utf8')).toBe('SECRET=1')
    expect(adminNames()).toEqual([])
  })
})

describe('a clean never deletes anything permanently (delta 5, item 1)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
    )
  it('no source under reaper/ or gc/ ever asks git to remove a worktree', () => {
    const base = join(__dirname, '..', 'src', 'main')
    const offenders = [...walk(join(base, 'reaper')), ...walk(join(base, 'gc'))].filter((f) =>
      /worktree['"\s,]+remove\b/.test(readFileSync(f, 'utf8'))
    )
    expect(offenders).toEqual([])
  })
})
