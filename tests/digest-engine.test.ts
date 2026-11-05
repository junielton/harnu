import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
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
  type CatchUpSession,
  type DigestEngineDeps
} from '../src/main/mcp/digest-engine'
import { emptyFacts, type TranscriptFacts } from '../src/main/mcp/digest-transcript'
import type { DigestCommit, GitEvidence } from '../src/main/mcp/digest-core'
import { gatherGitEvidence } from '../src/main/mcp/digest-io'
import { deriveTranscriptTruth } from '../src/main/transcript-truth'

/**
 * Every `git` command `digest-io.ts` spawns, recorded by wrapping `execFile`'s promisified
 * form (the one `promisify(execFile)` picks up) around the real one.
 */
const gitCalls = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const realAsync = promisify(real.execFile)
  const execFile = ((...args: Parameters<typeof real.execFile>) =>
    real.execFile(...args)) as typeof real.execFile
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: string[], opts: object) => {
      if (file === 'git') gitCalls.push(args)
      return realAsync(file, args, opts)
    }
  })
  return { ...real, execFile }
})

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
    memoryCheckout: vi.fn(async (folder: string) => folder),
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

  it('skips a session too short to digest', async () => {
    const short = fakes({
      readFacts: vi.fn(async () => ({ facts: { ...emptyFacts(), userTurns: 2 }, offset: 1 }))
    })
    const a = createDigestEngine(short.deps)
    await a.digestNow('s6', 'ended')
    expect(short.deps.readTruth).not.toHaveBeenCalled()
    expect(short.deps.writeDigest).not.toHaveBeenCalled()
  })

  it('writes a non-git digest', async () => {
    // A real folder outside any git work tree, probed by the real git probe.
    const plain = await mkdtemp(join(os.tmpdir(), 'memory-u1-plain-'))
    try {
      const f = fakes({
        resolveSession: vi.fn(async (id: string) => ({
          transcriptPath: `/t/${id}.jsonl`,
          folder: plain,
          branch: 'main'
        })),
        gatherGit: vi.fn(gatherGitEvidence)
      })
      const engine = createDigestEngine(f.deps)
      gitCalls.length = 0
      await engine.digestNow('s7', 'ended')

      // One probe, and no other git command after it.
      expect(gitCalls).toEqual([['-C', plain, 'rev-parse', '--is-inside-work-tree']])
      expect(f.deps.gatherGit).toHaveBeenCalledTimes(1)
      await expect(f.deps.gatherGit.mock.results[0].value).resolves.toEqual({
        kind: 'not-a-repo'
      })

      expect(f.deps.writeDigest).toHaveBeenCalledTimes(1)
      const [folder, page, entry] = f.deps.writeDigest.mock.calls[0]
      expect(folder).toBe(plain)
      expect(page).toBe('sessions/2026-11-03-s7')
      const header = (entry as string).split('\n')[2]
      expect(header).toBe('_Session `s7` · ended · auto-digest · evidence: no-git_')
      expect(header).not.toContain('branch')
      expect(entry).toContain('_Not a git repository: no git evidence._')
      expect(f.deps.writeHot).toHaveBeenCalledTimes(1)

      // The digest is remembered: a second end with nothing new plans `unchanged`.
      await engine.digestNow('s7', 'ended')
      expect(f.deps.writeDigest).toHaveBeenCalledTimes(1)
      engine.close()
    } finally {
      await rm(plain, { recursive: true, force: true })
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

  it('attributes commits through subagent windows and saves state after a write', async () => {
    const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000)
    const c = (subject: string, iso: string): DigestCommit => ({
      hash: subject.padEnd(40, '0'),
      shortHash: subject.padEnd(8, '0'),
      committedAt: at(iso),
      subject
    })
    const own = c('own', '2026-11-03T10:10:01.000Z')
    const sub = c('sub', '2026-11-03T10:20:01.000Z')
    const other = c('other', '2026-11-03T10:30:01.000Z')
    const win = (iso: string): { startMs: number; endMs: number } => ({
      startMs: Date.parse(iso) - 2_000,
      endMs: Date.parse(iso) + 7_000
    })
    const main: TranscriptFacts = {
      ...emptyFacts(),
      userTurns: 3,
      firstAt: '2026-11-03T10:00:00.000Z',
      lastAt: '2026-11-03T11:00:00.000Z',
      gitCalls: [win('2026-11-03T10:10:00.000Z')]
    }
    const subFacts: TranscriptFacts = {
      ...emptyFacts(),
      gitCalls: [win('2026-11-03T10:20:00.000Z')]
    }
    const saved: unknown[] = []
    const f = fakes({
      readFacts: vi.fn(async (path: string) =>
        path.includes('/subagents/') ? { facts: subFacts, offset: 9 } : { facts: main, offset: 100 }
      ),
      gatherGit: vi.fn(async () => ({
        kind: 'repo' as const,
        head: HEAD,
        commits: [other, sub, own],
        fileStats: [{ file: 'range-wide.ts', added: 9, deleted: 9 }],
        dirtyCount: 0
      })),
      subagentTranscripts: vi.fn(async (id: string) => [`/t/${id}/subagents/agent-1.jsonl`]),
      commitFileStats: vi.fn(async () => [{ file: 'mine.ts', added: 2, deleted: 1 }]),
      saveState: vi.fn((s: unknown) => saved.push(s))
    })
    const engine = createDigestEngine(f.deps)
    await engine.digestNow('s20', 'ended')
    expect(f.deps.subagentTranscripts).toHaveBeenCalledWith('s20')
    expect(f.deps.readFacts).toHaveBeenCalledWith('/t/s20/subagents/agent-1.jsonl')
    expect(f.deps.commitFileStats).toHaveBeenCalledWith('/repo', [sub.hash, own.hash])
    const entry = f.deps.writeDigest.mock.calls[0][2] as string
    expect(entry).toContain('**Commits (2)**')
    expect(entry).toContain('`sub00000` sub')
    expect(entry).toContain('`own00000` own')
    expect(entry).not.toContain('`other000`')
    expect(entry).toContain('`mine.ts`')
    expect(entry).not.toContain('range-wide.ts')
    expect(entry).toContain(
      '_1 other commit landed on this checkout during the session (not attributed to it)._'
    )
    // The hot snapshot lists the session's own commits only.
    const hot = f.deps.writeHot.mock.calls[0][4] as string
    expect(hot).not.toContain('other')
    // State is saved once, after the write, with what the digest saw.
    expect(saved).toHaveLength(1)
    expect(saved[0]).toEqual({
      version: 1,
      sessions: {
        s20: {
          lastDigestAt: NOW,
          last: { head: HEAD, userTurns: 3 },
          scan: { offset: 100, facts: main }
        }
      }
    })
    // A skipped digest saves nothing.
    await engine.digestNow('s20', 'ended')
    expect(saved).toHaveLength(1)
    engine.close()

    // Without commitFileStats, a narrowed digest shows no files line rather than another's files.
    const bare = fakes({
      readFacts: f.deps.readFacts,
      gatherGit: f.deps.gatherGit,
      subagentTranscripts: f.deps.subagentTranscripts
    })
    await createDigestEngine(bare.deps).digestNow('s21', 'ended')
    const bareEntry = bare.deps.writeDigest.mock.calls[0][2] as string
    expect(bareEntry).toContain('**Commits (2)**')
    expect(bareEntry).not.toContain('**Files')
  })

  it('merges hot.md with the snapshot on disk instead of overwriting it', async () => {
    const onDisk = (branch: string | null): string =>
      `**Now:**\n> Other branch work\n\nFull digest: [[sessions/2026-11-01-oooooooo]]\n\n> provenance: author=agent · at=2026-11-01${branch ? ` · branch=${branch}` : ''} · session=o1\n`
    const withQuestions: TranscriptFacts = {
      ...emptyFacts(),
      userTurns: 3,
      firstAt: '2026-11-03T10:00:00.000Z',
      lastAt: '2026-11-03T11:00:00.000Z',
      openQuestions: ['Should we migrate old entries?']
    }
    const truth = deriveTranscriptTruth([
      { type: 'last-prompt', lastPrompt: 'a prompt the questions outrank' }
    ])

    // Another branch's snapshot is kept; the new one becomes a Parallel line, and the stamp
    // written next names the branch the body belongs to.
    {
      const f = fakes({
        readHot: vi.fn(async () => onDisk('feat/other')),
        readFacts: vi.fn(async () => ({ facts: withQuestions, offset: 1 })),
        readTruth: vi.fn(async () => truth)
      })
      await createDigestEngine(f.deps).digestNow('s30', 'ended')
      expect(f.deps.readHot).toHaveBeenCalledWith('/repo')
      expect(f.deps.writeHot).toHaveBeenCalledTimes(1)
      const [folder, sessionId, stampBranch, , hot] = f.deps.writeHot.mock.calls[0] as string[]
      expect([folder, sessionId, stampBranch]).toEqual(['/repo', 's30', 'feat/other'])
      expect(hot).toContain('> Other branch work')
      expect(hot).not.toContain('> provenance:')
      expect(hot).toContain(
        '**Parallel:**\n- `main` · 2026-11-03 · Session s30 → [[sessions/2026-11-03-s30]]'
      )
    }

    // The same branch, no hot at all, a hot without a branch stamp and a deps without readHot all
    // replace; the open questions are Next, and the stamp names the new snapshot's branch.
    for (const readHot of [
      vi.fn(async () => onDisk('main')),
      vi.fn(async () => null),
      vi.fn(async () => onDisk(null)),
      undefined
    ]) {
      const f = fakes({
        ...(readHot ? { readHot } : {}),
        readFacts: vi.fn(async () => ({ facts: withQuestions, offset: 1 })),
        readTruth: vi.fn(async () => truth)
      })
      await createDigestEngine(f.deps).digestNow('s31', 'ended')
      const [, , stampBranch, , hot] = f.deps.writeHot.mock.calls[0] as string[]
      expect(stampBranch).toBe('main')
      expect(hot).not.toContain('Other branch work')
      expect(hot).not.toContain('**Parallel:**')
      expect(hot).toContain('**Next:**\n> - Should we migrate old entries?')
      expect(hot).not.toContain('a prompt the questions outrank')
    }

    // A folder outside git is keyed by its path and its hot carries no branch stamp: it replaces,
    // and the snapshot it writes gets no branch stamp of its own.
    {
      const f = fakes({
        readHot: vi.fn(async () => onDisk(null)),
        gatherGit: vi.fn(async () => ({ kind: 'not-a-repo' as const })),
        resolveSession: vi.fn(async (id: string) => ({
          transcriptPath: `/t/${id}.jsonl`,
          folder: '/plain'
        }))
      })
      await createDigestEngine(f.deps).digestNow('s32', 'ended')
      const [, , stampBranch, , hot] = f.deps.writeHot.mock.calls[0] as unknown[]
      expect(stampBranch).toBeUndefined()
      expect(hot).not.toContain('Other branch work')
      expect(hot).not.toContain('**Parallel:**')
    }

    // A hot.md that cannot be read is not overwritten blind: the digest stands, the hot waits.
    {
      const f = fakes({
        readHot: vi.fn(async () => {
          throw new Error('EIO')
        })
      })
      const err = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await createDigestEngine(f.deps).digestNow('s33', 'ended')
      } finally {
        err.mockRestore()
      }
      expect(f.deps.writeDigest).toHaveBeenCalledTimes(1)
      expect(f.deps.writeHot).not.toHaveBeenCalled()
    }
  })

  it('keys a git folder by its branch when the transcript names none', async () => {
    const noBranch = (folder: string) => async (id: string) => ({
      transcriptPath: `/t/${id}.jsonl`,
      folder
    })
    const hotOf = (branch: string | null, extra = ''): string =>
      `**Now:**\n> Earlier work\n\nFull digest: [[sessions/2026-11-01-oooooooo]]\n${extra}\n> provenance: author=agent · at=2026-11-01${branch ? ` · branch=${branch}` : ''} · session=o1\n`

    // The folder's own branch is the key: the same one replaces, whatever the transcript said.
    {
      const f = fakes({
        resolveSession: vi.fn(noBranch('/repo')),
        folderBranch: vi.fn(async () => 'feat/x'),
        readHot: vi.fn(async () =>
          hotOf('feat/x', '\n**Parallel:**\n- `feat/y` · 2026-11-01 · Y → [[sessions/y]]')
        )
      })
      await createDigestEngine(f.deps).digestNow('s40', 'ended')
      expect(f.deps.folderBranch).toHaveBeenCalledWith('/repo')
      const [, , stampBranch, , hot] = f.deps.writeHot.mock.calls[0] as string[]
      expect(stampBranch).toBe('feat/x')
      expect(hot).not.toContain('Earlier work')
      expect(hot).toContain('no new commits on `feat/x`')
      // The other branch's parallel line survives a same-branch replace.
      expect(hot).toContain('**Parallel:**\n- `feat/y` · 2026-11-01 · Y → [[sessions/y]]')
    }

    // Another branch's hot is kept, and the folder's branch (not its path) is the line's key.
    {
      const f = fakes({
        resolveSession: vi.fn(noBranch('/repo')),
        folderBranch: vi.fn(async () => 'feat/x'),
        readHot: vi.fn(async () => hotOf('feat/other'))
      })
      await createDigestEngine(f.deps).digestNow('s41', 'ended')
      const [, , stampBranch, , hot] = f.deps.writeHot.mock.calls[0] as string[]
      expect(stampBranch).toBe('feat/other')
      expect(hot).toContain('- `feat/x` · 2026-11-03 ·')
      expect(hot).not.toContain('`/repo`')
    }

    // A transcript's own branch wins and the git probe is not asked; a folder outside git is
    // keyed by its path and the probe is not asked either.
    {
      const named = fakes({ folderBranch: vi.fn(async () => 'never') })
      await createDigestEngine(named.deps).digestNow('s42', 'ended')
      expect(named.deps.folderBranch).not.toHaveBeenCalled()
      expect((named.deps.writeHot.mock.calls[0] as string[])[2]).toBe('main')

      const plain = fakes({
        resolveSession: vi.fn(noBranch('/plain')),
        gatherGit: vi.fn(async () => ({ kind: 'not-a-repo' as const })),
        folderBranch: vi.fn(async () => 'never')
      })
      await createDigestEngine(plain.deps).digestNow('s43', 'ended')
      expect(plain.deps.folderBranch).not.toHaveBeenCalled()
      expect((plain.deps.writeHot.mock.calls[0] as unknown[])[2]).toBeUndefined()
    }

    // A probe that fails or finds no branch (detached HEAD) leaves the key a path: no stamp.
    for (const folderBranch of [
      vi.fn(async () => undefined),
      vi.fn(async () => {
        throw new Error('boom')
      })
    ]) {
      const f = fakes({ resolveSession: vi.fn(noBranch('/repo')), folderBranch })
      await createDigestEngine(f.deps).digestNow('s44', 'ended')
      expect((f.deps.writeHot.mock.calls[0] as unknown[])[2]).toBeUndefined()
    }
  })

  it('catches up quiet undigested sessions one after another', async () => {
    const turns: Record<string, number> = { a: 5, b: 3, c: 1, d: 4, home: 6, done: 4 }
    let running = 0
    let overlapped = false
    const f = fakes({
      resolveSession: vi.fn(async (id: string) => ({
        transcriptPath: `/t/${id}.jsonl`,
        folder: id === 'home' ? os.homedir() : `/f/${id}`
      })),
      readFacts: vi.fn(async (path: string) => {
        const id = path.slice(3, -6)
        return {
          facts: {
            ...emptyFacts(),
            userTurns: turns[id] ?? 0,
            firstAt: '2026-11-03T10:00:00.000Z',
            lastAt: '2026-11-03T11:00:00.000Z'
          },
          offset: 1
        }
      }),
      writeDigest: vi.fn(async () => {
        running++
        if (running > 1) overlapped = true
        await Promise.resolve()
        running--
        return { ok: true }
      }),
      hasDigest: vi.fn(async (_folder: string, id: string) => id === 'done')
    })
    const engine = createDigestEngine(f.deps)
    const s = (id: string, ageMin: number): CatchUpSession => ({
      sessionId: id,
      folder: id === 'home' ? os.homedir() : `/f/${id}`,
      transcriptPath: `/t/${id}.jsonl`,
      mtimeMs: NOW - ageMin * 60_000
    })
    const list = [s('a', 30), s('b', 600), s('c', 60), s('d', 2), s('home', 90), s('done', 45)]
    const digested = await engine.catchUp(list)
    // b is oldest, then a; c has one turn, d is still live, home is an unsafe root, done has one.
    expect(digested).toEqual(['b', 'a'])
    expect(f.deps.writeDigest.mock.calls.map((c) => c[3])).toEqual(['b', 'a'])
    for (const call of f.deps.writeDigest.mock.calls) {
      expect(call[2]).toContain(' · caught up · ')
    }
    expect(overlapped).toBe(false)
    expect(f.deps.hasDigest).not.toHaveBeenCalledWith(os.homedir(), 'home')

    // A second pass digests nothing again: the digested sessions have state now.
    expect(await engine.catchUp(list)).toEqual([])
    expect(f.deps.writeDigest).toHaveBeenCalledTimes(2)
    engine.close()
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
