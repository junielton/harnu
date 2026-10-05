import { describe, it, expect } from 'vitest'
import {
  buildHotProposal,
  commitsAfter,
  commitsSince,
  DEFAULT_DIGEST_RELEVANCE,
  DIGEST_COMMIT_CAP,
  DIGEST_FILE_CAP,
  digestSlug,
  formatDigest,
  GIT_LOG_FORMAT,
  GIT_LOG_SEP,
  isRelevantWork,
  parseGitLog,
  parseNumstat,
  shortSessionId,
  summarizeStats,
  type DigestCommit,
  type DigestFileStat
} from '../src/main/mcp/digest-core'

/**
 * T79 S2 — the pure auto-digest core: the relevance gate, git-evidence parsing,
 * the evidence-linked digest formatter, and the proposed-`hot.md` builder.
 * Framework-free + side-effect-free (no fs/git/clock) so every gate/format
 * decision is pinned here; the env shell (`memory-digest.ts`) only marshals git +
 * transcript reads.
 */

// ---- Relevance gate (§3.4 / §5 — done-by-evidence) --------------------------

describe('isRelevantWork', () => {
  const base = { commitCount: 0, filesChanged: 0, dirtyCount: 0 }

  it('is relevant with ≥1 commit (the primary done-by-evidence signal)', () => {
    expect(isRelevantWork({ ...base, commitCount: 1 })).toEqual({
      relevant: true,
      reason: 'commits'
    })
  })

  it('is NOT relevant with zero commits, however dirty the tree', () => {
    expect(isRelevantWork({ ...base, dirtyCount: 50, filesChanged: 50 })).toEqual({
      relevant: false,
      reason: 'insufficient'
    })
  })

  it('never fires on time-in-seat alone (no commit → not relevant)', () => {
    expect(isRelevantWork(base).relevant).toBe(false)
  })

  it('honours a tunable minCommits threshold', () => {
    expect(isRelevantWork({ ...base, commitCount: 2 }, { minCommits: 3 }).relevant).toBe(false)
    expect(isRelevantWork({ ...base, commitCount: 3 }, { minCommits: 3 }).relevant).toBe(true)
  })

  it('defaults to minCommits: 1', () => {
    expect(DEFAULT_DIGEST_RELEVANCE).toEqual({ minCommits: 1 })
  })
})

// ---- Git log parsing --------------------------------------------------------

describe('parseGitLog', () => {
  const line = (hash: string, ct: number, subject: string): string =>
    [hash, String(ct), subject].join(GIT_LOG_SEP)

  it('parses hash / committer-unix / subject, newest-first', () => {
    const raw = [
      line('a'.repeat(40), 1_700_000_100, 'feat: b'),
      line('b'.repeat(40), 1_700_000_000, 'feat: a')
    ].join('\n')
    const commits = parseGitLog(raw)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toEqual({
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaaa',
      committedAt: 1_700_000_100,
      subject: 'feat: b'
    })
  })

  it('keeps a subject that contains spaces and punctuation intact', () => {
    const commits = parseGitLog(line('c'.repeat(40), 1, 'fix(x): a, b: c = d'))
    expect(commits[0].subject).toBe('fix(x): a, b: c = d')
  })

  it('skips blank + malformed lines, never throws', () => {
    const raw = ['', 'garbage-no-sep', line('d'.repeat(40), 5, 'ok'), 'x\x1fnotanumber\x1fy'].join(
      '\n'
    )
    const commits = parseGitLog(raw)
    expect(commits).toHaveLength(1)
    expect(commits[0].subject).toBe('ok')
  })

  it('exposes a format string using the unit separator', () => {
    expect(GIT_LOG_FORMAT).toBe(`%H${GIT_LOG_SEP}%ct${GIT_LOG_SEP}%s`)
  })
})

// ---- commitsSince / commitsAfter --------------------------------------------

const mkCommit = (hash: string, committedAt: number, subject = 's'): DigestCommit => ({
  hash,
  shortHash: hash.slice(0, 8),
  committedAt,
  subject
})

describe('commitsSince', () => {
  const commits = [
    mkCommit('a'.repeat(40), 300),
    mkCommit('b'.repeat(40), 200),
    mkCommit('c'.repeat(40), 100)
  ]

  it('keeps commits at or after the session start', () => {
    expect(commitsSince(commits, 200).map((c) => c.committedAt)).toEqual([300, 200])
  })

  it('returns all commits when the since bound is non-finite', () => {
    expect(commitsSince(commits, Number.NaN)).toHaveLength(3)
  })
})

describe('commitsAfter', () => {
  const a = mkCommit('a'.repeat(40), 300)
  const b = mkCommit('b'.repeat(40), 200)
  const c = mkCommit('c'.repeat(40), 100)
  const commits = [a, b, c]

  it('returns only commits newer than the baseline (exclusive)', () => {
    expect(commitsAfter(commits, b.hash)).toEqual([a])
  })

  it('returns all commits for an empty baseline', () => {
    expect(commitsAfter(commits, '')).toHaveLength(3)
  })

  it('returns all commits when the baseline is not in the list', () => {
    expect(commitsAfter(commits, 'f'.repeat(40))).toHaveLength(3)
  })

  it('matches a short/long baseline prefix', () => {
    expect(commitsAfter(commits, 'bbbbbbbb')).toEqual([a])
  })
})

// ---- numstat ----------------------------------------------------------------

describe('parseNumstat', () => {
  it('parses added / deleted / file', () => {
    const raw = '10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts'
    expect(parseNumstat(raw)).toEqual([
      { added: 10, deleted: 2, file: 'src/a.ts' },
      { added: 0, deleted: 5, file: 'src/b.ts' }
    ])
  })

  it('treats a binary file (`-`) as zero churn', () => {
    expect(parseNumstat('-\t-\timg.png')).toEqual([{ added: 0, deleted: 0, file: 'img.png' }])
  })

  it('keeps a rename path verbatim', () => {
    const stats = parseNumstat('1\t1\told.ts => new.ts')
    expect(stats[0].file).toBe('old.ts => new.ts')
  })

  it('summarizes churn', () => {
    const stats: DigestFileStat[] = [
      { added: 10, deleted: 2, file: 'a' },
      { added: 3, deleted: 4, file: 'b' }
    ]
    expect(summarizeStats(stats)).toEqual({ files: 2, added: 13, deleted: 6 })
  })
})

// ---- slug -------------------------------------------------------------------

describe('digestSlug / shortSessionId', () => {
  it('builds YYYY-MM-DD-<id8>', () => {
    expect(digestSlug('2026-07-07', 'a1b2c3d4-e5f6-7890-abcd-ef0123456789')).toBe(
      '2026-07-07-a1b2c3d4'
    )
  })

  it('truncates the session id to 8 chars', () => {
    expect(shortSessionId('abcdef0123456789')).toBe('abcdef01')
  })

  it('produces a slug matching the timeline filename convention', () => {
    // memory-core DIGEST_NAME = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9]+)\.md$/
    const slug = digestSlug('2026-07-07', 'deadbeefcafef00d')
    expect(`${slug}.md`).toMatch(/^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9]+)\.md$/)
  })
})

// ---- formatDigest -----------------------------------------------------------

describe('formatDigest', () => {
  const commits = [
    mkCommit('a'.repeat(40), 300, 'feat: ship it'),
    mkCommit('b'.repeat(40), 200, 'test: cover it')
  ]
  const fileStats: DigestFileStat[] = [
    { added: 10, deleted: 1, file: 'src/a.ts' },
    { added: 4, deleted: 0, file: 'src/b.ts' }
  ]

  it('starts with a `# ` heading (so the timeline reads it as the title)', () => {
    const md = formatDigest({
      date: '2026-07-07',
      title: 'Auto-digest engine',
      branch: 'feat/t79-s2-digest',
      sessionShort: 'a1b2c3d4',
      endReason: 'ended',
      commits,
      fileStats,
      dirtyCount: 0
    })
    expect(md.startsWith('# Auto-digest engine\n')).toBe(true)
  })

  it('links commit evidence (hash + subject), never a narrative claim', () => {
    const md = formatDigest({
      date: '2026-07-07',
      title: 'x',
      sessionShort: 'a1b2c3d4',
      endReason: 'idle',
      commits,
      fileStats,
      dirtyCount: 0
    })
    expect(md).toContain('## Evidence')
    expect(md).toContain('**Commits (2)**')
    expect(md).toContain('- `aaaaaaaa` feat: ship it')
    expect(md).toContain('**Files (2, +14/−1)**')
    expect(md).toContain('`src/a.ts`')
    expect(md).toContain('went idle')
  })

  it("frames the recap as the session's own words, not fact", () => {
    const md = formatDigest({
      date: '2026-07-07',
      title: 'x',
      sessionShort: 'a1b2c3d4',
      endReason: 'ended',
      awaySummary: 'Goal: build the engine. Next: wire the inbox.',
      commits,
      fileStats: [],
      dirtyCount: 0
    })
    expect(md).toContain('## Recap')
    expect(md).toContain('context, not verified fact')
    expect(md).toContain('Goal: build the engine.')
  })

  it('reports uncommitted churn as supplementary, not as a commit', () => {
    const md = formatDigest({
      date: '2026-07-07',
      title: 'x',
      sessionShort: 'a1b2c3d4',
      endReason: 'ended',
      commits,
      fileStats,
      dirtyCount: 3
    })
    expect(md).toContain('3 uncommitted changes in the working tree')
  })

  it('elides an over-long commit list with an explicit "+N more" (never silent)', () => {
    const many = Array.from({ length: DIGEST_COMMIT_CAP + 5 }, (_, i) =>
      mkCommit(String(i).padStart(40, '0'), 100 + i, `c${i}`)
    )
    const md = formatDigest({
      date: '2026-07-07',
      title: 'x',
      sessionShort: 'a1b2c3d4',
      endReason: 'ended',
      commits: many,
      fileStats: [],
      dirtyCount: 0
    })
    expect(md).toContain('_…and 5 more_')
    expect(md).toContain(`**Commits (${DIGEST_COMMIT_CAP + 5})**`)
  })

  it('elides an over-long file list with "+N more"', () => {
    const many: DigestFileStat[] = Array.from({ length: DIGEST_FILE_CAP + 3 }, (_, i) => ({
      added: 1,
      deleted: 0,
      file: `f${i}.ts`
    }))
    const md = formatDigest({
      date: '2026-07-07',
      title: 'x',
      sessionShort: 'a1b2c3d4',
      endReason: 'ended',
      commits,
      fileStats: many,
      dirtyCount: 0
    })
    expect(md).toContain('_(+3 more)_')
  })

  it('falls back to a session-id title when none is given', () => {
    const md = formatDigest({
      date: '2026-07-07',
      title: '   ',
      sessionShort: 'a1b2c3d4',
      endReason: 'ended',
      commits: [],
      fileStats: [],
      dirtyCount: 0
    })
    expect(md.startsWith('# Session a1b2c3d4\n')).toBe(true)
    expect(md).toContain('- _(none)_')
  })
})

// ---- buildHotProposal -------------------------------------------------------

describe('buildHotProposal', () => {
  const commits = [
    mkCommit('a'.repeat(40), 300, 'feat: ship it'),
    mkCommit('b'.repeat(40), 200, 'test: cover it')
  ]

  it('produces a NOW / LAST / NEXT snapshot linking the full digest', () => {
    const hot = buildHotProposal({
      date: '2026-07-07',
      title: 'Auto-digest engine',
      branch: 'feat/t79-s2-digest',
      commits,
      lastPrompt: 'Wire the inbox proposal',
      digestPage: 'sessions/2026-07-07-a1b2c3d4'
    })
    expect(hot).toContain('**Now:** Auto-digest engine')
    expect(hot).toContain('2 commits on `feat/t79-s2-digest` — latest `aaaaaaaa` feat: ship it')
    expect(hot).toContain('**Next:** Wire the inbox proposal')
    expect(hot).toContain('[[sessions/2026-07-07-a1b2c3d4]]')
  })

  it('stays well under the 500-word hot cap', () => {
    const hot = buildHotProposal({
      date: '2026-07-07',
      title: 'x'.repeat(40),
      commits,
      digestPage: 'sessions/2026-07-07-a1b2c3d4'
    })
    expect(hot.trim().split(/\s+/).length).toBeLessThan(500)
  })

  it('handles a single commit (singular) and a missing next', () => {
    const hot = buildHotProposal({
      date: '2026-07-07',
      title: 'x',
      commits: [commits[0]],
      digestPage: 'sessions/p'
    })
    expect(hot).toContain('1 commit')
    expect(hot).toContain('**Next:** —')
  })
})
