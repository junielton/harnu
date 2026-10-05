import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createWorktreeTracker,
  type WorktreeTrackerDeps,
  type TrackedWorktree
} from '../src/main/worktree-tracker'
import type { WorktreeListEntry } from '../src/main/worktree-core'

function fakeDeps(
  listing: Record<string, WorktreeListEntry[]>,
  canon: Record<string, string> = {}
) {
  const watchers = new Map<string, (ev: string, f: string | null) => void>()
  const errors = new Map<string, (err: Error) => void>()
  const closed: string[] = []
  const deps: WorktreeTrackerDeps = {
    listWorktrees: vi.fn(async (probe: string) => listing[probe] ?? []),
    canonicalize: vi.fn(async (p: string) => canon[p] ?? p),
    watch: (dir, onEvent, onError) => {
      watchers.set(dir, onEvent)
      if (onError) errors.set(dir, onError)
      return {
        close: () => {
          closed.push(dir)
          watchers.delete(dir)
        }
      }
    },
    stat: vi.fn(async () => ({ mtimeMs: 1 })),
    onFocus: () => () => {},
    now: () => Date.now()
  }
  return { deps, watchers, errors, closed }
}
const wt = (path: string, branch = 'b'): WorktreeListEntry => ({
  path,
  head: 'h',
  branch,
  detached: false,
  bare: false
})
const listCalls = (deps: WorktreeTrackerDeps): unknown[][] =>
  (deps.listWorktrees as ReturnType<typeof vi.fn>).mock.calls

describe('worktree tracker', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('AC-9: a burst of 10 watch events lists that repo ≤ 2 times and no other repo', async () => {
    vi.useFakeTimers()
    const listing = {
      '/r1': [
        wt('/r1', 'main'),
        ...Array.from({ length: 59 }, (_, i) => wt(`/r1/.claude/worktrees/w${i}`))
      ],
      '/r2': [wt('/r2', 'main')]
    }
    const { deps, watchers } = fakeDeps(listing)
    const emitted: Array<[string, TrackedWorktree[]]> = []
    const t = createWorktreeTracker(deps, (id, e) => emitted.push([id, e]))
    t.track([
      { repoId: '/r1/.git', probePath: '/r1', memberPaths: ['/r1'] },
      { repoId: '/r2/.git', probePath: '/r2', memberPaths: ['/r2'] }
    ])
    await vi.advanceTimersByTimeAsync(10)
    const calls = listCalls(deps)
    const r1Before = calls.filter(([p]) => p === '/r1').length
    const r2Before = calls.filter(([p]) => p === '/r2').length
    for (let i = 0; i < 10; i++) {
      watchers.get('/r1/.git/worktrees')!('rename', `w${i}`)
      await vi.advanceTimersByTimeAsync(40)
    }
    await vi.advanceTimersByTimeAsync(600)
    expect(calls.filter(([p]) => p === '/r1').length - r1Before).toBeLessThanOrEqual(2)
    expect(calls.filter(([p]) => p === '/r2').length - r2Before).toBe(0)
    t.close()
  })

  it('AC-9: never tracks more than 64 repos and never runs more than 4 listings at once', async () => {
    let inFlight = 0
    let peak = 0
    const { deps } = fakeDeps({})
    deps.listWorktrees = vi.fn(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return []
    })
    const t = createWorktreeTracker(deps, () => {})
    t.track(
      Array.from({ length: 80 }, (_, i) => ({
        repoId: `/r${i}/.git`,
        probePath: `/r${i}`,
        memberPaths: [`/r${i}`]
      }))
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(listCalls(deps).length).toBe(64)
    expect(peak).toBeLessThanOrEqual(4)
    t.close()
  })

  it('AC-9: over the cap, repos are admitted in input order and the overflow is never listed', async () => {
    const { deps, closed } = fakeDeps({})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repo = (i: number) => ({
      repoId: `/r${i}/.git`,
      probePath: `/r${i}`,
      memberPaths: [`/r${i}`]
    })
    const t = createWorktreeTracker(deps, () => {})
    t.track(Array.from({ length: 65 }, (_, i) => repo(i)))
    await new Promise((r) => setTimeout(r, 20))
    const listed = () => listCalls(deps).map(([p]) => p)
    expect(listed()).not.toContain('/r64')
    expect(listed()).toContain('/r63')
    // The overflow repo moves to the front: it is admitted, the last one is dropped
    // and its watches close.
    t.track([repo(64), ...Array.from({ length: 64 }, (_, i) => repo(i))])
    await new Promise((r) => setTimeout(r, 20))
    expect(listed()).toContain('/r64')
    expect(closed).toContain('/r63/.git')
    expect(warn).toHaveBeenCalledTimes(1)
    t.close()
  })

  it('emits only when the matched entries changed', async () => {
    vi.useFakeTimers()
    const { deps, watchers } = fakeDeps({ '/r': [wt('/r', 'main'), wt('/r/a')] })
    const emitted: TrackedWorktree[][] = []
    const t = createWorktreeTracker(deps, (_, e) => emitted.push(e))
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    expect(emitted).toHaveLength(1)
    watchers.get('/r/.git/worktrees')!('change', 'a')
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(2)
    expect(emitted).toHaveLength(1)
    t.close()
  })

  it('AC-34: a listed path that resolves to a known member is reported as the member path', async () => {
    const listing = {
      'C:\\x': [wt('C:/x', 'main'), wt('C:/x/wt')],
      '/var/r': [wt('/private/var/r', 'main')]
    }
    const canon = {
      'C:/x': 'C:\\x',
      'C:\\x': 'C:\\x',
      'C:/x/wt': 'C:\\x\\wt',
      'C:\\x\\wt': 'C:\\x\\wt',
      '/private/var/r': '/private/var/r',
      '/var/r': '/private/var/r'
    }
    const { deps } = fakeDeps(listing, canon)
    const emitted = new Map<string, TrackedWorktree[]>()
    const t = createWorktreeTracker(deps, (id, e) => emitted.set(id, e))
    t.track([
      { repoId: 'C:\\x\\.git', probePath: 'C:\\x', memberPaths: ['C:\\x', 'C:\\x\\wt'] },
      { repoId: '/private/var/r/.git', probePath: '/var/r', memberPaths: ['/var/r'] }
    ])
    await new Promise((r) => setTimeout(r, 20))
    expect(emitted.get('C:\\x\\.git')!.map((e) => e.path)).toEqual(['C:\\x', 'C:\\x\\wt'])
    expect(emitted.get('/private/var/r/.git')!.map((e) => e.path)).toEqual(['/var/r'])
    t.close()
  })

  it('AC-34: a symlinked parent matches its target member; an unknown path is reported canonical', async () => {
    const listing = { '/home/u/r': [wt('/data/r', 'main'), wt('/data/r/wt'), wt('/data/r/new')] }
    const canon = {
      '/home/u/r': '/data/r',
      '/home/u/r/wt': '/data/r/wt',
      '/data/r': '/data/r',
      '/data/r/wt': '/data/r/wt',
      '/data/r/new': '/data/r/new'
    }
    const { deps } = fakeDeps(listing, canon)
    let got: TrackedWorktree[] = []
    const t = createWorktreeTracker(deps, (_, e) => {
      got = e
    })
    t.track([
      { repoId: '/data/r/.git', probePath: '/home/u/r', memberPaths: ['/home/u/r', '/home/u/r/wt'] }
    ])
    await new Promise((r) => setTimeout(r, 20))
    expect(got.map((e) => e.path)).toEqual(['/home/u/r', '/home/u/r/wt', '/data/r/new'])
    t.close()
  })

  it('review focus 5: a worktree path with spaces and non-ASCII characters matches its member (one row)', async () => {
    const p = '/r/árvore com espaço'
    const { deps } = fakeDeps({ '/r': [wt('/r', 'main'), wt(p)] })
    let got: TrackedWorktree[] = []
    const t = createWorktreeTracker(deps, (_, e) => {
      got = e
    })
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r', p] }])
    await new Promise((r) => setTimeout(r, 20))
    expect(got.map((e) => e.path)).toEqual(['/r', p])
    t.close()
  })

  it('a memberPaths-only change re-matches without a re-list', async () => {
    const listing = { '/r': [wt('/r', 'main'), wt('/data/r/wt')] }
    const canon = { '/r/wt': '/data/r/wt' }
    const { deps } = fakeDeps(listing, canon)
    const emitted: TrackedWorktree[][] = []
    const t = createWorktreeTracker(deps, (_, e) => emitted.push(e))
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await new Promise((r) => setTimeout(r, 20))
    expect(emitted.at(-1)!.map((e) => e.path)).toEqual(['/r', '/data/r/wt'])
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r', '/r/wt'] }])
    await new Promise((r) => setTimeout(r, 20))
    expect(listCalls(deps).length).toBe(1)
    expect(emitted.at(-1)!.map((e) => e.path)).toEqual(['/r', '/r/wt'])
    t.close()
  })

  it('drops bare and prunable entries and marks the first entry as the main worktree', async () => {
    const listing = {
      '/r': [
        wt('/r', 'main'),
        { ...wt('/r/gone'), prunable: true },
        { ...wt('/r/.bare'), bare: true },
        { ...wt('/r/ok'), locked: true }
      ]
    }
    const { deps } = fakeDeps(listing)
    let got: TrackedWorktree[] = []
    const t = createWorktreeTracker(deps, (_, e) => {
      got = e
    })
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await new Promise((r) => setTimeout(r, 20))
    expect(got.map((e) => [e.path, e.isMainWorktree, e.locked])).toEqual([
      ['/r', true, false],
      ['/r/ok', false, true]
    ])
    t.close()
  })

  it('a dropped repo has its watches closed and is not listed again', async () => {
    vi.useFakeTimers()
    const { deps, watchers, closed } = fakeDeps({ '/r': [wt('/r', 'main')] })
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    const fire = watchers.get('/r/.git/worktrees')!
    t.track([])
    expect(closed).toEqual(expect.arrayContaining(['/r/.git', '/r/.git/worktrees']))
    fire('change', 'x')
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(1)
    t.close()
  })
  it('AC-35: a null rename for a worktrees dir that is gone closes its watch and re-arms when it reappears', async () => {
    vi.useFakeTimers()
    const { deps, watchers, closed } = fakeDeps({ '/r': [wt('/r', 'main')] })
    let gone = false
    deps.stat = vi.fn(async () => (gone ? null : { mtimeMs: 1 }))
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    gone = true
    watchers.get('/r/.git/worktrees')!('rename', null)
    // Closed as soon as the stat confirms the dir is gone, before any debounce.
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toContain('/r/.git/worktrees')
    expect(watchers.has('/r/.git/worktrees')).toBe(false)
    gone = false
    watchers.get('/r/.git')!('rename', 'worktrees')
    await vi.advanceTimersByTimeAsync(10)
    expect(watchers.has('/r/.git/worktrees')).toBe(true)
    t.close()
  })

  it('AC-35: a rename reported for the dir by its own name also closes the watch', async () => {
    vi.useFakeTimers()
    const { deps, watchers, closed } = fakeDeps({ '/r': [wt('/r', 'main')] })
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    const n = listCalls(deps).length
    watchers.get('/r/.git/worktrees')!('rename', 'worktrees')
    expect(closed).toContain('/r/.git/worktrees')
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(n + 1)
    t.close()
  })

  it('AC-35: a worktrees dir missing at track time (ENOENT) is armed later from the parent watch', async () => {
    vi.useFakeTimers()
    const { deps, watchers } = fakeDeps({ '/r': [wt('/r', 'main')] })
    const realWatch = deps.watch
    let exists = false
    deps.watch = (dir, onEvent) => {
      if (dir === '/r/.git/worktrees' && !exists) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      return realWatch(dir, onEvent)
    }
    const focus: Array<() => void> = []
    deps.onFocus = (cb) => {
      focus.push(cb)
      return () => {}
    }
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    expect(watchers.has('/r/.git/worktrees')).toBe(false)
    // ENOENT is expected, not a watch failure: focus does not re-list.
    const n = listCalls(deps).length
    focus.forEach((f) => f())
    await vi.advanceTimersByTimeAsync(10)
    expect(listCalls(deps).length).toBe(n)
    exists = true
    watchers.get('/r/.git')!('rename', 'worktrees')
    expect(watchers.has('/r/.git/worktrees')).toBe(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(n + 1)
    t.close()
  })

  it('AC-35: unrelated entries in the git dir are ignored', async () => {
    vi.useFakeTimers()
    const { deps, watchers } = fakeDeps({ '/r': [wt('/r', 'main')] })
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    const n = listCalls(deps).length
    for (const f of ['index', 'HEAD', 'index.lock', 'ORIG_HEAD'])
      watchers.get('/r/.git')!('change', f)
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(n)
    expect(deps.stat).not.toHaveBeenCalledWith('/r/.git/index')
    t.close()
  })

  it('AC-35: a null filename on the worktrees watch re-lists only when its mtime moved and keeps a live dir watched', async () => {
    vi.useFakeTimers()
    const { deps, watchers, closed } = fakeDeps({ '/r': [wt('/r', 'main')] })
    let mtime = 1
    deps.stat = vi.fn(async () => ({ mtimeMs: mtime }))
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    const n = listCalls(deps).length
    watchers.get('/r/.git/worktrees')!('change', null)
    watchers.get('/r/.git/worktrees')!('rename', null)
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(n)
    expect(closed).not.toContain('/r/.git/worktrees')
    expect(watchers.has('/r/.git/worktrees')).toBe(true)
    mtime = 2
    watchers.get('/r/.git/worktrees')!('rename', null)
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(n + 1)
    expect(watchers.has('/r/.git/worktrees')).toBe(true)
    t.close()
  })

  it('AC-35: a null filename re-lists only when the worktrees dir mtime moved', async () => {
    vi.useFakeTimers()
    const { deps, watchers } = fakeDeps({ '/r': [wt('/r', 'main')] })
    let mtime = 1
    deps.stat = vi.fn(async () => ({ mtimeMs: mtime }))
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    const n = listCalls(deps).length
    watchers.get('/r/.git')!('change', null)
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(n)
    mtime = 2
    watchers.get('/r/.git')!('change', null)
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(n + 1)
    t.close()
  })

  it('AC-13: a failed watch falls back to focus re-lists, at most once per 30 s, and no interval timer exists', async () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const { deps } = fakeDeps({ '/r': [wt('/r', 'main')], '/ok': [wt('/ok', 'main')] })
    let focus: () => void = () => {}
    deps.onFocus = (cb) => {
      focus = cb
      return () => {}
    }
    deps.watch = (dir) => {
      if (dir.startsWith('/ok')) return { close: () => {} }
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    }
    const t = createWorktreeTracker(deps, () => {})
    t.track([
      { repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] },
      { repoId: '/ok/.git', probePath: '/ok', memberPaths: ['/ok'] }
    ])
    await vi.advanceTimersByTimeAsync(10)
    const count = (p: string) => listCalls(deps).filter(([x]) => x === p).length
    const n = count('/r')
    focus()
    focus()
    await vi.advanceTimersByTimeAsync(10)
    expect(count('/r')).toBe(n + 1)
    expect(count('/ok')).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    focus()
    await vi.advanceTimersByTimeAsync(10)
    expect(count('/r')).toBe(n + 2)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    t.close()
  })

  it('AC-13: close() unsubscribes from focus', () => {
    const { deps } = fakeDeps({})
    const off = vi.fn()
    deps.onFocus = () => off
    const t = createWorktreeTracker(deps, () => {})
    t.close()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('Review focus 4: a failing git -C keeps the last listing and recovers on a new probePath', async () => {
    const { deps } = fakeDeps({})
    let fail = false
    deps.listWorktrees = vi.fn(async (p: string) => {
      if (fail) throw new Error('not a git repository')
      return [wt(p, 'main')]
    })
    const emitted: TrackedWorktree[][] = []
    const t = createWorktreeTracker(deps, (_, e) => emitted.push(e))
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await new Promise((r) => setTimeout(r, 20))
    fail = true
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r', '/r/x'] }])
    await new Promise((r) => setTimeout(r, 20))
    expect(emitted).toHaveLength(1)
    fail = false
    t.track([{ repoId: '/r/.git', probePath: '/r/x', memberPaths: ['/r', '/r/x'] }])
    await new Promise((r) => setTimeout(r, 20))
    expect(emitted.length).toBeGreaterThanOrEqual(2)
    t.close()
  })

  it('Review focus 4: re-lists that keep failing never throw, keep the last listing and log once', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, watchers } = fakeDeps({})
    let fail = false
    deps.listWorktrees = vi.fn(async (p: string) => {
      if (fail) throw new Error('fatal: cannot change to /r: No such file or directory')
      return [wt(p, 'main'), wt('/r/a')]
    })
    const emitted: TrackedWorktree[][] = []
    const t = createWorktreeTracker(deps, (_, e) => emitted.push(e))
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    fail = true
    for (let i = 0; i < 3; i++) {
      watchers.get('/r/.git/worktrees')!('rename', `w${i}`)
      await vi.advanceTimersByTimeAsync(600)
    }
    expect(listCalls(deps).length).toBe(4)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].map((e) => e.path)).toEqual(['/r', '/r/a'])
    expect(warn).toHaveBeenCalledTimes(1)
    t.close()
  })
  it('AC-35: an EPERM re-arm (Windows delete-pending) falls back to focus until the watch re-arms', async () => {
    vi.useFakeTimers()
    const { deps, watchers } = fakeDeps({ '/r': [wt('/r', 'main')] })
    const realWatch = deps.watch
    let pending = false
    deps.watch = (dir, onEvent) => {
      if (dir === '/r/.git/worktrees' && pending) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }
      return realWatch(dir, onEvent)
    }
    let focus: () => void = () => {}
    deps.onFocus = (cb) => {
      focus = cb
      return () => {}
    }
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    pending = true
    watchers.get('/r/.git/worktrees')!('rename', 'worktrees')
    watchers.get('/r/.git')!('rename', 'worktrees')
    await vi.advanceTimersByTimeAsync(600)
    const n = listCalls(deps).length
    focus()
    await vi.advanceTimersByTimeAsync(10)
    expect(listCalls(deps).length).toBe(n + 1)
    pending = false
    watchers.get('/r/.git')!('rename', 'worktrees')
    expect(watchers.has('/r/.git/worktrees')).toBe(true)
    await vi.advanceTimersByTimeAsync(30_600)
    const m = listCalls(deps).length
    focus()
    await vi.advanceTimersByTimeAsync(10)
    expect(listCalls(deps).length).toBe(m)
    t.close()
  })

  it('AC-35: a child admin entry named `worktrees` does not leave the worktrees dir unwatched', async () => {
    vi.useFakeTimers()
    const { deps, watchers } = fakeDeps({ '/r': [wt('/r', 'main')] })
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    // `git worktree add ../worktrees` creates `<repoId>/worktrees/worktrees`: same name as the dir.
    watchers.get('/r/.git/worktrees')!('rename', 'worktrees')
    await vi.advanceTimersByTimeAsync(600)
    // The dir still exists (stat), so the re-list re-arms its watch; later changes are seen.
    expect(watchers.has('/r/.git/worktrees')).toBe(true)
    const n = listCalls(deps).length
    watchers.get('/r/.git/worktrees')!('rename', 'w2')
    await vi.advanceTimersByTimeAsync(600)
    expect(listCalls(deps).length).toBe(n + 1)
    t.close()
  })

  it('AC-13: a watch that errors after arming is closed and falls back to focus re-lists', async () => {
    vi.useFakeTimers()
    const { deps, errors, closed } = fakeDeps({ '/r': [wt('/r', 'main')] })
    let focus: () => void = () => {}
    deps.onFocus = (cb) => {
      focus = cb
      return () => {}
    }
    const t = createWorktreeTracker(deps, () => {})
    t.track([{ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] }])
    await vi.advanceTimersByTimeAsync(10)
    const n = listCalls(deps).length
    focus()
    await vi.advanceTimersByTimeAsync(10)
    expect(listCalls(deps).length).toBe(n)
    errors.get('/r/.git')!(Object.assign(new Error('no space'), { code: 'ENOSPC' }))
    expect(closed).toContain('/r/.git')
    focus()
    await vi.advanceTimersByTimeAsync(10)
    expect(listCalls(deps).length).toBe(n + 1)
    t.close()
  })
})
