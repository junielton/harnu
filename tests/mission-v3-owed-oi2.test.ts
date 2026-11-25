// @vitest-environment node
/**
 * BUG-283 · OI-2 (G3) — a delivered v3 chapter mission with a pending close request and unticked checks
 * keeps both: its checks stay open criteria, and its close request is raised.
 *
 * The conversion settled every criterion of a delivered chapter (the chapter reads done), which swallowed
 * an unticked check or an unproven human step the operator still owed, and the chapter mission's own close
 * request had no waiting item. A chapter the operator closed as delivered keeps the old rule: they ended it
 * knowing what was open. Read through the real view channel on a neutral campaign; reads write nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  CHAPTERS,
  CHAPTERS_DELIVERED_OWING,
  writeCampaign13
} from './fixtures/missions-v4-campaign-13/build'

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
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-oi2-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-oi2-'))
  vi.resetModules()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

async function detail(specs: typeof CHAPTERS): Promise<{
  waiting: { items: Array<{ kind: string; ask: string }> }
  milestones: Array<{ id: string; state: string }>
}> {
  writeCampaign13(root, specs)
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
  return named.detail as never
}

describe('a delivered chapter with a close request and checks still open', () => {
  it('keeps its unticked check and its unproven human step as items the operator owes', async () => {
    const d = await detail(CHAPTERS_DELIVERED_OWING)
    const settle = d.waiting.items.filter((i) => i.kind === 'settle').map((i) => i.ask)
    expect(settle).toContain('Mark done: Report figures re-read by finance')
    expect(settle).toContain('Mark done: Sign off the report wording')
  }, 60_000)

  it('raises the chapter close request, naming the chapter', async () => {
    const d = await detail(CHAPTERS_DELIVERED_OWING)
    const close = d.waiting.items.filter(
      (i) => i.kind === 'unblock' && /Chapter 2 · Report/.test(i.ask) && /close/i.test(i.ask)
    )
    expect(close).toHaveLength(1)
  }, 60_000)

  it('raises the close request even when nothing else is open on the chapter', async () => {
    const d = await detail(CHAPTERS)
    expect(
      d.waiting.items.some((i) => i.kind === 'unblock' && /Chapter 2 · Report/.test(i.ask))
    ).toBe(true)
  }, 60_000)
})

describe('a chapter the operator closed as delivered keeps the old rule', () => {
  it('chapter 1 owes nothing: closed as delivered settles every criterion, and raises no close request', async () => {
    const d = await detail(CHAPTERS_DELIVERED_OWING)
    expect(JSON.stringify(d.waiting.items)).not.toContain('Chapter 1')
    expect(d.milestones.find((m) => m.id === 'mls-1')?.state).toBe('done')
  }, 60_000)
})

describe('reading writes nothing', () => {
  it('no file under .harnu changes, none appears', async () => {
    writeCampaign13(root, CHAPTERS_DELIVERED_OWING)
    const before = await hashes(root)
    await detail(CHAPTERS_DELIVERED_OWING)
    expect(await hashes(root)).toEqual(before)
  }, 60_000)
})
