// @vitest-environment node
/**
 * BUG-283 · OI-4 (G2) — a chapter that waits on two or more chapters shows its "Waits for" row, naming them,
 * on a campaign read from v3 files through the real view channel (the conversion joins the producers' ids
 * with `, `; the pane used to look the whole string up as one id and drew nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CHAPTERS_TWO_PRODUCERS, writeCampaign13 } from './fixtures/missions-v4-campaign-13/build'
import { buildPaneTree } from '../src/renderer/src/lib/mission-pane-view'

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

let root = ''
beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-oi4-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-oi4-'))
  vi.resetModules()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

describe('a campaign chapter that waits on two chapters', () => {
  it('carries both ids in the view and names both in the pane tree', async () => {
    writeCampaign13(root, CHAPTERS_TWO_PRODUCERS)
    const { buildMissionV4View } = await import('../src/main/mission-ipc')
    const list = await buildMissionV4View(
      { folder: root, sessionId: 'harnu-readers' },
      { facts: () => noFacts }
    )
    if (list.state !== 'none') throw new Error(JSON.stringify(list))
    const named = await buildMissionV4View(
      { folder: root, sessionId: 'harnu-readers', missionId: list.missions[0].id },
      { facts: () => noFacts }
    )
    if (named.state !== 'mission') throw new Error(JSON.stringify(named))
    const detail = named.detail
    expect(detail.milestones.find((m) => m.id === 'mls-4')?.waitsFor).toBe('mls-1, mls-2')

    const tree = buildPaneTree(detail as never)
    const row = tree.milestones.find((m) => m.id === 'mls-4')
    expect(row?.waitsFor).toEqual({ id: 'mls-1', title: 'Import core' })
    expect(row?.waitsForMore).toEqual([{ id: 'mls-2', title: 'Report' }])
  }, 60_000)
})
