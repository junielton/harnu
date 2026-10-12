import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Delta-1 item 1 (AC-D2): BOTH ways of removing a worktree reconcile the sidebar rows of every
 * gone folder under it: Cleanup's engine (the executor's sidebar-detach step) and the sidebar's own
 * Remove (`worktree:remove`, `removeWorktree`). Behavioural: a real repo and worktree, real
 * pinned/hidden entries on disk, real removal; only the electron window is faked.
 */

const h = vi.hoisted(() => ({
  userData: '',
  known: [] as { path: string; sessions: unknown[] }[],
  sent: [] as Array<{ channel: string; payload: { path: string } }>
}))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userData, isPackaged: false },
  ipcMain: { handle: (): void => {}, on: (): void => {} },
  shell: { trashItem: async (): Promise<void> => undefined }
}))
vi.mock('../src/main/claude-reader', () => ({
  scanFolders: async (): Promise<{ path: string; sessions: unknown[] }[]> => h.known
}))

import { addUserProject, hideUserProject, readUserProjects } from '../src/main/user-projects'
import { removeWorktree, registerWorktreeHandlers } from '../src/main/worktree-ipc'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

describe('removing a worktree leaves no ghost row under it', () => {
  let root: string
  let repo: string
  let wt: string

  beforeEach(async () => {
    h.userData = mkdtempSync(path.join(os.tmpdir(), 'harnu-ghost2-ud-'))
    h.known = []
    h.sent = []
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-ghost2-'))
    repo = path.join(root, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git(repo, 'config', 'user.email', 'a@b.c')
    git(repo, 'config', 'user.name', 'T')
    writeFileSync(path.join(repo, 'f.txt'), '1')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    wt = path.join(root, 'repo-wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt)
    mkdirSync(path.join(wt, 'api'))
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: { path: string }) => h.sent.push({ channel, payload })
      }
    }
    registerWorktreeHandlers(() => win as never)
    await addUserProject({ path: wt, alias: 'wt', addedAt: '2026-01-01', worktrees: [] })
    await addUserProject({
      path: path.join(wt, 'api'),
      alias: 'api',
      addedAt: '2026-01-01',
      worktrees: []
    })
    await hideUserProject(path.join(wt, 'web'))
    h.known = [{ path: path.join(wt, '.claude', 'worktrees', 'x'), sessions: [{ id: '1' }] }]
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('the sidebar Remove (worktree:remove) drops the subfolder rows too', async () => {
    await removeWorktree(repo, wt, true, false)
    const file = await readUserProjects()
    expect(file.projects.map((p) => p.path)).toEqual([])
    expect(file.hiddenPaths ?? []).toEqual([])
    const told = h.sent.filter((s) => s.channel === 'folders:removed').map((s) => s.payload.path)
    expect(told.sort()).toEqual(
      [
        wt,
        path.join(wt, 'api'),
        path.join(wt, 'web'),
        path.join(wt, '.claude', 'worktrees', 'x')
      ].sort()
    )
  })

  it('the engine path (the executor’s detach step) does the same', async () => {
    const { detachFromSidebar } = await import('../src/main/user-projects')
    git(repo, 'worktree', 'remove', '--force', wt)
    await detachFromSidebar(
      () =>
        ({
          isDestroyed: () => false,
          webContents: {
            send: (channel: string, payload: { path: string }) => h.sent.push({ channel, payload })
          }
        }) as never,
      wt
    )
    expect((await readUserProjects()).projects.map((p) => p.path)).toEqual([])
    expect(h.sent.filter((s) => s.channel === 'folders:removed')).toHaveLength(4)
  })
})
