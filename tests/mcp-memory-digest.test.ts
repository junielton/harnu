import { describe, it, expect } from 'vitest'
import {
  buildTimeline,
  extractHotPreview,
  parseDigestMeta,
  parseProvenanceLine,
  renderProvenance,
  HOT_PREVIEW_MAX_LINES,
  type DigestFile
} from '../src/main/mcp/memory-core'

/**
 * T79 S3 — the pure memory-UI core: the folder-hover `hot.md` preview trim and
 * the session-digest timeline parse. Framework-free + side-effect-free (no
 * fs/clock) so the resolution/parse decisions are pinned here; the env shell
 * (`memory-store.ts`, `readMemoryForFolder`) only marshals the fs effect.
 */

// ---- extractHotPreview (the 1s hover cue) -----------------------------------

describe('extractHotPreview', () => {
  it('returns the snapshot of a real hot, dropping the trailing provenance stamp', () => {
    // A real hot after a `memory_append(page:hot)` replace: <snapshot> + stamp.
    const hot =
      'NOW: T79 S3 memory UI.\n\n' +
      '- hover-hot done\n- memory pane in progress\n\n' +
      '> provenance: author=human · at=2026-07-06 · branch=feat/t79-s3-memory-ui\n'
    const out = extractHotPreview(hot)
    expect(out).toContain('NOW: T79 S3 memory UI.')
    expect(out).toContain('- hover-hot done')
    expect(out).not.toContain('provenance')
  })

  it('strips the H1 title and the scaffold guidance blockquote, keeping the placeholder', () => {
    const seed =
      '# Harnu — hot (where we left off)\n' +
      '> ≤500 words · 1s resume cue · edit by hand or via memory_append(page:hot) (replace).\n\n' +
      '_(memory just created — no state recorded yet)_\n'
    const out = extractHotPreview(seed)
    expect(out).toBe('_(memory just created — no state recorded yet)_')
    expect(out).not.toContain('#')
    expect(out).not.toContain('≤500')
  })

  it('respects the max-lines cap', () => {
    const body = Array.from({ length: 20 }, (_, i) => `linha ${i + 1}`).join('\n')
    const out = extractHotPreview(body, 3)
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toBe('linha 1\nlinha 2\nlinha 3')
  })

  it('defaults the cap to HOT_PREVIEW_MAX_LINES', () => {
    const body = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    expect(extractHotPreview(body).split('\n')).toHaveLength(HOT_PREVIEW_MAX_LINES)
  })

  it('ignores YAML frontmatter', () => {
    const hot = '---\ntitle: x\n---\nreal content line\n'
    expect(extractHotPreview(hot)).toBe('real content line')
  })

  it('returns empty string when there is nothing but chrome', () => {
    expect(extractHotPreview('# only a title\n')).toBe('')
    expect(extractHotPreview('')).toBe('')
  })
})

// ---- parseProvenanceLine ----------------------------------------------------

describe('parseProvenanceLine', () => {
  it('round-trips renderProvenance', () => {
    const line = renderProvenance({
      author: 'agent',
      at: '2026-07-06',
      branch: 'feat/x',
      sessionId: 'abc123def456'
    })
    expect(parseProvenanceLine(line)).toEqual({
      author: 'agent',
      at: '2026-07-06',
      branch: 'feat/x',
      sessionId: 'abc123def456'
    })
  })

  it('finds the stamp among other lines and returns the first one', () => {
    const content =
      '# Digest\n\nsome text\n\n' +
      '> provenance: author=human · at=2026-07-01\n' +
      '> provenance: author=agent · at=2026-07-02\n'
    expect(parseProvenanceLine(content)).toEqual({ author: 'human', at: '2026-07-01' })
  })

  it('coerces an unknown author to agent (fail-closed vocabulary)', () => {
    expect(parseProvenanceLine('> provenance: author=robot · at=2026-07-06').author).toBe('agent')
  })

  it('returns {} when there is no stamp', () => {
    expect(parseProvenanceLine('# just a heading\nno stamp here')).toEqual({})
  })
})

// ---- parseDigestMeta --------------------------------------------------------

describe('parseDigestMeta', () => {
  it('parses date + short id from the filename and title from the first heading', () => {
    const content =
      '# Shipped the memory pane\n\nDid the thing.\n\n' +
      '> provenance: author=agent · at=2026-07-06 · branch=feat/t79 · session=abcd1234ef\n'
    const meta = parseDigestMeta('2026-07-06-abcd1234.md', content)
    expect(meta).toMatchObject({
      page: 'sessions/2026-07-06-abcd1234',
      file: 'sessions/2026-07-06-abcd1234.md',
      date: '2026-07-06',
      sessionShort: 'abcd1234',
      title: 'Shipped the memory pane',
      author: 'agent',
      branch: 'feat/t79',
      sessionId: 'abcd1234ef'
    })
  })

  it('falls back to the filename stem as the title when there is no heading', () => {
    const meta = parseDigestMeta('2026-07-06-deadbeef.md', 'no heading, just prose\n')
    expect(meta.title).toBe('2026-07-06-deadbeef')
  })

  it('still parses a hand-authored digest whose name breaks the convention', () => {
    const meta = parseDigestMeta('random-notes.md', '# Notes\n')
    expect(meta.date).toBe('')
    expect(meta.sessionShort).toBe('')
    expect(meta.page).toBe('sessions/random-notes')
    expect(meta.title).toBe('Notes')
  })

  it('omits provenance fields when the stamp is absent', () => {
    const meta = parseDigestMeta('2026-07-06-aaaa1111.md', '# T\n\nbody\n')
    expect(meta.author).toBeUndefined()
    expect(meta.branch).toBeUndefined()
    expect(meta.sessionId).toBeUndefined()
  })
})

// ---- buildTimeline ----------------------------------------------------------

describe('buildTimeline', () => {
  const file = (name: string): DigestFile => ({ name, content: `# ${name}\n` })

  it('orders newest-first by filename date', () => {
    const files = [
      file('2026-07-01-aaaaaaaa.md'),
      file('2026-07-06-bbbbbbbb.md'),
      file('2026-07-03-cccccccc.md')
    ]
    expect(buildTimeline(files).map((d) => d.date)).toEqual([
      '2026-07-06',
      '2026-07-03',
      '2026-07-01'
    ])
  })

  it('breaks a same-day tie by filename descending (deterministic)', () => {
    const files = [file('2026-07-06-aaaa0001.md'), file('2026-07-06-zzzz9999.md')]
    expect(buildTimeline(files).map((d) => d.sessionShort)).toEqual(['zzzz9999', 'aaaa0001'])
  })

  it('is empty for no digests', () => {
    expect(buildTimeline([])).toEqual([])
  })
})
