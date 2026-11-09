/**
 * Memory U2 S-1 (spec docs/specs/2026-11-04-memory-u2-read-handoff/spec.md, F-1 and F-2): the
 * tiered `memory_read`. Driven through the REAL wired handler against a memory tree on disk, so
 * the answer is exactly what an agent receives.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const h = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userData,
    getAppPath: (): string => process.cwd()
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import {
  LARGE,
  SMALL,
  HOT_SMALL,
  digestName,
  writeMemoryTree,
  type FixtureShape
} from './fixtures/memory-read/fixture'

/** D-1: the byte cap of a `memory_read` answer, pinned here as the literal the spec fixes. */
const MEMORY_READ_MAX_BYTES = 16_384

const handler = WIRED_TOOLS.find((t) => t.op === 'memory_read')!.handler!

let root: string
const folders: Record<string, string> = {}

async function makeFolder(name: string, shape: FixtureShape, hot?: string): Promise<string> {
  const folder = path.join(root, name)
  await writeMemoryTree(path.join(folder, '.harnu', 'memory'), shape, hot)
  return folder
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-read-tiers-'))
  h.userData = path.join(root, 'userData')
  await fs.mkdir(h.userData, { recursive: true })
  folders.small = await makeFolder('small', SMALL)
  folders.large = await makeFolder('large', LARGE)
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function read(
  folder: string,
  extra: Record<string, unknown> = {}
): Promise<{ text: string; json: Record<string, any> }> {
  const res: CallToolResult = await handler({ folder, ...extra }, {
    folder,
    folders: [],
    denyFolders: [],
    bridge: undefined
  } as never)
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return { text: first.text, json: JSON.parse(first.text) }
}

describe('memory_read tiers (U2 S-1)', () => {
  it('default read returns hot, active cards and counts only', async () => {
    const { text, json } = await read(folders.small)
    expect(json.ok).toBe(true)
    const m = json.memory
    expect(Object.keys(m).sort()).toEqual(['bytes', 'cards', 'counts', 'hot', 'more', 'truncated'])
    expect(Object.keys(m.cards).sort()).toEqual(['inProgress', 'ready'])
    // No index body and no page-id list anywhere in the answer.
    expect(text).not.toContain('"index"')
    expect(text).not.toContain('"pages"')
    expect(m.hot).toContain('Ship S-1')
    expect(m.hot).not.toContain('provenance')
    expect(m.cards.inProgress.map((c: { id: string }) => c.id)).toEqual(['T0001', 'T0002'])
    expect(m.cards.inProgress[0]).toMatchObject({
      id: 'T0001',
      page: expect.stringMatching(/^roadmap\/T0001-/),
      executedIn: expect.stringMatching(/^card\/T0001-/)
    })
    expect(m.cards.ready.map((c: { id: string }) => c.id)).toEqual(['T0003', 'T0004'])
    expect(m.counts).toEqual({
      cards: { 'in-progress': 2, ready: 2, backlog: 1, done: 1 },
      sessions: 5,
      decisions: 2,
      archive: 0,
      learning: 0
    })
    expect(Object.keys(m.more).sort()).toEqual(['cards', 'page', 'sessions'])
    expect(m.truncated).toBe(false)
    expect(m.bytes).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('default read stays under the byte cap and says what it dropped', async () => {
    const { text, json } = await read(folders.large)
    const m = json.memory
    const bytes = Buffer.byteLength(text, 'utf8')
    expect(bytes).toBeLessThanOrEqual(MEMORY_READ_MAX_BYTES)
    expect(m.bytes).toBe(bytes)
    expect(m.truncated).toBe(true)
    const shown = m.cards.inProgress.length + m.cards.ready.length
    expect(m.cardsOmitted).toBe(LARGE.inProgress + LARGE.ready - shown)
    expect(m.cardsOmitted).toBeGreaterThan(0)
    // Rows leave from the end of `ready` first, then `inProgress`.
    if (m.cards.inProgress.length < Math.min(40, LARGE.inProgress)) {
      expect(m.cards.ready).toHaveLength(0)
    }
    expect(m.cards.ready.length).toBeLessThan(40)
    // `counts` and `more` always survive.
    expect(m.counts.cards['in-progress']).toBe(LARGE.inProgress)
    expect(m.counts.cards.ready).toBe(LARGE.ready)
    expect(m.counts.sessions).toBe(LARGE.digests)
    expect(Object.keys(m.more).sort()).toEqual(['cards', 'page', 'sessions'])
  })

  it('cards view paginates every card once', async () => {
    const walk = async (
      extra: Record<string, unknown>
    ): Promise<{ ids: string[]; pages: number; first: Record<string, any> }> => {
      const ids: string[] = []
      let cursor: string | null | undefined
      let pages = 0
      let first: Record<string, any> = {}
      do {
        const { text, json } = await read(folders.large, {
          page: 'cards',
          ...extra,
          ...(cursor ? { cursor } : {})
        })
        expect(json.ok).toBe(true)
        expect(json.page).toBe('cards')
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MEMORY_READ_MAX_BYTES)
        if (pages === 0) first = json
        for (const item of json.items) {
          expect(Object.keys(item)).toEqual(
            expect.arrayContaining(['id', 'title', 'status', 'page'])
          )
          ids.push(item.id)
        }
        cursor = json.nextCursor
        pages++
        expect(pages).toBeLessThan(500)
      } while (cursor)
      return { ids, pages, first }
    }

    const all = await walk({})
    expect(all.first.total).toBe(LARGE.cards)
    expect(all.first.items.length).toBeLessThanOrEqual(50)
    expect(new Set(all.ids).size).toBe(LARGE.cards)
    expect(all.ids).toHaveLength(LARGE.cards)
    // Status order: ready first, then in-progress.
    expect(all.first.items[0].status).toBe('ready')

    // Even at the maximum limit every card comes back exactly once (pages end early on the cap).
    const big = await walk({ limit: 200 })
    expect(new Set(big.ids).size).toBe(LARGE.cards)
    expect(big.ids).toHaveLength(LARGE.cards)

    const ready = await walk({ status: 'ready' })
    expect(ready.ids).toHaveLength(LARGE.ready)
    expect(ready.first.total).toBe(LARGE.ready)

    // A cursor is bound to its view and its filter.
    const { json: p1 } = await read(folders.large, { page: 'cards' })
    expect(p1.nextCursor).toEqual(expect.any(String))
    const otherFilter = await read(folders.large, {
      page: 'cards',
      status: 'ready',
      cursor: p1.nextCursor
    })
    expect(otherFilter.json).toMatchObject({ ok: false, error: 'BAD_CURSOR' })
    const otherView = await read(folders.large, { page: 'sessions', cursor: p1.nextCursor })
    expect(otherView.json).toMatchObject({ ok: false, error: 'BAD_CURSOR' })
    const garbage = await read(folders.large, { page: 'cards', cursor: 'not-a-cursor' })
    expect(garbage.json).toMatchObject({ ok: false, error: 'BAD_CURSOR' })
  })

  it('sessions view paginates every digest once newest first', async () => {
    const pages: string[] = []
    const dates: string[] = []
    let cursor: string | null | undefined
    let first: Record<string, any> | undefined
    let rounds = 0
    do {
      const { text, json } = await read(folders.large, {
        page: 'sessions',
        ...(cursor ? { cursor } : {})
      })
      expect(json.ok).toBe(true)
      expect(json.page).toBe('sessions')
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MEMORY_READ_MAX_BYTES)
      first ??= json
      for (const item of json.items) {
        expect(item.page).toMatch(/^sessions\//)
        expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(item.title).toEqual(expect.any(String))
        pages.push(item.page)
        dates.push(item.date)
      }
      cursor = json.nextCursor
      rounds++
      expect(rounds).toBeLessThan(500)
    } while (cursor)

    expect(first!.total).toBe(LARGE.digests)
    expect(pages).toHaveLength(LARGE.digests)
    expect(new Set(pages).size).toBe(LARGE.digests)
    expect(pages[0]).toBe(`sessions/${digestName(LARGE.digests - 1).replace(/\.md$/, '')}`)
    for (let i = 1; i < dates.length; i++) expect(dates[i] <= dates[i - 1]).toBe(true)

    // `branch` and `sessionId` appear when the digest carries a provenance stamp.
    const withStamp = first!.items.find((it: Record<string, unknown>) => it.branch !== undefined)
    expect(withStamp.sessionId).toMatch(/^[0-9a-f]{8}-aaaa-/)
    expect(withStamp.branch).toMatch(/^card\/x-/)
    const bare = first!.items.find((it: Record<string, unknown>) => it.branch === undefined)
    expect(bare).not.toHaveProperty('sessionId')
  })

  it('keeps the old behaviour for a named page and for an empty repo', async () => {
    const hot = await read(folders.small, { page: 'hot' })
    expect(hot.json).toMatchObject({ ok: true, page: 'hot' })
    expect(hot.json.content).toBe(HOT_SMALL)
    const empty = path.join(root, 'empty')
    await fs.mkdir(empty, { recursive: true })
    const none = await read(empty)
    expect(none.json).toMatchObject({ ok: true, memory: null })
  })
})
