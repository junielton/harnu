/**
 * Campaign ch.6 (T598, spec §3.6) — the memory entry schema: `valid_from`, `watches`, `supersedes` /
 * `superseded_by` and `mission:<id>` provenance, plus the recall match (AC-6.2 backend, AC-6.3).
 * Pure: every function works on strings, so the supersede chain and the overlap rule are asserted
 * byte for byte.
 */
import { describe, it, expect } from 'vitest'
import {
  buildMemoryWrite,
  grepMemory,
  parseProvenanceLine,
  renderProvenance
} from '../src/main/mcp/memory-core'
import {
  annotateSuperseded,
  markSuperseded,
  mintEntryId,
  parseEntries,
  recallEntries,
  renderEntryMeta
} from '../src/main/mcp/memory-entries'

const PROV = { author: 'agent' as const, at: '2026-11-02', mission: 'mnt-4ba02726' }

function write(
  existing: string,
  entry: string,
  meta: Parameters<typeof renderEntryMeta>[0]
): string {
  return buildMemoryWrite({ existing, entry, provenance: PROV, mode: 'append', meta })
}

describe('AC-6.2 — provenance.mission and the entry meta line', () => {
  it('stamps mission=<id> in the provenance line and keeps it parseable', () => {
    const line = renderProvenance(PROV)
    expect(line).toBe('> provenance: author=agent · at=2026-11-02 · mission=mnt-4ba02726')
    expect(parseProvenanceLine(`x\n\n${line}\n`)).toMatchObject({
      author: 'agent',
      at: '2026-11-02'
    })
  })

  it('writes the meta line between the entry and its provenance', () => {
    const id = mintEntryId('Use gates', '2026-11-02')
    const out = write('', '## Use gates', {
      id,
      validFrom: '2026-11-02',
      watches: ['src/main/mission-gates.ts', 'gates']
    })
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('## Use gates')
    expect(lines[2]).toBe(
      `> entry: ${id} · valid_from=2026-11-02 · watches=src/main/mission-gates.ts,gates`
    )
    expect(lines[3]).toMatch(/^> provenance: .*mission=mnt-4ba02726/)
  })

  it('mints a stable, content-addressed id', () => {
    expect(mintEntryId('a', '2026-11-02')).toBe(mintEntryId('a', '2026-11-02'))
    expect(mintEntryId('a', '2026-11-02')).not.toBe(mintEntryId('b', '2026-11-02'))
    expect(mintEntryId('a', '2026-11-02')).toMatch(/^e-[0-9a-f]{8}$/)
  })
})

describe('AC-6.2 — the supersede chain', () => {
  const oldId = 'e-00000001'
  const newId = 'e-00000002'
  const base = write('', '## Poll every minute', { id: oldId, validFrom: '2026-10-01' })

  it('marks the old entry superseded_by the new one and touches nothing else', () => {
    const marked = markSuperseded(base, oldId, newId)
    expect(marked).not.toBeNull()
    expect(marked).toContain(`> entry: ${oldId} · valid_from=2026-10-01 · superseded_by=${newId}`)
    expect(marked!.replace(` · superseded_by=${newId}`, '')).toBe(base)
  })

  it('returns null when the superseded id is not on the page', () => {
    expect(markSuperseded(base, 'e-ffffffff', newId)).toBeNull()
  })

  it('refuses to supersede an entry that already has a successor', () => {
    const marked = markSuperseded(base, oldId, newId)!
    expect(markSuperseded(marked, oldId, 'e-00000003')).toBeNull()
  })

  it('a memory_query match inside the old entry carries its successor', () => {
    const marked = markSuperseded(base, oldId, newId)!
    const page = write(marked, '## Poll on events, 20m fallback', {
      id: newId,
      validFrom: '2026-11-02',
      supersedes: oldId
    })
    const { matches } = grepMemory([{ page: 'decisions', content: page }], 'poll every minute')
    const annotated = annotateSuperseded([{ page: 'decisions', content: page }], matches)
    expect(annotated).toHaveLength(1)
    expect(annotated[0].supersededBy).toEqual({
      id: newId,
      page: 'decisions',
      line: expect.any(Number),
      text: 'Poll on events, 20m fallback'
    })
    // the successor line points at the successor's first line, not at the old entry
    const succLine = page.split('\n')[annotated[0].supersededBy!.line - 1]
    expect(succLine).toBe('## Poll on events, 20m fallback')
  })

  it('a match in a live entry is left alone', () => {
    const files = [{ page: 'decisions', content: base }]
    const { matches } = grepMemory(files, 'poll')
    expect(annotateSuperseded(files, matches)[0].supersededBy).toBeUndefined()
  })
})

describe('parseEntries', () => {
  it('reads id, validity, watches, supersedes and the first line of each entry', () => {
    let page = write('', '## One\nbody one', { id: 'e-00000001', watches: ['a.ts'] })
    page = write(page, '## Two', {
      id: 'e-00000002',
      supersedes: 'e-00000001',
      validFrom: '2026-11-02'
    })
    const entries = parseEntries(page)
    expect(entries.map((e) => e.meta.id)).toEqual(['e-00000001', 'e-00000002'])
    expect(entries[0]).toMatchObject({ title: 'One', startLine: 1, meta: { watches: ['a.ts'] } })
    expect(entries[1].meta).toMatchObject({ supersedes: 'e-00000001', validFrom: '2026-11-02' })
  })

  it('skips the scaffold header (H1 + guidance quote) that precedes the first entry', () => {
    const scaffold =
      '# Harnu — decisions (append-only, most recent at the bottom)\n> Dated decisions + why.\n\n'
    const page = write(scaffold, '## First real decision\nbody', { id: 'e-00000001' })
    const [entry] = parseEntries(page)
    expect(entry.title).toBe('First real decision')
    expect(page.split('\n')[entry.startLine - 1]).toBe('## First real decision')
  })

  it('ignores entries written without a meta line (older memory)', () => {
    const legacy = buildMemoryWrite({
      existing: '',
      entry: '## Old decision',
      provenance: { author: 'agent', at: '2026-01-01' },
      mode: 'append'
    })
    expect(parseEntries(legacy)).toEqual([])
  })
})

describe('AC-6.3 — recall', () => {
  const files = (): { page: string; content: string }[] => {
    let decisions = write('', '## Gates govern verified\nbody', {
      id: 'e-0000000a',
      validFrom: '2026-10-20',
      watches: ['src/main/mission-gates.ts', 'verified']
    })
    decisions = write(decisions, '## Unrelated\nbody', {
      id: 'e-0000000b',
      watches: ['src/renderer/']
    })
    decisions = write(decisions, '## Old, replaced', { id: 'e-0000000c', watches: ['src/main/'] })
    decisions = markSuperseded(decisions, 'e-0000000c', 'e-0000000d')!
    return [{ page: 'decisions', content: decisions }]
  }

  it('matches a watched path against a scope path (same file, or a directory holding it)', () => {
    const hits = recallEntries(files(), { paths: ['src/main/mission-gates.ts'], topics: [] })
    expect(hits.map((h) => h.text)).toEqual(['Gates govern verified'])
    const dir = recallEntries(files(), { paths: ['src/renderer/components/X.vue'], topics: [] })
    expect(dir.map((h) => h.text)).toEqual(['Unrelated'])
  })

  it('matches a watched topic against chapter titles, case-insensitively', () => {
    const hits = recallEntries(files(), {
      paths: [],
      topics: ['Make steps VERIFIED only on green']
    })
    expect(hits.map((h) => h.text)).toEqual(['Gates govern verified'])
  })

  it('never recalls a superseded entry, and an empty scope recalls nothing', () => {
    expect(
      recallEntries(files(), { paths: ['src/main/'], topics: [] }).map((h) => h.text)
    ).not.toContain('Old, replaced')
    expect(recallEntries(files(), { paths: [], topics: [] })).toEqual([])
  })

  it('returns { page, line, text } where line points at the entry', () => {
    const [hit] = recallEntries(files(), { paths: ['src/main/mission-gates.ts'], topics: [] })
    expect(hit).toEqual({ page: 'decisions', line: 1, text: 'Gates govern verified' })
  })

  it('caps the number of hits', () => {
    let page = ''
    for (let i = 0; i < 12; i++) {
      page = write(page, `## D${i}`, { id: `e-0000010${i.toString(16)}`, watches: ['x.ts'] })
    }
    expect(
      recallEntries([{ page: 'decisions', content: page }], { paths: ['x.ts'], topics: [] }, 5)
    ).toHaveLength(5)
  })
})
