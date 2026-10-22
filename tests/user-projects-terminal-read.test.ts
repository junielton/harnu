import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * T481 (AC-B4-5) — `getUserProjectTerminalRead` / `setUserProjectTerminalRead`: the per-folder
 * "let agents read terminals I open" opt-in. Default OFF, EXACT-PATH ONLY (a linked worktree of
 * an opted-in repo does not inherit it), persisted in a real `projects.json`. Mirrors
 * `user-projects-orchestrator-default.test.ts`.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  addUserProject,
  getUserProjectTerminalRead,
  readUserProjects,
  setUserProjectTerminalRead,
  terminalReadOptIns
} from '../src/main/user-projects'

const REPO = '/repos/app'
const WORKTREE = '/repos/app/.claude/worktrees/wt'

describe('getUserProjectTerminalRead / setUserProjectTerminalRead (T481)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-upterminalread-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('defaults to OFF when nothing is recorded', async () => {
    expect(await getUserProjectTerminalRead('/repos/standalone')).toBe(false)
  })

  it('creates a record for an auto-discovered folder, and it survives a re-read', async () => {
    const file = await setUserProjectTerminalRead(REPO, true)
    expect(file.projects.find((p) => p.path === REPO)!.agentTerminalRead).toBe(true)
    expect(await getUserProjectTerminalRead(REPO)).toBe(true)
    expect(
      (await readUserProjects()).projects.find((p) => p.path === REPO)!.agentTerminalRead
    ).toBe(true)
  })

  it('flips the flag on an existing record, preserving other fields', async () => {
    await addUserProject({
      path: REPO,
      alias: 'app',
      addedAt: '2026-01-01',
      worktrees: [],
      gitBranch: 'main'
    })
    await setUserProjectTerminalRead(REPO, true)
    const file = await setUserProjectTerminalRead(REPO, false)
    const rec = file.projects.find((p) => p.path === REPO)!
    expect(rec.agentTerminalRead).toBe(false)
    expect(rec.gitBranch).toBe('main')
  })

  it('is independent of the other per-folder flags', async () => {
    await setUserProjectTerminalRead(REPO, true)
    const rec = (await readUserProjects()).projects.find((p) => p.path === REPO)!
    expect(rec.agentDenied).toBeUndefined()
    expect(rec.orchestratorDefault).toBeUndefined()
  })

  it('AC-B4-5: a linked worktree does NOT inherit its parent repo opt-in', async () => {
    await setUserProjectTerminalRead(REPO, true)
    expect(await getUserProjectTerminalRead(WORKTREE)).toBe(false)
    const file = await readUserProjects()
    expect([...(await terminalReadOptIns(file, [REPO, WORKTREE]))]).toEqual([REPO])
  })

  it("AC-B4-5: the worktree's own value is independent of the repo's", async () => {
    await setUserProjectTerminalRead(REPO, false)
    await setUserProjectTerminalRead(WORKTREE, true)
    expect(await getUserProjectTerminalRead(WORKTREE)).toBe(true)
    expect(await getUserProjectTerminalRead(REPO)).toBe(false)
  })

  it('terminalReadOptIns matches a differently spelled path to its record', async () => {
    await setUserProjectTerminalRead(REPO, true)
    const file = await readUserProjects()
    expect((await terminalReadOptIns(file, ['/repos/app/'])).has('/repos/app/')).toBe(true)
  })
})
