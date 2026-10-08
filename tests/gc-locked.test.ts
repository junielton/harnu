// A worktree git has locked is never cleaned (T441 delta 6, item 2): it shows as review at scan
// time, and the pure rule that finds those items from git's own listing is covered here. The
// reprobe and the real-git halts are in gc-shell.test.ts and reaper-worktree-admin.test.ts.
import { describe, expect, it } from 'vitest'
import { AS_GIVEN, buildBundles, type BuildBundlesInput } from '../src/main/gc/bundle-core'
import { lockedItemIds } from '../src/main/gc/gc-locked'
import { collect, scanInput } from './gc-scan-fixtures'
import { NOW } from './gc-fixtures'

const build = (locked?: ReadonlySet<string>) => {
  const { items, fateInputs } = collect(scanInput())
  const input: BuildBundlesInput = {
    items,
    fateInputs,
    stacks: [],
    stackPaths: new Map(),
    containers: [],
    sessions: new Map(),
    keep: new Set(),
    neverClean: new Set(),
    now: NOW,
    graceDays: 2,
    volumes: new Map(),
    knownFolders: [],
    protectedProjects: new Set(),
    canonical: AS_GIVEN,
    foreignCheckouts: new Map(items.map((i) => [i.id, []])),
    ...(locked ? { locked } : {})
  }
  return { items, bundles: buildBundles(input) }
}

describe('a locked worktree shows in review at scan time (delta 6, item 2)', () => {
  it('is ready when nothing locks it (the baseline)', () => {
    expect(build().bundles[0]!.bucket).toBe('ready')
  })

  it('is review with the reason "This worktree is locked in git"', () => {
    const id = build().items[0]!.id
    const b = build(new Set([id])).bundles[0]!
    expect(b.bucket).toBe('review')
    expect(b.reason).toEqual({ code: 'locked', detail: 'This worktree is locked in git.' })
  })

  it('leaves the other worktrees alone', () => {
    expect(build(new Set(['some-other-id'])).bundles[0]!.bucket).toBe('ready')
  })
})

describe('lockedItemIds: which scanned worktrees git lists as locked', () => {
  const item = (id: string, path: string | null) => ({ id, path })

  it('matches on real paths, so a symlinked spelling is found too', () => {
    const real = (p: string) => ({ path: p.replace('/link', '/real'), resolved: true })
    const ids = lockedItemIds(
      [item('a', '/link/wt-a'), item('b', '/real/wt-b')],
      ['/real/wt-a'],
      real,
      'linux'
    )
    expect([...ids]).toEqual(['a'])
  })

  it('ignores an item with no path and a locked path that does not resolve', () => {
    const none = () => ({ path: '', resolved: false })
    expect([...lockedItemIds([item('a', null)], ['/x'], AS_GIVEN, 'linux')]).toEqual([])
    expect([...lockedItemIds([item('a', '/x')], ['/x'], none, 'linux')]).toEqual([])
  })

  it('is empty when nothing is locked', () => {
    expect(lockedItemIds([item('a', '/x')], [], AS_GIVEN, 'linux').size).toBe(0)
  })
})
