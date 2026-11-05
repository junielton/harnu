import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  addTaskEventObserver,
  configureHub,
  ingest,
  resetHubForTests,
  type HookTaskEvent
} from '../src/main/detect/task-state-hub'
import {
  createDigestEngine,
  LONG_IDLE_MS,
  type DigestEngineDeps
} from '../src/main/mcp/digest-engine'
import { emptyFacts, type TranscriptFacts } from '../src/main/mcp/digest-transcript'
import type { GitEvidence } from '../src/main/mcp/digest-core'
import { deriveTranscriptTruth } from '../src/main/transcript-truth'

/**
 * Memory U1 S-2: the digest engine's control flow with every I/O dep faked
 * (`src/main/mcp/digest-engine.ts`; spec "The engine").
 */

const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const HEAD = 'a'.repeat(40)

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Fakes for every dep, plus a hand-driven timer table. */
function fakes(over: Partial<DigestEngineDeps> = {}): {
  deps: DigestEngineDeps & Record<string, ReturnType<typeof vi.fn>>
  timers: Map<number, { fn: () => unknown; ms: number }>
  fire(handle: number): Promise<void>
} {
  const facts: TranscriptFacts = {
    ...emptyFacts(),
    userTurns: 3,
    firstAt: '2026-11-03T10:00:00.000Z',
    lastAt: '2026-11-03T11:00:00.000Z'
  }
  const git: GitEvidence = { kind: 'repo', head: HEAD, commits: [], fileStats: [], dirtyCount: 0 }
  const timers = new Map<number, { fn: () => unknown; ms: number }>()
  let next = 1
  const deps = {
    resolveSession: vi.fn(async (id: string) => ({
      transcriptPath: `/t/${id}.jsonl`,
      folder: '/repo',
      branch: 'main',
      created: '2026-11-03T09:00:00.000Z'
    })),
    readFacts: vi.fn(async () => ({ facts, offset: 100 })),
    readTruth: vi.fn(async () => deriveTranscriptTruth([])),
    gatherGit: vi.fn(async () => git),
    writeDigest: vi.fn(async () => ({ ok: true })),
    writeHot: vi.fn(async () => undefined),
    now: vi.fn(() => NOW),
    setTimer: vi.fn((fn: () => void, ms: number) => {
      const h = next++
      timers.set(h, { fn, ms })
      return h
    }),
    clearTimer: vi.fn((h: unknown) => {
      timers.delete(h as number)
    }),
    ...over
  } as unknown as DigestEngineDeps & Record<string, ReturnType<typeof vi.fn>>
  return {
    deps,
    timers,
    async fire(handle: number) {
      const t = timers.get(handle)
      if (!t) throw new Error(`no timer ${handle}`)
      timers.delete(handle)
      await t.fn()
    }
  }
}

const edge = (sessionId: string, event: string, taskState: string): HookTaskEvent =>
  ({ sessionId, event, taskState, ts: NOW, source: 'hook' }) as HookTaskEvent

describe('createDigestEngine', () => {
  it('drives digests from hook edges', async () => {
    // A PreCompact edge writes once, as a compaction.
    {
      const f = fakes()
      const engine = createDigestEngine(f.deps)
      await engine.onTaskEdge(edge('s1', 'PreCompact', 'working'))
      expect(f.deps.writeDigest).toHaveBeenCalledTimes(1)
      const [folder, page, entry, sessionId] = f.deps.writeDigest.mock.calls[0]
      expect(folder).toBe('/repo')
      expect(page).toBe('sessions/2026-11-03-s1')
      expect(sessionId).toBe('s1')
      expect(entry).toContain(' · compacted · auto-digest · evidence: no-commits_')
      expect(f.deps.writeHot).toHaveBeenCalledTimes(1)
      engine.close()
    }

    // Two SessionEnd edges write once: the second reads and probes again, then plans unchanged.
    {
      const f = fakes()
      const engine = createDigestEngine(f.deps)
      await engine.onTaskEdge(edge('s2', 'SessionEnd', 'completed'))
      await engine.onTaskEdge(edge('s2', 'SessionEnd', 'completed'))
      expect(f.deps.readFacts).toHaveBeenCalledTimes(2)
      expect(f.deps.gatherGit).toHaveBeenCalledTimes(2)
      expect(f.deps.writeDigest).toHaveBeenCalledTimes(1)
      // The second read resumes from the first one's offset and facts.
      expect(f.deps.readFacts.mock.calls[1][1]).toMatchObject({ offset: 100 })
      // The second probe passes the first digest's head as the baseline.
      expect(f.deps.gatherGit.mock.calls[1][2]).toBe(HEAD)
      engine.close()
    }

    // Going idle arms the timer; working again cancels it, and nothing is written.
    {
      const f = fakes()
      const engine = createDigestEngine(f.deps)
      expect(engine.onTaskEdge(edge('s3', 'Stop', 'idle'))).toBeUndefined()
      expect(f.timers.size).toBe(1)
      const [handle, timer] = [...f.timers][0]
      expect(timer.ms).toBe(LONG_IDLE_MS)
      expect(engine.onTaskEdge(edge('s3', 'UserPromptSubmit', 'working'))).toBeUndefined()
      expect(f.deps.clearTimer).toHaveBeenCalledWith(handle)
      expect(f.timers.size).toBe(0)
      expect(f.deps.writeDigest).not.toHaveBeenCalled()
      engine.close()
    }

    // An idle session writes once when the timer fires after LONG_IDLE_MS.
    {
      const f = fakes()
      const engine = createDigestEngine(f.deps)
      engine.onTaskEdge(edge('s4', 'Stop', 'idle'))
      expect(f.deps.writeDigest).not.toHaveBeenCalled()
      const [handle, timer] = [...f.timers][0]
      expect(timer.ms).toBe(LONG_IDLE_MS)
      await f.fire(handle)
      expect(f.deps.writeDigest).toHaveBeenCalledTimes(1)
      expect(f.deps.writeDigest.mock.calls[0][2]).toContain(' · went idle · ')
      engine.close()
    }

    // A digest trigger while a digest is in flight does not start a second read.
    {
      const held = deferred<{ facts: TranscriptFacts; offset: number }>()
      const f = fakes({ readFacts: vi.fn(() => held.promise) })
      const engine = createDigestEngine(f.deps)
      const first = engine.onTaskEdge(edge('s5', 'SessionEnd', 'completed'))
      await Promise.resolve()
      await Promise.resolve()
      await engine.onTaskEdge(edge('s5', 'PreCompact', 'completed'))
      expect(f.deps.readFacts).toHaveBeenCalledTimes(1)
      held.resolve({ facts: { ...emptyFacts(), userTurns: 4 }, offset: 7 })
      await first
      expect(f.deps.readFacts).toHaveBeenCalledTimes(1)
      expect(f.deps.writeDigest).toHaveBeenCalledTimes(1)
      engine.close()
    }
  })

  it('skips a session too short to digest and a folder that is not a git repository', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const short = fakes({
        readFacts: vi.fn(async () => ({ facts: { ...emptyFacts(), userTurns: 2 }, offset: 1 }))
      })
      const a = createDigestEngine(short.deps)
      await a.digestNow('s6', 'ended')
      expect(short.deps.readTruth).not.toHaveBeenCalled()
      expect(short.deps.writeDigest).not.toHaveBeenCalled()

      // Until S-3, a no-git plan is skipped: no digest, no hot, and no `last` recorded.
      const plain = fakes({ gatherGit: vi.fn(async () => ({ kind: 'not-a-repo' }) as const) })
      const b = createDigestEngine(plain.deps)
      await b.digestNow('s7', 'ended')
      await b.digestNow('s7', 'ended')
      expect(plain.deps.writeDigest).not.toHaveBeenCalled()
      expect(plain.deps.writeHot).not.toHaveBeenCalled()
      expect(plain.deps.gatherGit.mock.calls[1][2]).toBeNull()
      expect(log).toHaveBeenCalledWith('[memory-digest] skipped: not a git repository')
    } finally {
      log.mockRestore()
    }
  })

  it('picks the since time, the title, and survives a refused write or a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // since: facts.firstAt, else created, else a day before now.
      const f = fakes({
        readFacts: vi.fn(async () => ({
          facts: { ...emptyFacts(), userTurns: 3 },
          offset: 1
        }))
      })
      const e = createDigestEngine(f.deps)
      await e.digestNow('s8', 'ended')
      expect(f.deps.gatherGit.mock.calls[0][1]).toBe(
        Math.floor(Date.parse('2026-11-03T09:00:00.000Z') / 1000)
      )
      f.deps.resolveSession.mockResolvedValueOnce({
        transcriptPath: '/t/x',
        folder: '/repo',
        summary: 'A summary title'
      })
      await e.digestNow('s9', 'ended')
      expect(f.deps.gatherGit.mock.calls[1][1]).toBe(Math.floor(NOW / 1000) - 86_400)
      expect(f.deps.writeDigest.mock.calls[1][2].split('\n')[0]).toBe('# A summary title')
      // The first digest had no title source: `Session <id8>`.
      expect(f.deps.writeDigest.mock.calls[0][2].split('\n')[0]).toBe('# Session s8')

      // A refused write logs and writes no hot.
      const refused = fakes({
        writeDigest: vi.fn(async () => ({ ok: false, error: 'BAD_ENTRY', detail: 'too long' }))
      })
      await createDigestEngine(refused.deps).digestNow('s10', 'ended')
      expect(warn).toHaveBeenCalledWith(
        '[memory-digest] digest write refused (BAD_ENTRY): too long'
      )
      expect(refused.deps.writeHot).not.toHaveBeenCalled()

      // A throw is logged and swallowed, and the session is no longer in flight.
      const boom = fakes()
      boom.deps.gatherGit.mockRejectedValueOnce(new Error('boom'))
      const g = createDigestEngine(boom.deps)
      await expect(g.digestNow('s11', 'ended')).resolves.toBeUndefined()
      expect(error).toHaveBeenCalledWith('[memory-digest] digest failed', expect.any(Error))
      await g.digestNow('s11', 'ended')
      expect(boom.deps.writeDigest).toHaveBeenCalledTimes(1)

      // An unknown session does nothing.
      const none = fakes({ resolveSession: vi.fn(async () => null) })
      await createDigestEngine(none.deps).digestNow('s12', 'ended')
      expect(none.deps.readFacts).not.toHaveBeenCalled()

      // close() clears every armed timer, and later edges are ignored.
      const c = fakes()
      const ce = createDigestEngine(c.deps)
      ce.onTaskEdge(edge('s13', 'Stop', 'idle'))
      ce.close()
      expect(c.timers.size).toBe(0)
      expect(ce.onTaskEdge(edge('s13', 'SessionEnd', 'completed'))).toBeUndefined()
      expect(c.deps.readFacts).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })
})

describe('through the task-state hub', () => {
  beforeEach(() => {
    resetHubForTests()
    configureHub({ isHibernated: () => false })
  })
  afterEach(() => resetHubForTests())

  it('a PreCompact hook event reaches the engine through the hub', async () => {
    const f = fakes()
    const engine = createDigestEngine(f.deps)
    const off = addTaskEventObserver(engine.onTaskEdge)
    try {
      ingest({ sessionId: 's14', event: 'PreCompact', ts: NOW, source: 'hook' }, () => null)
      await vi.waitFor(() => expect(f.deps.writeDigest).toHaveBeenCalledTimes(1))
      expect(f.deps.writeDigest.mock.calls[0][2]).toContain(' · compacted · ')
    } finally {
      off()
      engine.close()
    }
  })
})
