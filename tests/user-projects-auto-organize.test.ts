import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * T106 (D6) — `getUserProjectAutoOrganize`/`setUserProjectAutoOrganize`: the
 * per-repo "auto-organize conversation into draft cards" toggle. Default ON
 * when nothing is recorded; own value always wins; a canonical Harnu worktree
 * with no own value inherits its parent repo's. Real `projects.json`
 * round-trips against a throwaway userData dir, mirroring
 * `user-projects-alias.test.ts`'s harness.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  getUserProjectAutoOrganize,
  setUserProjectAutoOrganize,
  addUserProject
} from '../src/main/user-projects'

const REPO = '/repos/app'
const WORKTREE = '/repos/app/.claude/worktrees/wt'
const UNRELATED_FOLDER = '/repos/standalone'

describe('getUserProjectAutoOrganize / setUserProjectAutoOrganize (T106/D6)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-upautoorg-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('defaults to ON when no record exists at all', async () => {
    expect(await getUserProjectAutoOrganize(UNRELATED_FOLDER)).toBe(true)
  })

  it('creates a record carrying the explicit value for an auto-discovered folder', async () => {
    const file = await setUserProjectAutoOrganize(REPO, false)
    const rec = file.projects.find((p) => p.path === REPO)!
    expect(rec).toBeTruthy()
    expect(rec.autoOrganizeCards).toBe(false)
    expect(await getUserProjectAutoOrganize(REPO)).toBe(false)
  })

  it('flips the flag on an existing record, preserving other fields', async () => {
    await addUserProject({
      path: REPO,
      alias: 'app',
      addedAt: '2026-01-01',
      worktrees: [],
      gitBranch: 'main'
    })
    await setUserProjectAutoOrganize(REPO, false)
    const file = await setUserProjectAutoOrganize(REPO, true)
    const rec = file.projects.find((p) => p.path === REPO)!
    expect(rec.autoOrganizeCards).toBe(true)
    expect(rec.gitBranch).toBe('main') // untouched
  })

  it('is idempotent — no throw and the value holds when set to the same value', async () => {
    await setUserProjectAutoOrganize(REPO, false)
    const file = await setUserProjectAutoOrganize(REPO, false)
    expect(file.projects.find((p) => p.path === REPO)!.autoOrganizeCards).toBe(false)
  })

  it('a canonical worktree with no own value inherits its parent repo explicit value', async () => {
    await setUserProjectAutoOrganize(REPO, false)
    expect(await getUserProjectAutoOrganize(WORKTREE)).toBe(false)
  })

  it("the worktree's own explicit value wins over the inherited one", async () => {
    await setUserProjectAutoOrganize(REPO, false)
    await setUserProjectAutoOrganize(WORKTREE, true)
    expect(await getUserProjectAutoOrganize(WORKTREE)).toBe(true)
  })

  it('a canonical worktree with no record at all, and no parent record either, defaults to ON', async () => {
    expect(await getUserProjectAutoOrganize(WORKTREE)).toBe(true)
  })

  it('a non-canonical worktree-shaped path (no matching parent record) falls back to default ON', async () => {
    // Same shape but the parent repo itself was never toggled — nothing to inherit.
    expect(await getUserProjectAutoOrganize('/repos/other/.claude/worktrees/wt')).toBe(true)
  })
})
