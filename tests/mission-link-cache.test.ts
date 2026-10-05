/**
 * Mission v3 S2 (§3.7) — `src/main/mission-link-cache.ts`: the last-known
 * resolution of each mission link, in memory and in a userData sidecar
 * (`mission-link-cache.json`), never in the mission file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir }
}))

let cache: typeof import('../src/main/mission-link-cache')
const sidecar = (): string => path.join(h.userDataDir, 'mission-link-cache.json')

async function sidecarJson(): Promise<{
  version: number
  entries: Record<string, Record<string, unknown>>
}> {
  return JSON.parse(await fs.readFile(sidecar(), 'utf8'))
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-linkcache-'))
  vi.resetModules()
  cache = await import('../src/main/mission-link-cache')
  await cache.ensureLinkCacheLoaded()
})

describe('mission link cache', () => {
  it('remembers a resolution per repo root + kind + ref, and forgets it on a contrary observation', () => {
    expect(cache.getLastKnown('/r', 'pr', '7')).toBeNull()
    cache.rememberResolved('/r', 'pr', '7', { state: 'OPEN', prNumber: 7 }, '2026-10-01T10:00:00Z')
    expect(cache.getLastKnown('/r', 'pr', '7')).toEqual({
      state: 'OPEN',
      prNumber: 7,
      at: '2026-10-01T10:00:00Z'
    })
    // Keyed by root and kind too.
    expect(cache.getLastKnown('/other', 'pr', '7')).toBeNull()
    expect(cache.getLastKnown('/r', 'worktree', '7')).toBeNull()
    cache.forgetResolved('/r', 'pr', '7')
    expect(cache.getLastKnown('/r', 'pr', '7')).toBeNull()
  })

  it('keeps the base branch current when the same open PR is retargeted, without moving `at`', async () => {
    cache.rememberResolved(
      '/r',
      'pr',
      '9',
      { state: 'OPEN', prNumber: 9, baseRefName: 'feat/parent' },
      'T1'
    )
    await cache.flushLinkCache()
    // The parent merged and the stacked PR was retargeted to main: same state, new base.
    cache.rememberResolved(
      '/r',
      'pr',
      '9',
      { state: 'OPEN', prNumber: 9, baseRefName: 'main' },
      'T2'
    )
    expect(cache.getLastKnown('/r', 'pr', '9')).toMatchObject({ baseRefName: 'main', at: 'T1' })
    await cache.flushLinkCache()
    expect(Object.values((await sidecarJson()).entries)).toEqual([
      { state: 'OPEN', prNumber: 9, baseRefName: 'main', at: 'T1' }
    ])
  })

  it('persists to the userData sidecar on flush, and a fresh process reads it back', async () => {
    cache.rememberResolved('/r', 'pr', '8', { state: 'MERGED', prNumber: 8, url: 'u8' }, 'T1')
    await cache.flushLinkCache()
    const disk = await sidecarJson()
    expect(disk.version).toBe(1)
    expect(Object.values(disk.entries)).toEqual([
      { state: 'MERGED', prNumber: 8, url: 'u8', at: 'T1' }
    ])
    vi.resetModules()
    const fresh = await import('../src/main/mission-link-cache')
    await fresh.ensureLinkCacheLoaded()
    expect(fresh.getLastKnown('/r', 'pr', '8')).toMatchObject({ state: 'MERGED', prNumber: 8 })
  })

  it('writes nothing when nothing changed: no sidecar for an empty cache, no rewrite for the same state', async () => {
    await cache.flushLinkCache()
    await expect(fs.stat(sidecar())).rejects.toThrow()
    cache.rememberResolved('/r', 'pr', '7', { state: 'OPEN', prNumber: 7 }, 'T1')
    await cache.flushLinkCache()
    const first = await fs.stat(sidecar())
    // The same observation again is not a change — `at` keeps the first sighting.
    cache.rememberResolved('/r', 'pr', '7', { state: 'OPEN', prNumber: 7 }, 'T2')
    expect(cache.getLastKnown('/r', 'pr', '7')?.at).toBe('T1')
    await cache.flushLinkCache()
    expect((await fs.stat(sidecar())).mtimeMs).toBe(first.mtimeMs)
    // Forgetting an unknown key is not a change either.
    cache.forgetResolved('/r', 'pr', '404')
    await cache.flushLinkCache()
    expect((await fs.stat(sidecar())).mtimeMs).toBe(first.mtimeMs)
  })

  it('a changed state is written, and a forget is persisted', async () => {
    cache.rememberResolved('/r', 'pr', '7', { state: 'OPEN', prNumber: 7 }, 'T1')
    cache.rememberResolved('/r', 'pr', '7', { state: 'MERGED', prNumber: 7 }, 'T2')
    await cache.flushLinkCache()
    expect(Object.values((await sidecarJson()).entries)).toEqual([
      { state: 'MERGED', prNumber: 7, at: 'T2' }
    ])
    cache.forgetResolved('/r', 'pr', '7')
    await cache.flushLinkCache()
    expect((await sidecarJson()).entries).toEqual({})
  })

  it('writes on its own after a short debounce', async () => {
    vi.useFakeTimers()
    try {
      cache.rememberResolved('/r', 'pr', '7', { state: 'OPEN', prNumber: 7 }, 'T1')
      await vi.advanceTimersByTimeAsync(cache.LINK_CACHE_WRITE_DEBOUNCE_MS + 10)
    } finally {
      vi.useRealTimers()
    }
    await cache.flushLinkCache()
    expect(Object.keys((await sidecarJson()).entries)).toHaveLength(1)
  })

  it('a corrupt or foreign sidecar reads as empty, never a throw', async () => {
    for (const body of ['{not json', '[]', '{"version":2,"entries":{}}', '{"entries":{"k":7}}']) {
      await fs.writeFile(sidecar(), body)
      vi.resetModules()
      const fresh = await import('../src/main/mission-link-cache')
      await fresh.ensureLinkCacheLoaded()
      expect(fresh.getLastKnown('/r', 'pr', '7')).toBeNull()
    }
  })

  it('drops malformed entries but keeps the good ones', async () => {
    cache.rememberResolved('/r', 'pr', '7', { state: 'OPEN', prNumber: 7 }, 'T1')
    await cache.flushLinkCache()
    const disk = await sidecarJson()
    disk.entries['bad'] = { at: 'T0' }
    await fs.writeFile(sidecar(), JSON.stringify(disk))
    vi.resetModules()
    const fresh = await import('../src/main/mission-link-cache')
    await fresh.ensureLinkCacheLoaded()
    expect(fresh.getLastKnown('/r', 'pr', '7')).toMatchObject({ state: 'OPEN' })
    await fresh.flushLinkCache()
  })

  it('is bounded: past the cap, the oldest sightings are dropped', () => {
    const cap = cache.LINK_CACHE_MAX_ENTRIES
    for (let i = 0; i <= cap; i++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
      cache.rememberResolved('/r', 'pr', String(i), { state: 'OPEN', prNumber: i }, at)
    }
    expect(cache.getLastKnown('/r', 'pr', '0')).toBeNull()
    expect(cache.getLastKnown('/r', 'pr', String(cap))).not.toBeNull()
  })

  it('a sighting made before the sidecar finished loading is kept over the stale disk copy', async () => {
    cache.rememberResolved('/r', 'pr', '7', { state: 'OPEN', prNumber: 7 }, 'T1')
    await cache.flushLinkCache()
    vi.resetModules()
    const fresh = await import('../src/main/mission-link-cache')
    fresh.rememberResolved('/r', 'pr', '7', { state: 'MERGED', prNumber: 7 }, 'T2')
    await fresh.ensureLinkCacheLoaded()
    expect(fresh.getLastKnown('/r', 'pr', '7')).toMatchObject({ state: 'MERGED', at: 'T2' })
  })

  it('a late write lands in the sidecar it was loaded from, never a userData set afterwards', async () => {
    const first = sidecar()
    cache.rememberResolved('/r', 'pr', '7', { state: 'OPEN', prNumber: 7 }, 'T1')
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-linkcache-moved-'))
    await cache.flushLinkCache()
    await expect(fs.stat(sidecar())).rejects.toThrow()
    expect(JSON.parse(await fs.readFile(first, 'utf8')).entries).not.toEqual({})
  })
})
