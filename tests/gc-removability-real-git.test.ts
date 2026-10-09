// The parity table in gc-removability.test.ts builds its fake world from the bundle's own facts, so
// "locked" there proves the predicate and main agree about a flag, not about git. This test closes
// that loop with a real repository: a real `git worktree lock`, read by the real scan (`gatherGc`,
// whose lock listing here is the real `git worktree list --porcelain` through the real parser), and
// then judged by the predicate AND by main's real `canUnregister` and pipeline.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, cpSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  userData: '',
  snapshot: null as null | { repos: Array<{ repoPath: string; items: unknown[] }> },
  fateInputs: new Map<string, unknown>()
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
  return {
    computeFolderSets: async () => ({ live: new Set(), inUse: new Set() }),
    lastFateInputs: () => h.fateInputs,
    lastSnapshot: () => h.snapshot,
    listAllWorktreePaths: async (repos: string[]) =>
      repos.flatMap((r) =>
        parseWorktreeList(
          run('git', ['-C', r, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
        )
          .filter((w) => !w.bare)
          .map((w) => w.path)
      ),
    // The real thing: what git itself says is locked.
    listLockedWorktreePaths: async (repos: string[]) =>
      repos.flatMap((r) =>
        parseWorktreeList(
          run('git', ['-C', r, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
        )
          .filter((w) => !w.bare && w.locked)
          .map((w) => w.path)
      )
  }
})
vi.mock('../src/main/gc/gc-transcripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/gc/gc-transcripts')>()),
  fsTranscriptProbe: () => ({
    listProjectDirs: async () => [],
    readIndex: async () => null,
    listJsonl: async () => [],
    cwdOf: async () => null
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
import { createGcOps } from '../src/main/gc/gc-shell'
import { createForcedGcOps } from '../src/main/gc/gc-forced-ops'
import { refusalFor } from '../src/main/gc/autopilot-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { runBundle } from '../src/main/gc/pipeline-core'
import { canUnregister } from '../src/main/reaper/worktree-admin-shell'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import type { BranchFacts, ReapItem } from '../src/main/reaper/reaper-core'
import { bundleRemovability } from '../src/renderer/src/lib/gc-removability'
import { worldFor } from './helpers/gc-world'

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.parse('2026-10-08T12:00:00Z')
const TIP = 'a'.repeat(40)
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const gitRun = async (repo: string, args: string[]): Promise<string> => git(repo, ...args)

let root: string
let repo: string

function itemFor(wt: string, name: string): ReapItem {
  return {
    id: `${repo}::worktree::feat/${name}`,
    repoPath: repo,
    kind: 'worktree',
    branch: `feat/${name}`,
    path: wt,
    hidden: false,
    ageDays: 1,
    diskBytes: 10,
    checkpoints: [
      { id: 'pr-merged', state: 'green', detail: new Date(NOW - 3_600_000).toISOString() },
      { id: 'local-clean', state: 'green' }
    ],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: 'ancestor',
    hydration: null
  }
}

function factsFor(wt: string, name: string): BranchFacts {
  return {
    kind: 'worktree',
    repoPath: repo,
    branch: `feat/${name}`,
    path: wt,
    hidden: false,
    sessionLive: false,
    trackedDirty: false,
    untracked: [],
    unpushed: false,
    remoteExists: false,
    ancestorOfDefault: true,
    patchIdContained: null,
    lastCommitAt: null,
    pr: null,
    ghAvailable: true,
    prSetComplete: true,
    prProvenance: 'own-name'
  }
}

/** A real worktree in the real repo, scanned by the real gather, released so it is ready. */
async function scanned(
  name: string,
  setup: (wt: string) => void = () => {}
): Promise<WorktreeBundle> {
  const wt = path.join(root, 'trees', name)
  git(repo, 'worktree', 'add', '-q', '-b', `feat/${name}`, wt)
  setup(wt)
  const item = itemFor(wt, name)
  h.snapshot = {
    repos: [{ repoPath: repo, items: [...(h.snapshot?.repos[0]?.items ?? []), item] }]
  }
  h.fateInputs.set(item.id, { facts: factsFor(wt, name), localTip: TIP })
  const prefs = {
    ...defaultGcPrefs(),
    graceDays: 2,
    released: Object.fromEntries(
      (h.snapshot.repos[0].items as ReapItem[]).map((i) => [i.id, NOW - 60_000])
    ),
    releasedFrom: Object.fromEntries(
      (h.snapshot.repos[0].items as ReapItem[]).map((i) => [
        i.id,
        { repoPath: repo, path: i.path as string, localTip: TIP }
      ])
    )
  }
  const g = await gatherGc(prefs, NOW)
  return g.bundles.find((b) => b.item.id === item.id)!
}

/** Main's own verdict, with git's real answer to "can this be unregistered?". */
async function mainSays(b: WorktreeBundle): Promise<string | null> {
  const hard = refusalFor(b, defaultGcPrefs(), { confirmed: true })
  if (hard) return hard
  const world = worldFor(b)
  // Real git answers the registration question; the clock is the one the scan ran at.
  world.executor.canUnregister = (r, p) => canUnregister(r, p, gitRun)
  world.executor.now = () => NOW
  const forced = b.bucket !== 'ready'
  const ops = forced ? createForcedGcOps(world) : createGcOps(world)
  const r = await runBundle(b, ops, { removeVolumes: false, confirmReview: forced })
  return r.ok ? null : (r.error ?? 'failed').split(':')[0]
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-gc-realgit-'))
  h.userData = path.join(root, 'userdata')
  repo = path.join(root, 'org', 'proj', 'www')
  mkdirSync(h.userData, { recursive: true })
  mkdirSync(repo, { recursive: true })
  h.snapshot = null
  h.fateInputs = new Map()
  git(repo, 'init', '-q', '-b', 'main')
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the scan fact "locked" is git\'s own, and the predicate and main agree on it', () => {
  it('an unlocked worktree is ready, removable by the predicate, and cleaned by main', async () => {
    const b = await scanned('free')
    expect(b.locked).not.toBe(true)
    expect(b.bucket).toBe('ready')
    expect(bundleRemovability(b, NOW)).toEqual({ ok: true })
    expect(await mainSays(b)).toBeNull()
  })

  it('a worktree locked with a real `git worktree lock` is read as locked by the scan, refused by the predicate, and refused by main as cannot-unregister', async () => {
    const b = await scanned('held', (wt) => git(repo, 'worktree', 'lock', wt))
    expect(b.locked).toBe(true)
    expect(bundleRemovability(b, NOW)).toMatchObject({ ok: false, reason: 'locked' })
    expect(await mainSays(b)).toBe('cannot-unregister')
  })

  it('a stale duplicate registration is invisible to the scan: the predicate cannot know, main refuses it, and that is what the remembered refusal is for', async () => {
    const b = await scanned('dup')
    const admin = path.join(repo, '.git', 'worktrees')
    const name = path.basename(b.item.path as string)
    cpSync(path.join(admin, name), path.join(admin, `${name}-dup`), { recursive: true })
    // The scan still calls it ready (nothing about the duplicate is a fact the scan reads) …
    expect(bundleRemovability(b, NOW)).toEqual({ ok: true })
    // … and main refuses it at the reprobe, which is exactly the case TM-11 remembers.
    expect(await mainSays(b)).toBe('cannot-unregister')
  })
})
