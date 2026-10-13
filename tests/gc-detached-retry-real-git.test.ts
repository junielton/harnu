// AC-E2 delta 1, item 6: a retried forced removal of the same folder at the same HEAD reuses the
// existing dated archive for that folder and commit (the newest one) instead of opening a new one,
// so the reflog refs and working states of one removal stay in ONE group.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createDryReprobe, createForcedGcOps } from '../src/main/gc/gc-forced-ops'
import type { GcShellDeps } from '../src/main/gc/gc-shell'
import { listRepoArchives, execGit } from '../src/main/gc/archives-shell'
import { runBundle } from '../src/main/gc/pipeline-core'
import {
  archiveTip,
  archiveWip,
  createReflogArchiver,
  findDetachedArchiveAt
} from '../src/main/reaper/archive-shell'
import {
  detachedArchiveKey,
  formatArchiveStamp,
  newestReusableStamp
} from '../src/main/reaper/archive-core'
import type { ExecutorDeps } from '../src/main/reaper/executor-core'
import { canUnregister, removeWorktreeAdmin } from '../src/main/reaper/worktree-admin-shell'
import { bundle, NOW, reapItem } from './gc-fixtures'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const gitRun = async (repo: string, args: string[]): Promise<string> => git(repo, ...args)

describe('newestReusableStamp (pure)', () => {
  const key = 'bisect-1-abcdef012345'
  const ref = (stamp: string, k = key): { ref: string; sha: string } => ({
    ref: `refs/archive/detached/${stamp}/${k}/tip`,
    sha: 'abcdef012345'.padEnd(40, '0')
  })
  const at = Date.parse('2026-10-12T10:00:00Z')

  it('picks the newest stamp for this folder and commit, within the retry window', () => {
    const refs = [ref('20261012T040000Z'), ref('20261012T080000Z'), ref('20261001T000000Z')]
    expect(newestReusableStamp(refs, key, at)).toBe(Date.parse('2026-10-12T08:00:00Z'))
  })

  it('ignores another folder, another commit, an old removal and a hand-made ref', () => {
    expect(newestReusableStamp([ref('20261012T080000Z', 'other-abcdef012345')], key, at)).toBeNull()
    expect(newestReusableStamp([ref('20261008T080000Z')], key, at)).toBeNull()
    expect(
      newestReusableStamp(
        [{ ref: `refs/archive/detached/20261012T080000Z/${key}/tip`, sha: 'f'.repeat(40) }],
        key,
        at
      )
    ).toBeNull()
    expect(newestReusableStamp([], key, at)).toBeNull()
  })

  it('never reuses a stamp from the future', () => {
    expect(newestReusableStamp([ref('20261013T080000Z')], key, at)).toBeNull()
  })
})

let root: string
let repo: string
let wt: string
let head: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-e6-'))
  repo = path.join(root, 'org', 'proj', 'www')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, ...ID, 'commit', '-q', '--allow-empty', '-m', 'init')
  wt = path.join(root, 'trees', 'bisect-1')
  git(repo, 'worktree', 'add', '-q', '--detach', wt)
  writeFileSync(path.join(wt, 'a.txt'), 'one\n')
  git(wt, 'add', 'a.txt')
  git(wt, ...ID, 'commit', '-q', '-m', 'work')
  head = git(wt, 'rev-parse', 'HEAD')
  // A commit only the reflog reaches, then back to HEAD, then uncommitted work.
  git(wt, ...ID, 'commit', '-q', '--allow-empty', '-m', 'reflog only')
  git(wt, 'checkout', '-q', '--detach', head)
  writeFileSync(path.join(wt, 'notes.md'), 'untracked\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

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

function world(now: number, over: Partial<ExecutorDeps> = {}): GcShellDeps {
  const executor: ExecutorDeps = {
    probeStatus: async () => ({ trackedDirty: true, untracked: ['notes.md'] }),
    hasUnpushed: async () => true,
    trash: async (p) => {
      await fsp.rename(p, path.join(root, 'trash-' + path.basename(p) + now))
    },
    git: gitRun,
    resolveSha: async (r, rev) => {
      try {
        return git(r, 'rev-parse', '--verify', `${rev}^{commit}`)
      } catch {
        return null
      }
    },
    archiveTip,
    archiveWip,
    archiveReflog: (r, prefix, w) => createReflogArchiver().archive(r, prefix, w),
    findDetachedArchiveAt,
    canUnregister: (r, p) => canUnregister(r, p, gitRun),
    removeWorktreeAdmin: (r, p) => removeWorktreeAdmin(r, p, gitRun),
    detachSidebar: async () => undefined,
    appendTombstone: async () => undefined,
    now: () => now,
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
    headOf: async (p) => git(p, 'rev-parse', 'HEAD'),
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

describe('a retried forced removal reuses its archive group', () => {
  it('two retries of the same folder at the same commit leave ONE group, reflog refs included', async () => {
    // Attempt 1 archives, then the reprobe of a later step refuses: nothing was removed.
    await createForcedGcOps(world(NOW)).reprobe(detachedBundle())
    // Attempt 2 and 3, hours later, are retries of the same removal.
    await createForcedGcOps(world(NOW + 2 * HOUR)).reprobe(detachedBundle())
    await createForcedGcOps(world(NOW + 5 * HOUR)).reprobe(detachedBundle())

    const groups = await listRepoArchives(execGit, repo)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.namespace).toContain(formatArchiveStamp(NOW))
    expect(groups[0]!.reflogCount).toBeGreaterThan(0)
    expect(groups[0]!.hasWip).toBe(true)
  })

  it('the removal that finishes writes into the same group too', async () => {
    await createForcedGcOps(world(NOW)).reprobe(detachedBundle())
    const result = await runBundle(detachedBundle(), createForcedGcOps(world(NOW + 3 * HOUR)), {
      removeVolumes: false,
      confirmReview: true
    })
    expect(result).toMatchObject({ ok: true })
    const groups = await listRepoArchives(execGit, repo)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.namespace).toContain(formatArchiveStamp(NOW))
  })

  it('a removal days later is a new, separately dated archive', async () => {
    await createForcedGcOps(world(NOW)).reprobe(detachedBundle())
    await createForcedGcOps(world(NOW + 3 * DAY)).reprobe(detachedBundle())
    expect(await listRepoArchives(execGit, repo)).toHaveLength(2)
  })

  it('the dry run reads the group and writes nothing', async () => {
    await createForcedGcOps(world(NOW)).reprobe(detachedBundle())
    const before = git(repo, 'for-each-ref', 'refs/archive')
    await createDryReprobe(world(NOW + 2 * HOUR), true)(detachedBundle())
    expect(git(repo, 'for-each-ref', 'refs/archive')).toBe(before)
  })

  it('a hand-made group of the same shape but another tip is not reused', async () => {
    const key = detachedArchiveKey(wt, head)
    git(
      repo,
      'update-ref',
      `refs/archive/detached/${formatArchiveStamp(NOW)}/${key}/tip`,
      git(repo, 'rev-parse', 'main')
    )
    await createForcedGcOps(world(NOW + HOUR)).reprobe(detachedBundle())
    const stamps = git(
      repo,
      'for-each-ref',
      '--format=%(refname)',
      `refs/archive/detached/*/${key}/tip`
    )
    expect(stamps.split('\n')).toHaveLength(2)
  })
})
