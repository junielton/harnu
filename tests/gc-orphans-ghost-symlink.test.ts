import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Delta-2 item 5: a worktree reached through a symlink keeps no subfolder ghost rows, whichever
 * spelling the pinned, hidden or transcript-known rows were stored under, and one reconcile reads
 * the folder list once, not once per candidate.
 */

const h = vi.hoisted(() => ({
  userData: '',
  known: [] as { path: string; sessions: unknown[] }[],
  scans: 0
}))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userData },
  ipcMain: { handle: (): void => {} }
}))
vi.mock('../src/main/claude-reader', () => ({
  scanFolders: async (): Promise<{ path: string; sessions: unknown[] }[]> => {
    h.scans++
    return h.known
  }
}))

import {
  addUserProject,
  hideUserProject,
  readUserProjects,
  removeGhostFoldersUnder
} from '../src/main/user-projects'

describe('reconciling a worktree reached through a symlink', () => {
  let root: string
  let real: string
  let link: string
  beforeEach(() => {
    h.userData = mkdtempSync(path.join(os.tmpdir(), 'harnu-ghostlink-ud-'))
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'harnu-ghostlink-')))
    real = path.join(root, 'real')
    link = path.join(root, 'link')
    mkdirSync(real)
    symlinkSync(real, link)
    h.known = []
    h.scans = 0
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(h.userData, { recursive: true, force: true })
  })

  const add = (p: string): Promise<unknown> =>
    addUserProject({ path: p, alias: 'x', addedAt: '2026-01-01', worktrees: [] })

  it('removed as given (through the link): rows stored under the real spelling go too', async () => {
    await add(path.join(real, 'wt', 'api'))
    await hideUserProject(path.join(real, 'wt', 'web'))
    h.known = [{ path: path.join(real, 'wt', 'tools'), sessions: [{ id: '1' }] }]
    const removed = await removeGhostFoldersUnder(() => null, path.join(link, 'wt'))
    expect(removed.map((r) => r.path).sort()).toEqual(
      ['api', 'tools', 'web'].map((n) => path.join(real, 'wt', n)).sort()
    )
    const file = await readUserProjects()
    expect(file.projects).toEqual([])
    expect(file.hiddenPaths ?? []).toEqual([])
  })

  it('removed by its real path: rows stored through the link go too', async () => {
    await add(path.join(link, 'wt', 'api'))
    await hideUserProject(path.join(link, 'wt', 'web'))
    const removed = await removeGhostFoldersUnder(() => null, path.join(real, 'wt'))
    expect(removed).toHaveLength(2)
    expect((await readUserProjects()).projects).toEqual([])
  })

  it('a sibling that merely shares the link prefix is left alone', async () => {
    await add(path.join(real, 'wt-other', 'api'))
    expect(await removeGhostFoldersUnder(() => null, path.join(link, 'wt'))).toEqual([])
    expect((await readUserProjects()).projects).toHaveLength(1)
  })

  it('reads the folder list once per reconcile, however many rows it drops', async () => {
    for (const n of ['a', 'b', 'c', 'd']) await add(path.join(real, 'wt', n))
    h.known = [{ path: path.join(real, 'wt', 'e'), sessions: [] }]
    h.scans = 0
    const removed = await removeGhostFoldersUnder(() => null, path.join(real, 'wt'))
    expect(removed).toHaveLength(5)
    expect(h.scans).toBe(1)
  })
})
