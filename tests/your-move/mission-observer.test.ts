/**
 * The seam the mission source hangs on: the list the renderer polls every 20 s is also handed to
 * one in-main observer, with the roots that were asked about. The observer can never change
 * the answer or break the poll.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '', channels: new Map<string, unknown>() }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: unknown): void => {
      h.channels.set(channel, fn)
    },
    on: (): void => {}
  }
}))
vi.mock('../../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

let ipc: typeof import('../../src/main/mission-ipc')
let folder: string
const list = (folders: unknown): Promise<{ views: unknown[] }> =>
  (h.channels.get('mission:list') as (e: unknown, f: unknown) => Promise<{ views: unknown[] }>)(
    null,
    folders
  )

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-observer-ud-'))
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-observer-'))
  ipc = await import('../../src/main/mission-ipc')
  ipc.registerMissionIpc()
})
afterEach(() => ipc.setMissionListObserver(null))

describe('setMissionListObserver', () => {
  it('receives the list result and the roots that were queried, once per poll', async () => {
    const seen: { result: unknown; roots: string[] }[] = []
    ipc.setMissionListObserver((result, roots) => seen.push({ result, roots }))
    const answer = await list([folder, folder])
    expect(seen).toHaveLength(1)
    expect(seen[0].result).toBe(answer)
    expect(seen[0].roots).toHaveLength(1)
    expect(path.basename(seen[0].roots[0])).toBe(path.basename(folder))
  })

  it('an observer that throws does not break the poll', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ipc.setMissionListObserver(() => {
      throw new Error('boom')
    })
    await expect(list([folder])).resolves.toMatchObject({ views: [] })
  })

  it('with no observer the poll answers as before', async () => {
    await expect(list([folder])).resolves.toMatchObject({ views: [] })
  })
})
