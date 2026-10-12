import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * AC-D2 (unit D, "no dead ends"): after a successful Harnu removal there is no ghost row left in
 * the sidebar. `removeGhostFolder` reconciles ONE exact path; a session started in a subfolder of
 * the removed worktree (`WT/api`) is its own path-keyed folder, so it used to survive the removal
 * as a pinned, hidden or transcript-known ghost. `removeGhostFoldersUnder` reconciles the root and
 * every gone folder inside it, and the executor's sidebar-detach step calls it.
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

import {
  addUserProject,
  hideUserProject,
  readUserProjects,
  removeGhostFoldersUnder
} from '../src/main/user-projects'

const ROOT = '/nonexistent/unit-d/org/proj/feat-a'

describe('removeGhostFoldersUnder', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ghosttree-'))
    h.known = []
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('drops the pinned root, a pinned subfolder, a hidden subfolder and a transcript-only subfolder', async () => {
    await addUserProject({ path: ROOT, alias: 'a', addedAt: '2026-01-01', worktrees: [] })
    await addUserProject({
      path: `${ROOT}/api`,
      alias: 'api',
      addedAt: '2026-01-01',
      worktrees: []
    })
    await hideUserProject(`${ROOT}/web`)
    h.known = [{ path: `${ROOT}/.claude/worktrees/x`, sessions: [{ id: '1' }] }]
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }

    const removed = await removeGhostFoldersUnder(() => win as never, ROOT)

    expect(removed.map((r) => r.path).sort()).toEqual(
      [ROOT, `${ROOT}/.claude/worktrees/x`, `${ROOT}/api`, `${ROOT}/web`].sort()
    )
    const file = await readUserProjects()
    expect(file.projects.map((p) => p.path)).toEqual([])
    expect(file.hiddenPaths ?? []).toEqual([])
    // The renderer is told about every one, so no row lingers until the next restart.
    const told = send.mock.calls.filter((c) => c[0] === 'folders:removed').map((c) => c[1].path)
    expect(told.sort()).toEqual([...removed.map((r) => r.path)].sort())
  })

  it('leaves a sibling whose name merely starts the same', async () => {
    await addUserProject({
      path: `${ROOT}-other`,
      alias: 'other',
      addedAt: '2026-01-01',
      worktrees: []
    })
    h.known = [{ path: `${ROOT}-other/api`, sessions: [{ id: '1' }] }]
    const removed = await removeGhostFoldersUnder(() => null, ROOT)
    expect(removed).toEqual([])
    expect((await readUserProjects()).projects.map((p) => p.path)).toEqual([`${ROOT}-other`])
  })

  it('never touches a subfolder that still exists on disk', async () => {
    const live = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ghosttree-live-'))
    try {
      await addUserProject({ path: live, alias: 'live', addedAt: '2026-01-01', worktrees: [] })
      // The "root" is the live folder's parent: it exists, so nothing under it is a ghost.
      const removed = await removeGhostFoldersUnder(() => null, path.dirname(live))
      expect(removed).toEqual([])
      expect((await readUserProjects()).projects.map((p) => p.path)).toContain(live)
    } finally {
      await fs.rm(live, { recursive: true, force: true })
    }
  })

  it('answers an empty list when nothing under the root is known', async () => {
    expect(await removeGhostFoldersUnder(() => null, ROOT)).toEqual([])
  })
})

describe('the sidebar-detach step reconciles the whole tree (wiring)', () => {
  const reaper = readFileSync(new URL('../src/main/reaper/reaper-ipc.ts', import.meta.url), 'utf8')
  it('detachSidebar calls removeGhostFoldersUnder, not the single-path function', () => {
    const start = reaper.indexOf('detachSidebar: async')
    expect(start).toBeGreaterThan(0)
    const body = reaper.slice(start, reaper.indexOf('},', start))
    expect(body).toMatch(/removeGhostFoldersUnder\(getWindow, p\)/)
    expect(body).not.toMatch(/removeGhostFolder\(/)
  })
})
