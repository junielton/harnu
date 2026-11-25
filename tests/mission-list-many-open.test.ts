// @vitest-environment node
/**
 * BUG-283 · OI-3 (G4), main side — the view channel lists, and reads by name, every open mission of a repo
 * however many there are (here 25 neutral v3 files through the real record store). The renderer's readers
 * ask for the list and then for each row; neither call may drop a row. Reading writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { manyOpenMissions } from './fixtures/missions-v4-owed-standalone/build'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

let root = ''
beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-many-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-many-'))
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  vi.resetModules()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

describe('a repo with 25 open missions', () => {
  it('lists all 25 and reads the last one by the id the list gave', async () => {
    const ids = manyOpenMissions(root, 25)
    const { buildMissionV4View } = await import('../src/main/mission-ipc')
    const list = await buildMissionV4View({ folder: root, sessionId: 'harnu-readers' })
    if (list.state !== 'none') throw new Error(JSON.stringify(list))
    expect(list.missions.map((m) => m.id).sort()).toEqual([...ids].sort())
    const last = await buildMissionV4View({
      folder: root,
      sessionId: 'harnu-readers',
      missionId: ids[24]
    })
    expect(last.state).toBe('mission')
    expect(await fs.readdir(path.join(root, '.harnu'))).toEqual(['missions'])
  }, 120_000)
})
