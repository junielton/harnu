import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * T191 persistence — `bornFrom` round-trip (including an old `projects.json`
 * without the field), the birth-time guarded `resolveBornFrom`, the manual
 * `setUserProjectBornFrom` override, and `listBornFromCandidates`. Real
 * `projects.json` round-trips against a throwaway userData dir; `electron.app`
 * is mocked to point at it — same harness as `user-projects-alias.test.ts`.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  addUserProject,
  readUserProjects,
  writeUserProjects,
  resolveBornFrom,
  setUserProjectBornFrom,
  listBornFromCandidates
} from '../src/main/user-projects'

// Non-existent paths → `normalizePath`'s realpath fails and it falls back to
// the resolved-but-unrealpathed string, so assertions are stable across runs.
const MAIN = '/repos/app'
const ORCHESTRATOR = '/repos/app/.claude/worktrees/orchestrator'
const CHILD = '/repos/app/.claude/worktrees/child'
const FOREIGN = '/repos/other-app'

describe('bornFrom round-trip (T191)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bornfrom-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('an old projects.json without the field parses unchanged', async () => {
    await writeUserProjects({
      version: 1,
      projects: [{ path: MAIN, alias: 'app', addedAt: '2026-01-01', worktrees: [] }],
      hiddenPaths: []
    })
    const file = await readUserProjects()
    expect(file.projects[0].bornFrom).toBeUndefined()
  })

  it('round-trips a bornFrom value written directly to the record', async () => {
    await addUserProject({
      path: CHILD,
      alias: 'child',
      addedAt: '2026-01-01',
      worktrees: [],
      bornFrom: ORCHESTRATOR
    })
    const file = await readUserProjects()
    expect(file.projects.find((p) => p.path === CHILD)!.bornFrom).toBe(ORCHESTRATOR)
  })
})

describe('resolveBornFrom (T191 birth-time recording guards)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bornfrom-guard-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('records the edge when the requester is a known non-main worktree of the same repo', async () => {
    await addUserProject({
      path: ORCHESTRATOR,
      alias: 'orchestrator',
      addedAt: '2026-01-01',
      worktrees: [],
      repoId: 'repo-1',
      isMainWorktree: false
    })
    const bornFrom = await resolveBornFrom(ORCHESTRATOR, { repoId: 'repo-1' })
    expect(bornFrom).toBe(ORCHESTRATOR)
  })

  it('drops the edge when the requester is the repo main checkout', async () => {
    await addUserProject({
      path: MAIN,
      alias: 'app',
      addedAt: '2026-01-01',
      worktrees: [],
      repoId: 'repo-1',
      isMainWorktree: true
    })
    const bornFrom = await resolveBornFrom(MAIN, { repoId: 'repo-1' })
    expect(bornFrom).toBeUndefined()
  })

  it('drops the edge when the requester is not a known folder at all', async () => {
    const bornFrom = await resolveBornFrom('/never/pinned', { repoId: 'repo-1' })
    expect(bornFrom).toBeUndefined()
  })

  it('drops the edge when the requester belongs to a different repo', async () => {
    await addUserProject({
      path: FOREIGN,
      alias: 'other-app',
      addedAt: '2026-01-01',
      worktrees: [],
      repoId: 'repo-2',
      isMainWorktree: false
    })
    const bornFrom = await resolveBornFrom(FOREIGN, { repoId: 'repo-1' })
    expect(bornFrom).toBeUndefined()
  })

  it('drops the edge when the target has no resolved repoId', async () => {
    await addUserProject({
      path: ORCHESTRATOR,
      alias: 'orchestrator',
      addedAt: '2026-01-01',
      worktrees: [],
      repoId: 'repo-1',
      isMainWorktree: false
    })
    const bornFrom = await resolveBornFrom(ORCHESTRATOR, {})
    expect(bornFrom).toBeUndefined()
  })
})

describe('setUserProjectBornFrom (T191 manual "Set/Clear parent folder")', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bornfrom-manual-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('creates a pinned record carrying the edge for an auto-discovered folder', async () => {
    const file = await setUserProjectBornFrom(CHILD, ORCHESTRATOR)
    const rec = file.projects.find((p) => p.path === CHILD)!
    expect(rec).toBeTruthy()
    expect(rec.bornFrom).toBe(ORCHESTRATOR)
  })

  it('sets the edge on an existing record, preserving other fields', async () => {
    await addUserProject({
      path: CHILD,
      alias: 'child',
      addedAt: '2026-01-01',
      worktrees: [],
      gitBranch: 'feat/x'
    })
    const file = await setUserProjectBornFrom(CHILD, ORCHESTRATOR)
    const rec = file.projects.find((p) => p.path === CHILD)!
    expect(rec.bornFrom).toBe(ORCHESTRATOR)
    expect(rec.gitBranch).toBe('feat/x')
  })

  it('clears the edge when passed null', async () => {
    await addUserProject({
      path: CHILD,
      alias: 'child',
      addedAt: '2026-01-01',
      worktrees: [],
      bornFrom: ORCHESTRATOR
    })
    const file = await setUserProjectBornFrom(CHILD, null)
    expect(file.projects.find((p) => p.path === CHILD)!.bornFrom).toBeUndefined()
  })

  it('is a no-op when clearing a folder that has no record at all', async () => {
    const file = await setUserProjectBornFrom('/never/pinned', null)
    expect(file.projects.find((p) => p.path === '/never/pinned')).toBeUndefined()
  })

  it('is idempotent — setting the same value does not throw and holds', async () => {
    await setUserProjectBornFrom(CHILD, ORCHESTRATOR)
    const file = await setUserProjectBornFrom(CHILD, ORCHESTRATOR)
    expect(file.projects.find((p) => p.path === CHILD)!.bornFrom).toBe(ORCHESTRATOR)
  })
})

describe('listBornFromCandidates (T191 "Set parent folder" submenu)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bornfrom-candidates-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('lists sibling worktrees of the same repo, excluding the target itself', async () => {
    await addUserProject({
      path: MAIN,
      alias: 'app',
      addedAt: '2026-01-01',
      worktrees: [],
      repoId: 'repo-1'
    })
    await addUserProject({
      path: ORCHESTRATOR,
      alias: 'orchestrator',
      addedAt: '2026-01-01',
      worktrees: [],
      repoId: 'repo-1'
    })
    await addUserProject({
      path: CHILD,
      alias: 'child',
      addedAt: '2026-01-01',
      worktrees: [],
      repoId: 'repo-1'
    })
    await addUserProject({
      path: FOREIGN,
      alias: 'other-app',
      addedAt: '2026-01-01',
      worktrees: [],
      repoId: 'repo-2'
    })
    const candidates = await listBornFromCandidates('repo-1', CHILD)
    expect(candidates.map((c) => c.path).sort()).toEqual([MAIN, ORCHESTRATOR].sort())
  })

  it('returns an empty list when there are no siblings', async () => {
    const candidates = await listBornFromCandidates('repo-lonely', MAIN)
    expect(candidates).toEqual([])
  })
})
