/**
 * The foreign-checkout walk (delta 7) on a real temp tree with real git: a worktree of
 * another repo, or a plain clone, created inside a worktree carries its own `.git`, which
 * `git worktree list` of the worktree's repo never shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createGcOps,
  findForeignCheckouts,
  parseWorktreeList,
  type GcShellDeps
} from '../src/main/gc/gc-shell'
import { runBundle } from '../src/main/gc/pipeline-core'
import { buildBundles, type WorktreeBundle } from '../src/main/gc/bundle-core'

let tmp = ''

/** Real git, isolated from the machine's config: no global/system config, no hooks. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmp,
      GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'harnu',
      GIT_AUTHOR_EMAIL: 'harnu@example.invalid',
      GIT_COMMITTER_NAME: 'harnu',
      GIT_COMMITTER_EMAIL: 'harnu@example.invalid'
    }
  })
}

/** A repo with one commit at `dir`. */
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'x\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** `org/proj/www` and its linked worktree A, whose own root `.git` is a file. */
function worktreeA(): { www: string; a: string } {
  const www = repo(join(tmp, 'org/proj/www'))
  const a = join(tmp, 'org/proj/worktrees/PROJ-0000-slug')
  git(www, 'worktree', 'add', '-q', '-b', 'feat/PROJ-0000-slug', a)
  return { www, a }
}

/** A `.git` file at `dir`, creating the folders on the way. */
function dotGitFile(dir: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), 'gitdir: /nowhere\n')
  return join(dir, '.git')
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'harnu-gc-foreign-')))
  writeFileSync(join(tmp, 'gitconfig'), '')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('findForeignCheckouts (delta 7)', () => {
  it('finds nothing in a linked worktree: its own root `.git` file never counts', async () => {
    const { a } = worktreeA()
    expect(await findForeignCheckouts(a)).toEqual([])
  })

  it('finds a worktree of another repo added inside it', async () => {
    const { a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    git(repo2, 'worktree', 'add', '-q', '-b', 'feat/b', join(a, '.claude/worktrees/b'))
    expect(await findForeignCheckouts(a)).toEqual([join(a, '.claude/worktrees/b/.git')])
  })

  it('finds a plain clone inside it, without descending into that `.git` directory', async () => {
    const { a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    git(a, 'clone', '-q', repo2, join(a, 'libs/api-gateway'))
    expect(await findForeignCheckouts(a)).toEqual([join(a, 'libs/api-gateway/.git')])
  })

  it('returns every one, sorted', async () => {
    const { a } = worktreeA()
    const z = dotGitFile(join(a, 'z'))
    const b = dotGitFile(join(a, 'b'))
    expect(await findForeignCheckouts(a)).toEqual([b, z])
  })

  it.each(['node_modules', 'vendor', '.venv', 'venv'])(
    'a `.git` inside %s/somepkg does not count',
    async (dir) => {
      const { a } = worktreeA()
      dotGitFile(join(a, dir, 'somepkg'))
      expect(await findForeignCheckouts(a)).toEqual([])
    }
  )

  it('does not follow a symlink to a repo elsewhere', async () => {
    const { a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    symlinkSync(repo2, join(a, 'linked'))
    expect(await findForeignCheckouts(a)).toEqual([])
  })

  it('does not record a symlink named `.git`', async () => {
    const { a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    mkdirSync(join(a, 'sub'))
    symlinkSync(join(repo2, '.git'), join(a, 'sub/.git'))
    expect(await findForeignCheckouts(a)).toEqual([])
  })

  it('sees a `.git` at depth 6 and not one at depth 7', async () => {
    const { a } = worktreeA()
    const six = dotGitFile(join(a, '1/2/3/4/5'))
    dotGitFile(join(a, 'x/2/3/4/5/6'))
    expect(await findForeignCheckouts(a)).toEqual([six])
  })

  it('takes a smaller depth bound', async () => {
    const { a } = worktreeA()
    const two = dotGitFile(join(a, '1'))
    dotGitFile(join(a, 'x/2'))
    expect(await findForeignCheckouts(a, { maxDepth: 2 })).toEqual([two])
  })

  it('rejects when the root is gone', async () => {
    await expect(findForeignCheckouts(join(tmp, 'gone'))).rejects.toThrow(/ENOENT/)
  })

  // Root ignores permissions, so the unreadable folder is readable there.
  it.skipIf(process.getuid?.() === 0)('rejects when a folder inside cannot be read', async () => {
    const { a } = worktreeA()
    const locked = join(a, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      await expect(findForeignCheckouts(a)).rejects.toThrow(/EACCES/)
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

// ---- the reprobe and the recheck over real git (delta 7) --------------------------------

const TIP = 'a'.repeat(40)
const EXEC_NOW = 1_700_000_000_000

/** A ready bundle for worktree A, with no stack: only the git and folder checks decide. */
function bundleOf(www: string, a: string): WorktreeBundle {
  return {
    item: {
      id: `${www}::worktree::${a}`,
      repoPath: www,
      kind: 'worktree',
      branch: 'feat/PROJ-0000-slug',
      path: a,
      hidden: false,
      ageDays: 12,
      diskBytes: 1_000_000,
      checkpoints: [],
      verdict: 'harvestable',
      blockers: [],
      needsRemoteDelete: false,
      untracked: [],
      justifiedBy: 'ancestor',
      hydration: null
    },
    fate: { fate: 'merged', signal: 'ancestor', strong: true },
    session: 'none',
    lastSignOfLifeAt: EXEC_NOW - 10 * 86_400_000,
    graceDays: 2,
    localTip: TIP,
    stackIds: [],
    sharedStackIds: [],
    ownedVolumes: [],
    depsBytes: 0,
    keep: false,
    neverClean: false,
    isMainCheckout: false,
    pathsResolved: true,
    nestedWorktrees: [],
    foreignCheckouts: [],
    bucket: 'ready',
    reason: null
  }
}

/**
 * Real paths, the real `git worktree list` and the real walk; everything that would change
 * the disk (trash, archive, deps) is a recording fake, so a refusal is visible as a trash
 * that never happened. `onRemoveDir` runs while the deps are being dropped.
 */
function realDeps(onRemoveDir?: () => void): {
  deps: GcShellDeps
  trash: ReturnType<typeof vi.fn>
} {
  const trash = vi.fn(async () => undefined)
  const deps: GcShellDeps = {
    executor: {
      probeStatus: async () => ({ trackedDirty: false, untracked: [] }),
      hasUnpushed: async () => false,
      trash,
      git: async () => '',
      resolveSha: async () => TIP,
      archiveTip: async (_repo, ref) => ref,
      archiveWip: async (_repo, ref) => ref,
      detachSidebar: async () => undefined,
      appendTombstone: async () => undefined,
      now: () => EXEC_NOW
    },
    dehydrate: {
      isSessionLive: async () => false,
      readManifest: async () => ({ ephemeral: ['node_modules'], setup: [] }),
      probeEntries: async () => [
        { path: 'node_modules', presence: 'dir', contained: true, ignored: true, tracked: false }
      ],
      trackedFingerprint: async () => new Map(),
      removeDir: async () => onRemoveDir?.(),
      recordDehydrated: async () => undefined
    },
    docker: {
      stop: async (ids) => ({ done: ids, error: null }),
      removeContainers: async (ids) => ({ done: ids, error: null }),
      removeVolumes: async (names) => ({ done: names, error: null })
    },
    listStacks: async () => ({ stacks: [] }),
    presenceOf: async () => 'none',
    headOf: async () => TIP,
    isProtectedNow: () => false,
    realpath: async (p) => realpath(p).catch(() => null),
    listWorktrees: async (repoPath) =>
      parseWorktreeList(git(repoPath, 'worktree', 'list', '--porcelain')),
    findForeignCheckouts
  }
  return { deps, trash }
}

describe('the reprobe and the recheck over real git (delta 7)', () => {
  const OPTS = { removeVolumes: true }

  it('the clean baseline: an untouched worktree passes and is trashed', async () => {
    const { www, a } = worktreeA()
    const { deps, trash } = realDeps()
    const r = await runBundle(bundleOf(www, a), createGcOps(deps), OPTS)
    expect(r).toMatchObject({ ok: true, haltedAt: null })
    expect(trash).toHaveBeenCalledWith(a)
  })

  it('(a) a worktree of another repo added inside it after the scan is never trashed', async () => {
    const { www, a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    git(repo2, 'worktree', 'add', '-q', '-b', 'feat/b', join(a, '.claude/worktrees/b'))
    const { deps, trash } = realDeps()
    const ops = createGcOps(deps)
    expect(await ops.reprobe(bundleOf(www, a))).toEqual({ ok: false, reason: 'foreign-checkout' })
    expect(await ops.recheck(bundleOf(www, a))).toEqual({ ok: false, reason: 'foreign-checkout' })
    const r = await runBundle(bundleOf(www, a), ops, OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'foreign-checkout' })
    expect(trash).not.toHaveBeenCalled()
  })

  it('(a) one added while the deps are dropped halts before cleanGit, and nothing is trashed', async () => {
    const { www, a } = worktreeA()
    const repo2 = repo(join(tmp, 'org/other/api-gateway'))
    const { deps, trash } = realDeps(() => {
      git(repo2, 'worktree', 'add', '-q', '-b', 'feat/b', join(a, '.claude/worktrees/b'))
    })
    const r = await runBundle(bundleOf(www, a), createGcOps(deps), OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'archive', error: 'changed-mid-run' })
    expect(trash).not.toHaveBeenCalled()
  })

  it('(b) a plain clone inside it refuses the reprobe', async () => {
    const { www, a } = worktreeA()
    git(a, 'clone', '-q', repo(join(tmp, 'org/other/api-gateway')), join(a, 'libs/api-gateway'))
    const { deps, trash } = realDeps()
    const r = await runBundle(bundleOf(www, a), createGcOps(deps), OPTS)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'foreign-checkout' })
    expect(trash).not.toHaveBeenCalled()
  })

  it.each(['node_modules', 'vendor', '.venv'])(
    '(c) a `.git` inside %s/somepkg does not block it',
    async (dir) => {
      const { www, a } = worktreeA()
      dotGitFile(join(a, dir, 'somepkg'))
      const { deps, trash } = realDeps()
      const r = await runBundle(bundleOf(www, a), createGcOps(deps), OPTS)
      expect(r).toMatchObject({ ok: true, haltedAt: null })
      expect(trash).toHaveBeenCalledWith(a)
    }
  )

  it('(d) a symlink to a repo elsewhere is not followed and does not block it', async () => {
    const { www, a } = worktreeA()
    symlinkSync(repo(join(tmp, 'org/other/api-gateway')), join(a, 'linked'))
    const { deps, trash } = realDeps()
    const r = await runBundle(bundleOf(www, a), createGcOps(deps), OPTS)
    expect(r).toMatchObject({ ok: true, haltedAt: null })
    expect(trash).toHaveBeenCalledWith(a)
  })

  // Root ignores permissions, so the unreadable folder is readable there; the injected
  // failure in tests/gc-shell.test.ts covers that case everywhere.
  it.skipIf(process.getuid?.() === 0)(
    '(e) a folder the walk cannot read refuses as probe-failed',
    async () => {
      const { www, a } = worktreeA()
      const locked = join(a, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o000)
      try {
        const { deps, trash } = realDeps()
        const r = await runBundle(bundleOf(www, a), createGcOps(deps), OPTS)
        expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe' })
        expect(r.error).toMatch(/^probe-failed: .*EACCES/)
        expect(trash).not.toHaveBeenCalled()
      } finally {
        chmodSync(locked, 0o755)
      }
    }
  )
})

describe('the builder over a real clone (delta 7)', () => {
  it('(b) a plain clone inside the worktree at scan time is review nested-worktree', async () => {
    const { www, a } = worktreeA()
    git(a, 'clone', '-q', repo(join(tmp, 'org/other/api-gateway')), join(a, 'libs/api-gateway'))
    const { item } = bundleOf(www, a)
    const [b] = buildBundles({
      items: [
        {
          ...item,
          checkpoints: [
            // Merged long ago, so only the clone can keep it from ready.
            {
              id: 'pr-merged',
              state: 'green',
              detail: new Date(EXEC_NOW - 10 * 86_400_000).toISOString()
            },
            { id: 'local-clean', state: 'green' }
          ]
        }
      ],
      fateInputs: new Map(),
      stacks: [],
      stackPaths: new Map(),
      containers: [],
      sessions: new Map(),
      keep: new Set(),
      neverClean: new Set(),
      now: EXEC_NOW,
      graceDays: 2,
      volumes: new Map(),
      knownFolders: [],
      protectedProjects: new Set(),
      canonical: (p) => ({ path: p, resolved: true }),
      // What the shell scan fills in, per worktree, from the same walk the reprobe runs.
      foreignCheckouts: new Map([[item.id, await findForeignCheckouts(a)]])
    })
    expect(b!.foreignCheckouts).toEqual([join(a, 'libs/api-gateway/.git')])
    expect(b!.bucket).toBe('review')
    expect(b!.reason?.code).toBe('nested-worktree')
  })
})
