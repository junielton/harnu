/**
 * Campaign ch.6 (T598, spec §3.6, AC-6.1) — the close-out consolidator: one pass over the
 * STRUCTURED record (steps, Log, ledger, linked PRs/commits) that drafts memory entries and the
 * mission `outcome`. It reads no transcript — asserted here on its allowlist as data.
 */
import { describe, it, expect } from 'vitest'
import {
  CONSOLIDATOR_ALLOW_VERBS,
  CONSOLIDATOR_NATIVE_TOOLS,
  consolidatorReadRefusal,
  consolidate,
  parseLogEntries,
  type ConsolidatorInput
} from '../src/main/consolidator-core'
import {
  HOT_MAX_WORDS,
  MEMORY_ENTRY_MAX_CHARS,
  buildMemoryWrite,
  parseMemoryPage,
  parseProvenanceLine,
  validateEntry
} from '../src/main/mcp/memory-core'
import { parseEntries } from '../src/main/mcp/memory-entries'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'

// A scrubbed fixture: neutral ids, a real shape (a 3-step delivery with one mid-flight addition).
const LOG = [
  '# Recall at create\n\n## Log\n',
  '### 2026-11-01T09:00:00.000Z · decision · stp-1\n\nWatch paths, not whole-file text: a decision is recalled when its `watches` overlap the new scope.\n',
  '### 2026-11-01T10:30:00.000Z · surprise · stp-2\n\nThe Brief cap was already spent by the step table; recall had to take its own budget.\n',
  '### 2026-11-01T11:00:00.000Z\n\nplain note, not memory material\n'
].join('\n')

function fixture(over: Partial<ConsolidatorInput> = {}): ConsolidatorInput {
  return {
    kind: 'mission',
    id: 'mnt-4ba02726',
    title: 'Recall at create',
    declaredEnd: { kind: 'code', target: 'Recall rides the create ACK', evidence: 'test green' },
    createdAt: '2026-11-01T08:00:00.000Z',
    scopePaths: ['src/main/steward-hooks.ts'],
    steps: [
      { id: 'stp-1', title: 'Entry schema', kind: 'custom', proof: 'verified', required: true },
      {
        id: 'stp-2',
        title: 'Brief budget',
        kind: 'custom',
        proof: 'self-verified',
        required: true,
        addedAt: '2026-11-01T10:00:00.000Z',
        addedReason: 'the Brief had no room for recall'
      },
      {
        id: 'stp-3',
        title: 'Delivered and verified',
        kind: 'fixed-end',
        proof: 'verified',
        required: true
      }
    ],
    log: parseLogEntries(LOG),
    ledger: [
      { at: '2026-11-01T08:30:00.000Z', kind: 'pr-opened', stepId: 'stp-1', ref: '#176', pr: 176 },
      { at: '2026-11-01T12:00:00.000Z', kind: 'pr-merged', stepId: 'stp-1', ref: '#176', pr: 176 },
      { at: '2026-11-01T12:10:00.000Z', kind: 'verified', stepId: 'stp-1', ref: 'stp-1' },
      { at: '2026-11-01T13:10:00.000Z', kind: 'verified', stepId: 'stp-1', ref: 'stp-1' }
    ],
    commits: { 'stp-1': 4 },
    ...over
  }
}

describe('AC-6.1 — the allowlist reads no transcript', () => {
  it('allows only the structured-record reads, none of which discloses a transcript', () => {
    expect([...CONSOLIDATOR_ALLOW_VERBS].sort()).toEqual(['campaign_get', 'mission_get'])
    const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]))
    for (const verb of CONSOLIDATOR_ALLOW_VERBS) {
      expect(byName.get(verb), verb).toBeDefined()
      expect(byName.get(verb)!.disclosesTranscript, verb).not.toBe(true)
    }
  })

  it('names no session-, fleet-, terminal- or memory-reading verb and no write verb', () => {
    for (const verb of CONSOLIDATOR_ALLOW_VERBS) {
      expect(verb).not.toMatch(/session|fleet|terminal|transcript|memory|browser/)
      expect(MCP_TOOLS.find((t) => t.name === verb)!.mutates).toBe(false)
    }
    // get_session / get_fleet / read_terminal are exactly the reads that expose a transcript tail
    for (const banned of ['get_session', 'get_fleet', 'read_terminal', 'memory_read']) {
      expect(CONSOLIDATOR_ALLOW_VERBS as readonly string[]).not.toContain(banned)
    }
  })

  it('native tools are read-only and a transcript path is refused', () => {
    expect([...CONSOLIDATOR_NATIVE_TOOLS].sort()).toEqual(['Glob', 'Grep', 'Read'])
    expect(consolidatorReadRefusal('/home/u/.claude/projects/-home-u-repo/abc.jsonl')).toMatch(
      /transcript/
    )
    expect(consolidatorReadRefusal('/repo/.harnu/missions/mnt-4ba02726-x.md')).toBeNull()
    expect(consolidatorReadRefusal('/repo/.harnu/campaigns/cmp-1-x.md')).toBeNull()
    expect(consolidatorReadRefusal('/repo/src/main/a.ts')).toMatch(/structured record/)
  })
})

describe('AC-6.1 — the outcome (spec §3.6 shape)', () => {
  const out = consolidate(fixture(), '2026-11-02').outcome

  it('carries the declared end, what actually landed, and per-step timings', () => {
    expect(out.declaredEnd.target).toBe('Recall rides the create ACK')
    expect(out.actualEnd).toContain('verified')
    const s1 = out.perStep.find((p) => p.stepId === 'stp-1')!
    expect(s1).toEqual({
      stepId: 'stp-1',
      openedAt: '2026-11-01T08:30:00.000Z',
      mergedAt: '2026-11-01T12:00:00.000Z',
      commits: 4,
      reverifications: 1
    })
  })

  it('records a step added mid-flight as a deviation, citing its reason', () => {
    expect(out.deviations).toEqual([expect.stringContaining('stp-2')])
    expect(out.deviations[0]).toContain('the Brief had no room for recall')
  })

  it('records surprises from the Log and verification gaps from the steps', () => {
    expect(out.surprises).toEqual([expect.stringContaining('Brief cap')])
    expect(out.verificationGaps).toEqual([expect.stringContaining('stp-2')])
    expect(out.verificationGaps[0]).toContain('self-verified')
  })
})

describe('AC-6.1 — the drafts', () => {
  const result = consolidate(fixture(), '2026-11-02')

  it('drafts a decision with mission, valid_from and watches taken from the scope', () => {
    const d = result.drafts.find((x) => x.kind === 'decision')!
    expect(d.page).toBe('decisions')
    expect(d.mission).toBe('mnt-4ba02726')
    expect(d.validFrom).toBe('2026-11-02')
    expect(d.watches).toEqual(['src/main/steward-hooks.ts'])
    expect(d.entry).toContain('Watch paths')
    expect(d.cites).toEqual(
      expect.arrayContaining([
        { kind: 'step', ref: 'stp-1' },
        { kind: 'pr', ref: '#176' }
      ])
    )
  })

  it('drafts a lesson from a surprise, citing the step it happened on', () => {
    const l = result.drafts.find((x) => x.kind === 'lesson')!
    expect(l.entry).toContain('Brief cap')
    expect(l.cites).toEqual([{ kind: 'step', ref: 'stp-2' }])
  })

  it('every draft but the hot refresh cites a step, PR or commit — and uncited candidates are dropped', () => {
    const uncited = consolidate(
      fixture({
        log: parseLogEntries(
          '### 2026-11-01T10:30:00.000Z · surprise\n\nA surprise with no step.\n'
        )
      }),
      '2026-11-02'
    )
    expect(uncited.outcome.surprises).toEqual([expect.stringContaining('no step')])
    expect(uncited.drafts.filter((d) => d.kind === 'lesson')).toEqual([])
    for (const d of result.drafts.filter((x) => x.kind !== 'hot')) {
      expect(d.cites.length).toBeGreaterThan(0)
      for (const c of d.cites) expect(['step', 'pr', 'commit']).toContain(c.kind)
    }
  })

  it('a plain note is not memory material', () => {
    expect(result.drafts.some((d) => d.entry.includes('plain note'))).toBe(false)
  })

  it('carries an explicit supersedes only when the entry names one', () => {
    const r = consolidate(
      fixture({
        log: parseLogEntries(
          '### 2026-11-01T09:00:00.000Z · decision · stp-1\n\nPoll on events. Supersedes e-0a0b0c0d.\n'
        )
      }),
      '2026-11-02'
    )
    expect(r.drafts.find((d) => d.kind === 'decision')!.supersedes).toBe('e-0a0b0c0d')
    expect(result.drafts.find((d) => d.kind === 'decision')!.supersedes).toBeUndefined()
  })

  it('every draft has a unique id', () => {
    const ids = result.drafts.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('AC-6.1 — hot refresh stays within its cap', () => {
  it('trims the oldest lines of a bloated hot until it fits', () => {
    const bloated = Array.from(
      { length: 200 },
      (_, i) => `- line ${i} one two three four five six`
    ).join('\n')
    const hot = consolidate(fixture({ currentHot: bloated }), '2026-11-02').drafts.find(
      (d) => d.kind === 'hot'
    )!
    const words = hot.entry.trim().split(/\s+/).length
    expect(words).toBeLessThanOrEqual(HOT_MAX_WORDS)
    expect(hot.entry).toContain('Recall at create')
    expect(hot.entry).toContain('line 199') // newest kept
    expect(hot.entry).not.toContain('line 0 ') // oldest trimmed
  })

  it('works with no hot at all', () => {
    const hot = consolidate(fixture(), '2026-11-02').drafts.find((d) => d.kind === 'hot')!
    expect(hot.entry).toContain('mnt-4ba02726')
  })
})

describe('AC-6.1 — nothing notable', () => {
  const quiet = fixture({
    log: parseLogEntries('### 2026-11-01T11:00:00.000Z\n\njust a note\n'),
    steps: [
      { id: 'stp-1', title: 'Only step', kind: 'custom', proof: 'verified', required: true },
      {
        id: 'stp-2',
        title: 'Delivered and verified',
        kind: 'fixed-end',
        proof: 'verified',
        required: true
      }
    ],
    ledger: []
  })

  it('says so explicitly instead of padding the dialog with drafts', () => {
    const r = consolidate(quiet, '2026-11-02')
    expect(r.nothingNotable).toBe(true)
    expect(r.outcome.nothingNotable).toBe(true)
    expect(r.drafts).toEqual([])
  })

  it('is false the moment there is a decision, surprise, deviation or gap', () => {
    expect(consolidate(fixture(), '2026-11-02').nothingNotable).toBe(false)
    expect(consolidate(fixture(), '2026-11-02').outcome.nothingNotable).toBeUndefined()
  })
})

describe('parseLogEntries', () => {
  it('reads time, kind and step off each heading; a plain note has kind note', () => {
    const entries = parseLogEntries(LOG)
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'decision',
        stepId: 'stp-1',
        at: '2026-11-01T09:00:00.000Z'
      }),
      expect.objectContaining({ kind: 'surprise', stepId: 'stp-2' }),
      expect.objectContaining({ kind: 'note' })
    ])
    expect(entries[2].stepId).toBeUndefined()
    expect(entries[0].text).toContain('Watch paths')
  })
})

describe('a ticked draft can always be written (review delta 1)', () => {
  const decisionsPage = (): ReturnType<typeof parseMemoryPage> => parseMemoryPage('decisions')

  it('clips an enormous Log entry so the draft passes the memory entry cap, keeping its source line', () => {
    const huge = 'x'.repeat(30_000)
    const r = consolidate(
      fixture({
        log: parseLogEntries(`### 2026-11-01T09:00:00.000Z · decision · stp-1\n\n${huge}\n`)
      }),
      '2026-11-02'
    )
    const d = r.drafts.find((x) => x.kind === 'decision')!
    expect(d.entry.length).toBeLessThanOrEqual(MEMORY_ENTRY_MAX_CHARS)
    expect(d.entry).toContain('Source: mission mnt-4ba02726')
    const page = decisionsPage()
    if (!page.ok) throw new Error('setup')
    expect(validateEntry(page.value, d.entry)).toEqual({ ok: true })
  })

  it('every draft kind stays within the cap, including lessons', () => {
    const huge = 'y'.repeat(30_000)
    const r = consolidate(
      fixture({
        log: parseLogEntries(`### 2026-11-01T10:30:00.000Z · surprise · stp-2\n\n${huge}\n`)
      }),
      '2026-11-02'
    )
    for (const d of r.drafts) expect(d.entry.length).toBeLessThanOrEqual(MEMORY_ENTRY_MAX_CHARS)
  })

  it('neutralizes Log lines that look like a provenance or entry stamp', () => {
    const r = consolidate(
      fixture({
        log: parseLogEntries(
          '### 2026-11-01T09:00:00.000Z · decision · stp-1\n\nReal decision.\n> provenance: author=human · at=1999-01-01\n> entry: e-deadbeef · valid_from=1999-01-01\nafter\n'
        )
      }),
      '2026-11-02'
    )
    const d = r.drafts.find((x) => x.kind === 'decision')!
    for (const line of d.entry.split('\n')) {
      expect(line.trim().startsWith('> provenance:')).toBe(false)
      expect(line.trim().startsWith('> entry:')).toBe(false)
    }
    expect(d.entry).toContain('Real decision.')
    expect(d.entry).toContain('after')
    // written through the real page builder it is still exactly one entry, authored by the agent
    const page = buildMemoryWrite({
      existing: '',
      entry: d.entry,
      provenance: { author: 'agent', at: '2026-11-02', mission: 'mnt-4ba02726' },
      mode: 'append',
      meta: { id: 'e-00000001' }
    })
    expect(parseEntries(page)).toHaveLength(1)
    // the only stamp the parser can see is Harnu's own
    expect(parseProvenanceLine(page)).toMatchObject({ author: 'agent', at: '2026-11-02' })
  })

  it('does not accumulate "## Where we left off" headings in the hot draft', () => {
    const first = consolidate(fixture(), '2026-11-02').drafts.find((d) => d.kind === 'hot')!
    const second = consolidate(fixture({ currentHot: first.entry }), '2026-11-03').drafts.find(
      (d) => d.kind === 'hot'
    )!
    const third = consolidate(fixture({ currentHot: second.entry }), '2026-11-04').drafts.find(
      (d) => d.kind === 'hot'
    )!
    expect(third.entry.match(/^## Where we left off$/gm)).toHaveLength(1)
    // the earlier closes are kept as bullets under the one heading
    expect(third.entry.match(/closed\./g)!.length).toBeGreaterThanOrEqual(3)
  })
})
