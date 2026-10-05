import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * T344 (AC-1/AC-5) — `getUserProjectOrchestratorDefault`/
 * `setUserProjectOrchestratorDefault`: the per-folder "new sessions start as
 * Orchestrator" toggle. Default OFF when nothing is recorded. Unlike
 * `autoOrganizeCards` (T106), this is EXACT-PATH ONLY — a linked worktree of
 * an armed repo does NOT inherit the flag (AC-5: executors run in worktrees,
 * and an orchestrator dispatching armed executors would block every one of
 * them from editing code). Real `projects.json` round-trips against a
 * throwaway userData dir, mirroring `user-projects-auto-organize.test.ts`'s
 * harness.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  getUserProjectOrchestratorDefault,
  setUserProjectOrchestratorDefault,
  addUserProject
} from '../src/main/user-projects'

const REPO = '/repos/app'
const WORKTREE = '/repos/app/.claude/worktrees/wt'
const UNRELATED_FOLDER = '/repos/standalone'

describe('getUserProjectOrchestratorDefault / setUserProjectOrchestratorDefault (T344)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-uporchdefault-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('defaults to OFF when no record exists at all', async () => {
    expect(await getUserProjectOrchestratorDefault(UNRELATED_FOLDER)).toBe(false)
  })

  it('creates a record carrying the explicit value for an auto-discovered folder', async () => {
    const file = await setUserProjectOrchestratorDefault(REPO, true)
    const rec = file.projects.find((p) => p.path === REPO)!
    expect(rec).toBeTruthy()
    expect(rec.orchestratorDefault).toBe(true)
    expect(await getUserProjectOrchestratorDefault(REPO)).toBe(true)
  })

  it('flips the flag on an existing record, preserving other fields', async () => {
    await addUserProject({
      path: REPO,
      alias: 'app',
      addedAt: '2026-01-01',
      worktrees: [],
      gitBranch: 'main'
    })
    await setUserProjectOrchestratorDefault(REPO, true)
    const file = await setUserProjectOrchestratorDefault(REPO, false)
    const rec = file.projects.find((p) => p.path === REPO)!
    expect(rec.orchestratorDefault).toBe(false)
    expect(rec.gitBranch).toBe('main') // untouched
  })

  it('is idempotent — no write / no throw when set to the same value', async () => {
    await setUserProjectOrchestratorDefault(REPO, true)
    const file = await setUserProjectOrchestratorDefault(REPO, true)
    expect(file.projects.find((p) => p.path === REPO)!.orchestratorDefault).toBe(true)
  })

  it('AC-5: a linked worktree does NOT inherit its parent repo explicit value', async () => {
    await setUserProjectOrchestratorDefault(REPO, true)
    expect(await getUserProjectOrchestratorDefault(WORKTREE)).toBe(false)
  })

  it("AC-5: the worktree's own explicit value is independent of the parent repo's", async () => {
    await setUserProjectOrchestratorDefault(REPO, false)
    await setUserProjectOrchestratorDefault(WORKTREE, true)
    expect(await getUserProjectOrchestratorDefault(WORKTREE)).toBe(true)
    expect(await getUserProjectOrchestratorDefault(REPO)).toBe(false)
  })

  it('AC-5: turning the flag ON never retro-promotes — reading a sibling path stays OFF', async () => {
    await setUserProjectOrchestratorDefault(REPO, true)
    expect(await getUserProjectOrchestratorDefault('/repos/other')).toBe(false)
  })
})
