/**
 * Campaign ch.4b (T596, AC-4b.5) — `src/main/campaign-ipc.ts`: the renderer's read of open
 * campaigns over `campaign:list`, driven against a real temp repo. Mirrors
 * `mission-ipc.test.ts`. The campaign's `progress` is the server's
 * (`computeCampaignProgress`), rolled up from the chapters' missions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createCampaignFile, type Campaign } from '../src/main/campaign-core'
import { createMissionFile, type Mission } from '../src/main/mission-core'

const h = vi.hoisted(() => ({ userDataDir: '', handlers: new Map<string, unknown>() }))

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
      h.handlers.set(channel, fn)
    },
    on: (): void => {}
  }
}))

vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

const OWNER = '11111111-2222-4333-8444-555555555555'

function mission(id: string, over: Partial<Mission> = {}): Mission {
  return {
    id,
    slug: `m-${id.slice(4)}`,
    folder: '/repo',
    owner: { sessionId: OWNER, folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'a chapter shipped', evidence: 'merged PRs' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'Build Acme feed',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      },
      {
        id: 'stp-2',
        ordinal: 2,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' },
    ...over
  }
}

function campaign(id: string, over: Partial<Campaign> = {}): Campaign {
  return {
    id,
    slug: 'acme-migration',
    folder: '/repo',
    owner: { sessionId: OWNER, folder: '/repo' },
    title: 'Acme content migration',
    declaredEnd: { kind: 'code', target: 'all pages live', evidence: 'review sheets' },
    chapters: [
      { id: 'chp-1', ordinal: 1, title: 'Pipeline', required: true, missionId: 'mnt-00000001' },
      { id: 'chp-2', ordinal: 2, title: 'Test pages', required: true, missionId: 'mnt-00000002' },
      { id: 'chp-3', ordinal: 3, title: 'Home', required: true },
      { id: 'chp-4', ordinal: 4, title: 'Lighter images', required: false }
    ],
    status: 'active',
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' },
    ...over
  }
}

let root: string
let ipc: typeof import('../src/main/campaign-ipc')

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign-ipc-ud-'))
  h.handlers.clear()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-campaign-ipc-'))
  vi.resetModules()
  ipc = await import('../src/main/campaign-ipc')
})

describe('listCampaignViews', () => {
  it('returns each open campaign with the server-computed chapter progress', async () => {
    // Chapter 1's mission was delivered (closed as delivered, so it is not an open view);
    // chapter 2's mission is open and running nothing yet.
    await createMissionFile(
      root,
      mission('mnt-00000001', { status: 'closed', closedAs: 'delivered' })
    )
    await createMissionFile(root, mission('mnt-00000002'))
    await createCampaignFile(root, campaign('cmp-0000000a'), '# Acme content migration\n')

    const { views, unreadable } = await ipc.listCampaignViews([root])
    expect(unreadable).toEqual([])
    expect(views).toHaveLength(1)
    const v = views[0]
    expect(v.root).toBe(root)
    expect(v.campaign.id).toBe('cmp-0000000a')
    expect(v.title).toBe('Acme content migration')
    // Three required chapters (one done), one side chapter.
    expect(v.progress).toMatchObject({
      total: 3,
      done: 1,
      current: { from: 2, to: 2 },
      side: { total: 1, done: 0, open: 1 }
    })
    expect(v.progress.states).toMatchObject({ 'chp-1': 'done', 'chp-2': 'todo' })
  })

  it('leaves out a closed campaign and reports an unreadable file instead of throwing', async () => {
    await createCampaignFile(root, campaign('cmp-0000000b', { status: 'closed' }))
    await createCampaignFile(root, campaign('cmp-0000000c', { slug: 'second' }))
    await fs.writeFile(
      path.join(root, '.harnu', 'campaigns', 'cmp-0000000d-broken.md'),
      'not a campaign'
    )
    const { views, unreadable } = await ipc.listCampaignViews([root])
    expect(views.map((v) => v.campaign.id)).toEqual(['cmp-0000000c'])
    expect(unreadable).toEqual(['cmp-0000000d-broken.md'])
  })

  it('is empty for a repo with no campaign', async () => {
    expect(await ipc.listCampaignViews([root])).toEqual({ views: [], unreadable: [] })
    expect(await ipc.listCampaignViews([])).toEqual({ views: [], unreadable: [] })
  })

  it('registers the read-only campaign:list channel and no write channel', () => {
    ipc.registerCampaignIpc()
    expect([...h.handlers.keys()]).toEqual(['campaign:list'])
  })
})
