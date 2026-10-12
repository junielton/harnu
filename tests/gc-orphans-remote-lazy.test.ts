import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createRemoteFactsService,
  REMOTE_FACTS_TTL_MS,
  type RemoteFactsDeps
} from '../src/main/gc/gc-remote-service'
import {
  createOpenPrLister,
  isRemoteCandidate,
  openPrRefsFromCache
} from '../src/main/gc/gc-remote-facts'
import type { RemoteFacts } from '../src/main/gc/gc-remote-delete'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import { bundle, reapItem } from './gc-fixtures'

/**
 * Delta-2 item 2: the remote facts of a branch are probed only when the remove dialog opens,
 * shared and cached for ten minutes, bounded in concurrency and in time, and the open pull requests
 * come from the scanner's bulk list when it can answer. A gather probes nothing.
 */

const GOOD: RemoteFacts = {
  remote: 'origin',
  remoteSha: 'a'.repeat(40),
  remoteMatchesLocal: true,
  openPr: false,
  ghProtected: false
}
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

function candidate(n: number, tip = 'a'.repeat(40)): WorktreeBundle {
  const b = bundle(`/ws/wt/b${n}`, 'ready')
  return {
    ...b,
    fate: { fate: 'merged', signal: 'gh-merged', strong: true },
    localTip: tip,
    item: reapItem(`/ws/wt/b${n}`, { branch: `feat/b${n}`, repoPath: '/ws/repo' })
  }
}

function harness(over: Partial<RemoteFactsDeps> = {}) {
  let t = 1_000_000
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  const service = createRemoteFactsService({
    now: () => t,
    probe: async () => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return GOOD
    },
    ...over
  })
  return {
    service,
    advance: (ms: number) => (t += ms),
    stats: () => ({ calls, maxInFlight })
  }
}

describe('the lazy, cached remote facts', () => {
  it('only a merged-PR branch is a candidate at all', () => {
    expect(isRemoteCandidate(candidate(1))).toBe(true)
    const ancestor = {
      ...candidate(2),
      fate: { fate: 'merged' as const, signal: 'ancestor' as const, strong: true }
    }
    expect(isRemoteCandidate(ancestor)).toBe(false)
  })

  it('opening twice within ten minutes probes once; after ten minutes it probes again', async () => {
    const h = harness()
    const b = candidate(1)
    expect(await h.service.facts([b])).toEqual({ [b.item.id]: GOOD })
    await h.service.facts([b])
    expect(h.stats().calls).toBe(1)
    h.advance(REMOTE_FACTS_TTL_MS - 1)
    await h.service.facts([b])
    expect(h.stats().calls).toBe(1)
    h.advance(2)
    await h.service.facts([b])
    expect(h.stats().calls).toBe(2)
  })

  it('a new local tip is a new question', async () => {
    const h = harness()
    await h.service.facts([candidate(1)])
    await h.service.facts([candidate(1, 'b'.repeat(40))])
    expect(h.stats().calls).toBe(2)
  })

  it('two dialogs opening together share one probe', async () => {
    const h = harness()
    const b = candidate(1)
    await Promise.all([h.service.facts([b]), h.service.facts([b])])
    expect(h.stats().calls).toBe(1)
  })

  it('a non-candidate is never probed', async () => {
    const h = harness()
    const plain = { ...candidate(1), fate: { fate: 'open' as const, signal: null, strong: false } }
    expect(await h.service.facts([plain])).toEqual({})
    expect(h.stats().calls).toBe(0)
  })

  it('probes at most four branches at a time', async () => {
    const h = harness()
    await h.service.facts(Array.from({ length: 12 }, (_v, i) => candidate(i)))
    expect(h.stats().calls).toBe(12)
    expect(h.stats().maxInFlight).toBeLessThanOrEqual(4)
  })

  it('a probe that hangs times out into "could not tell" and is not cached', async () => {
    let calls = 0
    const h = harness({
      timeoutMs: 20,
      probe: async () => {
        calls++
        return new Promise<RemoteFacts>(() => undefined)
      }
    })
    const b = candidate(1)
    const out = await h.service.facts([b])
    expect(out[b.item.id]).toEqual({
      remote: null,
      remoteSha: null,
      remoteMatchesLocal: null,
      openPr: null,
      ghProtected: null
    })
    await h.service.facts([b])
    expect(calls).toBe(2)
  })

  it('a probe that throws is also "could not tell", never an answer', async () => {
    const h = harness({
      probe: async () => {
        throw new Error('gh down')
      }
    })
    const b = candidate(1)
    expect((await h.service.facts([b]))[b.item.id]!.openPr).toBeNull()
  })
})

describe('the open pull requests come from the scanner list when it can answer', () => {
  const fresh = (rows: unknown[], over: Record<string, unknown> = {}) => ({
    version: 3,
    fetchedAt: 1,
    complete: true,
    prs: rows,
    ...over
  })
  it('reads head and base of OPEN rows', () => {
    const refs = openPrRefsFromCache(
      fresh([
        { state: 'OPEN', headRefName: 'feat/a', baseRefName: 'feat/x' },
        { state: 'MERGED', headRefName: 'feat/old', baseRefName: 'main' }
      ]),
      true,
      3
    )
    expect(refs).toEqual({ heads: ['feat/a'], bases: ['feat/x'] })
  })
  it.each([
    ['stale', fresh([]), false],
    ['capped (incomplete)', fresh([], { complete: false }), true],
    ['an old cache without base refs', fresh([{ state: 'OPEN', headRefName: 'a' }]), true],
    ['another cache version', fresh([], { version: 1 }), true],
    ['nothing there', null, true]
  ])('%s: cannot answer', (_why, entry, isFresh) => {
    expect(openPrRefsFromCache(entry, isFresh, 3)).toBeNull()
  })

  it('with the scanner list there are no gh calls; without it one list per repo, not per branch', async () => {
    let ghCalls = 0
    const lister = createOpenPrLister({
      now: () => 1,
      fromScanner: async (repo) =>
        repo === '/ws/scanned' ? { heads: ['feat/a'], bases: ['feat/x'] } : null,
      list: async () => {
        ghCalls++
        return JSON.stringify([{ headRefName: 'feat/a', baseRefName: 'main' }])
      }
    })
    expect(await lister('/ws/scanned', 'o/r', 'feat/x')).toBe(true)
    expect(await lister('/ws/scanned', 'o/r', 'feat/zzz')).toBe(false)
    expect(ghCalls).toBe(0)
    for (const br of ['feat/a', 'feat/b', 'feat/c', 'feat/d']) await lister('/ws/other', 'o/r', br)
    expect(ghCalls).toBe(1)
  })

  it('a failing gh list is unknown, and is retried rather than remembered', async () => {
    let ghCalls = 0
    const lister = createOpenPrLister({
      now: () => 1,
      fromScanner: async () => null,
      list: async () => {
        ghCalls++
        throw new Error('gh down')
      }
    })
    expect(await lister('/ws/r', 'o/r', 'feat/a')).toBeNull()
    expect(await lister('/ws/r', 'o/r', 'feat/a')).toBeNull()
    expect(ghCalls).toBe(2)
  })
})

describe('wiring', () => {
  it('a gather never probes remote facts (no gh, no ls-remote)', () => {
    const scan = read('src/main/gc/gc-scan-shell.ts')
    expect(scan).not.toMatch(/attachRemoteFacts|gc-remote-shell|probeRemoteFacts/)
    expect(scan).not.toMatch(/ls-remote/)
  })

  it('the probe is reached from one request channel, registered in main and the preload', () => {
    expect(read('src/main/gc/gc-ipc.ts')).toMatch(/ipcMain\.handle\('gc:remoteFacts'/)
    expect(read('src/preload/index.ts')).toMatch(/invoke\(\s*'gc:remoteFacts'/)
  })

  it('the screen probes when the confirm opens, not when the snapshot loads', () => {
    const view = read('src/renderer/src/components/CleanupView.vue')
    expect(view).toMatch(/probeRemote\(/)
    expect(read('src/renderer/src/stores/gc.ts')).not.toMatch(
      /probeRemote\([^)]*\)[^\n]*refresh|gcSnapshot[^\n]*probeRemote/
    )
  })

  it('the remote-facts field is gone from the bundle: it travels apart from the snapshot', () => {
    expect(read('src/main/gc/bundle-core.ts')).not.toMatch(/remoteFacts\??:/)
  })
})
