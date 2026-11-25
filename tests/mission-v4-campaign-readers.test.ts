/**
 * BUG-282 CC-2 — the readers (sidebar chip, Activity row) see an unconverted v3 campaign before any write.
 *
 * `readRepo` in the renderer store asks the view channel twice: once for the repo's list, then once per
 * listed row, BY THE ROW'S ID. The campaign is listed under the id its source ids hash to, which no file
 * carries, so the named read used to be refused and the mission was dropped: no chip, no Activity row.
 * This drives the same two calls through `buildMissionV4View` on a throwaway repo and checks that
 * nothing on disk changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { OWNER, writeCampaign13 } from './fixtures/missions-v4-campaign-13/build'

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

const noFacts = {
  findPrs: async () => ({ ghAvailable: true, worktrees: {}, branches: {}, numbers: {} }),
  findMainCi: async () => ({ ghAvailable: true, byNumber: {} }),
  lastKnown: () => null,
  pathExists: async () => true,
  taskState: () => undefined
}

/** Hash of every file under `dir`, so a read that wrote anything shows. */
async function hashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (sub: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, e.name)
      if (e.isDirectory()) await walk(rel)
      else
        out[rel] = createHash('sha256')
          .update(await fs.readFile(path.join(dir, rel)))
          .digest('hex')
    }
  }
  await walk('')
  return out
}

let root = ''
beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign13-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign13-readers-'))
  writeCampaign13(root)
  vi.resetModules()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

describe('the readers see a v3 campaign that was never converted', () => {
  it('lists it, reads the listed row by its id, and shows what it owes, writing nothing', async () => {
    const { buildMissionV4View } = await import('../src/main/mission-ipc')
    const before = await hashes(root)

    // First call of `readRepo`: no mission id, the list.
    const list = await buildMissionV4View(
      { folder: root, sessionId: 'harnu-readers' },
      { facts: () => noFacts }
    )
    expect(list.state).toBe('none')
    if (list.state !== 'none') return
    expect(list.missions).toHaveLength(1)

    // Second call: the row, by the id the list gave.
    const named = await buildMissionV4View(
      { folder: root, sessionId: 'harnu-readers', missionId: list.missions[0].id },
      { facts: () => noFacts }
    )
    expect(named.state).toBe('mission')
    if (named.state !== 'mission') return
    expect(named.detail.title).toBe('Migrate the Acme site')
    expect(named.detail.leads).toBe(OWNER)
    // An unticked check on a fixed end is an operator-owned blocker: the Activity row has something to say.
    expect(named.detail.waiting.items.length).toBeGreaterThan(0)

    expect(await hashes(root)).toEqual(before)
  })
})
