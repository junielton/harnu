import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import {
  digestOrphans,
  fsOrphanSessions,
  inspectOrphanTranscript,
  ownerRepoFor,
  type OrphanDigestDeps,
  type OrphanSessionFile
} from '../src/main/gc/gc-orphan-digest'
import { orphanTranscriptId, type OrphanTranscriptItem } from '../src/main/gc/gc-orphan-transcripts'
import { slugOfPath } from '../src/main/gc/gc-transcripts'
import { createDigestEngine, type DigestEngine } from '../src/main/mcp/digest-engine'
import {
  commitFileStats,
  gatherGitEvidence,
  hasSessionDigest,
  listSubagentTranscripts,
  readTranscriptFacts,
  readTranscriptTruth
} from '../src/main/mcp/digest-io'
import { memoryDirFor, resolveMemoryCheckout } from '../src/main/mcp/memory-core'
import { appendMemoryEntry } from '../src/main/mcp/memory-store'
import { probeGitMeta } from '../src/main/git-probe'
import { atMinute, buildMemoryU1Home, type MemoryU1Home } from './helpers/memory-u1-fixture'

/**
 * Memory U1 S-5: the sessions of orphaned transcripts are digested into their owning repo's memory
 * at Cleanup gather time, before the row is shown, so trashing the transcripts loses nothing.
 */

const REPLAY = atMinute(2 * 24 * 60)
const id = (id8: string): string => `${id8}-0000-4000-8000-000000000000`

let tmp: string
let fx: MemoryU1Home

beforeAll(async () => {
  tmp = await mkdtemp(join(os.tmpdir(), 'memory-u1-'))
  fx = await buildMemoryU1Home(tmp)
}, 60_000)

// Each test starts with the owning repo's memory empty.
afterEach(async () => {
  await rm(join(fx.repo, '.harnu'), { recursive: true, force: true })
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** The real engine over the fixture, writing through the real memory store. */
const hotCalls: string[] = []

function engineOver(): DigestEngine {
  return createDigestEngine({
    resolveSession: async () => null,
    readFacts: readTranscriptFacts,
    readTruth: readTranscriptTruth,
    gatherGit: gatherGitEvidence,
    writeDigest: (folder, page, entry, sessionId) =>
      appendMemoryEntry({
        memoryDir: memoryDirFor(folder),
        page,
        entry,
        author: 'agent',
        sessionId,
        now: REPLAY
      }),
    writeHot: async (folder) => void hotCalls.push(folder),
    memoryCheckout: async (folder) =>
      resolveMemoryCheckout(folder, (await probeGitMeta(folder)).repoId),
    subagentTranscripts: async (sid) => listSubagentTranscripts(fx.transcriptOf(sid), sid),
    commitFileStats,
    now: () => REPLAY,
    setTimer: () => {
      throw new Error('no timer')
    },
    clearTimer: () => undefined
  })
}

function goneItem(sessionCount = 2): OrphanTranscriptItem {
  const slug = slugOfPath(fx.gone)
  return {
    id: orphanTranscriptId(slug),
    slug,
    folder: fx.gone,
    repoLabel: 'repo',
    bytes: 1,
    sessionCount,
    proof: 'proven',
    newestAt: null,
    hasMemory: false
  }
}

function realDeps(engine: DigestEngine, calls: string[] = []): OrphanDigestDeps {
  return {
    repoPaths: [fx.repo],
    probe: {
      exists: async (p) => existsSync(p),
      isCheckout: async (p) => existsSync(join(p, '.git'))
    },
    sessionsOf: fsOrphanSessions(join(fx.home, '.claude', 'projects')),
    inspect: inspectOrphanTranscript,
    hasDigest: (home, sid) => hasSessionDigest(memoryDirFor(home), sid),
    digest: async (args) => {
      calls.push(args.sessionId)
      await engine.digestTranscriptInto(args)
    }
  }
}

describe('ownerRepoFor', () => {
  const REPO = '/w/org/proj'
  const exists = (...present: string[]) => ({
    exists: async (p: string) => present.includes(p),
    isCheckout: async (p: string) => present.includes(p)
  })

  it('resolves the owning repo and never writes under the gone folder', async () => {
    const gone = `${REPO}/.claude/worktrees/feature-x`
    // The longest existing known repo that contains the folder.
    expect(await ownerRepoFor(gone, ['/w/org', REPO, '/other'], exists('/w/org', REPO))).toBe(REPO)
    expect(await ownerRepoFor(gone, ['/w/org', REPO], exists('/w/org'))).toBe('/w/org')
    // A known repo that no longer exists is skipped; the `.claude/worktrees` parent answers.
    expect(await ownerRepoFor(gone, [REPO], exists(REPO))).toBe(REPO)
    expect(await ownerRepoFor(gone, [], exists(REPO))).toBe(REPO)
    // The parent must be a git checkout.
    expect(
      await ownerRepoFor(gone, [], {
        exists: async () => true,
        isCheckout: async () => false
      })
    ).toBeNull()
    // The `<repo>-worktrees` and `<repo>.worktrees` siblings.
    expect(await ownerRepoFor('/w/org/proj-worktrees/PROJ-1', [], exists('/w/org/proj'))).toBe(
      '/w/org/proj'
    )
    expect(await ownerRepoFor('/w/org/proj.worktrees/PROJ-1', [], exists('/w/org/proj'))).toBe(
      '/w/org/proj'
    )
    // Nothing known and nothing named: none.
    expect(await ownerRepoFor('/elsewhere/gone', [], exists())).toBeNull()
    // The gone folder, or a path under it, is never the answer, even when known and "existing".
    const inside = `${gone}/sub`
    expect(await ownerRepoFor(gone, [gone, inside], exists(gone, inside))).toBeNull()
    expect(await ownerRepoFor(gone, [gone, REPO], exists(gone, REPO))).toBe(REPO)

    // And the engine, over the fixture's gone worktree, writes into the owning repo only.
    expect(await ownerRepoFor(fx.gone, [fx.repo], realDeps(engineOver()).probe)).toBe(fx.repo)
    const engine = engineOver()
    await engine.digestTranscriptInto({
      sessionId: id('a1000009'),
      transcriptPath: fx.transcriptOf(id('a1000009')),
      memoryFolder: fx.repo,
      branch: 'feature-x'
    })
    expect(existsSync(fx.gone)).toBe(false)
    expect(existsSync(join(fx.repo, '.claude', 'worktrees'))).toBe(false)
    const files = await fs.readdir(join(memoryDirFor(fx.repo), 'sessions'))
    expect(files.some((n) => /^\d{4}-\d{2}-\d{2}-a1000009\.md$/.test(n))).toBe(true)
    engine.close()
  })
})

describe('digestTranscriptInto', () => {
  const args = (branch: string | null) => ({
    sessionId: id('a1000009'),
    transcriptPath: fx.transcriptOf(id('a1000009')),
    memoryFolder: fx.repo,
    branch
  })
  const digestText = async (): Promise<string> => {
    const dir = join(memoryDirFor(fx.repo), 'sessions')
    const [name] = (await fs.readdir(dir)).filter((n) => /-a1000009\.md$/.test(n))
    return fs.readFile(join(dir, name!), 'utf8')
  }

  it('reads a branch that resolves in the owning repo, claims no other session commits, and writes no hot.md', async () => {
    hotCalls.length = 0
    const engine = engineOver()
    await engine.digestTranscriptInto(args('main'))
    const text = await digestText()
    // The token stays `orphan` whatever the git evidence; main's commits belong to other sessions.
    expect(text).toMatch(
      /branch `main` · recovered from a removed folder · auto-digest · evidence: orphan_/
    )
    expect(text).not.toContain('git evidence is not available')
    expect(text).not.toMatch(/c[1-4]\b/)
    expect(hotCalls).toEqual([])
    engine.close()
  })

  it('never hands an option-shaped branch to git', async () => {
    const seen: Array<string | undefined> = []
    const engine = createDigestEngine({
      resolveSession: async () => null,
      readFacts: readTranscriptFacts,
      readTruth: readTranscriptTruth,
      gatherGit: async (_f, _s, _b, rev) => {
        seen.push(rev)
        return { kind: 'unavailable' }
      },
      writeDigest: async () => ({ ok: true }),
      writeHot: async () => undefined,
      memoryCheckout: async () => fx.repo,
      now: () => REPLAY,
      setTimer: () => undefined,
      clearTimer: () => undefined
    })
    for (const b of ['--output=/tmp/x', '-x', 'a b', 'a..b ', '']) {
      await engine.digestTranscriptInto(args(b))
    }
    expect(seen).toEqual([])
    engine.close()
  })

  it('writes nothing for a transcript below the gate', async () => {
    const engine = engineOver()
    await engine.digestTranscriptInto({
      ...args('feature-x'),
      sessionId: id('a100000a'),
      transcriptPath: fx.transcriptOf(id('a100000a'))
    })
    expect(existsSync(join(memoryDirFor(fx.repo), 'sessions'))).toBe(false)
    engine.close()
  })
})

describe('digestOrphans', () => {
  it('digests orphan sessions at gather time', async () => {
    const engine = engineOver()
    const calls: string[] = []
    const [out] = await digestOrphans([goneItem()], realDeps(engine, calls))

    // a1000009 (5 turns) is digested; a100000a (1 turn) is not counted.
    expect(calls).toEqual([id('a1000009')])
    expect(out!.digest).toEqual({ done: 1, total: 1, home: fx.repo })
    const dir = join(memoryDirFor(fx.repo), 'sessions')
    const names = await fs.readdir(dir)
    const mine = names.filter((n) => /-a1000009\.md$/.test(n))
    expect(mine).toHaveLength(1)
    expect(names.some((n) => /-a100000a\.md$/.test(n))).toBe(false)
    const text = await fs.readFile(join(dir, mine[0]!), 'utf8')
    const header = text.split('\n').find((l) => l.startsWith('_Session `a1000009`'))
    expect(header).toMatch(/· evidence: orphan_$/)
    // The branch never existed in the owning repo, so no git evidence is claimed.
    expect(text).toContain('_The folder was removed; git evidence is not available._')
    expect(existsSync(fx.gone)).toBe(false)

    // A second gather finds the digest and writes nothing.
    const again: string[] = []
    const [second] = await digestOrphans([goneItem()], realDeps(engine, again))
    expect(again).toEqual([])
    expect(second!.digest).toEqual({ done: 1, total: 1, home: fx.repo })
    expect(await fs.readdir(dir)).toEqual(names)
    engine.close()
  })

  it('digests at most 20 sessions per gather across all items, oldest first', async () => {
    const mk = (n: number, base: number): OrphanSessionFile[] =>
      Array.from({ length: n }, (_, i) => ({
        sessionId: `x${String(base + i).padStart(3, '0')}`.padEnd(36, '0'),
        transcriptPath: `/t/s${base + i}.jsonl`,
        mtimeMs: 1_000_000 - (base + i) * 1000 // higher index = older
      }))
    const files: Record<string, OrphanSessionFile[]> = { A: mk(15, 0), B: mk(10, 100) }
    const made = new Set<string>()
    const order: string[] = []
    const deps: OrphanDigestDeps = {
      repoPaths: ['/r'],
      probe: { exists: async () => true, isCheckout: async () => true },
      sessionsOf: async (it) => files[it.slug]!,
      inspect: async () => ({ userTurns: 3, gitBranch: null }),
      hasDigest: async (_h, sid) => made.has(sid),
      digest: async (a) => {
        order.push(a.sessionId)
        made.add(a.sessionId)
      }
    }
    const item = (slug: string): OrphanTranscriptItem => ({
      ...goneItem(),
      id: orphanTranscriptId(slug),
      slug,
      folder: '/r/.claude/worktrees/' + slug
    })
    const out = await digestOrphans([item('A'), item('B')], deps)
    expect(order).toHaveLength(20)
    const all = [...files.A!, ...files.B!].sort((a, b) => a.mtimeMs - b.mtimeMs)
    expect(order).toEqual(all.slice(0, 20).map((f) => f.sessionId))
    const done = out.map((o) => o.digest!.done)
    expect(done.reduce((a, b) => a + b, 0)).toBe(20)
    expect(out.map((o) => o.digest!.total)).toEqual([15, 10])
    // The next gather continues with the rest.
    order.length = 0
    await digestOrphans([item('A'), item('B')], deps)
    expect(order).toHaveLength(5)
  })

  it('counts an item with no owning repo as undigested and writes nothing', async () => {
    const engine = engineOver()
    const calls: string[] = []
    const deps = {
      ...realDeps(engine, calls),
      repoPaths: [],
      probe: { exists: async () => false, isCheckout: async () => false }
    }
    const [out] = await digestOrphans([goneItem()], deps)
    expect(calls).toEqual([])
    expect(out!.digest).toEqual({ done: 0, total: 1, home: null })
  })
})
