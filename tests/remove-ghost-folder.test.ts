import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * BUG-56 — `removeGhostFolder` is the single cleanup function (PRD D1/D2)
 * reused by Reaper's sidebar-detach step, manual `removeWorktree()`, and the
 * new `remove_folder` MCP verb. It ONLY proceeds when the directory is
 * confirmed absent from disk (D2's safety guardrail): unpins/unhides the
 * path in `projects.json` and emits `folders:removed` so the renderer drops
 * the folder and its sessions without a restart.
 */

const h = vi.hoisted(() => ({
  userDataDir: '',
  known: [] as { path: string; sessions: unknown[] }[]
}))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))
vi.mock('../src/main/claude-reader', () => ({
  scanFolders: async (): Promise<{ path: string; sessions: unknown[] }[]> => h.known
}))

import { addUserProject, hideUserProject, readUserProjects } from '../src/main/user-projects'
import { removeGhostFolder } from '../src/main/user-projects'

// A path that doesn't exist on disk anywhere on the test runner.
const GONE = '/nonexistent/BUG-56/ghost-folder'
// A real, existing path (the tmpdir itself) to exercise the DIRECTORY_STILL_EXISTS refusal.
let LIVE_DIR: string

describe('removeGhostFolder', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ghostfolder-'))
    LIVE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ghostfolder-live-'))
    h.known = []
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
    await fs.rm(LIVE_DIR, { recursive: true, force: true })
  })

  it('refuses a directory that still exists on disk, changes nothing', async () => {
    await addUserProject({ path: LIVE_DIR, alias: 'live', addedAt: '2026-01-01', worktrees: [] })
    const result = await removeGhostFolder(() => null, LIVE_DIR)
    expect(result).toEqual({ ok: false, error: 'DIRECTORY_STILL_EXISTS' })
    const file = await readUserProjects()
    expect(file.projects.some((p) => p.path === LIVE_DIR)).toBe(true)
  })

  it('refuses an unknown path — never pinned, never hidden, no known sessions', async () => {
    const result = await removeGhostFolder(() => null, GONE)
    expect(result).toEqual({ ok: false, error: 'FOLDER_UNKNOWN' })
  })

  it('unpins a previously-pinned gone path and reports it removed', async () => {
    await addUserProject({ path: GONE, alias: 'ghost', addedAt: '2026-01-01', worktrees: [] })
    const result = await removeGhostFolder(() => null, GONE)
    expect(result).toEqual({
      ok: true,
      removed: { path: GONE, unpinned: true, sessionsDropped: 0 }
    })
    const file = await readUserProjects()
    expect(file.projects.some((p) => p.path === GONE)).toBe(false)
  })

  it('unhides a previously-hidden gone path even when never pinned', async () => {
    await hideUserProject(GONE)
    const result = await removeGhostFolder(() => null, GONE)
    expect(result.ok).toBe(true)
    const file = await readUserProjects()
    expect(file.hiddenPaths ?? []).not.toContain(GONE)
  })

  it('recognizes a gone path as known via live session transcripts alone (never pinned)', async () => {
    h.known = [{ path: GONE, sessions: [{ id: '1' }, { id: '2' }] }]
    const result = await removeGhostFolder(() => null, GONE)
    expect(result).toEqual({
      ok: true,
      removed: { path: GONE, unpinned: false, sessionsDropped: 2 }
    })
  })

  it('emits folders:removed on the given window when the cleanup succeeds', async () => {
    await addUserProject({ path: GONE, alias: 'ghost', addedAt: '2026-01-01', worktrees: [] })
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    await removeGhostFolder(() => win as never, GONE)
    expect(send).toHaveBeenCalledWith('folders:removed', { path: GONE })
  })

  it('does NOT emit folders:removed when the call is refused', async () => {
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    await removeGhostFolder(() => win as never, GONE) // unknown, refused
    expect(send).not.toHaveBeenCalled()
  })

  it('is safe with no window available (getWindow returns null)', async () => {
    await addUserProject({ path: GONE, alias: 'ghost', addedAt: '2026-01-01', worktrees: [] })
    await expect(removeGhostFolder(() => null, GONE)).resolves.toMatchObject({ ok: true })
  })
})
