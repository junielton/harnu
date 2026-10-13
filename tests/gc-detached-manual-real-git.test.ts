// NDE-A delta-1, item 2: the real entry path for removing a detached worktree.
//
// The other detached tests build the bundle by hand. This one starts where the operator does: a real
// repository with a real detached worktree (an orphan commit, an edit, an untracked file), a scan item
// made by the real classifier and a real work stamp, the REAL gather (`gatherGc`) that buckets it, and
// `submitManualClean` — the function behind `gc:clean` — with the `expected` facts the dialog sent and
// the operator's confirmation. Only Docker, the OS trash and the Electron shell are replaced.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  userData: '',
  snapshot: null as null | { repos: Array<{ repoPath: string; items: unknown[] }> },
  transcripts: [] as Array<{ cwd: string; mtimeMs: number }>
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => h.userData, isPackaged: false },
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/fleet-model', () => ({ getFleetFolders: async () => [] }))
vi.mock('../src/main/user-projects', () => ({
  readUserProjects: async () => ({ projects: [], hiddenPaths: [] })
}))
vi.mock('../src/main/reaper/scanner-shell', async () => {
  const { execFileSync: run } = await import('node:child_process')
  const { parseWorktreeList } = await import('../src/main/worktree-core')
  const listed = (r: string) =>
    parseWorktreeList(
      run('git', ['-C', r, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    )
  return {
    computeFolderSets: async () => ({ live: new Set(), inUse: new Set() }),
    lastFateInputs: () => new Map(),
    lastSnapshot: () => h.snapshot,
    listAllWorktreePaths: async (repos: string[]) =>
      repos.flatMap((r) =>
        listed(r)
          .filter((w) => !w.bare)
          .map((w) => w.path)
      ),
    listLockedWorktreePaths: async (repos: string[]) =>
      repos.flatMap((r) =>
        listed(r)
          .filter((w) => !w.bare && w.locked)
          .map((w) => w.path)
      )
  }
})
// One old transcript per worktree: the sign of life that lets grace elapse, as in a real session.
vi.mock('../src/main/gc/gc-transcripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/gc/gc-transcripts')>()),
  fsTranscriptProbe: () => ({
    listProjectDirs: async () => h.transcripts.map((_, i) => `proj-${i}`),
    readIndex: async () => null,
    listJsonl: async (slug: string) => [
      { name: 'a.jsonl', mtimeMs: h.transcripts[Number(slug.slice(5))]!.mtimeMs }
    ],
    cwdOf: async (slug: string) => h.transcripts[Number(slug.slice(5))]!.cwd
  })
}))
vi.mock('../src/main/containers/containers-shell', () => ({
  inspectAll: async () => {
    throw Object.assign(new Error('docker: command not found'), { code: 'ENOENT' })
  },
  runDocker: async () => ({ stdout: '' })
}))
vi.mock('../src/main/containers/containers-journal', () => ({
  journalFile: () => '/nonexistent/journal',
  readJournal: async () => []
}))
vi.mock('../src/main/gc/gc-shell', async (importOriginal) => {
  const { AS_GIVEN } = await import('../src/main/gc/bundle-core')
  return {
    ...(await importOriginal<typeof import('../src/main/gc/gc-shell')>()),
    presenceFromSets: () => 'none',
    dockerIsUnavailable: () => true,
    dockerDaemonDown: () => false,
    findForeignCheckouts: async () => [],
    resolveRealPaths: async () => AS_GIVEN
  }
})

import { gatherGc } from '../src/main/gc/gc-scan-shell'
import { createGcOps, type GcShellDeps } from '../src/main/gc/gc-shell'
import { createForcedGcOps } from '../src/main/gc/gc-forced-ops'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { expectedOf } from '../src/main/gc/gc-confirm'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { scanWorkStamp, workStampOf } from '../src/main/gc/gc-work-stamp'
import { archiveReflog, archiveTip, archiveWip } from '../src/main/reaper/archive-shell'
import type { ExecutorDeps } from '../src/main/reaper/executor-core'
import { canUnregister, removeWorktreeAdmin } from '../src/main/reaper/worktree-admin-shell'
import { probeWorktreeStatus } from '../src/main/worktree-ipc'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import { buildRepoItems } from '../src/main/reaper/scan-core'
import { bundleRemovability } from '../src/renderer/src/lib/gc-removability'
import { buildGcModel, cleanRequestFor } from '../src/renderer/src/lib/gc-model'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import { NOW, DAY } from './gc-fixtures'
import { formatArchiveStamp } from '../src/main/reaper/archive-core'

vi.setConfig({ testTimeout: 60_000 })

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const gitRun = async (repo: string, args: string[]): Promise<string> => git(repo, ...args)
const exec = async (file: string, args: readonly string[]): Promise<{ stdout: string }> => ({
  stdout: execFileSync(file, [...args], { encoding: 'utf8', maxBuffer: 32 << 20 })
})
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']

let root: string
let repo: string
let wt: string
let head: string
let itemId: string
const prefs = { ...defaultGcPrefs(), graceDays: 2 }

/** Build the scan item the way the real scan does, for the real worktree on disk. */
async function scanDetached(): Promise<void> {
  const worktrees = [
    {
      path: repo,
      head: git(repo, 'rev-parse', 'HEAD').trim(),
      branch: 'main',
      detached: false,
      bare: false
    },
    { path: wt, head, branch: '', detached: true, bare: false }
  ]
  const status = await probeWorktreeStatus(wt)
  const items = buildRepoItems({
    repoPath: repo,
    defaultBranch: 'main',
    protectedBranches: ['main'],
    worktrees,
    mainWorktreePath: repo,
    localBranches: [],
    remoteHeads: new Map(),
    prByBranch: new Map(),
    ghAvailable: false,
    prSetComplete: false,
    hiddenPaths: [],
    liveFolders: new Set(),
    statusByPath: new Map([[wt, status]]),
    unpushedByPath: new Map(),
    ancestorByBranch: new Map(),
    patchIdContainedByBranch: new Map(),
    commitDateBySha: new Map([[head, NOW - 11 * DAY]]),
    diskBytesByPath: new Map([[wt, 1234]]),
    now: NOW
  })
  const item = items.find((i) => i.path === wt)!
  item.workStamp = await scanWorkStamp(exec, wt)
  itemId = item.id
  h.snapshot = { repos: [{ repoPath: repo, items: [item] }] }
}

function realWorld(): GcShellDeps {
  const executor: ExecutorDeps = {
    probeStatus: probeWorktreeStatus,
    hasUnpushed: async () => true,
    trash: async (p) => {
      await fsp.rename(p, path.join(root, `trash-${path.basename(p)}`))
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
    archiveReflog,
    canUnregister: (r, p) => canUnregister(r, p, gitRun),
    removeWorktreeAdmin: (r, p) => removeWorktreeAdmin(r, p, gitRun),
    detachSidebar: async () => undefined,
    appendTombstone: async () => undefined,
    now: () => NOW
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

function manualDeps(): {
  deps: ManualCleanDeps
  results: () => ReturnType<ManualCleanDeps['queue']['jobs']>
} {
  let n = 0
  const queue = createJobQueue({
    newId: () => `job-${++n}`,
    emitProgress: () => undefined,
    emitDone: () => undefined
  })
  const deps: ManualCleanDeps = {
    prefs: () => prefs,
    gather: () => gatherGc(prefs, NOW),
    opsFor: (_actor, forced) =>
      forced ? createForcedGcOps(realWorld()) : createGcOps(realWorld()),
    freshOrphans: async () => [],
    workStampOf: (p) => workStampOf(exec, p),
    removeOrphanVolumes: async () => ({
      buildCacheBytes: 0,
      imageBytes: 0,
      volumeBytes: 0,
      errors: []
    }),
    queue,
    state: createCycleState(),
    now: () => NOW
  }
  return { deps, results: () => queue.jobs() }
}

const gatherBundle = async (): Promise<WorktreeBundle> =>
  (await gatherGc(prefs, NOW)).bundles.find((b) => b.item.id === itemId)!

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-nde-a-manual-'))
  h.userData = path.join(root, 'userdata')
  repo = path.join(root, 'org', 'proj', 'www')
  mkdirSync(h.userData, { recursive: true })
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, ...ID, 'commit', '-q', '--allow-empty', '-m', 'init')
  wt = path.join(root, 'trees', 'bisect-1')
  git(repo, 'worktree', 'add', '-q', '--detach', wt)
  writeFileSync(path.join(wt, 'only-here.txt'), 'committed on no branch\n')
  git(wt, 'add', 'only-here.txt')
  git(wt, ...ID, 'commit', '-q', '-m', 'orphan work')
  head = git(wt, 'rev-parse', 'HEAD').trim()
  writeFileSync(path.join(wt, 'only-here.txt'), 'committed on no branch\nedited since\n')
  writeFileSync(path.join(wt, 'notes.md'), 'untracked, exists nowhere else\n')
  h.transcripts = [{ cwd: wt, mtimeMs: NOW - 10 * DAY }]
  await scanDetached()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a detached worktree through the real scan and the real gc:clean entry (delta-1, item 2)', () => {
  it('the real gather puts it in Needs review, with the untracked file disclosed and a work stamp', async () => {
    const b = await gatherBundle()
    expect(b.bucket).toBe('review')
    expect(b.reason?.code).toBe('detached')
    expect(b.localTip).toBe(head)
    expect(b.item.untracked).toEqual(['notes.md'])
    expect(typeof b.item.workStamp).toBe('string')
  })

  it('the Remove predicate offers it, and the dialog request carries it as confirmed', async () => {
    const snapshot = (await buildSnapshot()) as GcSnapshot
    const model = buildGcModel(snapshot)
    const block = model.byId.get(itemId)!
    expect(bundleRemovability(block.bundle!, NOW)).toEqual({ ok: true })
    const req = cleanRequestFor(model, [itemId], 'review')
    expect(req.ids).toEqual([itemId])
    expect(req.options.confirmed).toEqual([itemId])
  })

  it('confirm → removed: refs written, folder trashed and unregistered, nothing else touched', async () => {
    const b = await gatherBundle()
    const { deps } = manualDeps()
    submitManualClean(deps, [itemId], {
      confirmed: [itemId],
      expected: { [itemId]: expectedOf(b) }
    })
    await deps.queue.idle()

    const [job] = deps.queue.jobs()
    expect(job!.results).toEqual([
      expect.objectContaining({ id: itemId, ok: true, haltedAt: null })
    ])
    const ns = `refs/archive/detached/${formatArchiveStamp(NOW)}/bisect-1-${head.slice(0, 12)}`
    expect(
      git(repo, 'for-each-ref', '--format=%(refname)', 'refs/archive/detached')
        .trim()
        .split('\n')
        .sort()
    ).toEqual([`${ns}/tip`, `${ns}/wip`])
    expect(git(repo, 'rev-parse', `${ns}/tip`).trim()).toBe(head)
    expect(git(repo, 'show', `${ns}/wip:notes.md`)).toContain('exists nowhere else')
    expect(existsSync(wt)).toBe(false)
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('bisect-1')
    expect(git(repo, 'branch', '--format=%(refname:short)').trim()).toBe('main')
  })

  it('without the operator’s confirmation nothing is removed', async () => {
    const b = await gatherBundle()
    const { deps } = manualDeps()
    submitManualClean(deps, [itemId], { confirmed: [], expected: { [itemId]: expectedOf(b) } })
    await deps.queue.idle()
    expect(deps.queue.jobs()[0]!.results[0]).toMatchObject({
      ok: false,
      error: 'needs-confirmation'
    })
    expect(existsSync(wt)).toBe(true)
    expect(git(repo, 'for-each-ref', 'refs/archive').trim()).toBe('')
  })

  it('a file edited after the dialog opened stops the removal: the work stamp is compared for a detached item too', async () => {
    const b = await gatherBundle()
    writeFileSync(path.join(wt, 'notes.md'), 'edited after you looked\n')
    const { deps } = manualDeps()
    submitManualClean(deps, [itemId], {
      confirmed: [itemId],
      expected: { [itemId]: expectedOf(b) }
    })
    await deps.queue.idle()
    const r = deps.queue.jobs()[0]!.results[0]!
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/work-changed-since-confirm|changed-since-confirm/)
    expect(existsSync(wt)).toBe(true)
    expect(git(repo, 'for-each-ref', 'refs/archive').trim()).toBe('')
  })

  it('a new commit after the dialog opened is refused as changed since you confirmed', async () => {
    const b = await gatherBundle()
    writeFileSync(path.join(wt, 'later.txt'), 'x\n')
    git(wt, 'add', 'later.txt')
    git(wt, ...ID, 'commit', '-q', '-m', 'later')
    const { deps } = manualDeps()
    submitManualClean(deps, [itemId], {
      confirmed: [itemId],
      expected: { [itemId]: expectedOf(b) }
    })
    await deps.queue.idle()
    expect(deps.queue.jobs()[0]!.results[0]).toMatchObject({ ok: false })
    expect(existsSync(wt)).toBe(true)
  })

  it('a rebase left in progress refuses the removal, naming the command, and keeps the folder', async () => {
    // a rebase needs a clean tree: commit the dirty files first, then stop a rebase on its last commit
    git(wt, 'add', '-A')
    git(wt, ...ID, 'commit', '-q', '-m', 'second')
    execFileSync('git', ['-C', wt, ...ID, 'rebase', '-q', '-i', 'HEAD~1'], {
      env: { ...process.env, GIT_SEQUENCE_EDITOR: 'sed -i s/^pick/edit/' }
    })
    await scanDetached()
    const b = await gatherBundle()
    expect(b.operation).toBe('rebase')
    expect(b.reason?.code).toBe('operation-in-progress')
    expect(bundleRemovability(b, NOW)).toMatchObject({
      ok: false,
      reason: 'operation-in-progress',
      hint: expect.stringContaining('rebase --abort')
    })
    const { deps } = manualDeps()
    submitManualClean(deps, [itemId], {
      confirmed: [itemId],
      expected: { [itemId]: expectedOf(b) }
    })
    await deps.queue.idle()
    expect(deps.queue.jobs()[0]!.results[0]).toMatchObject({
      ok: false,
      error: 'operation-in-progress'
    })
    expect(existsSync(wt)).toBe(true)
  })
})

/** The snapshot the screen is built from, assembled from the same gather. */
async function buildSnapshot(): Promise<unknown> {
  const g = await gatherGc(prefs, NOW)
  return {
    scannedAt: NOW,
    bundles: g.bundles,
    orphanVolumes: g.orphanVolumes,
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs,
    lastCycle: null,
    nextCycleAt: null
  }
}
