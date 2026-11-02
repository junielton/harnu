/**
 * Campaign ch.6 (T598, AC-6.2 backend + AC-6.3) — `appendMemoryEntry` with `supersedes`, `watches`
 * and `mission`, `queryMemory` showing a superseded decision with its successor, and
 * `recallForScope` reading the real files. Real fs under a tmp dir; no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { appendMemoryEntry, queryMemory, recallForScope } from '../src/main/mcp/memory-store'
import { parseMemoryAppend } from '../src/main/mcp/validate'

let dir: string
const NOW = Date.parse('2026-11-02T10:00:00Z')

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mem-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function append(entry: string, extra: Record<string, unknown> = {}) {
  return appendMemoryEntry({
    memoryDir: dir,
    page: 'decisions',
    entry,
    author: 'agent',
    now: NOW,
    ...extra
  })
}

describe('AC-6.2 — memory_append supersedes + provenance.mission', () => {
  it('returns the new entry id and stamps mission and valid_from', async () => {
    const res = await append('## Poll every minute', {
      mission: 'mnt-4ba02726',
      watches: ['src/main/steward-core.ts']
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entryId).toMatch(/^e-[0-9a-f]{8}$/)
    const text = await fs.readFile(path.join(dir, 'decisions.md'), 'utf8')
    expect(text).toContain(
      `> entry: ${res.entryId} · valid_from=2026-11-02 · watches=src/main/steward-core.ts`
    )
    expect(text).toContain('mission=mnt-4ba02726')
  })

  it('supersedes: the old entry gains superseded_by, the new one gains supersedes', async () => {
    const first = await append('## Poll every minute')
    if (!first.ok) throw new Error('setup')
    const second = await append('## Wake on events, 20m fallback', { supersedes: first.entryId })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const text = await fs.readFile(path.join(dir, 'decisions.md'), 'utf8')
    expect(text).toContain(`superseded_by=${second.entryId}`)
    expect(text).toContain(`supersedes=${first.entryId}`)
  })

  it('refuses a supersedes that names no entry on the page — and writes nothing', async () => {
    await append('## Keep')
    const before = await fs.readFile(path.join(dir, 'decisions.md'), 'utf8')
    const res = await append('## Replaces nothing', { supersedes: 'e-deadbeef' })
    expect(res).toMatchObject({ ok: false, error: 'SUPERSEDES_NOT_FOUND' })
    expect(await fs.readFile(path.join(dir, 'decisions.md'), 'utf8')).toBe(before)
  })

  it('memory_query shows the superseded decision with its successor', async () => {
    const first = await append('## Poll every minute')
    if (!first.ok) throw new Error('setup')
    const second = await append('## Wake on events, 20m fallback', { supersedes: first.entryId })
    if (!second.ok) throw new Error('setup')
    const { matches } = await queryMemory(dir, 'poll every minute')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      page: 'decisions',
      supersededBy: { id: second.entryId, page: 'decisions', text: 'Wake on events, 20m fallback' }
    })
  })

  it('the verb gate accepts the new args and rejects a malformed id', () => {
    const ok = parseMemoryAppend({
      folder: '/tmp/x',
      page: 'decisions',
      entry: 'x',
      supersedes: 'e-0a0b0c0d',
      watches: ['a.ts'],
      mission: 'mnt-4ba02726'
    })
    expect(ok.ok).toBe(true)
    const bad = parseMemoryAppend({
      folder: '/tmp/x',
      page: 'decisions',
      entry: 'x',
      supersedes: 'nope'
    })
    expect(bad.ok).toBe(false)
    const hot = parseMemoryAppend({
      folder: '/tmp/x',
      page: 'hot',
      entry: 'x',
      supersedes: 'e-0a0b0c0d'
    })
    expect(hot.ok).toBe(false)
  })
})

describe('AC-6.3 — recallForScope reads the real files', () => {
  it('recalls a live decision whose watches overlap the scope, and not a superseded one', async () => {
    const old = await append('## Poll every minute', { watches: ['src/main/steward-core.ts'] })
    if (!old.ok) throw new Error('setup')
    await append('## Wake on events', {
      watches: ['src/main/steward-core.ts'],
      supersedes: old.entryId
    })
    const hits = await recallForScope(dir, { paths: ['src/main/steward-core.ts'], topics: [] })
    expect(hits.map((h) => h.text)).toEqual(['Wake on events'])
    expect(hits[0].page).toBe('decisions')
  })

  it('returns [] when there is no memory yet', async () => {
    const empty = path.join(dir, 'missing')
    expect(await recallForScope(empty, { paths: ['a.ts'], topics: ['x'] })).toEqual([])
  })
})
