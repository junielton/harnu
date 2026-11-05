import { describe, it, expect, vi } from 'vitest'
import * as os from 'node:os'
import { join, parse } from 'node:path'
import {
  commitsAfter,
  commitsSince,
  DIGEST_COMMIT_CAP,
  DIGEST_FILE_CAP,
  DIGEST_GATE,
  DIGEST_MAX_CHARS,
  digestSlug,
  digestTargetAllowed,
  digestTriggerFor,
  GIT_LOG_FORMAT,
  GIT_LOG_SEP,
  hotKeyOf,
  MEMORY_LABELS,
  mergeHot,
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
  type GitEvidence,
  type HotProposalInput
} from '../src/main/mcp/digest-core'
import { createDigestEngine } from '../src/main/mcp/digest-engine'
import { HOT_MAX_WORDS, MEMORY_ENTRY_MAX_CHARS } from '../src/main/mcp/memory-core'
import { deriveTranscriptTruth } from '../src/main/transcript-truth'
import {
  emptyFacts,
  scanTranscriptLines,
  type TranscriptFacts
} from '../src/main/mcp/digest-transcript'
import { fixtureSession, transcriptLines } from './helpers/memory-u1-fixture'

/**
 * T79 S2 / memory U1 — the pure auto-digest core: git-evidence parsing, the
 * hook-edge trigger, the planner, the digest body, and the `hot.md` builder.
 * Framework-free + side-effect-free (no fs/git/clock) so every gate/format
 * decision is pinned here; the env shell (`memory-digest.ts`) only marshals git +
 * transcript reads.
 */

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

// ---- mergeHot (memory U1 · S-7) -----------------------------------------------

const words = (text: string): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length)

/** What the memory write path leaves at the end of `hot.md`: the body, then the stamp. */
const stamped = (body: string, branch: string | null): string =>
  `${body.trim()}\n\n> provenance: author=agent · at=2026-11-03${branch ? ` · branch=${branch}` : ''} · session=s1\n`

const hotInput = (over: Partial<HotProposalInput> = {}): HotProposalInput => ({
  date: '2026-11-03',
  title: 'Cache work',
  branch: 'main',
  commits: [],
  digestPage: 'sessions/2026-11-03-aaaaaaaa',
  ...over
})

/** The Parallel list of a merged hot: its `- ` lines after the label. */
const parallelLines = (hot: string): string[] => {
  const at = hot.indexOf('**Parallel:**')
  return at === -1
    ? []
    : hot
        .slice(at)
        .split('\n')
        .filter((l) => l.startsWith('- '))
}

describe('mergeHot', () => {
  it('mergeHot keeps another branch’s snapshot', () => {
    const a = mergeHot({
      current: null,
      currentKey: null,
      next: hotInput({
        title: 'Title A',
        branch: 'feat/a',
        digestPage: 'sessions/2026-11-01-aaaaaaaa'
      }),
      nextKey: 'feat/a'
    })
    const aOnDisk = stamped(a, 'feat/a')
    const input = (key: string, date: string, title: string): HotProposalInput =>
      hotInput({ title, branch: key, date, digestPage: `sessions/${date}-${key.replace('/', '')}` })

    // The same key replaces the body; so does a null current key, or no current hot at all.
    const b = input('feat/b', '2026-11-02', 'Title B')
    const replaced = mergeHot({ current: null, currentKey: null, next: b, nextKey: 'feat/b' })
    expect(mergeHot({ current: aOnDisk, currentKey: 'feat/b', next: b, nextKey: 'feat/b' })).toBe(
      replaced
    )
    expect(mergeHot({ current: aOnDisk, currentKey: null, next: b, nextKey: 'feat/b' })).toBe(
      replaced
    )
    expect(replaced).not.toContain('Title A')
    expect(replaced).not.toContain('**Parallel:**')

    // A different key keeps the whole body, drops the old stamp, and lists the new key last.
    const kept = mergeHot({ current: aOnDisk, currentKey: 'feat/a', next: b, nextKey: 'feat/b' })
    expect(kept.startsWith(a.trimEnd())).toBe(true)
    expect(kept).not.toContain('> provenance:')
    expect(kept.trimEnd().endsWith('[[sessions/2026-11-02-featb]]')).toBe(true)
    expect(parallelLines(kept)).toEqual([
      '- `feat/b` · 2026-11-02 · Title B → [[sessions/2026-11-02-featb]]'
    ])
    expect(kept.match(/\*\*Parallel:\*\*/g)).toHaveLength(1)

    // Another branch's line is replaced by the same key, and the list is newest first.
    const withC = mergeHot({
      current: stamped(kept, 'feat/a'),
      currentKey: 'feat/a',
      next: input('feat/c', '2026-11-03', 'Title C'),
      nextKey: 'feat/c'
    })
    const withB2 = mergeHot({
      current: stamped(withC, 'feat/a'),
      currentKey: 'feat/a',
      next: input('feat/b', '2026-11-04', 'Title B again'),
      nextKey: 'feat/b'
    })
    expect(parallelLines(withB2)).toEqual([
      '- `feat/b` · 2026-11-04 · Title B again → [[sessions/2026-11-04-featb]]',
      '- `feat/c` · 2026-11-03 · Title C → [[sessions/2026-11-03-featc]]'
    ])
    expect(withB2.startsWith(a.trimEnd())).toBe(true)

    // At most five lines: the oldest is dropped.
    let hot = a
    for (let i = 1; i <= 7; i++) {
      hot = mergeHot({
        current: stamped(hot, 'feat/a'),
        currentKey: 'feat/a',
        next: input(`k/${i}`, `2026-11-0${i}`, `Title ${i}`),
        nextKey: `k/${i}`
      })
    }
    const lines = parallelLines(hot)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('`k/7`')
    expect(lines[4]).toContain('`k/3`')
    expect(hot).not.toContain('`k/2`')

    // A title is one line, whatever it held.
    const multi = mergeHot({
      current: aOnDisk,
      currentKey: 'feat/a',
      next: input('feat/m', '2026-11-05', 'first line\nsecond line'),
      nextKey: 'feat/m'
    })
    expect(parallelLines(multi)).toEqual([
      '- `feat/m` · 2026-11-05 · first line second line → [[sessions/2026-11-05-featm]]'
    ])

    // The result is never over the word cap: the oldest lines go first, then the new one.
    const roomy = (n: number): string =>
      `**Now:**\n> ${'pad '.repeat(n)}\n\nFull digest: [[sessions/x]]`
    const four = (n: number): string => {
      let h = roomy(n)
      for (const k of ['k/1', 'k/2', 'k/3', 'k/4']) {
        h = mergeHot({
          current: stamped(h, 'feat/a'),
          currentKey: 'feat/a',
          next: input(k, '2026-11-02', 'T'),
          nextKey: k
        })
      }
      return h
    }
    const pad = 503 - words(four(0))
    expect(words(four(pad - 1))).toBeLessThanOrEqual(HOT_MAX_WORDS)
    const tight = four(pad - 1)
    expect(parallelLines(tight).map((l) => l.slice(3, 6))).toEqual(['k/4', 'k/3', 'k/2'])
    expect(tight).not.toContain('`k/1`')
    // Nothing fits: the body stands alone, with no empty Parallel label.
    const full = mergeHot({
      current: stamped(roomy(HOT_MAX_WORDS - 6), 'feat/a'),
      currentKey: 'feat/a',
      next: input('k/9', '2026-11-02', 'T'),
      nextKey: 'k/9'
    })
    expect(words(full)).toBeLessThanOrEqual(HOT_MAX_WORDS)
    expect(full).not.toContain('**Parallel:**')

    // A snapshot of one's own is never over the cap either, however much the session said.
    const q = Array.from({ length: 5 }, () => 'a '.repeat(150).trim())
    const big = mergeHot({
      current: null,
      currentKey: null,
      next: hotInput({ openQuestions: q, lastPrompt: 'a '.repeat(400) }),
      nextKey: 'main'
    })
    expect(words(big)).toBeLessThanOrEqual(HOT_MAX_WORDS)
  })

  it('hot fences verbatim text and uses the label table', () => {
    // The table is English and complete.
    expect(Object.keys(MEMORY_LABELS).sort()).toEqual(
      ['fullDigest', 'last', 'lastPrompt', 'next', 'now', 'parallel'].sort()
    )
    for (const v of Object.values(MEMORY_LABELS)) expect(v).toMatch(/^[A-Za-z][A-Za-z ()-]*:?$/)
    const labels = new Set(Object.values(MEMORY_LABELS).map((v) => v.replace(/:$/, '')))
    expect(MEMORY_LABELS.lastPrompt).toBe('Last prompt (verbatim):')

    const input = hotInput({
      title: 'Migração do cache\nsegunda linha',
      lastPrompt: 'Falta o teste?\n\nSegunda parte',
      commits: [mkCommit('c'.repeat(40), 100, 'feat: cache')]
    })
    const withQuestions = mergeHot({
      current: null,
      currentKey: null,
      next: { ...input, openQuestions: ['Devemos migrar tudo?', 'Outra\nlinha?'] },
      nextKey: 'main'
    })
    const withPrompt = mergeHot({ current: null, currentKey: null, next: input, nextKey: 'main' })
    const withNothing = mergeHot({
      current: null,
      currentKey: null,
      next: hotInput({ title: 'Cache work' }),
      nextKey: 'main'
    })

    // Open questions: one verbatim bullet each, and the prompt is not Next.
    expect(withQuestions).toContain('**Next:**\n> - Devemos migrar tudo?\n> - Outra linha?')
    expect(withQuestions).not.toContain('Falta o teste')
    expect(withQuestions).not.toContain(MEMORY_LABELS.lastPrompt)
    // No questions: the label, then the prompt as a block.
    expect(withPrompt).toContain(
      `**Next:**\n${MEMORY_LABELS.lastPrompt}\n> Falta o teste?\n>\n> Segunda parte`
    )
    expect(withPrompt).not.toMatch(/\*\*Next:\*\*\s*Falta/)
    // Neither: a dash.
    expect(withNothing).toContain('**Next:** —')

    for (const hot of [withQuestions, withPrompt, withNothing]) {
      // The title is a block, every line quoted.
      expect(hot).toContain('**Now:**\n> ')
      // Outside the blocks there is only the label table's words, the dash and the digest link.
      for (const line of hot.split('\n')) {
        if (line === '' || line.startsWith('>')) continue
        const label =
          /^\*\*([^*]+?)(?: \(\d{4}-\d{2}-\d{2}\))?:?\*\*|^(Last prompt \(verbatim\)|Full digest):/.exec(
            line
          )
        expect(label, `unlabelled line: ${line}`).not.toBeNull()
        expect(labels.has((label![1] ?? label![2]).replace(/:$/, ''))).toBe(true)
        expect(line).not.toMatch(/Migra|Falta|Devemos|segunda/)
      }
    }
    expect(withPrompt).toContain('> Migração do cache\n> segunda linha')
    expect(withPrompt).toContain(
      '**Last (2026-11-03):** 1 commit on `main` — latest `cccccccc` feat: cache'
    )
    expect(withPrompt.trimEnd().endsWith('Full digest: [[sessions/2026-11-03-aaaaaaaa]]')).toBe(
      true
    )
  })

  it('hotKeyOf reads the stamp the write path left, not a quoted one', () => {
    expect(hotKeyOf(stamped('**Now:**\n> x', 'feat/a'))).toBe('feat/a')
    expect(hotKeyOf(stamped('**Now:**\n> x', null))).toBeNull()
    expect(hotKeyOf('no stamp here')).toBeNull()
    // A prompt that quotes a stamp-looking line cannot choose the key.
    const spoof = '**Now:**\n> provenance: author=agent · branch=evil\n\nFull digest: [[x]]'
    expect(hotKeyOf(stamped(spoof, 'feat/a'))).toBe('feat/a')
    expect(hotKeyOf(stamped(spoof, null))).toBeNull()
    // Frontmatter before the body is fine.
    expect(hotKeyOf(`---\ntitle: hot\n---\n\n${stamped('body', 'main')}`)).toBe('main')
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
    // The Evidence lines the pre-U1 digest (formatDigest, deleted in S-2) wrote for this input.
    const todayEvidence = [
      '**Commits (1)**',
      '- `aaaaaaaa` feat: ship it',
      '',
      '**Files (1, +10/−1)**',
      '`src/a.ts`',
      '',
      '_3 uncommitted changes in the working tree (not in the commits above)._'
    ].join('\n')
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

  it('elides over-long commit and file lists with an explicit count', () => {
    const many = Array.from({ length: DIGEST_COMMIT_CAP + 5 }, (_, i) =>
      mkCommit(String(i).padStart(40, '0'), 100 + i, `c${i}`)
    )
    const files: DigestFileStat[] = Array.from({ length: DIGEST_FILE_CAP + 3 }, (_, i) => ({
      added: 1,
      deleted: 0,
      file: `f${i}.ts`
    }))
    const evidence = section(
      renderDigest(
        base({
          plan: writePlan('commits', 'commits'),
          git: {
            kind: 'repo',
            head: 'a'.repeat(40),
            commits: many,
            fileStats: files,
            dirtyCount: 0
          }
        })
      ),
      'Evidence'
    )!
    expect(evidence).toContain(`**Commits (${DIGEST_COMMIT_CAP + 5})**`)
    expect(evidence).toContain('- _…and 5 more_')
    expect(evidence).toContain(`**Files (${DIGEST_FILE_CAP + 3}, +${DIGEST_FILE_CAP + 3}/−0)**`)
    expect(evidence).toContain('_(+3 more)_')
  })
})

describe('digestTargetAllowed', () => {
  it('digestTargetAllowed refuses unsafe roots', async () => {
    const home = join(parse(process.cwd()).root, 'home', 'op')
    expect(digestTargetAllowed(home, home)).toBe(false)
    expect(digestTargetAllowed(`${home}/`, home)).toBe(false)
    expect(digestTargetAllowed(parse(home).root, home)).toBe(false)
    expect(digestTargetAllowed(join(home, '.claude'), home)).toBe(false)
    expect(digestTargetAllowed(join(home, '.claude', 'projects', 'x'), home)).toBe(false)
    expect(digestTargetAllowed(join(home, '.harnu'), home)).toBe(false)
    expect(digestTargetAllowed(join(home, '.harnu', 'memory'), home)).toBe(false)
    expect(digestTargetAllowed(join(home, 'notes', '..', '.claude'), home)).toBe(false)
    // An ordinary folder under the home directory, and look-alike names, are fine.
    expect(digestTargetAllowed(join(home, 'notes'), home)).toBe(true)
    expect(digestTargetAllowed(join(home, '.claude-backup'), home)).toBe(true)
    expect(digestTargetAllowed(join(home, '..claude'), home)).toBe(true)
    expect(digestTargetAllowed(join(home, 'work', '.claude'), home)).toBe(true)

    // The engine writes nothing, digest or hot, for a refused memory root.
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      for (const root of [os.homedir(), join(os.homedir(), '.claude', 'scratch')]) {
        const writeDigest = vi.fn(async () => ({ ok: true }))
        const writeHot = vi.fn(async () => undefined)
        const engine = createDigestEngine({
          resolveSession: async () => ({ transcriptPath: '/t/x.jsonl', folder: root }),
          readFacts: async () => ({ facts: { ...emptyFacts(), userTurns: 3 }, offset: 1 }),
          readTruth: async () => deriveTranscriptTruth([]),
          gatherGit: async () => ({ kind: 'not-a-repo' }),
          writeDigest,
          writeHot,
          memoryCheckout: async (folder) => folder,
          now: () => Date.parse('2026-11-03T12:00:00.000Z'),
          setTimer: () => 0,
          clearTimer: () => undefined
        })
        await engine.digestNow('s-unsafe', 'ended')
        expect(writeDigest).not.toHaveBeenCalled()
        expect(writeHot).not.toHaveBeenCalled()
        expect(log).toHaveBeenCalledWith(`[memory-digest] skipped: unsafe memory root ${root}`)
      }
    } finally {
      log.mockRestore()
    }
  })
})
