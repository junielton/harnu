import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { removeWorktreeAdmin } from '../src/main/reaper/worktree-admin-shell'
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

const adminNames = (): string[] => readdirSync(join(repo, '.git', 'worktrees')).sort()

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
