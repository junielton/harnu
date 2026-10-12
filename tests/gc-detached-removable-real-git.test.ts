// NDE-A against a real repository: a detached worktree holding a commit that is on no branch plus
// an uncommitted file is removed from review, and what it held survives as archive refs keyed by
// its HEAD sha. The unit tests prove the order of the steps with fakes; this one proves the claims
// that are about git itself: the refs resolve, the objects are real, the folder is gone and the
// registration with it, and a failed archive leaves the folder exactly where it was.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createForcedGcOps } from '../src/main/gc/gc-forced-ops'
import { refusalFor } from '../src/main/gc/autopilot-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcShellDeps } from '../src/main/gc/gc-shell'
import { runBundle } from '../src/main/gc/pipeline-core'
import { archiveTip, archiveWip } from '../src/main/reaper/archive-shell'
import type { ExecutorDeps } from '../src/main/reaper/executor-core'
import { canUnregister, removeWorktreeAdmin } from '../src/main/reaper/worktree-admin-shell'
import { bundleRemovability } from '../src/renderer/src/lib/gc-removability'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const gitRun = async (repo: string, args: string[]): Promise<string> => git(repo, ...args)

let root: string
let repo: string
let wt: string
let head: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-nde-a-'))
  repo = path.join(root, 'org', 'proj', 'www')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']
  git(repo, ...id, 'commit', '-q', '--allow-empty', '-m', 'init')

  // A detached worktree with a commit that is on NO branch, a tracked edit, and an untracked file.
  wt = path.join(root, 'trees', 'bisect-1')
  git(repo, 'worktree', 'add', '-q', '--detach', wt)
  writeFileSync(path.join(wt, 'only-here.txt'), 'committed on no branch\n')
  git(wt, 'add', 'only-here.txt')
  git(wt, ...id, 'commit', '-q', '-m', 'orphan work')
  head = git(wt, 'rev-parse', 'HEAD').trim()
  writeFileSync(path.join(wt, 'only-here.txt'), 'committed on no branch\nedited since\n')
  writeFileSync(path.join(wt, 'notes.md'), 'untracked, exists nowhere else\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const detachedBundle = () => {
  const b = bundle(wt, 'review', { reason: { code: 'detached', detail: 'x' } })
  b.item = reapItem(wt, {
    id: `${repo}::detached-worktree::${wt}`,
    repoPath: repo,
    kind: 'detached-worktree',
    branch: undefined,
    headSha: head,
    verdict: 'blocked',
    blockers: ['detached-head'],
    justifiedBy: null
  })
  b.localTip = head
  b.fate = { fate: 'detached', signal: null, strong: false }
  return b
}

/** Real git and real archive shells; docker and sessions are the only fakes. */
function realWorld(over: Partial<ExecutorDeps> = {}): GcShellDeps {
  const executor: ExecutorDeps = {
    probeStatus: async () => ({ trackedDirty: true, untracked: ['notes.md'] }),
    hasUnpushed: async () => true,
    // A shim for the OS trash: moves the folder aside, as the real one would.
    trash: async (p) => {
      await fsp.rename(p, path.join(root, 'trash-' + path.basename(p)))
    },
    git: gitRun,
    resolveSha: async (r, rev) => {
      try {
        return git(r, 'rev-parse', '--verify', `${rev}^{commit}`).trim()
      } catch {
        return null
      }
    },
    archiveTip,
    archiveWip,
    canUnregister: (r, p) => canUnregister(r, p, gitRun),
    removeWorktreeAdmin: (r, p) => removeWorktreeAdmin(r, p, gitRun),
    detachSidebar: async () => undefined,
    appendTombstone: async () => undefined,
    now: () => NOW,
    ...over
  }
  return {
    executor,
    dehydrate: {
      isSessionLive: async () => false,
      readManifest: async () => ({ ephemeral: [], setup: [] }),
      probeEntries: async () => [],
      trackedFingerprint: async () => new Map(),
      removeDir: async () => undefined,
      recordDehydrated: async () => undefined
    },
    docker: {
      stop: async (ids) => ({ done: ids, error: null }),
      removeContainers: async (ids) => ({ done: ids, error: null }),
      removeVolumes: async (names) => ({ done: names, error: null })
    },
    listStacks: async () => ({ stacks: [] }),
    presenceOf: async () => 'none',
    headOf: async (p) => git(p, 'rev-parse', 'HEAD').trim(),
    isProtectedNow: () => false,
    realpath: async (p) => fsp.realpath(p).catch(() => null),
    listWorktrees: async (r) =>
      git(r, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length)),
    findForeignCheckouts: async () => []
  }
}

const FORCE = { removeVolumes: false, confirmReview: true }
const refs = (): string[] =>
  git(repo, 'for-each-ref', '--format=%(refname)', 'refs/archive/detached')
    .split('\n')
    .filter(Boolean)
    .sort()

describe('removing a detached worktree from review (AC-A1, AC-A2)', () => {
  it('the predicate and main both take it once confirmed', () => {
    const b = detachedBundle()
    expect(bundleRemovability(b, NOW + DAY)).toEqual({ ok: true })
    expect(refusalFor(b, defaultGcPrefs(), { confirmed: true })).toBeNull()
  })

  it('archives the commit and the uncommitted work by sha, then removes the folder and its registration', async () => {
    const b = detachedBundle()
    const result = await runBundle(b, createForcedGcOps(realWorld()), FORCE)
    expect(result).toMatchObject({ ok: true, haltedAt: null })

    const ns = `refs/archive/detached/bisect-1-${head.slice(0, 12)}`
    expect(refs()).toEqual([`${ns}/tip`, `${ns}/wip`])
    // Both objects exist and the tip is the commit that was on no branch.
    expect(git(repo, 'rev-parse', `${ns}/tip`).trim()).toBe(head)
    git(repo, 'cat-file', '-e', `${ns}/tip`)
    git(repo, 'cat-file', '-e', `${ns}/wip`)
    // The wip carries the tracked edit AND the untracked file the tip does not.
    expect(git(repo, 'show', `${ns}/wip:only-here.txt`)).toContain('edited since')
    expect(git(repo, 'show', `${ns}/wip:notes.md`)).toContain('exists nowhere else')

    expect(existsSync(wt)).toBe(false)
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('bisect-1')
    // No branch was created or deleted along the way.
    expect(git(repo, 'branch', '--format=%(refname:short)').trim()).toBe('main')

    // The refs outlive a gc: the work is recoverable, not merely unreferenced.
    git(repo, 'gc', '--prune=now', '-q')
    git(repo, 'cat-file', '-e', `${ns}/wip`)
  })

  it('restores with the documented commands: the commit as a worktree, the work as a branch', async () => {
    await runBundle(detachedBundle(), createForcedGcOps(realWorld()), FORCE)
    const ns = `refs/archive/detached/bisect-1-${head.slice(0, 12)}`

    const back = path.join(root, 'restored')
    git(repo, 'worktree', 'add', '-q', back, `${ns}/tip`)
    expect(readFileSync(path.join(back, 'only-here.txt'), 'utf8')).toBe('committed on no branch\n')

    git(repo, 'checkout', '-q', '-b', 'recovered-work', `${ns}/wip`)
    expect(readFileSync(path.join(repo, 'notes.md'), 'utf8')).toContain('exists nowhere else')
  })

  it('halts at the archive and leaves the folder, its registration and its files untouched', async () => {
    const world = realWorld({
      archiveWip: async () => {
        throw new Error('disk full')
      }
    })
    const result = await runBundle(detachedBundle(), createForcedGcOps(world), FORCE)

    expect(result).toMatchObject({ ok: false, haltedAt: 'reprobe' })
    expect(result.error).toContain('archive-failed: disk full')
    expect(existsSync(wt)).toBe(true)
    expect(readFileSync(path.join(wt, 'notes.md'), 'utf8')).toContain('exists nowhere else')
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('bisect-1')
  })

  it('archives a second removal of the same folder at the same commit without losing the first wip', async () => {
    const ns = `refs/archive/detached/bisect-1-${head.slice(0, 12)}`
    await runBundle(detachedBundle(), createForcedGcOps(realWorld()), FORCE)
    const firstWip = git(repo, 'rev-parse', `${ns}/wip`).trim()

    // The same folder name at the same commit again, with different uncommitted work.
    git(repo, 'worktree', 'add', '-q', '--detach', wt, head)
    writeFileSync(path.join(wt, 'second.md'), 'a different day\n')
    await runBundle(detachedBundle(), createForcedGcOps(realWorld()), FORCE)

    const secondWip = git(repo, 'rev-parse', `${ns}/wip`).trim()
    expect(secondWip).not.toBe(firstWip)
    // The first wip is still reachable from the ref, so a gc cannot reclaim it.
    git(repo, 'merge-base', '--is-ancestor', firstWip, `${ns}/wip`)
    git(repo, 'gc', '--prune=now', '-q')
    git(repo, 'cat-file', '-e', firstWip)
  })
})
