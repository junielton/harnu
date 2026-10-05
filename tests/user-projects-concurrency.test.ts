import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * BUG-41 — concurrent mutators on `user-projects.ts` must not clobber each
 * other's read-modify-write. Real `projects.json` round-trips against a
 * throwaway userData dir; `electron.app.getPath` is mocked to point at it.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import { addUserProject, setUserProjectAlias, readUserProjects } from '../src/main/user-projects'

const A = '/repos/app-a'
const B = '/repos/app-b'

describe('user-projects concurrency (BUG-41)', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-upconcurrency-'))
  })
  afterEach(async () => {
    await fs.rm(h.userDataDir, { recursive: true, force: true })
  })

  it('concurrent addUserProject calls do not lose entries', async () => {
    await Promise.all([
      addUserProject({ path: A, alias: 'A', addedAt: '2026-01-01', worktrees: [] }),
      addUserProject({ path: B, alias: 'B', addedAt: '2026-01-01', worktrees: [] })
    ])
    const file = await readUserProjects()
    expect(file.projects.map((p) => p.path)).toEqual(expect.arrayContaining([A, B]))
  })

  it('a mutator racing a different mutator preserves both effects', async () => {
    await addUserProject({ path: A, alias: 'A', addedAt: '2026-01-01', worktrees: [] })
    await Promise.all([
      addUserProject({ path: B, alias: 'B', addedAt: '2026-01-01', worktrees: [] }),
      setUserProjectAlias(A, 'Renamed A')
    ])
    const file = await readUserProjects()
    expect(file.projects.map((p) => p.path)).toEqual(expect.arrayContaining([A, B]))
    expect(file.projects.find((p) => p.path === A)!.alias).toBe('Renamed A')
  })

  it('a rejected mutator does not stall the queue for subsequent callers', async () => {
    const badPath = '/repos/will-fail'

    // Make writeUserProjects fail by pre-creating projects.json as a
    // directory, so fs.rename(tmp, projects.json) rejects with EISDIR/ENOTEMPTY.
    const finalPath = path.join(h.userDataDir, 'projects.json')
    await fs.mkdir(finalPath, { recursive: true })

    await expect(
      addUserProject({ path: badPath, alias: 'bad', addedAt: '2026-01-01', worktrees: [] })
    ).rejects.toThrow()

    // Clean up the directory blocking the file so the next mutator can succeed.
    await fs.rm(finalPath, { recursive: true, force: true })

    await expect(
      addUserProject({ path: A, alias: 'A', addedAt: '2026-01-01', worktrees: [] })
    ).resolves.toBeTruthy()

    const file = await readUserProjects()
    expect(file.projects.map((p) => p.path)).toEqual([A])
  })
})
