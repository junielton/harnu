import { describe, it, expect } from 'vitest'
import { collectForeignCheckouts, explainFailedWalks } from '../src/main/gc/gc-foreign'
import { AS_GIVEN, buildBundles, type CanonicalPath } from '../src/main/gc/bundle-core'
import { NOW, WT, collect, scanInput } from './gc-scan-fixtures'
import { reapItem } from './gc-fixtures'

const items = (...paths: string[]) => paths.map((p) => reapItem(p))
const denied = (dir: string): Error =>
  Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), { code: 'EACCES' })

describe('collectForeignCheckouts: one walk per worktree, on its real path (S2 delta 7)', () => {
  it('walks the real path of each worktree item and keys the result by item id', async () => {
    const walked: string[] = []
    const canonical: CanonicalPath = (p) => ({ path: p.replace('/link', '/real'), resolved: true })
    const a = items('/link/a')[0]!
    const out = await collectForeignCheckouts([a], canonical, async (p) => {
      walked.push(p)
      return [`${p}/sub/.git`]
    })
    expect(walked).toEqual(['/real/a'])
    expect(out.found.get(a.id)).toEqual(['/real/a/sub/.git'])
    expect(out.failed.size).toBe(0)
  })

  it('records an empty answer as an empty list: walked, nothing found', async () => {
    const [a] = items('/ws/a')
    const out = await collectForeignCheckouts([a!], AS_GIVEN, async () => [])
    expect(out.found.get(a!.id)).toEqual([])
  })

  it('a walk that fails leaves no entry and keeps the cause', async () => {
    const [a, b] = items('/ws/a', '/ws/b')
    const out = await collectForeignCheckouts([a!, b!], AS_GIVEN, async (p) => {
      if (p === '/ws/a') throw denied('/ws/a/root-owned')
      return []
    })
    expect(out.found.has(a!.id)).toBe(false)
    expect(out.found.get(b!.id)).toEqual([])
    expect(out.failed.get(a!.id)).toContain('EACCES')
    expect(out.failed.get(a!.id)).toContain('/ws/a/root-owned')
  })

  it('walks only worktrees and detached worktrees that have a path', async () => {
    const walked: string[] = []
    const list = [
      reapItem('/ws/w'),
      reapItem('/ws/d', { kind: 'detached-worktree' }),
      reapItem('/ws/b', { kind: 'local-branch', path: undefined }),
      reapItem('/ws/r', { kind: 'remote-branch', path: undefined })
    ]
    await collectForeignCheckouts(list, AS_GIVEN, async (p) => {
      walked.push(p)
      return []
    })
    expect(walked.sort()).toEqual(['/ws/d', '/ws/w'])
  })

  it('does not run more walks at once than it is allowed', async () => {
    let running = 0
    let peak = 0
    const many = items(...Array.from({ length: 12 }, (_, i) => `/ws/w${i}`))
    await collectForeignCheckouts(
      many,
      AS_GIVEN,
      async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 2))
        running--
        return []
      },
      3
    )
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('walks the given path when it could not be resolved', async () => {
    const walked: string[] = []
    await collectForeignCheckouts(
      items('/ws/a'),
      (p) => ({ path: p.toUpperCase(), resolved: false }),
      async (p) => {
        walked.push(p)
        return []
      }
    )
    expect(walked).toEqual(['/ws/a'])
  })
})

describe('a worktree that was not walked is never ready, and says why (S2 delta 7)', () => {
  const build = (foreign: Map<string, string[]>) => {
    const { items: its, fateInputs } = collect(scanInput())
    return buildBundles({
      items: its,
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
      foreignCheckouts: foreign
    })[0]!
  }

  it('is ready when the walk found nothing', () => {
    const b = build(new Map([[collect(scanInput()).items[0]!.id, []]]))
    expect(b.bucket).toBe('ready')
  })

  it('is not ready with no entry at all', () => {
    expect(build(new Map()).bucket).toBe('review')
  })

  it('names the cause of a failed walk in the review reason', () => {
    const b = build(new Map())
    const failed = new Map([
      [b.item.id, "EACCES: permission denied, scandir '/ws/org/proj/worktrees/x/secret'"]
    ])
    const [explained] = explainFailedWalks([b], failed)
    expect(explained!.reason?.code).toBe('nested-worktree')
    expect(explained!.reason?.detail).toContain('permission denied')
    expect(explained!.reason?.detail).toContain('/secret')
    expect(explained!.bucket).toBe('review')
  })

  it('leaves a bundle alone when its walk did not fail', () => {
    const b = build(new Map())
    expect(explainFailedWalks([b], new Map())[0]).toBe(b)
  })

  it('does not overwrite a different review reason', () => {
    const { items: its, fateInputs } = collect(scanInput({ prByBranch: new Map() }))
    expect(its.length).toBeGreaterThan(0)
    const b = { ...build(new Map()), reason: { code: 'dirty' as const, detail: 'x' } }
    const out = explainFailedWalks([b], new Map([[b.item.id, 'EACCES']]))
    expect(out[0]!.reason?.code).toBe('dirty')
    expect(fateInputs.size).toBeGreaterThan(0)
    expect(WT).toBeTruthy()
  })

  it('does not touch a bundle that is not in review', () => {
    const b = { ...build(new Map()), bucket: 'in-use' as const, reason: null }
    expect(explainFailedWalks([b], new Map([[b.item.id, 'EACCES']]))[0]).toBe(b)
  })
})
