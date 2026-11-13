import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BUG-262 AC-2 — `mainCheckoutRoot` / `repoRoot` ran a synchronous `statSync` walk-up on
 * every call (~700 probes a minute in a live profile). Results are now cached per directory:
 * a repeat call costs no fs call at all, and the cached answer is revalidated off the main
 * thread (async fs) so a changed `.git` entry is still noticed.
 */

const fsCalls = vi.hoisted(() => ({ n: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    statSync: ((...a: Parameters<typeof real.statSync>) => {
      fsCalls.n++
      return real.statSync(...a)
    }) as typeof real.statSync,
    readFileSync: ((...a: Parameters<typeof real.readFileSync>) => {
      fsCalls.n++
      return real.readFileSync(...a)
    }) as typeof real.readFileSync
  }
})

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearRootCache, mainCheckoutRoot, repoRoot, ROOT_CACHE_TTL_MS } from '../src/main/data-dir'

describe('mainCheckoutRoot cache (BUG-262 AC-2)', () => {
  let tmp: string
  let main: string
  let linked: string

  beforeEach(async () => {
    clearRootCache()
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'root-cache-')))
    main = join(tmp, 'main')
    linked = join(tmp, 'linked')
    await mkdir(join(main, '.git', 'worktrees', 'linked'), { recursive: true })
    await writeFile(join(main, '.git', 'worktrees', 'linked', 'commondir'), '../..\n')
    await mkdir(join(linked, 'src'), { recursive: true })
    await writeFile(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'linked')}\n`)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(tmp, { recursive: true, force: true })
  })

  it('hits the fs once for repeated calls on the same directory', () => {
    expect(mainCheckoutRoot(linked)).toBe(main)
    const afterFirst = fsCalls.n
    expect(afterFirst).toBeGreaterThan(0)
    for (let i = 0; i < 50; i++) expect(mainCheckoutRoot(linked)).toBe(main)
    expect(fsCalls.n).toBe(afterFirst)
  })

  it('shares the answer with directories already walked through (no re-walk of ancestors)', () => {
    expect(mainCheckoutRoot(join(linked, 'src'))).toBe(main)
    const afterFirst = fsCalls.n
    expect(mainCheckoutRoot(linked)).toBe(main)
    expect(fsCalls.n).toBe(afterFirst)
  })

  it('caches a miss (no git repo) too, and repoRoot rides the same cache', async () => {
    const plain = join(tmp, 'plain')
    await mkdir(plain)
    expect(mainCheckoutRoot(plain)).toBeNull()
    const afterFirst = fsCalls.n
    expect(mainCheckoutRoot(plain)).toBeNull()
    expect(repoRoot(plain)).toBe(plain)
    expect(fsCalls.n).toBe(afterFirst)
  })

  it('notices a changed .git entry after the TTL, resolving off the main thread', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    expect(mainCheckoutRoot(linked)).toBe(main)
    // The worktree becomes a standalone repo: `.git` is now a directory.
    await rm(join(linked, '.git'))
    await mkdir(join(linked, '.git'))
    const before = fsCalls.n
    vi.setSystemTime(Date.now() + ROOT_CACHE_TTL_MS + 1)
    // A stale hit answers from the cache without touching the fs on this call…
    expect(mainCheckoutRoot(linked)).toBe(main)
    expect(fsCalls.n).toBe(before)
    // …and the background revalidation then replaces it.
    await vi.waitFor(() => expect(mainCheckoutRoot(linked)).toBe(linked))
    expect(fsCalls.n).toBe(before)
  })
})
