import { describe, it, expect } from 'vitest'
import {
  buildHotProposal,
  commitsAfter,
  commitsSince,
  DEFAULT_DIGEST_RELEVANCE,
  DIGEST_COMMIT_CAP,
  DIGEST_FILE_CAP,
  DIGEST_GATE,
  DIGEST_MAX_CHARS,
  digestSlug,
  digestTriggerFor,
  formatDigest,
  GIT_LOG_FORMAT,
  GIT_LOG_SEP,
  isRelevantWork,
  parseGitLog,
  parseNumstat,
  planDigest,
  renderDigest,
  shortSessionId,
  summarizeStats,
  type DigestCommit,
  type DigestFileStat,
  type DigestPlan,
  type DigestRenderInput,
  type GitEvidence
} from '../src/main/mcp/digest-core'
import { MEMORY_ENTRY_MAX_CHARS } from '../src/main/mcp/memory-core'
import {
  emptyFacts,
  scanTranscriptLines,
  type TranscriptFacts
} from '../src/main/mcp/digest-transcript'
import { fixtureSession, transcriptLines } from './helpers/memory-u1-fixture'

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

// ---- Memory U1 · S-1: trigger, planner, renderer ----------------------------

const factsWith = (over: Partial<TranscriptFacts>): TranscriptFacts => ({
  ...emptyFacts(),
  ...over
})
const repoGit = (
  commits: DigestCommit[] = [],
  head: string | null = 'f'.repeat(40)
): GitEvidence => ({
  kind: 'repo',
  head,
  commits,
  fileStats: [],
  dirtyCount: 0
})
const oneCommit = mkCommit('c'.repeat(40), 500, 'feat: one')

describe('digestTriggerFor', () => {
  it('digestTriggerFor maps hook edges', () => {
    for (const taskState of ['working', 'idle', 'needs-input', 'completed', 'failed', 'stopped']) {
      expect(digestTriggerFor({ event: 'PreCompact', taskState })).toBe('digest-compact')
    }
    expect(digestTriggerFor({ event: 'SessionEnd', taskState: 'working' })).toBe('digest-ended')
    expect(digestTriggerFor({ event: 'Stop', taskState: 'completed' })).toBe('digest-ended')
    expect(digestTriggerFor({ event: 'UserPromptSubmit', taskState: 'working' })).toBe(
      'cancel-idle'
    )
    expect(digestTriggerFor({ event: 'Notification', taskState: 'needs-input' })).toBe(
      'cancel-idle'
    )
    expect(digestTriggerFor({ event: 'Stop', taskState: 'idle' })).toBe('arm-idle')
    expect(digestTriggerFor({ event: 'Stop', taskState: 'failed' })).toBe('none')
    expect(digestTriggerFor({ event: 'Stop', taskState: 'stopped' })).toBe('none')
    expect(digestTriggerFor({ event: 'Stop', taskState: 'mystery' })).toBe('none')
  })
})

describe('planDigest', () => {
  it('planDigest gates on commits or three user turns', () => {
    expect(DIGEST_GATE).toEqual({ minCommits: 1, minUserTurns: 3 })
    // 0 commits, 3 turns → write, relevance turns.
    expect(planDigest({ facts: factsWith({ userTurns: 3 }), git: repoGit(), last: null })).toEqual({
      action: 'write',
      evidence: 'no-commits',
      relevance: 'turns'
    })
    // 0 commits, 2 turns → skip insufficient.
    expect(planDigest({ facts: factsWith({ userTurns: 2 }), git: repoGit(), last: null })).toEqual({
      action: 'skip',
      reason: 'insufficient'
    })
    // 1 commit, 1 turn → write, relevance commits.
    expect(
      planDigest({ facts: factsWith({ userTurns: 1 }), git: repoGit([oneCommit]), last: null })
    ).toEqual({ action: 'write', evidence: 'commits', relevance: 'commits' })
    // A matching last → skip unchanged.
    expect(
      planDigest({
        facts: factsWith({ userTurns: 5 }),
        git: repoGit([oneCommit]),
        last: { head: 'f'.repeat(40), userTurns: 5 }
      })
    ).toEqual({ action: 'skip', reason: 'unchanged' })
    // A different head or turn count is not unchanged.
    expect(
      planDigest({
        facts: factsWith({ userTurns: 5 }),
        git: repoGit([oneCommit]),
        last: { head: 'e'.repeat(40), userTurns: 5 }
      }).action
    ).toBe('write')
    expect(
      planDigest({
        facts: factsWith({ userTurns: 6 }),
        git: repoGit(),
        last: { head: 'f'.repeat(40), userTurns: 5 }
      }).action
    ).toBe('write')
    // Insufficient with a matching last → insufficient (the gate runs first).
    expect(
      planDigest({
        facts: factsWith({ userTurns: 2 }),
        git: repoGit(),
        last: { head: 'f'.repeat(40), userTurns: 2 }
      })
    ).toEqual({ action: 'skip', reason: 'insufficient' })
    // orphan: true with a repo session with commits → evidence orphan.
    expect(
      planDigest({
        facts: factsWith({ userTurns: 1 }),
        git: repoGit([oneCommit]),
        last: null,
        orphan: true
      })
    ).toEqual({ action: 'write', evidence: 'orphan', relevance: 'commits' })
    // Non-git and unavailable evidence, and their head-null dedup.
    expect(
      planDigest({ facts: factsWith({ userTurns: 3 }), git: { kind: 'not-a-repo' }, last: null })
    ).toEqual({ action: 'write', evidence: 'no-git', relevance: 'turns' })
    expect(
      planDigest({
        facts: factsWith({ userTurns: 3 }),
        git: { kind: 'not-a-repo' },
        last: { head: null, userTurns: 3 }
      })
    ).toEqual({ action: 'skip', reason: 'unchanged' })
    expect(
      planDigest({ facts: factsWith({ userTurns: 4 }), git: { kind: 'unavailable' }, last: null })
    ).toEqual({ action: 'write', evidence: 'orphan', relevance: 'turns' })
    // A custom gate.
    expect(
      planDigest({
        facts: factsWith({ userTurns: 3 }),
        git: repoGit([oneCommit]),
        last: null,
        gate: { minCommits: 2, minUserTurns: 5 }
      })
    ).toEqual({ action: 'skip', reason: 'insufficient' })
  })
})

describe('renderDigest', () => {
  const writePlan = (
    evidence: Extract<DigestPlan, { action: 'write' }>['evidence'],
    relevance: 'commits' | 'turns' = 'turns'
  ): Extract<DigestPlan, { action: 'write' }> => ({ action: 'write', evidence, relevance })
  const base = (over: Partial<DigestRenderInput> = {}): DigestRenderInput => ({
    date: '2026-11-03',
    title: 'Session a1000003',
    branch: 'main',
    sessionShort: 'a1000003',
    reason: 'ended',
    plan: writePlan('no-commits'),
    git: repoGit(),
    facts: emptyFacts(),
    ...over
  })
  /** The content of one `## ` section, or undefined when the section is absent. */
  const section = (md: string, heading: string): string | undefined => {
    const start = md.indexOf(`\n## ${heading}\n\n`)
    if (start < 0) return undefined
    const body = md.slice(start + heading.length + 6)
    const end = body.indexOf('\n\n## ')
    return (end < 0 ? body : body.slice(0, end)).replace(/\n$/, '')
  }

  it('renders the a1000003 example digest', () => {
    const input = base({
      facts: scanTranscriptLines(
        transcriptLines(fixtureSession('a1000003'), { repo: '/r', plain: '/p', gone: '/g' }).main
      )
    })
    const expected = [
      '# Session a1000003',
      '',
      '_Session `a1000003` · branch `main` · ended · auto-digest · evidence: no-commits_',
      '',
      '## Evidence',
      '',
      '**Commits (0)** — none in this session',
      '',
      '## Asked and answered',
      '',
      '> - **Q:** Which storage should the cache use? — **A:** file',
      '> - **Q:** Ship behind a flag? — **A:** yes, later',
      '',
      '## Open questions',
      '',
      '> - Should we also migrate old entries?',
      '> - Do you want a CHANGELOG entry?',
      '',
      '## Last message',
      '',
      '> Migrated the cache to file storage. Should we also migrate old entries? Do you want a CHANGELOG entry? See `cache?.ts` and https://example.com/?q=1.',
      ''
    ].join('\n')
    expect(renderDigest(input)).toBe(expected)
    expect(renderDigest(input)).toBe(renderDigest(input))
  })

  it('fences verbatim text and cuts to fit', () => {
    // Every transcript text is a blockquote; one-line items collapse their newlines.
    const md = renderDigest(
      base({
        facts: factsWith({
          asked: [{ question: 'Pick\none?', answer: 'a\r\n  b' }],
          openQuestions: ['Still open?'],
          lastAssistantText: 'Line one\n\nLine three'
        }),
        awaySummary: 'Goal: x\n\nNext: y',
        lastPrompt: 'continue\nplease'
      })
    )
    expect(section(md, 'Asked and answered')).toBe('> - **Q:** Pick one? — **A:** a b')
    expect(section(md, 'Open questions')).toBe('> - Still open?')
    expect(section(md, 'Recap')).toBe(
      "_The session's own summary — context, not verified fact:_\n\n> Goal: x\n>\n> Next: y"
    )
    expect(section(md, 'Left off')).toBe('> continue\n> please')
    expect(section(md, 'Last message')).toBe('> Line one\n>\n> Line three')

    // Left off and Last message drop out when they repeat the recap source.
    const same = renderDigest(
      base({ facts: factsWith({ lastAssistantText: ' same ' }), lastPrompt: 'same ' })
    )
    expect(section(same, 'Recap')).toContain('> same')
    expect(section(same, 'Left off')).toBeUndefined()
    expect(section(same, 'Last message')).toBeUndefined()
    // The recap prefers the away summary, then the task summary, then the last prompt.
    expect(
      section(renderDigest(base({ taskSummary: 'task', lastPrompt: 'p' })), 'Recap')
    ).toContain('> task')
    // The left-off text is capped at 500 code points, the recap at 1,500.
    const capped = renderDigest(
      base({ awaySummary: 'r'.repeat(2_000), lastPrompt: 'p'.repeat(900) })
    )
    expect(section(capped, 'Left off')).toBe('> ' + 'p'.repeat(499) + '…')
    expect(section(capped, 'Recap')).toContain('> ' + 'r'.repeat(1_499) + '…')

    // Over 8,000 characters: sections are cut from 8 upward, the title, header and Evidence never.
    expect(DIGEST_MAX_CHARS).toBe(MEMORY_ENTRY_MAX_CHARS)
    const pairs = Array.from({ length: 9 }, (_, i) => ({
      question: `${i}`.padEnd(299, 'q') + '?',
      answer: `${i}`.padEnd(300, 'a')
    }))
    const questions = Array.from({ length: 5 }, (_, i) => `${i}`.padEnd(299, 'o') + '?')
    const full = factsWith({
      asked: pairs,
      openQuestions: questions,
      lastAssistantText: 'm'.repeat(1_499) + '…'
    })
    const bulky = {
      awaySummary: 's'.repeat(1_500),
      lastPrompt: 'l'.repeat(500)
    }
    const fit = renderDigest(base({ facts: full, ...bulky }))
    expect(fit.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(section(fit, 'Last message')).toBe('_…cut to fit_')
    expect(section(fit, 'Left off')).toBe('_…cut to fit_')
    expect(section(fit, 'Recap')).toBe('_…cut to fit_')
    expect(section(fit, 'Open questions')).toContain('> - 0oooo')
    expect(section(fit, 'Asked and answered')?.split('\n')).toHaveLength(9)
    expect(fit.startsWith('# Session a1000003\n\n_Session `a1000003`')).toBe(true)
    expect(section(fit, 'Evidence')).toBe('**Commits (0)** — none in this session')

    // A large Evidence pushes the cut all the way to section 4, and Evidence stays whole.
    const commits = Array.from({ length: 20 }, (_, i) =>
      mkCommit(String(i).padStart(40, '0'), 1_000 + i, `feat: ${'x'.repeat(150)} ${i}`)
    )
    const heavy = renderDigest(
      base({
        plan: writePlan('commits', 'commits'),
        git: repoGit(commits),
        facts: full,
        ...bulky
      })
    )
    expect(heavy.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    for (const h of ['Asked and answered', 'Open questions', 'Recap', 'Left off', 'Last message']) {
      expect(section(heavy, h)).toBe('_…cut to fit_')
    }
    expect(section(heavy, 'Evidence')?.split('\n')).toHaveLength(21)

    // An orphan plan with repo git renders the commit lines under the token orphan.
    const orphanRepo = renderDigest(
      base({
        reason: 'orphan',
        branch: 'feature-x',
        plan: writePlan('orphan', 'commits'),
        git: repoGit([oneCommit])
      })
    )
    expect(orphanRepo.split('\n')[2]).toBe(
      '_Session `a1000003` · branch `feature-x` · recovered from a removed folder · auto-digest · evidence: orphan_'
    )
    expect(section(orphanRepo, 'Evidence')).toBe('**Commits (1)**\n- `cccccccc` feat: one')
    const orphanGone = renderDigest(
      base({ reason: 'orphan', plan: writePlan('orphan'), git: { kind: 'unavailable' } })
    )
    expect(section(orphanGone, 'Evidence')).toBe(
      '_The folder was removed; git evidence is not available._'
    )
  })

  it('renders each evidence kind and reason in the header', () => {
    const verbs: [DigestRenderInput['reason'], string][] = [
      ['ended', 'ended'],
      ['idle', 'went idle'],
      ['compact', 'compacted'],
      ['catch-up', 'caught up'],
      ['orphan', 'recovered from a removed folder']
    ]
    for (const [reason, verb] of verbs) {
      expect(renderDigest(base({ reason })).split('\n')[2]).toBe(
        `_Session \`a1000003\` · branch \`main\` · ${verb} · auto-digest · evidence: no-commits_`
      )
    }
    // No branch part without a branch, nor for a non-git folder.
    expect(renderDigest(base({ branch: '' })).split('\n')[2]).toBe(
      '_Session `a1000003` · ended · auto-digest · evidence: no-commits_'
    )
    const noGit = renderDigest(base({ plan: writePlan('no-git'), git: { kind: 'not-a-repo' } }))
    expect(noGit.split('\n')[2]).toBe(
      '_Session `a1000003` · ended · auto-digest · evidence: no-git_'
    )
    expect(section(noGit, 'Evidence')).toBe('_Not a git repository: no git evidence._')
    // no-commits with a dirty tree keeps today's uncommitted line.
    const dirty = renderDigest(base({ git: { ...repoGit(), dirtyCount: 2 } as GitEvidence }))
    expect(section(dirty, 'Evidence')).toBe(
      '**Commits (0)** — none in this session\n\n_2 uncommitted changes in the working tree (not in the commits above)._'
    )
    // The title is capped at 200 code points.
    const title = renderDigest(base({ title: 't'.repeat(300) })).split('\n')[0]
    expect(Array.from(title).length).toBe(2 + 200)
  })

  it('keeps the commit evidence lines of today and counts other commits as context', () => {
    const commits = [mkCommit('a'.repeat(40), 300, 'feat: ship it')]
    const fileStats: DigestFileStat[] = [{ added: 10, deleted: 1, file: 'src/a.ts' }]
    const today = formatDigest({
      date: '2026-11-03',
      title: 'x',
      sessionShort: 'a1000003',
      endReason: 'ended',
      commits,
      fileStats,
      dirtyCount: 3
    })
    const todayEvidence = today.split('## Evidence\n')[1].replace(/\n$/, '')
    const md = renderDigest(
      base({
        plan: writePlan('commits', 'commits'),
        git: { kind: 'repo', head: 'a'.repeat(40), commits, fileStats, dirtyCount: 3 }
      })
    )
    expect(section(md, 'Evidence')).toBe(todayEvidence)
    const others = renderDigest(base({ otherCommits: 2 }))
    expect(section(others, 'Evidence')).toBe(
      '**Commits (0)** — none in this session\n\n_2 other commits landed on this checkout during the session (not attributed to it)._'
    )
    expect(section(renderDigest(base({ otherCommits: 1 })), 'Evidence')).toContain(
      '_1 other commit landed on this checkout during the session (not attributed to it)._'
    )
    expect(section(renderDigest(base({ otherCommits: 0 })), 'Evidence')).toBe(
      '**Commits (0)** — none in this session'
    )
  })
})
