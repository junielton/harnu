/**
 * T358 S7 — legacy goal-file migration (design
 * `docs/specs/2026-09-26-mission-progress/design.md` §9, §12 layer 2): the pure
 * importer `importLegacyGoalFile` against the three corpus shapes, and the
 * `mission_import_legacy` verb against a real temp filesystem.
 *
 * This suite IS the migration-eval layer (plan S7 "Eval gate — migration"). The
 * real corpus (55 goal files across 7 repos) holds client identifiers, so it is
 * never copied here: `tests/fixtures/mission-migration/*.md` are hand-written in
 * the SHAPES the T360 smoke test measured — `standard.md` (the mission skill's
 * section set), `partial.md` (`Objective`/`Topology`/`Units`/`Ticks` plus the
 * Portuguese `Executores`), `unrecognized.md` (no recognized heading at all,
 * with trailing whitespace, a tab and no final newline, which is why the fixture
 * directory is excluded from prettier and editorconfig).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { importLegacyGoalFile } from '../src/main/mission-migration'

const FIXTURES = path.join(__dirname, 'fixtures', 'mission-migration')
const NOW = '2026-09-28T12:00:00.000Z'

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
}

describe('importLegacyGoalFile — standard-shaped goal files (design §9 step 1)', () => {
  it('importLegacyGoalFile extracts North star into declaredEnd, Executors rows into StepLinks, Pending gates into Blockers, for a standard-shaped fixture', () => {
    const raw = fixture('standard.md')
    const out = importLegacyGoalFile(raw, { now: NOW, fileName: '3f2a9c10-proj-231-export.md' })

    expect(out.title).toBe('PROJ-231 CSV export')
    expect(out.session).toBe('3f2a9c10-5b7d-4e21-9a8c-0d1e2f3a4b5c')
    expect(out.declaredEnd).toStrictEqual({
      kind: 'code',
      target:
        "Ship the CSV export for Acme's reporting screen: one PR merged into main with the exporter, its tests and the settings toggle.",
      evidence:
        'PR merged into main with green CI; delivery-verifier report with every AC met; spec approved by the operator'
    })
    expect(out.needsReview).toStrictEqual([])

    // One custom step per Executors row, between the fixed frame's ids.
    expect(out.steps.map((s) => [s.id, s.ordinal, s.kind, s.title])).toStrictEqual([
      ['stp-3', 2, 'custom', 'exporter + tests (PR #412)'],
      ['stp-4', 3, 'custom', 'settings toggle']
    ])
    expect(out.steps[0].links).toStrictEqual([
      { kind: 'session', ref: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' },
      { kind: 'card', ref: 'T231' },
      { kind: 'pr', ref: '#412' }
    ])
    expect(out.steps[1].links).toStrictEqual([
      { kind: 'session', ref: '0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b' },
      { kind: 'card', ref: 'T232' }
    ])
    for (const s of out.steps) {
      // Proof is never inferred from prose: a legacy "state" column is not evidence.
      expect(s).toMatchObject({ verification: 'verifier', proof: 'unproven', blockers: [] })
      expect(s.addedReason).toMatch(/legacy goal file/)
    }

    expect(out.blockers.map((b) => b.reason)).toStrictEqual([
      'approval apr-7f3e: operator to allow the schema migration',
      'blocked on the org/proj/www staging deploy'
    ])
    for (const b of out.blockers) {
      expect(b).toMatchObject({ owner: 'agent', raisedAt: NOW })
      expect(b.unblocks.length).toBeGreaterThan(0)
    }

    // The Log section is carried over verbatim, never re-summarized.
    expect(out.log).toBe(
      '\n<!-- newest first, ONE line per tick: date time — state → action taken -->\n' +
        '- 2026-08-15 10:40 — T231 working, T232 idle → nudged T232\n' +
        '- 2026-08-14 17:05 — mission set, two executors dispatched\n'
    )
    expect(out.extractedFields).toStrictEqual([
      'title',
      'session',
      'declaredEnd.target',
      'declaredEnd.evidence',
      'declaredEnd.kind',
      'steps',
      'blockers',
      'log'
    ])
    expect(out.legacyRaw).toBe(raw)
  })

  it('partial shape: Objective → target, Units + Executores rows → steps merged by card id, declaredEnd flagged needs-review', () => {
    const raw = fixture('partial.md')
    const out = importLegacyGoalFile(raw, { now: NOW, fileName: 'wave-2.md' })

    expect(out.title).toBe('Wave 2 — ProjectAlpha importer')
    expect(out.session).toBeUndefined()
    expect(out.declaredEnd.kind).toBe('code')
    expect(out.declaredEnd.target).toBe(
      'Land the ProjectAlpha importer rewrite as two stacked PRs on org/proj/www, each with green CI, before the Acme demo.'
    )
    // No Done criteria: the evidence is a placeholder, so the end needs review.
    expect(out.declaredEnd.evidence).toMatch(/not stated in the legacy goal file/i)
    expect(out.needsReview).toStrictEqual(['declaredEnd'])

    expect(out.steps.map((s) => s.title)).toStrictEqual([
      'T401-importer-parser',
      'T402-importer-writer'
    ])
    expect(out.steps[0].links).toStrictEqual([
      { kind: 'card', ref: 'T401-importer-parser' },
      { kind: 'pr', ref: 'owner/repo#88' }
    ])
    // The Executores bullet names T402 again: its session joins the Units row's step.
    expect(out.steps[1].links).toStrictEqual([
      { kind: 'card', ref: 'T402-importer-writer' },
      { kind: 'pr', ref: 'owner/repo#91' },
      { kind: 'session', ref: '5d4c3b2a-1f0e-4d9c-8b7a-6e5f4d3c2b1a' }
    ])
    // Topology and Ticks have no Mission field: they live on in legacyRaw only.
    expect(out.blockers).toStrictEqual([])
    expect(out.log).toBe('')
    expect(out.extractedFields).toStrictEqual([
      'title',
      'declaredEnd.target',
      'declaredEnd.kind',
      'steps'
    ])
    expect(out.legacyRaw).toBe(raw)
  })
})

describe('importLegacyGoalFile — lossless fallback for unrecognized shapes (Review Focus #3)', () => {
  it('importLegacyGoalFile on a file with zero recognized headings still returns a Mission with declaredEnd flagged needs-review and legacyRaw equal to the original byte-for-byte', () => {
    const bytes = readFileSync(path.join(FIXTURES, 'unrecognized.md'))
    const raw = bytes.toString('utf8')
    const out = importLegacyGoalFile(raw, { now: NOW, fileName: 'c0ffee12-field-notes.md' })

    expect(out.needsReview).toStrictEqual(['declaredEnd'])
    // Still a COMPLETE declared end (decision 5) — placeholders, never empty strings.
    expect(out.declaredEnd.kind).toBe('other')
    expect(out.declaredEnd.target).toMatch(/not stated in the legacy goal file "field notes"/i)
    expect(out.declaredEnd.evidence).toMatch(/not stated in the legacy goal file/i)
    expect(out.title).toBe('field notes')
    expect(out.steps).toStrictEqual([])
    expect(out.blockers).toStrictEqual([])
    expect(out.openQuestions).toStrictEqual([])
    expect(out.log).toBe('')
    expect(out.extractedFields).toStrictEqual([])
    // Byte-for-byte: trailing spaces, the tab and the missing final newline included.
    expect(out.legacyRaw).toBe(raw)
    expect(Buffer.from(out.legacyRaw, 'utf8').equals(bytes)).toBe(true)
  })

  it('all three fixture shapes import, and each keeps its source verbatim (AC-S7-1, AC-S7-2)', () => {
    for (const name of ['standard.md', 'partial.md', 'unrecognized.md']) {
      const raw = fixture(name)
      const out = importLegacyGoalFile(raw, { now: NOW, fileName: name })
      expect(out.legacyRaw, name).toBe(raw)
      expect(out.declaredEnd.target.length, name).toBeGreaterThan(0)
      expect(out.declaredEnd.evidence.length, name).toBeGreaterThan(0)
    }
  })

  it('importLegacyGoalFile never throws — malformed, empty and hostile inputs', () => {
    const inputs: unknown[] = [
      '',
      '\n',
      '---',
      '---\n',
      '---\nsession: not-a-uuid\n',
      '---\nsession: 3f2a9c10-5b7d-4e21-9a8c-0d1e2f3a4b5c\n---\n',
      '# \n## \n##\n',
      '## North star\n',
      '## Executors\n|\n||\n| a |\n|---|\n| <id> | <card> |\n',
      '## Units\n| card |\n| --- |\n| T9 |\n| T9-dup |\n',
      '```\n## Log\nnot a section\n```\n## Log\nreal\n',
      '## Pending gates\n- none\n- \n-\n',
      '﻿# Goal — bom\r\n## North star\r\nship a PR\r\n',
      '\u0000\u0001\u0002',
      '# '.repeat(5000),
      'x'.repeat(200_000),
      '| '.repeat(2000),
      '## Log\n'.repeat(1000),
      42,
      null,
      undefined
    ]
    for (const input of inputs) {
      const out = importLegacyGoalFile(input as string, { now: NOW })
      expect(out.declaredEnd.target.length).toBeGreaterThan(0)
      expect(out.declaredEnd.evidence.length).toBeGreaterThan(0)
      expect(out.legacyRaw).toBe(typeof input === 'string' ? input : '')
      for (const s of out.steps) expect(s.id).toMatch(/^stp-\d+$/)
    }
  })

  it('does not read a heading inside a fenced code block as structure', () => {
    const out = importLegacyGoalFile('```md\n## North star\nfenced\n```\n', { now: NOW })
    expect(out.needsReview).toStrictEqual(['declaredEnd'])
    expect(out.extractedFields).not.toContain('declaredEnd.target')
  })

  it('ignores a frontmatter session that is not a full session UUID (it could never match an owner)', () => {
    const out = importLegacyGoalFile('---\nsession: 3f2a9c10\n---\n# Goal — x\n', { now: NOW })
    expect(out.session).toBeUndefined()
  })
})
