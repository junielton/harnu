/**
 * Campaign ch.6 part 2 (T610, AC-6.2) — "Also record" writes ONLY the memory drafts the operator ticked,
 * through the same `appendMemoryEntry` path `memory_append` uses (so the supersede chain stays intact). The
 * caller sends draft ids, never text: the entry is read from the stored draft. Real fs, no mocks of the
 * writer.
 *
 * Missions v4 S-40: the v3 end door that called this (`runOperatorDoor('end')`) is gone, so the cases run on
 * the writer itself, `recordMemoryDrafts`: which drafts it writes, how a refused one is reported, and that
 * an id naming no stored draft is found before anything is written. What closing a mission does is the v4
 * doors' business (`mission-doors-v4.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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

const ID = 'mnt-4ba02726'
const AT = '2026-11-02T15:00:00.000Z'
const NOW = Date.parse(AT)

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

let root: string
let memoryDir: string
let record: typeof import('../src/main/mission-record')
let store: typeof import('../src/main/mcp/memory-store')

const decisions = async (): Promise<string> => {
  try {
    return await fs.readFile(path.join(memoryDir, 'decisions.md'), 'utf8')
  } catch {
    return ''
  }
}
const write = (
  drafts: MemoryDraft[],
  ids: string[]
): ReturnType<typeof record.recordMemoryDrafts> => record.recordMemoryDrafts(root, drafts, ids, NOW)

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-end-record-ud-'))
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-end-record-'))
  vi.resetModules()
  record = await import('../src/main/mission-record')
  store = await import('../src/main/mcp/memory-store')
  memoryDir = (await store.resolveMemoryLocation(root)).memoryDir
})

describe('Also record writes only the ticked drafts (AC-6.2)', () => {
  it('a ticked draft is written, an unticked one is not', async () => {
    const res = await write(
      [
        draft({ id: 'drf-1', entry: '## Wake the steward on events' }),
        draft({ id: 'drf-2', entry: '## Poll every minute' })
      ],
      ['drf-1']
    )
    expect(res).toEqual({ written: ['drf-1'], failed: [] })
    const text = await decisions()
    expect(text).toContain('Wake the steward on events')
    expect(text).not.toContain('Poll every minute')
  })

  it('stamps the mission, valid_from and watches, and the operator as the author', async () => {
    await write(
      [draft({ id: 'drf-1', entry: '## Keep it', watches: ['src/main/scheduler-core.ts'] })],
      ['drf-1']
    )
    const text = await decisions()
    expect(text).toContain('mission=mnt-4ba02726')
    expect(text).toContain('watches=src/main/scheduler-core.ts')
    expect(text).toContain('human')
  })

  it('no ticks, no memory: nothing is written', async () => {
    expect(await write([draft({ id: 'drf-1', entry: '## Not ticked' })], [])).toEqual({
      written: [],
      failed: []
    })
    expect(await decisions()).not.toContain('Not ticked')
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
    const res = await write(
      [draft({ id: 'drf-1', entry: '## Wake on events, 20m fallback', supersedes: first.entryId })],
      ['drf-1']
    )
    expect(res).toEqual({ written: ['drf-1'], failed: [] })
    const text = await decisions()
    expect(text).toContain(`supersedes=${first.entryId}`)
    expect(text).toMatch(new RegExp(`superseded_by=e-[0-9a-f]{8}`))
    const { matches } = await store.queryMemory(memoryDir, 'poll every minute')
    expect(matches[0]).toMatchObject({ supersededBy: { text: 'Wake on events, 20m fallback' } })
  })

  it('a hot draft replaces hot.md', async () => {
    await write(
      [draft({ id: 'drf-1', kind: 'hot', page: 'hot', entry: '**Now:** campaign closed' })],
      ['drf-1']
    )
    const hot = await fs.readFile(path.join(memoryDir, 'hot.md'), 'utf8')
    expect(hot).toContain('campaign closed')
  })

  it('a draft that fails is reported, and the others are still written', async () => {
    const res = await write(
      [
        draft({ id: 'drf-1', entry: '## Good one' }),
        draft({ id: 'drf-2', entry: '## Replaces nothing', supersedes: 'e-deadbeef' })
      ],
      ['drf-1', 'drf-2']
    )
    expect(res).toMatchObject({
      written: ['drf-1'],
      failed: [{ id: 'drf-2', error: expect.stringMatching(/SUPERSEDES_NOT_FOUND/) }]
    })
    expect(await decisions()).toContain('Good one')
    expect(await decisions()).not.toContain('Replaces nothing')
  })

  it('names an id that is not a stored draft, so a caller can refuse before writing anything', () => {
    const drafts = [draft({ id: 'drf-1', entry: '## Real' })]
    expect(record.unknownDraftIds(drafts, ['drf-1', 'drf-ghost', 'drf-ghost'])).toEqual([
      'drf-ghost'
    ])
    expect(record.unknownDraftIds(drafts, ['drf-1'])).toEqual([])
    expect(record.unknownDraftIds(undefined, ['drf-1'])).toEqual(['drf-1'])
  })

  it('writes each ticked draft once even when an id repeats', async () => {
    await write([draft({ id: 'drf-1', entry: '## Once only' })], ['drf-1', 'drf-1'])
    expect((await decisions()).match(/Once only/g)).toHaveLength(1)
  })
})
