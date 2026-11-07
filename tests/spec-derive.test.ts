import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acHash, parseSpec } from '../resources/skills/skills/spec/scripts/spec-check-core.mjs'
import {
  applyBlock,
  planDerive,
  renderBlock
} from '../resources/skills/skills/spec/scripts/spec-derive-core.mjs'

/**
 * The derive planner (T601 S-6): `spec-derive.mjs <spec-path> --board <file>` reads a spec and a
 * board (`[{ slug, status, title, body }]`) and prints `{ create, update, skip, refuse }`. It
 * writes nothing. A card is matched to a slice by its `spec-slice` marker, else by an Amendments
 * `card` row; `backlog` and `ready` cards are updatable, any other status is `skip`, a marked card
 * whose slice is gone is `skip` as `orphan`. An update rewrites only the span between the
 * `spec:begin` / `spec:end` markers. A second plan over the board the first produced is empty.
 */

const ROOT = resolve(__dirname, '..')
const CLI = join(ROOT, 'resources/skills/skills/spec/scripts/spec-derive.mjs')
const FIX = join(ROOT, 'tests/fixtures/spec-derive')
const SPEC = join(FIX, 'spec.md')
const SPEC_REL = 'tests/fixtures/spec-derive/spec.md'
const REFUSE = join(FIX, 'refuse.md')
const REFUSE_REL = 'tests/fixtures/spec-derive/refuse.md'
const REAL_SPEC = join(ROOT, 'docs/specs/2026-11-harnu-spec/spec.md')
const read = (path: string): string => readFileSync(path, 'utf8')

type Card = { slug: string; status: string; title: string; body: string }
type Plan = {
  create: { slice: string; title: string; block: string }[]
  update: { slug: string; slice: string; block: string }[]
  skip: { slug?: string; slice: string; reason: string }[]
  refuse: { slice: string; reason: string }[]
}
const EMPTY_PLAN: Plan = { create: [], update: [], skip: [], refuse: [] }

const plan = (specPath: string, specRel: string, board: Card[]): Plan =>
  planDerive(read(specPath), specRel, board) as Plan

/** The envelope the orchestrator writes around a block; derive must never touch it. */
const envelope = (slice: string, block: string): string =>
  [
    `spec-slice: ${slice}`,
    '',
    '## Objective',
    '',
    'Return address: the owner session. Exit sequence: push, then report.',
    '',
    '## Acceptance criteria',
    '',
    block,
    '',
    '- [ ] AC-C — the PR follows CLAUDE.md',
    '',
    '## Honest exit clause',
    '',
    'Report `AC-n: unmet` with the reason; never weaken a test.',
    ''
  ].join('\n')

/** Apply a plan the way the orchestrator does: `create_card` per create, the spliced block per update. */
function applyPlan(board: Card[], p: Plan): Card[] {
  const next = board.map((c) => ({ ...c }))
  for (const u of p.update) {
    const card = next.find((c) => c.slug === u.slug)!
    card.body = applyBlock(card.body, u.slice, u.block)
  }
  for (const c of p.create) {
    next.push({
      slug: `card-${c.slice.toLowerCase()}`,
      status: 'backlog',
      title: c.title,
      body: envelope(c.slice, c.block)
    })
  }
  return next
}

const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

function withBoard<T>(board: unknown, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'spec-derive-'))
  try {
    const path = join(dir, 'board.json')
    writeFileSync(path, typeof board === 'string' ? board : JSON.stringify(board))
    return fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The span of a body from its `spec:begin` line through its `spec:end` line. */
function span(body: string, slice: string): { start: number; end: number } {
  const start = body.indexOf(`<!-- spec:begin ${slice} -->`)
  const endMarker = `<!-- spec:end ${slice} -->`
  const end = body.indexOf(endMarker) + endMarker.length
  if (start === -1 || end < endMarker.length) throw new Error(`no ${slice} block`)
  return { start, end }
}

describe('renderBlock', () => {
  it('writes the AC lines, the scope and the links between the markers', () => {
    const parsed = parseSpec(read(SPEC))
    const s1 = parsed.slices.find((s) => s.id === 'S-1')!
    const ac1 = parsed.acs.find((a) => a.id === 'AC-1')!
    const ac2 = parsed.acs.find((a) => a.id === 'AC-2')!
    expect(renderBlock(parsed, s1, SPEC_REL)).toBe(
      [
        '<!-- spec:begin S-1 -->',
        '',
        `- [ ] AC-1 ${acHash(ac1.statement, ac1.proof)} — ${ac1.statement} — proof: ${ac1.proof}`,
        `- [ ] AC-2 ${acHash(ac2.statement, ac2.proof)} — ${ac2.statement} — proof: ${ac2.proof}`,
        '',
        'scope: `src/export/stream.ts`, `tests/export-stream.test.ts`',
        `links: spec ${SPEC_REL}, prd docs/prds/acme-export.md, adr docs/adr/0042-acme-export.md`,
        '',
        '<!-- spec:end S-1 -->'
      ].join('\n')
    )
  })

  it('keeps a ticked box for an AC id the card already carries', () => {
    const parsed = parseSpec(read(SPEC))
    const s1 = parsed.slices.find((s) => s.id === 'S-1')!
    const block = renderBlock(parsed, s1, SPEC_REL, new Set(['AC-2']))
    expect(block).toMatch(/^- \[ \] AC-1 #/m)
    expect(block).toMatch(/^- \[x\] AC-2 #/m)
  })
})

describe('second plan is empty and in-progress cards are skipped', () => {
  it('creates one card per slice, and a second plan over the applied board is empty', () => {
    // A card of another spec carries `spec-slice: S-1`; it is not this spec's card.
    const foreign: Card = {
      slug: 'other-spec-card',
      status: 'backlog',
      title: 'S-1 · Something else',
      body: 'spec-slice: S-1\n\n<!-- spec:begin S-1 -->\n\nlinks: spec docs/specs/other/spec.md\n\n<!-- spec:end S-1 -->\n'
    }
    const first = plan(SPEC, SPEC_REL, [foreign])
    expect(first.refuse).toEqual([])
    expect(first.update).toEqual([])
    expect(first.skip).toEqual([])
    expect(first.create.map((c) => c.slice)).toEqual(['S-1', 'S-2', 'S-3'])
    expect(first.create.map((c) => c.title)).toEqual([
      'S-1 · Stream the export',
      'S-2 · Show `progress` while exporting',
      'S-3 · Export guide'
    ])
    const parsed = parseSpec(read(SPEC))
    for (const c of first.create) {
      const slice = parsed.slices.find((s) => s.id === c.slice)!
      expect(c.block).toBe(renderBlock(parsed, slice, SPEC_REL))
    }

    const applied = applyPlan([foreign], first)
    expect(applied).toHaveLength(4)
    expect(applied[0]).toEqual(foreign)
    expect(plan(SPEC, SPEC_REL, applied)).toEqual(EMPTY_PLAN)
  })

  it('skips a card in progress, in review or done with its status, and never changes it', () => {
    const stale = (slice: string) =>
      envelope(
        slice,
        `<!-- spec:begin ${slice} -->\n\n- [ ] AC-1 #0000 — an old statement — proof: test:x::y\n\n<!-- spec:end ${slice} -->`
      )
    const board: Card[] = [
      { slug: 'stream', status: 'in-progress', title: 'S-1 · Stream', body: stale('S-1') },
      // Matched by the Amendments `card` row only: no marker on the card.
      {
        slug: 'acme-progress',
        status: 'review',
        title: 'S-2',
        body: stale('S-2').replace('spec-slice: S-2\n', '')
      },
      { slug: 'guide', status: 'done', title: 'S-3 · Guide', body: stale('S-3') }
    ]
    const snapshot = JSON.parse(JSON.stringify(board))
    const p = plan(SPEC, SPEC_REL, board)
    expect(p).toEqual({
      create: [],
      update: [],
      refuse: [],
      skip: [
        { slug: 'stream', slice: 'S-1', reason: 'in-progress' },
        { slug: 'acme-progress', slice: 'S-2', reason: 'review' },
        { slug: 'guide', slice: 'S-3', reason: 'done' }
      ]
    })
    expect(board).toEqual(snapshot)

    // The CLI prints the same plan, exits 0 and leaves the board file byte-identical.
    withBoard(board, (path) => {
      const before = read(path)
      const res = run([SPEC, '--board', path])
      expect(res.status).toBe(0)
      expect(JSON.parse(res.stdout)).toEqual(p)
      expect(read(path)).toBe(before)
    })
  })

  it('plans the real harnu:spec spec over an empty board without a refusal', () => {
    withBoard([], (path) => {
      const res = run([REAL_SPEC, '--board', path])
      expect(res.stderr).not.toMatch(/refuse/i)
      expect(res.status).toBe(0)
      const p = JSON.parse(res.stdout) as Plan
      const ids = parseSpec(read(REAL_SPEC)).slices.map((s) => s.id)
      expect(p.create.map((c) => c.slice)).toEqual(ids)
      expect(p.create.find((c) => c.slice === 'S-6')!.title).toBe('S-6 · Derive planner')
      expect(p.create.find((c) => c.slice === 'S-6')!.block).toContain(
        'links: spec docs/specs/2026-11-harnu-spec/spec.md, prd docs/prds/T601-harnu-spec.md'
      )
      expect(p.refuse).toEqual([])
    })
  })
})

describe('update rewrites only the marked block for a marker and for a map row', () => {
  // Each card's block predates an AC change in the spec: AC-1 and AC-3 were reworded since.
  const oldBlock = (slice: string, lines: string[]) =>
    [
      `<!-- spec:begin ${slice} -->`,
      '',
      ...lines,
      '',
      'scope: `old/path.ts`',
      '',
      `<!-- spec:end ${slice} -->`
    ].join('\n')
  const byMarker: Card = {
    slug: 'stream-card',
    status: 'backlog',
    title: 'S-1 · Stream the export',
    body: envelope(
      'S-1',
      oldBlock('S-1', [
        '- [ ] AC-1 #26ec — Exports stream rows as they are read. — proof: test:tests/export-stream.test.ts::streams',
        '- [x] AC-2 #1111 — The stream keeps memory flat on a large export. — proof: test:tests/export-stream.test.ts::flat memory'
      ])
    )
  }
  const byMapRow: Card = {
    slug: 'acme-progress',
    status: 'backlog',
    title: 'S-2 · Show progress',
    body: envelope(
      'S-2',
      oldBlock('S-2', [
        '- [ ] AC-3 #2222 — The export reports progress. — proof: test:tests/export-progress.test.ts::reports'
      ])
    ).replace('spec-slice: S-2\n', '')
  }

  for (const [label, card, slice] of [
    ['found by its spec-slice marker', byMarker, 'S-1'],
    ['found only by an Amendments card row', byMapRow, 'S-2']
  ] as const) {
    it(`rewrites the span of a backlog card ${label}, every byte outside it unchanged`, () => {
      const board: Card[] = [card]
      const p = plan(SPEC, SPEC_REL, board)
      expect(p.refuse).toEqual([])
      expect(p.skip).toEqual([])
      expect(p.update.map((u) => [u.slug, u.slice])).toEqual([[card.slug, slice]])
      const { block } = p.update[0]
      expect(block.startsWith(`<!-- spec:begin ${slice} -->\n`)).toBe(true)
      expect(block.endsWith(`\n<!-- spec:end ${slice} -->`)).toBe(true)

      const after = applyBlock(card.body, slice, block)
      const was = span(card.body, slice)
      const now = span(after, slice)
      expect(after.slice(0, now.start)).toBe(card.body.slice(0, was.start))
      expect(after.slice(now.end)).toBe(card.body.slice(was.end))
      expect(after.slice(now.start, now.end)).toBe(block)

      const parsed = parseSpec(read(SPEC))
      for (const id of parsed.slices.find((s) => s.id === slice)!.acs) {
        const row = parsed.acs.find((a) => a.id === id)!
        expect(block).toContain(
          `${id} ${acHash(row.statement, row.proof)} — ${row.statement} — proof: ${row.proof}`
        )
      }
      // The second pass over the updated card changes nothing on it (the board holds only this
      // card, so the other slices are still planned as creates).
      const again = plan(SPEC, SPEC_REL, [{ ...card, body: after }])
      expect(again.update).toEqual([])
      expect(again.skip).toEqual([])
      expect(again.refuse).toEqual([])
      expect(again.create.map((c) => c.slice)).not.toContain(slice)
    })
  }

  it('keeps the ticked box of an AC it rewrites', () => {
    const p = plan(SPEC, SPEC_REL, [byMarker])
    expect(p.update[0].block).toMatch(/^- \[x\] AC-2 #/m)
    expect(p.update[0].block).toMatch(/^- \[ \] AC-1 #/m)
  })

  it('lets the card marker win over a map row that names another slice', () => {
    // The map row says S-2 -> acme-progress, but the card itself says it is S-1's card.
    const card: Card = {
      ...byMapRow,
      body: `spec-slice: S-1\n\n${byMapRow.body.replace(/S-2/g, 'S-1')}`
    }
    const p = plan(SPEC, SPEC_REL, [card])
    expect(p.update.map((u) => [u.slug, u.slice])).toEqual([['acme-progress', 'S-1']])
    expect(p.create.map((c) => c.slice)).toEqual(['S-2', 'S-3'])
  })
})

describe('plan refuses missing scope, overlap and broken markers', () => {
  const brokenCard: Card = {
    slug: 'broken-card',
    status: 'backlog',
    title: 'S-6 · Broken card',
    body: envelope(
      'S-6',
      '<!-- spec:begin S-6 -->\n\n- [ ] AC-1 #0000 — old — proof: x\n\n<!-- spec:begin S-6 -->'
    )
  }
  const orphan: Card = {
    slug: 'gone-card',
    status: 'backlog',
    title: 'S-8 · Gone',
    body: envelope(
      'S-8',
      `<!-- spec:begin S-8 -->\n\nlinks: spec ${REFUSE_REL}\n\n<!-- spec:end S-8 -->`
    )
  }

  it('refuses each broken slice once, with the reason, and skips an orphan', () => {
    const p = plan(REFUSE, REFUSE_REL, [brokenCard, orphan])
    const reasons = new Map(p.refuse.map((r) => [r.slice, r.reason]))
    expect([...reasons.keys()]).toEqual(['S-1', 'S-2', 'S-3', 'S-5', 'S-6'])
    expect(reasons.get('S-1')).toMatch(/files-may-touch/)
    expect(reasons.get('S-2')).toMatch(/overlap/)
    expect(reasons.get('S-2')).toMatch(/S-3/)
    expect(reasons.get('S-3')).toMatch(/overlap/)
    expect(reasons.get('S-3')).toMatch(/S-2/)
    expect(reasons.get('S-5')).toMatch(/AC-9/)
    expect(reasons.get('S-5')).not.toMatch(/AC-1\b/)
    expect(reasons.get('S-6')).toMatch(/broken-card/)
    expect(reasons.get('S-6')).toMatch(/spec:begin|spec:end|marker/)

    // A refusal blocks only that slice: S-4 overlaps S-2 but depends on it, and S-7 is clean.
    expect(p.create.map((c) => c.slice)).toEqual(['S-4', 'S-7'])
    expect(p.update).toEqual([])
    expect(p.skip).toEqual([{ slug: 'gone-card', slice: 'S-8', reason: 'orphan' }])
  })

  it('exits 1 from the CLI when anything is refused', () => {
    withBoard([brokenCard, orphan], (path) => {
      const res = run([REFUSE, '--board', path])
      expect(res.status).toBe(1)
      const p = JSON.parse(res.stdout) as Plan
      expect(p.refuse.map((r) => r.slice)).toEqual(['S-1', 'S-2', 'S-3', 'S-5', 'S-6'])
    })
  })

  it('refuses a card whose block has no end marker, and one whose markers are out of order', () => {
    const noEnd = {
      ...brokenCard,
      body: brokenCard.body.replace(/\n\n<!-- spec:begin S-6 -->/, '')
    }
    const reversed = {
      ...brokenCard,
      body: envelope('S-6', '<!-- spec:end S-6 -->\n\nstuff\n\n<!-- spec:begin S-6 -->')
    }
    for (const card of [noEnd, reversed]) {
      const p = plan(REFUSE, REFUSE_REL, [card])
      expect(p.refuse.find((r) => r.slice === 'S-6')?.reason).toMatch(/broken-card/)
      expect(p.update).toEqual([])
    }
  })
})

describe('cli usage', () => {
  it('exits 2 on a usage error, an unreadable spec and an unreadable or malformed board', () => {
    expect(run([]).status).toBe(2)
    expect(run([SPEC]).status).toBe(2)
    expect(run([SPEC, '--board']).status).toBe(2)
    expect(run([join(FIX, 'nope.md'), '--board', join(FIX, 'nope.json')]).status).toBe(2)
    expect(run([SPEC, '--board', join(FIX, 'nope.json')]).status).toBe(2)
    withBoard('{not json', (path) => expect(run([SPEC, '--board', path]).status).toBe(2))
    withBoard({ slug: 'x' }, (path) => expect(run([SPEC, '--board', path]).status).toBe(2))
  })
})
