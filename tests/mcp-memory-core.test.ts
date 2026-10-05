import { describe, it, expect } from 'vitest'
import {
  buildMemoryIndex,
  buildMemoryWrite,
  buildWhereBacklink,
  centralMemoryFolderName,
  DEFAULT_MEMORY_CONFIG,
  effectiveMemoryConfig,
  formatMemoryDate,
  grepMemory,
  hash8,
  HOT_MAX_WORDS,
  lintSecrets,
  MEMORY_ENTRY_MAX_CHARS,
  memoryDirFor,
  parseCardMeta,
  parseMemoryPage,
  renderProvenance,
  resolveMemoryCheckout,
  resolveMemoryDir,
  resolvePageFile,
  splitFrontmatter,
  validateEntry,
  type MemoryLocationConfig,
  type ParsedMemoryPage,
  type Provenance
} from '../src/main/mcp/memory-core'

/**
 * T79 S1 — the pure Project Memory core: storage keying, the page traversal
 * gate, body-append/hot-replace assembly, server-stamped provenance, the
 * anti-secret lint, the deterministic index, and the v1 grep. Framework-free +
 * side-effect-free (no fs/clock) so every accept/reject/format decision is
 * pinned here; the env shell (`memory-store.ts`) only marshals the effect.
 */

const FIXED_NOW = 1_700_000_000_000 // 2023-11-14 (UTC)

describe('resolveMemoryCheckout (storage keying §3.1)', () => {
  it('collapses a worktree onto its main checkout via the git common-dir', () => {
    expect(
      resolveMemoryCheckout('/home/u/repo/.claude/worktrees/feat-x', '/home/u/repo/.git')
    ).toBe('/home/u/repo')
  })

  it('resolves the main checkout to itself', () => {
    expect(resolveMemoryCheckout('/home/u/repo', '/home/u/repo/.git')).toBe('/home/u/repo')
  })

  it('every worktree of a repo shares ONE checkout (the whole point)', () => {
    const a = resolveMemoryCheckout('/home/u/repo/.claude/worktrees/a', '/home/u/repo/.git')
    const b = resolveMemoryCheckout('/home/u/repo/.claude/worktrees/b', '/home/u/repo/.git')
    expect(a).toBe(b)
  })

  it('falls back to folder-local memory when there is no git repo', () => {
    expect(resolveMemoryCheckout('/home/u/plain', undefined)).toBe('/home/u/plain')
  })

  it('never points memory at the filesystem root for a degenerate common-dir', () => {
    // dirname('/.git') === '/', which must NOT become the memory checkout.
    expect(resolveMemoryCheckout('/home/u/plain', '/.git')).toBe('/home/u/plain')
  })

  it('memoryDirFor appends the fixed .harnu/memory layout', () => {
    expect(memoryDirFor('/home/u/repo')).toBe('/home/u/repo/.harnu/memory')
  })
})

describe('configurable storage location (T89)', () => {
  const CENTRAL: MemoryLocationConfig = { mode: 'central', root: '/home/u/vault/harnu' }

  describe('hash8 / centralMemoryFolderName (collision keys)', () => {
    it('is deterministic (same input → same 8 hex chars)', () => {
      expect(hash8('/home/u/repo')).toBe(hash8('/home/u/repo'))
      expect(hash8('/home/u/repo')).toMatch(/^[0-9a-f]{8}$/)
    })

    it('disambiguates two repos that share a basename (the "two www" lesson)', () => {
      const a = centralMemoryFolderName('/home/u/clientA/www')
      const b = centralMemoryFolderName('/home/u/clientB/www')
      expect(a).not.toBe(b) // same prefix `www--`, different hash suffix
      expect(a.startsWith('www--')).toBe(true)
      expect(b.startsWith('www--')).toBe(true)
    })

    it('folder name is <repo-name>--<hash8(checkout)>', () => {
      expect(centralMemoryFolderName('/home/u/repo')).toBe(`repo--${hash8('/home/u/repo')}`)
    })
  })

  describe('resolveMemoryDir', () => {
    it('in-project (default) is the unchanged .harnu/memory under the main checkout', () => {
      expect(resolveMemoryDir('/home/u/repo', '/home/u/repo/.git')).toBe(
        '/home/u/repo/.harnu/memory'
      )
      expect(resolveMemoryDir('/home/u/repo', '/home/u/repo/.git', DEFAULT_MEMORY_CONFIG)).toBe(
        '/home/u/repo/.harnu/memory'
      )
    })

    it('central redirects to <root>/<repo-name>--<hash8> outside the repo', () => {
      expect(resolveMemoryDir('/home/u/repo', '/home/u/repo/.git', CENTRAL)).toBe(
        `/home/u/vault/harnu/repo--${hash8('/home/u/repo')}`
      )
    })

    it('every worktree of a repo resolves to the SAME central folder', () => {
      const a = resolveMemoryDir('/home/u/repo/.claude/worktrees/a', '/home/u/repo/.git', CENTRAL)
      const b = resolveMemoryDir('/home/u/repo/.claude/worktrees/b', '/home/u/repo/.git', CENTRAL)
      expect(a).toBe(b)
      expect(a).toBe(`/home/u/vault/harnu/repo--${hash8('/home/u/repo')}`)
    })

    it('a central config with a blank root falls back to in-project (never a relative path)', () => {
      expect(
        resolveMemoryDir('/home/u/repo', '/home/u/repo/.git', { mode: 'central', root: '  ' })
      ).toBe('/home/u/repo/.harnu/memory')
    })

    it('a folder outside git + central still uses the folder-local checkout for the key', () => {
      expect(resolveMemoryDir('/home/u/plain', undefined, CENTRAL)).toBe(
        `/home/u/vault/harnu/plain--${hash8('/home/u/plain')}`
      )
    })
  })

  describe('effectiveMemoryConfig (override precedence)', () => {
    it('the per-project override wins over the global default', () => {
      expect(effectiveMemoryConfig(CENTRAL, { mode: 'in-project' })).toEqual(CENTRAL)
    })

    it('falls back to the global default when there is no override', () => {
      expect(effectiveMemoryConfig(undefined, CENTRAL)).toEqual(CENTRAL)
      expect(effectiveMemoryConfig(null, { mode: 'in-project' })).toEqual({ mode: 'in-project' })
    })
  })

  describe('containment moves WITH the resolved dir', () => {
    it('a valid page resolves inside the CENTRAL dir, an escape still fails closed', () => {
      const dir = resolveMemoryDir('/home/u/repo', '/home/u/repo/.git', CENTRAL)
      const parsed = parseMemoryPage('roadmap/T89')
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(resolvePageFile(dir, parsed.value)).toBe(`${dir}/roadmap/T89.md`)
      const escaping: ParsedMemoryPage = {
        page: 'x',
        file: '../../../etc/passwd',
        mode: 'append',
        requireExists: false,
        appendable: true
      }
      expect(resolvePageFile(dir, escaping)).toBeNull()
    })
  })

  describe('buildWhereBacklink', () => {
    it('names the source project path for humans + Harnu to find the owner', () => {
      const out = buildWhereBacklink({ sourcePath: '/home/u/repo', generatedAt: '2026-07-07' })
      expect(out).toContain('/home/u/repo')
      expect(out).toContain('2026-07-07')
      expect(out.startsWith('# ')).toBe(true)
    })
  })
})

describe('parseMemoryPage (traversal gate)', () => {
  it('accepts the root pages with the right write policy', () => {
    expect(parseMemoryPage('hot')).toMatchObject({
      ok: true,
      value: {
        page: 'hot',
        file: 'hot.md',
        mode: 'replace',
        appendable: true,
        requireExists: false
      }
    })
    expect(parseMemoryPage('decisions')).toMatchObject({
      ok: true,
      value: { page: 'decisions', file: 'decisions.md', mode: 'append', appendable: true }
    })
  })

  it('marks the Harnu-managed index as non-appendable', () => {
    expect(parseMemoryPage('index')).toMatchObject({ ok: true, value: { appendable: false } })
  })

  it('requires an existing card for roadmap/* (creation is T80)', () => {
    expect(parseMemoryPage('roadmap/T74-markdown-pane')).toMatchObject({
      ok: true,
      value: {
        page: 'roadmap/T74-markdown-pane',
        file: 'roadmap/T74-markdown-pane.md',
        mode: 'append',
        requireExists: true,
        appendable: true
      }
    })
  })

  it('allows create-on-append for sessions/* and read-only archive/*', () => {
    expect(parseMemoryPage('sessions/2026-07-06-abcd1234')).toMatchObject({
      ok: true,
      value: { requireExists: false, appendable: true }
    })
    expect(parseMemoryPage('archive/TASKS-legacy')).toMatchObject({
      ok: true,
      value: { appendable: false }
    })
  })

  it('tolerates an explicit .md extension without doubling it', () => {
    expect(parseMemoryPage('hot.md')).toMatchObject({
      ok: true,
      value: { page: 'hot', file: 'hot.md' }
    })
    expect(parseMemoryPage('roadmap/T74.md')).toMatchObject({
      ok: true,
      value: { page: 'roadmap/T74', file: 'roadmap/T74.md' }
    })
  })

  // T123 — Harnu Learn: mission/path/resources/records all live flat under
  // `learning/<slug>` (the gate allows only ONE segment past the dir, so a
  // record is `learning/record-0001-intro`, never `learning/records/0001-intro`).
  // Regression coverage for the CRITICAL finding: the tutor's contract
  // (docs/harnu-teacher.md) prescribed page ids the gate used to reject outright.
  it('accepts create-on-append learning/<slug> pages (Harnu Learn, T123)', () => {
    expect(parseMemoryPage('learning/mission')).toMatchObject({
      ok: true,
      value: {
        page: 'learning/mission',
        file: 'learning/mission.md',
        mode: 'append',
        requireExists: false,
        appendable: true
      }
    })
    expect(parseMemoryPage('learning/path')).toMatchObject({
      ok: true,
      value: { page: 'learning/path', file: 'learning/path.md', appendable: true }
    })
    expect(parseMemoryPage('learning/resources')).toMatchObject({
      ok: true,
      value: { page: 'learning/resources', file: 'learning/resources.md', appendable: true }
    })
    expect(parseMemoryPage('learning/record-0001-intro')).toMatchObject({
      ok: true,
      value: {
        page: 'learning/record-0001-intro',
        file: 'learning/record-0001-intro.md',
        requireExists: false,
        appendable: true
      }
    })
  })

  it('still refuses traversal and too-many-segments under learning/ (T123)', () => {
    expect(parseMemoryPage('learning/../../etc/passwd').ok).toBe(false)
    expect(parseMemoryPage('learning/records/0001-intro').ok).toBe(false) // 3 segments
    expect(parseMemoryPage('learning/a/b').ok).toBe(false) // too many segments
    expect(parseMemoryPage('/etc/learning/mission').ok).toBe(false) // absolute
  })

  it.each([
    ['../etc/passwd'],
    ['roadmap/../../secret'],
    ['/etc/passwd'],
    ['roadmap/a/b'],
    ['..'],
    ['roadmap/'],
    ['unknown'],
    ['foo/bar'],
    ['roadmap/bad name'],
    ['hot\\evil']
  ])('rejects the traversal / unknown page %s', (page) => {
    expect(parseMemoryPage(page).ok).toBe(false)
  })

  it('rejects a non-string / empty page', () => {
    expect(parseMemoryPage(42).ok).toBe(false)
    expect(parseMemoryPage('').ok).toBe(false)
    expect(parseMemoryPage('   ').ok).toBe(false)
  })
})

describe('resolvePageFile containment', () => {
  const dir = '/home/u/repo/.harnu/memory'
  it('resolves a valid page inside the memory dir', () => {
    const parsed = parseMemoryPage('roadmap/T74')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(resolvePageFile(dir, parsed.value)).toBe(`${dir}/roadmap/T74.md`)
  })

  it('resolves a Harnu Learn record page inside the memory dir (T123)', () => {
    const parsed = parseMemoryPage('learning/record-0001-intro')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(resolvePageFile(dir, parsed.value)).toBe(`${dir}/learning/record-0001-intro.md`)
    }
  })

  it('returns null if the file (somehow) escapes the memory dir', () => {
    const escaping: ParsedMemoryPage = {
      page: 'x',
      file: '../../../etc/passwd',
      mode: 'append',
      requireExists: false,
      appendable: true
    }
    expect(resolvePageFile(dir, escaping)).toBeNull()
  })
})

describe('validateEntry (caps + appendability + secrets)', () => {
  const page = (over: Partial<ParsedMemoryPage> = {}): ParsedMemoryPage => ({
    page: 'decisions',
    file: 'decisions.md',
    mode: 'append',
    requireExists: false,
    appendable: true,
    ...over
  })

  it('accepts a normal entry', () => {
    expect(validateEntry(page(), 'chose grep over embeddings for v1')).toEqual({ ok: true })
  })

  it('refuses a non-appendable page', () => {
    expect(validateEntry(page({ appendable: false }), 'x').ok).toBe(false)
  })

  it('refuses an empty entry', () => {
    expect(validateEntry(page(), '   ').ok).toBe(false)
  })

  it('refuses an entry over the char cap', () => {
    expect(validateEntry(page(), 'a'.repeat(MEMORY_ENTRY_MAX_CHARS + 1)).ok).toBe(false)
  })

  it('refuses a hot (replace) snapshot over the word cap', () => {
    const tooMany = Array.from({ length: HOT_MAX_WORDS + 1 }, (_, i) => `w${i}`).join(' ')
    expect(validateEntry(page({ mode: 'replace' }), tooMany).ok).toBe(false)
    const ok = Array.from({ length: HOT_MAX_WORDS }, (_, i) => `w${i}`).join(' ')
    expect(validateEntry(page({ mode: 'replace' }), ok)).toEqual({ ok: true })
  })

  it('refuses an entry that carries an obvious secret (naming the kind, not the value)', () => {
    const r = validateEntry(page(), 'token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.detail).toContain('github-token')
      expect(r.detail).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    }
  })
})

describe('lintSecrets', () => {
  it.each([
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key-block'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key-id'],
    ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'github-token'],
    ['xoxb-1234567890-abcdefghijklmnop', 'slack-token'],
    ['password: hunter2000longenough', 'credential-assignment']
  ])('flags %s as %s', (text, kind) => {
    const r = lintSecrets(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe(kind)
  })

  it('passes ordinary prose', () => {
    expect(lintSecrets('We decided to use grep for v1; embeddings deferred to S5.')).toEqual({
      ok: true
    })
  })
})

describe('provenance (server-stamped)', () => {
  it('formats an injected clock as YYYY-MM-DD', () => {
    expect(formatMemoryDate(FIXED_NOW)).toBe('2023-11-14')
  })

  it('renders a visible, greppable one-line blockquote', () => {
    const p: Provenance = { author: 'agent', at: '2026-07-06', branch: 'feat/t79-s1-memory' }
    expect(renderProvenance(p)).toBe(
      '> provenance: author=agent · at=2026-07-06 · branch=feat/t79-s1-memory'
    )
  })

  it('omits empty branch/session but always shows author + at', () => {
    expect(renderProvenance({ author: 'human', at: '2026-07-06' })).toBe(
      '> provenance: author=human · at=2026-07-06'
    )
  })
})

describe('splitFrontmatter', () => {
  it('splits a leading YAML block from the body', () => {
    const { frontmatter, body } = splitFrontmatter('---\nid: T1\nstatus: ready\n---\n\nbody\n')
    expect(frontmatter).toBe('---\nid: T1\nstatus: ready\n---\n')
    expect(body).toBe('\nbody\n')
  })

  it('treats a file with no frontmatter as all body', () => {
    expect(splitFrontmatter('# hot\ncontent')).toEqual({ frontmatter: '', body: '# hot\ncontent' })
  })

  it('does not corrupt a malformed (unterminated) frontmatter — all body', () => {
    expect(splitFrontmatter('---\nid: T1\nno close')).toEqual({
      frontmatter: '',
      body: '---\nid: T1\nno close'
    })
  })
})

describe('buildMemoryWrite (body-append / hot-replace)', () => {
  const prov: Provenance = { author: 'agent', at: '2026-07-06', branch: 'feat/x' }

  it('appends to the BODY and never rewrites frontmatter/status', () => {
    const existing = '---\nid: T74\nstatus: ready\n---\n\nexisting body\n'
    const out = buildMemoryWrite({
      existing,
      entry: '## note\nnew line',
      provenance: prov,
      mode: 'append'
    })
    // Frontmatter intact, exactly once.
    expect(out).toContain('---\nid: T74\nstatus: ready\n---\n')
    expect(out.match(/status: ready/g)?.length).toBe(1)
    // Old body kept, new entry + provenance appended after it.
    const bodyIdx = out.indexOf('existing body')
    const entryIdx = out.indexOf('new line')
    const provIdx = out.indexOf('> provenance:')
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(entryIdx).toBeGreaterThan(bodyIdx)
    expect(provIdx).toBeGreaterThan(entryIdx)
  })

  it('replace (hot) swaps the whole body for the new snapshot + provenance', () => {
    const existing = '# Harnu — hot\nold snapshot\n'
    const out = buildMemoryWrite({
      existing,
      entry: '# Harnu — hot\nfresh',
      provenance: prov,
      mode: 'replace'
    })
    expect(out).not.toContain('old snapshot')
    expect(out).toBe(
      '# Harnu — hot\nfresh\n\n> provenance: author=agent · at=2026-07-06 · branch=feat/x\n'
    )
  })

  it('replace still preserves frontmatter if a page has it', () => {
    const existing = '---\nid: X\n---\nold body\n'
    const out = buildMemoryWrite({ existing, entry: 'new', provenance: prov, mode: 'replace' })
    expect(out).toContain('---\nid: X\n---\n')
    expect(out).not.toContain('old body')
    expect(out).toContain('new')
  })

  it('appends cleanly to an empty (fresh) file', () => {
    const out = buildMemoryWrite({ existing: '', entry: 'first', provenance: prov, mode: 'append' })
    expect(out).toBe('first\n\n> provenance: author=agent · at=2026-07-06 · branch=feat/x\n')
  })
})

describe('parseCardMeta', () => {
  it('reads top-level id/title/status and ignores nested provenance', () => {
    const card =
      '---\nid: T74\ntitle: Markdown viewer\nstatus: ready\nprovenance:\n  author: human\n  at: 2026-07-06\n---\n\nbody\n'
    expect(parseCardMeta(card)).toEqual({ id: 'T74', title: 'Markdown viewer', status: 'ready' })
  })

  it('returns empty for a file with no frontmatter', () => {
    expect(parseCardMeta('# just a heading')).toEqual({})
  })
})

describe('buildMemoryIndex (deterministic)', () => {
  it('groups cards by status in the canonical order', () => {
    const md = buildMemoryIndex({
      hasHot: true,
      hasDecisions: true,
      cards: [
        { page: 'roadmap/T80', id: 'T80', title: 'Kanban', status: 'backlog' },
        { page: 'roadmap/T74', id: 'T74', title: 'Markdown', status: 'ready' },
        { page: 'roadmap/T67', id: 'T67', title: 'Fleet', status: 'in-progress' }
      ],
      sessions: ['2026-07-06-abcd.md'],
      archive: ['TASKS-legacy.md', 'BUGS-legacy.md'],
      generatedAt: '2026-07-06'
    })
    expect(md).toContain('# Harnu — memory index (auto-generated)')
    expect(md).toContain('updated 2026-07-06')
    // ready before in-progress before backlog.
    expect(md.indexOf('**ready**')).toBeLessThan(md.indexOf('**in-progress**'))
    expect(md.indexOf('**in-progress**')).toBeLessThan(md.indexOf('**backlog**'))
    expect(md).toContain('[[roadmap/T74|T74: Markdown]]')
    expect(md).toContain('sessions/** — session digests. 1 files.')
    expect(md).toContain('archive/** — frozen, read-only history. 2 files.')
  })

  it('handles a card with no status (trails under no-status)', () => {
    const md = buildMemoryIndex({
      hasHot: false,
      hasDecisions: false,
      cards: [{ page: 'roadmap/T1', id: 'T1' }],
      sessions: [],
      archive: [],
      generatedAt: '2026-07-06'
    })
    expect(md).toContain('**no-status**')
    expect(md).not.toContain('hot.md** — where we left off')
  })

  it('lists learning/ file count when present, omits the line when absent (T123)', () => {
    const withLearning = buildMemoryIndex({
      hasHot: false,
      hasDecisions: false,
      cards: [],
      sessions: [],
      archive: [],
      learning: ['mission.md', 'path.md', 'resources.md', 'record-0001-intro.md'],
      generatedAt: '2026-07-06'
    })
    expect(withLearning).toContain(
      'learning/** — Harnu Learn mission, path, resources, and learning records'
    )
    expect(withLearning).toContain('4 files')

    const withoutLearning = buildMemoryIndex({
      hasHot: false,
      hasDecisions: false,
      cards: [],
      sessions: [],
      archive: [],
      generatedAt: '2026-07-06'
    })
    expect(withoutLearning).not.toContain('learning/**')
  })
})

describe('grepMemory (v1 query)', () => {
  const files = [
    { page: 'hot', content: 'AGORA — rodada 5\nPRÓXIMO consolidar' },
    { page: 'decisions', content: 'chose grep over EMBEDDINGS for v1' }
  ]

  it('matches case-insensitively with page + 1-indexed line', () => {
    const { matches, truncated } = grepMemory(files, 'embeddings')
    expect(truncated).toBe(false)
    expect(matches).toEqual([
      { page: 'decisions', line: 1, text: 'chose grep over EMBEDDINGS for v1' }
    ])
  })

  it('reports the correct line number on a later line', () => {
    const { matches } = grepMemory(files, 'próximo')
    expect(matches).toEqual([{ page: 'hot', line: 2, text: 'PRÓXIMO consolidar' }])
  })

  it('bounds the result set and flags truncation', () => {
    const many = { page: 'p', content: Array.from({ length: 10 }, () => 'hit').join('\n') }
    const { matches, truncated } = grepMemory([many], 'hit', 3)
    expect(matches).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('returns nothing for an empty query', () => {
    expect(grepMemory(files, '   ')).toEqual({ matches: [], truncated: false })
  })
})
