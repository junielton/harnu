import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

/**
 * BUG-40 §3.3's rollback test exercises the REAL `createWorktree` shell (a real
 * `git init` repo in a tmpdir, real `git worktree add`) rather than mocking git —
 * the whole point is proving no orphan is left on disk. Only `addUserProject` (the
 * root-cause doc's confirmed real throw point in the adopt stage) is faked, so a
 * single test can force the failure deterministically without touching git at all.
 */
const h = vi.hoisted(() => ({ userDataDir: '', failAdopt: false }))

vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

vi.mock('../src/main/user-projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/user-projects')>()
  return {
    ...actual,
    addUserProject: async (...args: Parameters<typeof actual.addUserProject>) => {
      if (h.failAdopt) throw new Error('simulated addUserProject failure (BUG-40 AC3)')
      return actual.addUserProject(...args)
    }
  }
})

import {
  planAdopt,
  worktreeRemovalBlock,
  classifyWorktreePlan,
  type WorktreePlanPreview
} from '../src/main/worktree-core'
import { createWorktree } from '../src/main/worktree-ipc'
import { addUserProject, readUserProjects } from '../src/main/user-projects'

describe('planAdopt', () => {
  it('returns "add" when the candidate is not among the existing worktrees', () => {
    expect(
      planAdopt(
        ['/home/u/repo', '/home/u/repo/.claude/worktrees/other'],
        '/home/u/repo/.claude/worktrees/feat'
      )
    ).toBe('add')
  })

  it('returns "noop" when the candidate is already present', () => {
    const existing = ['/home/u/repo', '/home/u/repo/.claude/worktrees/feat']
    expect(planAdopt(existing, '/home/u/repo/.claude/worktrees/feat')).toBe('noop')
  })

  it('normalizes trailing slashes and redundant segments before comparing', () => {
    const existing = ['/home/u/repo/.claude/worktrees/feat']
    expect(planAdopt(existing, '/home/u/repo/.claude/worktrees/feat/')).toBe('noop')
    expect(planAdopt(existing, '/home/u/repo/.claude/./worktrees/feat')).toBe('noop')
    expect(planAdopt(existing, '/home/u/repo/.claude/worktrees/sub/../feat')).toBe('noop')
  })

  it('returns "add" against an empty existing set', () => {
    expect(planAdopt([], '/home/u/repo/.claude/worktrees/feat')).toBe('add')
  })
})

describe('worktreeRemovalBlock (T32/AC18 remove guard)', () => {
  it('allows a clean, pushed worktree', () => {
    expect(worktreeRemovalBlock({ dirty: false, unpushed: false, force: false })).toBeNull()
  })

  it('blocks uncommitted changes (most urgent, reported first)', () => {
    expect(worktreeRemovalBlock({ dirty: true, unpushed: false, force: false })).toBe('uncommitted')
    // uncommitted wins over unpushed when both are present
    expect(worktreeRemovalBlock({ dirty: true, unpushed: true, force: false })).toBe('uncommitted')
  })

  it('blocks unpushed commits when the tree is clean', () => {
    expect(worktreeRemovalBlock({ dirty: false, unpushed: true, force: false })).toBe('unpushed')
  })

  it('force overrides every block', () => {
    expect(worktreeRemovalBlock({ dirty: true, unpushed: true, force: true })).toBeNull()
    expect(worktreeRemovalBlock({ dirty: false, unpushed: true, force: true })).toBeNull()
  })
})

describe('classifyWorktreePlan (T32/AC6 pre-check precedence)', () => {
  const preview: WorktreePlanPreview = {
    targetPath: '/home/u/repo/.worktrees/feat-x',
    branch: 'feature/x',
    baseRef: 'main',
    mode: 'new-branch',
    source: 'worktree-md',
    seed: { copy: ['.env'], link: ['node_modules'] },
    commands: ['npm ci'],
    warnings: []
  }
  const clean = { targetExists: false, checkedOutWorktree: null, hasCommits: true }

  it('returns the preview unchanged when every pre-check passes', () => {
    expect(classifyWorktreePlan(preview, clean)).toBe(preview)
  })

  it('reports target-exists (highest precedence)', () => {
    expect(classifyWorktreePlan(preview, { ...clean, targetExists: true })).toEqual({
      error: 'target-exists',
      path: preview.targetPath
    })
  })

  it('reports branch-checked-out with the owning worktree', () => {
    expect(
      classifyWorktreePlan(preview, { ...clean, checkedOutWorktree: '/home/u/repo/wt-old' })
    ).toEqual({ error: 'branch-checked-out', worktree: '/home/u/repo/wt-old' })
  })

  it('reports no-commits when the repo has no HEAD', () => {
    expect(classifyWorktreePlan(preview, { ...clean, hasCommits: false })).toEqual({
      error: 'no-commits'
    })
  })

  it('applies precedence: target-exists beats branch-checked-out beats no-commits', () => {
    const all = { targetExists: true, checkedOutWorktree: '/wt', hasCommits: false }
    expect(classifyWorktreePlan(preview, all)).toEqual({
      error: 'target-exists',
      path: preview.targetPath
    })
    expect(classifyWorktreePlan(preview, { ...all, targetExists: false })).toEqual({
      error: 'branch-checked-out',
      worktree: '/wt'
    })
  })
})

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return runFile('git', ['-C', cwd, ...args])
}

/** A minimal real git repo (one commit, no remote) — no manifest, so createWorktree's seed/setup are both no-ops. */
async function initRepo(): Promise<string> {
  const repo = await tmpDir('harnu-worktree-adopt-')
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(repo, 'README.md'), '# test\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-q', '-m', 'initial'])
  return repo
}

describe('createWorktree — adopt-stage rollback (BUG-40 §3.3)', () => {
  beforeEach(() => {
    h.failAdopt = false
  })

  it('a failed adopt rolls the worktree back — no orphan is left on disk', async () => {
    const repo = await initRepo()
    h.userDataDir = await tmpDir('harnu-worktree-adopt-userdata-')
    h.failAdopt = true

    const branch = 'card/BUG-40-rollback-test'
    await expect(createWorktree(repo, branch)).rejects.toThrow(/simulated addUserProject failure/)

    const target = path.join(repo, '.claude', 'worktrees', 'card-BUG-40-rollback-test')
    await expect(fs.access(target)).rejects.toThrow()

    const { stdout: worktreeList } = await git(repo, ['worktree', 'list', '--porcelain'])
    expect(worktreeList).not.toContain(target)

    // BUG-40 root cause: deriveWorktreePath is slug-deterministic, so an orphaned
    // branch here would poison every retry with `fatal: '<branch>' is already
    // used by worktree at '<path>'`. The branch we created must be gone too.
    const { stdout: branchList } = await git(repo, ['branch', '--list', branch])
    expect(branchList.trim()).toBe('')

    // The retry that motivated this bug: the SAME create must now succeed cleanly.
    h.failAdopt = false
    const retry = await createWorktree(repo, branch)
    await expect(fs.access(retry.path)).resolves.toBeUndefined()
  }, 20000)

  it('a successful adopt is unaffected — no rollback, the worktree lands on disk', async () => {
    const repo = await initRepo()
    h.userDataDir = await tmpDir('harnu-worktree-adopt-userdata-ok-')
    h.failAdopt = false

    const result = await createWorktree(repo, 'card/BUG-40-success-test')
    await expect(fs.access(result.path)).resolves.toBeUndefined()

    const { stdout: worktreeList } = await git(repo, ['worktree', 'list', '--porcelain'])
    expect(worktreeList).toContain(result.path)
  }, 20000)
})

describe('createWorktree — T191 origin/bornFrom threading', () => {
  beforeEach(() => {
    h.failAdopt = false
  })

  it('records bornFrom on the MCP/drain path — origin is a known non-main worktree of the same repo', async () => {
    const repo = await initRepo()
    h.userDataDir = await tmpDir('harnu-worktree-bornfrom-')

    const mother = await createWorktree(repo, 'card/mother')
    const child = await createWorktree(repo, 'card/child', undefined, undefined, undefined, {
      origin: mother.path
    })

    expect(child.bornFrom).toBe(mother.path)
    const file = await readUserProjects()
    expect(file.projects.find((p) => p.path === child.path)?.bornFrom).toBe(mother.path)
  }, 20000)

  it('records NOTHING on the human New-worktree dialog path (no origin passed)', async () => {
    const repo = await initRepo()
    h.userDataDir = await tmpDir('harnu-worktree-bornfrom-none-')

    const result = await createWorktree(repo, 'card/solo')

    expect(result.bornFrom).toBeUndefined()
    const file = await readUserProjects()
    expect(file.projects.find((p) => p.path === result.path)?.bornFrom).toBeUndefined()
  }, 20000)

  it("drops the edge when the origin is the repo's main checkout", async () => {
    const repo = await initRepo()
    h.userDataDir = await tmpDir('harnu-worktree-bornfrom-main-')

    // Learn the repo's real repoId, then register the main checkout itself as
    // a known folder — mirrors what happens once the repo is opened in Harnu.
    const probe = await createWorktree(repo, 'card/probe')
    const repoId = probe.adopted.repoId!
    await addUserProject({
      path: repo,
      alias: 'main',
      addedAt: new Date().toISOString(),
      worktrees: [],
      isMainWorktree: true,
      repoId
    })

    const child = await createWorktree(repo, 'card/child2', undefined, undefined, undefined, {
      origin: repo
    })
    expect(child.bornFrom).toBeUndefined()
  }, 20000)

  it('drops the edge when the origin is a foreign/unknown path', async () => {
    const repo = await initRepo()
    h.userDataDir = await tmpDir('harnu-worktree-bornfrom-unknown-')

    const child = await createWorktree(repo, 'card/child3', undefined, undefined, undefined, {
      origin: '/never/pinned/anywhere'
    })
    expect(child.bornFrom).toBeUndefined()
  }, 20000)
})
