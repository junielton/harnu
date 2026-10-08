import { describe, it, expect } from 'vitest'
import { sessionsFromFleet, sessionsFromFolders } from '../src/main/gc/gc-sessions'
import { buildBundles, canonicalPathKey, type CanonicalPath } from '../src/main/gc/bundle-core'
import { NOW, REPO, WT, collect, scanInput } from './gc-scan-fixtures'

/** A tiny filesystem of symlinks: `/link/...` is another spelling of `/real/...`. */
const aliasing =
  (map: Record<string, string>): CanonicalPath =>
  (p) => {
    for (const [from, to] of Object.entries(map)) {
      if (p === from || p.startsWith(`${from}/`))
        return { path: to + p.slice(from.length), resolved: true }
    }
    return { path: p, resolved: true }
  }

const bundlesFor = (
  sessions: ReturnType<typeof sessionsFromFolders>,
  canonical: CanonicalPath,
  over: { worktree?: string } = {}
) => {
  const base = scanInput()
  if (over.worktree) {
    base.worktrees = base.worktrees.map((w) => (w.path === WT ? { ...w, path: over.worktree! } : w))
    base.statusByPath = new Map([[over.worktree, { trackedDirty: false, untracked: [] }]])
    base.unpushedByPath = new Map([[over.worktree, false]])
  }
  const { items, fateInputs } = collect(base)
  return buildBundles({
    items,
    fateInputs,
    stacks: [],
    stackPaths: new Map(),
    containers: [],
    sessions,
    keep: new Set(),
    neverClean: new Set(),
    now: NOW,
    graceDays: 2,
    volumes: new Map(),
    knownFolders: [],
    protectedProjects: new Set(),
    canonical
  })
}

describe('session presence is judged on real paths (delta 3b, item 8)', () => {
  const canonical = aliasing({ '/link': '/real' })

  it('a live session at /real/wt makes the worktree /link/wt read live', () => {
    const sessions = sessionsFromFolders(
      ['/real/wt'],
      { live: new Set(['/real/wt']), inUse: new Set(['/real/wt']) },
      canonical
    )
    const [b] = bundlesFor(sessions, canonical, { worktree: '/link/wt' })
    expect(b!.session).toBe('working')
    expect(b!.bucket).toBe('in-use')
  })

  it('an idle open session through the alias reads open-idle, so a review item', () => {
    const sessions = sessionsFromFolders(
      ['/link/wt'],
      { live: new Set(), inUse: new Set(['/real/wt']) },
      canonical
    )
    const [b] = bundlesFor(sessions, canonical, { worktree: '/real/wt' })
    expect(b!.session).toBe('open-idle')
    expect(b!.bucket).not.toBe('ready')
  })

  it('without the canonical resolver the same sessions would be missed (the old wiring)', () => {
    const sessions = sessionsFromFolders(
      ['/real/wt'],
      { live: new Set(['/real/wt']), inUse: new Set(['/real/wt']) },
      (p) => ({ path: p, resolved: true })
    )
    const [b] = bundlesFor(sessions, aliasing({ '/link': '/real' }), { worktree: '/link/wt' })
    // The map is keyed on /real/wt with presence computed on spellings: still found by the
    // builder through its own canonical, which is why the key set must include the set folders.
    expect(b!.session).toBe('working')
  })

  it('has one entry per folder given, set folders included, with no duplicates', () => {
    const sessions = sessionsFromFolders(
      ['/real/wt', '/real/wt', '/ws/other'],
      { live: new Set(['/real/wt']), inUse: new Set(['/real/wt', '/ws/idle']) },
      canonical
    )
    expect([...sessions.keys()].sort()).toEqual(['/real/wt', '/ws/idle', '/ws/other'])
  })

  it('a sibling that merely shares a name prefix is not a session of the worktree', () => {
    const sessions = sessionsFromFolders(
      ['/real/wt-other'],
      { live: new Set(['/real/wt-other']), inUse: new Set(['/real/wt-other']) },
      canonical
    )
    const [b] = bundlesFor(sessions, canonical, { worktree: '/real/wt' })
    expect(b!.session).toBe('none')
  })

  it('keys by the spelling it was given', () => {
    const sessions = sessionsFromFolders(
      ['/link/wt'],
      { live: new Set(), inUse: new Set() },
      canonical
    )
    expect(sessions.has('/link/wt')).toBe(true)
    expect(canonicalPathKey('/link/wt', 'linux')).toBe('/link/wt')
    expect(REPO).toBeTruthy()
  })
})

describe('grace counts every terminal under the worktree, outside Harnu too (delta 3b, item 9)', () => {
  const HOUR = 3_600_000
  const idle = { live: new Set<string>(), inUse: new Set<string>() }
  const folder = (path: string, atMs: number | null) => ({
    path,
    sessions: atMs === null ? [] : [{ fileMtime: atMs }]
  })

  it('takes the latest activity of a folder from its transcripts', () => {
    const out = sessionsFromFleet(
      [
        {
          path: '/ws/wt',
          sessions: [{ fileMtime: 100 }, { modified: new Date(900).toISOString() }, {}]
        }
      ],
      idle,
      aliasing({})
    )
    expect(out.get('/ws/wt')!.lastActivityAt).toBe(900)
  })

  it('gives a folder with no transcript no activity', () => {
    const out = sessionsFromFleet([folder('/ws/wt', null)], idle, aliasing({}))
    expect(out.get('/ws/wt')!.lastActivityAt).toBeNull()
  })

  it('a recent transcript in WT/api, from a claude run outside Harnu, keeps the worktree in use', () => {
    const canonical = aliasing({})
    const sessions = sessionsFromFleet([folder(`${WT}/api`, NOW - HOUR)], idle, canonical)
    const [b] = bundlesFor(sessions, canonical)
    expect(b!.session).toBe('none')
    expect(b!.lastSignOfLifeAt).toBe(NOW - HOUR)
    expect(b!.bucket).toBe('in-use')
  })

  it('a session parked an hour ago counts toward grace', () => {
    const canonical = aliasing({})
    const sessions = sessionsFromFleet([folder(WT, NOW - HOUR)], idle, canonical)
    expect(bundlesFor(sessions, canonical)[0]!.bucket).toBe('in-use')
  })

  it('a transcript under an alias of the worktree counts', () => {
    const canonical = aliasing({ '/link': '/real' })
    const sessions = sessionsFromFleet([folder('/link/wt/api', NOW - HOUR)], idle, canonical)
    const [b] = bundlesFor(sessions, canonical, { worktree: '/real/wt' })
    expect(b!.bucket).toBe('in-use')
  })

  it('old activity under the worktree does not keep it, and a sibling name prefix never counts', () => {
    const canonical = aliasing({})
    const old = sessionsFromFleet(
      [folder(`${WT}/api`, NOW - 30 * 86_400_000), folder(`${WT}-other`, NOW - HOUR)],
      idle,
      canonical
    )
    expect(bundlesFor(old, canonical)[0]!.bucket).toBe('ready')
  })

  it('takes the newest of several folders under the worktree', () => {
    const canonical = aliasing({})
    const sessions = sessionsFromFleet(
      [
        folder(`${WT}/a`, NOW - 5 * HOUR),
        folder(`${WT}/b`, NOW - HOUR),
        folder(WT, NOW - 9 * HOUR)
      ],
      idle,
      canonical
    )
    expect(bundlesFor(sessions, canonical)[0]!.lastSignOfLifeAt).toBe(NOW - HOUR)
  })

  it('still reads presence for those folders on real paths', () => {
    const canonical = aliasing({ '/link': '/real' })
    const sessions = sessionsFromFleet(
      [folder('/real/wt/api', NOW - HOUR)],
      { live: new Set(['/real/wt/api']), inUse: new Set(['/real/wt/api']) },
      canonical
    )
    expect(bundlesFor(sessions, canonical, { worktree: '/link/wt' })[0]!.session).toBe('working')
  })
})
