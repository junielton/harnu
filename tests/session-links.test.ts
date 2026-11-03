import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyUrl,
  createSessionLinksService,
  extractLinksFromJsonl,
  extractUrls,
  findKnownFolder,
  findKnownSession
} from '../src/main/session-links'
import type { FolderEntry } from '../src/main/folder-model'

// Links shelf (T617) — pure core + the injected-deps service. Every expected value is a hand-written
// literal (lesson testing/001): no assertion is derived from the function under test.

const SID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const SID_UNKNOWN = 'cccccccc-3333-4333-8333-cccccccccccc'

const user = (content: unknown, at: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'user',
    timestamp: at,
    isSidechain: false,
    message: { role: 'user', content },
    ...extra
  })
const assistant = (content: unknown, at: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    isSidechain: false,
    message: { role: 'assistant', content },
    ...extra
  })
const jsonl = (...lines: string[]): string => lines.join('\n') + '\n'

describe('extractLinksFromJsonl — AC-1', () => {
  it('extracts user and assistant links only', () => {
    const raw = jsonl(
      user('first https://example.com/a for you', '2026-11-03T10:00:00.000Z'),
      user([{ type: 'text', text: 'block https://example.com/b' }], '2026-11-03T10:01:00.000Z'),
      assistant(
        [{ type: 'text', text: 'Opened https://github.com/acme/web/pull/183 — footer pill.' }],
        '2026-11-03T10:02:00.000Z'
      ),
      // None of the following may leak into the shelf.
      assistant(
        [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'curl https://tool.example/x' }
          }
        ],
        '2026-11-03T10:03:00.000Z'
      ),
      user(
        [{ type: 'tool_result', tool_use_id: 't1', content: 'fetched https://result.example/y' }],
        '2026-11-03T10:04:00.000Z'
      ),
      user(
        [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'page https://result.example/z' }]
          }
        ],
        '2026-11-03T10:05:00.000Z'
      ),
      assistant(
        [{ type: 'thinking', thinking: 'maybe https://thought.example/q' }],
        '2026-11-03T10:06:00.000Z'
      ),
      assistant(
        [{ type: 'text', text: 'sub https://side.example/s' }],
        '2026-11-03T10:07:00.000Z',
        {
          isSidechain: true
        }
      ),
      user(
        '<system-reminder>see https://reminder.example/r</system-reminder>real text',
        '2026-11-03T10:08:00.000Z'
      )
    )
    const links = extractLinksFromJsonl(raw)
    expect(links.map((l) => l.url)).toEqual([
      'https://github.com/acme/web/pull/183',
      'https://example.com/b',
      'https://example.com/a'
    ])
    expect(links.map((l) => l.source)).toEqual(['agent', 'user', 'user'])
    expect(links.map((l) => l.at)).toEqual([
      '2026-11-03T10:02:00.000Z',
      '2026-11-03T10:01:00.000Z',
      '2026-11-03T10:00:00.000Z'
    ])
  })

  it('dedups by URL keeping the latest occurrence, newest first', () => {
    const raw = jsonl(
      user('read https://example.com/a first', '2026-11-03T10:00:00.000Z'),
      user('and https://example.com/b', '2026-11-03T10:01:00.000Z'),
      assistant(
        [{ type: 'text', text: 'Back to https://example.com/a again.' }],
        '2026-11-03T10:02:00.000Z'
      )
    )
    const links = extractLinksFromJsonl(raw)
    expect(links).toHaveLength(2)
    expect(links[0]).toMatchObject({
      url: 'https://example.com/a',
      source: 'agent',
      at: '2026-11-03T10:02:00.000Z',
      excerpt: 'Back to https://example.com/a again.'
    })
    expect(links[1].url).toBe('https://example.com/b')
  })

  it('carries url, kind, label, detail, source, at and excerpt on every entry', () => {
    const [link] = extractLinksFromJsonl(
      jsonl(user('check https://github.com/acme/web/pull/9', '2026-11-03T10:00:00.000Z'))
    )
    expect(link).toEqual({
      url: 'https://github.com/acme/web/pull/9',
      kind: 'pr',
      label: 'acme/web #9',
      detail: 'GitHub PR',
      source: 'user',
      at: '2026-11-03T10:00:00.000Z',
      excerpt: 'check'
    })
  })

  it('builds the excerpt from the surrounding sentence', () => {
    const links = extractLinksFromJsonl(
      jsonl(
        // Mid-sentence → the URL stays so the sentence still reads.
        assistant(
          [
            {
              type: 'text',
              text: 'Opened https://github.com/acme/web/pull/183 — footer pill. Next up: tests.'
            }
          ],
          '2026-11-03T10:00:00.000Z'
        ),
        // Trailing URL → dropped from the excerpt (the row already shows it).
        user(
          'also check the PR from yesterday https://github.com/acme/web/pull/181',
          '2026-11-03T10:01:00.000Z'
        ),
        // URL alone on its line → falls back to the previous line.
        user(
          'and the Figma frame:\nhttps://www.figma.com/design/K1/Name',
          '2026-11-03T10:02:00.000Z'
        )
      )
    )
    const byUrl = Object.fromEntries(links.map((l) => [l.url, l.excerpt]))
    expect(byUrl['https://github.com/acme/web/pull/183']).toBe(
      'Opened https://github.com/acme/web/pull/183 — footer pill.'
    )
    expect(byUrl['https://github.com/acme/web/pull/181']).toBe('also check the PR from yesterday')
    expect(byUrl['https://www.figma.com/design/K1/Name']).toBe('and the Figma frame:')
  })

  it('trims a long excerpt to about 120 characters', () => {
    const long = 'word '.repeat(80) // 400 chars, no sentence end
    const [link] = extractLinksFromJsonl(
      jsonl(
        assistant(
          [{ type: 'text', text: `${long}https://example.com/mid ${long}` }],
          '2026-11-03T10:00:00.000Z'
        )
      )
    )
    expect(link.excerpt.length).toBeLessThanOrEqual(120)
    expect(link.excerpt).toContain('https://example.com/mid')
  })

  it('skips corrupt lines and lines without a timestamp keep the previous time', () => {
    const raw = [
      user('one https://example.com/a', '2026-11-03T10:00:00.000Z'),
      '{not json',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'two https://example.com/b' }
      })
    ].join('\n')
    const links = extractLinksFromJsonl(raw)
    expect(links.map((l) => l.url)).toEqual(['https://example.com/b', 'https://example.com/a'])
    expect(links[0].at).toBe('2026-11-03T10:00:00.000Z')
  })
})

describe('classifyUrl — AC-2', () => {
  it('classifies and labels from the URL', () => {
    expect(classifyUrl('https://github.com/acme/web/pull/183')).toEqual({
      kind: 'pr',
      label: 'acme/web #183',
      detail: 'GitHub PR'
    })
    expect(classifyUrl('https://github.com/acme/web/pull/183/files?w=1#diff-abc')).toMatchObject({
      kind: 'pr',
      label: 'acme/web #183'
    })
    expect(classifyUrl('https://github.com/acme/web/issues/42')).toEqual({
      kind: 'issue',
      label: 'acme/web #42',
      detail: 'GitHub issue'
    })
    expect(classifyUrl('https://app.clickup.com/t/86b7x2k1q')).toEqual({
      kind: 'task',
      label: 'Task 86b7x2k1q',
      detail: 'ClickUp'
    })
    // Team-scoped form: the id is the last segment.
    expect(classifyUrl('https://app.clickup.com/t/9012345/PROJ-231')).toMatchObject({
      kind: 'task',
      label: 'Task PROJ-231'
    })
    expect(classifyUrl('https://www.figma.com/design/Qx7Lm2/Harnu?node-id=812-4410')).toEqual({
      kind: 'figma',
      label: 'Harnu',
      detail: 'node 812-4410'
    })
    expect(
      classifyUrl('https://www.figma.com/file/Qx7Lm2/My%20Design%20System?node-id=1%3A2')
    ).toEqual({
      kind: 'figma',
      label: 'My Design System',
      detail: 'node 1:2'
    })
    expect(classifyUrl('https://www.figma.com/design/Qx7Lm2/Harnu')).toEqual({
      kind: 'figma',
      label: 'Harnu',
      detail: ''
    })
    expect(
      classifyUrl('https://docs.google.com/document/d/1xR8kq0Zt/edit?tab=t.0#heading=h.1')
    ).toEqual({
      kind: 'doc',
      label: 'docs.google.com/document/d/1xR8kq0Zt/edit',
      detail: 'Google Docs'
    })
    expect(classifyUrl('https://www.notion.so/acme/Plan-123abc?pvs=4')).toEqual({
      kind: 'doc',
      label: 'www.notion.so/acme/Plan-123abc',
      detail: 'Notion'
    })
    expect(classifyUrl('https://keepachangelog.com/en/1.1.0/?x=1#top')).toEqual({
      kind: 'web',
      label: 'keepachangelog.com/en/1.1.0',
      detail: ''
    })
    expect(classifyUrl('https://example.com/')).toEqual({
      kind: 'web',
      label: 'example.com',
      detail: ''
    })
  })

  it('falls back to web for GitHub urls that are not a PR or an issue', () => {
    expect(classifyUrl('https://github.com/acme/web')).toMatchObject({
      kind: 'web',
      label: 'github.com/acme/web'
    })
  })

  it('has no network code anywhere in the module', () => {
    const src = readFileSync(join(__dirname, '../src/main/session-links.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"]node:(https?|net|dns|tls|http2)['"]/)
    expect(src).not.toMatch(/from ['"](https?|net|dns|tls|http2)['"]/)
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/\bnet\.(request|fetch)\b/)
    expect(src).not.toMatch(/XMLHttpRequest|WebSocket/)
  })
})

describe('extractUrls — AC-3', () => {
  it('strips trailing punctuation and markdown', () => {
    expect(extractUrls('see https://example.com/a.')).toEqual(['https://example.com/a'])
    expect(
      extractUrls('a https://example.com/a, b https://example.com/b; c https://example.com/c:')
    ).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c'])
    expect(extractUrls('(see https://example.com/a)')).toEqual(['https://example.com/a'])
    expect(extractUrls('[https://example.com/a]')).toEqual(['https://example.com/a'])
    expect(extractUrls('"https://example.com/a" and \'https://example.com/b\'')).toEqual([
      'https://example.com/a',
      'https://example.com/b'
    ])
    expect(extractUrls('run `https://example.com/a` now')).toEqual(['https://example.com/a'])
    expect(extractUrls('[the docs](https://example.com/docs) rock')).toEqual([
      'https://example.com/docs'
    ])
    expect(extractUrls('<https://example.com/a>')).toEqual(['https://example.com/a'])
    expect(extractUrls('end https://example.com/a?x=1&y=2).')).toEqual([
      'https://example.com/a?x=1&y=2'
    ])
    expect(extractUrls('Did you see https://example.com/a?')).toEqual(['https://example.com/a'])
  })

  it('keeps a balanced parenthesis that is part of the path', () => {
    expect(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    ])
    expect(extractUrls('[x](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    ])
  })

  it('only matches http(s) and drops garbage', () => {
    expect(
      extractUrls('ftp://example.com/a mailto:x@y.z file:///etc/passwd javascript:alert(1)')
    ).toEqual([])
    expect(extractUrls('http://localhost:5173/app and https://example.com')).toEqual([
      'http://localhost:5173/app',
      'https://example.com'
    ])
    expect(extractUrls('https:// not a url')).toEqual([])
  })
})

describe('folder scope and session resolution — AC-4', () => {
  let dir: string
  let folders: FolderEntry[]
  const fileA = (): string => join(dir, `${SID_A}.jsonl`)
  const fileB = (): string => join(dir, `${SID_B}.jsonl`)

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harnu-links-'))
    await writeFile(
      fileA(),
      jsonl(
        user('a1 https://example.com/a1', '2026-11-03T10:00:00.000Z'),
        user('a2 https://example.com/a2', '2026-11-03T10:05:00.000Z')
      )
    )
    await writeFile(
      fileB(),
      jsonl(
        user('b1 https://example.com/b1', '2026-11-03T11:00:00.000Z'),
        assistant(
          [{ type: 'text', text: 'b2 https://example.com/b2' }],
          '2026-11-03T11:30:00.000Z'
        ),
        user('b3 https://example.com/b3', '2026-11-03T11:45:00.000Z')
      )
    )
    const session = (
      sessionId: string,
      fullPath: string,
      summary: string,
      firstPrompt = ''
    ): unknown => ({
      sessionId,
      fullPath,
      summary,
      firstPrompt
    })
    folders = [
      {
        path: '/work/harnu',
        alias: 'harnu',
        sessions: [
          session(SID_A, fileA(), 'Older session'),
          session(SID_B, fileB(), '', 'Newer prompt title')
        ]
      },
      { path: '/work/other', alias: 'other', sessions: [] }
    ] as unknown as FolderEntry[]
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves transcripts only through sessions Harnu already knows', () => {
    expect(findKnownSession(folders, SID_A)?.fullPath).toBe(fileA())
    expect(findKnownSession(folders, SID_UNKNOWN)).toBeNull()
    // A forged path or a non-uuid never resolves, whatever it looks like.
    expect(findKnownSession(folders, '../../etc/passwd')).toBeNull()
    expect(findKnownSession(folders, fileA())).toBeNull()
    expect(findKnownSession(folders, 42 as unknown as string)).toBeNull()
    expect(findKnownFolder(folders, '/work/harnu')?.alias).toBe('harnu')
    expect(findKnownFolder(folders, '/etc')).toBeNull()
  })

  it('reads the links of one session by uuid and nothing for an unknown one', async () => {
    const svc = createSessionLinksService({ getFolders: async () => folders })
    const links = await svc.forSession(SID_A)
    expect(links.map((l) => l.url)).toEqual(['https://example.com/a2', 'https://example.com/a1'])
    expect(await svc.forSession(SID_UNKNOWN)).toEqual([])
    expect(await svc.forSession('../../etc/passwd')).toEqual([])
    expect(await svc.forSession(undefined as unknown as string)).toEqual([])
  })

  it('folder scope groups by session, newest session first', async () => {
    const svc = createSessionLinksService({ getFolders: async () => folders })
    const groups = await svc.forFolder('/work/harnu')
    expect(groups.map((g) => g.sessionId)).toEqual([SID_B, SID_A])
    expect(groups[0]).toMatchObject({
      sessionId: SID_B,
      title: 'Newer prompt title',
      count: 3,
      latestAt: '2026-11-03T11:45:00.000Z'
    })
    expect(groups[0].links.map((l) => l.url)).toEqual([
      'https://example.com/b3',
      'https://example.com/b2',
      'https://example.com/b1'
    ])
    expect(groups[1]).toMatchObject({
      sessionId: SID_A,
      title: 'Older session',
      count: 2,
      latestAt: '2026-11-03T10:05:00.000Z'
    })
  })

  it('omits sessions with no links and answers an unknown folder with an empty list', async () => {
    const svc = createSessionLinksService({ getFolders: async () => folders })
    expect(await svc.forFolder('/work/other')).toEqual([])
    expect(await svc.forFolder('/etc')).toEqual([])
    expect(await svc.forFolder(undefined as unknown as string)).toEqual([])
  })

  it('sees a URL appended to the transcript on the next read, without a re-scan', async () => {
    const svc = createSessionLinksService({ getFolders: async () => folders })
    expect((await svc.forSession(SID_A)).map((l) => l.url)).toEqual([
      'https://example.com/a2',
      'https://example.com/a1'
    ])
    await appendFile(fileA(), jsonl(user('a3 https://example.com/a3', '2026-11-03T10:10:00.000Z')))
    expect((await svc.forSession(SID_A)).map((l) => l.url)).toEqual([
      'https://example.com/a3',
      'https://example.com/a2',
      'https://example.com/a1'
    ])
    // A rewrite (compaction) that shrinks the file falls back to a full re-read.
    await writeFile(fileA(), jsonl(user('only https://example.com/z', '2026-11-03T12:00:00.000Z')))
    expect((await svc.forSession(SID_A)).map((l) => l.url)).toEqual(['https://example.com/z'])
  })

  it('survives a missing transcript file', async () => {
    const ghost = [
      {
        path: '/work/ghost',
        alias: 'ghost',
        sessions: [
          {
            sessionId: SID_UNKNOWN,
            fullPath: join(dir, 'gone.jsonl'),
            summary: '',
            firstPrompt: ''
          }
        ]
      }
    ] as unknown as FolderEntry[]
    const svc = createSessionLinksService({ getFolders: async () => ghost })
    expect(await svc.forSession(SID_UNKNOWN)).toEqual([])
    expect(await svc.forFolder('/work/ghost')).toEqual([])
  })
})
