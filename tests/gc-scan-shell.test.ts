import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * T445 delta 2 (6) — `gatherGc` itself, with its environment mocked: no docker, no git, no
 * electron. What is pinned here is how the gather feeds the release rules: that a release mark
 * reaches `buildBundles`, that a mark is judged "cleaned" only for a repo the Reaper scanned
 * and a folder that is really gone, and that an unreadable folder is never read as gone.
 */

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
vi.mock('../src/main/reaper/scanner-shell', () => ({
  computeFolderSets: async () => ({ live: new Set(), inUse: new Set() }),
  lastFateInputs: () => h.fateInputs,
  lastSnapshot: () => h.snapshot,
  listAllWorktreePaths: async () => [],
  listLockedWorktreePaths: async () => []
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
vi.mock('../src/main/gc/gc-shell', async () => {
  const { AS_GIVEN } = await import('../src/main/gc/bundle-core')
  return {
    presenceFromSets: () => 'none',
    dockerIsUnavailable: () => true,
    findForeignCheckouts: async () => [],
    resolveRealPaths: async () => AS_GIVEN
  }
})

import { gatherGc } from '../src/main/gc/gc-scan-shell'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { BranchFacts, ReapItem } from '../src/main/reaper/reaper-core'

// Each test runs real gathers (fs stats, realpaths); coverage instrumentation can slow them.
vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.parse('2026-10-08T12:00:00Z')
const TIP = 'a'.repeat(40)

let root: string
let repo: string
let wt: string

function item(): ReapItem {
  return {
    id: `${repo}::worktree::feat/x`,
    repoPath: repo,
    kind: 'worktree',
    branch: 'feat/x',
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

function facts(): BranchFacts {
  return {
    kind: 'worktree',
    repoPath: repo,
    branch: 'feat/x',
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

/** A prefs with one release mark for the fixture worktree. */
/** `tip` null records none (a legacy mark). */
function released(over: Partial<GcPrefs> = {}, tip: string | null = TIP): GcPrefs {
  const id = item().id
  return {
    ...defaultGcPrefs(),
    released: { [id]: NOW - 60_000 },
    releasedFrom: {
      [id]: { repoPath: repo, path: wt, ...(tip === null ? {} : { localTip: tip }) }
    },
    ...over
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-gc-scan-'))
  h.userData = path.join(root, 'userdata')
  repo = path.join(root, 'org', 'proj', 'www')
  wt = path.join(root, 'trees', 'PROJ-1-x')
  mkdirSync(h.userData, { recursive: true })
  mkdirSync(repo, { recursive: true })
  h.snapshot = null
  h.fateInputs = new Map()
})

afterEach(() => {
  try {
    chmodSync(path.join(root, 'locked'), 0o755)
  } catch {
    /* only exists in the unreadable-folder test */
  }
  rmSync(root, { recursive: true, force: true })
})

describe('gatherGc: a release mark reaches the bundle builder (G3)', () => {
  function scanWithWorktree(): void {
    mkdirSync(wt, { recursive: true })
    h.snapshot = { repos: [{ repoPath: repo, items: [item()] }] }
    h.fateInputs = new Map([[item().id, { facts: facts(), localTip: TIP }]])
  }

  it('a merged worktree inside its grace is in-use without a release and ready with one', async () => {
    scanWithWorktree()
    const plain = await gatherGc({ ...defaultGcPrefs(), graceDays: 2 }, NOW)
    expect(plain.bundles).toHaveLength(1)
    expect(plain.bundles[0]!.bucket).toBe('in-use')

    const withRelease = await gatherGc({ ...released(), graceDays: 2 }, NOW)
    expect(withRelease.bundles[0]!.bucket).toBe('ready')
  })

  it('a mark made at another tip, or with no tip, does not apply', async () => {
    scanWithWorktree()
    const other = await gatherGc({ ...released({}, 'b'.repeat(40)), graceDays: 2 }, NOW)
    expect(other.bundles[0]!.bucket).toBe('in-use')
    const legacy = await gatherGc({ ...released({}, null), graceDays: 2 }, NOW)
    expect(legacy.bundles[0]!.bucket).toBe('in-use')
  })

  it('a mark made at another tip is reported stale', async () => {
    scanWithWorktree()
    const g = await gatherGc({ ...released({}, 'b'.repeat(40)), graceDays: 2 }, NOW)
    expect(g.staleReleases).toEqual([item().id])
  })
})

describe('gatherGc: a cleaned worktree drops its mark, nothing else does (G1, G2)', () => {
  it('drops the mark when the repo was scanned and the folder is gone', async () => {
    h.snapshot = { repos: [{ repoPath: repo, items: [] }] }
    const g = await gatherGc(released(), NOW)
    expect(g.staleReleases).toEqual([item().id])
  })

  it('G2: keeps it when the repo was not part of the scan', async () => {
    h.snapshot = { repos: [{ repoPath: path.join(root, 'other-repo'), items: [] }] }
    const g = await gatherGc(released(), NOW)
    expect(g.staleReleases).toEqual([])
  })

  it('keeps it when there is no Reaper snapshot at all (app start)', async () => {
    h.snapshot = null
    const g = await gatherGc(released(), NOW)
    expect(g.staleReleases).toEqual([])
  })

  it('keeps it when the folder still exists', async () => {
    mkdirSync(wt, { recursive: true })
    h.snapshot = { repos: [{ repoPath: repo, items: [] }] }
    const g = await gatherGc(released(), NOW)
    expect(g.staleReleases).toEqual([])
  })

  it('G1: an unreadable folder is not a gone folder', async () => {
    // Skipped where the process can read through mode 000 (root).
    if (process.getuid?.() === 0) return
    const locked = path.join(root, 'locked')
    mkdirSync(path.join(locked, 'inner'), { recursive: true })
    chmodSync(locked, 0o000)
    h.snapshot = { repos: [{ repoPath: repo, items: [] }] }
    const hidden = path.join(locked, 'inner', 'wt')
    const id = item().id
    const prefs: GcPrefs = {
      ...defaultGcPrefs(),
      released: { [id]: NOW - 1 },
      releasedFrom: { [id]: { repoPath: repo, path: hidden, localTip: TIP } }
    }
    const g = await gatherGc(prefs, NOW)
    chmodSync(locked, 0o755)
    expect(g.staleReleases).toEqual([])
  })
})
