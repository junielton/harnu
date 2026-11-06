import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import {
  attributeCommits,
  attributeEvidence,
  commitCandidates,
  sessionWindows
} from '../src/main/mcp/digest-attribution'
import type { DigestCommit, GitEvidence } from '../src/main/mcp/digest-core'
import { createDigestEngine } from '../src/main/mcp/digest-engine'
import {
  commitFileStats,
  gatherGitEvidence,
  listSubagentTranscripts,
  readTranscriptFacts,
  readTranscriptTruth
} from '../src/main/mcp/digest-io'
import { emptyFacts, type TranscriptFacts } from '../src/main/mcp/digest-transcript'
import { memoryDirFor, resolveMemoryCheckout } from '../src/main/mcp/memory-core'
import { appendMemoryEntry } from '../src/main/mcp/memory-store'
import { probeGitMeta } from '../src/main/git-probe'
import { atMinute, buildMemoryU1Home, type MemoryU1Home } from './helpers/memory-u1-fixture'

/**
 * Memory U1 S-4: a commit is attributed to the session whose own git-call windows (its main
 * transcript's and its subagents') hold its committer time (D-5); the rest are context.
 */

/** The replay clock: T + 2 days. */
const REPLAY = atMinute(2 * 24 * 60)

let tmp: string
let fx: MemoryU1Home

const id = (id8: string): string => `${id8}-0000-4000-8000-000000000000`

beforeAll(async () => {
  tmp = await mkdtemp(join(os.tmpdir(), 'memory-u1-'))
  fx = await buildMemoryU1Home(tmp)
}, 60_000)

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const commit = (subject: string, sec: number): DigestCommit => ({
  hash: subject.padEnd(40, '0'),
  shortHash: subject.padEnd(8, '0'),
  committedAt: sec,
  subject
})

/** Attribution as the engine runs it, from the real reader and git probe. */
async function attribute(
  id8: string,
  withSubagents = true
): Promise<{ mine: string[]; others: number }> {
  const sid = id(id8)
  const { facts } = await readTranscriptFacts(fx.transcriptOf(sid))
  const subs: TranscriptFacts[] = []
  if (withSubagents) {
    for (const p of await listSubagentTranscripts(fx.transcriptOf(sid), sid)) {
      subs.push((await readTranscriptFacts(p)).facts)
    }
  }
  const git = await gatherGitEvidence(fx.repo, Math.floor(Date.parse(facts.firstAt!) / 1000), null)
  if (git.kind !== 'repo') throw new Error('the fixture repo is a repo')
  const { mine, others } = attributeCommits(
    commitCandidates(git.commits, facts),
    sessionWindows(facts, subs, REPLAY)
  )
  return { mine: mine.map((c) => c.subject), others }
}

describe('digest attribution', () => {
  it('attributes commits to the session that made them', async () => {
    // The subagent listing finds the fixture's subagent file, and nothing for a session without one.
    expect(await listSubagentTranscripts(fx.transcriptOf(id('a1000005')), id('a1000005'))).toEqual(
      fx.subagentsOf(id('a1000005'))
    )
    expect(await listSubagentTranscripts(fx.transcriptOf(id('a1000006')), id('a1000006'))).toEqual(
      []
    )

    expect(await attribute('a1000005')).toEqual({ mine: ['c4', 'c2'], others: 1 })
    expect(await attribute('a1000006')).toEqual({ mine: ['c3'], others: 2 })
    expect(await attribute('a1000001')).toEqual({ mine: ['c1'], others: 0 })
    // c4 is a1000005's only through its subagent transcript.
    expect(await attribute('a1000005', false)).toEqual({ mine: ['c2'], others: 2 })

    // Pure rules: window ends are included; a commit outside every window is another's.
    const windows = [{ startMs: 10_000, endMs: 20_000 }]
    const r = attributeCommits(
      [commit('end', 20), commit('start', 10), commit('before', 9), commit('after', 21)],
      windows
    )
    expect(r.mine.map((c) => c.subject)).toEqual(['end', 'start'])
    expect(r.others).toBe(2)

    // Candidates lie in [firstAt − 2 s, lastAt + 5 s]; a session without timestamps has none.
    const facts: TranscriptFacts = {
      ...emptyFacts(),
      firstAt: new Date(100_000).toISOString(),
      lastAt: new Date(200_000).toISOString()
    }
    expect(
      commitCandidates(
        [commit('a', 97), commit('b', 98), commit('c', 205), commit('d', 206)],
        facts
      ).map((c) => c.subject)
    ).toEqual(['b', 'c'])
    expect(commitCandidates([commit('a', 150)], emptyFacts())).toEqual([])

    // Evidence: narrowed repo evidence loses its range-wide file stats; other kinds pass through.
    const repo: GitEvidence = {
      kind: 'repo',
      head: 'h'.repeat(40),
      commits: [commit('in', 150), commit('out', 160)],
      fileStats: [{ file: 'x', added: 1, deleted: 0 }],
      dirtyCount: 2
    }
    const narrowed = attributeEvidence(repo, facts, [{ startMs: 149_000, endMs: 151_000 }])
    expect(narrowed.others).toBe(1)
    expect(narrowed.narrowed).toBe(true)
    expect(narrowed.git).toMatchObject({ head: repo.head, dirtyCount: 2, fileStats: [] })
    expect((narrowed.git as { commits: DigestCommit[] }).commits.map((c) => c.subject)).toEqual([
      'in'
    ])
    const whole = attributeEvidence(repo, facts, [{ startMs: 100_000, endMs: 200_000 }])
    expect(whole).toEqual({ git: repo, others: 0, narrowed: false })
    expect(attributeEvidence({ kind: 'not-a-repo' }, facts, [])).toEqual({
      git: { kind: 'not-a-repo' },
      others: 0,
      narrowed: false
    })
  })

  it('unattributed commits are context, not evidence', async () => {
    const engine = createDigestEngine({
      resolveSession: async (sid) => ({
        transcriptPath: fx.transcriptOf(sid),
        folder: fx.repo,
        branch: 'main'
      }),
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
      writeHot: async () => undefined,
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
    for (const id8 of ['a1000001', 'a1000005', 'a1000006']) {
      await engine.digestNow(id(id8), 'ended')
    }
    engine.close()

    const evidenceOf = async (id8: string): Promise<string[]> => {
      const page = join(memoryDirFor(fx.repo), 'sessions', `2026-11-03-${id8}.md`)
      const text = await fs.readFile(page, 'utf8')
      const start = text.indexOf('## Evidence\n\n')
      expect(start).toBeGreaterThan(-1)
      const body = text.slice(start + '## Evidence\n\n'.length)
      const end = body.indexOf('\n\n## ')
      return (end === -1 ? body : body.slice(0, end)).trimEnd().split('\n')
    }

    const six = await evidenceOf('a1000006')
    expect(six[0]).toBe('**Commits (1)**')
    expect(six.filter((l) => l.startsWith('- `')).map((l) => l.replace(/^- `\w+` /, ''))).toEqual([
      'c3'
    ])
    expect(six).toContain('`c3.txt`')
    expect(six.join('\n')).not.toMatch(/c2|c4/)
    expect(six[six.length - 1]).toBe(
      '_2 other commits landed on this checkout during the session (not attributed to it)._'
    )

    const five = await evidenceOf('a1000005')
    expect(five[0]).toBe('**Commits (2)**')
    expect(five.filter((l) => l.startsWith('- `')).map((l) => l.replace(/^- `\w+` /, ''))).toEqual([
      'c4',
      'c2'
    ])
    expect(five).toContain('`c2.txt`, `c4.txt`')
    expect(five.join('\n')).not.toMatch(/c3/)
    expect(five[five.length - 1]).toBe(
      '_1 other commit landed on this checkout during the session (not attributed to it)._'
    )

    const one = await evidenceOf('a1000001')
    expect(one[0]).toBe('**Commits (1)**')
    expect(one.join('\n')).not.toContain('other commit')
  })
})
