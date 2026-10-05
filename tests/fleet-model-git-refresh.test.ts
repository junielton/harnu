import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FolderEntry } from '../src/main/folder-model'
import type { SessionEntry } from '../src/main/claude-reader'

/**
 * BUG-34 — shell-level wiring net, isolated in its own file (rather than
 * `fleet-model.test.ts`) because it needs `scanFoldersUncached` mocked so the
 * scenario is deterministic: a REAL git probe is cached for 60s
 * (`git-probe.ts`'s `CACHE_TTL_MS`), which would make "the same path reports a
 * different branch on the next full rescan" flaky/impossible to assert inside
 * a fast unit test. `fleet-model.test.ts`'s other tests keep exercising the
 * real `scanFoldersUncached` against real fixture dirs — this file only swaps
 * that one seam so the shell's OWN plumbing (thread a freshly-scanned
 * `gitByPath` into the model) is what's under test, not `git-probe.ts`'s cache
 * policy (out of scope per the BUG-34 spec's scope boundary).
 */

const mockScan = vi.fn<[], Promise<FolderEntry[]>>()

vi.mock('../src/main/claude-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/claude-reader')>()
  return { ...actual, scanFoldersUncached: (...args: unknown[]) => mockScan(...(args as [])) }
})

import {
  getFleetFolders,
  notifyWatcherReady,
  notifyWatcherDegraded,
  __resetFleetModelForTests,
  __setDebounceMsForTests,
  __flushPendingRefreshForTests
} from '../src/main/fleet-model'

function folderFor(folders: FolderEntry[], path: string): FolderEntry | undefined {
  return folders.find((f) => f.path === path)
}

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: 's1',
    fullPath: '/root/slug-a/s1.jsonl',
    fileMtime: 0,
    firstPrompt: '',
    summary: '',
    messageCount: 0,
    created: '',
    modified: '',
    gitBranch: '',
    projectPath: '/repo',
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: false,
    bridged: false,
    transcriptState: 'unknown',
    awaySummary: '',
    whatsHappening: '',
    ctxPct: null,
    teamName: '',
    agentName: '',
    ...overrides
  }
}

describe('fleet-model — full-rescan git refresh (BUG-34)', () => {
  beforeEach(async () => {
    await __resetFleetModelForTests()
    __setDebounceMsForTests(5)
    mockScan.mockReset()
  })

  afterEach(async () => {
    await __resetFleetModelForTests()
  })

  it('a notifyWatcherReady() rescan re-probes git metadata for a folder with no session churn', async () => {
    const session = makeSession()
    mockScan.mockResolvedValueOnce([
      { path: '/repo', alias: 'repo', gitBranch: 'main', sessions: [session] }
    ])
    await getFleetFolders() // boot
    expect(folderFor(await getFleetFolders(), '/repo')?.gitBranch).toBe('main')

    // Same session, a branch switch happened on disk with zero session
    // activity — only the probed gitBranch differs on the next full scan.
    mockScan.mockResolvedValueOnce([
      { path: '/repo', alias: 'repo', gitBranch: 'feat/x', sessions: [session] }
    ])
    notifyWatcherReady()
    await __flushPendingRefreshForTests()

    const folders = await getFleetFolders()
    expect(folderFor(folders, '/repo')?.gitBranch).toBe('feat/x')
  })

  it('a notifyWatcherDegraded() rescan also re-probes git metadata for a quiet folder', async () => {
    const session = makeSession()
    mockScan.mockResolvedValueOnce([
      { path: '/repo', alias: 'repo', gitBranch: 'main', sessions: [session] }
    ])
    await getFleetFolders() // boot

    mockScan.mockResolvedValueOnce([
      { path: '/repo', alias: 'repo', gitBranch: 'hotfix/y', sessions: [session] }
    ])
    notifyWatcherDegraded()
    await __flushPendingRefreshForTests()

    const folders = await getFleetFolders()
    expect(folderFor(folders, '/repo')?.gitBranch).toBe('hotfix/y')
  })
})
