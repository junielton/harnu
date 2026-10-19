import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * BUG-197 (AC-4) — `getUserProjectWipLimit`/`setUserProjectWipLimit`: the per-repo
 * In Progress WIP ceiling. Default 5; bounded 1…10; a canonical Harnu worktree
 * shares its parent repo's value (the board is per repo). Real `projects.json`
 * round-trips against a throwaway userData dir, mirroring
 * `user-projects-auto-organize.test.ts`'s harness.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  getUserProjectWipLimit,
  setUserProjectWipLimit,
  addUserProject
} from '../src/main/user-projects'

const REPO = '/repos/app'
const WORKTREE = '/repos/app/.claude/worktrees/wt'

describe('getUserProjectWipLimit / setUserProjectWipLimit (BUG-197)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-upwip-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('defaults to 5 when nothing is recorded', async () => {
    expect(await getUserProjectWipLimit('/repos/standalone')).toBe(5)
  })

  it('creates a record for an auto-discovered folder and reads it back', async () => {
    const file = await setUserProjectWipLimit(REPO, 3)
    expect(file.projects.find((p) => p.path === REPO)?.wipLimit).toBe(3)
    expect(await getUserProjectWipLimit(REPO)).toBe(3)
  })

  it('clamps a write to the 1…10 range', async () => {
    await setUserProjectWipLimit(REPO, 99)
    expect(await getUserProjectWipLimit(REPO)).toBe(10)
    await setUserProjectWipLimit(REPO, 0)
    expect(await getUserProjectWipLimit(REPO)).toBe(1)
  })

  it('clamps a hand-edited out-of-range value on read', async () => {
    await addUserProject({
      path: REPO,
      alias: 'app',
      addedAt: '2026-01-01',
      worktrees: [],
      wipLimit: 400
    })
    expect(await getUserProjectWipLimit(REPO)).toBe(10)
  })

  it('preserves the other fields of an existing record', async () => {
    await addUserProject({
      path: REPO,
      alias: 'app',
      addedAt: '2026-01-01',
      worktrees: [],
      gitBranch: 'main'
    })
    const file = await setUserProjectWipLimit(REPO, 7)
    const rec = file.projects.find((p) => p.path === REPO)!
    expect(rec.wipLimit).toBe(7)
    expect(rec.gitBranch).toBe('main')
  })

  it('a canonical worktree reads its parent repo value', async () => {
    await setUserProjectWipLimit(REPO, 8)
    expect(await getUserProjectWipLimit(WORKTREE)).toBe(8)
  })

  it('setting from a canonical worktree writes the PARENT repo (one board, one limit)', async () => {
    const file = await setUserProjectWipLimit(WORKTREE, 2)
    expect(file.projects.find((p) => p.path === REPO)?.wipLimit).toBe(2)
    expect(file.projects.find((p) => p.path === WORKTREE)?.wipLimit).toBeUndefined()
    expect(await getUserProjectWipLimit(REPO)).toBe(2)
  })
})
