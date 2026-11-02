/**
 * Campaign ch.6 part 2 (T610, AC-6.2) — the end door writes ONLY the memory drafts the
 * operator ticked, through the same `appendMemoryEntry` path `memory_append` uses (so the
 * supersede chain stays intact). The renderer sends draft ids, never text: the entry is
 * read from the mission record. Discard writes nothing. Real fs, no mocks of the writer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createMissionFile,
  missionsDir,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../src/main/mission-core'
import type { MemoryDraft } from '../src/main/consolidator-core'

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

const OWNER = '11111111-2222-4333-8444-555555555555'
const ID = 'mnt-4ba02726'
const AT = '2026-11-02T15:00:00.000Z'
const now = (): string => AT

function draft(over: Partial<MemoryDraft> & Pick<MemoryDraft, 'id'>): MemoryDraft {
  return {
    kind: 'decision',
    page: 'decisions',
    entry: `## Decision ${over.id}\n\nWhy: because.`,
    cites: [{ kind: 'step', ref: 'stp-2' }],
    mission: ID,
    validFrom: '2026-11-02',
    ...over
  }
}

function mission(drafts: MemoryDraft[], over: Partial<Mission> = {}): Mission {
  return {
    id: ID,
    slug: 'close-out',
    folder: '/repo',
    owner: { sessionId: OWNER, folder: '/repo' },
    status: 'delivered',
    declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
    steps: [
      {
        id: 'stp-2',
        ordinal: 1,
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
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-11-02T10:00:00.000Z' },
    memoryDrafts: drafts,
    ...over
  }
}

async function onDisk(root: string): Promise<{ m: Mission; log: string }> {
  const name = (await fs.readdir(missionsDir(root))).find((n) => n.startsWith(`${ID}-`))!
  const raw = await fs.readFile(path.join(missionsDir(root), name), 'utf8')
  return { m: parseMissionFile(raw) as Mission, log: readMissionLog(raw) }
}

let root: string
let memoryDir: string
let ipc: typeof import('../src/main/mission-ipc')
let store: typeof import('../src/main/mcp/memory-store')

const decisions = async (): Promise<string> => {
  try {
    return await fs.readFile(path.join(memoryDir, 'decisions.md'), 'utf8')
  } catch {
    return ''
  }
}
const end = (extra: Record<string, unknown> = {}): ReturnType<typeof ipc.runOperatorDoor> =>
  ipc.runOperatorDoor({ door: 'end', root, missionId: ID, closedAs: 'delivered', ...extra }, now)

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-end-record-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-end-record-'))
  vi.resetModules()
  ipc = await import('../src/main/mission-ipc')
  store = await import('../src/main/mcp/memory-store')
  memoryDir = (await store.resolveMemoryLocation(root)).memoryDir
})

describe('Close as delivered writes only the ticked drafts (AC-6.2)', () => {
  it('a ticked draft is written, an unticked one is not', async () => {
    await createMissionFile(
      root,
      mission([
        draft({ id: 'drf-1', entry: '## Wake the steward on events' }),
        draft({ id: 'drf-2', entry: '## Poll every minute' })
      ]),
      '# Close out\n\n## Log\n'
    )
    const res = await end({ record: ['drf-1'] })
    expect(res).toMatchObject({
      ok: true,
      view: null,
      recorded: { written: ['drf-1'], failed: [] }
    })
    const text = await decisions()
    expect(text).toContain('Wake the steward on events')
    expect(text).not.toContain('Poll every minute')
  })

  it('stamps the mission, valid_from and watches, and the operator as the author', async () => {
    await createMissionFile(
      root,
      mission([draft({ id: 'drf-1', entry: '## Keep it', watches: ['src/main/steward-core.ts'] })])
    )
    await end({ record: ['drf-1'] })
    const text = await decisions()
    expect(text).toContain('mission=mnt-4ba02726')
    expect(text).toContain('watches=src/main/steward-core.ts')
    expect(text).toContain('human')
  })

  it('no ticks, no memory: nothing is written and the mission still closes', async () => {
    await createMissionFile(root, mission([draft({ id: 'drf-1', entry: '## Not ticked' })]))
    expect(await end()).toMatchObject({ ok: true, view: null })
    expect(await decisions()).not.toContain('Not ticked')
    expect((await onDisk(root)).m).toMatchObject({ status: 'closed', closedAs: 'delivered' })
  })

  it('a supersede draft marks its predecessor, exactly as memory_append does', async () => {
    const first = await store.appendMemoryEntry({
      memoryDir,
      page: 'decisions',
      entry: '## Poll every minute',
      author: 'agent',
      now: Date.parse('2026-11-01T10:00:00Z')
    })
    if (!first.ok || !first.entryId) throw new Error('setup')
    await createMissionFile(
      root,
      mission([
        draft({ id: 'drf-1', entry: '## Wake on events, 20m fallback', supersedes: first.entryId })
      ])
    )
    const res = await end({ record: ['drf-1'] })
    expect(res).toMatchObject({ ok: true, recorded: { written: ['drf-1'], failed: [] } })
    const text = await decisions()
    expect(text).toContain(`supersedes=${first.entryId}`)
    expect(text).toMatch(new RegExp(`superseded_by=e-[0-9a-f]{8}`))
    const { matches } = await store.queryMemory(memoryDir, 'poll every minute')
    expect(matches[0]).toMatchObject({ supersededBy: { text: 'Wake on events, 20m fallback' } })
  })

  it('a hot draft replaces hot.md', async () => {
    await createMissionFile(
      root,
      mission([draft({ id: 'drf-1', kind: 'hot', page: 'hot', entry: '**Now:** campaign closed' })])
    )
    await end({ record: ['drf-1'] })
    const hot = await fs.readFile(path.join(memoryDir, 'hot.md'), 'utf8')
    expect(hot).toContain('campaign closed')
  })

  it('a draft that fails is reported and logged, never blocks the close, stays on the record', async () => {
    await createMissionFile(
      root,
      mission([
        draft({ id: 'drf-1', entry: '## Good one' }),
        draft({ id: 'drf-2', entry: '## Replaces nothing', supersedes: 'e-deadbeef' })
      ]),
      '# T\n\n## Log\n'
    )
    const res = await end({ record: ['drf-1', 'drf-2'] })
    expect(res).toMatchObject({
      ok: true,
      view: null,
      recorded: {
        written: ['drf-1'],
        failed: [{ id: 'drf-2', error: expect.stringMatching(/SUPERSEDES_NOT_FOUND/) }]
      }
    })
    const { m, log } = await onDisk(root)
    expect(m.status).toBe('closed')
    expect(m.memoryDrafts?.map((d) => d.id)).toEqual(['drf-1', 'drf-2'])
    expect(log).toContain('recorded to memory: drf-1')
    expect(log).toContain('drf-2')
  })

  it('refuses an id that is not a stored draft, before anything is written or closed', async () => {
    await createMissionFile(root, mission([draft({ id: 'drf-1', entry: '## Real' })]))
    const res = await end({ record: ['drf-1', 'drf-ghost'] })
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^UNKNOWN_DRAFT.*drf-ghost/) })
    expect(await decisions()).not.toContain('Real')
    expect((await onDisk(root)).m.status).toBe('delivered')
  })

  it('writes each ticked draft once even when an id repeats', async () => {
    await createMissionFile(root, mission([draft({ id: 'drf-1', entry: '## Once only' })]))
    await end({ record: ['drf-1', 'drf-1'] })
    expect((await decisions()).match(/Once only/g)).toHaveLength(1)
  })

  it('rejects a non-array or non-string record before touching the mission', async () => {
    await createMissionFile(root, mission([draft({ id: 'drf-1' })]))
    expect(await end({ record: 'drf-1' })).toEqual({
      ok: false,
      error: expect.stringMatching(/^BAD_ARGS/)
    })
    expect(await end({ record: [1] })).toEqual({
      ok: false,
      error: expect.stringMatching(/^BAD_ARGS/)
    })
    expect((await onDisk(root)).m.status).toBe('delivered')
  })
})

describe('Discard writes nothing (AC-6.2)', () => {
  it('ignores a record list entirely', async () => {
    await createMissionFile(root, mission([draft({ id: 'drf-1', entry: '## Should not land' })]))
    const res = await end({ closedAs: 'discarded', record: ['drf-1'] })
    expect(res).toEqual({ ok: true, view: null })
    expect(await decisions()).not.toContain('Should not land')
    expect((await onDisk(root)).m.closedAs).toBe('discarded')
  })
})
