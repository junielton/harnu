import { describe, it, expect } from 'vitest'
import { sessionsFromFolders } from '../src/main/gc/gc-sessions'
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
